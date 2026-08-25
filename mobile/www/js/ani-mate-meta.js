// YASA PRESENTS
// ani-mate-meta.js — redundant metadata layer for ANI-MATE
//
// WHY THIS EXISTS (2026-08-25)
//   Covers, titles, genres and episode counts come from a metadata service, and the app
//   had exactly one path to each. Measured this day, api.jikan.moe returned 200 on one
//   request and 504 on the next within the same minute — it is alive but flaky, and a
//   flaky single source shows up as missing covers with no explanation.
//
//   AniList is the sturdier of the two (POST /graphql answered every attempt) so it
//   leads; Jikan and Kitsu stand behind it. A miss on all three is cached briefly so a
//   dead title does not re-ask on every scroll.
//
// All requests go through window.NET, so if a metadata host ever ends up behind a
// browser check the transport layer handles it exactly as it does for the sources.

(function () {
    'use strict';

    const NET = window.NET;
    if (!NET) { console.error('ani-mate-meta: NET layer missing'); return; }

    const TTL_OK   = 60 * 60 * 1000;   // an hour for a hit
    const TTL_MISS =  5 * 60 * 1000;   // five minutes for a miss, so outages self-heal
    const cache = new Map();

    function cached(key) {
        const e = cache.get(key);
        if (!e) return undefined;
        if (Date.now() > e.exp) { cache.delete(key); return undefined; }
        return e.val;
    }
    function put(key, val) {
        cache.set(key, { val, exp: Date.now() + (val ? TTL_OK : TTL_MISS) });
        return val;
    }

    // ── AniList ────────────────────────────────────────────────────────────
    const ANILIST = 'https://graphql.anilist.co';

    async function anilist(query) {
        const gql = `query($q:String){Media(search:$q,type:ANIME){
            id title{romaji english} description(asHtml:false) episodes format status
            averageScore genres seasonYear coverImage{large extraLarge} bannerImage }}`;
        // AniList is POST-only; NET is a GET layer, so this one call uses fetch directly
        // and falls through to the next provider on any failure.
        try {
            const r = await fetch(ANILIST, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query: gql, variables: { q: query } }),
                signal: AbortSignal.timeout(9000)
            });
            if (!r.ok) return null;
            const j = await r.json();
            const m = j?.data?.Media;
            if (!m) return null;
            return {
                source: 'anilist',
                id: m.id,
                title: m.title?.english || m.title?.romaji || query,
                title_romaji: m.title?.romaji || null,
                description: (m.description || '').replace(/<[^>]+>/g, ''),
                episodes: m.episodes ?? null,
                format: m.format || null,
                status: m.status || null,
                score: m.averageScore ?? null,
                genres: m.genres || [],
                year: m.seasonYear ?? null,
                cover: m.coverImage?.extraLarge || m.coverImage?.large || null,
                banner: m.bannerImage || null
            };
        } catch { return null; }
    }

    // ── Jikan (MyAnimeList) ────────────────────────────────────────────────
    async function jikan(query) {
        const j = await NET.json(
            `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1&sfw=true`);
        const d = j?.data?.[0];
        if (!d) return null;
        return {
            source: 'jikan',
            id: d.mal_id,
            title: d.title_english || d.title,
            title_romaji: d.title || null,
            description: d.synopsis || '',
            episodes: d.episodes ?? null,
            format: d.type || null,
            status: d.status || null,
            score: d.score != null ? Math.round(d.score * 10) : null,
            genres: (d.genres || []).map(g => g.name),
            year: d.year ?? null,
            cover: d.images?.jpg?.large_image_url || d.images?.jpg?.image_url || null,
            banner: null
        };
    }

    // ── Kitsu ──────────────────────────────────────────────────────────────
    async function kitsu(query) {
        const j = await NET.json(
            `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=1`);
        const d = j?.data?.[0]?.attributes;
        if (!d) return null;
        return {
            source: 'kitsu',
            id: j.data[0].id,
            title: d.titles?.en || d.canonicalTitle || query,
            title_romaji: d.titles?.en_jp || null,
            description: d.synopsis || '',
            episodes: d.episodeCount ?? null,
            format: d.subtype || null,
            status: d.status || null,
            score: d.averageRating ? Math.round(parseFloat(d.averageRating)) : null,
            genres: [],
            year: d.startDate ? Number(String(d.startDate).slice(0, 4)) : null,
            cover: d.posterImage?.large || d.posterImage?.original || null,
            banner: d.coverImage?.original || null
        };
    }

    const CHAIN = [
        { id: 'anilist', fn: anilist },
        { id: 'jikan',   fn: jikan   },
        { id: 'kitsu',   fn: kitsu   }
    ];

    /** Metadata for one title, from whichever service answers first. Never throws. */
    async function lookup(query) {
        if (!query) return null;
        const key = 'm:' + query.toLowerCase();
        const hit = cached(key);
        if (hit !== undefined) return hit;
        for (const step of CHAIN) {
            try {
                const out = await step.fn(query);
                if (out) return put(key, out);
            } catch { /* next */ }
        }
        return put(key, null);
    }

    /** Just the cover, which is the hottest path — same chain, same cache. */
    async function cover(query) {
        const m = await lookup(query);
        return m?.cover || null;
    }

    /** Which metadata services are answering right now. */
    async function healthCheck() {
        const rows = await Promise.all(CHAIN.map(async step => {
            const t0 = Date.now();
            try {
                const ok = !!(await step.fn('one piece'));
                return { id: step.id, state: ok ? 'up' : 'down', ms: Date.now() - t0 };
            } catch (e) {
                return { id: step.id, state: 'down', ms: Date.now() - t0 };
            }
        }));
        return rows;
    }

    window.META = { lookup, cover, healthCheck, clear: () => cache.clear() };
})();
