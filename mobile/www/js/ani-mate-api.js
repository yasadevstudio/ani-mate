// YASA PRESENTS
// ani-mate-api.js - ANI-MATE Client-Side API Module (Android)
// Ported from server-side ani-mate-server.js for Capacitor with CapacitorHttp

const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0';
const ALLANIME_REFR = 'https://allanime.to';
const ALLANIME_API = 'https://api.allanime.day/api';

// Title corrections for AllAnime names that don't match AniList/MAL
const TITLE_MAP = {
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

// ⛔ ALLANIME MUST BE POST. GET IS CLOUDFLARE-BLOCKED AND ALWAYS HAS BEEN.
// Measured 2026-10-05 against the live API, same machine, same minute:
//     GET  https://api.allanime.day/api?variables=...&query=...  -> 403, "Just a moment..."
//     POST https://api.allanime.day/api  {variables, query}       -> 200
// The desktop server has used POST since v0.4.4 (server/ani-mate-server.js lines 187, 240),
// which is the entire reason desktop worked and mobile did not. DEVELOPMENT.md line 19 has
// said "POST ... GET is Cloudflare-blocked" since April.
//
// The 2026-08-25 note in this file concluded the challenge was "unsolvable" and shipped the
// source disabled. It was never a challenge. It was the wrong verb.
//
// Mobile builds its URLs as `${ALLANIME_API}?${params}`, so this splits the query string
// back out and sends it as a JSON body. Call sites keep passing a URL and do not change.
function allanimeSplit(url) {
    const u = new URL(url);
    const variables = u.searchParams.get('variables');
    const query = u.searchParams.get('query');
    return {
        endpoint: u.origin + u.pathname,
        body: JSON.stringify({
            variables: variables ? JSON.parse(variables) : undefined,
            query: query || undefined,
        }),
    };
}

// AllAnime GET request returning parsed JSON.
// THROWS on failure — see allanimeGetSafe below, which is what callers must use.
async function allanimeGet(url) {
    if (CapHttp) {
        const { endpoint, body } = allanimeSplit(url);
        const resp = await CapHttp.post({
            url: endpoint,
            headers: { ...ALLANIME_HEADERS, 'Content-Type': 'application/json' },
            data: JSON.parse(body),
        });
        if (resp.status !== 200) throw new Error(`AllAnime HTTP ${resp.status}`);
        // CapHttp auto-parses JSON if content-type is application/json
        if (typeof resp.data === 'string') {
            if (resp.data.trimStart().startsWith('<')) throw new Error('AllAnime returned HTML (Cloudflare challenge)');
            return JSON.parse(resp.data);
        }
        return resp.data;
    }
    const { endpoint, body } = allanimeSplit(url);
    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { ...ALLANIME_HEADERS, 'Content-Type': 'application/json' },
        body,
    });
    if (!resp.ok) throw new Error(`AllAnime HTTP ${resp.status}`);
    return resp.json();
}

// Non-throwing form, and it is worth keeping for its own sake: a throwing call aborted its
// caller before any fallback could run, so one dead source made the whole app look dead
// rather than merely sourceless. The redundancy chain existed and was unreachable.
//
// THE 403 IT WAS WRITTEN FOR WAS NOT A CHALLENGE. It was a GET against an endpoint that
// only accepts POST — fixed above, measured 2026-10-05. The wrapper stays because sources
// will keep dying for real reasons; the diagnosis in the old note was simply wrong.
// Returns null instead of throwing.
async function allanimeGetSafe(url) {
    try { return await allanimeGet(url); }
    catch (e) { return null; }
}

// AllAnime GET request returning raw text
async function allanimeGetText(url) {
    if (CapHttp) {
        const { endpoint, body } = allanimeSplit(url);
        const resp = await CapHttp.post({
            url: endpoint,
            headers: { ...ALLANIME_HEADERS, 'Content-Type': 'application/json' },
            data: JSON.parse(body),
            responseType: 'text'
        });
        if (resp.status !== 200) throw new Error(`AllAnime HTTP ${resp.status}`);
        return typeof resp.data === 'object' ? JSON.stringify(resp.data) : String(resp.data);
    }
    const { endpoint, body } = allanimeSplit(url);
    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { ...ALLANIME_HEADERS, 'Content-Type': 'application/json' },
        body,
    });
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

