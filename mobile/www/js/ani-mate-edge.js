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
//
// ⚠ THE CALLER SAYS WHAT THE SHOW IS CALLED (2026-11-12).
//   The edge finds a show by TITLE. This file used to work the title out for itself, from
//   a map of "ids seen in a search". A show that came from favorites, history, a sync
//   from the desktop, or a previous session was never in that map: the episode list came
//   back empty and play refused with "no title known". The 18+ switch was read from
//   window.state, which does not exist (the UI's state is private to its own file), so it
//   was never sent. getEpisodeList and getEpisodeUrl now take the titles and the switch
//   from the caller, as their last argument:
//       { title, alt, nsfw }

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

    /* A second source for the title, for a caller that did not pass one: what each id was
     * called when a search returned it. The caller's own title always wins. */
    const titleOf = new Map();
    function remember(items) {
        for (const r of (items || [])) {
            if (r && r.id && r.name) titleOf.set(String(r.id), r.name);
        }
    }
    window.__edgeRemember = remember;        // so the AniList half can contribute too

    /* ── WHEN THE EDGE CANNOT BE REACHED, STOP ASKING IT FOR A WHILE ───────────────
     * Every call used to wait out the whole 20 seconds before the local path got its
     * turn: search, then the episode list, then play. On a phone with no route to the
     * Worker that is a minute of spinner in front of an app that works. One failure to
     * CONNECT (a timeout or a network error; an HTTP answer does not count) rests the
     * edge for five minutes, and the local path is used at once in the meantime. A 429
     * rests it for one minute, because the edge has asked for exactly that. */
    let restUntil = 0;
    const REST_UNREACHABLE = 5 * 60 * 1000;
    const REST_BUSY = 60 * 1000;

    async function edge(path, params) {
        if (Date.now() < restUntil) throw new Error('edge resting');
        const u = new URL(EDGE + path);
        for (const [k, v] of Object.entries(params || {})) {
            if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
        }
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), TIMEOUT);
        let r;
        try {
            r = await fetch(u.toString(), { signal: ctl.signal, headers: { Accept: 'application/json' } });
        } catch (e) {
            restUntil = Date.now() + REST_UNREACHABLE;
            throw new Error('edge unreachable (' + (e && e.name === 'AbortError' ? 'timeout' : (e && e.message)) + ')');
        } finally { clearTimeout(t); }
        if (r.status === 429) restUntil = Date.now() + REST_BUSY;
        if (!r.ok) throw new Error('edge ' + r.status);
        return await r.json();
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

    /* The edge asks AllAnime by id and everything else by title. Only an id AllAnime
     * could have issued is worth sending: a "search:Title" id, a source-tagged id or a
     * sync identity ("al:123") would cost the edge an upstream request for nothing. */
    const allanimeId = (id) => (/^[A-Za-z0-9]{8,32}$/.test(String(id || '')) ? String(id) : '');

    function names(showId, opts) {
        const o = opts || {};
        const id = String(showId || '');
        const title = String(o.title || titleOf.get(id) || (id.startsWith('search:') ? id.slice(7) : '') || '').trim();
        const alt = String(o.alt || '').trim();
        return { title, alt: alt && alt.toLowerCase() !== title.toLowerCase() ? alt : '', nsfw: !!o.nsfw };
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
                return hits.filter((h) => !/\b(hentai|uncensored)\b/i.test(h.name));
            }
            return hits;
        }, [query, mode, allowAdult]);
    };

    // ── EPISODE LIST ──────────────────────────────────────────────────────────────
    // AllAnime first on the edge, then hianime by title. That second step is the one that
    // makes adult titles playable: they are in AniList and hianime but almost never in
    // AllAnime, so the list came back empty and there was nothing on screen to tap.
    //
    // Returns { episodes, arcs }, the same shape as the local path. It used to return a
    // bare list, so a show opened through the edge never had its story arcs.
    window.API.getEpisodeList = function (showId, mode = 'sub', anilistId = null, opts) {
        return withFallback('getEpisodeList', async () => {
            const n = names(showId, opts);
            const id = allanimeId(showId);
            if (!id && !n.title) throw new Error('nothing to ask the edge with');
            const d = await edge('/api/episodes', {
                id, title: n.title, alt: n.alt, mode, nsfw: n.nsfw ? 'true' : '',
            });
            const episodes = (d.episodes || []).map(String);
            /* An empty answer is "the edge did not find it", not "it has no episodes".
             * The local path gets its turn. */
            if (!episodes.length) throw new Error('edge found no episodes');
            const arcs = window.API.arcsFor ? window.API.arcsFor(anilistId, episodes.length) : null;
            return { episodes, arcs };
        }, [showId, mode, anilistId, opts]);
    };

    // ── PLAY ──────────────────────────────────────────────────────────────────────
    // Shape matches what the mobile player already consumes: url, referer, subtitles,
    // resolution, all_links.
    window.API.getEpisodeUrl = function (showId, episodeString, mode = 'sub', quality = 'best', opts) {
        return withFallback('getEpisodeUrl', async () => {
            const n = names(showId, opts);
            if (!n.title) throw new Error('no title known for ' + showId);
            const d = await edge('/api/play', {
                title: n.title,
                alt: n.alt,
                episode: episodeString,
                mode,
                nsfw: n.nsfw ? 'true' : '',
            });
            if (!d || !d.url) throw new Error('edge returned no url');
            return {
                url: d.url,
                referer: d.referer || null,
                subtitles: d.subtitles || [],
                malId: d.mal_id || null,
                resolution: d.quality || '',
                provider: d.source || 'edge',
                all_links: [],            // the edge hands back one resolved stream
                subs_quality: d.subs_quality || null,
                subs_cues: d.subs_cues || null,
            };
        }, [showId, episodeString, mode, quality, opts]);
    };

    console.log('[edge] ANI-MATE pointed at ' + EDGE + ' (search, episodes, play). ' +
                'AniList and media bytes stay on the device.');
})();
