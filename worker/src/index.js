/**
 * ANI-MATE edge API — the half of the server that a datacenter IP is allowed to run.
 *
 * WHY THIS EXISTS (2026-11-07)
 *   Desktop and mobile were two implementations of one app. Mobile carried a 4,800 line
 *   port of the provider logic and talked to AllAnime directly, so every fix had to be
 *   written twice or the two apps disagreed -- which they did, for months.
 *
 *   The fix is one backend both clients call. It cannot be a machine of YASA's: ANI-MATE is
 *   public software with real installs, and pointing other people's phones at his hardware
 *   is not an option.
 *
 * ⛔ WHAT RUNS HERE AND WHAT CANNOT, AND IT WAS ALL MEASURED ON CLOUDFLARE'S EDGE
 *   BEFORE A LINE OF THIS WAS WRITTEN, not reasoned about:
 *
 *     hianime.at ................. 200   249 KB, film-name markup intact
 *     gogoanime.by ............... 200
 *     api.allanime.day ........... 200   availableEpisodesDetail present
 *     rest.opensubtitles.org ..... 200   search works
 *     graphql.anilist.co ......... 403   "You have been manually blocked.
 *                                         Please come to the principal's office."
 *     dl.opensubtitles.org ....... 401   "Making sure you're not a bot!"
 *
 *   The last two bot-wall datacenter IPs. Six header variants on AniList, all 403 -- it is
 *   an IP block, not a header problem. BOTH of them answer a real client perfectly: AniList
 *   returns 200 with CORS to a browser page, and the OpenSubtitles download returns 10,729
 *   bytes to the same page. So they belong on the client, and that is not a workaround: a
 *   public read API with CORS is meant to be called from clients.
 *
 * THEREFORE:
 *   here .... stream resolution, episode lists, subtitle SEARCH, accounts
 *   client .. AniList metadata, the OpenSubtitles DOWNLOAD, and every byte of video
 *
 * ⚠ NO VIDEO EVER PASSES THROUGH THIS WORKER. Clients fetch the CDN directly. Proxying
 *   streams here would bill every byte to Cloudflare and would break the referer gating
 *   anyway. /play hands back a URL and the headers to send with it; it does not fetch it.
 *
 * The providers are imported from ../../server/ UNCHANGED. They load as-is under
 * nodejs_compat, verified on the edge -- the dub-server subtitle fix ran there and returned
 * 336 cues for the Beastars episode that started all of this. One copy, two runtimes.
 */

import { makeProvider as makeHiAnime } from '../../server/hianime-at.js';
import { makeProvider as makeGogo } from '../../server/gogoanime-by.js';
import * as opensubs from '../../server/subs-opensubtitles.js';
import * as episodeMap from '../../server/episode-map.js';

const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_REFR = 'https://allmanga.to';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* The providers take an `afetch` so they can travel Electron's bridge on the desktop.
 * Here it is a plain fetch, which is all the edge has and all these hosts need. */
async function afetch(url, opt = {}) {
    const r = await fetch(url, { headers: opt.headers || {}, redirect: 'follow' });
    return { status: r.status, text: () => r.text() };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: {
        ...(status === 429 ? { 'retry-after': '60' } : {}),
        'content-type': 'application/json; charset=utf-8',
        /* Open on purpose. Every caller is someone's own ANI-MATE install on their own
         * device; there is no cookie, no session and nothing user-specific on these
         * routes. The account routes below are the ones that carry identity. */
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'cache-control': 'no-store',
    },
});

/* ── RATE LIMITING ────────────────────────────────────────────────────────────────
 * ⚠ THIS SHIPPED WITHOUT IT ONCE. v0.7.0 went public with no limiter and the gap was
 * written down as a caveat instead of being closed, which is worth naming: a risk you
 * have NAMED is not a risk you have HANDLED.
 *
 * Keyed on the caller's IP, which for this app is one person's device. The buckets are
 * sized off measured cost (see wrangler.toml), and the point is less about abuse than
 * about not getting the whole Cloudflare range banned by an upstream -- AniList has
 * already done exactly that to Workers, and hianime could.
 *
 * Fails OPEN. If the binding is missing or throws, requests are served rather than
 * refused: a limiter that breaks must not take the app down with it.
 */