// Raw AllAnime title search. Split out of searchAnime() so the content-index
// fallback can resolve a concept hit back to a playable entry without recursing
// through the whole merge.
async function allAnimeSearchRaw(query, mode = 'sub', allowAdult = false) {
    const searchGql = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } } }`;

    const variables = JSON.stringify({
        search: { allowAdult, allowUnknown: false, query },
        limit: 40,
        page: 1,
        translationType: mode,
        countryOrigin: 'ALL'
    });

    const params = new URLSearchParams({ variables, query: searchGql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;
    const data = await allanimeGetSafe(apiUrl);

    const out = [];
    if (data?.data?.shows?.edges) {
        for (const show of data.data.shows.edges) {
            const epCount = show.availableEpisodes?.[mode] || 0;
            if (epCount > 0) {
                const type = epCount === 1 ? 'movie' : epCount <= 12 ? 'short' : 'series';
                out.push({ id: show._id, name: show.name, episodes: epCount, type });
            }
        }
    }
    return out;
}

// Search anime via AllAnime GraphQL, then merge, group and rank.
async function searchAnime(query, mode = 'sub', allowAdult = false) {
    const results = await allAnimeSearchRaw(query, mode, allowAdult);
    results.sort((a, b) => b.episodes - a.episodes);

    // Dual-source search: AllAnime (primary/streams) + AniList (fuzzy/romaji)
    const aniListResults = await searchAniList(query, 15).catch(() => []);

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

    // Season number from a title. Absent means season 1.
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

    // Multi-pass AniList matching: exact -> base title -> prefix.
    // Mobile previously did EXACT ONLY, so most entries got no AniList data at all
    // and therefore no date, no franchise and no content text to search on.
    // Passes 2 and 3 require the SEASON NUMBERS TO AGREE, otherwise "... Season 3"
    // matches the season 1 entry and inherits its date, cover and description.
    function findAniMatch(name, aniResults) {
        const n = normName(name);
        const nBase = stripSeason(n);
        const nSeason = seasonNum(n);
        let m = aniResults.find(a =>
            (a.title_romaji && normName(a.title_romaji) === n) ||
            (a.title_english && normName(a.title_english) === n));
        if (m) return m;
        m = aniResults.find(a => {
            const rN = normName(a.title_romaji || ''), eN = normName(a.title_english || '');
            const rB = stripSeason(rN), eB = stripSeason(eN);
            if (rB && rB === nBase && seasonNum(rN) === nSeason) return true;
            if (eB && eB === nBase && seasonNum(eN) === nSeason) return true;
            return false;
        });
        if (m) return m;
        if (n.length >= 8) {
            m = aniResults.find(a => {
                const r = normName(a.title_romaji || ''), e = normName(a.title_english || '');
                const okR = r.length >= 8 && (r.startsWith(n) || n.startsWith(r)) && seasonNum(r) === nSeason;
                const okE = e.length >= 8 && (e.startsWith(n) || n.startsWith(e)) && seasonNum(e) === nSeason;
                return okR || okE;
            });
        }
        return m || null;
    }

    // Everything AniList returned goes into the local content index, so the
    // corpus grows from ordinary use.
    try { window.CONTENT_INDEX?.upsert(aniListResults); } catch { /* never block a search */ }

    // Enrich AllAnime results with AniList data
    for (const r of results) {
        const rNorm = normName(r.name);
        let aniMatch = findAniMatch(r.name, aniListResults);
        // Fallback: check TITLE_MAP alias (e.g. "1P" → "One Piece"), case-insensitive
        const aliasKey = Object.keys(TITLE_MAP).find(k => k.toLowerCase() === r.name.toLowerCase());
        if (!aniMatch && aliasKey) {
            const aliasNorm = normName(TITLE_MAP[aliasKey]);
            aniMatch = aniListResults.find(a =>
                !a.isAdult &&
                ((a.title_romaji && normName(a.title_romaji) === aliasNorm) ||
                (a.title_english && normName(a.title_english) === aliasNorm))
            ) || aniListResults.find(a =>
                (a.title_romaji && normName(a.title_romaji) === aliasNorm) ||
                (a.title_english && normName(a.title_english) === aliasNorm)
            );
        }
        // If TITLE_MAP matched, fix the display name (abbreviation → real title)
        if (aliasKey) {
            r.name = (aniMatch?.title_romaji) || TITLE_MAP[aliasKey];
            if (!r.title_english) r.title_english = aniMatch?.title_english || null;
        }
        // If aniMatch is adult but AllAnime source isn't marked adult, skip the match
        if (aniMatch && aniMatch.isAdult) {
            const nameMatch = normName(aniMatch.title_romaji) === rNorm || normName(aniMatch.title_english) === rNorm;
            if (!nameMatch && !aliasKey) aniMatch = null;
        }
        if (aniMatch) {
            if (!r.title_english) r.title_english = aniMatch.title_english;
            r.cover = r.cover || aniMatch.cover;
            r.description = r.description || aniMatch.description;
            r.anilist_format = aniMatch.format;
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
        if (!allowAdult && a.isAdult) return false; // Skip adult AniList results when NSFW off
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
                search: { allowAdult, allowUnknown: false, query: searchName },
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
        aniIdFormat[a.anilist_id] = a.format;
        aniIdStart[a.anilist_id] = a.start_key || 0;
        aniIdPop[a.anilist_id] = a.popularity || 0;
        // Synonyms catch alternate romanisations the two sources disagree
        // on, which is one way an entry sits ungrouped beside its own franchise.
        for (const syn of (a.synonyms || [])) {
            const k = normName(syn);
            if (k && !nameToAniId[k]) nameToAniId[k] = a.anilist_id;
        }
        if (a.relations) {
            for (const rel of a.relations) {
                if (rel.title_romaji) nameToAniId[normName(rel.title_romaji)] = rel.id;
                if (rel.title_english) nameToAniId[normName(rel.title_english)] = rel.id;
                aniIdFormat[rel.id] = rel.format;
                if (rel.start_key) aniIdStart[rel.id] = rel.start_key;
            }
        }
    }
    for (const a of aniListResults) {
        if (!a.relations) continue;
        for (const rel of a.relations) ufUnion(a.anilist_id, rel.id);
    }

    // Name-pattern franchise overrides (catches series AniList doesn't link)
    const FRANCHISE_PATTERNS = [
        'jujutsu kaisen', 'one piece', 'attack on titan', 'shingeki no kyojin',
        'demon slayer', 'kimetsu no yaiba', 'my hero academia', 'boku no hero academia',
        'sword art online', 'naruto', 'dragon ball', 'bleach', 'hunter x hunter',
        'fullmetal alchemist', 'mob psycho', 're zero', 'overlord', 'konosuba',
    ];
    for (const pattern of FRANCHISE_PATTERNS) {
        const matchingIds = Object.entries(nameToAniId)
            .filter(([name]) => name.startsWith(pattern) || name === pattern)
            .map(([, id]) => id);
        for (let i = 1; i < matchingIds.length; i++) ufUnion(matchingIds[0], matchingIds[i]);
    }

    for (const r of results) {
        const rNorm = normName(r.name);
        const rEnNorm = r.title_english ? normName(r.title_english) : null;
        const aniId = nameToAniId[rNorm] || (rEnNorm && nameToAniId[rEnNorm]);
        if (aniId) {
            r.anilist_id = aniId;
            r.franchise_id = String(ufFind(aniId));
            if (!r.anilist_format) r.anilist_format = aniIdFormat[aniId] || null;
            // A result matched only by id here never went through the enrich loop
            // above, so it would otherwise carry no date and sort wrong.
            if (!r.start_key) r.start_key = aniIdStart[aniId] || 0;
            if (!r.popularity) r.popularity = aniIdPop[aniId] || 0;
        }
    }

    // Last-chance franchise grouping: anything still without a franchise_id whose
    // season-stripped title matches one that HAS a franchise joins it. Two AllAnime
    // entries for one show (romaji and English) otherwise sit side by side, one
    // grouped and one orphaned.
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
    const filtered = (!allowAdult)
        ? results.filter(r => !(r.genres && r.genres.includes('Hentai')))
        : results;

    // ── CONTENT RETRIEVAL FALLBACK ───────────────────────────────────────────
    // Both upstream sources match titles only, so a query describing a show rather
    // than naming it retrieves NOTHING and there is no result set to rank. Search
    // the local corpus and resolve hits back to playable AllAnime entries.
    // Fire ONLY when the title search genuinely failed: nothing at all, or nothing
    // that matches a title well. Triggering on a small-but-good result set pads a
    // correct answer with loose content matches.
    const bestTitleKw = filtered.length
        ? Math.max(...filtered.map(r => keywordScore(query, r, normName)))
        : 0;
    if ((filtered.length === 0 || bestTitleKw < 45) && window.CONTENT_INDEX) {
        try {
            const hits = window.CONTENT_INDEX.search(query, { limit: 6, nsfw: allowAdult });
            const have = new Set(filtered.map(r => normName(r.name)));
            for (const h of hits) {
                const nm = h.entry.romaji || h.entry.english;
                if (!nm || have.has(normName(nm))) continue;
                const sub = await allAnimeSearchRaw(nm, mode, allowAdult).catch(() => []);
                if (!sub.length) continue;
                const match = sub[0];
                if (have.has(normName(match.name))) continue;
                match.description = h.entry.desc;
                match.title_english = match.title_english || h.entry.english;
                match.genres = h.entry.genres || [];
                match.tags = h.entry.tags || [];
                match.start_key = h.entry.start || 0;
                match.popularity = h.entry.pop || 0;
                match.anilist_id = h.entry.id;
                match.anilist_format = h.entry.fmt || null;
                match.from_content_index = true;
                filtered.push(match);
                have.add(normName(match.name));
            }
        } catch { /* the title results still stand */ }
    }

    // Rank the MERGED set. Until now AllAnime's order was kept as-is and AniList-only
    // titles were appended, with no scoring anywhere.
    try { rankResults(query, filtered, normName); } catch { /* order just stays as-is */ }

    // Nothing came back from the legacy path — every source it knows may be down.
    // Fall through to the redundant chain, which carries its own transports and its
    // own failover. Ids from there are provider-tagged ("anidb:3880") and the episode
    // and stream calls below route on that tag.
    if (!filtered.length && window.SOURCES) {
        try {
            const alt = await window.SOURCES.search(query, mode);
            if (alt.length) {
                return alt.map(a => {
                    const eps = Number(a.episodes) || 0;
                    return {
                        id: a.id,
                        name: a.name,
                        episodes: eps,
                        type: eps === 1 ? 'movie' : eps > 0 && eps <= 12 ? 'short' : 'series',
                        source: a.provider || 'fallback'
                    };
                });
            }
        } catch (e) { /* chain exhausted — return empty, the UI reports it */ }
    }
    return filtered;
}

// Provider-tagged ids come from window.SOURCES and must route back to their owner.
function isTagged(id) {
    return typeof id === 'string' && /^[a-z]+:/.test(id);
}

// The trending list is built from AniList, which knows titles but no streaming ids.
// Those entries carry "search:<title>" and are resolved to a real provider id the
// first time they are opened. Resolved ids are memoised for the session so opening
// the same show twice does not search twice.
const resolvedIds = new Map();
async function resolveSearchId(taggedId, mode = 'sub') {
    if (!taggedId.startsWith('search:')) return taggedId;
    if (resolvedIds.has(taggedId)) return resolvedIds.get(taggedId);
    const title = taggedId.slice(7);
    let real = null;
    try {
        const hits = await window.SOURCES.search(title, mode);
        if (hits.length) {
            const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const want = norm(title);
            const exact = hits.find(h => norm(h.name) === want);
            real = (exact || hits[0]).id;
        }
    } catch { /* leave null */ }
    resolvedIds.set(taggedId, real);
    return real;
}


// Release date as one sortable integer, 0 when the date is unknown. An undated
// entry sorts to the front rather than disappearing, so ordering stays stable.
function dateKey(d, seasonYear) {
    const y = d?.year || seasonYear || 0;
    if (!y) return 0;
    return y * 10000 + (d?.month || 0) * 100 + (d?.day || 0);
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

// Get episode list for a show
async function getEpisodeList(showId, mode = 'sub') {
    if (isTagged(showId) && window.SOURCES) {
        const real = await resolveSearchId(showId, mode);
        if (!real) return [];
        const eps = await window.SOURCES.episodes(real, mode).catch(() => []);
        return eps.map(e => e.number);
    }
    const gql = `query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail } }`;
    const variables = JSON.stringify({ showId });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const data = await allanimeGetSafe(apiUrl);

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
    if (isTagged(showId) && window.SOURCES) {
        // The provider owns the episode id; SOURCES built it during getEpisodeList.
        const real = await resolveSearchId(showId, mode);
        if (!real) return null;
        const pid = real.slice(0, real.indexOf(':'));
        const eps = await window.SOURCES.episodes(real, mode).catch(() => []);
        const hit = eps.find(e => String(e.number) === String(episodeString)) || null;
        if (hit) {
            const s = await window.SOURCES.stream(hit.id, mode).catch(() => null);
            // SUBTITLES MUST BE CARRIED THROUGH. This line used to build a fresh object
            // with only url/referer/source, which silently dropped the subtitle array the
            // provider had just resolved — so even a source that returns tracks produced a
            // player with none, indistinguishable from a source that has none.
            if (s) return { url: s.url, referer: s.referer, source: s.providerName || pid,
                            subtitles: s.subtitles || [], malId: s.malId || null };
        }
        return null;
    }
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

// Trending, without a streaming source. AniList answered every request during the
// 2026-08-25 audit while every streaming host was walled, so it is the sturdier list.
// Titles resolve to a playable id through the normal search chain when tapped.
async function getTrendingFallback(mode = 'sub') {
    const gql = `query { Page(page:1, perPage:25) { media(sort:TRENDING_DESC, type:ANIME, isAdult:false) {
        id title{romaji english} episodes format coverImage{large} description(asHtml:false) } } }`;
    const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: gql }),
        signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return [];
    const j = await r.json();
    const media = j?.data?.Page?.media || [];
    return media.map(m => {
        const eps = Number(m.episodes) || 0;
        const name = m.title?.romaji || m.title?.english;
        if (!name) return null;
        return {
            id: 'search:' + name,
            name,
            title_english: m.title?.english || null,
            episodes: eps,
            type: m.format === 'MOVIE' ? 'movie' : eps > 0 && eps <= 12 ? 'short' : 'series',
            cover: m.coverImage?.large || null,
            description: (m.description || '').replace(/<[^>]+>/g, ''),
            source: 'anilist'
        };
    }).filter(Boolean);
}

// Daily popular/trending anime
async function getDailyPopular(mode = 'sub') {
    const gql = `query($type: VaildPopularTypeEnumType!, $size: Int!, $dateRange: Int, $page: Int) { queryPopular(type: $type, size: $size, dateRange: $dateRange, page: $page) { recommendations { anyCard { _id name availableEpisodes __typename } } } }`;
    const variables = JSON.stringify({ type: 'anime', size: 25, dateRange: 1, page: 1 });
    const params = new URLSearchParams({ variables, query: gql });
    const apiUrl = `${ALLANIME_API}?${params.toString()}`;

    const data = await allanimeGetSafe(apiUrl);

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

    // AllAnime is the only source that answers queryPopular, and when it is walled this
    // list comes back empty. Fall back to AniList's own trending query, which needs no
    // streaming source to build the list — the ids are resolved by search on click.
    if (!results.length) {
        try {
            const trending = await getTrendingFallback(mode);
            if (trending.length) results.push(...trending);
        } catch { /* leave empty; the UI reports it */ }
    }

    // Attach covers
    try {
        const titles = results.slice(0, 15).map(r => r.name);
        const anilistData = await getAniListCovers(titles);
        for (const r of results) {
            const info = anilistData[r.name];
            r.cover = r.cover || info?.cover || null;
            r.description = r.description || info?.description || null;
            r.title_english = r.title_english || info?.title_english || null;
        }
    } catch { /* non-critical */ }

    return results;
}

// AniList airing schedule
async function getAiringSchedule(dateStr) {
    const now = new Date();
    // Parse date as local midnight (dateStr should be YYYY-MM-DD in local time)
    let target;
    if (dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        target = new Date(y, m - 1, d); // local midnight
    } else {
        target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const cacheKey = dateStr || target.toISOString().slice(0, 10);

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
    const titleMapKey = Object.keys(TITLE_MAP).find(k => k.toLowerCase() === title.toLowerCase());
    const searchTitle = (titleMapKey && TITLE_MAP[titleMapKey]) || title;
    if (infoCache[title] && (Date.now() - infoCache[title].at) < INFO_CACHE_TTL) {
        return infoCache[title];
    }

    // Try AniList first (fetch 3 results, prefer non-adult match)
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
    } catch { /* fall through to Jikan */ }

    // Jikan/MAL fallback
    try {
        const resp = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchTitle)}&limit=1`, {
            signal: AbortSignal.timeout(5000)
        });
        const json = await resp.json();
        const anime = json?.data?.[0];
        if (anime) {
            const result = { description: anime.synopsis || null, cover: anime.images?.jpg?.large_image_url || null, banner: null, genres: (anime.genres || []).map(g => g.name), score: anime.score ? anime.score * 10 : null, source: 'mal', at: Date.now() };
            infoCache[title] = result;
            return result;
        }
    } catch { /* no fallback */ }

    const empty = { description: null, cover: null, banner: null, genres: [], score: null, source: null, at: Date.now() };
    infoCache[title] = empty;
    return empty;
}

// Export all API functions
window.API = {
    decodeProviderId,
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
