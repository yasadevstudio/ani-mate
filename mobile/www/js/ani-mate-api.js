// YASA PRESENTS
// ani-mate-api.js - ANI-MATE Client-Side API Module (Android)
// Ported from server-side ani-mate-server.js for Capacitor with CapacitorHttp

const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0';
const ALLANIME_REFR = 'https://allanime.to';
const ALLANIME_API = 'https://api.allanime.day/api';

// Title corrections for AllAnime names that don't match AniList/MAL
const TITLE_MAP = {
    '1P': 'One Piece',
};

// Caches (memory-only, cleared on app restart)
const coverCache = {};
const COVER_CACHE_TTL = 60 * 60 * 1000;
const COVER_CACHE_FAIL_TTL = 5 * 60 * 1000;

const airingCache = {};
const AIRING_CACHE_TTL = 5 * 60 * 1000;

const infoCache = {};
const INFO_CACHE_TTL = 60 * 60 * 1000;

// === NATIVE HTTP HELPERS ===
// Use Capacitor's native HTTP plugin directly for AllAnime requests.
// The patched fetch may not properly forward headers or may trigger
// Cloudflare challenges due to TLS fingerprint differences.
const CapHttp = window.Capacitor?.Plugins?.CapacitorHttp;

const ALLANIME_HEADERS = {
    'User-Agent': AGENT,
    'Referer': ALLANIME_REFR,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
};

// AllAnime GET request returning parsed JSON
async function allanimeGet(url) {
    if (CapHttp) {
        const resp = await CapHttp.get({ url, headers: ALLANIME_HEADERS });
        if (resp.status !== 200) throw new Error(`AllAnime HTTP ${resp.status}`);
        // CapHttp auto-parses JSON if content-type is application/json
        if (typeof resp.data === 'string') {
            if (resp.data.trimStart().startsWith('<')) throw new Error('AllAnime returned HTML (Cloudflare challenge)');
            return JSON.parse(resp.data);
        }
        return resp.data;
    }
    const resp = await fetch(url, { headers: ALLANIME_HEADERS });
    if (!resp.ok) throw new Error(`AllAnime HTTP ${resp.status}`);
    return resp.json();
}

// AllAnime GET request returning raw text
async function allanimeGetText(url) {
    if (CapHttp) {
        const resp = await CapHttp.get({
            url,
            headers: ALLANIME_HEADERS,
            responseType: 'text'
        });
        if (resp.status !== 200) throw new Error(`AllAnime HTTP ${resp.status}`);
        return typeof resp.data === 'object' ? JSON.stringify(resp.data) : String(resp.data);
    }
    const resp = await fetch(url, { headers: ALLANIME_HEADERS });
    return resp.text();
}

// Provider link fetch (with timeout, may be different domains)
async function providerFetch(url) {
    try {
        if (CapHttp) {
            const resp = await CapHttp.get({
                url,
                headers: ALLANIME_HEADERS,
                responseType: 'text',
                connectTimeout: 8000,
                readTimeout: 8000
            });
            if (resp.status && resp.status >= 400) return '';
            const data = typeof resp.data === 'object' ? JSON.stringify(resp.data) : String(resp.data);
            // Reject if response looks like HTML (error page) or is too large (binary)
            if (data.trimStart().startsWith('<') || data.length > 50000) return '';
            return data;
        }
        const resp = await fetch(url, {
            headers: { 'User-Agent': AGENT, 'Referer': ALLANIME_REFR },
            signal: AbortSignal.timeout(8000)
        });
        if (!resp.ok) return '';
        return resp.text();
    } catch {
        return '';
    }
}

