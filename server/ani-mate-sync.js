// YASA PRESENTS
// ani-mate-sync.js -- the sync engine. ONE copy, both clients.
//
// ⛔ THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR SYNC AND IT RUNS IN BOTH APPS.
//   Desktop loads it from the local server at /ani-mate-sync.js (it ships inside
//   server/**/* already). Mobile needs a real file in the APK, so `npm run sync:shared`
//   copies it to mobile/www/js/ and into the android assets. If you edit it, run that.
//
//   The reason for one copy is not tidiness. Sync is the feature where two platforms that
//   disagree do not produce a broken half, they produce DATA LOSS.
//
// ⛔ WHAT THIS FILE DOES NOT DO: it does not know where a favorite is stored or how either
//   app renders. It takes an ADAPTER (see create) and talks to the edge. What it DOES own,
//   so that it exists once: the record translation, the merge rules, the apply loop, the
//   identity of a show across platforms, and the settings adapter.
//
// THE PROTOCOL
//
//   pull(since) -> decide row by row what the pull means here -> apply -> look up show
//   identities -> diff local against what we last saw -> push -> remember the cursor
//
// ⛔ FOUR RULES. EACH ONE IS HERE BECAUSE ITS ABSENCE WAS MEASURED ON 2026-11-12.
//
//   1. A PULLED ROW IS NOT APPLIED BLINDLY. The cursor is the pull's clock, so the next
//      pull returns this device's own last push. The first version applied it by
//      overwrite, which rolled back anything changed in the meantime: a watched mark was
//      lost for good, an un-starred show came back, a show removed from history came
//      back. One device was enough. Now a pulled row whose hash equals what we last saw
//      is skipped, and a row changed on both sides is MERGED (see mergeRows).
//
//   2. A DELETE IS SOMETHING THE USER DID, NEVER SOMETHING WE INFER. The first version
//      treated "was here last time, is not here now" as a delete. A history list capped
//      at 100 rows and a file that failed to read once both look exactly like that, and
//      both would have deleted rows on every device. Deletes now come from a journal the
//      apps write when the user removes something (adapter.loadDeleted).
//
//   3. THE CURSOR OVERLAPS. A push stamped just before our pull can commit just after
//      it, and a cursor set to the pull's clock steps over that row forever. Pulling
//      from two minutes earlier costs a few rows that rule 1 skips.
//
//   4. A SHOW HAS ONE IDENTITY ON EVERY PLATFORM. The desktop stores AllAnime ids and
//      the phone stores hianime slugs, so the same show was two unrelated rows. The sync
//      key is the AniList id when a title matches one strictly (see resolveIdentity),
//      and the local id otherwise.

