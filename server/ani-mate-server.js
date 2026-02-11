// YASA PRESENTS
// ani-mate-server.js - ANI-MATE Backend Server
// Anime streaming interface - REST API

const http = require('http');
const { spawn } = require('child_process');
const url = require('url');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.ANI_MATE_PORT) || 7890;
const HIST_DIR = process.env.ANI_MATE_DATA_DIR
    || process.env.ANI_CLI_HIST_DIR
    || `${process.env.XDG_STATE_HOME || `${process.env.HOME || process.env.USERPROFILE}/.local/state`}/ani-cli`;
const HIST_FILE = path.join(HIST_DIR, 'ani-hsts');

// Ensure data directory exists on startup
try { fs.mkdirSync(HIST_DIR, { recursive: true }); } catch {}
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0';
const ALLANIME_REFR = 'https://allanime.to';
const ALLANIME_API = 'https://api.allanime.day/api';

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
    fs.writeFileSync(FORGE_HIST_FILE, JSON.stringify(history, null, 2));
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
        history.unshift({
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
        });
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
        fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favs, null, 2));
    } catch { /* ignore */ }
}

// Daily popular/trending
async function getDailyPopular(mode = 'sub') {
    const gql = `query($type: VaildPopularTypeEnumType!, $size: Int!, $dateRange: Int, $page: Int) { queryPopular(type: $type, size: $size, dateRange: $dateRange, page: $page) { recommendations { anyCard { _id name availableEpisodes __typename } } } }`;
    const variables = JSON.stringify({ type: 'anime', size: 25, dateRange: 1, page: 1 });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const response = await fetch(apiUrl, {
        headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR }
    });
    const data = await response.json();

    const results = [];
    const recs = data?.data?.queryPopular?.recommendations || [];
    for (const rec of recs) {
        const show = rec.anyCard;
        if (!show) continue;
        const epCount = show.availableEpisodes?.[mode] || 0;
        if (epCount > 0) {
            const type = epCount === 1 ? 'movie' : epCount <= 12 ? 'short' : 'series';
            results.push({ id: show._id, name: show.name, episodes: epCount, type });
        }
    }
    return results;
}

// AniList airing schedule - real episode air times
const airingCache = {};
const AIRING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAiringSchedule(dateStr) {
    const now = new Date();
    const target = dateStr ? new Date(dateStr + 'T00:00:00') : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cacheKey = target.toISOString().slice(0, 10);

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
        return titles.reduce((acc, t) => { acc[t] = { cover: coverCache[t]?.url || null, description: coverCache[t]?.description || null }; return acc; }, {});
    }

    // Batch query AniList (5 at a time to avoid rate limits)
    for (let i = 0; i < needed.length; i += 5) {
        const batch = needed.slice(i, i + 5);
        try {
            // Build individual queries
            const fragments = batch.map((title, idx) => {
                return `q${idx}: Page(perPage: 1) { media(search: "${title.replace(/"/g, '\\"')}", type: ANIME) { title { english romaji } coverImage { medium } description(asHtml: false) } }`;
            }).join('\n');

            const gql = `query { ${fragments} }`;
            const resp = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query: gql }),
                signal: AbortSignal.timeout(5000)
            });
            const json = await resp.json();

            batch.forEach((title, idx) => {
                const media = json?.data?.[`q${idx}`]?.media?.[0];
                const coverUrl = media?.coverImage?.medium || null;
                const desc = media?.description || null;
                coverCache[title] = { url: coverUrl, description: desc, at: Date.now() };
            });
        } catch {
            // On failure, cache null so we don't retry immediately
            batch.forEach(title => {
                if (!coverCache[title]) coverCache[title] = { url: null, at: Date.now() };
            });
        }
    }

    return titles.reduce((acc, t) => { acc[t] = { cover: coverCache[t]?.url || null, description: coverCache[t]?.description || null }; return acc; }, {});
}

// Anime info lookup (AniList primary, Jikan/MAL fallback)
const infoCache = {};
const INFO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Title corrections for AllAnime names that don't match AniList/MAL
const TITLE_MAP = {
    '1P': 'One Piece',
};

async function getAnimeInfo(title) {
    const searchTitle = TITLE_MAP[title] || title;
    if (infoCache[title] && (Date.now() - infoCache[title].at) < INFO_CACHE_TTL) {
        return infoCache[title];
    }

    // Try AniList first
    try {
        const gql = `query { Page(perPage: 1) { media(search: "${searchTitle.replace(/"/g, '\\"')}", type: ANIME) { description(asHtml: false) coverImage { large } genres averageScore } } }`;
        const resp = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: gql }),
            signal: AbortSignal.timeout(5000)
        });
        const json = await resp.json();
        const media = json?.data?.Page?.media?.[0];
        if (media?.description) {
            const result = { description: media.description, cover: media.coverImage?.large || null, genres: media.genres || [], score: media.averageScore, source: 'anilist', at: Date.now() };
            infoCache[title] = result;
            return result;
        }
    } catch { /* fall through to Jikan */ }

    // Jikan/MAL fallback
    try {
        const resp = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchTitle)}&limit=1`, {
            signal: AbortSignal.timeout(5000)
        });
        const json = await resp.json();
        const anime = json?.data?.[0];
        if (anime) {
            const result = { description: anime.synopsis || null, cover: anime.images?.jpg?.large_image_url || null, genres: (anime.genres || []).map(g => g.name), score: anime.score ? anime.score * 10 : null, source: 'mal', at: Date.now() };
            infoCache[title] = result;
            return result;
        }
    } catch { /* no fallback */ }

    const empty = { description: null, cover: null, genres: [], score: null, source: null, at: Date.now() };
    infoCache[title] = empty;
    return empty;
}

// Direct API calls to AllAnime (same as ani-cli but from Node)
async function searchAnime(query, mode = 'sub') {
    const searchGql = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } } }`;

    const variables = JSON.stringify({
        search: { allowAdult: true, allowUnknown: false, query },
        limit: 40,
        page: 1,
        translationType: mode,
        countryOrigin: 'ALL'
    });

    const params = new URLSearchParams({ variables, query: searchGql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const response = await fetch(apiUrl, {
        headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR }
    });
    const data = await response.json();

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
    return results;
}

