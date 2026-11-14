'use strict';
/**
 * hianime-at.js — a working stream source, implemented from ani-cli 5.1.5's recipe.
 *
 * WHY THIS EXISTS (2026-10-05)
 *   Every source ANI-MATE had was dead at once:
 *     AllAnime   AA_CRYPTO_MISSING — moved to a per-epoch AES-GCM aaReq token
 *     AniDB      503, "Under Maintenance"
 *     AnimePahe  real site is behind Cloudflare, consumet pins a NXDOMAIN host
 *     HiAnime    consumet pins hianime.to, which does not resolve
 *
 *   Reading the actual ani-cli script rather than articles about it gave the answer in one
 *   line: `base_api="https://hianime.at"`. A host nobody had tried, alive, and reachable
 *   with a plain request — no TLS impersonation needed for any step measured here.
 *
 * THE CHAIN, ALL FIVE STEPS VERIFIED LIVE ON 2026-10-05 (Cowboy Bebop, episode 1)
 *   1. GET /search?keyword=...                      -> slug, e.g. cowboy-bebop-1281
 *   2. GET /api/theme/episode/list/<numeric tail>   -> 26 episode ids
 *   3. GET /api/theme/episode/servers?episodeId=    -> base64 hash per server/mode
 *   4. base64 -> embed url (zokoanime.video), fetch it, read window.__P
 *   5. base64(__P) XOR "otaku-embed-v1" -> JSON  -> m3u8 master + subtitle vtt + mal id
 *   master.m3u8 200 -> variant 200 -> segment HTTP 206, video/mp2t, first byte 0x47.
 *
 * THE OBFUSCATION IS NOT CRYPTO. It is a repeating 14-byte XOR against a FIXED key. Unlike
 * AllAnime's rotating epoch scheme there is nothing here to re-derive when it changes, which
 * is the whole reason this is the better source to depend on.
 *
 * AND IT RETURNS THINGS THE APP DID NOT HAVE BEFORE:
 *   - a real English WebVTT subtitle track (ANI-MATE had no subtitle track support at all)
 *   - the MyAnimeList id, which is what ani-skip needs for skip-intro
 *
 * Every request goes through `afetch` so it travels the Electron bridge when one exists.
 */

const BASE = process.env.ANI_MATE_HIANIME || 'https://hianime.at';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const XOR_KEY = Buffer.from('otaku-embed-v1');

/* Which show a hit is. Shared with every other stream provider so one fix reaches all
 * of them -- see the header of server/title-match.js. */
const { queryLadder, bestTrack, acceptableTier } = require('./title-match');

/* `mode` reaches a RegExp below. It arrives from an HTTP query string on the desktop and on
 * the public Worker, and until 2026-11-12 it was pasted in as received: a value such as
 * `(.+)+!` made one match call run for more than 30 seconds on a 34 character input,
 * which hangs the desktop server and burns the Worker's CPU limit. There are exactly two
 * modes, so anything that is not 'dub' is 'sub'. */
const modeOf = (m) => (m === 'dub' ? 'dub' : 'sub');

