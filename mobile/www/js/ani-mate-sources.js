// YASA PRESENTS
// ani-mate-sources.js — redundant streaming-source layer for ANI-MATE
//
// WHY THIS EXISTS (2026-08-25)
//   v0.4.5 restored streaming on desktop by adding one new source. Android shipped the
//   changelog for it and none of the code, so the phone was left with a single provider
//   (AllAnime) that had already gone behind Cloudflare — it could not play anything.
//   One source is one outage away from a dead app, and that is what happened.
//
//   This module makes the source a detail rather than a dependency. Providers register
//   themselves; every call walks the chain until one answers; a provider that fails is
//   put on a cooldown and demoted so the next call does not wait on it again.
//
// EVERY provider goes through window.NET (ani-mate-net.js), never a bare fetch.
// Measured 2026-08-25: anidb.app and api.allanime.day answer 403 to plain HTTP, and
// animepahe/animeheaven serve an interstitial or render their results in JS. Only a
// real browser stack reaches any of them.
//
// VERIFICATION STATUS — stated honestly, because a provider that has never returned a
// stream is a liability, not a redundancy:
//   anidb      chain documented and verified end-to-end 2026-08-22 (see server/providers/anidb.js)
//   allanime   chain is the one this app shipped for months; host is currently walled
//   animepahe  host is alive behind DDoS-Guard; selectors NOT yet confirmed -> disabled
//   animeheaven host is alive, results are JS-rendered; selectors NOT yet confirmed -> disabled
// A disabled provider is never called. Enable one only after its chain returns a real
// playlist on a device.

