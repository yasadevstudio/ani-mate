// YASA PRESENTS
// ani-mate-server.js - ANI-MATE Backend Server
// Anime streaming interface - REST API

const http = require('http');
const SearchIndex = require('./search-index');
const { spawn } = require('child_process');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Fallback streaming providers (AnimePahe, HiAnime via consumet)
let consumetAnimePahe = null;
let consumetHiAnime = null;

// ⛔ CONSUMET SHIPS DEAD DOMAINS AND CANNOT BE UPGRADED OUT OF IT.
// Measured 2026-10-05: consumet pins AnimePahe at `animepahe.si`, which is NXDOMAIN —
// `getaddrinfo ENOTFOUND animepahe.si` on every call. 1.8.8 IS the latest published
// release (checked against the npm registry the same day), so there is no version to
// upgrade to. The domain moved to animepahe.su; animepahe.ru 301s there.
//
// These hosts rotate on somebody else's schedule, so they are DATA, not code. Override
// them here and the next rotation is a one-line edit instead of a dead fallback that
// reports itself as "loaded".
const SOURCE_HOSTS = {
    // ⚠ CHECKED EVERY CANDIDATE 2026-10-05 BEFORE PICKING, because the obvious answer was
    // wrong twice:
    //   animepahe.si  NXDOMAIN, and this is what consumet 1.8.8 still pins
    //   animepahe.ru  301s to animepahe.su, which is a PARKED "This domain is for sale" page
    //   animepahe.ch  200 but a WordPress squatter page (gmpg.org/xfn/11 profile)
    //   animepahe.ng  same squatter
    //   animepahe.com 403 "Just a moment" <- THE REAL SITE, behind Cloudflare
    // A 200 is not a signal here. Four of five hosts answer 200 and none of those is
    // AnimePahe. The real one is the one that challenges you.
    animepahe: process.env.ANI_MATE_ANIMEPAHE || 'https://animepahe.com',
    hianime: process.env.ANI_MATE_HIANIME || null,   // null = leave consumet's default
};

// ⛔ AND CONSUMET BRINGS ITS OWN HTTP CLIENT, WHICH ROUTES AROUND THE BRIDGE.
// This is the same architectural fault electron-net-bridge.js was written for, one layer
// further down. consumet builds its own axios instance, so its requests leave as bare Node
// HTTP with no Chromium fingerprint and no shared cookie jar — and AnimePahe answers them
// with a DDoS-Guard interstitial. Measured 2026-10-05: after the domain fix the error moved
// from `ENOTFOUND animepahe.si` to `Cannot read properties of undefined (reading 'map')`,
// which is consumet trying to parse that HTML page as JSON.
//
// axios takes a custom adapter, so hand it one that forwards to afetch. Every consumet
// provider then inherits Chromium's stack and its challenge-solving for free.
function bridgeAdapter(config) {
    const url = config.url.startsWith('http')
        ? config.url
        : (config.baseURL || '') + config.url;
    // config.headers is an AxiosHeaders INSTANCE, not a plain object. Electron's net.request
    // gets it over IPC and rejects it, which comes back as status 0 in about 3ms — fast
    // enough to look like a config error rather than a network one. Flatten it first.
    //
    // AND CHROMIUM REFUSES MOST OF WHAT CONSUMET SENDS. Measured 2026-10-05: forwarding
    // consumet's header set produced `net::ERR_INVALID_ARGUMENT` from Electron's net stack.
    // consumet emits HTTP/2 pseudo-headers (`authority`) and other names Chromium owns and
    // will not accept from a caller. So this is an ALLOWLIST, not a filter: anything not
    // known-safe is dropped rather than guessed at, because one bad name kills the whole
    // request rather than being ignored.
    const SAFE = new Set(['user-agent', 'referer', 'accept', 'accept-language',
                          'content-type', 'cookie', 'x-requested-with', 'origin-x']);
    const headers = {};
    try {
        const h = config.headers;
        const src = (h && typeof h.toJSON === 'function') ? h.toJSON() : (h || {});
        for (const k of Object.keys(src)) {
            const v = src[k];
            if (v === undefined || v === null) continue;
            if (!SAFE.has(String(k).toLowerCase())) continue;
            headers[k] = String(v);
        }
    } catch { /* send none rather than send something unserializable */ }

    return afetch(url, {
        method: (config.method || 'get').toUpperCase(),
        headers,
        body: config.data || null,
    }).then((r) => {
        // afetch returns a real Response when headless, {status, body} over the bridge.
        const read = typeof r.text === 'function' ? r.text() : Promise.resolve(r.body || '');
        return read.then((body) => {
            let data = body;
            if (config.responseType !== 'text') {
                try { data = JSON.parse(body); } catch { /* leave as text, like axios does */ }
            }
            const status = r.status || 0;
            const res = { data, status, statusText: String(status), headers: {}, config };
            // axios treats a non-2xx as a rejection, and consumet relies on that.
            if (status < 200 || status >= 300) {
                // Carry the bridge's own reason. Without it a Chromium-level failure is
                // indistinguishable from an HTTP 0 and there is nothing to act on.
                // afetch returns `sourceError`, NOT `error`. Reading the wrong field meant
                // every bridge-level failure arrived as a bare "status code 0" with no
                // reason attached, which is why this took three rounds to diagnose.
                const why = (r.sourceError || r.error) ? ` (${r.sourceError || r.error})` : '';
                const err = new Error(`Request failed with status code ${status}${why}`);
                err.response = res; err.config = config; err.isAxiosError = true;
                throw err;
            }
            return res;
        });
    });
}

try {
    const { ANIME } = require('@consumet/extensions');
    // adapter is the SECOND constructor argument (proxyConfig, adapter) — see
    // @consumet/extensions/dist/models/proxy.js
    consumetAnimePahe = new ANIME.AnimePahe(undefined, bridgeAdapter);
    consumetHiAnime = new ANIME.Hianime(undefined, bridgeAdapter);
    if (SOURCE_HOSTS.animepahe) consumetAnimePahe.baseUrl = SOURCE_HOSTS.animepahe;
    if (SOURCE_HOSTS.hianime) consumetHiAnime.baseUrl = SOURCE_HOSTS.hianime;
} catch { /* consumet not available — AllAnime only */ }

// HiAnime.at (2026-10-05) — THE ONLY SOURCE THAT ACTUALLY PRODUCES A STREAM TODAY.
// Implemented from ani-cli 5.1.5's own script (base_api="https://hianime.at"), verified end
// to end the same day: search -> episodes -> servers -> embed -> m3u8 -> HTTP 206 video/mp2t.
// It also returns a WebVTT subtitle track and the MAL id, neither of which this app had.
// See server/hianime-at.js for the full chain and why its obfuscation is not real crypto.
let hianimeAt = null;

// AniDB provider (2026-08-22). Every previously-known source is dead: AllAnime 403s behind
// Cloudflare, animepahe.si has no DNS, HiAnime 522s, and consumet 1.8.8 is the latest
// release yet unpublished since 2026-01-20 with stale scrapers. Upstream ani-cli migrated
// to anidb.app; verified working here (search -> episodes -> HLS playlist, HTTP 200).
// Requests must travel the Electron bridge, so it is constructed with `afetch`.
let anidbProvider = null;


const PKG_VERSION = (() => { try { return require('../package.json').version; } catch { return '0.4.0'; } })();
const PORT = parseInt(process.env.ANI_MATE_PORT) || 7890;
// How many AniList-only titles get a secondary AllAnime lookup so they become
// playable. Was hardcoded to 3.
const SECONDARY_LOOKUP_CAP = 8;
// Below this many title matches, fall back to content retrieval over the
// local index. A title search that found plenty does not need help.
const CONTENT_FALLBACK_BELOW = 5;
// Best title-match score below which a query is treated as describing a show
// rather than naming one.
const CONTENT_FALLBACK_KW = 45;
const HIST_DIR = process.env.ANI_MATE_DATA_DIR
    || process.env.ANI_CLI_HIST_DIR
    || `${process.env.XDG_STATE_HOME || `${process.env.HOME || process.env.USERPROFILE}/.local/state`}/ani-cli`;
const HIST_FILE = path.join(HIST_DIR, 'ani-hsts');

// Ensure data directory exists on startup
try { fs.mkdirSync(HIST_DIR, { recursive: true }); } catch {}
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0';
const ALLANIME_REFR = 'https://allmanga.to';
const ALLANIME_API = 'https://api.allanime.day/api';
// Cowboy Bebop. A finished 26-episode series from 1998: it will never be unpublished, so a
// failure here is always the SOURCE and never a missing episode.
const HEALTH_PROBE_SHOW = 'PGcK4wGnqDoeihT6n';

// ---------------------------------------------------------------------------
// afetch — fetch-shaped, but the request travels Chromium's network stack.
//
// This server runs as a fork() child of the Electron main process. A bare Node request
// from here carries no cookie jar and no browser fingerprint, so the source's browser
// check returns 403 to every call. When an IPC parent is present we hand the request to
// main, which issues it via Electron `net` on the shared session (see
// ../electron-net-bridge.js). Standalone (no parent) we fall back to plain fetch so the
// server still runs headless for development.
//
// Returns a minimal Response-like object so existing call sites are unchanged.
let _netSeq = 0;
const _netPending = new Map();
if (process.send) {
    process.on('message', (m) => {
        if (m && m.type === 'net-response' && _netPending.has(m.id)) {
            const done = _netPending.get(m.id);
            _netPending.delete(m.id);
            done(m);
        }
    });
}
// Built here because it must be handed `afetch` (the bridge), not global fetch.
function getAniDB() {
    if (!anidbProvider) {
        try {
            const { createAniDB } = require('./providers/anidb.js');
            anidbProvider = createAniDB(afetch);
        } catch (e) {
            console.error('[anidb] provider unavailable:', e.message);
            anidbProvider = null;
        }
    }
    return anidbProvider;
}

async function afetch(url, opts = {}) {
    if (!process.send) return fetch(url, opts);          // dev / headless fallback
    const id = ++_netSeq;
    const reply = new Promise((res) => _netPending.set(id, res));
    const timeout = new Promise((res) => setTimeout(() => {
        _netPending.delete(id);
        res({ status: 0, body: '', error: 'bridge timeout' });
    }, 30000));
    try {
        process.send({
            type: 'net-request', id, url,
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body || null,
            // THE ORIGIN TO SOLVE IS THE ONE BEING CALLED, NOT ALLANIME'S.
            // This was pinned to ALLANIME_REFR, so a Cloudflare challenge from any OTHER
            // host sent Chromium to solve allmanga.to instead — the clearance cookie landed
            // on the wrong domain and the retry failed identically. Every non-AllAnime
            // source was therefore unprotected by the very bridge written to protect it.
            challengeOrigin: (() => { try { return new URL(url).origin; } catch { return ALLANIME_REFR; } })()
        });
    } catch (e) {
        _netPending.delete(id);
        return { ok: false, status: 0, sourceError: String(e),
                 text: async () => '', json: async () => ({}) };
    }
    const r = await Promise.race([reply, timeout]);
    return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        sourceError: r.error || null,
        text: async () => r.body || '',
        json: async () => JSON.parse(r.body || '{}')
    };
}

// Internal history for the UI (richer than ani-cli's)
const FORGE_HIST_FILE = path.join(HIST_DIR, 'ani-mate-history.json');
const FAVORITES_FILE = path.join(HIST_DIR, 'ani-mate-favorites.json');

function loadForgeHistory() {
    try {
        if (fs.existsSync(FORGE_HIST_FILE)) {
            return JSON.parse(fs.readFileSync(FORGE_HIST_FILE, 'utf8'));
        }
    } catch { /* ignore */ }
    return [];
}

function saveForgeHistory(history) {
    fs.mkdirSync(path.dirname(FORGE_HIST_FILE), { recursive: true });
    const tmp = FORGE_HIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, FORGE_HIST_FILE);
}

function addToForgeHistory(entry) {
    const history = loadForgeHistory();
    const existing = history.findIndex(h => h.anime_id === entry.anime_id);
    const ep = String(entry.episode);

    if (existing >= 0) {
        // Update existing record
        const rec = history[existing];
        rec.episode = ep;
        rec.quality = entry.quality || rec.quality || 'best';
        rec.mode = entry.mode || rec.mode || 'sub';
        rec.timestamp = new Date().toISOString();
        rec.title = entry.title || rec.title;
        if (entry.title_english) rec.title_english = entry.title_english;
        // Track all watched episodes (unless skip_watched — client handles marking)
        if (!Array.isArray(rec.episodes_watched)) rec.episodes_watched = [];
        if (!entry.skip_watched && !rec.episodes_watched.includes(ep)) rec.episodes_watched.push(ep);
        // Update total episodes if provided
        if (entry.total_episodes) rec.total_episodes = entry.total_episodes;
        // Track playback position for resume
        if (entry.playback_time !== undefined) {
            rec.playback_time = entry.playback_time;
            rec.playback_episode = ep;
        }
        // Move to top
        history.splice(existing, 1);
        history.unshift(rec);
    } else {
        const newRec = {
            anime_id: entry.anime_id,
            title: entry.title,
            episode: ep,
            quality: entry.quality || 'best',
            mode: entry.mode || 'sub',
            timestamp: new Date().toISOString(),
            episodes_watched: entry.skip_watched ? [] : [ep],
            total_episodes: entry.total_episodes || null,
            playback_time: entry.playback_time || 0,
            playback_episode: ep
        };
        if (entry.title_english) newRec.title_english = entry.title_english;
        history.unshift(newRec);
    }
    // Keep last 100
    if (history.length > 100) history.length = 100;
    saveForgeHistory(history);
    return history[0];
}

