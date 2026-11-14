// YASA PRESENTS
// ani-mate-server.js - ANI-MATE Backend Server
// Anime streaming interface - REST API

const http = require('http');
const SearchIndex = require('./search-index');
const { spawn } = require('child_process');
const url = require('url');
const path = require('path');
const fs = require('fs');

/* @consumet/extensions used to be loaded here for AnimePahe and HiAnime. Neither has been
 * in the stream chain since 0.6.0 (animepahe.com is behind Cloudflare, api.consumet.org
 * answers 451), and the package brought axios, undici and adm-zip advisories with it.
 * It is gone, together with the axios adapter that existed only to route it through the
 * Electron bridge. The chain is in getEpisodeUrlWithFallbacks. */

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


/* The sync engine, required for its SHAPE helpers only: the record translation, the
 * apply loop and the sync keys. The desktop's favorites and history live in this
 * process, and the browser page cannot translate records it cannot read. Same functions
 * the phone calls in its WebView, so the two cannot disagree. */
const syncShape = require('./ani-mate-sync.js').shape;
/* How many questions AllAnime and AniList take, and who waits. Shared with the phone. */
const Budget = require('./ani-mate-budget.js');

/* In a packaged build this file runs from app.asar.unpacked/server/ and package.json is
 * inside app.asar, so the require below fails and /status said 0.4.0 forever. main.js
 * passes the real version in. */
const PKG_VERSION = process.env.ANI_MATE_VERSION
    || (() => { try { return require('../package.json').version; } catch { return 'unknown'; } })();
const PORT = parseInt(process.env.ANI_MATE_PORT) || 7890;
/* Exactly two modes exist. The value used to travel from the request into a RegExp in
 * the HiAnime provider as received; see modeOf in hianime-at.js for what that allowed. */
const modeOf = (m) => (m === 'dub' ? 'dub' : 'sub');
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
/* TEST HOOKS: where AllAnime and AniList are. The suites point these at stand-ins on
 * this machine, so a test can make AllAnime refuse, fail or answer, and never depends
 * on (or spends) the real services' request budgets. Same rule as ANI_MATE_TEST_STREAM
 * further down: main.js removes every ANI_MATE_TEST_ name from the packaged app's
 * server, so an installed copy cannot be pointed anywhere by its environment. */
const ALLANIME_API = process.env.ANI_MATE_TEST_ALLANIME || 'https://api.allanime.day/api';
const ANILIST_API = process.env.ANI_MATE_TEST_ANILIST || 'https://graphql.anilist.co';
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

/** A real episode total, or null. The page used to send '?' for a show opened from the
 *  history panel; it was stored, and CONTINUE then filtered the show out because no
 *  number is less than '?'. */
function wholeTotal(v) {
    const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v == null ? '' : v)) ? Number(v) : NaN);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
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
        // Update total episodes if provided, and repair one that was stored as text
        if (wholeTotal(entry.total_episodes)) rec.total_episodes = wholeTotal(entry.total_episodes);
        else rec.total_episodes = wholeTotal(rec.total_episodes);
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
            total_episodes: wholeTotal(entry.total_episodes),
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

/* ⚠ THIS THROWS. It used to swallow every write error, so adding a favorite, removing
 * one and applying a sync all answered "done" when nothing had reached the disk. The
 * request handler turns the throw into a 500, which is the truth. */
function saveFavorites(favs) {
    if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
    const tmp = FAVORITES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(favs, null, 2));
    fs.renameSync(tmp, FAVORITES_FILE);
}

/* ── FOR SYNC ONLY: a file that exists and cannot be read is an ERROR ──────────────
 * loadFavorites() and loadForgeHistory() answer [] when a file will not parse, which is
 * right for drawing a screen and wrong for sync: an empty list was pushed to the account
 * as "the user deleted everything". A missing file is still an honest empty list. */
function readListStrict(file) {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error(path.basename(file) + ' is not a list');
    return data;
}

/* ── THE DELETE JOURNAL ────────────────────────────────────────────────────────────
 * ⛔ A DELETE IS RECORDED WHEN THE USER MAKES ONE. The sync engine used to infer deletes
 * from absence ("it was here last sync and is not now"), and a history list capped at
 * 100 rows produces exactly that absence every time show 101 is watched. So the three
 * routes where a user removes something write the row's sync key here, the engine sends
 * tombstones from this file and nothing else, and clears each entry once it is pushed.
 * { favorites: { key: when }, watch: { key: when } } */
const DELETED_FILE = path.join(HIST_DIR, 'ani-mate-deleted.json');
const DELETED_KEEP = 2000;      // an install that never signs in must not grow this forever

function loadDeleted() {
    try {
        const j = JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8'));
        return { favorites: (j && j.favorites) || {}, watch: (j && j.watch) || {} };
    } catch { return { favorites: {}, watch: {} }; }
}

function saveDeleted(j) {
    for (const kind of ['favorites', 'watch']) {
        const keys = Object.keys(j[kind]);
        if (keys.length > DELETED_KEEP) {
            keys.sort((a, b) => j[kind][a] - j[kind][b]);
            for (const k of keys.slice(0, keys.length - DELETED_KEEP)) delete j[kind][k];
        }
    }
    fs.mkdirSync(HIST_DIR, { recursive: true });
    const tmp = DELETED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j));
    fs.renameSync(tmp, DELETED_FILE);
}