function makeProvider(afetch) {
    async function get(url, referer) {
        const r = await afetch(url, {
            headers: { 'User-Agent': AGENT, ...(referer ? { Referer: referer } : {}) },
        });
        const body = typeof r.text === 'function' ? await r.text() : (r.body || '');
        return { status: r.status, body };
    }

    /** Search -> [{ id: slug, name }]. The slug's numeric tail is the id every later call wants. */
    async function search(query) {
        const { body } = await get(`${BASE}/search?keyword=${encodeURIComponent(query)}`);
        // The top-10 sidebar repeats the result markup. Cut it before parsing or every hit doubles.
        const main = body.split('id="main-sidebar"')[0];
        const out = [];
        const re = /<h3 class="film-name">\s*<a href="[^"]*?\/([^"\/]+)"\s*title="([^"]*)"/g;
        let m;
        while ((m = re.exec(main))) out.push({ id: m[1], name: decodeEntities(m[2]) });
        return out;
    }

    /** Episode list -> [{ id, number }] in broadcast order. */
    async function episodes(slug) {
        const numericId = String(slug).split('-').pop();
        const { body } = await get(`${BASE}/api/theme/episode/list/${numericId}`);
        let html = '';
        try { html = (JSON.parse(body).html || ''); } catch { return []; }
        const out = [];
        const re = /data-number="(\d+)"[^>]*data-id="(\d+)"|data-id="(\d+)"[^>]*data-number="(\d+)"/g;
        let m;
        while ((m = re.exec(html))) {
            const number = m[1] || m[4];
            const id = m[2] || m[3];
            if (number && id) out.push({ id, number });
        }
        return out;
    }

    /**
     * Resolve one episode to a playable stream.
     * -> { url, referer, subtitles: [{lang,label,src,default}], malId, quality } or null
     */
    /* ── EVERY SERVER, NOT JUST ONE. Added 2026-11-07. ──────────────────────────
     * This adapter only ever read ZokoAnime. hianime also lists HD-1 (megaplay),
     * and HD-1 is the RICHER source: measured on Beastars Season 2 ep2 it returns
     * 36 subtitle tracks including four English variants, where ZokoAnime returns
     * three tracks total.
     *
     * That gap is why "no subtitles" kept recurring on individual episodes. When
     * ZokoAnime's only English file is signs-only, HD-1 frequently has a full one,
     * and nothing here ever looked.
     *
     * GRAFTING IS SAFE, and it was checked rather than assumed. The warning further
     * up about foreign subtitles drifting against a different encode does not apply
     * between these two: on Beastars S2 ep2 both servers return 300 cues with
     * identical timestamps (00:01:32.509, 00:01:33.635, ...) and identical text.
     * Same master, same timing.
     *
     * Each track carries its OWN referer, because the two hosts gate differently:
     * ZokoAnime's vtt wants zokoanime.video, HD-1's wants megaplay.buzz. A single
     * stream-level referer cannot serve both.
     */
    async function serversFor(episodeId) {
        const out = {};
        try {
            const r = await get(`${BASE}/api/theme/episode/servers?episodeId=${episodeId}`, `${BASE}/`);
            let html = '';
            try { html = JSON.parse(r.body).html || ''; } catch { return out; }
            html = html.replace(/\\"/g, '"');
            const re = /data-type="(\w+)"[^>]*data-server-name="([^"]+)"[^>]*data-hash="([^"]*)"/g;
            let m;
            while ((m = re.exec(html))) {
                if (m[1] !== 'sub' && m[1] !== 'dub') continue;
                out[m[1] + ':' + m[2]] = Buffer.from(m[3], 'base64').toString('utf8');
            }
        } catch { /* a server list we cannot read just means fewer candidates */ }
        return out;
    }

    async function megaplayTracks(embed) {
        try {
            const page = await get(embed, `${BASE}/`);
            const id = (page.body.match(/data-id="(\d+)"/) || [])[1];
            if (!id) return [];
            const host = embed.replace(/^(https?:\/\/[^/]*).*/, '$1');
            const r = await get(`${host}/stream/getSources?id=${id}`, embed);
            let j;
            try { j = JSON.parse(r.body); } catch { return []; }
            return (j.tracks || [])
                .filter((x) => x && x.file && x.kind !== 'thumbnails')
                .map((x) => ({
                    lang: /^english/i.test(x.label || '') ? 'en' : (x.lang || ''),
                    label: x.label || x.lang || 'Subtitles',
                    src: x.file,
                    default: !!x.default,
                    referer: host + '/',          // megaplay's CDN gates on its own host
                }));
        } catch { return []; }
    }

    /* ── THE DUB LISTING IS A SUBTITLE SOURCE. Added 2026-11-07 for v0.6.0. ──────────
     *
     * THIS IS THE FIX FOR THE BUG THAT OPENED 0.6.0, and it was hiding in plain sight.
     * hianime lists sub and dub servers for the SAME episode id, and `stream()` only ever
     * read the servers matching the mode being played. Measured 2026-11-07:
     *
     *   BEASTARS FINAL SEASON Part 2 ep 1    sub:  1 track,  7 cues (signs)
     *                                        dub: 66 tracks, 336 cues (full dialogue)
     *   Cowboy Bebop ep 1                    sub:  2 tracks, 1 cue
     *                                        dub:  2 tracks, 217 cues
     *
     * Two episodes that have played silent for weeks, and a full script was one request away
     * on a server the sub path never looked at.
     *
     * ⛔ AND IT IS THE SAME VIDEO, WHICH IS WHY THIS IS SAFE WHERE AN EXTERNAL FILE IS NOT.
     * Same episode id, same encode, so the timing cannot drift. Checked rather than assumed:
     * every cue of the sub-mode signs track reappears in the dub-listing track, 4 of 7 at an
     * IDENTICAL timestamp and identical text (21.146 PLANT PRODUCTION RESEARCH FACILITY,
     * 242.033 A THREEFOLD DILEMMA, 577.118 CITY HALL, 725.057 YASUMARU FAMILY PHARMACY).
     * Same grid.
     *
     * The tracks may be dubtitles -- a transcript of the English dub rather than the sub
     * script -- so the WORDS can differ slightly from what a sub-only release would say. The
     * TIMING is the part that has to be right, and it is. 336 cues of approximately-right
     * words beat 7 signs by a distance that makes the distinction academic.
     */
    async function zokoTracks(embed) {
        try {
            const origin = embed.replace(/^(https?:\/\/[^/]*).*/, '$1/');
            const page = await get(embed, `${BASE}/`);
            const blob = (page.body.match(/window\.__P="([^"]*)"/) || [])[1];
            if (!blob) return [];
            const raw = Buffer.from(blob, 'base64');
            const dec = Buffer.alloc(raw.length);
            for (let i = 0; i < raw.length; i++) dec[i] = raw[i] ^ XOR_KEY[i % XOR_KEY.length];
            const cfg = JSON.parse(dec.toString('utf8'));
            return (Array.isArray(cfg.subtitles) ? cfg.subtitles : [])
                .map((s) => Object.assign({}, s, { referer: s.referer || origin }));
        } catch { return []; }
    }

    /** Every subtitle track hianime has for one episode in one mode, across all its servers. */
    async function tracksForMode(episodeId, mode) {
        mode = modeOf(mode);
        const servers = await serversFor(episodeId);
        let out = [];
        for (const key of Object.keys(servers)) {
            if (!key.startsWith(mode + ':')) continue;
            out = out.concat(/ZokoAnime/i.test(key)
                ? await zokoTracks(servers[key])
                : await megaplayTracks(servers[key]));
        }
        return out;
    }

    async function stream(episodeId, mode = 'sub') {
        mode = modeOf(mode);
        const { body } = await get(`${BASE}/api/theme/episode/servers?episodeId=${episodeId}`);
        let html = '';
        try { html = (JSON.parse(body).html || ''); } catch { return null; }

        // ZokoAnime is the only embed whose config this understands. The others use different
        // players, so taking "any server" would hand back a page we cannot parse.
        const re = new RegExp(
            `data-type="${mode}"[^>]*data-server-name="ZokoAnime"[^>]*data-hash="([^"]*)"`, 'i');
        const hit = html.replace(/\\"/g, '"').match(re);
        if (!hit) return null;

        const embed = Buffer.from(hit[1], 'base64').toString('utf8');
        if (!/^https?:\/\//.test(embed)) return null;
        const embedOrigin = embed.replace(/^(https?:\/\/[^/]*).*/, '$1/');
        const malId = (embed.match(/\/mal\/(\d+)\//) || [])[1] || null;

        const page = await get(embed, `${BASE}/`);
        const blob = (page.body.match(/window\.__P="([^"]*)"/) || [])[1];
        if (!blob) return null;

        // base64, then a repeating XOR against a fixed key. Not a cipher, a scramble.
        const raw = Buffer.from(blob, 'base64');
        const dec = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i++) dec[i] = raw[i] ^ XOR_KEY[i % XOR_KEY.length];

        let cfg;
        try { cfg = JSON.parse(dec.toString('utf8')); } catch { return null; }
        if (!cfg.src) return null;

        // ZokoAnime's own tracks, tagged with the referer THEIR host needs.
        const zoko = (Array.isArray(cfg.subtitles) ? cfg.subtitles : [])
            .map((s) => Object.assign({}, s, { referer: s.referer || embedOrigin }));

        // Pool in HD-1's, which is usually the richer list. Same timing, checked.
        let extra = [];
        const servers = await serversFor(episodeId);
        for (const key of Object.keys(servers)) {
            if (!key.startsWith(mode + ':')) continue;
            if (/ZokoAnime/i.test(key)) continue;          // already have it
            extra = extra.concat(await megaplayTracks(servers[key]));
        }
        const seen = new Set(zoko.map((s) => s.src));
        const subtitles = zoko.concat(extra.filter((s) => s.src && !seen.has(s.src)));

        return {
            url: cfg.src,
            referer: embedOrigin,         // the CDN rejects the request without this
            subtitles,
            malId,
            quality: (cfg.player && cfg.player.default_quality) || 'auto',
        };
    }

    /**
     * Title -> stream, the shape getEpisodeUrlWithFallbacks wants.
     *
     * WHY THIS WALKS THE SEARCH HITS INSTEAD OF TAKING THE FIRST (2026-10-22)
     *   This took hits[0] and stopped. Tokyo Revengers: Tenjiku-hen episode 11 showed what
     *   that costs. hianime.at lists that show twice:
     *     tokyo-revengers-tenjiku-arc-222              <- hits[0], ep 11 subtitles: []
     *     tokyo-revengers-tenjiku-hen-uncensored-9614  <- hits[1], ep 11 subtitles: ["English"]
     *   Episodes 10 and 12 of the first listing both carry an English track, so the show
     *   looked fine and exactly one episode played silent. Checked upstream directly: the
     *   empty array is what ZokoAnime returns, and the HD-1 server (megaplay) returns
     *   "tracks":[] for the same episode, so it is a genuine hole in that ONE listing --
     *   not a parse failure here, and not something a different server on that listing fixes.
     *
     *   So: keep the first PLAYABLE stream, but keep looking for one that can also be read,
     *   and prefer that. The alternate listing's stream and its .vtt come from the same
     *   encode, so they stay in sync -- grafting a foreign subtitle file onto the original
     *   stream would risk drift, which is worse than no subtitles.
     *
     *   Cost: nothing on the happy path. The first listing with a track returns immediately.
     *   The extra lookups only happen for an episode that currently plays with no subtitles
     *   at all.
     */
    const MAX_LISTINGS = 4;

    /* ── A TRACK EXISTING IS NOT A TRACK WORKING. Added 2026-11-01. ───────────────
     * Beastars Season 2 episode 1 played with no readable subtitles even though a
     * track was present, selected and showing. Measured against the two listings
     * hianime.at returns for that title:
     *
     *   "Beastars Final Season Part 2"  English ->    7 cues   <- hits[0], taken
     *   "Beastars 2nd Season"           English ->  301 cues   <- the real one
     *
     * The 7-cue file is signs only: PLANT PRODUCTION RESEARCH FACILITY, CITY HALL,
     * FESTIVAL OF THE METEOR. 362 bytes across a 24 minute episode.
     *
     * TWO EARLIER FIXES DO NOT CATCH IT, and that is the point.
     *   - the track ranker penalizes /forced/i in the LABEL. This file is labeled
     *     plain "English" and carries default:true. Nothing in the metadata says
     *     signs-only.
     *   - the walk below accepted the first listing with `subtitles.length`, which
     *     is presence, not usefulness. One signs track passes that test.
     *
     * So the only honest test is to open the file and count. A 24 minute episode of
     * dialogue runs 250-400 cues; a signs track runs under 30. 40 is the line.
     */
    const MIN_CUES = 40;

    /* ── WHICH SHOW IS THIS? -> server/title-match.js ───────────────────────────
     * normTitle, titleScore, titleAcceptable, queryLadder, bestTrack and the tier band all
     * used to live here, written across v0.5.5 to v0.5.8 with each version paying for a
     * specific failure. v0.6.0 added a second stream provider, and logic that decides WHICH
     * SHOW PLAYS must not exist in two copies that can drift apart -- that is the exact
     * complaint 0.6.0 was opened to answer. Moved out verbatim; the reasoning travelled with
     * it, because the reasoning is the valuable part.
     */

    async function cueCount(src, referer) {
        if (!src) return 0;
        try {
            const r = await get(src, referer);
            return (String(r.body).match(/ --> /g) || []).length;
        } catch { return -1; }   // unreadable; treat as unknown, not as signs-only
    }

    /* Episode counts for a set of listings, so the caller can work out what episode number a
     * subtitle database would use. Kept SEPARATE from streamByTitle and called only when an
     * episode turns out to have no readable track: it costs one request per listing, and the
     * happy path must not pay for a fallback it never uses. */
    async function listingCounts(listings) {
        const out = [];
        for (const l of (listings || []).slice(0, 8)) {
            try {
                const eps = await episodes(l.id);
                if (eps.length) out.push({ name: l.name, count: eps.length });
            } catch { /* a listing we cannot read simply contributes nothing */ }
        }
        return out;
    }

    /* WHAT THE CALLER NEEDS TO KNOW BEYOND THE URL. Added 2026-11-07.
     *
     * streamByTitle used to hand back a stream and nothing about the state of its subtitles,
     * so the server could not tell a full script from a 7-cue signs file and had no reason to
     * look elsewhere. The walk below ALREADY measures this; it just threw the number away.
     *
     *   subsQuality  'dialogue' | 'signs' | 'none'  -- 'signs' and 'none' are the cases worth
     *                                                 reaching outside hianime for
     *   subsCues     the cue count of the track the player will actually choose
     *   listing      which of the host's listings this came from
     *   allListings  every listing the search turned up, for absolute-episode mapping
     */
    function decorate(st, quality, cues, listing, allListings) {
        if (!st) return st;
        st.subsQuality = quality;
        st.subsCues = cues;
        st.listing = listing;
        st.allListings = allListings;
        return st;
    }

    async function streamByTitle(title, episodeNumber, mode = 'sub', opts = {}) {
        mode = modeOf(mode);
        // Widen the net until an ACCEPTABLE listing appears, then rank. Asking the
        // host for the exact title can return fewer and worse hits than asking for
        // less, so a single wrong hit is not a reason to stop looking.
        let hits = [];
        const seen = new Set();
        /* RUN THE WHOLE LADDER, do not stop at the first acceptable name. Stopping
         * early put "Tokyo Revengers: Santen Sensou-hen" on an 8-cue signs track:
         * the exact query returns exactly ONE listing, its name is acceptable, so
         * the search stopped there and the cue walk below had nothing to walk to.
         * The broader query "Tokyo Revengers" surfaces a listing with 380 cues.
         * A name being plausible is not the same as that listing being usable, and
         * only collecting every candidate first lets the cue check do its job. */
        for (const q of queryLadder(title)) {
            let got = [];
            try { got = await search(q); } catch { continue; }
            for (const h of got) if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); }
        }
        if (!hits.length) return null;

        /* EVERY listing the ladder found, kept before any filtering touches `hits`.
         * The tier filter below deliberately throws away "Part 1" when "Part 2" was asked
         * for, and Part 1's episode count is precisely what an absolute-episode offset is
         * computed from, so it has to be captured here or it is gone. Names and slugs only,
         * which the search already returned, so this costs nothing. */
        const allListings = hits.map((h) => ({ id: h.id, name: h.name }));

        // Keep only listings that are plausibly the show asked for. If ranking is
        // allowed to pick from a list containing nothing correct, it will still
        // return something, and that something plays.
        const tier = acceptableTier(hits, title, opts);
        if (!tier.length) {
            console.error(`[hianime.at] no listing matches "${title}" ` +
                          `(saw: ${hits.map((h) => h.name).join(', ')}). Refusing to ` +
                          `play a different entry in the same series.`);
            return null;
        }
        /* ⛔ IDENTITY IS A CONSTRAINT, NOT A SCORE. This is the whole lesson of 0.5.5
         * through 0.5.8 and it is enforced in title-match.js now, not here:
         *   - "Beastars Season 2" played Final Season Part 2, because that entry had more
         *     cues in that episode and cue count was being used as an identity test
         *   - "FINAL SEASON Part 2" played Part 1, 7 cues against 250
         * acceptableTier() filters to the plausible listings and keeps only the best-scoring
         * band, so the cue walk below can only ever choose between copies of the SAME show.
         */
        hits = tier;

        /* Pull the OTHER mode's tracks for this same episode and, if one of them is readable,
         * pool it onto the stream we already have. The stream is untouched -- only the
         * subtitle list grows -- so a user watching subbed keeps the subbed audio and simply
         * gets a track that has words in it. */
        async function crossMode(episodeId, mode, got, epNum, listingName, listings) {
            const other = mode === 'sub' ? 'dub' : 'sub';
            let tracks = [];
            try { tracks = await tracksForMode(episodeId, other); }
            catch (e) { console.error('[hianime.at] cross-mode lookup failed:', e.message); return null; }
            if (!tracks.length) return null;

            const pick = bestTrack(tracks.filter((t) =>
                /^en/i.test(t.lang || '') || /^english/i.test(t.label || '')));
            if (!pick) return null;
            const n = await cueCount(pick.src, pick.referer || got.referer);
            if (n < MIN_CUES) return null;

            /* Say where it came from. A dub-listing track can be a dubtitle, so the wording
             * may not match a sub release exactly, and the person watching is the only one
             * who can judge that. Hiding the origin is how a wrong season went unnoticed. */
            const label = `${pick.label || 'English'} (${other} server)`;

            /* ⛔ IT HAS TO CARRY default:true, AND THE SIGNS TRACK HAS TO LOSE IT.
             *
             * Caught in the player, not in the chain, and it would have shipped a fix that
             * fixed nothing. The UI ranks English at +100 and adds +1 for `default` as a
             * tiebreak. ZokoAnime's 7-cue signs file for this episode is labeled plain
             * "English" and carries default:true, so it scored 101 against this track's 100
             * and the player kept choosing the 7 signs over 336 lines of dialogue.
             *
             * Server-side cue counts said the fix worked. readyState and cues.length in a
             * real browser said the fix worked. Which track the ranker actually PICKED is a
             * third question, and it was the only one that mattered. */
            const others = (got.subtitles || [])
                .filter((s) => s.src !== pick.src)
                .map((s) => Object.assign({}, s, { default: false }));
            got.subtitles = [Object.assign({}, pick, { label, default: true })].concat(others);
            console.error(`[hianime.at] ep ${epNum}: the ${other} servers have a readable track ` +
                          `(${n} cues) for this same episode -- using it`);
            return decorate(got, 'dialogue', n, listingName, listings);
        }

        let silent = null;      // playable, but no subtitle track. Held as the fallback.
        let silentFrom = '';
        let signs = null;       // playable, has a track, but the track is signs only.
        let signsFrom = '';
        let signsCues = 0;

        for (const hit of hits.slice(0, MAX_LISTINGS)) {
            let got = null;
            let epId = null;        // hoisted: the cross-mode lookup below needs this id
            try {
                const eps = await episodes(hit.id);
                const ep = eps.find((e) => String(e.number) === String(episodeNumber));
                if (!ep) continue;
                epId = ep.id;
                got = await stream(ep.id, mode);
            } catch { continue; }
            if (!got || !got.url) continue;

            if (got.subtitles && got.subtitles.length) {
                const best = bestTrack(got.subtitles);
                // per-track referer: pooled tracks come from different hosts
                const n = await cueCount(best && best.src, (best && best.referer) || got.referer);
                if (n < 0 || n >= MIN_CUES) {          // readable, or unknown: take it
                    if (silent || signs) {
                        console.error(`[hianime.at] ep ${episodeNumber}: using "${hit.name}" ` +
                                      `(${n} cues) over "${signsFrom || silentFrom}"`);
                    }
                    return decorate(got, 'dialogue', n, hit.name, allListings);
                }
                console.error(`[hianime.at] ep ${episodeNumber}: "${hit.name}" track is signs only ` +
                              `(${n} cues), trying the ${mode === 'sub' ? 'dub' : 'sub'} servers ` +
                              `for this same episode`);
                const cross = await crossMode(epId, mode, got, episodeNumber, hit.name, allListings);
                if (cross) return cross;
                if (!signs) { signs = got; signsFrom = hit.name; signsCues = n; }
                continue;
            }
            /* No track at all in this mode. The other mode's servers are still worth asking:
             * they are the same episode, so anything they have is in sync by construction. */
            const cross = await crossMode(epId, mode, got, episodeNumber, hit.name, allListings);
            if (cross) return cross;
            if (!silent) { silent = got; silentFrom = hit.name; }
        }

        /* A signs-only track still beats nothing: it is in sync and names the places. It is
         * also the signal the caller uses to go looking outside hianime, which is why the
         * cue count travels with it instead of being logged and dropped. */
        if (signs) {
            console.error(`[hianime.at] ep ${episodeNumber}: no listing has a dialogue track ` +
                          `(checked ${Math.min(hits.length, MAX_LISTINGS)}), using "${signsFrom}" signs only`);
            return decorate(signs, 'signs', signsCues, signsFrom, allListings);
        }
        if (silent) {
            console.error(`[hianime.at] ep ${episodeNumber}: no listing has a subtitle track ` +
                          `(checked ${Math.min(hits.length, MAX_LISTINGS)}), playing "${silentFrom}" without one`);
            return decorate(silent, 'none', 0, silentFrom, allListings);
        }
        return silent;
    }

    return { name: 'HiAnime.at', base: BASE, search, episodes, stream, streamByTitle, listingCounts };
}

function decodeEntities(s) {
    return String(s).replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

module.exports = { makeProvider };