(function () {
    'use strict';

    const NET = window.NET;
    if (!NET) { console.error('ani-mate-sources: NET layer missing'); return; }

    // ── health / circuit breaker ───────────────────────────────────────────
    const HEALTH_KEY = 'ani-mate-source-health';
    const COOLDOWN_MS = 5 * 60 * 1000;   // a failing provider sits out this long
    const TRIP_AFTER = 2;                // consecutive failures before tripping

    let health = {};
    try { health = JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}'); } catch { health = {}; }

    function h(id) {
        if (!health[id]) health[id] = { ok: 0, fail: 0, streak: 0, until: 0, lastMs: 0 };
        return health[id];
    }
    function saveHealth() {
        try { localStorage.setItem(HEALTH_KEY, JSON.stringify(health)); } catch { /* ignore */ }
    }
    function noteOk(id, ms) {
        const s = h(id); s.ok++; s.streak = 0; s.until = 0; s.lastMs = ms; saveHealth();
    }
    function noteFail(id) {
        const s = h(id); s.fail++; s.streak++;
        if (s.streak >= TRIP_AFTER) s.until = Date.now() + COOLDOWN_MS;
        saveHealth();
    }
    function available(p) {
        return p.enabled && h(p.id).until < Date.now();
    }
    /** Best-first: never-failed before recovering, then by success rate, then by speed. */
    function ordered() {
        return PROVIDERS.filter(available).sort((a, b) => {
            const A = h(a.id), B = h(b.id);
            const ra = A.ok + A.fail ? A.ok / (A.ok + A.fail) : 0.5;
            const rb = B.ok + B.fail ? B.ok / (B.ok + B.fail) : 0.5;
            if (rb !== ra) return rb - ra;
            if (a.weight !== b.weight) return b.weight - a.weight;
            return (A.lastMs || 9999) - (B.lastMs || 9999);
        });
    }

    /** Run `fn` across the chain until one returns something useful. */
    async function firstAnswer(method, fn, { all = false } = {}) {
        const chain = ordered();
        const merged = [];
        for (const p of chain) {
            if (typeof p[method] !== 'function') continue;
            const t0 = Date.now();
            try {
                const out = await fn(p);
                const good = Array.isArray(out) ? out.length > 0 : !!out;
                if (good) {
                    noteOk(p.id, Date.now() - t0);
                    if (!all) return { provider: p.id, data: out };
                    merged.push(...out.map(x => ({ ...x, provider: p.id })));
                } else {
                    noteFail(p.id);
                }
            } catch (e) {
                noteFail(p.id);
            }
        }
        if (all && merged.length) return { provider: 'multi', data: merged };
        return { provider: null, data: all ? [] : null };
    }

    // ── provider: AniDB ────────────────────────────────────────────────────
    // Chain measured 2026-08-22 against one-piece (3880):
    //   /browse?q=            -> HTML, anchors /anime/{slug}-{id}
    //   /api/frontend/anime/{id}/episodes      -> { episodes:[{id,number,number2,filler}] }
    //   /api/frontend/episode/{ep}/languages   -> { languages:[{code,name,embed_url}] }
    //   {embed_url}                            -> HTML carrying a master .m3u8
    const ANIDB = 'https://anidb.app';
    const HLS_RE = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i;
    const ANIDB_LINK_RE = /\/anime\/([a-z0-9-]+)-(\d+)/gi;

    const anidb = {
        id: 'anidb', name: 'AniDB', weight: 100, enabled: true,
        async search(query) {
            const html = await NET.html(`${ANIDB}/browse?q=${encodeURIComponent(query)}`,
                                        { referer: ANIDB });
            const out = [], seen = new Set();
            let m; ANIDB_LINK_RE.lastIndex = 0;
            while ((m = ANIDB_LINK_RE.exec(html)) !== null) {
                if (seen.has(m[2])) continue;
                seen.add(m[2]);
                out.push({
                    id: m[2],
                    name: m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                });
                if (out.length >= 40) break;
            }
            return out;
        },
        async episodes(showId) {
            const j = await NET.json(`${ANIDB}/api/frontend/anime/${encodeURIComponent(showId)}/episodes`,
                                     { referer: ANIDB });
            const eps = Array.isArray(j?.episodes) ? j.episodes : [];
            return eps.map(e => ({
                id: e.id,
                number: e.number2 != null ? `${e.number}.${e.number2}` : String(e.number),
                filler: !!e.filler
            }));
        },
        async stream(episodeId, mode) {
            const j = await NET.json(`${ANIDB}/api/frontend/episode/${encodeURIComponent(episodeId)}/languages`,
                                     { referer: ANIDB });
            const langs = Array.isArray(j?.languages) ? j.languages : [];
            if (!langs.length) return null;
            const want = mode === 'dub' ? 'eng' : 'jpn';
            const pick = langs.find(l => l.code === want) || langs[0];
            if (!pick?.embed_url) return null;
            const html = await NET.html(pick.embed_url, { referer: ANIDB });
            const m = html.match(HLS_RE);
            return m ? { url: m[0], referer: ANIDB, language: pick.code, type: 'hls' } : null;
        },
        async probe() {
            const j = await NET.json(`${ANIDB}/api/frontend/anime/3880/episodes`, { referer: ANIDB });
            return Array.isArray(j?.episodes) && j.episodes.length > 0;
        }
    };

    // ── provider: AllAnime ─────────────────────────────────────────────────
    // The chain this app shipped for months. Host is currently behind Cloudflare, which
    // NET now clears, so it stays in the rotation rather than being deleted.
    const AA_API = 'https://api.allanime.day/api';
    const AA_REF = 'https://allmanga.to';

    // ⛔ THE 2026-08-25 NOTE HERE WAS WRONG AND IT COST THE PRIMARY SOURCE.
    // It read: "api.allanime.day answers 403 with a Cloudflare interstitial ... it is not
    // slow, it is unsolvable", and shipped this provider disabled.
    //
    // RE-MEASURED 2026-10-05, live, same minute:
    //     GET  https://api.allanime.day/api?variables=...&query=...  -> 403 "Just a moment..."
    //     POST https://api.allanime.day/api  {variables, query}       -> 200
    // It was never a challenge. The mobile client was sending GET to an endpoint that only
    // accepts POST, which DEVELOPMENT.md line 19 has said since April. The desktop server
    // has used POST since v0.4.4, which is the whole reason desktop worked and mobile did
    // not. ani-mate-api.js now sends POST, so SEARCH AND EPISODE LISTS WORK AGAIN.
    //
    // IT STAYS enabled:true BECAUSE SEARCH IS REAL VALUE ON ITS OWN. What is still broken
    // is narrower and unrelated: the `episode` query (the only one returning sourceUrls)
    // answers AA_CRYPTO_MISSING, because AllAnime moved to a per-epoch AES-GCM aaReq token.
    // So this provider SEARCHES but cannot yet STREAM. Disabling it would throw away the
    // working half to punish the broken half.
    const allanime = {
        id: 'allanime', name: 'AllAnime', weight: 80, enabled: true,
        note: 'search works (POST, fixed 2026-10-05); streams blocked by AA_CRYPTO_MISSING',
        async search(query, mode = 'sub') {
            const gql = 'query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } } }';
            const params = new URLSearchParams({
                variables: JSON.stringify({
                    search: { allowAdult: false, allowUnknown: false, query },
                    limit: 40, page: 1, translationType: mode, countryOrigin: 'ALL'
                }),
                query: gql
            });
            const j = await NET.json(`${AA_API}?${params}`, { referer: AA_REF });
            const edges = j?.data?.shows?.edges || [];
            return edges.map(e => ({ id: e._id, name: e.name, episodes: e.availableEpisodes }));
        },
        async episodes(showId, mode = 'sub') {
            const gql = 'query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail } }';
            const params = new URLSearchParams({
                variables: JSON.stringify({ showId }), query: gql
            });
            const j = await NET.json(`${AA_API}?${params}`, { referer: AA_REF });
            const detail = j?.data?.show?.availableEpisodesDetail;
            const list = detail?.[mode] || [];
            return list.slice().sort((a, b) => parseFloat(a) - parseFloat(b))
                       .map(n => ({ id: `${showId}::${n}`, number: String(n), filler: false }));
        },
        async stream(episodeId, mode = 'sub') {
            const [showId, num] = String(episodeId).split('::');
            if (!showId || !num) return null;
            const gql = 'query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode( showId: $showId translationType: $translationType episodeString: $episodeString ) { episodeString sourceUrls } }';
            const params = new URLSearchParams({
                variables: JSON.stringify({ showId, translationType: mode, episodeString: num }),
                query: gql
            });
            const j = await NET.json(`${AA_API}?${params}`, { referer: AA_REF });
            const srcs = j?.data?.episode?.sourceUrls || [];
            if (!srcs.length) return null;
            // Highest-priority source that yields a playlist wins.
            const sorted = srcs.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
            for (const s of sorted) {
                const raw = s.sourceUrl || '';
                const url = raw.startsWith('--') ? window.API?.decodeProviderId?.(raw.slice(2)) : raw;
                if (!url) continue;
                if (HLS_RE.test(url)) return { url, referer: AA_REF, type: 'hls' };
                const body = await NET.get(url.startsWith('http') ? url : `https://allanime.day${url}`,
                                           { referer: AA_REF });
                const m = body.ok && body.body.match(HLS_RE);
                if (m) return { url: m[0], referer: AA_REF, type: 'hls' };
            }
            return null;
        },
        async probe() {
            const r = await this.search('one piece');
            return r.length > 0;
        }
    };

    // ── HiAnime.at ────────────────────────────────────────────────────────
    // PORTED FROM server/hianime-at.js 2026-10-06. It was desktop-only, which meant mobile
    // was shipping with AllAnime (streams blocked by AA_CRYPTO_MISSING) and AniDB as its only
    // enabled sources — and HiAnime is BOTH the one that currently resolves a playlist AND the
    // only one that returns a subtitle track at all. Mobile had no subtitles because it had no
    // source that carries them.
    //
    // TWO THINGS DIFFER FROM THE SERVER COPY, both because this runs in a webview:
    //   Buffer is not available, so base64 goes through atob() into a Uint8Array and the XOR
    //   output is decoded with TextDecoder. Doing the XOR on a JS string instead corrupts any
    //   byte above 0x7F and the JSON fails to parse for non-ASCII titles.
    //   afetch becomes NET.get, which already picks a transport and can set Referer — the
    //   chain needs one on every hop and a plain fetch() cannot.
    const HA_BASE = 'https://hianime.at';
    const HA_KEY  = new TextEncoder().encode('otaku-embed-v1');

    function haEntities(t) {
        return String(t).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'");
    }
    function haB64Bytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    const hianime = {
        id: 'hianime', name: 'HiAnime.at', weight: 120, enabled: false,
        // DISABLED ON PURPOSE, AND NOT BECAUSE THE CHAIN IS UNPROVEN — it is the only chain
        // that resolves on desktop right now. The blocker is transport.
        //
        // Measured 2026-10-06 against hls.dramahot.top:
        //     m3u8 direct, no referer   403        m3u8 with Referer   200
        //     .vtt direct, no referer   403        .vtt  with Referer  200
        //
        // Desktop clears this by routing media through the local /proxy-stream, which can set
        // Referer. MOBILE HAS NO SUCH PATH: Hls.js loads through the webview, and a browser is
        // forbidden from setting Referer on XHR/fetch, so NET.get's header support cannot reach
        // the media layer. Enabling it would make HiAnime the top-weighted provider by weight
        // and then fail every playback — strictly worse than today.
        //
        // TO TURN IT ON, mobile needs a referer-capable media transport (Capacitor HTTP feeding
        // Hls.js via a loader, or a tiny on-device proxy). That is the real work. Flip `enabled`
        // the same day that lands, not before.
        note: 'chain works; blocked on mobile having no referer-capable media transport',

        async search(query) {
            const r = await NET.get(`${HA_BASE}/search?keyword=${encodeURIComponent(query)}`,
                                    { referer: HA_BASE + '/', html: true });
            if (!r.ok) return [];
            // The top-10 sidebar repeats the result markup. Cut it or every hit doubles.
            const main = r.body.split('id="main-sidebar"')[0];
            const re = /<h3 class="film-name">\s*<a href="[^"]*?\/([^"\/]+)"\s*title="([^"]*)"/g;
            const out = []; let m;
            while ((m = re.exec(main))) out.push({ id: m[1], name: haEntities(m[2]) });
            return out;
        },

        async episodes(slug) {
            const numericId = String(slug).split('-').pop();
            const r = await NET.get(`${HA_BASE}/api/theme/episode/list/${numericId}`,
                                    { referer: HA_BASE + '/' });
            if (!r.ok) return [];
            let html = '';
            try { html = (JSON.parse(r.body).html || ''); } catch { return []; }
            const re = /data-number="(\d+)"[^>]*data-id="(\d+)"|data-id="(\d+)"[^>]*data-number="(\d+)"/g;
            const out = []; let m;
            while ((m = re.exec(html))) {
                const number = m[1] || m[4], id = m[2] || m[3];
                if (number && id) out.push({ id, number: String(number), filler: false });
            }
            return out;
        },

        async stream(episodeId, mode = 'sub') {
            const r = await NET.get(`${HA_BASE}/api/theme/episode/servers?episodeId=${episodeId}`,
                                    { referer: HA_BASE + '/' });
            if (!r.ok) return null;
            let html = '';
            try { html = (JSON.parse(r.body).html || ''); } catch { return null; }

            // ZokoAnime is the only embed whose config this understands. Taking "any server"
            // hands back a player page this cannot parse.
            const re = new RegExp(
                `data-type="${mode}"[^>]*data-server-name="ZokoAnime"[^>]*data-hash="([^"]*)"`, 'i');
            const hit = html.replace(/\\"/g, '"').match(re);
            if (!hit) return null;

            const embed = new TextDecoder().decode(haB64Bytes(hit[1]));
            if (!/^https?:\/\//.test(embed)) return null;
            const embedOrigin = embed.replace(/^(https?:\/\/[^/]*).*/, '$1/');

            const page = await NET.get(embed, { referer: HA_BASE + '/', html: true });
            if (!page.ok) return null;
            const blob = (page.body.match(/window\.__P="([^"]*)"/) || [])[1];
            if (!blob) return null;

            // base64, then a repeating XOR against a fixed key. Not a cipher, a scramble.
            const raw = haB64Bytes(blob);
            const dec = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) dec[i] = raw[i] ^ HA_KEY[i % HA_KEY.length];

            let cfg;
            try { cfg = JSON.parse(new TextDecoder().decode(dec)); } catch { return null; }
            if (!cfg.src) return null;

            return {
                url: cfg.src,
                referer: embedOrigin,      // the CDN rejects the request without this
                type: 'hls',
                subtitles: Array.isArray(cfg.subtitles) ? cfg.subtitles : [],
                malId: (embed.match(/\/mal\/(\d+)\//) || [])[1] || null,
            };
        },

        async probe() {
            const r = await this.search('one piece');
            return r.length > 0;
        }
    };

    // ── providers present but not yet trusted ──────────────────────────────
    // Both hosts answered on 2026-08-25, but neither chain has produced a playlist yet.
    // Shipping a guessed scraper as "redundancy" is how you get a second silent failure,
    // so they stay disabled until their selectors are confirmed on a device.
    const animepahe   = { id: 'animepahe',   name: 'AnimePahe',   weight: 60, enabled: false,
                          note: 'animepahe.su alive behind DDoS-Guard; chain unconfirmed' };
    const animeheaven = { id: 'animeheaven', name: 'AnimeHeaven', weight: 50, enabled: false,
                          note: 'animeheaven.me alive, results JS-rendered; chain unconfirmed' };

    const PROVIDERS = [hianime, anidb, allanime, animepahe, animeheaven];

    // ── public surface ─────────────────────────────────────────────────────
    // Ids are tagged with their provider so episodes() and stream() route home.
    const tag = (pid, id) => `${pid}:${id}`;
    const untag = (v) => {
        const s = String(v);
        const i = s.indexOf(':');
        if (i < 0) return { pid: null, id: s };
        return { pid: s.slice(0, i), id: s.slice(i + 1) };
    };
    const byId = (pid) => PROVIDERS.find(p => p.id === pid);

    async function search(query, mode = 'sub') {
        const r = await firstAnswer('search', p => p.search(query, mode), { all: true });
        return (r.data || []).map(x => ({ ...x, id: tag(x.provider, x.id) }));
    }

    async function episodes(taggedShowId, mode = 'sub') {
        const { pid, id } = untag(taggedShowId);
        const p = pid && byId(pid);
        if (p && available(p)) {
            const t0 = Date.now();
            try {
                const out = await p.episodes(id, mode);
                if (out?.length) { noteOk(p.id, Date.now() - t0); return out.map(e => ({ ...e, id: tag(pid, e.id) })); }
                noteFail(p.id);
            } catch { noteFail(p.id); }
        }
        // Owner is down — no other provider knows this id, so the caller must re-search.
        return [];
    }

    async function stream(taggedEpisodeId, mode = 'sub') {
        const { pid, id } = untag(taggedEpisodeId);
        const p = pid && byId(pid);
        if (!p || !available(p)) return null;
        const t0 = Date.now();
        try {
            const s = await p.stream(id, mode);
            if (s) { noteOk(p.id, Date.now() - t0); return { ...s, provider: p.id, providerName: p.name }; }
            noteFail(p.id);
        } catch { noteFail(p.id); }
        return null;
    }

    /** Every provider probed in parallel — what the UI shows instead of an empty list. */
    async function healthCheck() {
        const rows = await Promise.all(PROVIDERS.map(async p => {
            if (!p.enabled) return { id: p.id, name: p.name, state: 'disabled', note: p.note || '' };
            const t0 = Date.now();
            try {
                const ok = await p.probe();
                if (ok) noteOk(p.id, Date.now() - t0); else noteFail(p.id);
                return { id: p.id, name: p.name, state: ok ? 'up' : 'down', ms: Date.now() - t0 };
            } catch (e) {
                noteFail(p.id);
                return { id: p.id, name: p.name, state: 'down', ms: Date.now() - t0, error: String(e.message || e) };
            }
        }));
        return { checked: Date.now(), transports: NET.transports, sources: rows };
    }

    window.SOURCES = {
        search, episodes, stream, healthCheck,
        list: () => PROVIDERS.map(p => ({ id: p.id, name: p.name, enabled: p.enabled, ...h(p.id) })),
        reset: () => { health = {}; saveHealth(); return NET.reset(); }
    };
})();