/** Call BEFORE removing the row: the key depends on the row still being in the list. */
function noteDeleted(kind, list, localIds) {
    const j = loadDeleted();
    const keys = syncShape.keyMap(kind, list);
    const now = Date.now();
    for (const id of localIds) j[kind][keys.get(String(id)) || String(id)] = now;
    saveDeleted(j);
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
    // genres/startDate/popularity are here for the rail's filters and the card facts.
    // Without them DAILY had no genre chips and no year, because the trending query
    // asked for a third of what /search already returns for the same shows.
    const gql = `query { Page(page: 1, perPage: 20) { media(type: ANIME, sort: [TRENDING_DESC]) { id title { romaji english } coverImage { large color } format episodes genres popularity startDate { year month day } seasonYear } } }`;
    const json = await anilistPost(gql, undefined, 5000);
    return (json?.data?.Page?.media || []).map(m => {
        const name = m.title?.romaji || m.title?.english || 'Unknown';
        const eps = m.episodes || 0;
        const type = eps === 1 ? 'movie' : eps <= 12 ? 'short' : 'series';
        return fixDisplayName({ id: null, name, title_english: m.title?.english || null, cover: m.coverImage?.large || null, cover_color: m.coverImage?.color || null, episodes: eps, type, anilist_id: m.id,
                                genres: m.genres || [], popularity: m.popularity || 0,
                                anilist_format: m.format || null,
                                start_key: dateKey(m.startDate, m.seasonYear) });
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
                    id title { romaji english } coverImage { large color } format episodes status genres popularity
                }
            }
        }
    }`;

    /* A page that was refused is not "no more pages". A day cut short that way used to
     * be remembered for five minutes as the whole day. */
    let complete = true;
    while (hasNext && page <= 10) {
        let json = null;
        try { json = await anilistPost(gql, { page, gt: dayStart, lt: dayEnd }, 8000); }
        catch (e) {
            if (!allSchedules.length) throw e;          // nothing at all: the route says so
            complete = false;
            break;
        }
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
        cover: s.media?.coverImage?.large,
        cover_color: s.media?.coverImage?.color || null,
        genres: s.media?.genres || [],
        popularity: s.media?.popularity || 0,
        anilist_format: s.media?.format || null,
        format: s.media?.format,
        totalEpisodes: s.media?.episodes
    }));

    if (complete) airingCache[cacheKey] = { data: results, at: Date.now() };
    return results;
}

/* ── ANILIST, ASKED POLITELY ───────────────────────────────────────────────────────
 * ⚠ 30 REQUESTS A MINUTE, for everything this address sends (read off the
 * x-ratelimit-limit header, 2026-11-12). The callers below fired without looking at the
 * status, so a refused request was parsed as "no data" and, for covers, cached that way
 * for five minutes. Four call sites still did that after the first fix of 2026-11-12
 * (the search, the trending row, a day's airing list, a show's description), and nothing
 * counted before sending: six ordinary searches in a row spent 28 of the 30.
 * The count, AniList's limits and the rules for who is asked are in ani-mate-budget.js. */
const aniListBudget = Budget.create(Budget.ANILIST, { patienceMs: 5000 });

/**
 * ONE DOOR. Every AniList request this server makes goes through here.
 *
 *   need 'user'    what someone is waiting on: a search, a show's description, a tab.
 *                  Asked unless the minute is used up; never waits more than 5 seconds.
 *   need 'spare'   covers and details for cards, the airing crawl, the content index.
 *                  Asked only while there is room to spare. Resolves NULL when it was
 *                  not asked: write nothing down for it, and ask on a later call.
 *
 * Resolves the parsed body. Throws when AniList refused or did not answer; a caller that
 * catches must not remember the throw as an empty answer.
 */
async function anilistPost(query, variables, timeoutMs = 8000, need = 'user') {
    return aniListBudget.ask('anilist', async () => {
        const resp = await fetch(ANILIST_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        /* AniList's own count includes what the page and the phone sent. */
        aniListBudget.note('anilist', {
            limit: parseInt(resp.headers.get('x-ratelimit-limit')) || 0,
            remaining: resp.headers.get('x-ratelimit-remaining') === null
                ? undefined : parseInt(resp.headers.get('x-ratelimit-remaining')),
        });
        if (resp.status === 429) {
            const wait = Math.min(300, Math.max(5, parseInt(resp.headers.get('retry-after') || '60') || 60));
            return { errors: [{ message: 'Too many requests, please try again in ' + wait + ' seconds.' }] };
        }
        if (!resp.ok) throw new Error('AniList answered HTTP ' + resp.status);
        return resp.json();
    }, { need });
}

/* The last complete crawl of the week's airing schedule, for /favorites/check. */
const recentAiring = { at: 0, rows: null };

// AniList cover image lookup with cache
const coverCache = {};
const COVER_CACHE_TTL = 60 * 60 * 1000; // 1 hour for successful lookups
const COVER_CACHE_FAIL_TTL = 5 * 60 * 1000; // 5 minutes for failed lookups

const ANILIST_DETAIL_BATCH = 25;

async function getAniListCovers(titles, maxLookups = Infinity) {
    // Filter to titles not already cached (use shorter TTL for failed lookups)
    const needed = titles.filter(t => {
        if (!coverCache[t]) return true;
        const ttl = coverCache[t].url ? COVER_CACHE_TTL : COVER_CACHE_FAIL_TTL;
        return (Date.now() - coverCache[t].at) > ttl;
    });
    if (needed.length === 0) {
        return titles.reduce((acc, t) => { acc[t] = { ...(coverCache[t] || {}), cover: coverCache[t]?.url || null, cover_color: coverCache[t]?.color || null }; return acc; }, {});
    }

    // Batch query AniList, 25 titles to a request (parameterized variables).
    //
    // It was 5 "to avoid rate limits", which did the opposite: AniList counts requests,
    // not titles, so a 25-row search spent five of its thirty a minute here. Measured
    // 2026-11-12: one request with 25 of these fragments answers in 0.3 s, HTTP 200, no
    // complexity error, and counts as one.
    // `maxLookups` bounds how many NEW titles one call may ask about; the rest are
    // answered from the cache if they are there and tried on a later call.
    const lookups = needed.slice(0, maxLookups);
    for (let i = 0; i < lookups.length; i += ANILIST_DETAIL_BATCH) {
        const batch = lookups.slice(i, i + ANILIST_DETAIL_BATCH);
        try {
            const varDefs = batch.map((_, idx) => `$s${idx}: String`).join(', ');
            const fragments = batch.map((_, idx) => {
                // id/format/startDate/popularity ride along on the request already
                // being made for covers. Tightening the pass-3 prefix match stopped
                // films inheriting the 1986 series' identity, which was right, but it
                // left anything AniList's paged search had not returned with NO match
                // at all — "Dragon Ball Super: Super Hero" came back format null, date
                // null. Searched on its own it resolves fine (MOVIE, 2022, id 133898),
                // so the data was always there; only the broad query missed it. This
                // is a targeted per-title lookup, batched 5 at a time and cached, so
                // it costs no extra round trip. Added 2026-10-12.
                return `q${idx}: Page(perPage: 1) { media(search: $s${idx}, type: ANIME) { id title { english romaji } coverImage { large color } description(asHtml: false) format startDate { year month day } seasonYear popularity genres } }`;
            }).join('\n');
            const variables = {};
            batch.forEach((title, idx) => { variables[`s${idx}`] = title; });

            const gql = `query (${varDefs}) { ${fragments} }`;
            const json = await anilistPost(gql, variables, 8000, 'spare');
            /* Not asked: AniList has no room to spare this minute. Nothing is written
             * down, so these titles are simply asked about on a later call. */
            if (json === null) break;
            /* An answer with no data block is an error body, not "these shows have no
             * cover". Do not write it into the cache as one. */
            if (!json || !json.data) throw new Error('AniList answered without data');

            batch.forEach((title, idx) => {
                const media = json?.data?.[`q${idx}`]?.media?.[0];
                const coverUrl = media?.coverImage?.large || null;
                const coverColor = media?.coverImage?.color || null;
                const desc = media?.description || null;
                const titleEnglish = media?.title?.english || null;
                coverCache[title] = { url: coverUrl, color: coverColor, description: desc, title_english: titleEnglish,
                                      title_romaji: media?.title?.romaji || null,
                                      /* answered: AniList was asked and replied, whether or
                                       * not it knew the show. A failed request never sets it. */
                                      answered: true,
                                      genres: media?.genres || [],
                                      anilist_id: media?.id || null,
                                      format: media?.format || null,
                                      start_key: media ? dateKey(media.startDate, media.seasonYear) : 0,
                                      popularity: media?.popularity || 0,
                                      at: Date.now() };
            });
        } catch (e) {
            /* A refusal is not "these shows have no cover", and the count already keeps
             * the next call from asking too soon. Only a real failure (no network, a
             * broken answer) is remembered, for five minutes, so it is not retried for
             * every card. */
            if (!(e && e.name === 'Refused')) {
                batch.forEach(title => {
                    if (!coverCache[title]) coverCache[title] = { url: null, at: Date.now() };
                });
            }
            /* Rate limited or unreachable: the remaining batches would fail the same
             * way and each one costs a request. */
            break;
        }
    }

    return titles.reduce((acc, t) => { acc[t] = { ...(coverCache[t] || {}), cover: coverCache[t]?.url || null, cover_color: coverCache[t]?.color || null }; return acc; }, {});
}

/* English name and cover for a list of names, for POST /favorites/refresh.
 *
 * ⛔ THAT ROUTE SENT ONE REQUEST PER NAME, IN A ROW, EVERY TIME IT WAS CALLED, and it is
 * called when the app starts. A name AniList has no English title for was asked about
 * again on every start. Thirty such names were the whole minute's allowance.
 * Now: 25 names to a request (measured 2026-11-12: HTTP 200, counted as one), each name
 * asked at most once an hour, and as a spare question.
 * Returns { name: [{ title_romaji, title_english, cover }, up to three] } for the names
 * AniList answered about this time. */
const titlesAsked = new Map();          // name -> when AniList last answered about it
async function anilistTitles(names) {
    const out = {};
    const fresh = names.filter((n) => !(titlesAsked.has(n) && Date.now() - titlesAsked.get(n) < 60 * 60 * 1000));
    for (let i = 0; i < fresh.length; i += ANILIST_DETAIL_BATCH) {
        const batch = fresh.slice(i, i + ANILIST_DETAIL_BATCH);
        const varDefs = batch.map((_, k) => `$s${k}: String`).join(', ');
        const body = batch.map((_, k) =>
            `q${k}: Page(perPage: 3) { media(search: $s${k}, type: ANIME) { title { english romaji } coverImage { large } } }`).join('\n');
        const variables = {};
        batch.forEach((n, k) => { variables[`s${k}`] = n; });
        let json = null;
        try { json = await anilistPost(`query (${varDefs}) { ${body} }`, variables, 8000, 'spare'); }
        catch (e) { break; }
        if (!json || !json.data) break;
        batch.forEach((n, k) => {
            titlesAsked.set(n, Date.now());
            out[n] = ((json.data[`q${k}`] || {}).media || []).map((md) => ({
                title_romaji: md.title?.romaji || null,
                title_english: md.title?.english || null,
                cover: md.coverImage?.large || null,
            }));
        });
    }
    return out;
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
        const gql = `query ($search: String) { Page(perPage: 3) { media(search: $search, type: ANIME) { description(asHtml: false) coverImage { extraLarge large color } bannerImage genres averageScore isAdult title { romaji english } } } }`;
        const json = await anilistPost(gql, { search: searchTitle }, 5000);
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
            const result = { description: media.description, cover: media.coverImage?.extraLarge || media.coverImage?.large || null, cover_color: media.coverImage?.color || null, banner: media.bannerImage || null, genres: (media.genres || []).filter(g => media.isAdult || g !== 'Hentai'), score: media.averageScore, source: 'anilist', at: Date.now() };
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
// Story arcs for long-running series, keyed by AniList id. See server/arcs.json.
// Neither AllAnime nor AniList exposes arcs, so a 131-episode series renders as one
// undivided grid with no way to find a saga. Validated on load: ranges must be
// contiguous from 1 and must end at the episode count, or the entry is dropped —
// a wrong boundary is worse than no boundary. Added 2026-10-12.
const ARCS = (() => {
    try {
        const raw = JSON.parse(require('fs').readFileSync(
            require('path').join(__dirname, 'arcs.json'), 'utf8'));
        const ok = {};
        for (const [id, v] of Object.entries(raw)) {
            if (id.startsWith('_') || !v || !Array.isArray(v.arcs) || !v.arcs.length) continue;
            const a = v.arcs;
            let contiguous = a[0].from === 1;
            for (let i = 0; i < a.length - 1; i++) {
                if (a[i + 1].from !== a[i].to + 1) contiguous = false;
            }
            if (!contiguous || a[a.length - 1].to !== v.episodes) {
                console.warn(`[ANI-MATE] arcs.json: ${v.title || id} has non-contiguous or short ranges, ignored`);
                continue;
            }
            ok[id] = v;
        }
        return ok;
    } catch (e) {
        console.warn('[ANI-MATE] arcs.json not loaded:', e.message);
        return {};
    }
})();

/* The named franchises live in the shared module, the same file this server hands to
 * the page and the phone ships. This list used to be written out here and again in
 * mobile/www/js/ani-mate-api.js, under a comment that said KEEP IN STEP. */
const FRANCHISE_PATTERNS = require('./ani-mate-franchise.js').PATTERNS;

/* ── ALLANIME KEEPS A COUNT, SO THIS DOES TOO ───────────────────────────────────────
 * AllAnime takes ten searches and six episode lists in ten seconds, and one search here
 * used to spend nine. The count, the measurements behind it and the rules for who waits
 * and who is skipped are in server/ani-mate-budget.js, which the phone loads too. Every
 * search and every episode list goes through allAnimeAsk(). */
const allAnimeBudget = Budget.create(Budget.ALLANIME);
/* What AllAnime answered to a search, for five minutes: searching for a show, opening
 * it and opening its next season ask for the same titles again and again. */
const allAnimeSearches = Budget.memo({ ttlMs: 5 * 60 * 1000, emptyTtlMs: 2 * 60 * 1000, keep: 400 });

/**
 * One question to AllAnime. `opts.need` is 'user' (waits for room) or 'spare' (asked only
 * while there is room to spare; resolves null when it was not asked).
 * Resolves the parsed answer. Throws when there was none.
 */
function allAnimeAsk(kind, variables, query, opts) {
    return allAnimeBudget.ask(kind, async () => {
        const response = await afetch(ALLANIME_API, {
            method: 'POST',
            headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables, query }),
            signal: AbortSignal.timeout(8000)
        });
        const text = await response.text();
        try { return JSON.parse(text); } catch { throw new Error('AllAnime returned non-JSON'); }
    }, opts);
}

// Direct API calls to AllAnime (same as ani-cli but from Node)
/**
 * @param {string} query
 * @param {string} [mode]
 * @param {boolean} [allowAdult]
 * @param {{ need?: string, catalogOnly?: boolean }} [opts]
 *   need 'spare'        see allAnimeAsk. An empty list when it was not asked.
 *   catalogOnly true    AllAnime or nothing. For a lookup whose whole purpose is the
 *                       AllAnime row of a title already known. Another source's row
 *                       for that title, under another id and another name, is the same
 *                       show a second time: on 2026-11-12 a lookup that AllAnime refused
 *                       brought back "The Apothecary Diaries Season 3" from HiAnime next
 *                       to AllAnime's "Kusuriya no Hitorigoto 3rd Season".
 */
async function searchAnime(query, mode = 'sub', allowAdult = false, opts = {}) {
    const searchGql = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } } }`;

    const variables = {
        search: { allowAdult, allowUnknown: false, query },
        limit: 40,
        page: 1,
        translationType: mode,
        countryOrigin: 'ALL'
    };

    /* ⚠ ALLANIME FAILING IS NOT THE SAME AS ALLANIME HAVING NOTHING, AND NEITHER IS
     * ALLANIME REFUSING. A non-JSON answer (a Cloudflare page, an outage) used to throw,
     * the route turned the throw into an empty list, and search showed nothing while
     * HiAnime, which is what actually plays, was up. It has gone dark before: 2026-08-20
     * and 2026-10-05. A refusal used to parse and read as an empty result. Only an
     * answer that carries a result list is an answer, and only that is remembered. */
    const cacheKey = mode + '|' + (allowAdult ? 1 : 0) + '|' + String(query).trim().toLowerCase();
    let results = allAnimeSearches.recall(cacheKey);
    if (results === null) {
        results = [];
        try {
            const data = await allAnimeAsk('shows', variables, searchGql,
                                           { need: opts.need === 'spare' ? 'spare' : 'user' });
            if (data === null) return [];               // a spare lookup that was not asked
            const edges = data && data.data && data.data.shows && data.data.shows.edges;
            if (!Array.isArray(edges)) throw new Error('AllAnime answered without a result list');
            for (const show of edges) {
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
            // Sort: series first (by ep count desc), then shorts, then movies
            results.sort((a, b) => b.episodes - a.episodes);
            allAnimeSearches.remember(cacheKey, results);
        } catch (e) {
            console.error('[search] AllAnime did not answer (' + e.message + ')'
                          + (opts.catalogOnly ? '' : '; asking HiAnime'));
        }
    }
    if (results.length || opts.catalogOnly) return results;

    /* Nothing from AllAnime: ask the source that serves the video. Its listings carry
     * no episode count (0 here), and the id is its own slug, which the episode and play
     * routes resolve by title. */
    {
        const ha = getHiAnimeAt();
        if (ha) {
            try {
                const hits = (await ha.search(query))
                    .filter(h => allowAdult || !/\b(hentai|uncensored)\b/i.test(h.name || ''));
                if (hits.length) {
                    return hits.slice(0, 40).map(h => ({
                        id: h.id, name: h.name, episodes: 0, type: 'series', provider: 'HiAnime'
                    }));
                }
            } catch (e) {
                console.error('[hianime.at] search failed:', e.message);
            }
        }
    }

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
                    id title { english romaji } coverImage { large color }
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
        const json = await anilistPost(gql, { search: query, perPage: limit }, 5000);
        return (json?.data?.Page?.media || []).map(m => ({
            anilist_id: m.id,
            title_english: m.title?.english || null,
            title_romaji: m.title?.romaji || null,
            cover: m.coverImage?.large || null,
            cover_color: m.coverImage?.color || null,
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

/* ── WHEN ALLANIME HAS NEVER HEARD OF THE SHOW. Added 2026-11-07. ────────────────
 * AllAnime's catalog and AniList's are not the same catalog, and search merges
 * both. A show AniList knows and AllAnime does not comes back with an id that this
 * query answers `show: null` for, so the episode list is EMPTY, the grid renders
 * "No episodes available", and there is nothing on screen to click. From outside it
 * looks exactly like the title does not stream.
 *
 * Measured 2026-11-07:
 *     Black Clover  id kibfyvtiFpKCGGoSD  -> 171 episodes   (in AllAnime)
 *     Overflow      id PwqFKA4oYhY6TMEA6  ->   0 episodes   (AniList only)
 * And yet /play resolved Overflow to a working m3u8, because PLAY goes by TITLE
 * through hianime while the EPISODE LIST went by id through AllAnime. The stream was
 * always there; the list of things to click was not.
 *
 * This hits adult titles hardest -- almost none are in AllAnime's catalog -- which
 * is why the 18+ toggle looked like it returned shows that refuse to play. Probed on
 * 2026-11-07: hianime carries 11 of 11 sampled adult titles, several with a separate
 * (Uncensored) listing. The source was never missing.
 */
async function getEpisodeList(showId, mode = 'sub', title = '', opts = {}) {
    /* Test hook, see TEST_STREAM: one named show has a canned episode list. */
    if (TEST_STREAM && TEST_STREAM.show_id && String(showId) === String(TEST_STREAM.show_id)
        && Array.isArray(TEST_STREAM.episodes)) {
        return TEST_STREAM.episodes.map(String);
    }
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

    /* Only ask AllAnime about ids that can be AllAnime's. A row that came from the phone
     * through sync carries a HiAnime slug or `al:<n>`, and sending those was a wasted
     * request that could only miss. And when AllAnime does not answer, that is not the
     * end: this used to throw before the HiAnime fallback below was ever reached. */
    let data = null;
    if (/^[A-Za-z0-9]{8,32}$/.test(String(showId))) {
        try {
            /* Through the counted door: AllAnime takes six of these in ten seconds, and
             * a refusal used to read as "this show has no episodes". */
            data = await allAnimeAsk('show', variables, gql, { need: 'user' });
        } catch (e) {
            console.error('[episodes] AllAnime did not answer (' + e.message + '); asking HiAnime');
            if (!title) throw e;        // nothing else to ask with
        }
    }

    let episodes = [];
    try {
        const detail = data?.data?.show?.availableEpisodesDetail;
        if (detail && detail[mode]) {
            episodes = detail[mode].sort((a, b) => parseFloat(a) - parseFloat(b));
        }
    } catch { /* ignore */ }

    // Nothing from AllAnime: ask the source that is actually going to serve the video.
    if (!episodes.length && title) {
        episodes = await hianimeEpisodeList(title, mode, opts);
        if (episodes.length) {
            console.error(`[episodes] AllAnime has no "${title}"; hianime lists ` +
                          `${episodes.length} episodes`);
        }
    }
    return episodes;
}

/** Episode numbers for a title straight from hianime, used when AllAnime has no row. */
async function hianimeEpisodeList(title, mode = 'sub', opts = {}) {
    const ha = getHiAnimeAt();
    if (!ha) return [];
    try {
        const hits = await ha.search(title);
        if (!hits.length) return [];
        /* Same identity rule the stream chain uses, so the episode COUNT shown cannot
         * come from a different entry than the one that will play. */
        const { acceptableTier } = require('./title-match');
        const tier = acceptableTier(hits, title, opts);
        const pick = (tier.length ? tier : hits)[0];
        const eps = await ha.episodes(pick.id);
        return eps.map((e) => String(e.number));
    } catch (e) {
        console.error('[episodes] hianime fallback failed:', e.message);
        return [];
    }
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

/* ⚠ DORMANT SINCE 2026-11-07. NOTHING CALLS THIS. AllAnime's extraction still works as
 * written; its HOST does not. api.allanime.day answers 403 and allanime.day is a 50-hop
 * redirect loop, so the step that called this was removed from getEpisodeUrlWithFallbacks
 * rather than left to spend the user's first click on a timeout.
 * Kept, not deleted, because the recipe is correct and hosts come back. If it is ever
 * re-enabled, PROBE THE HOST FIRST -- that is the whole lesson of the 0.6.0 survey. */
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
/* ⚠ DORMANT SINCE 2026-11-07, with getFallbackStreamUrl below it. Both existed to drive
 * consumet's AnimePahe and HiAnime adapters, and api.consumet.org now returns HTTP 451 while
 * animepahe.com returns 403 Cloudflare. Unreachable, kept for the same reason as above. */
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
/* ⚠ THE CHAIN RETURNS ONE OBJECT: { url, source, referer, subtitles, malId, subsQuality,
 * subsCues, subsOrigin }, or null. It used to return a bare URL and leave the rest in two
 * module-level variables (lastStreamSource, lastStreamMeta). Two things followed:
 *   - /download read `.url` off the string and answered 500 for every episode, in every
 *     release from 0.6.0 on. /play had been patched for this; /download had not.
 *   - two requests resolving at the same time shared those variables, so one could be
 *     answered with the other's referer and subtitles. */

function getHiAnimeAt() {
    if (!hianimeAt) {
        try { hianimeAt = require('./hianime-at').makeProvider(afetch); }
        catch (e) { console.error('[hianime.at] load failed:', e.message); hianimeAt = null; }
    }
    return hianimeAt;
}

let gogoanime = null;
function getGogoanime() {
    if (!gogoanime) {
        try { gogoanime = require('./gogoanime-by').makeProvider(afetch); }
        catch (e) { console.error('[gogoanime.by] load failed:', e.message); gogoanime = null; }
    }
    return gogoanime;
}

/* ── THE SUBTITLE CHAIN, SEPARATE FROM THE STREAM CHAIN. Added 2026-11-07 for v0.6.0. ─────
 *
 * The 2026-11-07 provider survey settled a question that had been answered wrong for a month:
 * adding stream providers cannot fix missing subtitles, because the providers share backends.
 * hianime.at, AniLight and gogoanime.by all resolve to ZokoAnime or megaplay, so "try another
 * source" reads the same file. An episode published without a script track has none on any of
 * them, and no amount of failover changes that.
 *
 * What fixes it is asking somewhere that is not a streaming site at all. See
 * subs-external.js for the chain and subs-opensubtitles.js for the measurements.
 */
let subsChain = null;
let episodeMap = null;
function getSubsChain() {
    if (!subsChain) {
        try {
            subsChain = require('./subs-external').makeChain(afetch, HIST_DIR);
            episodeMap = require('./episode-map');
            console.error(`[subs] external chain ready: ${subsChain.providers.join(' -> ')}`);
        } catch (e) {
            console.error('[subs] external chain load failed:', e.message);
            subsChain = null;
        }
    }
    return subsChain;
}

/**
 * Pool external subtitles onto a stream whose own tracks are not readable.
 *
 * ONLY WHEN THERE IS NOTHING TO READ. An external file is a judgment call: it is grafted
 * from a different authoring onto this encode. When hianime already has a dialogue track that
 * track is correct by construction and nothing should displace it.
 *
 * ⛔ AND ONLY WHEN THE EPISODE NUMBER CAN BE DERIVED. episode-map returns null rather than
 * guessing, and that null is honored here. The wrong episode's subtitles spoil the show;
 * no subtitles is a disappointment. These are not the same cost, so they do not get the
 * same benefit of the doubt.
 */
async function addExternalSubtitles(st, title, episodeNumber) {
    if (!st || st.subsQuality === 'dialogue') return st;
    const chain = getSubsChain();
    if (!chain || !episodeMap) return st;

    const ha = getHiAnimeAt();
    if (!ha || !st.allListings || !st.listing) return st;

    let counts = [];
    try { counts = await ha.listingCounts(st.allListings); }
    catch (e) { console.error('[subs] listing counts failed:', e.message); return st; }

    const map = episodeMap.resolve({
        listings: counts, chosen: st.listing, episode: episodeNumber,
    });
    if (!map) {
        console.error(`[subs] cannot derive an absolute episode number for ` +
                      `"${st.listing}" ep ${episodeNumber}; not grafting. ` +
                      `Saw listings: ${counts.map((c) => `${c.name}(${c.count})`).join(', ') || 'none'}`);
        return st;
    }
    console.error(`[subs] ${title}: hianime track is ${st.subsQuality} (${st.subsCues} cues). ` +
                  `Looking up ${map.franchise} S${map.season}E${map.episode} -- ${map.derivedFrom}`);

    /* The episode's real length, read off the playlist we are about to play. This is the
     * only identity test a subtitle file has: see probeDuration in subs-external.js for the
     * live-action Cowboy Bebop that matched by name, season and episode and ran 47 minutes. */
    let durationSec = 0;
    try { durationSec = await chain.probeDuration(st.url, st.referer); }
    catch (e) { console.error('[subs] duration probe failed:', e.message); }

    let found = [];
    try { found = await chain.find(map, { durationSec }); }
    catch (e) { console.error('[subs] chain failed:', e.message); return st; }
    if (!found.length) return st;

    /* APPENDED LAST, DELIBERATELY. The UI's ranker breaks score ties by keeping the EARLIER
     * entry, so putting an external file first would let it beat a track that came from the
     * episode's own servers. It must not: a track from this episode is correct by
     * construction, and an external one is a derived guess that has already been measured
     * getting an episode wrong. See the note on entry() in subs-external.js. */
    st.subtitles = (st.subtitles || []).concat(found);
    st.subsQuality = 'external';
    st.subsCues = found[0].cues;
    st.subsOrigin = found[0].origin;
    return st;
}

/* The stream chain, in the order getEpisodeUrlWithFallbacks actually walks it. Kept beside
 * the walk so a /play failure can name what was tried without a second list going stale. */
const STREAM_CHAIN = ['HiAnime.at', 'AniDB', 'Gogoanime.by', 'AniDB (title match)'];

/* ── TEST HOOK ────────────────────────────────────────────────────────────────────────
 * The test suites set ANI_MATE_TEST_STREAM to a small JSON object and the stream chain
 * answers with it instead of asking any source:
 *
 *     { url, referer, subtitles }      what /play and /download resolve to, for any show
 *     { show_id, episodes }            and the episode list of that ONE show id
 *
 * That is the only way /play, /download and the player itself can be driven with no
 * network; /download answered 500 in every release from 0.6.0 to 0.7.1 because nothing
 * drove it. Set by tests/server-net.test.js and scripts/test-dom.js and by nothing
 * else: main.js takes every ANI_MATE_TEST_ and ANI_MATE_PROXY_TEST_ variable out of the
 * environment it starts this process with. */
const TEST_STREAM = (() => {
    try { return process.env.ANI_MATE_TEST_STREAM ? JSON.parse(process.env.ANI_MATE_TEST_STREAM) : null; }
    catch (e) { return null; }
})();

async function getEpisodeUrlWithFallbacks(showId, episodeString, mode, quality, title, titleEnglish,
                                          opts = {}) {
    if (TEST_STREAM && TEST_STREAM.url) {
        return { url: String(TEST_STREAM.url), source: 'test', referer: TEST_STREAM.referer || null,
                 subtitles: Array.isArray(TEST_STREAM.subtitles) ? TEST_STREAM.subtitles : [],
                 malId: null, subsQuality: null, subsCues: null, subsOrigin: null };
    }
    // 0a. HIANIME.AT FIRST. It is the only source measured working on 2026-10-05, and putting
    // a dead source ahead of it just spends the user's first click on a timeout.
    {
        const ha = getHiAnimeAt();
        if (ha) {
            for (const t of [title, titleEnglish].filter(Boolean)) {
                try {
                    let st = await ha.streamByTitle(t, episodeString, mode, opts);
                    if (st && st.url) {
                        // Subtitles are a SEPARATE question from the stream. Only runs when
                        // this episode's own tracks turned out to be signs-only or absent.
                        st = await addExternalSubtitles(st, t, episodeString);
                        return {
                            url: st.url, source: 'HiAnime.at',
                            referer: st.referer || null, subtitles: st.subtitles || [],
                            malId: st.malId || null, subsQuality: st.subsQuality || null,
                            subsCues: st.subsCues || null, subsOrigin: st.subsOrigin || null,
                        };
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
                    /* The referer travels with the url now. It used to be dropped, so
                     * /play answered referer: null for a source whose CDN demands one. */
                    if (st) {
                        return { url: st.url, source: 'AniDB', referer: st.referer || null,
                                 subtitles: [], malId: null, subsQuality: null, subsCues: null,
                                 subsOrigin: null };
                    }
                }
            } catch (e) {
                console.error('[anidb] stream failed:', e.message);
            }
        }
        return null;
    }

    /* ── 1. GOGOANIME.BY. The only backup measured to be a DIFFERENT BACKEND. ─────────
     *
     * Three steps used to sit here -- AllAnime, then AnimePahe, then HiAnime-via-consumet --
     * and on 2026-11-07 every one of them was probed and every one is gone:
     *     allanime.day .......... 301 redirect loop, 50 hops
     *     api.allanime.day ...... 403
     *     animepahe.com ......... 403 Cloudflare
     *     api.consumet.org ...... 451, legally blocked
     * They cost three timeouts on the user's first click and implied a safety net that was
     * not there. ani-py deleted its own dead providers for exactly this reason:
     *     "a provider that cannot resolve costs failover time and implies a safety net
     *      that is not there."
     *
     * What replaces them answers from Google's own video hosting rather than from ZokoAnime
     * or megaplay, so it is real redundancy and not another door into the same room. Its
     * catalog is thin -- a search for "Beastars" returns only Part 2, and "Cowboy Bebop"
     * returns nothing -- so it is a backup and not a primary. It does cover the episode this
     * release was written for, and its encodes are HARDSUBBED, which means an episode that
     * hianime publishes with no script track still plays with words on screen.
     */
    {
        const gg = getGogoanime();
        if (gg) {
            for (const t of [title, titleEnglish].filter(Boolean)) {
                try {
                    const st = await gg.streamByTitle(t, episodeString, opts);
                    if (st && st.url) {
                        return {
                            url: st.url, source: 'Gogoanime.by',
                            referer: st.referer || null, subtitles: [], malId: null,
                            subsQuality: 'hardsub', subsCues: 0, subsOrigin: null,
                        };
                    }
                } catch (e) { console.error('[gogoanime.by]', e.message); }
            }
        }
    }

    // 2. Last resort: match the title on AniDB. Reached when a show was found via AllAnime
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
                if (st) {
                    return { url: st.url, source: 'AniDB (title match)', referer: st.referer || null,
                             subtitles: [], malId: null, subsQuality: null, subsCues: null,
                             subsOrigin: null };
                }
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
            const total = wholeTotal(h.total_episodes);
            if (!total) return true; // unknown total (or one stored as '?') = always show
            const watched = Array.isArray(h.episodes_watched) ? h.episodes_watched.length : 1;
            return watched < total;
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
                total_episodes: wholeTotal(h.total_episodes),
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
/* ⚠ NO CORS HEADERS, ANYWHERE IN THIS FILE. They used to be `*` on every answer. The page
 * is served from this same origin and never needed them; what they did was let any web
 * page the user had open read the library and the watch history through the browser.
 *
 * ⚠ AND IT NEVER WRITES HEADERS TWICE. A route that has already started its answer and
 * then fails lands here from a catch block. writeHead would throw, the outer catch would
 * call this again, that would throw too, and the unhandled rejection ended the process. */
function jsonResponse(res, statusCode, data) {
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(data));
}

function serveStatic(res, filePath, contentType) {
    try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            // NO-STORE ON THE UI, AND IT IS NOT AN OPTIMIZATION QUESTION. ADDED 2026-10-17.
            //
            // This handler sent no Cache-Control, no ETag and no Last-Modified. With none of
            // the three, Chromium falls back to HEURISTIC caching: it may reuse a cached
            // response without revalidating, and its disk cache survives an app restart. So
            // an edited ani-mate-ui.html could sit on disk, correct, while the Electron window
            // kept rendering the previous build — a fix that looks like it did nothing, with
            // no way to tell from the outside.
            //
            // Measured: `curl -I http://localhost:7890/` returned Content-Type, CORS, Date,
            // Connection and Keep-Alive. Nothing else. There was no cache directive at all.
            //
            // The server is localhost and the whole UI is ~700 KB, so there is no bandwidth
            // argument for caching it. Correctness wins outright.
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(content);
    } catch {
        jsonResponse(res, 404, { error: 'File not found' });
    }
}

/* ── WHO MAY ASK ───────────────────────────────────────────────────────────────────
 * This server holds one person's library and can start downloads. It answers its own
 * page and nothing else:
 *   Host        must be this machine by a loopback name. A DNS name someone pointed at
 *               127.0.0.1 arrives with THEIR name in Host and is refused.
 *   Origin      if the browser sent one, it must be this server's own.
 *   Sec-Fetch-Site  browsers label every request. `cross-site` and `same-site` (another
 *               port on localhost counts as the same SITE) are refused; this covers an
 *               <img> or a form on another page, which send no Origin on a GET.
 * A request with none of those headers is a local program (curl, the test suites), which
 * could read the files directly anyway. */
function requestAllowed(req) {
    const own = ['localhost:' + PORT, '127.0.0.1:' + PORT, '[::1]:' + PORT];
    const host = String(req.headers.host || '').toLowerCase();
    if (own.indexOf(host) < 0) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && own.map(h => 'http://' + h).indexOf(String(origin).toLowerCase()) < 0) return false;
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site' || site === 'same-site') return false;
    return true;
}

/* ── THE STREAM PROXY'S RULES ──────────────────────────────────────────────────────
 * The page cannot set a Referer, and the CDNs refuse a request without the right one, so
 * video and subtitles are fetched here and handed on. That makes this an HTTP client
 * anyone who can reach the server can aim, so:
 *   - only these hosts, and only http(s)
 *   - EVERY redirect hop is checked against the same list. The first version checked the
 *     first URL and then let fetch follow redirects wherever they led.
 *   - sharepoint.com and dropbox.com were on the list from the AllAnime era. Anyone can
 *     put a file on either, so they are gone.
 *   - nothing that a browser would run is ever answered from this origin (see safeType). */
const ALLOWED_PROXY_DOMAINS = [
    'allanime.day', 'allanime.to', 'blog.allanime.pro',
    'ep.allanime.pro', 'wb.allanime.pro',
    'gogoanime.bid', 'anitaku.pe',
    /* Gogoanime.by resolves to Blogger-hosted files on rr<N>---sn-<id>.googlevideo.com, a
     * different host every request, so the bare domain covers every edge node. */
    'googlevideo.com',
    'biananset.net', 'gofcdn.com', 'vrv.co', 'crunchyroll.com',
    'cdnfile.info', 'cdn.master-file.com',
    'betterstream.cc', 'filemoon.sx',
    'vidstreaming.io', 'vidplay.online',
    'kwik.cx', 'kwik.si', 'owocdn.top',
    'animepahe.si', 'animepahe.ru', 'animepahe.com',
    'hianime.to', 'aniwatch.to',
    'megacloud.tv', 'rapid-cloud.co',
    'vidcloud9.com', 'vizcloud2.online',
    // HiAnime.at chain: the API host, the embed (and the Referer its CDN demands), the
    // playlists and subtitle vtt, and the segment CDN the variant points at.
    'hianime.at', 'zokoanime.video', 'dramahot.top', 'drama1.cfd',
    // HD-1 / megaplay: the embed, and where its subtitle vtt files live.
    'megaplay.buzz', 'mysubsplay.com',
    // AniDB. Its streams were in the chain and could not be played: the proxy refused
    // its own source.
    'anidb.app',
];

/* FOR THE TEST SUITE ONLY: exact host:port pairs that stand in for a CDN, so the rules
 * above (redirect hops, Range, an empty body, the content type) can be exercised against
 * a stub on this machine instead of against somebody's video host. Unset in every real
 * launch; tests/server-net.test.js sets it for the server it starts. */
const PROXY_TEST_HOSTS = String(process.env.ANI_MATE_PROXY_TEST_HOSTS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

function proxyAllowed(u) {
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
    const host = String(u.hostname || '').toLowerCase();
    if (PROXY_TEST_HOSTS.length && PROXY_TEST_HOSTS.indexOf(host + ':' + (u.port || '')) >= 0) return true;
    return ALLOWED_PROXY_DOMAINS.some(d => host === d || host.endsWith('.' + d));
}

/* A page, a script or an SVG served from this origin would run WITH this origin: the
 * local API and, once sync is on, the device token. Media and playlists only. */
function safeType(contentType) {
    const t = String(contentType || '').toLowerCase();
    if (/html|javascript|ecmascript|svg|xml/.test(t)) return 'application/octet-stream';
    return contentType || 'application/octet-stream';
}

const PROXY_FIRST_BYTE_MS = 15000;      // the CDN must START answering within this
const PROXY_IDLE_MS = 30000;            // and must not go silent for longer than this
const PROXY_MAX_HOPS = 5;

const handleRequest = async (req, res) => {
    if (!requestAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
        res.end('{"error":"forbidden"}');
        return;
    }
    // No route here answers a preflight with permission, which is the point.
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    /* url.parse throws on some malformed targets, and it used to sit outside the try:
     * one bad request line was an unhandled rejection. */
    let parsedUrl;
    try { parsedUrl = url.parse(req.url, true); }
    catch { jsonResponse(res, 400, { error: 'Bad request' }); return; }
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

        /* THE SYNC ENGINE, served from server/ so there is exactly one copy of it.
         * The phone needs a real file inside the APK and has its own; this is the
         * desktop half of that arrangement, and `npm run sync:shared` keeps them
         * identical. See the header of ani-mate-sync.js for why one copy matters. */
        /* One line of config, so the page never has to guess the backend and a dev can
         * point a whole desktop install at a local worker with an env var. */
        if (pathname === '/sync/config.js') {
            const edge = process.env.ANI_MATE_EDGE || '';
            res.writeHead(200, { 'Content-Type': 'application/javascript',
                                 'Cache-Control': 'no-store' });
            res.end(edge ? 'window.ANI_MATE_EDGE=' + JSON.stringify(edge) + ';' : '');
            return;
        }

        if (pathname === '/ani-mate-sync.js') {
            serveStatic(res, path.join(__dirname, 'ani-mate-sync.js'), 'application/javascript');
            return;
        }

        /* FRANCHISE IDENTITY, the same one-copy arrangement as the sync engine above.
         * It decides what a franchise is, which season a row is, and what the season
         * strip shows — and it used to exist three times (here in the page, again in
         * mobile/www/js/ani-mate-ui.js, and as a Python port in the test harness), all
         * three keyed on a franchise_id that most rows do not have. */
        if (pathname === '/ani-mate-franchise.js') {
            serveStatic(res, path.join(__dirname, 'ani-mate-franchise.js'), 'application/javascript');
            return;
        }

        /* ── SYNC: THE LOCAL SIDE ──────────────────────────────────────────────────
         * The engine runs in the browser page but the desktop's data lives HERE, in
         * two JSON files this process owns. So the page cannot read or write it
         * directly; these two routes are the adapter's hands.
         *
         * ⚠ THE SHAPES ARE NOT THE SAME AND THE TRANSLATION BELONGS HERE. The sync
         * schema says {anime_id, title, position}; the desktop files say
         * {id, name, playback_time}. Doing this mapping in the page would mean doing
         * it again, differently, on the phone. */
        if (pathname === '/sync/local' && req.method === 'GET') {
            jsonResponse(res, 200, {
                favorites: syncShape.favoritesOut(readListStrict(FAVORITES_FILE)),
                watch: syncShape.watchOut(readListStrict(FORGE_HIST_FILE)),
                deleted: loadDeleted(),
            });
            return;
        }

        if (pathname === '/sync/local' && req.method === 'POST') {
            const payload = safeJsonParse(await readBody(req)) || {};
            const applied = { favorites: 0, watch: 0 };

            /* ⛔ MERGE ON WRITE, NEVER WRITE A SNAPSHOT THE CALLER BROUGHT. Re-read,
             * apply row by row, write once. The rows have already been decided on by the
             * engine (skip, merge or delete); the loop that writes them is the shared
             * one, so the phone cannot apply the same pull differently. */
            if (Array.isArray(payload.favorites) && payload.favorites.length) {
                saveFavorites(syncShape.applyFavorites(readListStrict(FAVORITES_FILE), payload.favorites));
                applied.favorites = payload.favorites.length;
            }
            if (Array.isArray(payload.watch) && payload.watch.length) {
                saveForgeHistory(syncShape.applyWatch(readListStrict(FORGE_HIST_FILE), payload.watch));
                applied.watch = payload.watch.length;
            }

            /* The AniList id a row was matched to. This is what lets the phone's copy of
             * a show and this one be the same row on the account. */
            const ident = payload.identity || {};
            if (Array.isArray(ident.favorites) && ident.favorites.length) {
                saveFavorites(syncShape.setIdentity('favorites', readListStrict(FAVORITES_FILE), ident.favorites));
            }
            if (Array.isArray(ident.watch) && ident.watch.length) {
                saveForgeHistory(syncShape.setIdentity('watch', readListStrict(FORGE_HIST_FILE), ident.watch));
            }

            /* Journal entries the engine has pushed (or found re-added). */
            const done = payload.clear_deleted || {};
            if ((Array.isArray(done.favorites) && done.favorites.length)
                || (Array.isArray(done.watch) && done.watch.length)) {
                const j = loadDeleted();
                for (const kind of ['favorites', 'watch']) {
                    for (const key of (Array.isArray(done[kind]) ? done[kind] : [])) delete j[kind][String(key)];
                }
                saveDeleted(j);
            }

            jsonResponse(res, 200, { status: 'applied', applied });
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
                    name: 'AllAnime (dropped 0.6.0)',
                    ok: srcCount > 0,
                    status: r ? r.status : 0,
                    sources: srcCount,
                    error: gqlErr || undefined,
                    ms: Date.now() - t0
                });
            } catch (e) { out.push({ name: 'AllAnime (dropped 0.6.0)', ok: false, error: String(e.message || e) }); }

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
            /* Gogoanime.by is in the chain as of 0.6.0, so it belongs in the health report.
             * The two consumet entries below it are NOT in the chain any more and are probed
             * only so this endpoint keeps telling the truth about why they were dropped. */
            {
                const t0g = Date.now();
                try {
                    const gg = getGogoanime();
                    const hits = gg ? await gg.search('beastars') : [];
                    out.push({
                        name: 'Gogoanime.by', ok: hits.length > 0, results: hits.length,
                        ms: Date.now() - t0g,
                    });
                } catch (e) {
                    out.push({ name: 'Gogoanime.by', ok: false,
                               error: String(e.message || e).slice(0, 90), ms: Date.now() - t0g });
                }
            }
            /* The two consumet providers that were probed here are no longer loaded. */
            for (const prov of []) {
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
            const mode = modeOf(query.mode);
            const nsfw = query.nsfw === 'true';

            // Dual-source search: AllAnime (primary/streams) + AniList (fuzzy/romaji)
            const [allAnimeResults, aniListResults] = await Promise.all([
                searchAnime(query.q, mode, nsfw).catch(() => []),
                searchAniList(query.q, 15)
            ]);

            // Everything AniList returned goes into the local content index, so the
            // corpus grows from ordinary use rather than needing a crawl.
            try { SearchIndex.upsert(aniListResults); SearchIndex.saveSoon(); } catch { /* never block a search */ }

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
            // A prefix match is only safe if what remains after the shared prefix is
            // nothing, or a season marker. Without this, normName('Dragon Ball') is
            // 'dragonball' — ten characters, so it clears the length floor — and every
            // title in the franchise starts with it. 'dragonballsuperbroly' leaves
            // 'superbroly', and a 2018 film inherited the 1986 series' date, format,
            // cover and description. 27 of 40 Dragon Ball results were affected.
            //
            // The v0.5.1 season guard does not catch this: none of those titles carry a
            // season number, so seasonNum() returns 1 for all of them and they "agree".
            // Measured 2026-10-12.
            const SEASON_TAIL = /^(?:season|part|cour|s)?(?:\d+|i{1,3}|iv|vi?)$/;
            const prefixSafe = (long, short) => {
                if (!long.startsWith(short)) return false;
                const rest = long.slice(short.length);
                return rest === '' || SEASON_TAIL.test(rest);
            };
            const containsSafe = (a, b) =>
                a.length >= b.length ? prefixSafe(a, b) : prefixSafe(b, a);

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
                        const okR = r.length >= 8 && containsSafe(r, n) && seasonNum(r) === nSeason;
                        const okE = e.length >= 8 && containsSafe(e, n) && seasonNum(e) === nSeason;
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
                    /* A lookup, not the search: AllAnime or nothing, and only while
                     * there is room to spare. See searchAnime. */
                    const subResults = await searchAnime(searchName, mode, nsfw,
                                                         { need: 'spare', catalogOnly: true });
                    if (subResults.length > 0) {
                        /* The list is sorted longest first, so [0] is the longest show
                         * the fuzzy search returned, not the one that was asked for: a
                         * 5-episode "X 2nd Season" came back as 24-episode "X". Take the
                         * row with this name when there is one. */
                        const want = searchName.toLowerCase();
                        const match = subResults.find(r => String(r.name || '').toLowerCase() === want)
                                   || subResults[0];
                        if (!existingNames.has(match.name.toLowerCase())) {
                            match.cover = aniResult.cover;
                            match.cover_color = aniResult.cover_color || null;
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
                // Anything missing a cover OR an identity. An entry with no AniList
                // match has no format and no date, which breaks sorting and makes a
                // film indistinguishable from a season.
                // 15 was the old cover-only cap. A 40-row franchise search left 25
                // rows with no identity at all, so it rises to 25 — five batches of
                // five, which is the rate-limit ceiling worth spending here.
                const needy = results.filter(r => !r.cover || !r.anilist_id)
                                     .slice(0, 25).map(r => r.name);
                if (needy.length > 0) {
                    const anilistData = await getAniListCovers(needy);
                    for (const r of results) {
                        const info = anilistData[r.name];
                        if (!info) continue;
                        if (!r.cover) r.cover = info.cover || null;
                        if (!r.cover_color) r.cover_color = info.cover_color || null;
                        if (!r.description) r.description = info.description || null;
                        if (!r.anilist_id && info.anilist_id) {
                            r.anilist_id = info.anilist_id;
                            r.anilist_format = r.anilist_format || info.format || null;
                            if (!r.start_key) r.start_key = info.start_key || 0;
                            if (!r.popularity) r.popularity = info.popularity || 0;
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
            //
            // patternFid also gives those franchises a STABLE id. ufFind() returns the
            // smallest AniList id in whatever union this query happened to build, so
            // the same show came back as franchise 502 from one search and 223 from
            // another, and anything persisted against it — favorites, history, the
            // sibling cache — went stale. A pattern name does not vary by query.
            // Measured 2026-10-12.
            const patternFid = {};
            for (const pattern of FRANCHISE_PATTERNS) {
                const pNorm = normName(pattern);
                const matchingIds = Object.entries(nameToAniId)
                    .filter(([name]) => name.startsWith(pNorm) || name === pNorm)
                    .map(([, id]) => id);
                for (let i = 1; i < matchingIds.length; i++) ufUnion(matchingIds[0], matchingIds[i]);
                // Longest pattern wins, so "jojo's bizarre adventure" beats "jojo".
                for (const id of matchingIds) {
                    if (!patternFid[id] || pNorm.length > patternFid[id].length) patternFid[id] = pNorm;
                }
            }

            // Assign franchise_id and anilist_format to each result
            for (const r of results) {
                const rNorm = normName(r.name);
                const rEnNorm = r.title_english ? normName(r.title_english) : null;
                const aniId = nameToAniId[rNorm] || (rEnNorm && nameToAniId[rEnNorm]);
                if (aniId) {
                    r.anilist_id = aniId;
                    // Stable key where a franchise pattern applies, union-find root
                    // otherwise. Every member of a union must agree, so the pattern is
                    // read off the ROOT rather than off this entry.
                    const root = ufFind(aniId);
                    r.franchise_id = patternFid[root] ? 'fp:' + patternFid[root]
                                   : (patternFid[aniId] ? 'fp:' + patternFid[aniId]
                                                        : String(root));
                    if (!r.anilist_format) r.anilist_format = aniIdFormat[aniId] || null;
                    // A result matched only by id here never went through the enrich
                    // loop above, so it would otherwise carry no date and sort wrong.
                    if (!r.start_key) r.start_key = aniIdStart[aniId] || 0;
                    if (!r.popularity) r.popularity = aniIdPop[aniId] || 0;
                }
            }

            // Franchise by NAME PATTERN, independent of AniList.
            //
            // Tightening the pass-3 prefix match stopped films inheriting the 1986
            // series' identity, which was right, but it also left them with no AniList
            // match at all — and franchise_id was only ever assigned to entries that
            // had one. "Dragon Ball Super: Super Hero" dropped out of the Dragon Ball
            // franchise entirely. Franchise membership is a property of the TITLE and
            // should not require a successful AniList lookup. Added 2026-10-12.
            for (const r of results) {
                if (r.franchise_id) continue;
                const nm = normName(r.name);
                const en = r.title_english ? normName(r.title_english) : '';
                let best = null;
                for (const pattern of FRANCHISE_PATTERNS) {
                    const pNorm = normName(pattern);
                    if (nm.startsWith(pNorm) || (en && en.startsWith(pNorm))) {
                        if (!best || pNorm.length > best.length) best = pNorm;
                    }
                }
                if (best) r.franchise_id = 'fp:' + best;
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
                        const sub = await searchAnime(nm, mode, nsfw, { need: 'spare', catalogOnly: true })
                            .catch(() => []);
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
            const mode = modeOf(query.mode);
            let episodes = [];
            try {
                episodes = await getEpisodeList(query.id, mode, query.title || '',
                                                { allowUncensored: query.nsfw === 'true' });
            } catch {
                jsonResponse(res, 200, { anime_id: query.id, episodes: [], mode, error: 'Source temporarily unavailable — try again in a moment' });
                return;
            }
            // Attach arcs when we know them. The id here is an AllAnime id, so the
            // AniList id has to come from the caller; fall back to matching on count.
            let arcs = null;
            const aniKey = query.anilist_id && ARCS[String(query.anilist_id)]
                ? String(query.anilist_id)
                : Object.keys(ARCS).find(k => ARCS[k].episodes === episodes.length
                                           && episodes.length > 0);
            if (aniKey) arcs = ARCS[aniKey].arcs;
            jsonResponse(res, 200, { anime_id: query.id, episodes, mode, arcs });
            return;
        }

        if (pathname === '/play' && req.method === 'POST') {

            const params = safeJsonParse(await readBody(req));
            if (!params || !params.anime_id || !params.episode) {
                jsonResponse(res, 400, { error: 'Missing anime_id or episode' });
                return;
            }

            const quality = params.quality || 'best';
            const mode = modeOf(params.sub_or_dub || params.mode);

            // Get episode URL via AllAnime + fallback providers
            const epUrl = await getEpisodeUrlWithFallbacks(
                params.anime_id, params.episode.toString(), mode, quality,
                params.title || '', params.title_english || '',
                // the user's own 18+ switch. On, an (Uncensored) listing is the one that
                // was asked for; off, it stays disqualified exactly as before.
                { allowUncensored: params.nsfw === true || params.nsfw === 'true' }
            );
            if (!epUrl) {
                /* ⚠ THIS LIST WAS HARDCODED AND WENT STALE THE MOMENT THE CHAIN CHANGED. It named
                 * AllAnime, AnimePahe and HiAnime-via-consumet, all three of which were removed
                 * from the chain in 0.6.0, and it never named HiAnime.at -- the only source that
                 * actually runs. A diagnostic that reports sources nobody tried is worse than no
                 * diagnostic, because it sends the next person after hosts that were never asked.
                 * Derived from the chain now. */
                jsonResponse(res, 404, { error: 'No streams available for this episode. The episode may not be uploaded yet — try again later.', retryable: true, sources_tried: STREAM_CHAIN });
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
            jsonResponse(res, 200, {
                status: 'playing', source: epUrl.source,
                stream_url: epUrl.url,
                /* The chain resolves ONE stream. `provider` is its source; there is no
                 * list of alternative links and no per-quality URL to report. */
                provider: epUrl.source,
                // From HiAnime.at: a real subtitle track, the referer its CDN requires, and
                // the MAL id ani-skip needs. Null from sources that cannot supply them.
                referer: epUrl.referer || null,
                subtitles: epUrl.subtitles || [],
                mal_id: epUrl.malId || null,
                /* WHERE THE SUBTITLES CAME FROM: 'dialogue' | 'signs' | 'none' |
                 * 'hardsub' | 'external'. Reported so a silent episode and a substituted
                 * track are distinguishable from the outside. */
                subs_quality: epUrl.subsQuality || null,
                subs_cues: epUrl.subsCues || null,
                subs_origin: epUrl.subsOrigin || null,
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
            /* The episode label is drawn in the history panel. It is a short label and
             * nothing else, so it is stored as one. */
            const epLabel = String(params.episode).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12);
            const seconds = Number(params.playback_time);
            if (!epLabel) { jsonResponse(res, 400, { error: 'Bad episode' }); return; }
            // Update playback position in history
            const history = loadForgeHistory();
            const idx = history.findIndex(h => h.anime_id === params.anime_id);
            if (idx >= 0) {
                history[idx].playback_time = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
                history[idx].playback_episode = epLabel;
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
            const ep = String(params.episode).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12);
            if (idx >= 0 && ep) {
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

        /* POST. As a GET, `<img src=".../history/clear">` on any web page emptied the
         * history. */
        if (pathname === '/history/remove' && req.method === 'POST') {
            const animeId = query.id;
            if (!animeId) {
                jsonResponse(res, 400, { error: 'Missing id parameter' });
                return;
            }
            const history = loadForgeHistory();
            const idx = history.findIndex(h => h.anime_id === animeId);
            if (idx >= 0) {
                noteDeleted('watch', history, [animeId]);
                history.splice(idx, 1);
                saveForgeHistory(history);
                jsonResponse(res, 200, { status: 'removed', anime_id: animeId });
            } else {
                jsonResponse(res, 404, { error: 'Not found in history' });
            }
            return;
        }

        if (pathname === '/history/clear' && req.method === 'POST') {
            const all = loadForgeHistory();
            noteDeleted('watch', all, all.map(h => h.anime_id));
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
                    const found = await anilistTitles([...needsEnrich.keys()]);
                    for (const [name, entries] of needsEnrich) {
                        try {
                            const results = found[name];
                            if (!results) continue;
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
                        /* ⚠ RE-READ BEFORE WRITING, AND MERGE -- NEVER SAVE THE ARRAY
                         * LOADED AT THE TOP OF THIS HANDLER.
                         *
                         * `favs` and `history` were read BEFORE several seconds of
                         * AniList lookups. Writing them back writes a pre-lookup
                         * snapshot over the file, so anything the user removed during
                         * that window is RESURRECTED ON DISK. Reproduced 2026-11-07:
                         * nine favorites, delete one mid-refresh, and it came back.
                         *
                         * Enrichment only ever sets title_english and cover, so copy
                         * exactly those onto whatever is on disk NOW. A row that is
                         * gone stays gone, because it is not in the fresh list to
                         * copy onto. */
                        const encFav = new Map(favs.map(f => [f.id, f]));
                        const freshFavs = loadFavorites();
                        for (const f of freshFavs) {
                            const e = encFav.get(f.id);
                            if (!e) continue;
                            if (e.title_english && !f.title_english) f.title_english = e.title_english;
                            if (e.cover && !f.cover) f.cover = e.cover;
                        }
                        saveFavorites(freshFavs);

                        const encHist = new Map(history.map(h => [h.anime_id, h]));
                        const freshHist = loadForgeHistory();
                        for (const h of freshHist) {
                            const e = encHist.get(h.anime_id);
                            if (!e) continue;
                            if (e.title_english && !h.title_english) h.title_english = e.title_english;
                            if (e.cover && !h.cover) h.cover = e.cover;
                        }
                        saveForgeHistory(freshHist);
                    }
                }
                // Apply same fixDisplayName + franchise backfill as GET /favorites.
                // Re-read so the response cannot hand the client a list containing
                // something it just deleted.
                const fixedFavs = loadFavorites().map(f => fixDisplayName(f));
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
            const mode = modeOf(query.mode);
            const results = await getDailyPopular(mode);

            // Resolve AllAnime IDs for AniList-sourced results (parallel, max 5, 10s total timeout)
            const needsId = results.filter(r => !r.id).slice(0, 5);
            if (needsId.length > 0) {
                try {
                    await Promise.race([
                        Promise.all(needsId.map(async (r) => {
                            try {
                                /* The AllAnime id of a title AniList named: AllAnime
                                 * or nothing. */
                                const found = await searchAnime(r.name, mode, false,
                                                                { need: 'spare', catalogOnly: true });
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
            /* FOURTH PASS: the metadata the browse grid needs (genres, year, format).
             *
             * ⛔ IT IS WRITTEN DOWN NOW. A stored favorite used to be {id,name,episodes,cover}
             * and nothing else, this pass filled the rest in memory for the first 25 rows
             * that needed it, and the file never changed, so it was the SAME 25 on every
             * call. Measured 2026-11-12 with 30 favorites: rows 26 to 30 got no genres and
             * no year, twice. Each call now looks up at most 25 rows that have never been
             * looked up, stores what AniList said on the row, and so reaches every
             * favorite after a few calls and never asks about the same one twice.
             * `meta_at` marks a row AniList has answered for, found or not. */
            try {
                const needy = rawFavs.filter(f => f && typeof f.name === 'string' && !f.meta_at);
                if (needy.length) {
                    const info = await getAniListCovers(needy.map(f => f.name), 25);
                    const learned = new Map();
                    for (const f of needy) {
                        const d = info[f.name];
                        if (!d || !d.answered) continue;
                        const m = { meta_at: Date.now() };
                        if (!f.genres) m.genres = d.genres || [];
                        if (!f.start_key) m.start_key = d.start_key || 0;
                        if (!f.anilist_format) m.anilist_format = d.format || null;
                        if (!f.popularity) m.popularity = d.popularity || 0;
                        if (!f.cover && d.cover) m.cover = d.cover;
                        if (!f.cover_color && d.cover_color) m.cover_color = d.cover_color;
                        Object.assign(f, m);
                        learned.set(String(f.id), m);
                    }
                    if (learned.size) {
                        /* Re-read, apply by id, write once. The lookups above took time,
                         * and writing back the list this request started with is the
                         * mistake that lost real favorites on 2026-11-07. */
                        try {
                            const fresh = loadFavorites();
                            let touched = false;
                            for (const f of fresh) {
                                const m = f && learned.get(String(f.id));
                                if (m) { Object.assign(f, m); touched = true; }
                            }
                            if (touched) saveFavorites(fresh);
                        } catch (e) { console.error('[favorites] could not store metadata:', e.message); }
                    }
                }
            } catch { /* the list still renders without it */ }

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
            /* ⚠ TEXT IS TEXT. This tested only that id and name were truthy, so
             * {"id":"x","name":5} was stored, and GET /favorites then threw on
             * (5).toLowerCase() and answered 500 until the file was edited by hand. */
            const okText = (v, max) => (typeof v === 'string' || typeof v === 'number')
                && String(v).length > 0 && String(v).length <= max;
            if (!item || typeof item !== 'object' || !okText(item.id, 200) || !okText(item.name, 300)) {
                jsonResponse(res, 400, { error: 'Missing id or name' });
                return;
            }
            item.id = String(item.id);
            item.name = String(item.name);
            const favs = loadFavorites();
            if (!favs.some(f => String(f.id) === item.id)) {
                const fav = { id: item.id, name: item.name, episodes: wholeTotal(item.episodes) || 0, added: new Date().toISOString() };
                if (okText(item.title_english, 300)) fav.title_english = String(item.title_english);
                /* A bare 'fp:' is what the page produced while the franchise module was
                 * missing. Stored, it later glued every such favorite into one group. */
                if (okText(item.franchise_id, 200) && !/^fp:\s*$/.test(String(item.franchise_id))) {
                    fav.franchise_id = String(item.franchise_id);
                }
                if (okText(item.cover, 600) && /^https?:\/\//i.test(String(item.cover))) fav.cover = String(item.cover);
                favs.unshift(fav);
                saveFavorites(favs);
            }
            jsonResponse(res, 200, { status: 'added', favorites: favs });
            return;
        }

        if (pathname.startsWith('/favorites/') && req.method === 'DELETE') {
            /* The page sends encodeURIComponent(id). Compared undecoded, an id with a
             * ':' in it (anidb:123, al:456) never matched and the route still said
             * "removed". */
            let deleteId = pathname.split('/favorites/')[1] || '';
            try { deleteId = decodeURIComponent(deleteId); } catch { /* keep it as sent */ }
            const before = loadFavorites();
            if (before.some(f => String(f.id) === deleteId)) noteDeleted('favorites', before, [deleteId]);
            const favs = before.filter(f => String(f.id) !== deleteId);
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
            /* ⚠ ONE CRAWL PER HALF HOUR. The page calls this after every star tap and
             * every finished episode, and each call paged through a week of schedules:
             * up to 20 requests against a budget of 30 a minute. A week of airings does
             * not change between two taps. A crawl that fails is not cached. */
            if (recentAiring.rows && (Date.now() - recentAiring.at) < 30 * 60 * 1000) {
                allRecent.push(...recentAiring.rows);
            } else {
                let complete = false;
                try {
                    while (hasNext && page <= 20) {
                        const json = await anilistPost(gql, { page, gt: weekAgo, lt: nowSec }, 8000, 'spare');
                        if (json === null) throw new Error('AniList has no room to spare');
                        const pg = json?.data?.Page;
                        if (pg?.airingSchedules) allRecent.push(...pg.airingSchedules);
                        hasNext = pg?.pageInfo?.hasNextPage || false;
                        page++;
                    }
                    complete = true;
                } catch { /* AniList down or rate limited: answer from what arrived */ }
                if (complete) { recentAiring.rows = allRecent.slice(); recentAiring.at = Date.now(); }
            }

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

            const mode = modeOf(params.sub_or_dub || params.mode);
            const quality = params.quality || 'best';

            // Resolve the stream (same chain as /play)
            const st = await getEpisodeUrlWithFallbacks(
                params.anime_id, String(params.episode), mode, quality,
                params.title || '', params.title_english || '',
                { allowUncensored: params.nsfw === true || params.nsfw === 'true' }
            );
            if (!st || !st.url) {
                jsonResponse(res, 404, { error: 'No streams available for download. Try again later.', retryable: true });
                return;
            }

            /* ⚠ EVERY PART OF THE FILE NAME IS CLEANED. The title was; the episode and the
             * quality went in as received, so `x]/../../../../tmp/y[` in either one put
             * the file wherever the caller liked, with ffmpeg's -y to overwrite. The
             * resolved path is checked as well, because one check is one mistake away
             * from none. */
            const clean = (v, max) => String(v == null ? '' : v).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, max);
            const safeTitle = String(params.title || 'anime').replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().slice(0, 60) || 'anime';
            const filename = `${safeTitle} - EP${clean(params.episode, 12) || '0'} [${clean(quality, 12) || 'best'}].mp4`;
            const filePath = path.join(DOWNLOAD_DIR, filename);
            if (path.dirname(path.resolve(filePath)) !== path.resolve(DOWNLOAD_DIR)) {
                jsonResponse(res, 400, { error: 'Bad file name' });
                return;
            }
            const dlId = `${clean(params.anime_id, 40)}-${clean(params.episode, 12)}-${Date.now()}`;

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

            /* The CDN refuses a request without the stream's own Referer. The download
             * sent none (ffmpeg) or AllAnime's (fetch), so even with the 500 fixed it
             * would have been refused by the only source that plays. */
            const referer = st.referer || ALLANIME_REFR;

            // Start async download
            (async () => {
                const dl = downloadQueue.get(dlId);
                try {
                    if (st.url.includes('.m3u8')) {
                        // HLS: ffmpeg fetches the playlist and every segment
                        const ffmpeg = spawn('ffmpeg', [
                            '-user_agent', AGENT,
                            '-referer', referer,
                            '-headers', `Referer: ${String(referer).replace(/[\r\n]/g, '')}\r\n`,
                            '-i', st.url,
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
                            ffmpeg.on('error', (e) => reject(e && e.code === 'ENOENT'
                                ? new Error('ffmpeg is not installed. Install it and add it to PATH.') : e));
                        });

                        dl.status = 'complete';
                        dl.progress = 100;
                    } else {
                        // Direct MP4 download with progress
                        const resp = await fetch(st.url, {
                            headers: { 'User-Agent': AGENT, 'Referer': referer },
                            signal: AbortSignal.timeout(30 * 60 * 1000)
                        });
                        if (!resp.ok || !resp.body) throw new Error('the stream host answered HTTP ' + resp.status);
                        const totalSize = parseInt(resp.headers.get('content-length') || '0');
                        let downloaded = 0;

                        const writer = fs.createWriteStream(filePath);
                        /* A full disk or a folder that cannot be written is an 'error'
                         * event. With no listener it was an uncaught exception. */
                        const failed = new Promise((_, reject) => writer.on('error', reject));
                        const reader = resp.body.getReader();

                        await Promise.race([failed, (async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (!writer.write(value)) await new Promise(r => writer.once('drain', r));
                                downloaded += value.length;
                                if (totalSize > 0) {
                                    dl.progress = Math.min(99, Math.round((downloaded / totalSize) * 100));
                                }
                            }
                            writer.end();
                            await new Promise(resolve => writer.on('finish', resolve));
                        })()]);
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

        /* EXTERNAL SUBTITLES, SERVED FROM DISK. Added 2026-11-07 for v0.6.0.
         *
         * An external subtitle file reaches the player through here rather than through
         * /proxy-stream, and the difference is deliberate:
         *   - it is already WebVTT. The source is SubRip or SubStation Alpha, and a <track>
         *     element renders neither. The conversion happened when it was fetched.
         *   - it is already stripped of the uploader's adverts.
         *   - it needs NO referer, so the UI leaves `src` alone. v0.5.9 wrapped tracks the UI
         *     was already wrapping and produced `/proxy-stream?url=%2Fproxy-stream%3F...`,
         *     a 400 on every track and a player with no subtitles.
         * The token is an opaque key into the cache, not a URL, so nothing here can be
         * pointed at an arbitrary host. */
        if (pathname === '/subtitle') {
            const chain = getSubsChain();
            const vtt = chain && query.t ? chain.read(String(query.t)) : null;
            if (!vtt) {
                jsonResponse(res, 404, { error: 'No such subtitle' });
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/vtt; charset=utf-8',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(vtt);
            return;
        }

        // Proxy stream for referer-gated CDNs (required for the in-app player).
        if (pathname === '/proxy-stream') {
            if (!query.url) {
                jsonResponse(res, 400, { error: 'Missing url parameter' });
                return;
            }
            let target;
            try { target = new URL(String(query.url)); }
            catch { jsonResponse(res, 400, { error: 'Invalid URL' }); return; }
            if (!proxyAllowed(target)) {
                console.warn(`[ANI-MATE] Blocked proxy domain: ${target.hostname}`);
                jsonResponse(res, 403, { error: 'Domain not allowed for proxy' });
                return;
            }

            /* THE REFERER IS PER-SOURCE. HiAnime.at's CDN 403s unless it is
             * https://zokoanime.video/, and /play returns the right one for each stream. */
            const refr = (typeof query.referer === 'string' && query.referer) ? query.referer : ALLANIME_REFR;
            const wrap = (u) => `/proxy-stream?url=${encodeURIComponent(u)}`
                              + (query.referer ? `&referer=${encodeURIComponent(query.referer)}` : '');

            /* ⚠ THE DEADLINE IS ON THE FIRST BYTE AND ON SILENCE, NOT ON THE TRANSFER.
             * It was AbortSignal.timeout(15000) over the whole body, which cut every
             * transfer longer than 15 seconds: an MP4 through the proxy could not finish.
             * And when the viewer leaves, stop pulling from the CDN. */
            const ctl = new AbortController();
            let timer = setTimeout(() => ctl.abort(), PROXY_FIRST_BYTE_MS);
            const stop = () => { clearTimeout(timer); ctl.abort(); };
            res.on('close', stop);

            try {
                /* ⚠ RANGE IS FORWARDED. Without it a seek in an MP4 asked for bytes
                 * N onward and was sent the file from byte 0 with a 200, so the player
                 * could only ever play from the start. */
                const headers = { 'User-Agent': AGENT, 'Referer': refr };
                if (req.headers.range) headers.Range = String(req.headers.range);

                /* ⚠ REDIRECTS BY HAND, EVERY HOP CHECKED. */
                let current = target, resp = null;
                for (let hop = 0; hop <= PROXY_MAX_HOPS; hop++) {
                    resp = await fetch(current, { headers, redirect: 'manual', signal: ctl.signal });
                    const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
                    if (!loc) break;
                    let next;
                    try { next = new URL(loc, current); } catch { next = null; }
                    try { if (resp.body) await resp.body.cancel(); } catch { /* nothing to drain */ }
                    if (!next || !proxyAllowed(next) || hop === PROXY_MAX_HOPS) {
                        clearTimeout(timer);
                        console.warn(`[ANI-MATE] Blocked proxy redirect to: ${next ? next.hostname : loc}`);
                        jsonResponse(res, 403, { error: 'Redirect to a domain that is not allowed' });
                        return;
                    }
                    current = next;
                }
                clearTimeout(timer);

                const contentType = resp.headers.get('content-type') || 'application/octet-stream';
                const isM3u8 = /\.m3u8($|\?)/i.test(current.pathname + current.search)
                            || /mpegurl/i.test(contentType);

                if (isM3u8) {
                    /* A playlist the CDN refused is an error. It used to be rewritten
                     * line by line, error page and all, and served as a 200 playlist. */
                    if (!resp.ok) {
                        try { if (resp.body) await resp.body.cancel(); } catch { /* ignore */ }
                        jsonResponse(res, resp.status === 404 ? 404 : 502,
                                     { error: 'The stream host refused the playlist', status: resp.status });
                        return;
                    }
                    // Make every URI absolute against where the playlist actually came
                    // from, and route it back through here with the same referer.
                    const abs = (u) => { try { return new URL(u, current).toString(); } catch { return null; } };
                    const manifest = (await resp.text()).split('\n').map(line => {
                        line = line.trim();
                        if (line && !line.startsWith('#')) {
                            const a = abs(line);
                            return a ? wrap(a) : line;
                        }
                        if (line.includes('URI="')) {
                            line = line.replace(/URI="([^"]+)"/g, (m, uri) => {
                                const a = abs(uri);
                                return a ? `URI="${wrap(a)}"` : m;
                            });
                        }
                        return line;
                    }).join('\n');
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'X-Content-Type-Options': 'nosniff',
                        'Cache-Control': 'no-store'
                    });
                    res.end(manifest);
                    return;
                }

                // Segments, MP4, subtitle files: pass the bytes through.
                const out = {
                    'Content-Type': safeType(contentType),
                    'X-Content-Type-Options': 'nosniff',
                    'Accept-Ranges': 'bytes'
                };
                /* fetch has already decompressed the body, so an upstream length for a
                 * compressed answer would be the wrong number and truncate it. */
                if (!resp.headers.get('content-encoding') && resp.headers.get('content-length')) {
                    out['Content-Length'] = resp.headers.get('content-length');
                }
                if (resp.headers.get('content-range')) out['Content-Range'] = resp.headers.get('content-range');
                res.writeHead(resp.status, out);

                /* ⛔ A 204 OR A 304 HAS NO BODY AND resp.body IS null. Reading it threw
                 * AFTER the headers were written, which is the request that used to end
                 * the process. */
                if (!resp.body) { res.end(); return; }

                const reader = resp.body.getReader();
                try {
                    for (;;) {
                        timer = setTimeout(() => ctl.abort(), PROXY_IDLE_MS);
                        const { done, value } = await reader.read();
                        clearTimeout(timer);
                        if (done) break;
                        // Wait for the viewer to take what was sent before pulling more.
                        if (!res.write(value)) {
                            await new Promise(r => { res.once('drain', r); res.once('close', r); });
                        }
                    }
                } catch { /* the CDN went quiet, or the viewer left */ }
                clearTimeout(timer);
                try { res.end(); } catch { /* already closed */ }
            } catch (err) {
                clearTimeout(timer);
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
};

/* Nothing restarts this process if it dies (main.js now does, but it should not have
 * to). One stray rejection is a line in the log, not the end of the backend. */
process.on('unhandledRejection', (e) => {
    console.error('[ANI-MATE] unhandled rejection: ' + (e && e.stack || e));
});
process.on('uncaughtException', (e) => {
    console.error('[ANI-MATE] uncaught exception: ' + (e && e.stack || e));
});

const server = http.createServer(handleRequest);

/* ⛔ DO NOT OUTLIVE THE APP. main.js forks this process with a channel between the two.
 * When the app's main process died without stopping it (a crash: /var/crash on the
 * developer's machine holds one for the installed app from 2026-11-08; or kill -9)
 * nothing ended this server. It kept the port and the data files, and the next launch
 * found its port busy and started on another one, where the settings and the sync
 * sign-in look empty. Measured 2026-11-12: three test launches whose app crashed left
 * three servers running.
 * The channel closing is the one thing a dead parent cannot fail to do. */
if (process.send) {
    process.on('disconnect', () => {
        console.error('[ANI-MATE] the app is gone; the server is stopping');
        try { SearchIndex.save(); } catch (e) { /* the index refills from use */ }
        process.exit(0);
    });
}

// Fill the content index in the background on a fresh install, so a query that
// describes a show instead of naming it has a corpus to search from the first run.
// Delayed and fire-and-forget: it must never hold up the server coming online.
function seedIndexIfEmpty() {
    setTimeout(() => {
        try {
            if (process.env.ANI_MATE_TEST_NO_SEED) return;       // test hook, see ALLANIME_API
            if (SearchIndex.stats().entries >= 200) return;
            /* Through the counted door, as a spare question: twelve pages are twelve of
             * AniList's thirty a minute, and whatever the user asks meanwhile comes first. */
            SearchIndex.seed(12, 50, () => {}, (q, v) => anilistPost(q, v, 15000, 'spare'))
                .then(n => { if (n) console.log(`[ANI-MATE] content index seeded: ${n} entries`); })
                .catch(() => {});
        } catch { /* search still works on titles */ }
    }, 5000);
}

/* ⛔ LOOPBACK ONLY. This was server.listen(PORT) with no host, which binds every address
 * the machine has. Measured 2026-11-12 on the developer's own box: it answered on the
 * LAN address, the tailnet address and the Docker bridge. Nothing outside this machine
 * has any business here.
 * The page is loaded as http://localhost:PORT, and `localhost` can be either loopback
 * family, so both are bound. ::1 is allowed to fail (IPv6 can be switched off). */
const server6 = http.createServer(handleRequest);
server6.on('error', (err) => {
    console.error(`[ANI-MATE] not listening on [::1]:${PORT}: ${err.code || err.message}`);
});
server.listen(PORT, '127.0.0.1', () => {
    server6.listen(PORT, '::1');
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
