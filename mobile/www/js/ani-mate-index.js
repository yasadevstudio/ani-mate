'use strict';
/**
 * Local content index for the mobile app — the retrieval half of hybrid search.
 *
 * Same job as server/search-index.js, and the same reason: AllAnime matches
 * titles by substring and AniList's `search:` is a fuzzy TITLE match, so a query
 * describing a show rather than naming it retrieved nothing at all. Scoring
 * cannot fix that, because there was no result set to score.
 *
 * Mobile has no filesystem, so the corpus lives in localStorage. It is kept
 * deliberately smaller than the server's: fewer entries and shorter descriptions,
 * because localStorage is a few megabytes and shared with everything else.
 *
 * What it is: lexical retrieval over description, genres and tags. It finds
 * Apothecary Diaries for "apothecary in the imperial palace" because the synopsis
 * says so. It does not infer meaning — that needs an embedding model.
 */
(function () {
    const KEY = 'animate_content_index_v1';
    const MAX_ENTRIES = 1200;
    const MAX_DESC = 480;

    const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'is', 'it',
        'for', 'with', 'his', 'her', 'its', 'that', 'this', 'be', 'are', 'as', 'at',
        'by', 'from', 'or', 'was', 'were', 'who', 'what', 'about', 'anime', 'series',
        'season', 'show', 'one', 'they', 'their', 'but', 'has', 'have', 'not', 'she',
        'he', 'him', 'you', 'all', 'can', 'will', 'when', 'into', 'out', 'up', 'there']);

    function tok(s) {
        return (s || '').toLowerCase()
            .replace(/<[^>]*>/g, ' ')
            .replace(/&[a-z]+;/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .split(' ')
            .filter(w => w.length > 2 && !STOP.has(w));
    }

    let IDX = null;
    let dirty = false;

    function load() {
        if (IDX) return IDX;
        try {
            IDX = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (!IDX || !IDX.byId) throw new Error('shape');
        } catch {
            IDX = { byId: {}, saved_at: 0 };
        }
        return IDX;
    }

    function save() {
        if (!dirty) return;
        const ix = load();
        const ids = Object.keys(ix.byId);
        if (ids.length > MAX_ENTRIES) {
            ids.sort((a, b) => (ix.byId[b].pop || 0) - (ix.byId[a].pop || 0));
            const keep = {};
            for (const id of ids.slice(0, MAX_ENTRIES)) keep[id] = ix.byId[id];
            ix.byId = keep;
        }
        ix.saved_at = Date.now();
        try {
            localStorage.setItem(KEY, JSON.stringify(ix));
            dirty = false;
        } catch {
            // Out of quota. Halve it and try once; an index that cannot be written
            // is still usable for this session.
            const ids2 = Object.keys(ix.byId)
                .sort((a, b) => (ix.byId[b].pop || 0) - (ix.byId[a].pop || 0))
                .slice(0, Math.floor(MAX_ENTRIES / 2));
            const keep = {};
            for (const id of ids2) keep[id] = ix.byId[id];
            ix.byId = keep;
            try { localStorage.setItem(KEY, JSON.stringify(ix)); dirty = false; } catch { /* give up */ }
        }
    }

    function upsert(items) {
        const ix = load();
        let n = 0;
        for (const a of items || []) {
            const id = a.anilist_id || a.id;
            if (!id) continue;
            const desc = (a.description || '').replace(/<[^>]*>/g, ' ').slice(0, MAX_DESC);
            const prev = ix.byId[id];
            if (prev && prev.desc && !desc) continue;
            ix.byId[id] = {
                id,
                romaji: a.title_romaji || prev?.romaji || null,
                english: a.title_english || prev?.english || null,
                desc: desc || prev?.desc || '',
                genres: a.genres?.length ? a.genres : (prev?.genres || []),
                tags: a.tags?.length ? a.tags : (prev?.tags || []),
                start: a.start_key || prev?.start || 0,
                pop: a.popularity || prev?.pop || 0,
                fmt: a.format || prev?.fmt || null,
                adult: a.isAdult ?? prev?.adult ?? false,
            };
            n++;
        }
        if (n) { dirty = true; save(); }
        return n;
    }

    function search(q, opts) {
        const { limit = 8, nsfw = false } = opts || {};
        const ix = load();
        const qt = [...new Set(tok(q))];
        if (!qt.length) return [];
        const entries = Object.values(ix.byId).filter(e => nsfw || !e.adult);
        if (!entries.length) return [];

        const docs = entries.map(e => tok([
            e.desc, (e.genres || []).join(' '), (e.tags || []).join(' '),
            e.romaji, e.english,
        ].join(' ')));
        const N = docs.length;
        const avgdl = docs.reduce((a, d) => a + d.length, 0) / N || 1;
        const df = Object.create(null);
        for (const d of docs) for (const w of new Set(d)) df[w] = (df[w] || 0) + 1;

        const k1 = 1.5, b = 0.75;
        const scored = [];
        for (let i = 0; i < N; i++) {
            const d = docs[i];
            if (!d.length) continue;
            const tf = Object.create(null);
            for (const w of d) tf[w] = (tf[w] || 0) + 1;
            let s = 0, hits = 0;
            for (const w of qt) {
                const f = tf[w];
                if (!f) continue;
                hits++;
                const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
                s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
            }
            // Coverage floor. A fixed RATIO punishes long queries: six tokens with
            // three matched is 0.5, and a 0.6 bar rejects the right answer. Absolute
            // floor plus a loose ratio, then a score gate below trims the noise.
            if (hits < 2 || hits / qt.length < 0.4) continue;
            s *= 1 + Math.log10(1 + (entries[i].pop || 0)) / 12;
            scored.push({ entry: entries[i], score: s });
        }
        scored.sort((a, c) => c.score - a.score);
        const top = scored.length ? scored[0].score : 0;
        return scored.filter(h => h.score >= top * 0.45).slice(0, limit);
    }

    /** Fill from AniList popularity so concept search works on a fresh install. */
    async function seed(pages = 4, perPage = 50) {
        const gql = `query ($page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
                media(type: ANIME, sort: [POPULARITY_DESC]) {
                    id title { romaji english } description(asHtml: false)
                    genres isAdult popularity format
                    startDate { year month day } seasonYear
                    tags { name rank isGeneralSpoiler }
                }
            }
        }`;
        let total = 0;
        for (let p = 1; p <= pages; p++) {
            try {
                const resp = await fetch('https://graphql.anilist.co', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ query: gql, variables: { page: p, perPage } }),
                    signal: AbortSignal.timeout(15000),
                });
                const json = await resp.json();
                const media = json?.data?.Page?.media || [];
                if (!media.length) break;
                total += upsert(media.map(m => ({
                    anilist_id: m.id,
                    title_romaji: m.title?.romaji || null,
                    title_english: m.title?.english || null,
                    description: m.description || '',
                    genres: m.genres || [],
                    tags: (m.tags || []).filter(t => !t.isGeneralSpoiler && (t.rank ?? 0) >= 40).map(t => t.name),
                    popularity: m.popularity || 0,
                    format: m.format,
                    isAdult: m.isAdult || false,
                    start_key: (() => {
                        const y = m.startDate?.year || m.seasonYear || 0;
                        return y ? y * 10000 + (m.startDate?.month || 0) * 100 + (m.startDate?.day || 0) : 0;
                    })(),
                })));
                await new Promise(r => setTimeout(r, 800));
            } catch { break; }
        }
        return total;
    }

    function stats() {
        const ix = load();
        return { entries: Object.keys(ix.byId).length, saved_at: ix.saved_at };
    }

    /** Seed once in the background, well after startup, and only if nearly empty. */
    function seedIfEmpty() {
        if (stats().entries >= 200) return;
        setTimeout(() => { seed().catch(() => {}); }, 8000);
    }

    window.CONTENT_INDEX = { upsert, search, seed, seedIfEmpty, stats, tok };
})();