async function getEpisodeList(showId, mode = 'sub') {
    const gql = `query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail } }`;
    const variables = JSON.stringify({ showId });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const response = await fetch(apiUrl, {
        headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR }
    });
    const data = await response.json();

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

    const variables = JSON.stringify({ showId, translationType: mode, episodeString });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const response = await fetch(apiUrl, {
        headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR }
    });
    const text = await response.text();

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
            const linkResp = await fetch(linkUrl, {
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

    // Select quality
    if (allLinks.length === 0) return null;

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

            return {
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
            const results = await searchAnime(query.q, mode);

            // Attach cover images from AniList (top 15 results)
            try {
                const topTitles = results.slice(0, 15).map(r => r.name);
                const anilistData = await getAniListCovers(topTitles);
                for (const r of results) {
                    const info = anilistData[r.name];
                    r.cover = info?.cover || null;
                    r.description = info?.description || null;
                }
            } catch { /* non-critical */ }

            jsonResponse(res, 200, { results, query: query.q, mode });
            return;
        }

        if (pathname === '/episodes') {
            if (!query.id) {
                jsonResponse(res, 400, { error: 'Missing anime ID parameter "id"' });
                return;
            }
            const mode = query.mode || 'sub';
            const episodes = await getEpisodeList(query.id, mode);
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

            // Get episode URL via direct API
            const epUrl = await getEpisodeUrl(params.anime_id, params.episode.toString(), mode, quality);
            if (!epUrl) {
                jsonResponse(res, 404, { error: 'Could not find episode stream URL' });
                return;
            }

            // Update history metadata only — episode NOT marked as watched yet
            // (client calls /mark-watched after 80% or 20min threshold)
            addToForgeHistory({
                anime_id: params.anime_id,
                title: params.title || 'Unknown',
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
                status: 'playing',
                stream_url: epUrl.url,
                resolution: epUrl.resolution,
                provider: epUrl.provider,
                all_links: epUrl.all_links,
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

        if (pathname === '/continue') {
            const continueList = getContinueList();
            jsonResponse(res, 200, { continue_list: continueList });
            return;
        }

        if (pathname === '/daily') {
            const mode = query.mode || 'sub';
            const results = await getDailyPopular(mode);

            // Attach cover images
            try {
                const titles = results.slice(0, 15).map(r => r.name);
                const anilistData = await getAniListCovers(titles);
                for (const r of results) {
                    const info = anilistData[r.name];
                    r.cover = info?.cover || null;
                    r.description = info?.description || null;
                }
            } catch { /* non-critical */ }

            jsonResponse(res, 200, { results, mode });
            return;
        }

        if (pathname === '/releases') {
            const date = query.date || '';
            try {
                const results = await getAiringSchedule(date);
                jsonResponse(res, 200, { results, date: date || new Date().toISOString().slice(0, 10) });
            } catch (err) {
                jsonResponse(res, 500, { error: 'Failed to fetch airing schedule' });
            }
            return;
        }

        if (pathname === '/favorites' && req.method === 'GET') {
            const favs = loadFavorites();
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
                favs.unshift({ id: item.id, name: item.name, episodes: item.episodes || 0, added: new Date().toISOString() });
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

            // Get stream URL first
            const epUrl = await getEpisodeUrl(params.anime_id, params.episode.toString(), mode, quality);
            if (!epUrl) {
                jsonResponse(res, 404, { error: 'Could not find stream URL for download' });
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
                    'vidstreaming.io', 'vidplay.online'
                ];
                const allowed = ALLOWED_PROXY_DOMAINS.some(d => proxyHost === d || proxyHost.endsWith('.' + d));
                if (!allowed) {
                    jsonResponse(res, 403, { error: 'Domain not allowed for proxy' });
                    return;
                }
            } catch {
                jsonResponse(res, 400, { error: 'Invalid URL' });
                return;
            }

            try {
                const streamResp = await fetch(streamUrl, {
                    headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR },
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
                            return `/proxy-stream?url=${encodeURIComponent(absUrl)}`;
                        }
                        // Rewrite URI= in EXT-X-KEY and similar tags
                        if (line.includes('URI="')) {
                            line = line.replace(/URI="([^"]+)"/g, (match, uri) => {
                                const absUri = uri.startsWith('http') ? uri : baseUrl + uri;
                                return `URI="/proxy-stream?url=${encodeURIComponent(absUri)}"`;
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
                version: '0.2.0',
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

server.listen(PORT, () => {
    console.log(`[ANI-MATE] Server online at http://localhost:${PORT}`);
    console.log(`[ANI-MATE] UI available at http://localhost:${PORT}/`);
    console.log(`[ANI-MATE] API endpoints: /search, /episodes, /play, /history, /continue, /download, /status`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[ANI-MATE] Port ${PORT} already in use. Kill existing process or use a different port.`);
    } else {
        console.error(`[ANI-MATE] Server error: ${err.message}`);
    }
    process.exit(1);
});