// Search anime via AllAnime GraphQL
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

    const data = await allanimeGet(apiUrl);

    const results = [];
    if (data?.data?.shows?.edges) {
        for (const show of data.data.shows.edges) {
            const epCount = show.availableEpisodes?.[mode] || 0;
            if (epCount > 0) {
                const type = epCount === 1 ? 'movie' : epCount <= 12 ? 'short' : 'series';
                results.push({ id: show._id, name: show.name, episodes: epCount, type });
            }
        }
    }
    results.sort((a, b) => b.episodes - a.episodes);

    // Dual-source search: AllAnime (primary/streams) + AniList (fuzzy/romaji)
    const aniListResults = await searchAniList(query, 15).catch(() => []);

    const existingNames = new Set(results.map(r => r.name.toLowerCase()));

    // Enrich AllAnime results with AniList English titles
    for (const r of results) {
        const aniMatch = aniListResults.find(a =>
            (a.title_romaji && a.title_romaji.toLowerCase() === r.name.toLowerCase()) ||
            (a.title_english && a.title_english.toLowerCase() === r.name.toLowerCase())
        );
        if (aniMatch) {
            r.title_english = aniMatch.title_english;
            r.cover = r.cover || aniMatch.cover;
            r.description = r.description || aniMatch.description;
        }
    }

    // Find AniList results NOT already in AllAnime results
    const aniListOnly = aniListResults.filter(a => {
        const names = [a.title_english, a.title_romaji].filter(Boolean).map(n => n.toLowerCase());
        return !names.some(n => existingNames.has(n));
    });

    // Search AllAnime for AniList-only titles (parallel, max 3)
    const secondarySearches = aniListOnly.slice(0, 3).map(async (aniResult) => {
        const searchName = aniResult.title_romaji || aniResult.title_english;
        if (!searchName) return null;
        try {
            const subGql = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } } }`;
            const subVars = JSON.stringify({
                search: { allowAdult: true, allowUnknown: false, query: searchName },
                limit: 5, page: 1, translationType: mode, countryOrigin: 'ALL'
            });
            const subParams = new URLSearchParams({ variables: subVars, query: subGql });
            const subData = await allanimeGet(`${ALLANIME_API}?${subParams.toString()}`);
            const subShows = subData?.data?.shows?.edges || [];
            for (const show of subShows) {
                const epCount = show.availableEpisodes?.[mode] || 0;
                if (epCount > 0 && !existingNames.has(show.name.toLowerCase())) {
                    const type = epCount === 1 ? 'movie' : epCount <= 12 ? 'short' : 'series';
                    return {
                        id: show._id, name: show.name, episodes: epCount, type,
                        cover: aniResult.cover, description: aniResult.description,
                        title_english: aniResult.title_english
                    };
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

    return results;
}

// AniList search — fuzzy matching, romaji/English, catches misspellings
async function searchAniList(query, limit = 15) {
    try {
        const gql = `query ($search: String, $perPage: Int) {
            Page(page: 1, perPage: $perPage) {
                media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
                    id title { english romaji } coverImage { medium }
                    description(asHtml: false) format episodes status
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
            status: m.status
        }));
    } catch { return []; }
}

// Get episode list for a show
async function getEpisodeList(showId, mode = 'sub') {
    const gql = `query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail } }`;
    const variables = JSON.stringify({ showId });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const data = await allanimeGet(apiUrl);

    let episodes = [];
    try {
        const detail = data?.data?.show?.availableEpisodesDetail;
        if (detail && detail[mode]) {
            episodes = detail[mode].sort((a, b) => parseFloat(a) - parseFloat(b));
        }
    } catch { /* ignore */ }
    return episodes;
}

// Decode provider ID (hex mapping from ani-cli)
function decodeProviderId(encoded) {
    const hexMap = {
        '01': '9', '08': '0', '05': '=', '0a': '2', '0b': '3',
        '0c': '4', '07': '?', '00': '8', '5c': 'd', '0f': '7',
        '5e': 'f', '17': '/', '54': 'l', '09': '1', '48': 'p',
        '4f': 'w', '0e': '6', '5b': 'c', '5d': 'e', '0d': '5',
        '53': 'k', '1e': '&', '5a': 'b', '59': 'a', '4a': 'r',
        '4c': 't', '4e': 'v', '57': 'o', '51': 'i',
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

// Get streaming URL for an episode
async function getEpisodeUrl(showId, episodeString, mode = 'sub', quality = 'best') {
    const gql = `query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode( showId: $showId translationType: $translationType episodeString: $episodeString ) { episodeString sourceUrls } }`;

    const variables = JSON.stringify({ showId, translationType: mode, episodeString });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const text = await allanimeGetText(apiUrl);

    const sourceUrls = [];
    const sourceRegex = /"sourceUrl":"--([^"]*)"[^}]*"sourceName":"([^"]*)"/g;
    let match;
    while ((match = sourceRegex.exec(text)) !== null) {
        sourceUrls.push({ url: match[1], name: match[2] });
    }

    // Fetch all providers in parallel
    const allLinks = [];
    const providerResults = await Promise.allSettled(
        sourceUrls.map(async (source) => {
            const decodedPath = decodeProviderId(source.url);
            const linkUrl = decodedPath.startsWith('http') ? decodedPath : `https://allanime.day${decodedPath}`;

            // Direct video URL (not a clock.json endpoint) — use as-is
            if (!linkUrl.includes('clock.json') && !linkUrl.includes('/apivtwo/')) {
                const ext = linkUrl.split('?')[0].split('.').pop().toLowerCase();
                const res = ext === 'mp4' || source.name.toLowerCase().includes('mp4') ? 'Mp4' : 'auto';
                return [{ resolution: res, url: linkUrl, provider: source.name }];
            }

            // Clock.json endpoint — fetch small JSON and extract stream links
            const linkText = await providerFetch(linkUrl);
            if (!linkText || linkText.length < 10) return [];
            const links = [];

            const linkRegex = /"link":"([^"]*)"[^}]*"resolutionStr":"([^"]*)"/g;
            let linkMatch;
            while ((linkMatch = linkRegex.exec(linkText)) !== null) {
                const link = linkMatch[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
                links.push({ resolution: linkMatch[2], url: link, provider: source.name });
            }

            const hlsRegex = /"hls"[^}]*"url":"([^"]*)"[^}]*"hardsub_lang":"en-US"/g;
            while ((linkMatch = hlsRegex.exec(linkText)) !== null) {
                const link = linkMatch[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
                links.push({ resolution: 'hls', url: link, provider: source.name });
            }

            // Also handle plain hls without hardsub filter
            if (links.length === 0) {
                const hlsAny = /"hls"[^}]*"url":"([^"]*)"/g;
                while ((linkMatch = hlsAny.exec(linkText)) !== null) {
                    const link = linkMatch[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
                    links.push({ resolution: 'hls', url: link, provider: source.name });
                }
            }

            return links;
        })
    );

    for (const result of providerResults) {
        if (result.status === 'fulfilled') {
            allLinks.push(...result.value);
        }
    }

    if (allLinks.length === 0) return null;

    // Sort: prefer HLS (adaptive bitrate) over direct MP4
    allLinks.sort((a, b) => {
        const aHls = a.url.includes('.m3u8') || a.resolution.toLowerCase() === 'hls' ? 0 : 1;
        const bHls = b.url.includes('.m3u8') || b.resolution.toLowerCase() === 'hls' ? 0 : 1;
        return aHls - bHls;
    });

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

