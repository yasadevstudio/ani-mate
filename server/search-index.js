'use strict';
/**
 * Local content index — the retrieval half of hybrid search.
 *
 * WHY THIS EXISTS
 * Both upstream sources only match TITLES. AllAnime does a substring match on the
 * name; AniList's `search:` is a fuzzy title match. Neither looks at what a show
 * is about. So a query like "apothecary in the imperial palace" returned nothing
 * at all — not badly ranked, literally zero candidates — because no title contains
 * those words.
 *
 * Scoring alone could not fix that. You cannot rank a result set that was never
 * retrieved. This keeps a local corpus of descriptions, genres and tags, and runs
 * BM25 over it when the title search comes up short.
 *
 * WHAT IT IS, PRECISELY
 * Lexical retrieval over meaning-bearing text. It finds Apothecary Diaries for
 * "apothecary in the imperial palace" because the synopsis says that. It will not
 * infer that "medicine girl royal court" means the same thing — that needs
 * sentence embeddings and a vector index, which is a different build with a model
 * dependency. This has no dependencies and no model.
 *
 * The corpus grows from ordinary use: every search and every trending fetch upserts
 * what it saw. `seed()` fills it from AniList's popularity ranking so it is useful
 * before the user has searched for anything.
 */

const fs = require('fs');
const path = require('path');

// The index must live in the USER data directory, not next to the code.
// server/ ships inside asarUnpack, which on Windows lands under Program Files and
// is not writable by a normal user — the index would silently fail to save and the
// app would re-seed from AniList on every single launch. ANI_MATE_DATA_DIR is the
// same writable path main.js already hands the server for watch history.
const DIR = process.env.ANI_MATE_DATA_DIR
    || process.env.ANI_CLI_HIST_DIR
    || `${process.env.XDG_STATE_HOME || `${process.env.HOME || process.env.USERPROFILE}/.local/state`}/ani-cli`;
const FILE = path.join(DIR, 'search-index.json');
const MAX_ENTRIES = 6000;        // ~12 MB of descriptions, bounded on purpose
const MAX_DESC = 900;            // characters kept per entry

let IDX = null;                  // { byId: { anilist_id: entry }, saved_at }
let dirty = false;

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

function load() {
    if (IDX) return IDX;
    try {
        IDX = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!IDX || typeof IDX !== 'object' || !IDX.byId) throw new Error('shape');
    } catch {
        IDX = { byId: {}, saved_at: 0 };
    }
    return IDX;
}

function save() {
    if (!dirty) return;
    try {
        fs.mkdirSync(DIR, { recursive: true });
        const ids = Object.keys(IDX.byId);
        // Bounded. When it overflows, the least popular entries go first — they are
        // the least likely to be what anyone was looking for.
        if (ids.length > MAX_ENTRIES) {
            ids.sort((a, b) => (IDX.byId[b].pop || 0) - (IDX.byId[a].pop || 0));
            const keep = {};
            for (const id of ids.slice(0, MAX_ENTRIES)) keep[id] = IDX.byId[id];
            IDX.byId = keep;
        }
        IDX.saved_at = Date.now();
        fs.writeFileSync(FILE, JSON.stringify(IDX));
        dirty = false;
    } catch { /* an index that cannot be written is still usable in memory */ }
}

/** Add or refresh entries. Accepts AniList-shaped records. */
function upsert(items) {
    const ix = load();
    let n = 0;
    for (const a of items || []) {
        const id = a.anilist_id || a.id;
        if (!id) continue;
        const desc = (a.description || '').replace(/<[^>]*>/g, ' ').slice(0, MAX_DESC);
        const prev = ix.byId[id];
        // Do not overwrite a full record with a thinner one.
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
    if (n) dirty = true;
    return n;
}

/** BM25 over description + genres + tags + titles. Returns scored entries. */
function search(q, { limit = 12, nsfw = false } = {}) {
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
        // Coverage floor. A fixed RATIO punishes long queries: "giant titans eat
        // humans behind walls" is six tokens, so matching three is 0.5 and a 0.6
        // bar rejects the right answer. Use an absolute floor plus a loose ratio,
        // then trim noise with a score gate relative to the best hit instead.
        if (hits < 2 || hits / qt.length < 0.4) continue;
        s *= 1 + Math.log10(1 + (entries[i].pop || 0)) / 12;   // gentle popularity lift
        scored.push({ entry: entries[i], score: s, coverage: hits / qt.length });
    }
    scored.sort((a, b2) => b2.score - a.score);
    // Everything well below the best match is noise. In a list that was previously
    // empty, noise reads as a wrong answer.
    const top = scored.length ? scored[0].score : 0;
    return scored.filter(h => h.score >= top * 0.45).slice(0, limit);
}

/**
 * Fill the index from AniList's popularity ranking so concept search works before
 * the user has searched for anything. Safe to call repeatedly; it upserts.
 */
async function seed(pages = 10, perPage = 50, log = () => {}) {
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
            log(`  seeded page ${p}/${pages} (${total} entries)`);
            await new Promise(r => setTimeout(r, 750));   // AniList rate limit
        } catch (e) {
            log(`  page ${p} failed: ${e.message}`);
            break;
        }
    }
    save();
    return total;
}

function stats() {
    const ix = load();
    const n = Object.keys(ix.byId).length;
    const withDesc = Object.values(ix.byId).filter(e => e.desc).length;
    return { entries: n, with_description: withDesc, saved_at: ix.saved_at };
}

module.exports = { upsert, search, seed, save, stats, tok };