// Download tracking
const downloadQueue = new Map();
const DL_MAX_AGE = 30 * 60 * 1000; // 30 minutes
const DL_MAX_SIZE = 50;

function cleanDownloadQueue() {
    const now = Date.now();
    for (const [id, dl] of downloadQueue) {
        if ((dl.status === 'complete' || dl.status === 'error') && (now - dl.startedAt) > DL_MAX_AGE) {
            downloadQueue.delete(id);
        }
    }
    // Hard cap: remove oldest entries if over limit
    if (downloadQueue.size > DL_MAX_SIZE) {
        const sorted = [...downloadQueue.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
        while (sorted.length > DL_MAX_SIZE) {
            const [id] = sorted.shift();
            downloadQueue.delete(id);
        }
    }
}

const DOWNLOAD_DIR = process.env.ANI_MATE_DOWNLOAD_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', 'Videos', 'ANI-MATE');

// Favorites
function loadFavorites() {
    try {
        if (fs.existsSync(FAVORITES_FILE)) {
            return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
        }
    } catch { /* ignore */ }
    return [];
}

function saveFavorites(favs) {
    try {
        if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
        const tmp = FAVORITES_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(favs, null, 2));
        fs.renameSync(tmp, FAVORITES_FILE);
    } catch { /* ignore */ }
}

// Daily popular/trending — hybrid AniList trending + AllAnime popular
const dailyCache = {};
const DAILY_CACHE_TTL = 30 * 60 * 1000; // 30 min cache

async function getDailyPopular(mode = 'sub') {
    if (dailyCache[mode] && (Date.now() - dailyCache[mode].at) < DAILY_CACHE_TTL) {
        return dailyCache[mode].data;
    }

    // Fetch AniList trending (rotates daily) + AllAnime popular in parallel
    const [aniTrending, allAnimePopular] = await Promise.all([
        getAniListTrending().catch(() => []),
        getAllAnimePopular(mode).catch(() => [])
    ]);

    // Merge: AniList trending first, fill with AllAnime popular (dedupe by name)
    const seen = new Set();
    const results = [];
    for (const r of [...aniTrending, ...allAnimePopular]) {
        const key = r.name.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            results.push(r);
        }
    }
    const trimmed = results.slice(0, 30);
    // Only cache non-empty results to avoid locking out for 30min on transient failures
    if (trimmed.length > 0) {
        dailyCache[mode] = { data: trimmed, at: Date.now() };
    }
    return trimmed;
}

async function getAniListTrending() {
    const gql = `query { Page(page: 1, perPage: 20) { media(type: ANIME, sort: [TRENDING_DESC]) { id title { romaji english } coverImage { medium } format episodes } } }`;
    const resp = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: gql }),
        signal: AbortSignal.timeout(5000)
    });
    const json = await resp.json();
    return (json?.data?.Page?.media || []).map(m => {
        const name = m.title?.romaji || m.title?.english || 'Unknown';
        const eps = m.episodes || 0;
        const type = eps === 1 ? 'movie' : eps <= 12 ? 'short' : 'series';
        return fixDisplayName({ id: null, name, title_english: m.title?.english || null, cover: m.coverImage?.medium || null, episodes: eps, type, anilist_id: m.id });
    });
}

async function getAllAnimePopular(mode = 'sub') {
    const gql = `query($type: VaildPopularTypeEnumType!, $size: Int!, $dateRange: Int, $page: Int) { queryPopular(type: $type, size: $size, dateRange: $dateRange, page: $page) { recommendations { anyCard { _id name availableEpisodes __typename } } } }`;
    const variables = { type: 'anime', size: 25, dateRange: 1, page: 1 };
    const response = await afetch(ALLANIME_API, {
        method: 'POST',
        headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables, query: gql }),
        signal: AbortSignal.timeout(8000)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    const results = [];
    const recs = data?.data?.queryPopular?.recommendations || [];
    for (const rec of recs) {
        const show = rec.anyCard;
        if (!show) continue;
        const epCount = show.availableEpisodes?.[mode] || 0;
        if (epCount > 0) {
            const type = epCount === 1 ? 'movie' : epCount <= 12 ? 'short' : 'series';
            results.push(fixDisplayName({ id: show._id, name: show.name, episodes: epCount, type }));
        }
    }
    return results;
}

// AniList airing schedule - real episode air times
const airingCache = {};
const AIRING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAiringSchedule(dateStr, tzOffsetMin = 0) {
    const now = new Date();
    // Build day boundaries in the client's local timezone
    // tzOffsetMin is JS getTimezoneOffset() (minutes, positive = behind UTC)
    let target;
    if (dateStr) {
        // Parse as UTC midnight, then shift by client timezone offset
        target = new Date(dateStr + 'T00:00:00Z');
        target = new Date(target.getTime() + tzOffsetMin * 60 * 1000);
    } else {
        target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const cacheKey = dateStr + '_tz' + tzOffsetMin;

    if (airingCache[cacheKey] && (Date.now() - airingCache[cacheKey].at) < AIRING_CACHE_TTL) {
        return airingCache[cacheKey].data;
    }

    const dayStart = Math.floor(target.getTime() / 1000);
    const dayEnd = dayStart + 86400;
    const allSchedules = [];
    let page = 1;
    let hasNext = true;

    const gql = `query ($page: Int, $gt: Int, $lt: Int) {
        Page(page: $page, perPage: 50) {
            pageInfo { hasNextPage }
            airingSchedules(airingAt_greater: $gt, airingAt_lesser: $lt, sort: [TIME]) {
                episode airingAt media {
                    id title { romaji english } coverImage { medium } format episodes status
                }
            }
        }
    }`;

    while (hasNext && page <= 10) {
        const resp = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: gql, variables: { page, gt: dayStart, lt: dayEnd } })
        });
        const json = await resp.json();
        const pg = json?.data?.Page;
        if (pg?.airingSchedules) allSchedules.push(...pg.airingSchedules);
        hasNext = pg?.pageInfo?.hasNextPage || false;
        page++;
    }

    const results = allSchedules.map(s => ({
        anilist_id: s.media?.id,
        title: s.media?.title?.english || s.media?.title?.romaji || 'Unknown',
        title_romaji: s.media?.title?.romaji,
        episode: s.episode,
        airingAt: s.airingAt,
        cover: s.media?.coverImage?.medium,
        format: s.media?.format,
        totalEpisodes: s.media?.episodes
    }));

    airingCache[cacheKey] = { data: results, at: Date.now() };
    return results;
}

// AniList cover image lookup with cache
const coverCache = {};
const COVER_CACHE_TTL = 60 * 60 * 1000; // 1 hour for successful lookups
const COVER_CACHE_FAIL_TTL = 5 * 60 * 1000; // 5 minutes for failed lookups

async function getAniListCovers(titles) {
    // Filter to titles not already cached (use shorter TTL for failed lookups)
    const needed = titles.filter(t => {
        if (!coverCache[t]) return true;
        const ttl = coverCache[t].url ? COVER_CACHE_TTL : COVER_CACHE_FAIL_TTL;
        return (Date.now() - coverCache[t].at) > ttl;
    });
    if (needed.length === 0) {
        return titles.reduce((acc, t) => { acc[t] = { cover: coverCache[t]?.url || null, description: coverCache[t]?.description || null, title_english: coverCache[t]?.title_english || null }; return acc; }, {});
    }

    // Batch query AniList (5 at a time to avoid rate limits, parameterized variables)
    for (let i = 0; i < needed.length; i += 5) {
        const batch = needed.slice(i, i + 5);
        try {
            const varDefs = batch.map((_, idx) => `$s${idx}: String`).join(', ');
            const fragments = batch.map((_, idx) => {
                return `q${idx}: Page(perPage: 1) { media(search: $s${idx}, type: ANIME) { title { english romaji } coverImage { medium } description(asHtml: false) } }`;
            }).join('\n');
            const variables = {};
            batch.forEach((title, idx) => { variables[`s${idx}`] = title; });

            const gql = `query (${varDefs}) { ${fragments} }`;
            const resp = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query: gql, variables }),
                signal: AbortSignal.timeout(5000)
            });
            const json = await resp.json();

            batch.forEach((title, idx) => {
                const media = json?.data?.[`q${idx}`]?.media?.[0];
                const coverUrl = media?.coverImage?.medium || null;
                const desc = media?.description || null;
                const titleEnglish = media?.title?.english || null;
                coverCache[title] = { url: coverUrl, description: desc, title_english: titleEnglish, at: Date.now() };
            });
        } catch {
            // On failure, cache null so we don't retry immediately
            batch.forEach(title => {
                if (!coverCache[title]) coverCache[title] = { url: null, at: Date.now() };
            });
        }
    }

    return titles.reduce((acc, t) => { acc[t] = { cover: coverCache[t]?.url || null, description: coverCache[t]?.description || null, title_english: coverCache[t]?.title_english || null }; return acc; }, {});
}

// Anime info lookup (AniList primary, Jikan/MAL fallback)
const infoCache = {};
const INFO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Title corrections for AllAnime names that don't match AniList/MAL
// Used by both /info endpoint and search enrichment
const TITLE_MAP = {
    // Abbreviations → full romaji (for AllAnime search)
    '1P': 'One Piece',
    'OP': 'One Piece',
    'AOT': 'Attack on Titan',
    'SNK': 'Shingeki no Kyojin',
    'JJK': 'Jujutsu Kaisen',
    'MHA': 'My Hero Academia',
    'KNY': 'Kimetsu no Yaiba',
    'SAO': 'Sword Art Online',
    'HXH': 'Hunter x Hunter',
    'FMA': 'Fullmetal Alchemist',
    'FMAB': 'Fullmetal Alchemist Brotherhood',
    'DS': 'Demon Slayer',
    'CSM': 'Chainsaw Man',
    'MP100': 'Mob Psycho 100',
    'OPM': 'One Punch Man',
    'DBS': 'Dragon Ball Super',
    'DBZ': 'Dragon Ball Z',
    'BC': 'Black Clover',
    'TOG': 'Tower of God',
    'SOL': 'Solo Leveling',
    'SxF': 'Spy x Family',
    // Long romaji → English (for titles AniList fails to match)
    'Tensei shitara Slime Datta Ken': 'That Time I Got Reincarnated as a Slime',
    'Ore dake Level Up na Ken': 'Solo Leveling',
    'Mushoku Tensei': 'Mushoku Tensei: Jobless Reincarnation',
    'Boku no Hero Academia': 'My Hero Academia',
    'Shingeki no Kyojin': 'Attack on Titan',
    'Kimetsu no Yaiba': 'Demon Slayer',
    'Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka': 'Is It Wrong to Try to Pick Up Girls in a Dungeon?',
    'Re:Zero kara Hajimeru Isekai Seikatsu': 'Re:ZERO -Starting Life in Another World-',
    'Kono Subarashii Sekai ni Shukufuku wo!': 'KonoSuba: God\'s Blessing on This Wonderful World!',
    'Sousou no Frieren': 'Frieren: Beyond Journey\'s End',
    'Oshi no Ko': 'Oshi No Ko',
    'Sono Bisque Doll wa Koi wo Suru': 'My Dress-Up Darling',
    'Jujutsu Kaisen': 'Jujutsu Kaisen',
};

