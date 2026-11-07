// YASA PRESENTS
// ani-mate-edge.js — point the phone at the shared backend instead of its own scraper.
//
// WHY THIS EXISTS (2026-11-07)
//   Desktop and mobile were two implementations of one app. ani-mate-api.js carries a
//   ~4,800 line port of the provider logic and talks to AllAnime directly, so every fix had
//   to be written twice or the two apps disagreed. They disagreed for months: the dub-server
//   subtitle fix, the hianime episode fallback that makes adult titles playable, the bigger
//   covers and the uncensored switch all landed on desktop and none of them reached here.
//
//   Now there is one backend, at ani-mate.yasadevstudio.workers.dev, and both clients call it.
//
// ⛔ THIS FILE REPLACES THREE METHODS ON window.API AND NOTHING ELSE.
//   The mobile UI calls exactly six API functions. Three of them need scraping and move to
//   the edge; three are AniList, which the edge CANNOT reach and the phone can:
//
//     searchAnime      -> edge /api/search
//     getEpisodeList   -> edge /api/episodes
//     getEpisodeUrl    -> edge /api/play
//     getDailyPopular  -> stays here (AniList)
//     getAnimeInfo     -> stays here (AniList)
//     getAiringSchedule-> stays here (AniList)
//
//   Measured on Cloudflare's edge 2026-11-07: graphql.anilist.co answers a Worker with
//   403 "You have been manually blocked. Please come to the principal's office." Six header
//   variants, all 403 -- an IP block, not a header problem. The same query from a client is
//   200. So AniList stays on the device, which is where a public CORS-enabled read API was
//   always meant to be called from.
//
//   Loaded AFTER ani-mate-api.js, so the originals exist and are kept as the fallback.
//
// ⚠ NO VIDEO GOES THROUGH THE EDGE. /api/play returns a URL and the referer its CDN
//   demands; the phone fetches the bytes itself through its own native transport, exactly
//   as it does today. Proxying video through a Worker would bill every byte and break the
//   referer gating anyway.

(function () {
    'use strict';

    const EDGE = 'https://ani-mate.yasadevstudio.workers.dev';
    const TIMEOUT = 20000;

    const original = {
        searchAnime: window.API && window.API.searchAnime,
        getEpisodeList: window.API && window.API.getEpisodeList,
        getEpisodeUrl: window.API && window.API.getEpisodeUrl,
    };
    if (!window.API) { console.warn('[edge] window.API missing; nothing to overlay'); return; }

    /* THE UI CALLS getEpisodeUrl WITH AN ID, NOT A TITLE, and the edge resolves by title --
     * it has to, because an AllAnime id means nothing to hianime. Rather than change the UI
     * (and every other caller), remember what each id was called when we saw it. */
    const titleOf = new Map();
    function remember(items) {
        for (const r of (items || [])) {
            if (r && r.id && r.name) titleOf.set(String(r.id), r.name);
        }
    }
    window.__edgeRemember = remember;        // so the AniList half can contribute too

    async function edge(path, params) {
        const u = new URL(EDGE + path);
        for (const [k, v] of Object.entries(params || {})) {
            if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
        }
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), TIMEOUT);
        try {
            const r = await fetch(u.toString(), { signal: ctl.signal, headers: { Accept: 'application/json' } });
            if (!r.ok) throw new Error('edge ' + r.status);
            return await r.json();
        } finally { clearTimeout(t); }
    }

    /* Every override degrades to the old local implementation. A phone on a captive
     * network, or an edge deploy that is briefly broken, must not mean a dead app --
     * the scraper that shipped in 0.6.0 is still sitting right there. */
    async function withFallback(name, fn, args) {
        try { return await fn(); }
        catch (e) {
            console.warn('[edge] ' + name + ' failed (' + (e && e.message) + '), using the local path');
            const orig = original[name];
            return orig ? orig.apply(window.API, args) : null;
        }
    }

    // ── SEARCH ────────────────────────────────────────────────────────────────────
    // The edge returns listings. AniList art, genres and descriptions are attached here,
    // on the device, because the edge is blocked from AniList.
    window.API.searchAnime = function (query, mode = 'sub', allowAdult = false) {
        return withFallback('searchAnime', async () => {
            const d = await edge('/api/search', { q: query });
            const hits = (d.results || []).map((h) => ({
                id: h.id,
                name: h.name,
                episodes: 0,
                type: 'series',
                mode,
            }));
            remember(hits);
            /* Enrich from AniList using the function that is still local. Best effort:
             * a listing with no art is still playable, and that matters more. */
            try {
                if (window.API.getAniListCovers && hits.length) {
                    const info = await window.API.getAniListCovers(hits.map((h) => h.name));
                    for (const h of hits) {
                        const i = info && info[h.name];
                        if (!i) continue;
                        h.cover = i.cover || null;
                        h.cover_color = i.cover_color || null;
                        h.description = i.description || null;
                        h.title_english = i.title_english || null;
                        h.genres = i.genres || [];
                        h.anilist_id = i.anilist_id || null;
                        h.anilist_format = i.format || null;
                        h.start_key = i.start_key || 0;
                        h.popularity = i.popularity || 0;
                    }
                }
            } catch { /* art is optional, playing is not */ }
            if (!allowAdult) {
                return hits.filter((h) => !/\b(hentai|uncensored)\b/i.test(h.name) || allowAdult);
            }
            return hits;
        }, [query, mode, allowAdult]);
    };

    // ── EPISODE LIST ──────────────────────────────────────────────────────────────
    // AllAnime first on the edge, then hianime by title. That second step is the one that
    // makes adult titles playable: they are in AniList and hianime but almost never in
    // AllAnime, so the list came back empty and there was nothing on screen to tap.
    window.API.getEpisodeList = function (showId, mode = 'sub', anilistId = null) {
        return withFallback('getEpisodeList', async () => {
            const d = await edge('/api/episodes', {
                id: showId,
                title: titleOf.get(String(showId)) || '',
                mode,
                nsfw: window.state && window.state.nsfw ? 'true' : '',
            });
            return d.episodes || [];
        }, [showId, mode, anilistId]);
    };

    // ── PLAY ──────────────────────────────────────────────────────────────────────
    // Shape matches what the mobile player already consumes: url, referer, subtitles,
    // resolution, all_links. Changing the UI was avoidable, so it was avoided.
    window.API.getEpisodeUrl = function (showId, episodeString, mode = 'sub', quality = 'best') {
        return withFallback('getEpisodeUrl', async () => {
            const title = titleOf.get(String(showId));
            if (!title) throw new Error('no title known for ' + showId);
            const d = await edge('/api/play', {
                title,
                episode: episodeString,
                mode,
                nsfw: window.state && window.state.nsfw ? 'true' : '',
            });
            if (!d || !d.url) throw new Error('edge returned no url');
            return {
                url: d.url,
                referer: d.referer || null,
                subtitles: d.subtitles || [],
                malId: d.mal_id || null,
                resolution: d.quality || quality,
                provider: d.source || 'edge',
                all_links: [],            // the edge hands back one resolved stream
                subs_quality: d.subs_quality || null,
                subs_cues: d.subs_cues || null,
            };
        }, [showId, episodeString, mode, quality]);
    };

    console.log('[edge] ANI-MATE pointed at ' + EDGE + ' (search, episodes, play). ' +
                'AniList and media bytes stay on the device.');
})();