// Daily popular/trending anime
async function getDailyPopular(mode = 'sub') {
    const gql = `query($type: VaildPopularTypeEnumType!, $size: Int!, $dateRange: Int, $page: Int) { queryPopular(type: $type, size: $size, dateRange: $dateRange, page: $page) { recommendations { anyCard { _id name availableEpisodes __typename } } } }`;
    const variables = JSON.stringify({ type: 'anime', size: 25, dateRange: 1, page: 1 });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const data = await allanimeGet(apiUrl);

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

    // Attach covers
    try {
        const titles = results.slice(0, 15).map(r => r.name);
        const anilistData = await getAniListCovers(titles);
        for (const r of results) {
            const info = anilistData[r.name];
            r.cover = info?.cover || null;
            r.description = info?.description || null;
            r.title_english = r.title_english || info?.title_english || null;
        }
    } catch { /* non-critical */ }

    return results;
}

// AniList airing schedule
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

// AniList cover image + description lookup (batched)
async function getAniListCovers(titles) {
    const needed = titles.filter(t => {
        if (!coverCache[t]) return true;
        const ttl = coverCache[t].url ? COVER_CACHE_TTL : COVER_CACHE_FAIL_TTL;
        return (Date.now() - coverCache[t].at) > ttl;
    });
    if (needed.length === 0) {
        return titles.reduce((acc, t) => {
            acc[t] = { cover: coverCache[t]?.url || null, description: coverCache[t]?.description || null, title_english: coverCache[t]?.title_english || null };
            return acc;
        }, {});
    }

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
            batch.forEach(title => {
                if (!coverCache[title]) coverCache[title] = { url: null, at: Date.now() };
            });
        }
    }

    return titles.reduce((acc, t) => {
        acc[t] = { cover: coverCache[t]?.url || null, description: coverCache[t]?.description || null, title_english: coverCache[t]?.title_english || null };
        return acc;
    }, {});
}

// Anime info lookup (AniList primary, Jikan/MAL fallback)
async function getAnimeInfo(title) {
    const searchTitle = TITLE_MAP[title] || title;
    if (infoCache[title] && (Date.now() - infoCache[title].at) < INFO_CACHE_TTL) {
        return infoCache[title];
    }

    // Try AniList first
    try {
        const gql = `query ($search: String) { Page(perPage: 1) { media(search: $search, type: ANIME) { description(asHtml: false) coverImage { large } genres averageScore } } }`;
        const resp = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: gql, variables: { search: searchTitle } }),
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

// Export all API functions
window.API = {
    searchAnime,
    searchAniList,
    getEpisodeList,
    getEpisodeUrl,
    getDailyPopular,
    getAiringSchedule,
    getAniListCovers,
    getAnimeInfo,
    TITLE_MAP
};