async function getAnimeInfo(title) {
    const titleMapKey = Object.keys(TITLE_MAP).find(k => k.toLowerCase() === title.toLowerCase());
    const searchTitle = (titleMapKey && TITLE_MAP[titleMapKey]) || title;
    if (infoCache[title] && (Date.now() - infoCache[title].at) < INFO_CACHE_TTL) {
        return infoCache[title];
    }

    // Try AniList first
    try {
        const gql = `query ($search: String) { Page(perPage: 3) { media(search: $search, type: ANIME) { description(asHtml: false) coverImage { large } bannerImage genres averageScore isAdult title { romaji english } } } }`;
        const resp = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: gql, variables: { search: searchTitle } }),
            signal: AbortSignal.timeout(5000)
        });
        const json = await resp.json();
        const mediaList = json?.data?.Page?.media || [];
        // Prefer non-adult result with matching name
        const infoNorm = (s) => (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();
        const searchNorm = infoNorm(searchTitle);
        const media = mediaList.find(m => !m.isAdult && (infoNorm(m.title?.romaji) === searchNorm || infoNorm(m.title?.english) === searchNorm))
            || mediaList.find(m => !m.isAdult)
            || mediaList[0];
        if (media?.description) {
            const result = { description: media.description, cover: media.coverImage?.large || null, banner: media.bannerImage || null, genres: (media.genres || []).filter(g => media.isAdult || g !== 'Hentai'), score: media.averageScore, source: 'anilist', at: Date.now() };
            infoCache[title] = result;
            return result;
        }
    } catch (e) { console.error('[meta] AniList failed:', e.message); }

    // ---------------------------------------------------------------------------
// jikanGet — Jikan over Node's https module, NOT global fetch.
//
// MEASURED 2026-08-22, same URL, same machine, same minute:
//     curl (any HTTP version)      -> 200
//     node https module (HTTP/1.1) -> 200, real data
//     node global fetch (undici)   -> 504, every time, with or without headers
// It is undici specifically. Not the User-Agent (tested three variants, all 504), not
// HTTP/2 (curl negotiated 1.1 anyway), and not the Electron bridge (plain node 504s too).
//
// Jikan also rate-limits (~3 req/s, 60/min) and answers 429 when exceeded — observed on
// the first of five back-to-back probes. So calls are serialised with a minimum gap and
// retried once on 429, otherwise a grid of covers trips it immediately.
const JIKAN_MIN_GAP_MS = 400;
let jikanChain = Promise.resolve();
let jikanLast = 0;

function jikanRequest(url) {
    return new Promise((resolve) => {
        const https = require('https');
        const req = https.get(url, {
            headers: { 'User-Agent': 'ANI-MATE', 'Accept': 'application/json' },
            timeout: 8000
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
            res.on('error', () => resolve({ status: 0, body: '' }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0, body: '' }); });
    });
}

// Serialised + rate-limit aware. Returns a fetch-like object so call sites are unchanged.
function jikanGet(url) {
    const run = async () => {
        const wait = Math.max(0, JIKAN_MIN_GAP_MS - (Date.now() - jikanLast));
        if (wait) await new Promise((r) => setTimeout(r, wait));
        let r = await jikanRequest(url);
        if (r.status === 429) {                       // backoff once, then give up
            await new Promise((r2) => setTimeout(r2, 1500));
            r = await jikanRequest(url);
        }
        jikanLast = Date.now();
        return r;
    };
    const p = jikanChain.then(run, run);
    jikanChain = p.then(() => undefined, () => undefined);
    return p.then((r) => ({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => JSON.parse(r.body || '{}'),
        text: async () => r.body || ''
    }));
}

// Jikan/MAL fallback
    try {
        const resp = await jikanGet(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchTitle)}&limit=1`);
        const json = await resp.json();
        const anime = json?.data?.[0];
        if (anime) {
            const result = { description: anime.synopsis || null, cover: anime.images?.jpg?.large_image_url || null, genres: (anime.genres || []).map(g => g.name), score: anime.score ? anime.score * 10 : null, source: 'mal', at: Date.now() };
            infoCache[title] = result;
            return result;
        }
    } catch (e) { console.error('[meta] Jikan fallback failed:', e.message); }

    // DO NOT cache a failure for the full hour. A single upstream blip used to blank
    // covers/descriptions for INFO_CACHE_TTL and never retry, which also hid the cause:
    // repeat calls returned the cached empty without touching the network, so nothing
    // ever logged. Failures now expire in 60s so the next view retries.
    const empty = { description: null, cover: null, genres: [], score: null, source: null,
                    at: Date.now() - (INFO_CACHE_TTL - 60 * 1000) };
    infoCache[title] = empty;
    return empty;
}

// Retry wrapper for flaky API calls (1 retry with backoff)
async function withRetry(fn, retries = 1, delayMs = 1000) {
    try { return await fn(); }
    catch (err) {
        if (retries <= 0) throw err;
        await new Promise(r => setTimeout(r, delayMs));
        return withRetry(fn, retries - 1, delayMs * 2);
    }
}

// Fix display names using TITLE_MAP (abbreviations + romaji → English)
function fixDisplayName(result) {
    const normName = (s) => (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    const n = result.name;
    // Check exact alias (case-insensitive)
    const aliasKey = Object.keys(TITLE_MAP).find(k => k.toLowerCase() === n.toLowerCase())
        || Object.keys(TITLE_MAP).find(k => normName(k) === normName(n));
    if (aliasKey) {
        result.name = TITLE_MAP[aliasKey];
        if (!result.title_english) result.title_english = TITLE_MAP[aliasKey];
    }
    return result;
}

// Franchise pattern list — used by search grouping and favorites backfill
const FRANCHISE_PATTERNS = [
    'jujutsu kaisen', 'one piece', 'attack on titan', 'shingeki no kyojin',
    'demon slayer', 'kimetsu no yaiba', 'my hero academia', 'boku no hero academia',
    'sword art online', 'naruto', 'dragon ball', 'bleach', 'hunter x hunter',
    'fullmetal alchemist', 'mob psycho', 're zero', 'overlord', 'konosuba',
    'jojo', "jojo's bizarre adventure", 'spy x family', 'spy family',
    'dr stone', 'dr. stone', 'solo leveling', 'ore dake level up',
    'mushoku tensei', 'that time i got reincarnated as a slime', 'tensei shitara slime',
    'danmachi', 'is it wrong to try to pick up girls in a dungeon',
    'chainsaw man', 'vinland saga', 'mashle', 'blue lock', 'frieren',
    'oshi no ko',
];

// Direct API calls to AllAnime (same as ani-cli but from Node)
async function searchAnime(query, mode = 'sub', allowAdult = false) {
    const searchGql = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } } }`;

    const variables = {
        search: { allowAdult, allowUnknown: false, query },
        limit: 40,
        page: 1,
        translationType: mode,
        countryOrigin: 'ALL'
    };

    const data = await withRetry(async () => {
        const response = await afetch(ALLANIME_API, {
            method: 'POST',
            headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables, query: searchGql }),
            signal: AbortSignal.timeout(8000)
        });
        const text = await response.text();
        try { return JSON.parse(text); } catch { throw new Error('AllAnime returned non-JSON'); }
    });

    const results = [];
    if (data?.data?.shows?.edges) {
        for (const show of data.data.shows.edges) {
            const epCount = show.availableEpisodes?.[mode] || 0;
            if (epCount > 0) {
                const type = epCount === 1 ? 'movie' : epCount <= 12 ? 'short' : 'series';
                results.push({
                    id: show._id,
                    name: show.name,
                    episodes: epCount,
                    type
                });
            }
        }
    }
    // Sort: series first (by ep count desc), then shorts, then movies
    results.sort((a, b) => b.episodes - a.episodes);
    if (results.length) return results;

    // FALLBACK: AllAnime returned nothing (it currently 403s on every call). IDs are
    // tagged `anidb:<id>` so getEpisodeList/getEpisodeUrl route to the right provider —
    // show ids are not portable between sources.
    const ad = getAniDB();
    if (ad) {
        try {
            const alt = await ad.search(query);
            return alt.map((r) => ({
                id: 'anidb:' + r.id,
                name: r.title,
                episodes: 0,
                provider: 'AniDB'
            }));
        } catch (e) {
            console.error('[anidb] search failed:', e.message);
        }
    }
    return results;
}


// Release date as one sortable integer, 0 when the date is unknown. An undated
// entry sorts to the front rather than disappearing, so ordering stays stable.
function dateKey(d, seasonYear) {
    const y = d?.year || seasonYear || 0;
    if (!y) return 0;
    return y * 10000 + (d?.month || 0) * 100 + (d?.day || 0);
}


// ─────────────────────────────────────────────────────────────────────────────
// SEARCH RANKING — keyword and content, blended, over the merged result set.
//
// Two signals:
//   KEYWORD  how well the query matches a TITLE (name, English title, synonyms).
//            exact > prefix > substring > all-tokens > partial > edit distance.
//   CONTENT  how well the query matches what the show IS — description, genres
//            and AniList tags — scored with BM25 across the candidate set.
//
// Honest about what this is: lexical-semantic, not embedding-semantic. It matches
// meaning-bearing TEXT, so "pharmacist in the palace" now finds Apothecary Diaries
// because the description says exactly that. It will NOT infer that "medicine girl
// royal court" means the same thing. That needs an embedding model and an index,
// which is a separate build.
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_STOP = new Set(['the','a','an','of','and','in','on','to','is','it','for',
    'with','his','her','its','that','this','be','are','as','at','by','from','or','was',
    'were','who','what','about','anime','show','series','season']);

function searchTok(s) {
    return (s || '').toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/[^a-z0-9぀-ヿ一-鿿]+/g, ' ')
        .split(' ')
        .filter(w => w.length > 1 && !SEARCH_STOP.has(w));
}

// Levenshtein, capped — anything past the cap is "not close" and the exact
// distance stops mattering.
function editDist(a, b, cap = 8) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                              prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < best) best = cur[j];
        }
        if (best > cap) return cap + 1;
        prev = cur;
    }
    return prev[b.length];
}

function keywordScore(q, r, norm) {
    const qn = norm(q);
    if (!qn) return 0;
    const qt = searchTok(q);
    const titles = [r.name, r.title_english, ...(r.synonyms || [])]
        .filter(Boolean).map(norm).filter(Boolean);
    let best = 0;
    for (const t of titles) {
        let sc;
        if (t === qn) sc = 100;
        else if (t.startsWith(qn)) sc = 80 - Math.min(16, (t.length - qn.length) / 3);
        else if (t.includes(qn)) sc = 62;
        else {
            const tt = new Set(searchTok(t));
            const hit = qt.filter(w => tt.has(w)).length;
            if (qt.length && hit === qt.length) sc = 55;
            else if (hit) sc = 18 + 26 * (hit / qt.length);
            else {
                const d = editDist(qn, t);
                const sim = 1 - d / Math.max(qn.length, t.length, 1);
                sc = sim > 0.72 ? 32 * sim : 0;
            }
        }
        if (sc > best) best = sc;
    }
    return best;
}

// BM25 over description + genres + tags, across just this result set. A small
// corpus is fine: the job is to order these candidates, not to search the world.
function contentScores(q, items) {
    const qt = [...new Set(searchTok(q))];
    const docs = items.map(r => searchTok(
        [r.description, (r.genres || []).join(' '), (r.tags || []).join(' ')].join(' ')));
    const N = docs.length || 1;
    const avgdl = docs.reduce((a, d) => a + d.length, 0) / N || 1;
    const df = Object.create(null);
    for (const d of docs) for (const w of new Set(d)) df[w] = (df[w] || 0) + 1;
    const k1 = 1.5, b = 0.75;
    return docs.map(d => {
        if (!d.length) return 0;
        const tf = Object.create(null);
        for (const w of d) tf[w] = (tf[w] || 0) + 1;
        let s = 0;
        for (const w of qt) {
            const f = tf[w];
            if (!f) continue;
            const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
            s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
        }
        return s;
    });
}

// Blend and sort in place.
//
// The weighting is ADAPTIVE, and it has to be. A fixed split ranked "Cowboy Bebop"
// below "Cowboy Bebop: Tengoku no Tobira", because the movie's synopsis repeats the
// franchise name and the 26-episode series carried no description at all. Two rules
// come out of that:
//
//   1. Content only earns real weight when NO title matched well. If someone typed
//      a title, titles decide. Content is for queries that describe a show.
//   2. A missing description is missing DATA, not a zero match. Scoring it 0 punishes
//      an entry for a gap in the upstream metadata, so it inherits the set's median.
function rankResults(q, items, norm) {
    if (!items.length) return items;
    const content = contentScores(q, items);
    const hasText = items.map(r =>
        !!((r.description && r.description.length > 40) || (r.tags || []).length));
    const maxC = Math.max(1e-9, ...content);

    const kws = items.map(r => keywordScore(q, r, norm));
    const bestKw = Math.max(0, ...kws);
    const wC = bestKw >= 70 ? 0.10 : bestKw >= 45 ? 0.30 : 0.60;
    const wK = 1 - wC;

    const present = content.filter((_, i) => hasText[i]).sort((a, b) => a - b);
    const medC = present.length ? present[Math.floor(present.length / 2)] : 0;

    items.forEach((r, i) => {
        const kw = kws[i];
        const raw = hasText[i] ? content[i] : medC;
        const cn = 100 * (raw / maxC);
        // Popularity is a real signal for "which of these did they mean", not just
        // a tiebreak: the main series is always far more popular than its recap.
        const pop = Math.log10(1 + (r.popularity || 0)) * 3;
        r.kw_score = Math.round(kw);
        r.content_score = Math.round(cn);
        r.search_score = Math.round(kw * wK + cn * wC + pop);
    });
    items.sort((a, b) => b.search_score - a.search_score
                      || (b.popularity || 0) - (a.popularity || 0));
    return items;
}