(function (root) {
    'use strict';

    const DEFAULT_EDGE = 'https://ani-mate.yasadevstudio.workers.dev';
    /* ⛔ WHICH SYNC PROTOCOL THIS ENGINE SPEAKS, SENT WITH EVERY REQUEST (`v=2`).
     * The first engine (1) spoke the same routes and bodies and was not safe: it wrote
     * its own echo over newer local rows, and it reported any row it failed to read as
     * deleted, which removed that row from every other device. It sends no `v`, so the
     * server can tell it apart and refuses it. Raise this number when a change to this
     * engine makes an older engine dangerous to an account, and raise MIN_CLIENT in
     * worker/src/accounts.js with it. */
    const SYNC_PROTOCOL = 2;
    const ANILIST = 'https://graphql.anilist.co';
    const POLL_MS = 2500;
    const KINDS = ['watch', 'favorites'];
    const CURSOR_OVERLAP_MS = 120000;
    const REQUEST_TIMEOUT_MS = 30000;
    const WATCH_FLUSH_MS = 5000;
    const HISTORY_CAP = 100;
    const RESOLVE_PER_REQUEST = 8;
    const RESOLVE_REQUESTS_PER_SYNC = 4;
    const API_NEEDED = 2;

    const COLS = {
        watch: ['title', 'title_english', 'episode', 'position', 'duration', 'mode',
                'episodes_watched', 'total_episodes'],
        favorites: ['title', 'title_english', 'episodes', 'franchise_id', 'cover', 'added_at'],
    };

    /* localStorage can throw outright (private windows, embedded webviews with site data
     * blocked), and a sync feature that takes the whole app down when it cannot remember
     * a token is worse than one that is merely signed out. */
    function memoryStore() {
        const m = new Map();
        return {
            get: (k) => (m.has(k) ? m.get(k) : null),
            set: (k, v) => m.set(k, v),
            remove: (k) => m.delete(k),
        };
    }
    function localStore() {
        try {
            const probe = '__animate_sync_probe__';
            root.localStorage.setItem(probe, '1');
            root.localStorage.removeItem(probe);
            return {
                get: (k) => root.localStorage.getItem(k),
                set: (k, v) => root.localStorage.setItem(k, v),
                remove: (k) => root.localStorage.removeItem(k),
            };
        } catch (e) {
            return memoryStore();
        }
    }

    /** The device's own calendar day, YYYY-MM-DD. Local, not UTC: a 1am session belongs
     *  to the night the person was up, not to the following morning. */
    function localDay(d) {
        const t = d || new Date();
        const p = (n) => String(n).padStart(2, '0');
        return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
    }

    /** Stable hash of a row: sorted keys, so key order cannot fake a change.
     *  Keys that start with an underscore are LOCAL NOTES (the local id, the local clock)
     *  and never count: they are not on the server, so counting them would make every
     *  pulled row look different from the one we pushed. */
    function hashRow(row) {
        const keys = Object.keys(row)
            .filter((k) => k !== 'updated_at' && k !== 'deleted' && k.charAt(0) !== '_').sort();
        let s = '';
        for (const k of keys) {
            const v = row[k];
            s += k + '\u0001' + (v === null || v === undefined ? '' : String(v)) + '\u0002';
        }
        /* FNV-1a. Not a security hash and does not need to be: a collision here means
         * one edit does not sync until the next change touches the row. */
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
        }
        return h.toString(36);
    }

    const filled = (v) => v !== null && v !== undefined && v !== '';

    /** A real episode total, or null. '?' was being stored as one. */
    function wholeNumber(v) {
        const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v || '')) ? Number(v) : NaN);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }

    function parseEpisodes(v) {
        if (Array.isArray(v)) return v.map(String);
        try {
            const a = JSON.parse(v || '[]');
            return Array.isArray(a) ? a.map(String) : [];
        } catch (e) { return []; }
    }

    /** Both lists, each episode once, in one fixed order so two devices that hold the
     *  same set always hold the same string. */
    function unionEpisodes(a, b) {
        const set = new Set(parseEpisodes(a).concat(parseEpisodes(b)));
        return Array.from(set).sort((x, y) => {
            const nx = parseFloat(x), ny = parseFloat(y);
            const fx = Number.isFinite(nx), fy = Number.isFinite(ny);
            if (fx && fy && nx !== ny) return nx - ny;
            if (fx !== fy) return fx ? -1 : 1;
            return x < y ? -1 : (x > y ? 1 : 0);
        });
    }

    /* ── IDENTITY ──────────────────────────────────────────────────────────────────
     * titleKey reduces a title to what must be equal for two titles to be the same
     * show: case, punctuation and the three ways of writing a season number are
     * removed, and nothing else is. "Boku no Hero Academia 2nd Season" and "Boku no
     * Hero Academia 2" are equal. "Fate/stay night" and "Fate/stay night: Unlimited
     * Blade Works" are NOT, on purpose: this decides whose watch progress is whose,
     * so a near miss must stay a miss. */
    function titleKey(t) {
        let s = String(t || '');
        try { s = s.normalize('NFKC'); } catch (e) { /* very old webviews */ }
        s = s.toLowerCase()
            .replace(/[‘’‛ʼ′]/g, "'")
            .replace(/[“”″]/g, '"');
        let season = '', part = '';
        s = s.replace(/\b(\d+)\s*(?:st|nd|rd|th)\s+season\b|\bseason\s*(\d+)\b/g, (m, a, b) => {
            season = String(parseInt(a || b, 10)); return ' ';
        });
        s = s.replace(/\b(?:part|cour)\s*(\d+)\b/g, (m, a) => { part = String(parseInt(a, 10)); return ' '; });
        s = s.replace(/\s+$/, '');
        if (!season) {
            const m = s.match(/\s+(ii|iii|iv)$/);
            if (m) { season = String({ ii: 2, iii: 3, iv: 4 }[m[1]]); s = s.slice(0, m.index); }
        }
        if (!season) {
            const m = s.match(/\s+([2-9])$/);
            if (m) { season = m[1]; s = s.slice(0, m.index); }
        }
        let bare;
        try { bare = s.replace(/[^\p{L}\p{N}]+/gu, ''); }
        catch (e) { bare = s.replace(/[^a-z0-9]+/g, ''); }
        if (!bare) return '';
        return bare + (season && season !== '1' ? '#s' + season : '') + (part ? '#p' + part : '');
    }

    /**
     * Look titles up on AniList and return the id of the entry whose own title IS that
     * title. `items` is [{ name, alt }]; the result is an array of the same length holding
     * an id, 0 for "looked up, nothing matched strictly", or undefined for "not looked up"
     * (network down, rate limited). Undefined rows are tried again on a later sync.
     *
     * ⚠ STRICT ON PURPOSE. AniList's search is fuzzy and its first hit for "X 2nd Season"
     * is often season 1. Taking the first hit would file season 2's progress under season
     * 1 on the other device. A row only gets an AniList id when one of the returned
     * entries carries the same title, by titleKey, as romaji, english or a synonym.
     */
    async function resolveIdentity(items, fetchImpl, maxRequests) {
        const out = new Array(items.length);
        const f = fetchImpl || root.fetch;
        if (!f || !items.length) return out;
        let requests = 0;
        for (let at = 0; at < items.length; at += RESOLVE_PER_REQUEST) {
            if (requests >= (maxRequests || RESOLVE_REQUESTS_PER_SYNC)) break;
            requests++;
            const batch = items.slice(at, at + RESOLVE_PER_REQUEST);
            const defs = batch.map((_, i) => '$s' + i + ': String').join(', ');
            const body = batch.map((_, i) => 'q' + i + ': Page(perPage: 6) { media(search: $s' + i
                + ', type: ANIME) { id title { romaji english } synonyms } }').join(' ');
            const variables = {};
            batch.forEach((it, i) => { variables['s' + i] = String(it.name || it.alt || '').slice(0, 200); });
            let json = null;
            try {
                const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
                let res;
                try {
                    res = await f(ANILIST, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ query: 'query (' + defs + ') { ' + body + ' }', variables }),
                        signal: ctl ? ctl.signal : undefined,
                    });
                } finally { if (timer) clearTimeout(timer); }
                if (!res || !res.ok) break;             // 429 or an outage: stop asking, try next sync
                json = await res.json();
            } catch (e) { break; }
            if (!json || !json.data) break;
            batch.forEach((it, i) => {
                const want = new Set([titleKey(it.name), titleKey(it.alt)].filter(Boolean));
                const page = json.data['q' + i];
                const media = (page && page.media) || [];
                let id = 0;
                for (const m of media) {
                    const names = [m && m.title && m.title.romaji, m && m.title && m.title.english]
                        .concat((m && m.synonyms) || []);
                    if (names.some((n) => n && want.has(titleKey(n)))) { id = Number(m.id) || 0; break; }
                }
                out[at + i] = id;
            });
        }
        return out;
    }

    /* ── SHAPE TRANSLATION ─────────────────────────────────────────────────────────
     * ⛔ BOTH APPS STORE THE SAME RECORDS AND THE SYNC SCHEMA USES DIFFERENT NAMES, SO
     * THIS MAPPING LIVES HERE AND NOWHERE ELSE. Verified 2026-11-08: the desktop's
     * ani-mate-history.json entry and the phone's history.json entry are field for
     * field identical, down to playback_episode being nulled when an episode finishes.
     *
     * The desktop requires() this from its Node server, where the files actually live;
     * the phone calls it in the WebView. Same functions, two runtimes.
     *
     * ⚠ episodes_watched CROSSES AS A JSON STRING. D1 has no array type.
     *
     * ⚠ quality IS NOT IN EITHER DIRECTION, ON PURPOSE. It is the one preference about
     * the hardware and the connection rather than the person.
     *
     * ⚠ THE APPLY LOOP LIVES HERE TOO (applyFavorites / applyWatch). It used to be
     * written twice, once in the desktop server and once in the phone adapter. */
    const localIdOf = (kind, rec) => String(kind === 'watch' ? rec.anime_id : rec.id);

    /** local id -> sync key for a whole list.
     *  A row with an AniList id syncs as `al:<id>`. If two local rows carry the same
     *  AniList id, the one with the smaller local id keeps it and the other syncs under
     *  its local id: the rule must not depend on list order, or the two would trade
     *  keys every time one of them is watched. */
    function keyMap(kind, list) {
        const owner = new Map();
        for (const rec of (list || [])) {
            if (!rec) continue;
            const a = Number(rec.anilist_id) || 0;
            if (a <= 0) continue;
            const lid = localIdOf(kind, rec);
            if (!owner.has(a) || lid < owner.get(a)) owner.set(a, lid);
        }
        const out = new Map();
        for (const rec of (list || [])) {
            if (!rec) continue;
            const lid = localIdOf(kind, rec);
            const a = Number(rec.anilist_id) || 0;
            out.set(lid, a > 0 && owner.get(a) === lid ? 'al:' + a : lid);
        }
        return out;
    }

    const shape = {
        COLS,
        HISTORY_CAP,
        titleKey,
        keyMap,

        favToSync(f, key) {
            return {
                anime_id: key || String(f.id),
                title: f.name == null ? null : String(f.name),
                title_english: f.title_english ? String(f.title_english) : null,
                episodes: wholeNumber(f.episodes) || 0,
                franchise_id: f.franchise_id ? String(f.franchise_id) : null,
                cover: f.cover ? String(f.cover) : null,
                added_at: f.added ? (Date.parse(f.added) || null) : null,
                _lid: String(f.id),
                _ts: f.added ? (Date.parse(f.added) || 0) : 0,
                _resolved: f.anilist_id !== undefined && f.anilist_id !== null,
                _guest: !!f.from_sync,
            };
        },
        favFromSync(row, prev) {
            const key = String(row.anime_id);
            /* Everything the app has added to the stored row over time (genres, year,
             * format) survives a sync. Rebuilding the row from the six synced columns
             * threw that away on every pull. */
            const fav = Object.assign({}, prev || {});
            fav.id = prev ? prev.id : key;
            /* ⚠ A ROW THAT ONLY EXISTS HERE BECAUSE A PULL BROUGHT IT is marked. Its id
             * is another device's id for the show (or an `al:` placeholder), and when
             * this device turns out to have a row of its own for the same show, the two
             * are one row and this is the one that goes. See setIdentity. */
            if (!prev) fav.from_sync = true;
            fav.name = filled(row.title) ? String(row.title) : ((prev && prev.name) || key);
            fav.episodes = wholeNumber(row.episodes) || 0;
            fav.added = new Date(Number(row.added_at) || Number(row.updated_at) || Date.now()).toISOString();
            if (row.title_english) fav.title_english = String(row.title_english);
            if (row.franchise_id) fav.franchise_id = String(row.franchise_id);
            if (row.cover) fav.cover = String(row.cover);
            if (/^al:\d+$/.test(key)) fav.anilist_id = Number(key.slice(3));
            return fav;
        },
        watchToSync(h, key) {
            return {
                anime_id: key || String(h.anime_id),
                title: h.title == null ? null : String(h.title),
                title_english: h.title_english ? String(h.title_english) : null,
                episode: h.episode == null ? null : String(h.episode),
                /* The resume POINT, which is what another device needs. `episode` is the
                 * last one opened; playback_time is where in it we stopped, and
                 * markWatched zeroes it when the episode finishes. */
                position: Number(h.playback_time) || 0,
                duration: h.duration == null ? null : Number(h.duration) || null,
                mode: h.mode === 'dub' ? 'dub' : (h.mode ? 'sub' : null),
                episodes_watched: JSON.stringify(
                    Array.isArray(h.episodes_watched) ? h.episodes_watched.map(String) : []),
                total_episodes: wholeNumber(h.total_episodes),
                _lid: String(h.anime_id),
                _ts: Date.parse(h.timestamp || '') || 0,
                _resolved: h.anilist_id !== undefined && h.anilist_id !== null,
                _guest: !!h.from_sync,
            };
        },
        watchFromSync(row, prev) {
            const key = String(row.anime_id);
            const pos = Number(row.position) || 0;
            const rec = Object.assign({}, prev || {});
            rec.anime_id = prev ? prev.anime_id : key;
            if (!prev) rec.from_sync = true;          // see favFromSync
            rec.title = filled(row.title) ? String(row.title) : ((prev && prev.title) || key);
            rec.episode = row.episode == null ? '1' : String(row.episode);
            rec.quality = (prev && prev.quality) || 'best';
            rec.mode = row.mode === 'dub' ? 'dub' : 'sub';
            /* `timestamp` is what orders CONTINUE. The engine sets updated_at to the
             * clock of whichever side won the merge. */
            rec.timestamp = new Date(Number(row.updated_at) || Date.now()).toISOString();
            rec.episodes_watched = parseEpisodes(row.episodes_watched);
            rec.total_episodes = wholeNumber(row.total_episodes);
            rec.playback_time = pos;
            rec.playback_episode = pos > 0 ? (row.episode == null ? null : String(row.episode)) : null;
            if (row.title_english) rec.title_english = String(row.title_english);
            if (/^al:\d+$/.test(key)) rec.anilist_id = Number(key.slice(3));
            return rec;
        },

        /** A stored list as sync rows, keyed the way the server keys them. */
        favoritesOut(list) {
            const keys = keyMap('favorites', list);
            return (list || []).filter((f) => f && f.id !== undefined && f.id !== null)
                .map((f) => shape.favToSync(f, keys.get(String(f.id))));
        },
        watchOut(list) {
            const keys = keyMap('watch', list);
            return (list || []).filter((h) => h && h.anime_id !== undefined && h.anime_id !== null)
                .map((h) => shape.watchToSync(h, keys.get(String(h.anime_id))));
        },

        /** The sync key a local row has right now. The delete paths call this BEFORE they
         *  remove a row, because afterwards there is nothing left to ask. */
        keyOfLocal(kind, list, localId) {
            return keyMap(kind, list).get(String(localId)) || String(localId);
        },

        /**
         * Apply decided rows to a stored list and return the new list. Pure: the caller
         * loads, calls this, saves. `rows` are sync rows the ENGINE has already decided
         * on (skip, merge or delete), so this only writes.
         */
        applyFavorites(list, rows) {
            const favs = (list || []).slice();
            for (const row of (rows || [])) {
                if (!row || row.anime_id === undefined || row.anime_id === null) continue;
                const key = String(row.anime_id);
                const keys = keyMap('favorites', favs);
                const at = favs.findIndex((f) => f && keys.get(String(f.id)) === key);
                if (row.deleted) { if (at >= 0) favs.splice(at, 1); continue; }
                const fav = shape.favFromSync(row, at >= 0 ? favs[at] : null);
                if (at >= 0) favs[at] = fav; else favs.unshift(fav);
            }
            return favs;
        },
        applyWatch(list, rows) {
            const hist = (list || []).slice();
            for (const row of (rows || [])) {
                if (!row || row.anime_id === undefined || row.anime_id === null) continue;
                const key = String(row.anime_id);
                const keys = keyMap('watch', hist);
                const at = hist.findIndex((h) => h && keys.get(String(h.anime_id)) === key);
                if (row.deleted) { if (at >= 0) hist.splice(at, 1); continue; }
                const rec = shape.watchFromSync(row, at >= 0 ? hist[at] : null);
                if (at >= 0) hist[at] = rec; else hist.unshift(rec);
            }
            /* The same cap the apps keep, applied after a merge so a sync cannot grow the
             * file without bound. Newest first. A row that falls off here is NOT a delete
             * and is never reported as one. */
            hist.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
            if (hist.length > HISTORY_CAP) hist.length = HISTORY_CAP;
            return hist;
        },

        /**
         * Record looked-up identities on a stored list and return the new list.
         * `updates` is [{ id, anilist_id }] with LOCAL ids.
         *
         * ⚠ IT ALSO MAKES ONE ROW OF ONE SHOW. Once rows carry AniList ids, two rows with
         * the same one are the same show, and which of them stays depends on how each
         * got here:
         *
         *     made on this device        stays. It carries the id this platform can open.
         *     arrived by sync (a guest)  folds into the row above, if there is one:
         *                                the watched episodes are united, gaps are
         *                                filled, and the guest goes.
         *     two made on this device    both stay. That is the user's doing (a show
         *                                starred from two sources), not sync's.
         *     only guests                one stays, the one with a real id rather than
         *                                an `al:` placeholder.
         *
         * A guest is a row marked `from_sync`, or a row whose id is an `al:<n>`
         * placeholder. The first version folded placeholders only, so two devices that
         * first synced while AniList could not be reached (each pushing under its own
         * id, each storing the other's as a second row) kept every shared show twice,
         * for good. Without any folding a phone joining an account showed every shared
         * show twice.
         */
        setIdentity(kind, list, updates) {
            const by = new Map((updates || []).map((u) => [String(u.id), Number(u.anilist_id) || 0]));
            const rows = (list || []).slice();
            for (const rec of rows) {
                if (!rec) continue;
                const lid = localIdOf(kind, rec);
                if (by.has(lid)) rec.anilist_id = by.get(lid);
            }
            const shows = new Map();
            for (const rec of rows) {
                if (!rec) continue;
                const a = Number(rec.anilist_id) || 0;
                if (a <= 0) continue;
                if (!shows.has(a)) shows.set(a, []);
                shows.get(a).push(rec);
            }
            const gone = new Set();
            shows.forEach((members, a) => {
                if (members.length < 2) return;
                const lidOf = (r) => localIdOf(kind, r);
                const placeholder = (r) => lidOf(r) === 'al:' + a;
                const guest = (r) => !!r.from_sync || placeholder(r);
                /* 0 made here, 1 a guest with a real id, 2 a placeholder. The smallest
                 * id breaks a tie, so the choice never depends on list order. */
                const rank = (r) => (guest(r) ? (placeholder(r) ? 2 : 1) : 0);
                const keeper = members.slice()
                    .sort((x, y) => rank(x) - rank(y) || (lidOf(x) < lidOf(y) ? -1 : 1))[0];
                for (const rec of members) {
                    if (rec === keeper || !guest(rec)) continue;
                    if (kind === 'watch') {
                        const m = mergeRows('watch',
                            Object.assign(shape.watchToSync(keeper), { anime_id: 'al:' + a }),
                            Object.assign(shape.watchToSync(rec),
                                { anime_id: 'al:' + a, updated_at: Date.parse(rec.timestamp || '') || 0 }),
                            true);
                        Object.assign(keeper, shape.watchFromSync(m, keeper));
                    } else {
                        for (const k of Object.keys(rec)) {
                            if (k !== 'id' && k !== 'from_sync' && !filled(keeper[k]) && filled(rec[k])) keeper[k] = rec[k];
                        }
                        /* The show was added when it was FIRST added, on whichever device. */
                        const ka = Date.parse(keeper.added || '') || 0, ra = Date.parse(rec.added || '') || 0;
                        if (ra && (!ka || ra < ka)) keeper.added = rec.added;
                    }
                    gone.add(rec);
                }
            });
            return rows.filter((rec) => rec && !gone.has(rec));
        },

        /* The three toggles both apps already keep under these exact localStorage keys. */
        SETTING_KEYS: {
            prefer_english: 'ani-mate-english-titles',
            autoplay: 'ani-mate-autoplay',
            nsfw: 'ani-mate-nsfw',
        },
    };

    /**
     * Two versions of one row, one result.
     *
     *   watch      the resume point (episode, position, mode) comes whole from ONE side:
     *              the newer one when both sides changed, the server's otherwise. Mixing
     *              an episode from one device with a position from the other is how a
     *              resume lands in the wrong place.
     *              episodes_watched is ALWAYS the union. A watched mark is never
     *              withdrawn by either app, so a list can only be missing an entry by
     *              mistake, and the union repairs it.
     *   favorites  the server's fields, with gaps filled from the local row.
     */
    function mergeRows(kind, local, remote, bothChanged) {
        const out = { anime_id: String(remote.anime_id) };
        if (kind === 'watch') {
            const localNewer = !!bothChanged && (Number(local._ts) || 0) > (Number(remote.updated_at) || 0);
            const a = localNewer ? local : remote, b = localNewer ? remote : local;
            out.title = filled(a.title) ? a.title : (filled(b.title) ? b.title : null);
            out.title_english = filled(a.title_english) ? a.title_english
                : (filled(b.title_english) ? b.title_english : null);
            out.episode = a.episode != null ? String(a.episode) : (b.episode != null ? String(b.episode) : null);
            out.position = Number(a.position) || 0;
            out.duration = a.duration != null ? a.duration : null;
            out.mode = a.mode || b.mode || null;
            out.episodes_watched = JSON.stringify(unionEpisodes(local.episodes_watched, remote.episodes_watched));
            out.total_episodes = wholeNumber(a.total_episodes) || wholeNumber(b.total_episodes);
            out.updated_at = localNewer ? (Number(local._ts) || Date.now())
                                        : (Number(remote.updated_at) || Date.now());
        } else {
            for (const c of COLS.favorites) out[c] = filled(remote[c]) ? remote[c] : (filled(local[c]) ? local[c] : null);
            out.episodes = Math.max(wholeNumber(remote.episodes) || 0, wholeNumber(local.episodes) || 0);
            const ra = Number(remote.added_at) || 0, la = Number(local.added_at) || 0;
            out.added_at = ra && la ? Math.min(ra, la) : (ra || la || null);
            out.updated_at = Number(remote.updated_at) || Date.now();
        }
        return out;
    }

    /**
     * The settings half of an adapter, shared so the two apps cannot disagree about it.
     *
     * ⚠ AN UNSET TOGGLE IS NOT 'false'. English titles default to ON when the key is
     * absent. The first version reported absent as 'false', pushed it, pulled it back and
     * wrote it down, so turning sync on switched English titles off on every device.
     * A key the user never touched is simply not sent.
     *
     * `onApplied(rows)` is where the app updates its in-memory state and its checkboxes;
     * writing the key without that leaves the screen and the behavior disagreeing.
     */
    function settingsAdapter(ls, onApplied) {
        return {
            loadSettings: async () => Object.keys(shape.SETTING_KEYS)
                .map((key) => ({ key, value: ls.getItem(shape.SETTING_KEYS[key]) }))
                .filter((s) => s.value === 'true' || s.value === 'false'),
            applySettings: async (rows) => {
                const done = [];
                for (const row of (rows || [])) {
                    const lsKey = row && shape.SETTING_KEYS[row.key];
                    if (!lsKey) continue;                  // an unknown key from a newer client
                    const value = row.value === 'true' ? 'true' : 'false';
                    ls.setItem(lsKey, value);
                    done.push({ key: row.key, value });
                }
                if (onApplied && done.length) onApplied(done);
            },
        };
    }

    function create(options) {
        const opt = options || {};
        /* ANI_MATE_EDGE is set by the HOST PAGE, never by a query string or by
         * anything a user can type. A device token travels on these requests, and an
         * endpoint anyone could flip from a link would be a way to collect one. */
        const endpoint = (opt.endpoint || root.ANI_MATE_EDGE || DEFAULT_EDGE)
            .replace(/\/+$/, '');
        const platform = opt.platform || 'electron';
        const adapter = opt.adapter;
        const store = opt.store || localStore();
        const log = opt.log || function () {};
        const fetchImpl = opt.fetch || null;            // tests hand one in
        const doFetch = function () { return (fetchImpl || root.fetch).apply(root, arguments); };
        if (!adapter) throw new Error('ani-mate-sync needs an adapter');

        const K = {
            token: 'animate.sync.token',
            account: 'animate.sync.account',
            device: 'animate.sync.device',
            label: 'animate.sync.label',
            since: 'animate.sync.since',
            seen: 'animate.sync.seen',
            /* local id -> the key it last synced under. When a row gains an AniList id
             * its key changes, and this is how the old key gets retired instead of
             * living on the server as a second copy of the show. */
            lids: 'animate.sync.lids',
            at: 'animate.sync.at',
            /* The counters, held locally until the next sync. Keyed by the DEVICE's
             * own local day: the day boundary belongs to the person watching. */
            wt: 'animate.sync.watchtime',
            gt: 'animate.sync.genretime',
            /* ⛔ THE RECOVERY KEY, IN CLEAR, ON THIS DEVICE. His call 2026-11-08:
             * "make sure users can pull up their keys 1 more time after the inital
             * popup cuz not everyone will read."
             * The server stores a SHA-256 and cannot show it again, so the device keeps
             * a copy. That adds no exposure: K.token sits in the same storage and is
             * strictly more powerful. A device that JOINED BY PAIRING never sees a key
             * and so never stores one. */
            rkey: 'animate.sync.recoverykey',
            /* 'on' | 'later': whether the first-run prompt has been answered. */
            choice: 'animate.sync.choice',
        };

        let claimTimer = null;
        let autoTimer = null;
        let inFlight = null;
        let backendOk = null;                 // null = not asked yet this session

        /* Watch time is counted about four times a second. Writing two localStorage keys
         * on every tick was most of this feature's cost, so the ticks collect here and
         * reach the store every few seconds, before a sync, and when the app asks. */
        let pendWt = {}, pendGt = {}, flushTimer = null;

        const getToken = () => store.get(K.token);
        const readJson = (k) => {
            try { return JSON.parse(store.get(k) || '{}') || {}; } catch (e) { return {}; }
        };
        const readSeen = () => readJson(K.seen);

        function flushWatchClock() {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            const days = Object.keys(pendWt), genres = Object.keys(pendGt);
            if (days.length) {
                const wt = readJson(K.wt);
                for (const d of days) wt[d] = (wt[d] || 0) + pendWt[d];
                try { store.set(K.wt, JSON.stringify(wt)); pendWt = {}; } catch (e) { /* keep for next time */ }
            }
            if (genres.length) {
                const gt = readJson(K.gt);
                for (const g of genres) gt[g] = (gt[g] || 0) + pendGt[g];
                try { store.set(K.gt, JSON.stringify(gt)); pendGt = {}; } catch (e) { /* keep for next time */ }
            }
        }

        /**
         * Drop this device's credential.
         *
         * ⚠ K.rkey AND K.choice SURVIVE ON PURPOSE. The recovery key is the ONLY way back
         * into an account once the token is gone, so deleting it here would turn a
         * sign-out, or a revoke from another device, into permanent silent lockout. The
         * choice survives so that being signed out does not re-open the first-run prompt.
         * The counters survive too: they are this device's own history, not a credential.
         */
        function forgetLocal() {
            for (const k of Object.values(K)) {
                if (k === K.rkey || k === K.choice || k === K.wt || k === K.gt) continue;
                store.remove(k);
            }
        }

        async function api(method, path, body, token) {
            const headers = { 'content-type': 'application/json' };
            const t = token === undefined ? getToken() : token;
            if (t) headers.authorization = 'Bearer ' + t;
            /* A request with no deadline that stalls leaves `inFlight` set for the rest
             * of the session, and sync is then dead without saying so. */
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
            let res;
            try {
                res = await doFetch(endpoint + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + SYNC_PROTOCOL, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: ctl ? ctl.signal : undefined,
                });
            } catch (e) {
                const err = new Error(ctl && ctl.signal.aborted ? 'The sync server did not answer in time'
                                                              : 'Could not reach the sync server');
                err.status = 0;
                throw err;
            } finally { if (timer) clearTimeout(timer); }
            let json = null;
            try { json = await res.json(); } catch (e) { /* 204s and error pages */ }
            if (!res.ok) {
                const err = new Error((json && json.error) || ('HTTP ' + res.status));
                err.status = res.status;
                err.detail = json && json.detail;
                err.body = json;
                /* A 401 means this device was revoked from another device. That is a
                 * legitimate instruction, not an error to retry: drop the credential so
                 * the UI stops pretending to be signed in. */
                if (res.status === 401 && t && t === getToken()) {
                    log('this device was revoked elsewhere; signing out locally');
                    forgetLocal();
                }
                /* A server that predates accounts answers 404 "not found" on every
                 * account route. Say what that means instead of echoing it. */
                if (res.status === 404 && json && json.error === 'not found') {
                    err.message = 'Sync is not available on the server yet';
                    err.code = 'no_backend';
                }
                throw err;
            }
            return json || {};
        }

        /** Refuse to start an account against a server that cannot hold one. /health is
         *  free and unauthenticated, and `api` is there for exactly this. */
        async function ensureBackend() {
            if (backendOk === true) return;
            let h = null;
            try { h = await api('GET', '/health', undefined, null); } catch (e) { h = null; }
            if (!h || !(Number(h.api) >= API_NEEDED)) {
                const err = new Error(h ? 'Sync is not available on the server yet'
                                        : 'Could not reach the sync server');
                err.code = h ? 'no_backend' : 'offline';
                throw err;
            }
            backendOk = true;
        }

        /* A device token generated HERE, not handed to us. The server only ever learns
         * its SHA-256, so a dump of the database cannot sign in as this device. */
        function mintToken() {
            const b = new Uint8Array(32);
            (root.crypto || root.msCrypto).getRandomValues(b);
            let s = '';
            for (const x of b) s += String.fromCharCode(x);
            return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

        const self = {
            endpoint,

            state() {
                return {
                    signedIn: !!getToken(),
                    accountId: store.get(K.account),
                    deviceId: store.get(K.device),
                    label: store.get(K.label),
                    lastSync: Number(store.get(K.at) || 0) || 0,
                    pairing: !!claimTimer,
                    /* Whether this device can still show the key, and what the user
                     * already chose. The panel needs both to decide what to offer. */
                    hasKey: !!store.get(K.rkey),
                    choice: store.get(K.choice) || null,
                    /* Reported so a test can assert the background timer is actually
                     * running. It must be alive even while signed out: see startAuto. */
                    auto: !!autoTimer,
                };
            },

            /* ── THE FIRST-RUN CHOICE ───────────────────────────────────────────────
             * His call 2026-11-08: "make the sync thing a whole different popup that you
             * have to interact with (opt-in or out) before it goes away."
             * Asked ONCE, the answer is recorded either way, and it is never asked again. */
            needsIntro() {
                return !store.get(K.choice) && !getToken();
            },
            setChoice(v) {
                store.set(K.choice, v === 'on' ? 'on' : 'later');
            },

            /* ── WATCH TIME ─────────────────────────────────────────────────────────
             * Called by the player with REAL elapsed seconds in front of a playing
             * video. Never with currentTime: that is a POSITION, so scrubbing forward 20
             * minutes would bank 20 minutes nobody watched.
             *
             * ⚠ IT COUNTS WHETHER OR NOT ANYONE IS SIGNED IN. The numbers are kept
             * locally and only leave the device on a sync.
             *
             * ⚠ FRACTIONS ARE KEPT. `timeupdate` fires about four times a second, so
             * every call is about 0.25s; rounding each one would round every call to
             * zero. Rounding happens once, on the way out.
             *
             * ⚠ THE FULL DURATION AGAINST EACH GENRE, NOT A SPLIT. An hour of a show
             * tagged Action/Comedy/Drama is an hour of each, so the genre totals do not
             * sum to watch time and the stats screen must not present them as a share. */
            noteWatching(seconds, genres) {
                const secs = Math.max(0, Number(seconds) || 0);
                if (!secs) return;
                const day = localDay();
                pendWt[day] = (pendWt[day] || 0) + secs;
                if (Array.isArray(genres) && genres.length) {
                    for (const g of genres.slice(0, 8)) {
                        const name = String(g || '').trim().slice(0, 40);
                        if (name) pendGt[name] = (pendGt[name] || 0) + secs;
                    }
                }
                if (!flushTimer) flushTimer = setTimeout(flushWatchClock, WATCH_FLUSH_MS);
            },

            /** Write the collected watch time down now. The apps call this when the
             *  window is hidden or closed, so the last few seconds are not lost. */
            flush() { flushWatchClock(); },

            /** Everything the account knows, summed across devices. */
            stats() { return api('GET', '/api/stats?today=' + encodeURIComponent(localDay())); },

            /** What this device alone has counted, for a screen that works signed out. */
            localStats() {
                flushWatchClock();
                const wt = readJson(K.wt), gt = readJson(K.gt);
                const days = Object.keys(wt).sort().reverse().map((d) => ({ day: d, seconds: wt[d] }));
                return {
                    total_seconds: Math.round(days.reduce((n, d) => n + d.seconds, 0)),
                    today_seconds: Math.round(wt[localDay()] || 0),
                    days: days.map((d) => ({ day: d.day, seconds: Math.round(d.seconds) })),
                    genres: Object.keys(gt).map((g) => ({ genre: g, seconds: Math.round(gt[g]) }))
                        .sort((a, b) => b.seconds - a.seconds),
                    local_only: true,
                };
            },

            /** The key this device saved at sign-up, or null if it never had one. */
            recoveryKey() { return store.get(K.rkey); },

            /** The user says they have written it down. Then and only then it goes. */
            forgetRecoveryKey() { store.remove(K.rkey); },

            /* ── START HERE: a brand new account, no form, no email ─────────────────
             * Returns the recovery key. The caller MUST show it before anything else. */
            async createAccount(labelHint) {
                await ensureBackend();
                const r = await api('POST', '/api/account',
                                    { platform, label: labelHint }, null);
                store.set(K.token, r.device_token);
                store.set(K.account, r.account_id);
                store.set(K.device, r.device_id);
                store.set(K.label, r.label);
                store.set(K.rkey, r.recovery_key);      // so it can be shown again
                store.set(K.choice, 'on');
                store.remove(K.since);
                store.remove(K.seen);
                store.remove(K.lids);
                /* First sync pushes everything this device already has, so the stuff the
                 * user has been collecting locally does not look like it vanished. A
                 * failure here must not hide the key: the account exists. */
                try { await self.sync(); } catch (e) { log('first sync failed: ' + e.message); }
                return { recovery_key: r.recovery_key, label: r.label };
            },

            /* ── ADD THIS DEVICE TO AN EXISTING ACCOUNT ─────────────────────────────
             * This device shows a code; the user types it into a device that is already
             * signed in. See ACCOUNTS-DESIGN.md for why it runs in this direction. */
            async startPairing(onPaired, onExpired, labelHint) {
                self.cancelPairing();
                await ensureBackend();
                const token = mintToken();
                const r = await api('POST', '/api/device/claim',
                                    { platform, label: labelHint }, token);
                claimTimer = setInterval(async () => {
                    let res;
                    try {
                        res = await api('GET', '/api/device/claim', undefined, token);
                    } catch (e) {
                        if (e.status === 404) {
                            self.cancelPairing();
                            if (onExpired) onExpired();
                        }
                        return;                 // a blip on the network is not an expiry
                    }
                    if (res.status !== 'approved') return;
                    self.cancelPairing();
                    store.set(K.token, token);
                    store.set(K.account, res.account_id);
                    store.set(K.device, res.device_id);
                    store.set(K.label, res.label);
                    store.set(K.choice, 'on');
                    /* ⚠ NO K.rkey HERE. A device that joined by pairing was never shown
                     * a key, and an OLD key from an earlier account on this device would
                     * now be the wrong one, so it goes. */
                    store.remove(K.rkey);
                    store.remove(K.since);
                    store.remove(K.seen);
                    store.remove(K.lids);
                    try { await self.sync(); } catch (e) { log('first sync failed: ' + e.message); }
                    if (onPaired) onPaired(res);
                }, POLL_MS);
                return { code: r.code, expires_in: r.expires_in };
            },

            cancelPairing() {
                if (claimTimer) { clearInterval(claimTimer); claimTimer = null; }
            },

            /** On the device that is already signed in: let the other one in. */
            approve(code) {
                return api('POST', '/api/device/approve', { code: String(code) });
            },

            /* ── LOST EVERY DEVICE ──────────────────────────────────────────────────
             * The recovery key is the whole account. There is no email to fall back on,
             * which is the deliberate trade for storing nothing about anyone. */
            async recover(recoveryKey, labelHint) {
                await ensureBackend();
                const r = await api('POST', '/api/account/recover',
                                    { recovery_key: recoveryKey, platform, label: labelHint },
                                    null);
                store.set(K.token, r.device_token);
                store.set(K.account, r.account_id);
                store.set(K.device, r.device_id);
                store.set(K.label, r.label);
                /* They just typed it in, so they have it, but keeping it means the
                 * panel can show it back, same as on a fresh sign-up. */
                store.set(K.rkey, recoveryKey);
                store.set(K.choice, 'on');
                store.remove(K.since);
                store.remove(K.seen);
                store.remove(K.lids);
                try { await self.sync(); } catch (e) { log('first sync failed: ' + e.message); }
                return r;
            },

            devices() { return api('GET', '/api/devices'); },
            renameDevice(id, label) {
                return api('PATCH', '/api/devices/' + encodeURIComponent(id), { label });
            },

            async revokeDevice(id) {
                const r = await api('DELETE', '/api/devices/' + encodeURIComponent(id));
                if (r.was_current) forgetLocal();        // we just signed ourselves out
                return r;
            },

            async newRecoveryKey() {
                const r = await api('POST', '/api/account/recovery-key');
                /* The old one is dead the instant this returns, so replacing the stored
                 * copy is not optional. */
                if (r && r.recovery_key) store.set(K.rkey, r.recovery_key);
                return r;
            },

            async deleteAccount() {
                const r = await api('DELETE', '/api/account');
                forgetLocal();
                /* The account is gone, so the key opens nothing. */
                store.remove(K.rkey);
                pendWt = {}; pendGt = {};
                store.remove(K.wt);
                store.remove(K.gt);
                return r;
            },

            /** Local only: forget the credential, keep the data, leave the account alone. */
            signOut() {
                self.cancelPairing();
                forgetLocal();
                /* ⚠ THE AUTO TIMER IS LEFT RUNNING ON PURPOSE. Its tick checks for a
                 * credential before doing anything, so while signed out it makes no
                 * requests, and leaving it alive is what lets a user sign back in later
                 * in the same session and have background sync just work. */
            },

            /* ── THE SYNC ITSELF ────────────────────────────────────────────────────── */
            sync() {
                /* One at a time. Two overlapping runs would each diff against the same
                 * `seen` and push the same rows twice. */
                if (inFlight) return inFlight;
                inFlight = runSync().finally(() => { inFlight = null; });
                return inFlight;
            },

            /**
             * Background sync. `onSynced(summary)` is called after every run that pulled
             * something, so the app can redraw. The first version had no such hook: rows
             * pulled by the timer reached the disk and never reached the screen.
             */
            startAuto(ms, onSynced) {
                self.stopAuto();
                const every = Math.max(30000, ms || 120000);
                autoTimer = setInterval(() => {
                    if (!getToken()) return;
                    self.sync().then((s) => {
                        if (onSynced && s && (s.pulled.watch || s.pulled.favorites || s.pulled.settings)) {
                            try { onSynced(s); } catch (e) { log('refresh after sync: ' + e.message); }
                        }
                    }).catch((e) => log('auto sync: ' + e.message));
                }, every);
            },
            stopAuto() {
                if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
            },
        };

        async function loadKind(kind) {
            const rows = await adapter['load' + cap(kind)]();
            if (!Array.isArray(rows)) throw new Error('could not read local ' + kind);
            return rows;
        }

        async function runSync() {
            if (!getToken()) throw new Error('not signed in');
            flushWatchClock();
            const since = Number(store.get(K.since) || 0) || 0;
            const seen = readSeen();

            // ── 0. IDENTITY: give rows an AniList id where a title matches strictly ───
            /* ⚠ BEFORE THE PULL, NOT AFTER. A row pulled as `al:123` can only be matched
             * to the local copy of that show if the local copy already knows it is 123.
             * Looked up afterwards, the pull has already been stored as a second row. */
            if (adapter.saveIdentity) {
                const todo = [], byTitle = new Map();
                for (const kind of KINDS) {
                    for (const r of await loadKind(kind)) {
                        if (r._resolved !== false || !filled(r.title)) continue;
                        const t = String(r.title) + '\u0001' + String(r.title_english || '');
                        if (!byTitle.has(t)) byTitle.set(t, { name: r.title, alt: r.title_english, rows: [] });
                        byTitle.get(t).rows.push({ kind, id: r._lid });
                    }
                }
                byTitle.forEach((v) => todo.push(v));
                if (todo.length) {
                    /* A device meeting an account for the first time gets a bigger
                     * allowance, because every row it cannot match becomes a duplicate
                     * until the next sync folds it. */
                    const first = !since && !Object.keys(seen).length;
                    const ids = await resolveIdentity(todo, fetchImpl || undefined,
                                                      first ? RESOLVE_REQUESTS_PER_SYNC * 2 : RESOLVE_REQUESTS_PER_SYNC);
                    for (const kind of KINDS) {
                        const updates = [];
                        todo.forEach((t, i) => {
                            if (ids[i] === undefined) return;
                            for (const row of t.rows) if (row.kind === kind) updates.push({ id: row.id, anilist_id: ids[i] });
                        });
                        if (updates.length) await adapter.saveIdentity(kind, updates);
                    }
                }
            }

            // ── 1. PULL ───────────────────────────────────────────────────────────────
            const remote = await api('GET', '/api/sync?since=' + since);
            const journal = (adapter.loadDeleted ? await adapter.loadDeleted() : null) || {};
            const overruled = { watch: [], favorites: [] };

            // ── 2. DECIDE, row by row, what the pull means on THIS device ─────────────
            const applied = { watch: 0, favorites: 0, settings: 0 };
            for (const kind of KINDS) {
                const rows = remote[kind] || [];
                if (!rows.length) continue;
                const local = new Map((await loadKind(kind)).map((r) => [String(r.anime_id), r]));
                const was = seen[kind] || {};
                const gone = journal[kind] || {};
                const out = [];
                for (const r of rows) {
                    if (!r || r.anime_id === undefined || r.anime_id === null) continue;
                    const key = String(r.anime_id);
                    const mine = local.get(key) || null;
                    const hSeen = was[key];
                    const hMine = mine ? hashRow(mine) : undefined;

                    if (r.deleted) {
                        /* Someone else removed it. That only holds here if this device
                         * still has the row exactly as it last synced it. A row that is
                         * new here, or changed here since, is newer than their delete. */
                        if (mine && hSeen !== undefined && hMine === hSeen) out.push({ anime_id: key, deleted: true });
                        continue;
                    }
                    /* Our own last push coming back, or a row already applied. THIS LINE
                     * IS RULE 1: without it the echo overwrote whatever changed since. */
                    if (hashRow(r) === hSeen) continue;

                    if (gone[key] !== undefined) {
                        /* Removed here, edited there. The later of the two wins. */
                        if ((Number(r.updated_at) || 0) <= Number(gone[key])) continue;
                        overruled[kind].push(key);
                    }
                    if (!mine) { out.push(r); continue; }
                    const bothChanged = hSeen === undefined || hMine !== hSeen;
                    const merged = mergeRows(kind, mine, r, bothChanged);
                    if (hashRow(merged) !== hMine) out.push(merged);
                }
                if (out.length) {
                    await adapter['apply' + cap(kind)](out);
                    applied[kind] = out.length;
                }
            }

            // settings: the same three cases, without the merge
            const remoteSettings = remote.settings || [];
            let localSettings = adapter.loadSettings ? ((await adapter.loadSettings()) || []) : [];
            if (remoteSettings.length && adapter.applySettings) {
                const was = seen.settings || {};
                const mine = new Map(localSettings.map((s) => [s.key, hashRow({ key: s.key, value: s.value })]));
                const out = [];
                for (const s of remoteSettings) {
                    if (!s || !s.key) continue;
                    const h = hashRow({ key: s.key, value: s.value });
                    if (h === was[s.key]) continue;                       // our own echo
                    const hMine = mine.get(s.key);
                    /* Changed here since the last sync: ours is about to be pushed. On a
                     * device that has never synced, the account's value is the one. */
                    if (was[s.key] !== undefined && hMine !== was[s.key]) continue;
                    if (h !== hMine) out.push({ key: s.key, value: s.value });
                }
                if (out.length) {
                    await adapter.applySettings(out);
                    applied.settings = out.length;
                    localSettings = (await adapter.loadSettings()) || [];
                }
            }

            // ── 3. DIFF local against what we last saw ───────────────────────────────
            const nextSeen = {};
            const nextLids = {};
            const lids = readJson(K.lids);
            const payload = {};
            const cleared = { watch: [], favorites: [] };
            let pushCount = 0;

            for (const kind of KINDS) {
                const rows = await loadKind(kind);
                const was = seen[kind] || {};
                const wasLid = lids[kind] || {};
                const gone = journal[kind] || {};
                const now = {}, nowLid = {};
                const out = [];
                const tombs = new Set();
                for (const row of rows) {
                    if (!row || row.anime_id === undefined || row.anime_id === null) continue;
                    const key = String(row.anime_id);
                    const h = hashRow(row);
                    now[key] = h;
                    if (row._lid !== undefined) {
                        nowLid[row._lid] = key;
                        /* This row used to sync under another key (it gained an AniList
                         * id). Retire the old key, or the show lives on twice.
                         *
                         * ⛔ BUT ONLY FOR A ROW THIS DEVICE MADE. A guest row's old key is
                         * another device's own id for the show, and that device is still
                         * using it: a tombstone from here was pulled by the owner as "your
                         * row was deleted", and the owner deleted it. The owner retires
                         * its key itself when its own lookup succeeds. */
                        const old = wasLid[row._lid];
                        if (old !== undefined && old !== key && !row._guest) tombs.add(old);
                    }
                    if (was[key] !== h) { out.push(wire(row)); pushCount++; }
                }
                /* ⛔ RULE 2. Tombstones come from the journal and from nowhere else. A
                 * row that is simply absent (capped off the list, or the file did not
                 * read) is left alone on the server and on every other device. */
                for (const key of Object.keys(gone)) {
                    if (now[key] !== undefined) { cleared[kind].push(key); continue; }   // re-added since
                    if (overruled[kind].indexOf(key) >= 0) { cleared[kind].push(key); continue; }
                    tombs.add(key);
                    cleared[kind].push(key);
                }
                for (const key of tombs) {
                    if (now[key] !== undefined) continue;
                    out.push({ anime_id: key, deleted: true });
                    pushCount++;
                }
                nextSeen[kind] = now;
                nextLids[kind] = nowLid;
                if (out.length) payload[kind] = out;
            }

            {
                const was = seen.settings || {};
                const now = {};
                const out = [];
                for (const s of localSettings) {
                    if (!s || !s.key) continue;
                    const h = hashRow({ key: s.key, value: s.value });
                    now[s.key] = h;
                    if (was[s.key] !== h) { out.push({ key: s.key, value: s.value }); pushCount++; }
                }
                nextSeen.settings = now;
                if (out.length) payload.settings = out;
            }

            /* The counters go up with every sync. They are monotonic and the server
             * takes MAX, so re-sending the same totals is harmless. */
            const wt = readJson(K.wt), gt = readJson(K.gt);
            const wtRows = Object.keys(wt)
                .map((d) => ({ day: d, seconds: Math.round(wt[d]) }))
                .filter((r) => r.seconds > 0);
            const gtRows = Object.keys(gt)
                .map((g) => ({ genre: g, seconds: Math.round(gt[g]) }))
                .filter((r) => r.seconds > 0);
            if (wtRows.length) { payload.watch_time = wtRows; pushCount += wtRows.length; }
            if (gtRows.length) { payload.genre_time = gtRows; pushCount += gtRows.length; }

            // ── 4. PUSH ──────────────────────────────────────────────────────────────
            if (pushCount) await api('POST', '/api/sync', payload);

            /* The journal entries are done with only AFTER the push landed. Clearing
             * them first would lose a delete to one failed request. */
            if (adapter.clearDeleted) {
                for (const kind of KINDS) {
                    if (cleared[kind].length) await adapter.clearDeleted(kind, cleared[kind]);
                }
            }

            /* ⚠ RULE 3: THE CURSOR IS THE PULL'S CLOCK MINUS AN OVERLAP. Another device
             * can land a write between our pull and our push, and a push stamped before
             * our pull can commit after it. Rule 1 makes re-receiving rows free. */
            store.set(K.since, String(Math.max(0, (Number(remote.now) || 0) - CURSOR_OVERLAP_MS)));
            store.set(K.seen, JSON.stringify(nextSeen));
            store.set(K.lids, JSON.stringify(nextLids));
            store.set(K.at, String(Date.now()));

            const summary = { pulled: applied, pushed: pushCount, at: Date.now() };
            log('sync: applied ' + (applied.watch + applied.favorites + applied.settings) +
                ', pushed ' + pushCount);
            return summary;
        }

        /** A row as it goes on the wire: the local notes stay home. */
        function wire(row) {
            const o = {};
            for (const k of Object.keys(row)) if (k.charAt(0) !== '_') o[k] = row[k];
            return o;
        }

        function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

        return self;
    }

    const api = { create, shape, settingsAdapter, resolveIdentity, hashRow, mergeRows,
                  unionEpisodes, DEFAULT_EDGE, CURSOR_OVERLAP_MS };
    root.ANIMATE_SYNC = api;

    /* The desktop loads this over HTTP into a browser page; the Node server and the tests
     * load it as a module. Export both ways so neither has to care. */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