async function limited(env, req, p) {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const bucket = p === '/api/play' ? env.RL_PLAY : env.RL_READ;
    if (!bucket || typeof bucket.limit !== 'function') return null;
    try {
        const { success } = await bucket.limit({ key: ip });
        if (success) return null;
        return json({
            error: 'rate limited',
            detail: p === '/api/play'
                ? 'Too many playback requests. This endpoint makes up to nine upstream ' +
                  'requests each, so it is capped at 20 a minute per device.'
                : 'Too many requests. Capped at 120 a minute per device.',
            retry_after: 60,
        }, 429);
    } catch { return null; }      // fail open, never fail closed
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const q = url.searchParams;
        if (req.method === 'OPTIONS') return json({});

        /* /health stays free so a client can always ask whether the backend is alive,
         * including while it is being rate limited on everything else. */
        if (p !== '/' && p !== '/health') {
            const blocked = await limited(env, req, p);
            if (blocked) return blocked;
        }

        try {
            if (p === '/' || p === '/health') {
                return json({
                    service: 'ani-mate edge api',
                    ok: true,
                    /* Named so a client can refuse to talk to a backend older than it is,
                     * rather than failing in some confusing way three calls later. */
                    api: 1,
                    runs_here: ['hianime.at', 'gogoanime.by', 'api.allanime.day',
                                'rest.opensubtitles.org'],
                    runs_on_client: ['graphql.anilist.co (403 here)',
                                     'dl.opensubtitles.org (401 here)',
                                     'video + subtitle bytes'],
                });
            }

            /* Title -> listings. The client shows these; AniList art and genres are
             * attached client-side afterwards. */
            if (p === '/api/search') {
                const term = q.get('q') || '';
                if (!term) return json({ error: 'missing q' }, 400);
                const hits = await makeHiAnime(afetch).search(term);
                return json({ query: term, results: hits });
            }

            /* Episode numbers. AllAnime first because it is instant when it has the row,
             * then hianime by title -- which is what makes adult titles playable, since
             * almost none of them are in AllAnime's catalog. */
            if (p === '/api/episodes') {
                const title = q.get('title') || '';
                const id = q.get('id') || '';
                const mode = q.get('mode') || 'sub';
                const nsfw = q.get('nsfw') === 'true';
                let episodes = [];
                if (id) episodes = await allanimeEpisodes(id, mode);
                if (!episodes.length && title) {
                    episodes = await hianimeEpisodes(title, mode, { allowUncensored: nsfw });
                }
                return json({ id, title, mode, episodes, source: episodes.length ? 'ok' : 'none' });
            }

            /* The one that matters: a playable URL, the headers it needs, and every
             * subtitle track worth offering. */
            if (p === '/api/play') {
                const title = q.get('title') || '';
                const ep = q.get('episode') || '';
                const mode = q.get('mode') || 'sub';
                const nsfw = q.get('nsfw') === 'true';
                if (!title || !ep) return json({ error: 'missing title or episode' }, 400);
                const opts = { allowUncensored: nsfw };

                let st = null;
                try { st = await makeHiAnime(afetch).streamByTitle(title, ep, mode, opts); }
                catch (e) { /* fall through to the backup source */ }

                let source = 'hianime.at';
                if (!st || !st.url) {
                    try {
                        st = await makeGogo(afetch).streamByTitle(title, ep, opts);
                        source = 'gogoanime.by';
                    } catch { st = null; }
                }
                if (!st || !st.url) {
                    return json({ error: 'no stream', title, episode: ep,
                                  sources_tried: ['hianime.at', 'gogoanime.by'] }, 404);
                }
                return json({
                    source,
                    url: st.url,
                    /* The CDN 403s without this. The CLIENT sends it -- a browser cannot
                     * set Referer cross-origin, which is why the desktop proxies locally
                     * and mobile uses its native HTTP. */
                    referer: st.referer || null,
                    subtitles: st.subtitles || [],
                    subs_quality: st.subsQuality || null,
                    subs_cues: st.subsCues || null,
                    listing: st.listing || null,
                    mal_id: st.malId || null,
                    hardsub: !!st.hardsub,
                    quality: st.quality || 'auto',
                });
            }

            /* Subtitle SEARCH only. The download is 401 from here, so the client fetches
             * the file itself and converts it -- see shared/opensubs-client.js. */
            if (p === '/api/subs') {
                const query = q.get('query') || '';
                const season = Number(q.get('season') || 0);
                const episode = Number(q.get('episode') || 0);
                if (!query || !season || !episode) {
                    return json({ error: 'missing query, season or episode' }, 400);
                }
                const hits = await opensubs.search(afetch, { query, season, episode });
                return json({ query, season, episode, results: hits.slice(0, 6) });
            }

            /* Absolute episode number for a subtitle database, derived from the host's own
             * episode counts. Returns null rather than guessing -- see episode-map.js. */
            if (p === '/api/episode-map') {
                const title = q.get('title') || '';
                const ep = Number(q.get('episode') || 0);
                if (!title || !ep) return json({ error: 'missing title or episode' }, 400);
                const ha = makeHiAnime(afetch);
                /* THE LADDER, not a bare search. Asking hianime for the exact title
                 * "Beastars Final Season Part 2" returns that ONE listing, so the prior
                 * parts are absent, the offset is unknowable and the map refuses -- which
                 * is correct behavior for the wrong reason. streamByTitle widens the
                 * query for exactly this; so must this. */
                const { queryLadder } = await import('../../server/title-match.js');
                const seen = new Set();
                let hits = [];
                for (const term of queryLadder(title)) {
                    let got = [];
                    try { got = await ha.search(term); } catch { continue; }
                    for (const h of got) if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); }
                }
                const counts = await ha.listingCounts(hits.slice(0, 8));
                const map = episodeMap.resolve({ listings: counts, chosen: title, episode: ep });
                return json({ title, episode: ep, map, listings: counts });
            }

            return json({ error: 'not found', path: p }, 404);
        } catch (e) {
            return json({ error: String(e && e.message || e).slice(0, 200) }, 500);
        }
    },
};

/** AllAnime's episode list. Its STREAM endpoint is dead; this read still answers. */
async function allanimeEpisodes(showId, mode) {
    try {
        const r = await fetch(ALLANIME_API, {
            method: 'POST',
            headers: { 'User-Agent': AGENT, Referer: ALLANIME_REFR, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                variables: { showId },
                query: 'query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail } }',
            }),
        });
        const d = await r.json();
        const detail = d?.data?.show?.availableEpisodesDetail;
        if (detail && detail[mode]) return detail[mode].sort((a, b) => parseFloat(a) - parseFloat(b));
    } catch { /* fall through to hianime */ }
    return [];
}

/** Episode numbers from the host that is going to serve the video. */
async function hianimeEpisodes(title, mode, opts) {
    try {
        const ha = makeHiAnime(afetch);
        const hits = await ha.search(title);
        if (!hits.length) return [];
        const { acceptableTier } = await import('../../server/title-match.js');
        const tier = acceptableTier(hits, title, opts);
        const pick = (tier.length ? tier : hits)[0];
        const eps = await ha.episodes(pick.id);
        return eps.map((e) => String(e.number));
    } catch { return []; }
}