// AniList search — fuzzy matching, romaji/English, catches misspellings
async function searchAniList(query, limit = 15) {
    try {
        const gql = `query ($search: String, $perPage: Int) {
            Page(page: 1, perPage: $perPage) {
                media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
                    id title { english romaji } coverImage { medium }
                    description(asHtml: false) format episodes status
                    genres isAdult popularity
                    startDate { year month day } seasonYear
                    synonyms
                    tags { name rank isGeneralSpoiler }
                    relations { edges { node { id title { romaji english } format episodes
                                               startDate { year month day } seasonYear } relationType } }
                }
            }
        }`;
        const resp = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: gql, variables: { search: query, perPage: limit } }),
            signal: AbortSignal.timeout(5000)
        });
        const json = await resp.json();
        return (json?.data?.Page?.media || []).map(m => ({
            anilist_id: m.id,
            title_english: m.title?.english || null,
            title_romaji: m.title?.romaji || null,
            cover: m.coverImage?.medium || null,
            description: m.description || null,
            format: m.format,
            episodes: m.episodes,
            status: m.status,
            genres: m.genres || [],
            isAdult: m.isAdult || false,
            popularity: m.popularity || 0,
            synonyms: m.synonyms || [],
            // Sortable release key. Franchise ordering used to run on episode count,
            // which puts a currently-airing season LAST because it has the fewest
            // episodes. Date is the only field that orders seasons correctly.
            start_key: dateKey(m.startDate, m.seasonYear),
            // Tag names above the noise floor, spoilers excluded. Content signal for
            // the semantic half of search.
            tags: (m.tags || []).filter(t => !t.isGeneralSpoiler && (t.rank ?? 0) >= 40).map(t => t.name),
            relations: (m.relations?.edges || [])
                .filter(e => ['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'PARENT'].includes(e.relationType))
                .map(e => ({ id: e.node.id, title_romaji: e.node.title?.romaji, title_english: e.node.title?.english, format: e.node.format, episodes: e.node.episodes, start_key: dateKey(e.node.startDate, e.node.seasonYear), relationType: e.relationType }))
        }));
    } catch { return []; }
}

async function getEpisodeList(showId, mode = 'sub') {
    // Route by provider tag. AniDB show ids are numeric and unrelated to AllAnime's,
    // so the tag applied at search time decides which source answers.
    if (String(showId).startsWith('anidb:')) {
        const ad = getAniDB();
        if (!ad) return [];
        try {
            const eps = await ad.getEpisodes(String(showId).slice(6));
            return eps.map((e) => e.number);
        } catch (e) {
            console.error('[anidb] episodes failed:', e.message);
            return [];
        }
    }
    const gql = `query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail } }`;
    const variables = { showId };

    const data = await withRetry(async () => {
        const response = await afetch(ALLANIME_API, {
            method: 'POST',
            headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables, query: gql }),
            signal: AbortSignal.timeout(8000)
        });
        const text = await response.text();
        try { return JSON.parse(text); }
        catch { throw new Error('AllAnime returned non-JSON response'); }
    });

    let episodes = [];
    try {
        const detail = data?.data?.show?.availableEpisodesDetail;
        if (detail && detail[mode]) {
            episodes = detail[mode].sort((a, b) => parseFloat(a) - parseFloat(b));
        }
    } catch { /* ignore */ }
    return episodes;
}

// Decode provider ID (hex mapping from ani-cli latest)
function decodeProviderId(encoded) {
    const hexMap = {
        '01': '9', '08': '0', '05': '=', '0a': '2', '0b': '3',
        '0c': '4', '07': '?', '00': '8', '5c': 'd', '0f': '7',
        '5e': 'f', '17': '/', '54': 'l', '09': '1', '48': 'p',
        '4f': 'w', '0e': '6', '5b': 'c', '5d': 'e', '0d': '5',
        '53': 'k', '1e': '&', '5a': 'b', '59': 'a', '4a': 'r',
        '4c': 't', '4e': 'v', '57': 'o', '51': 'i',
        // Extended map (added in newer ani-cli versions)
        '50': 'h', '4b': 's', '02': ':', '16': '.', '4d': 'u',
        '55': 'm', '56': 'n', '79': 'A', '7a': 'B', '7b': 'C',
        '7c': 'D', '7d': 'E', '7e': 'F', '7f': 'G', '70': 'H',
        '71': 'I', '72': 'J', '73': 'K', '74': 'L', '75': 'M',
        '76': 'N', '77': 'O', '68': 'P', '69': 'Q', '6a': 'R',
        '6b': 'S', '6c': 'T', '6d': 'U', '6e': 'V', '6f': 'W',
        '60': 'X', '61': 'Y', '62': 'Z', '52': 'j', '5f': 'g',
        '40': 'x', '41': 'y', '42': 'z', '15': '-', '67': '_',
        '46': '~', '1b': '#', '63': '[', '65': ']', '78': '@',
        '19': '!', '1c': '$', '10': '(', '11': ')', '12': '*',
        '13': '+', '14': ',', '03': ';', '1d': '%', '49': 'q'
    };
    let result = '';
    for (let i = 0; i < encoded.length; i += 2) {
        const hex = encoded.substring(i, i + 2);
        result += hexMap[hex] || hex;
    }
    return result.replace('/clock', '/clock.json');
}

async function getEpisodeUrl(showId, episodeString, mode = 'sub', quality = 'best') {
    const gql = `query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode( showId: $showId translationType: $translationType episodeString: $episodeString ) { episodeString sourceUrls } }`;

    const variables = { showId, translationType: mode, episodeString };

    const text = await withRetry(async () => {
        const response = await afetch(ALLANIME_API, {
            method: 'POST',
            headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables, query: gql }),
            signal: AbortSignal.timeout(8000)
        });
        return response.text();
    });

    // Parse source URLs from response
    const sourceUrls = [];
    const sourceRegex = /"sourceUrl":"--([^"]*)"[^}]*"sourceName":"([^"]*)"/g;
    let match;
    while ((match = sourceRegex.exec(text)) !== null) {
        sourceUrls.push({ url: match[1], name: match[2] });
    }

    // Fetch all providers in parallel (3-5x faster than sequential)
    const allLinks = [];
    const providerResults = await Promise.allSettled(
        sourceUrls.map(async (source) => {
            const decodedPath = decodeProviderId(source.url);
            const linkUrl = decodedPath.startsWith('http') ? decodedPath : `https://allanime.day${decodedPath}`;
            const linkResp = await afetch(linkUrl, {
                headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR },
                signal: AbortSignal.timeout(8000)
            });
            const linkText = await linkResp.text();
            const links = [];

            // Extract links
            const linkRegex = /"link":"([^"]*)"[^}]*"resolutionStr":"([^"]*)"/g;
            let linkMatch;
            while ((linkMatch = linkRegex.exec(linkText)) !== null) {
                const link = linkMatch[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
                links.push({ resolution: linkMatch[2], url: link, provider: source.name });
            }

            // Also check for HLS urls
            const hlsRegex = /"hls"[^}]*"url":"([^"]*)"[^}]*"hardsub_lang":"en-US"/g;
            while ((linkMatch = hlsRegex.exec(linkText)) !== null) {
                const link = linkMatch[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
                links.push({ resolution: 'hls', url: link, provider: source.name });
            }

            return links;
        })
    );

    for (const result of providerResults) {
        if (result.status === 'fulfilled') {
            allLinks.push(...result.value);
        }
    }

    // Sort by resolution descending (1080p > 720p > 480p > auto/hls)
    if (allLinks.length === 0) return null;
    const resRank = (r) => {
        const m = String(r).match(/(\d+)/);
        return m ? parseInt(m[1]) : 0;
    };
    allLinks.sort((a, b) => resRank(b.resolution) - resRank(a.resolution));

    let selected;
    if (quality === 'best') {
        selected = allLinks[0];
    } else if (quality === 'worst') {
        selected = allLinks[allLinks.length - 1];
    } else {
        selected = allLinks.find(l => l.resolution.includes(quality)) || allLinks[0];
    }

    return {
        url: selected.url,
        resolution: selected.resolution,
        provider: selected.provider,
        all_links: allLinks
    };
}

// === FALLBACK STREAMING PROVIDERS ===
// When AllAnime fails, try AnimePahe and HiAnime via consumet

const fallbackCache = {};
const FALLBACK_CACHE_TTL = 30 * 60 * 1000;

// Normalize title for cross-provider matching
function normTitle(s) {
    return (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// Search a consumet provider for a title, return best match ID + episode map
async function searchFallbackProvider(provider, providerName, title, titleEnglish) {
    const cacheKey = `${providerName}:${title}`;
    if (fallbackCache[cacheKey] && (Date.now() - fallbackCache[cacheKey].at) < FALLBACK_CACHE_TTL) {
        return fallbackCache[cacheKey].data;
    }

    try {
        const searchTerms = [title, titleEnglish].filter(Boolean);
        for (const term of searchTerms) {
            const results = await Promise.race([
                provider.search(term),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
            ]);
            if (!results?.results?.length) continue;

            const termNorm = normTitle(term);
            const match = results.results.find(r => normTitle(r.title) === termNorm)
                || results.results[0];

            if (match) {
                const info = await Promise.race([
                    provider.fetchAnimeInfo(match.id),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
                ]);
                const result = { id: match.id, title: match.title, episodes: info?.episodes || [] };
                fallbackCache[cacheKey] = { data: result, at: Date.now() };
                return result;
            }
        }
    } catch { /* provider failed */ }
    return null;
}

// Get stream URL from a fallback provider for a specific episode
async function getFallbackStreamUrl(provider, providerName, title, titleEnglish, episodeNum, mode) {
    const animeData = await searchFallbackProvider(provider, providerName, title, titleEnglish);
    if (!animeData?.episodes?.length) return null;

    // Find matching episode by number
    const ep = animeData.episodes.find(e => e.number === parseInt(episodeNum));
    if (!ep) return null;

    // Check sub/dub availability
    if (mode === 'dub' && ep.isDubbed === false) return null;
    if (mode === 'sub' && ep.isSubbed === false) return null;

    try {
        const sources = await Promise.race([
            provider.fetchEpisodeSources(ep.id),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
        ]);
        if (!sources?.sources?.length) return null;

        // Prefer m3u8 sources
        const m3u8 = sources.sources.filter(s => s.isM3U8);
        const selected = m3u8[0] || sources.sources[0];

        return {
            url: selected.url,
            resolution: selected.quality || 'auto',
            provider: providerName,
            all_links: sources.sources.map(s => ({
                url: s.url, resolution: s.quality || 'auto', provider: providerName
            })),
            headers: sources.headers || {}
        };
    } catch { /* stream fetch failed */ }
    return null;
}

// Master fallback chain: try each provider in order
// Provenance of the last successful resolve. Surfaced by /play so a working stream and a
// silently-substituted source are distinguishable, and so the next rotation is visible.
let lastStreamSource = null;
// Subtitles, referer and MAL id from whichever source answered. The old chain could only
// return a bare URL, so a source that supplied subtitle tracks had nowhere to put them.
let lastStreamMeta = null;

function getHiAnimeAt() {
    if (!hianimeAt) {
        try { hianimeAt = require('./hianime-at').makeProvider(afetch); }
        catch (e) { console.error('[hianime.at] load failed:', e.message); hianimeAt = null; }
    }
    return hianimeAt;
}

async function getEpisodeUrlWithFallbacks(showId, episodeString, mode, quality, title, titleEnglish) {
    lastStreamSource = null;
    lastStreamMeta = null;

    // 0a. HIANIME.AT FIRST. It is the only source measured working on 2026-10-05, and putting
    // a dead source ahead of it just spends the user's first click on a timeout.
    {
        const ha = getHiAnimeAt();
        if (ha) {
            for (const t of [title, titleEnglish].filter(Boolean)) {
                try {
                    const st = await ha.streamByTitle(t, episodeString, mode);
                    if (st && st.url) {
                        lastStreamSource = 'HiAnime.at';
                        lastStreamMeta = { referer: st.referer, subtitles: st.subtitles, malId: st.malId };
                        return st.url;
                    }
                } catch (e) { console.error('[hianime.at]', e.message); }
            }
        }
    }
    // 0. AniDB shows resolve directly — the tag already told us who owns this id.
    if (String(showId).startsWith('anidb:')) {
        const ad = getAniDB();
        if (ad) {
            try {
                const eps = await ad.getEpisodes(String(showId).slice(6));
                const hit = eps.find((e) => String(e.number) === String(episodeString));
                if (hit) {
                    const st = await ad.getStream(hit.id, mode);
                    if (st) { lastStreamSource = 'AniDB'; return st.url; }
                }
            } catch (e) {
                console.error('[anidb] stream failed:', e.message);
            }
        }
        return null;
    }

    // 1. Try AllAnime (primary)
    const allAnimeResult = await getEpisodeUrl(showId, episodeString, mode, quality);
    if (allAnimeResult) { lastStreamSource = 'AllAnime'; return allAnimeResult; }

    // 2. Try AnimePahe
    if (consumetAnimePahe) {
        const paheResult = await getFallbackStreamUrl(consumetAnimePahe, 'AnimePahe', title, titleEnglish, episodeString, mode);
        if (paheResult) { lastStreamSource = 'AnimePahe'; return paheResult; }
    }

    // 3. Try HiAnime
    if (consumetHiAnime) {
        const hiResult = await getFallbackStreamUrl(consumetHiAnime, 'HiAnime', title, titleEnglish, episodeString, mode);
        if (hiResult) { lastStreamSource = 'HiAnime'; return hiResult; }
    }

    // 4. Last resort: match the title on AniDB. Reached when a show was found via AllAnime
    // (so its id is not tagged) but no source could produce a stream.
    const ad4 = getAniDB();
    if (ad4) {
        try {
            for (const t of [title, titleEnglish].filter(Boolean)) {
                const hits = await ad4.search(t);
                if (!hits.length) continue;
                const eps = await ad4.getEpisodes(hits[0].id);
                const hit = eps.find((e) => String(e.number) === String(episodeString));
                if (!hit) continue;
                const st = await ad4.getStream(hit.id, mode);
                if (st) { lastStreamSource = 'AniDB (title match)'; return st.url; }
            }
        } catch (e) {
            console.error('[anidb] title-match fallback failed:', e.message);
        }
    }

    return null;
}

function getHistory() {
    // Read ani-cli native history
    const nativeHistory = [];
    try {
        if (fs.existsSync(HIST_FILE)) {
            const content = fs.readFileSync(HIST_FILE, 'utf8').trim();
            if (content) {
                for (const line of content.split('\n')) {
                    const parts = line.split('\t');
                    if (parts.length >= 3) {
                        nativeHistory.push({
                            episode: parts[0],
                            anime_id: parts[1],
                            title: parts[2]
                        });
                    }
                }
            }
        }
    } catch { /* ignore */ }

    // Merge with forge history
    const forgeHistory = loadForgeHistory();

    return { native: nativeHistory, forge: forgeHistory };
}

function getContinueList() {
    const history = loadForgeHistory();
    return history
        .filter(h => {
            // Only show anime where we haven't finished all episodes
            if (!h.total_episodes) return true; // unknown total = always show
            const watched = Array.isArray(h.episodes_watched) ? h.episodes_watched.length : 1;
            return watched < h.total_episodes;
        })
        .map(h => {
            const watched = Array.isArray(h.episodes_watched) ? h.episodes_watched : [h.episode];
            const numericEps = watched.map(Number).filter(n => !isNaN(n));
            const maxWatched = numericEps.length > 0 ? Math.max(...numericEps) : 0;
            const nextEp = maxWatched + 1;

            // Determine resume info: if there's a saved playback position, resume there
            // Otherwise suggest next unwatched episode
            const hasResumePosition = h.playback_time && h.playback_time > 10;
            const resumeEpisode = hasResumePosition ? h.playback_episode || h.episode : String(nextEp);
            const resumeTime = hasResumePosition ? h.playback_time : 0;

            const item = {
                anime_id: h.anime_id,
                title: h.title,
                episode: h.episode,
                episodes_watched: watched,
                total_episodes: h.total_episodes,
                next_episode: nextEp,
                resume_episode: resumeEpisode,
                resume_time: resumeTime,
                mode: h.mode,
                timestamp: h.timestamp
            };
            if (h.title_english) item.title_english = h.title_english;
            return item;
        });
}

// Safe body reader with 1MB size limit
function readBody(req, limit = 1048576) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > limit) {
                req.destroy();
                reject(new Error('Body too large'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// Safe JSON parse — returns null on failure
function safeJsonParse(str) {
    try { return JSON.parse(str); } catch { return null; }
}

// JSON response helper
function jsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
    try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });
        res.end(content);
    } catch {
        jsonResponse(res, 404, { error: 'File not found' });
    }
}

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    const UI_DIR = process.env.ANI_MATE_UI_DIR || __dirname;

    try {
        // Serve the UI
        if (pathname === '/' || pathname === '/index.html') {
            serveStatic(res, path.join(UI_DIR, 'ani-mate-ui.html'), 'text/html');
            return;
        }

        // Serve bundled hls.js
        if (pathname === '/hls.min.js') {
            serveStatic(res, path.join(UI_DIR, 'hls.min.js'), 'application/javascript');
            return;
        }

        // API routes
        // SOURCE HEALTH — probe every provider and say which are alive.
        // The 2026-08-20 diagnosis asked for exactly this: sources rotate every few months,
        // and without a probe a dead source is indistinguishable from a broken app. Returns
        // per-provider status so the UI can say "source unreachable" instead of showing an
        // empty list.
        if (pathname === '/health/sources') {
            const out = [];
            const ad = getAniDB();
            if (ad) { try { out.push(await ad.health()); } catch (e) { out.push({ name: 'AniDB', ok: false, error: String(e.message || e) }); } }
            else out.push({ name: 'AniDB', ok: false, error: 'provider not loaded' });
            try {
                const t0 = Date.now();
                // A real query, not an empty one: an empty GraphQL body makes the edge
                // hang for the full timeout, which reports as a 30 s failure regardless of
                // whether the source is actually up.
                // MUST be POST. The app's real AllAnime calls are POST (see v0.4.4);
                // a GET probe returns 403 and libels a working source as dead.
                //
                // ⛔ AND IT MUST BE THE **EPISODE** QUERY, NOT THE SEARCH QUERY.
                // Measured 2026-10-05: the `shows` search query answers 200 while the `episode`
                // query — the only one that returns sourceUrls — answers
                //     {"errors":[{"message":"AA_CRYPTO_MISSING"}],"data":{"episode":null}}
                // because AllAnime moved to a per-epoch AES-GCM aaReq token. Probing `shows`
                // therefore reported AllAnime HEALTHY while the app could not play anything at
                // all, and /health/sources returned ok:true on a completely dead app.
                //
                // THIS IS THE CEB FAILURE FROM CLAUDE.md: ALIVE IS NOT HEALTHY. A probe that
                // asks "does the server answer" instead of "does the feature work" always
                // eventually says yes about something broken. The probe is now the real thing.
                const r = await afetch(ALLANIME_API, {
                    method: 'POST',
                    headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        variables: { showId: HEALTH_PROBE_SHOW, translationType: 'sub', episodeString: '1' },
                        query: 'query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode( showId: $showId translationType: $translationType episodeString: $episodeString ) { episodeString sourceUrls } }'
                    }),
                    signal: AbortSignal.timeout(12000)
                });
                const body = r && r.ok ? await r.text() : '';
                let srcCount = 0, gqlErr = null;
                try {
                    const j = JSON.parse(body || '{}');
                    gqlErr = (j.errors && j.errors[0] && (j.errors[0].extensions?.code || j.errors[0].message)) || null;
                    srcCount = ((j.data && j.data.episode && j.data.episode.sourceUrls) || []).length;
                } catch (e) { gqlErr = 'unparseable response'; }
                // ok ONLY when a real stream source came back. HTTP 200 is not the question.
                out.push({
                    name: 'AllAnime',
                    ok: srcCount > 0,
                    status: r ? r.status : 0,
                    sources: srcCount,
                    error: gqlErr || undefined,
                    ms: Date.now() - t0
                });
            } catch (e) { out.push({ name: 'AllAnime', ok: false, error: String(e.message || e) }); }

            // HIANIME.AT IS PROBED FIRST BECAUSE IT IS THE ONE THAT WORKS. A health check
            // that omits the only functioning source is the same lie as one that reports a
            // broken source healthy — it just fails in the other direction.
            {
                const t0h = Date.now();
                try {
                    const ha = getHiAnimeAt();
                    if (!ha) throw new Error('provider failed to load');
                    const hits = await ha.search('cowboy bebop');
                    const eps = hits.length ? await ha.episodes(hits[0].id) : [];
                    // ok only if it got all the way to a playable url, not merely to a search hit
                    const st = eps.length ? await ha.stream(eps[0].id, 'sub') : null;
                    out.push({
                        name: 'HiAnime.at', ok: !!(st && st.url),
                        results: hits.length, episodes: eps.length,
                        subtitles: st ? (st.subtitles || []).length : 0,
                        ms: Date.now() - t0h,
                    });
                } catch (e) {
                    out.push({ name: 'HiAnime.at', ok: false, error: String(e.message || e).slice(0, 90), ms: Date.now() - t0h });
                }
            }

            // The other three are PROBED, not asserted. The previous version pushed hardcoded
            // strings here — 'domain rotated', 'upstream 522' — which can never report healthy
            // and never actually tested anything. Two of four providers had a fake status.
            for (const prov of [
                { name: 'AnimePahe', mod: consumetAnimePahe },
                { name: 'HiAnime',   mod: consumetHiAnime },
            ]) {
                const t = Date.now();
                if (!prov.mod) { out.push({ name: prov.name, ok: false, note: 'not installed' }); continue; }
                try {
                    // 45s, not 12s. A FIRST request through the bridge may have to solve a
                    // Cloudflare interstitial in a hidden window, and solveChallenge alone
                    // allows 30s. A 12s probe timed out on a request that was working, and
                    // reported the source dead for it.
                    const res = await Promise.race([
                        prov.mod.search('cowboy bebop'),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 45s')), 45000)),
                    ]);
                    const n = ((res && res.results) || []).length;
                    out.push({ name: prov.name, ok: n > 0, results: n, ms: Date.now() - t });
                } catch (e) {
                    out.push({ name: prov.name, ok: false, error: String(e.message || e).slice(0, 90), ms: Date.now() - t });
                }
            }

            const anyOk = out.some((o) => o.ok);
            jsonResponse(res, 200, { ok: anyOk, providers: out });
            return;
        }

        if (pathname === '/info') {
            if (!query.title) {
                jsonResponse(res, 400, { error: 'Missing title parameter' });
                return;
            }
            const info = await getAnimeInfo(query.title);
            jsonResponse(res, 200, info);
            return;
        }

        if (pathname === '/search') {
            if (!query.q) {
                jsonResponse(res, 400, { error: 'Missing search query parameter "q"' });
                return;
            }
            const mode = query.mode || 'sub';
            const nsfw = query.nsfw === 'true';

            // Dual-source search: AllAnime (primary/streams) + AniList (fuzzy/romaji)
            const [allAnimeResults, aniListResults] = await Promise.all([
                searchAnime(query.q, mode, nsfw).catch(() => []),
                searchAniList(query.q, 15)
            ]);

            // Everything AniList returned goes into the local content index, so the
            // corpus grows from ordinary use rather than needing a crawl.
            try { SearchIndex.upsert(aniListResults); } catch { /* never block a search */ }

            const results = allAnimeResults.map(r => fixDisplayName(r));
            const existingNames = new Set(results.map(r => r.name.toLowerCase()));

            // Normalize name for fuzzy matching (strip punctuation, collapse whitespace)
            const normName = (s) => (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();

            // Strip season/part suffixes for base-title matching
            const stripSeason = (s) => s.replace(/\b(season|part|cour|s)\s*\d+/gi, '').replace(/\b\d+(st|nd|rd|th)\s*(season|part|cour)/gi, '').replace(/\s+(ii|iii|iv|v|vi)$/i, '').replace(/\s+/g, ' ').trim();


            // Season number from a title. Absent means season 1, which is what
            // "Kusuriya no Hitorigoto" vs "... 2nd Season" actually means.
            const seasonNum = (s) => {
                const m = s.match(/\b(\d+)\s*(?:st|nd|rd|th)\s+season\b/)
                       || s.match(/\bseason\s*(\d+)\b/)
                       || s.match(/\bpart\s*(\d+)\b/)
                       || s.match(/\bcour\s*(\d+)\b/);
                if (m) return parseInt(m[1], 10);
                const rom = s.match(/\s+(ii|iii|iv|v|vi)$/);
                if (rom) return { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 }[rom[1]];
                return 1;
            };
            // Multi-pass AniList matching: exact → base-title → contains
            function findAniMatch(name, aniResults) {
                const n = normName(name);
                const nBase = stripSeason(n);
                // Pass 1: exact normalized match
                let m = aniResults.find(a =>
                    (a.title_romaji && normName(a.title_romaji) === n) ||
                    (a.title_english && normName(a.title_english) === n));
                if (m) return m;
                // Pass 2: base title match — but ONLY when the season numbers agree.
                //
                // This used to strip the season off both sides and compare the stems,
                // so "Kusuriya no Hitorigoto Season 3" matched the SEASON 1 AniList
                // entry and inherited its date, cover and description. Every later
                // season of every show was being described as its first season.
                const nSeason = seasonNum(n);
                m = aniResults.find(a => {
                    const rN = normName(a.title_romaji || '');
                    const eN = normName(a.title_english || '');
                    const rBase = stripSeason(rN);
                    const eBase = stripSeason(eN);
                    if (rBase && rBase === nBase && seasonNum(rN) === nSeason) return true;
                    if (eBase && eBase === nBase && seasonNum(eN) === nSeason) return true;
                    return false;
                });
                if (m) return m;
                // Pass 3: one contains the other (min 8 chars to avoid false positives)
                if (n.length >= 8) {
                    m = aniResults.find(a => {
                        const r = normName(a.title_romaji || '');
                        const e = normName(a.title_english || '');
                        // Same season guard as pass 2: a prefix match across different
                        // seasons is the same wrong answer by another route.
                        const okR = r.length >= 8 && (r.startsWith(n) || n.startsWith(r))
                                    && seasonNum(r) === nSeason;
                        const okE = e.length >= 8 && (e.startsWith(n) || n.startsWith(e))
                                    && seasonNum(e) === nSeason;
                        return okR || okE;
                    });
                }
                return m || null;
            }

            // Enrich AllAnime results with AniList data
            for (const r of results) {
                const rNorm = normName(r.name);
                let aniMatch = findAniMatch(r.name, aniListResults);
                // Fallback: check TITLE_MAP alias (e.g. "1P" → "One Piece"), case-insensitive
                const aliasKey = Object.keys(TITLE_MAP).find(k => k.toLowerCase() === r.name.toLowerCase())
                    || Object.keys(TITLE_MAP).find(k => normName(k) === rNorm);
                if (!aniMatch && aliasKey) {
                    aniMatch = findAniMatch(TITLE_MAP[aliasKey], aniListResults);
                }
                // If TITLE_MAP matched, fix the display name (abbreviation → real title)
                if (aliasKey) {
                    r.name = (aniMatch?.title_romaji) || TITLE_MAP[aliasKey];
                    if (!r.title_english) r.title_english = aniMatch?.title_english || TITLE_MAP[aliasKey] || null;
                }
                // If aniMatch is adult but the AllAnime source isn't marked adult, skip the match
                if (aniMatch && aniMatch.isAdult) {
                    const nameMatch = normName(aniMatch.title_romaji) === rNorm || normName(aniMatch.title_english) === rNorm;
                    if (!nameMatch && !aliasKey) aniMatch = null;
                }
                if (aniMatch) {
                    if (!r.title_english) r.title_english = aniMatch.title_english;
                    r.cover = r.cover || aniMatch.cover;
                    r.description = r.description || aniMatch.description;
                    r.anilist_format = aniMatch.format;
                    // Set genres, filter Hentai from non-adult matches
                    r.genres = (aniMatch.genres || []).filter(g => aniMatch.isAdult || g !== 'Hentai');
                    r.anilist_id = aniMatch.anilist_id;
                    // Ordering and scoring signals. start_key is what seasons sort on.
                    r.start_key = aniMatch.start_key || 0;
                    r.popularity = aniMatch.popularity || 0;
                    r.tags = aniMatch.tags || [];
                    r.synonyms = aniMatch.synonyms || [];
                }
            }

            // Find AniList results NOT already in AllAnime results
            const aniListOnly = aniListResults.filter(a => {
                if (!nsfw && a.isAdult) return false; // Skip adult AniList results when NSFW off
                const names = [a.title_english, a.title_romaji].filter(Boolean).map(n => n.toLowerCase());
                return !names.some(n => existingNames.has(n));
            });

            // Search AllAnime for AniList-only titles, in parallel. The cap was 3,
            // which silently truncated the AniList half of a "hybrid" search.
            const secondarySearches = aniListOnly.slice(0, SECONDARY_LOOKUP_CAP).map(async (aniResult) => {
                const searchName = aniResult.title_romaji || aniResult.title_english;
                if (!searchName) return null;
                try {
                    const subResults = await searchAnime(searchName, mode, nsfw);
                    if (subResults.length > 0) {
                        const match = subResults[0];
                        if (!existingNames.has(match.name.toLowerCase())) {
                            match.cover = aniResult.cover;
                            match.description = aniResult.description;
                            match.title_english = aniResult.title_english;
                            return match;
                        }
                    }
                } catch { /* skip */ }
                return null;
            });

            const secondaryResults = (await Promise.all(secondarySearches)).filter(Boolean);
            for (const r of secondaryResults) {
                if (!existingNames.has(r.name.toLowerCase())) {
                    results.push(r);
                    existingNames.add(r.name.toLowerCase());
                }
            }

            // Attach cover images for results still missing covers
            try {
                const uncovered = results.filter(r => !r.cover).slice(0, 15).map(r => r.name);
                if (uncovered.length > 0) {
                    const anilistData = await getAniListCovers(uncovered);
                    for (const r of results) {
                        if (!r.cover) {
                            const info = anilistData[r.name];
                            r.cover = info?.cover || null;
                            r.description = r.description || info?.description || null;
                        }
                    }
                }
            } catch { /* non-critical */ }

            // Franchise grouping via AniList relations (union-find)
            const ufParent = {};
            function ufFind(x) { return ufParent[x] === undefined ? x : (ufParent[x] = ufFind(ufParent[x])); }
            function ufUnion(a, b) { const ra = ufFind(a), rb = ufFind(b); if (ra !== rb) ufParent[Math.max(ra, rb)] = Math.min(ra, rb); }

            // Build comprehensive name→anilist_id map (search results + ALL relations)
            const nameToAniId = {};
            const aniIdFormat = {};
            const aniIdStart = {};   // anilist id -> release key, for season ordering
            const aniIdPop = {};     // anilist id -> popularity, for search ranking
            for (const a of aniListResults) {
                if (a.title_romaji) nameToAniId[normName(a.title_romaji)] = a.anilist_id;
                if (a.title_english) nameToAniId[normName(a.title_english)] = a.anilist_id;
                // Synonyms catch alternate romanisations the two sources disagree on,
                // which is one way an entry ends up ungrouped next to its own franchise.
                for (const syn of (a.synonyms || [])) {
                    const k = normName(syn);
                    if (k && !nameToAniId[k]) nameToAniId[k] = a.anilist_id;
                }
                aniIdFormat[a.anilist_id] = a.format;
                aniIdStart[a.anilist_id] = a.start_key || 0;
                aniIdPop[a.anilist_id] = a.popularity || 0;
                // Also index relation titles so we can match AllAnime results to related anime
                if (a.relations) {
                    for (const rel of a.relations) {
                        if (rel.title_romaji) nameToAniId[normName(rel.title_romaji)] = rel.id;
                        if (rel.title_english) nameToAniId[normName(rel.title_english)] = rel.id;
                        aniIdFormat[rel.id] = rel.format;
                        if (rel.start_key) aniIdStart[rel.id] = rel.start_key;
                    }
                }
            }

            // Union related AniList IDs
            for (const a of aniListResults) {
                if (!a.relations) continue;
                for (const rel of a.relations) {
                    ufUnion(a.anilist_id, rel.id);
                }
            }

            // Name-pattern franchise overrides — group results whose normalized names share a common prefix
            for (const pattern of FRANCHISE_PATTERNS) {
                const pNorm = normName(pattern);
                const matchingIds = Object.entries(nameToAniId)
                    .filter(([name]) => name.startsWith(pNorm) || name === pNorm)
                    .map(([, id]) => id);
                for (let i = 1; i < matchingIds.length; i++) ufUnion(matchingIds[0], matchingIds[i]);
            }

            // Assign franchise_id and anilist_format to each result
            for (const r of results) {
                const rNorm = normName(r.name);
                const rEnNorm = r.title_english ? normName(r.title_english) : null;
                const aniId = nameToAniId[rNorm] || (rEnNorm && nameToAniId[rEnNorm]);
                if (aniId) {
                    r.anilist_id = aniId;
                    r.franchise_id = String(ufFind(aniId));
                    if (!r.anilist_format) r.anilist_format = aniIdFormat[aniId] || null;
                    // A result matched only by id here never went through the enrich
                    // loop above, so it would otherwise carry no date and sort wrong.
                    if (!r.start_key) r.start_key = aniIdStart[aniId] || 0;
                    if (!r.popularity) r.popularity = aniIdPop[aniId] || 0;
                }
            }

            // Last-chance franchise grouping: anything still without a franchise_id
            // whose season-stripped title matches one that HAS a franchise joins it.
            // Two AllAnime entries for one show (romaji and English) otherwise end
            // up side by side, one grouped and one orphaned.
            const baseToFid = {};
            for (const r of results) {
                if (!r.franchise_id) continue;
                const k = stripSeason(normName(r.name));
                if (k && !baseToFid[k]) baseToFid[k] = r.franchise_id;
                const ke = r.title_english ? stripSeason(normName(r.title_english)) : null;
                if (ke && !baseToFid[ke]) baseToFid[ke] = r.franchise_id;
            }
            for (const r of results) {
                if (r.franchise_id) continue;
                const k = stripSeason(normName(r.name));
                const ke = r.title_english ? stripSeason(normName(r.title_english)) : null;
                const fid = baseToFid[k] || (ke && baseToFid[ke]);
                if (fid) r.franchise_id = fid;
            }

            // When NSFW is off, filter out results with Hentai genre
            const finalResults = nsfw ? results : results.filter(r => {
                if (r.genres && r.genres.includes('Hentai')) return false;
                return true;
            });

            // ── CONTENT RETRIEVAL FALLBACK ──────────────────────────────────
            // Both upstream sources match titles only, so a query that describes a
            // show instead of naming it retrieves NOTHING and there is no result set
            // to rank. When the title search comes up short, search the local corpus
            // of descriptions/genres/tags and resolve the hits back to playable
            // AllAnime entries.
            // Fire ONLY when the title search genuinely failed to find the thing:
            // nothing at all, or nothing that matches a title well. Triggering on a
            // small-but-good result set pads a correct answer with loose content
            // matches - "apothecary diaries" returned 3 right answers and then
            // Mirai Nikki, because its synopsis shares some words.
            const bestTitleKw = finalResults.length
                ? Math.max(...finalResults.map(r => keywordScore(query.q, r, normName)))
                : 0;
            if (finalResults.length === 0 || bestTitleKw < CONTENT_FALLBACK_KW) {
                try {
                    const hits = SearchIndex.search(query.q, { limit: 8, nsfw });
                    const have = new Set(finalResults.map(r => normName(r.name)));
                    const lookups = hits.map(async (h) => {
                        const nm = h.entry.romaji || h.entry.english;
                        if (!nm || have.has(normName(nm))) return null;
                        const sub = await searchAnime(nm, mode, nsfw).catch(() => []);
                        if (!sub.length) return null;
                        const match = fixDisplayName(sub[0]);
                        if (have.has(normName(match.name))) return null;
                        match.cover = match.cover || null;
                        match.description = h.entry.desc;
                        match.title_english = match.title_english || h.entry.english;
                        match.genres = h.entry.genres || [];
                        match.tags = h.entry.tags || [];
                        match.start_key = h.entry.start || 0;
                        match.popularity = h.entry.pop || 0;
                        match.anilist_id = h.entry.id;
                        match.anilist_format = h.entry.fmt || null;
                        match.from_content_index = true;
                        return match;
                    });
                    for (const r of (await Promise.all(lookups))) {
                        if (r && !have.has(normName(r.name))) {
                            finalResults.push(r);
                            have.add(normName(r.name));
                        }
                    }
                } catch { /* the title results still stand */ }
            }

            // Rank the MERGED set. Until now AllAnime's order was kept as-is and
            // AniList-only titles were appended, with no scoring anywhere.
            rankResults(query.q, finalResults, normName);

            jsonResponse(res, 200, { results: finalResults, query: query.q, mode });
            return;
        }

        if (pathname === '/episodes') {
            if (!query.id) {
                jsonResponse(res, 400, { error: 'Missing anime ID parameter "id"' });
                return;
            }
            const mode = query.mode || 'sub';
            let episodes = [];
            try {
                episodes = await getEpisodeList(query.id, mode);
            } catch {
                jsonResponse(res, 200, { anime_id: query.id, episodes: [], mode, error: 'Source temporarily unavailable — try again in a moment' });
                return;
            }
            jsonResponse(res, 200, { anime_id: query.id, episodes, mode });
            return;
        }

        if (pathname === '/play' && req.method === 'POST') {
            const params = safeJsonParse(await readBody(req));
            if (!params || !params.anime_id || !params.episode) {
                jsonResponse(res, 400, { error: 'Missing anime_id or episode' });
                return;
            }

            const quality = params.quality || 'best';
            const mode = params.sub_or_dub || params.mode || 'sub';

            // Get episode URL via AllAnime + fallback providers
            const epUrl = await getEpisodeUrlWithFallbacks(
                params.anime_id, params.episode.toString(), mode, quality,
                params.title || '', params.title_english || ''
            );
            if (!epUrl) {
                jsonResponse(res, 404, { error: 'No streams available for this episode. The episode may not be uploaded yet — try again later.', retryable: true, sources_tried: ['AllAnime','AnimePahe','HiAnime','AniDB'] });
                return;
            }

            // Update history metadata only — episode NOT marked as watched yet
            // (client calls /mark-watched after 80% or 20min threshold)
            addToForgeHistory({
                anime_id: params.anime_id,
                title: params.title || 'Unknown',
                title_english: params.title_english || null,
                episode: params.episode,
                quality,
                mode,
                total_episodes: params.total_episodes || null,
                skip_watched: true
            });

            // Also update ani-cli native history
            try {
                const histLine = `${params.episode}\t${params.anime_id}\t${params.title || 'Unknown'}\n`;
                const histContent = fs.existsSync(HIST_FILE) ? fs.readFileSync(HIST_FILE, 'utf8') : '';
                if (histContent.includes(params.anime_id)) {
                    const updated = histContent.replace(
                        new RegExp(`^[^\\t]+\\t${params.anime_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\t.*$`, 'm'),
                        `${params.episode}\t${params.anime_id}\t${params.title || 'Unknown'}`
                    );
                    fs.writeFileSync(HIST_FILE, updated);
                } else {
                    fs.appendFileSync(HIST_FILE, histLine);
                }
            } catch { /* non-critical */ }

            const playTitle = `${params.title || 'Anime'} - Episode ${params.episode}`;
            // epUrl is a STRING from some sources and an OBJECT from others. It was read as
            // an object unconditionally, so any source returning a bare url produced
            // stream_url: undefined and a player with nothing to play.
            const asObj = (typeof epUrl === 'string') ? { url: epUrl } : (epUrl || {});
            jsonResponse(res, 200, {
                status: 'playing', source: lastStreamSource,
                stream_url: asObj.url,
                resolution: asObj.resolution,
                provider: asObj.provider,
                all_links: asObj.all_links,
                // From HiAnime.at: a real subtitle track, the referer its CDN requires, and
                // the MAL id ani-skip needs. Null from sources that cannot supply them.
                referer: (lastStreamMeta && lastStreamMeta.referer) || null,
                subtitles: (lastStreamMeta && lastStreamMeta.subtitles) || [],
                mal_id: (lastStreamMeta && lastStreamMeta.malId) || null,
                title: playTitle
            });
            return;
        }

        // Save playback progress (called periodically from UI)
        if (pathname === '/save-progress' && req.method === 'POST') {
            const params = safeJsonParse(await readBody(req));
            if (!params || !params.anime_id || !params.episode) {
                jsonResponse(res, 400, { error: 'Missing anime_id or episode' });
                return;
            }
            // Update playback position in history
            const history = loadForgeHistory();
            const idx = history.findIndex(h => h.anime_id === params.anime_id);
            if (idx >= 0) {
                history[idx].playback_time = params.playback_time || 0;
                history[idx].playback_episode = String(params.episode);
                saveForgeHistory(history);
            }
            jsonResponse(res, 200, { status: 'saved' });
            return;
        }

        // Mark episode as watched (called from UI after 80%/20min threshold)
        if (pathname === '/mark-watched' && req.method === 'POST') {
            const params = safeJsonParse(await readBody(req));
            if (!params || !params.anime_id || !params.episode) {
                jsonResponse(res, 400, { error: 'Missing anime_id or episode' });
                return;
            }
            const history = loadForgeHistory();
            const idx = history.findIndex(h => h.anime_id === params.anime_id);
            if (idx >= 0) {
                const ep = String(params.episode);
                if (!Array.isArray(history[idx].episodes_watched)) history[idx].episodes_watched = [];
                if (!history[idx].episodes_watched.includes(ep)) {
                    history[idx].episodes_watched.push(ep);
                }
                // Clear playback position since episode is now complete
                history[idx].playback_time = 0;
                history[idx].playback_episode = null;
                saveForgeHistory(history);
            }
            jsonResponse(res, 200, { status: 'marked' });
            return;
        }

        if (pathname === '/history') {
            const history = getHistory();
            jsonResponse(res, 200, history);
            return;
        }

        if (pathname === '/history/remove') {
            const animeId = query.id;
            if (!animeId) {
                jsonResponse(res, 400, { error: 'Missing id parameter' });
                return;
            }
            const history = loadForgeHistory();
            const idx = history.findIndex(h => h.anime_id === animeId);
            if (idx >= 0) {
                history.splice(idx, 1);
                saveForgeHistory(history);
                jsonResponse(res, 200, { status: 'removed', anime_id: animeId });
            } else {
                jsonResponse(res, 404, { error: 'Not found in history' });
            }
            return;
        }

        if (pathname === '/history/clear') {
            saveForgeHistory([]);
            jsonResponse(res, 200, { status: 'cleared' });
            return;
        }

        if (pathname === '/favorites/refresh' && req.method === 'POST') {
            try {
                const favs = loadFavorites();
                const history = loadForgeHistory();
                // Collect unique titles missing title_english
                const needsEnrich = new Map();
                for (const f of favs) {
                    if ((!f.title_english || !f.cover) && f.name) {
                        if (!needsEnrich.has(f.name)) needsEnrich.set(f.name, []);
                        needsEnrich.get(f.name).push(f);
                    }
                }
                for (const h of history) {
                    if (!h.title_english && h.title) {
                        if (!needsEnrich.has(h.title)) needsEnrich.set(h.title, []);
                        needsEnrich.get(h.title).push(h);
                    }
                }

                if (needsEnrich.size > 0) {
                    let updated = false;
                    const normName = (s) => (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();
                    for (const [name, entries] of needsEnrich) {
                        try {
                            const results = await searchAniList(name, 3);
                            const nameNorm = normName(name);
                            const match = results.find(r =>
                                (r.title_romaji && normName(r.title_romaji) === nameNorm) ||
                                (r.title_english && normName(r.title_english) === nameNorm)
                            );
                            if (match) {
                                for (const entry of entries) {
                                    if (match.title_english && !entry.title_english) entry.title_english = match.title_english;
                                    if (match.cover && !entry.cover) entry.cover = match.cover;
                                }
                                updated = true;
                            }
                        } catch { /* skip failed queries */ }
                    }
                    if (updated) {
                        saveFavorites(favs);
                        saveForgeHistory(history);
                    }
                }
                // Apply same fixDisplayName + franchise backfill as GET /favorites
                const fixedFavs = favs.map(f => fixDisplayName(f));
                const fn2 = (s) => (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();
                const pats2 = FRANCHISE_PATTERNS.map(p => fn2(p));
                function matchPat2(names) {
                    for (const name of names) {
                        const n = fn2(name);
                        const p = pats2.find(p => n.startsWith(p) || (p.length >= 6 && n.includes(p)));
                        if (p) return p;
                    }
                    return null;
                }
                const fp2 = favs.map(f => matchPat2([f.name, f.title_english || '']));
                const pi2 = {};
                for (let i = 0; i < favs.length; i++) {
                    if (!favs[i].franchise_id || !fp2[i]) continue;
                    if (!pi2[fp2[i]]) pi2[fp2[i]] = favs[i].franchise_id;
                }
                for (let i = 0; i < fixedFavs.length; i++) {
                    if (!fixedFavs[i].franchise_id && fp2[i]) {
                        fixedFavs[i].franchise_id = pi2[fp2[i]] || ('fav-' + fp2[i].replace(/\s+/g, '-'));
                    }
                }
                jsonResponse(res, 200, { favorites: fixedFavs, enriched: needsEnrich.size });
            } catch (err) {
                jsonResponse(res, 500, { error: 'Refresh failed' });
            }
            return;
        }

        if (pathname === '/continue') {
            const continueList = getContinueList();
            jsonResponse(res, 200, { continue_list: continueList });
            return;
        }

        if (pathname === '/daily') {
            const mode = query.mode || 'sub';
            const results = await getDailyPopular(mode);

            // Resolve AllAnime IDs for AniList-sourced results (parallel, max 5, 10s total timeout)
            const needsId = results.filter(r => !r.id).slice(0, 5);
            if (needsId.length > 0) {
                try {
                    await Promise.race([
                        Promise.all(needsId.map(async (r) => {
                            try {
                                const found = await searchAnime(r.name, mode);
                                if (found.length > 0) {
                                    r.id = found[0].id;
                                    r.episodes = r.episodes || found[0].episodes;
                                }
                            } catch { /* skip individual */ }
                        })),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
                    ]);
                } catch { /* timeout — continue with whatever resolved */ }
            }
            // Remove results without AllAnime ID (can't play them)
            const playable = results.filter(r => r.id);

            // Attach cover images for results missing covers
            try {
                const needsCover = playable.filter(r => !r.cover).slice(0, 15);
                if (needsCover.length > 0) {
                    const titles = needsCover.map(r => r.name);
                    const anilistData = await getAniListCovers(titles);
                    for (const r of needsCover) {
                        const info = anilistData[r.name];
                        r.cover = info?.cover || null;
                        r.description = info?.description || null;
                        r.title_english = r.title_english || info?.title_english || null;
                    }
                }
            } catch { /* non-critical */ }

            jsonResponse(res, 200, { results: playable, mode });
            return;
        }

        if (pathname === '/releases') {
            const date = query.date || '';
            const tz = parseInt(query.tz) || 0;
            try {
                const results = await getAiringSchedule(date, tz);
                jsonResponse(res, 200, { results, date: date || new Date().toISOString().slice(0, 10) });
            } catch (err) {
                jsonResponse(res, 500, { error: 'Failed to fetch airing schedule' });
            }
            return;
        }

        if (pathname === '/favorites' && req.method === 'GET') {
            const rawFavs = loadFavorites();
            const fn = (s) => (s || '').toLowerCase()
        // Fold unicode punctuation to ASCII FIRST. AniList writes "Journey’s End" with
        // U+2019 and AllAnime writes "Journey's End" with an ASCII quote; stripping only
        // the ASCII one left the two titles unequal, so the same show came back twice,
        // one copy grouped into its franchise and one orphaned next to it.
        .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[:\-\u2010\u2011\u2012\u2013\u2014\u2015.,'"!?()\uFF08\uFF09\u300C\u300D\u300E\u300F\/\\~\uFF5E\u30FB]/g, ' ')
        .replace(/\s+/g, ' ').trim();
            const patterns = FRANCHISE_PATTERNS.map(p => fn(p));
            // Helper: find matching pattern for a name (checks all name variants)
            function matchPattern(names) {
                for (const name of names) {
                    const n = fn(name);
                    const p = patterns.find(p => n.startsWith(p) || (p.length >= 6 && n.includes(p)));
                    if (p) return p;
                }
                return null;
            }
            // First pass: match ALL entries to patterns (using original name before rename)
            const favPat = rawFavs.map(f => matchPattern([f.name, f.title_english || '']));
            // Second pass: build pattern → existing franchise_id map
            const patToId = {};
            for (let i = 0; i < rawFavs.length; i++) {
                if (!rawFavs[i].franchise_id || !favPat[i]) continue;
                if (!patToId[favPat[i]]) patToId[favPat[i]] = rawFavs[i].franchise_id;
            }
            // Third pass: apply fixDisplayName + assign franchise_id
            const favs = rawFavs.map((f, i) => {
                const fixed = fixDisplayName(f);
                if (!fixed.franchise_id && favPat[i]) {
                    fixed.franchise_id = patToId[favPat[i]] || ('fav-' + favPat[i].replace(/\s+/g, '-'));
                }
                return fixed;
            });
            jsonResponse(res, 200, { favorites: favs });
            return;
        }

        if (pathname === '/favorites' && req.method === 'POST') {
            const item = safeJsonParse(await readBody(req));
            if (!item || !item.id || !item.name) {
                jsonResponse(res, 400, { error: 'Missing id or name' });
                return;
            }
            const favs = loadFavorites();
            if (!favs.some(f => f.id === item.id)) {
                const fav = { id: item.id, name: item.name, episodes: item.episodes || 0, added: new Date().toISOString() };
                if (item.title_english) fav.title_english = item.title_english;
                if (item.franchise_id) fav.franchise_id = item.franchise_id;
                if (item.cover) fav.cover = item.cover;
                favs.unshift(fav);
                saveFavorites(favs);
            }
            jsonResponse(res, 200, { status: 'added', favorites: favs });
            return;
        }

        if (pathname.startsWith('/favorites/') && req.method === 'DELETE') {
            const deleteId = pathname.split('/favorites/')[1];
            const favs = loadFavorites().filter(f => f.id !== deleteId);
            saveFavorites(favs);
            jsonResponse(res, 200, { status: 'removed', favorites: favs });
            return;
        }

        // Check favorites for new episodes aired in the last 7 days
        if (pathname === '/favorites/check' && req.method === 'GET') {
            const favs = loadFavorites();
            if (favs.length === 0) { jsonResponse(res, 200, { updates: [] }); return; }

            // Query AniList for all episodes aired in last 7 days
            const now = new Date();
            const weekAgo = Math.floor(now.getTime() / 1000) - (7 * 86400);
            const nowSec = Math.floor(now.getTime() / 1000);
            const allRecent = [];
            let page = 1, hasNext = true;
            const gql = `query ($page: Int, $gt: Int, $lt: Int) {
                Page(page: $page, perPage: 50) {
                    pageInfo { hasNextPage }
                    airingSchedules(airingAt_greater: $gt, airingAt_lesser: $lt, sort: [TIME]) {
                        episode airingAt media { id title { romaji english } }
                    }
                }
            }`;
            try {
                while (hasNext && page <= 20) {
                    const resp = await fetch('https://graphql.anilist.co', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify({ query: gql, variables: { page, gt: weekAgo, lt: nowSec } })
                    });
                    const json = await resp.json();
                    const pg = json?.data?.Page;
                    if (pg?.airingSchedules) allRecent.push(...pg.airingSchedules);
                    hasNext = pg?.pageInfo?.hasNextPage || false;
                    page++;
                }
            } catch { /* AniList down — return empty */ }

            // Normalize for matching
            const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const updates = [];
            for (const fav of favs) {
                const favNorm = norm(fav.name);
                const match = allRecent.find(s => {
                    const romaji = norm(s.media?.title?.romaji);
                    const english = norm(s.media?.title?.english);
                    return (romaji && romaji === favNorm) || (english && english === favNorm) ||
                           (romaji && (romaji.includes(favNorm) || favNorm.includes(romaji))) ||
                           (english && (english.includes(favNorm) || favNorm.includes(english)));
                });
                if (match) {
                    updates.push({ id: fav.id, name: fav.name });
                }
            }
            jsonResponse(res, 200, { updates });
            return;
        }

        if (pathname === '/download' && req.method === 'POST') {
            cleanDownloadQueue();
            const params = safeJsonParse(await readBody(req));
            if (!params || !params.anime_id || !params.episode) {
                jsonResponse(res, 400, { error: 'Missing anime_id or episode' });
                return;
            }

            const mode = params.sub_or_dub || params.mode || 'sub';
            const quality = params.quality || 'best';
            const dlId = `${params.anime_id}-${params.episode}-${Date.now()}`;

            // Get stream URL first (with fallback providers)
            const epUrl = await getEpisodeUrlWithFallbacks(
                params.anime_id, params.episode.toString(), mode, quality,
                params.title || '', params.title_english || ''
            );
            if (!epUrl) {
                jsonResponse(res, 404, { error: 'No streams available for download. Try again later.', retryable: true });
                return;
            }

            // Set up download tracking
            const safeTitle = (params.title || 'anime').replace(/[^a-zA-Z0-9\-_ ]/g, '').slice(0, 60);
            const ext = epUrl.url.includes('.m3u8') ? 'mp4' : 'mp4';
            const filename = `${safeTitle} - EP${params.episode} [${epUrl.resolution || quality}].${ext}`;
            const filePath = path.join(DOWNLOAD_DIR, filename);

            downloadQueue.set(dlId, {
                status: 'downloading',
                progress: 0,
                filename,
                filePath,
                error: null,
                startedAt: Date.now()
            });

            // Ensure output directory exists
            fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

            // Start async download
            (async () => {
                const dl = downloadQueue.get(dlId);
                try {
                    if (epUrl.url.includes('.m3u8')) {
                        // HLS → use ffmpeg to download
                        const ffmpeg = spawn('ffmpeg', [
                            '-i', epUrl.url,
                            '-c', 'copy',
                            '-bsf:a', 'aac_adtstoasc',
                            '-y', filePath
                        ], { stdio: ['ignore', 'pipe', 'pipe'] });

                        ffmpeg.stderr.on('data', (data) => {
                            const str = data.toString();
                            // Parse time= from ffmpeg output for progress
                            const timeMatch = str.match(/time=(\d+):(\d+):(\d+)/);
                            if (timeMatch) {
                                const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
                                dl.progress = Math.min(secs, 99); // rough progress
                            }
                        });

                        await new Promise((resolve, reject) => {
                            ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
                            ffmpeg.on('error', reject);
                        });

                        dl.status = 'complete';
                        dl.progress = 100;
                    } else {
                        // Direct MP4 download with progress
                        const resp = await fetch(epUrl.url, {
                            headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR },
                            signal: AbortSignal.timeout(300000) // 5 minute timeout
                        });
                        const totalSize = parseInt(resp.headers.get('content-length') || '0');
                        let downloaded = 0;

                        const writer = fs.createWriteStream(filePath);
                        const reader = resp.body.getReader();

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            writer.write(value);
                            downloaded += value.length;
                            if (totalSize > 0) {
                                dl.progress = Math.round((downloaded / totalSize) * 100);
                            }
                        }

                        writer.end();
                        await new Promise(resolve => writer.on('finish', resolve));
                        dl.status = 'complete';
                        dl.progress = 100;
                    }
                } catch (err) {
                    dl.status = 'error';
                    dl.error = err.message;
                }
            })();

            jsonResponse(res, 200, {
                status: 'download_started',
                download_id: dlId,
                filename
            });
            return;
        }

        if (pathname === '/download-status') {
            const dlId = query.id;
            if (!dlId || !downloadQueue.has(dlId)) {
                jsonResponse(res, 404, { error: 'Download not found' });
                return;
            }
            const dl = downloadQueue.get(dlId);
            jsonResponse(res, 200, {
                status: dl.status,
                progress: dl.progress,
                filename: dl.filename,
                error: dl.error
            });
            return;
        }

        // Proxy stream for CORS-restricted CDNs (required for in-app player)
        if (pathname === '/proxy-stream') {
            const streamUrl = query.url;
            if (!streamUrl) {
                jsonResponse(res, 400, { error: 'Missing url parameter' });
                return;
            }

            // SSRF protection: only allow known streaming CDN domains
            try {
                const proxyHost = new URL(streamUrl).hostname;
                const ALLOWED_PROXY_DOMAINS = [
                    'allanime.day', 'allanime.to', 'blog.allanime.pro',
                    'ep.allanime.pro', 'wb.allanime.pro',
                    'gogoanime.bid', 'anitaku.pe',
                    'cache.googlevideo.com',
                    'biananset.net', 'gofcdn.com', 'vrv.co', 'crunchyroll.com',
                    'sharepoint.com', 'dropbox.com',
                    'cdnfile.info', 'cdn.master-file.com',
                    'betterstream.cc', 'filemoon.sx',
                    'vidstreaming.io', 'vidplay.online',
                    // Fallback provider CDNs (AnimePahe/kwik, HiAnime)
                    'kwik.cx', 'kwik.si', 'owocdn.top',
                    'animepahe.si', 'animepahe.ru', 'animepahe.com',
                    'hianime.to', 'aniwatch.to',
                    'megacloud.tv', 'rapid-cloud.co',
                    'vidcloud9.com', 'vizcloud2.online',
                    // HiAnime.at chain, added 2026-10-05. Without these the only source that
                    // works is blocked by our OWN proxy: /play hands back a url the player
                    // then cannot fetch, which reads as "the stream is broken".
                    'hianime.at',        // the API host
                    'zokoanime.video',   // the embed, and the Referer its CDN demands
                    'dramahot.top',      // master + variant playlists and the subtitle vtt
                    'drama1.cfd'         // the segment CDN the variant points at
                ];
                const allowed = ALLOWED_PROXY_DOMAINS.some(d => proxyHost === d || proxyHost.endsWith('.' + d));
                if (!allowed) {
                    console.warn(`[ANI-MATE] Blocked proxy domain: ${proxyHost}`);
                    jsonResponse(res, 403, { error: 'Domain not allowed for proxy' });
                    return;
                }
            } catch {
                jsonResponse(res, 400, { error: 'Invalid URL' });
                return;
            }

            try {
                // THE REFERER IS PER-SOURCE AND WAS HARDCODED TO ALLANIME'S.
                // HiAnime.at's CDN (dramahot.top / drama1.cfd) 403s unless the referer is
                // https://zokoanime.video/. Sending allmanga.to to every host meant the only
                // working stream could not be proxied, which is what "it almost works but
                // nothing plays" actually was. /play returns the right one; pass it through.
                const refr = query.referer || ALLANIME_REFR;
                const streamResp = await fetch(streamUrl, {
                    headers: { 'User-Agent': AGENT, 'Referer': refr },
                    signal: AbortSignal.timeout(15000)
                });

                const contentType = streamResp.headers.get('content-type') || 'application/octet-stream';
                const isM3u8 = streamUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegURL');

                if (isM3u8) {
                    // Rewrite m3u8 manifest: make segment URLs absolute and route through proxy
                    let manifest = await streamResp.text();
                    const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

                    manifest = manifest.split('\n').map(line => {
                        line = line.trim();
                        if (line && !line.startsWith('#')) {
                            // This is a segment URL or sub-playlist
                            const absUrl = line.startsWith('http') ? line : baseUrl + line;
                            // Carry the referer down. The variant playlist and every segment
                            // are separate proxy calls, and each one is checked by the CDN.
                            return `/proxy-stream?url=${encodeURIComponent(absUrl)}`
                                 + (query.referer ? `&referer=${encodeURIComponent(query.referer)}` : '');
                        }
                        // Rewrite URI= in EXT-X-KEY and similar tags
                        if (line.includes('URI="')) {
                            line = line.replace(/URI="([^"]+)"/g, (match, uri) => {
                                const absUri = uri.startsWith('http') ? uri : baseUrl + uri;
                                return `URI="/proxy-stream?url=${encodeURIComponent(absUri)}`
                                     + (query.referer ? `&referer=${encodeURIComponent(query.referer)}` : '') + `"`;
                            });
                        }
                        return line;
                    }).join('\n');

                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Range'
                    });
                    res.end(manifest);
                } else {
                    // Binary stream (ts segments, mp4, etc.) — pipe through
                    const headers = {
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Range',
                        'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
                    };
                    if (streamResp.headers.get('content-length')) {
                        headers['Content-Length'] = streamResp.headers.get('content-length');
                    }
                    res.writeHead(streamResp.status, headers);

                    // Stream the body through
                    const reader = streamResp.body.getReader();
                    const pump = async () => {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) { res.end(); return; }
                            res.write(value);
                        }
                    };
                    pump().catch(() => res.end());
                }
            } catch (err) {
                jsonResponse(res, 502, { error: 'Stream proxy failed' });
            }
            return;
        }

        if (pathname === '/status') {
            jsonResponse(res, 200, {
                status: 'online',
                server: 'ANI-MATE',
                version: PKG_VERSION,
                port: PORT,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
            return;
        }

        // 404
        jsonResponse(res, 404, { error: 'Not found', path: pathname });

    } catch (err) {
        console.error(`[ANI-MATE] Error: ${err.message}`);
        jsonResponse(res, 500, { error: 'Internal server error' });
    }
});

// Fill the content index in the background on a fresh install, so a query that
// describes a show instead of naming it has a corpus to search from the first run.
// Delayed and fire-and-forget: it must never hold up the server coming online.
function seedIndexIfEmpty() {
    setTimeout(() => {
        try {
            if (SearchIndex.stats().entries >= 200) return;
            SearchIndex.seed(12, 50, () => {})
                .then(n => { if (n) console.log(`[ANI-MATE] content index seeded: ${n} entries`); })
                .catch(() => {});
        } catch { /* search still works on titles */ }
    }, 5000);
}

server.listen(PORT, () => {
    console.log(`[ANI-MATE] Server online at http://localhost:${PORT}`);
    console.log(`[ANI-MATE] UI available at http://localhost:${PORT}/`);
    console.log(`[ANI-MATE] API endpoints: /search, /episodes, /play, /history, /continue, /download, /status`);
    seedIndexIfEmpty();
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[ANI-MATE] Port ${PORT} already in use. Kill existing process or use a different port.`);
    } else {
        console.error(`[ANI-MATE] Server error: ${err.message}`);
    }
    process.exit(1);
});
