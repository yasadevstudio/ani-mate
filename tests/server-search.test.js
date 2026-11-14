// YASA PRESENTS
/* What the desktop server's search does in front of sources that count, refuse and fail.
 *
 *     node tests/server-search.test.js
 *
 * No request leaves this machine. AllAnime, AniList and HiAnime are each played by a
 * stand-in in this file, and the server is pointed at them through its test addresses
 * (ANI_MATE_TEST_ALLANIME, ANI_MATE_TEST_ANILIST) and ANI_MATE_HIANIME.
 *
 * ⛔ THE ALLANIME STAND-IN COUNTS THE WAY ALLANIME WAS MEASURED TO COUNT on 2026-11-12:
 * ten searches in a window, six episode lists in a window, and after that HTTP 200 with
 * {"errors":[{"message":"Too many requests, please try again in N seconds."}]}. The
 * window here is two seconds instead of ten so the suite does not take a minute; the
 * server reads the wait out of the message, so it follows whatever the source says.
 *
 * WHAT IT CHECKS, each one seen on 2026-11-12:
 *   - three searches back to back are all answered, and the server never makes the
 *     source refuse (one search used to spend nine of the ten; the third came back empty)
 *   - a lookup for a title AllAnime does not carry brings nothing in from another source
 *     (it brought the same season back a second time, under another id and name)
 *   - a search already answered is not asked again
 *   - when someone else has used the budget, the search waits it out; it does not come
 *     back empty and it does not switch source
 *   - when AllAnime gives no answer at all, the search falls through to HiAnime
 *     (audit row 19), and the lookups do not each wait for a dead source
 *   - a refused episode list is waited out too
 *   - favorites past the 25th get their details, and they are written down (row 18)
 *   - a search with 22 rows asks AniList twice, not six times (it allows 30 a minute,
 *     and six ordinary searches in a row were measured spending 28)
 *   - a refusal from AniList is not an empty answer, and quiets every caller
 *   - POST /favorites/refresh asks about the library in two requests, not thirty, and
 *     does not ask again about a name AniList has no English title for
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const env = require(path.join(__dirname, '..', 'scripts', 'test-env.js'));

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
const section = (t) => console.log('\n' + t + ':');

// ── what the stand-ins know ──────────────────────────────────────────────────────────
const AA = {
    'apothecary diaries': [['aaApothecaryS1xxxx', 'Kusuriya no Hitorigoto', 24],
                           ['aaApothecaryS2xxxx', 'Kusuriya no Hitorigoto 2nd Season', 24],
                           ['aaApothecaryS3xxxx', 'Kusuriya no Hitorigoto 3rd Season', 6]],
    'beastars': [['aaBeastarsS1xxxxxx', 'Beastars', 12], ['aaBeastarsS2xxxxxx', 'Beastars Season 2', 12],
                 ['aaBeastarsFinal1xx', 'BEASTARS FINAL SEASON Part 1', 12],
                 ['aaBeastarsFinal2xx', 'BEASTARS FINAL SEASON Part 2', 12]],
    'frieren': [['aaFrierenS1xxxxxxx', 'Sousou no Frieren', 28]],
    /* 22 rows AniList's search knows nothing about: each needs its details looked up. */
    'many shows': Array.from({ length: 22 }, (_, i) =>
        ['manyShow' + String(i + 1).padStart(2, '0') + 'abcd', 'Many Show ' + String(i + 1).padStart(2, '0'), 12 + i]),
};
const media = (id, romaji, english, extra) => Object.assign({
    id, title: { romaji, english }, coverImage: { large: 'http://127.0.0.1/c/' + id + '.jpg', color: '#334455' },
    description: 'about ' + romaji, format: 'TV', episodes: 12, status: 'FINISHED', genres: ['Drama', 'Mystery'],
    isAdult: false, popularity: 1000 + id, startDate: { year: 2020, month: 1, day: 1 }, seasonYear: 2020,
    synonyms: [], tags: [], relations: { edges: [] },
}, extra || {});
/* Nine titles AniList lists for the search that AllAnime's own answer did not name. Each
 * one costs the old code a lookup. */
const EXTRAS = ['Maomao no Hitorigoto', 'Maomao no Hitorigoto 2nd Season', 'Kusuriya Gaiden A', 'Kusuriya Gaiden B',
                'Kusuriya Gaiden C', 'Kusuriya Gaiden D', 'Kusuriya Gaiden E', 'Kusuriya Gaiden F', 'Kusuriya Gaiden G'];
const ANI = {
    'apothecary diaries': [media(161645, 'Kusuriya no Hitorigoto', 'The Apothecary Diaries'),
                           media(176301, 'Kusuriya no Hitorigoto 2nd Season', 'The Apothecary Diaries Season 2'),
                           media(185660, 'Kusuriya no Hitorigoto 3rd Season', 'The Apothecary Diaries Season 3')]
        .concat(EXTRAS.map((t, i) => media(900 + i, t, null, { format: 'ONA' }))),
    'beastars': [media(107660, 'BEASTARS', 'BEASTARS'), media(114194, 'BEASTARS 2nd Season', 'BEASTARS Season 2'),
                 media(155783, 'BEASTARS FINAL SEASON', 'BEASTARS Final Season'),
                 media(155784, 'Beastars Gaiden A', null), media(155785, 'Beastars Gaiden B', null)],
    'frieren': [media(154587, 'Sousou no Frieren', 'Frieren: Beyond Journey\'s End')],
};
const HI = { beastars: [['beastars-5001', 'Beastars'], ['beastars-season-2-5002', 'Beastars Season 2']] };

/** One HTTP server playing all three sources. Its state is the test's to read and set. */
function makeSources() {
    const s = {
        windowMs: 2000,
        shows: { max: 10, start: 0, n: 0, asked: [], refused: 0 },
        show:  { max: 6,  start: 0, n: 0, asked: [], refused: 0 },
        allanimeDown: false,
        anilist: { requests: 0, searches: [], detailTitles: [], detailRequests: 0, nameRequests: 0, names: [] },
        anilistRefuse: false,
        hianime: { searches: [], lists: 0 },
    };
    const counted = (b, what) => {
        const now = Date.now();
        if (!b.start || now - b.start >= s.windowMs) { b.start = now; b.n = 0; }
        b.asked.push(what);
        if (b.n >= b.max) {
            b.refused++;
            const left = Math.max(1, Math.ceil((b.start + s.windowMs - now) / 1000));
            return { errors: [{ message: 'Too many requests, please try again in ' + left + ' seconds.',
                                extensions: { code: 'INTERNAL_SERVER_ERROR' } }], data: null };
        }
        b.n++;
        return null;
    };
    s.fill = (kind) => { s[kind].start = Date.now(); s[kind].n = s[kind].max; };

    s.server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const send = (code, obj, type) => {
                const out = typeof obj === 'string' ? obj : JSON.stringify(obj);
                res.writeHead(code, { 'Content-Type': type || 'application/json' });
                res.end(out);
            };
            const u = new URL(req.url, 'http://x');
            if (u.pathname === '/allanime') {
                if (s.allanimeDown) { s.shows.asked.push('(down)'); return send(403, '<html><title>Just a moment...</title></html>', 'text/html'); }
                let j = {}; try { j = JSON.parse(body); } catch (e) { /* answered as empty */ }
                const v = j.variables || {};
                if (v.search) {
                    const q = String(v.search.query || '').toLowerCase();
                    const refusal = counted(s.shows, q);
                    if (refusal) return send(200, refusal);
                    const rows = AA[q] || [];
                    return send(200, { data: { shows: { edges: rows.map(([id, name, n]) =>
                        ({ _id: id, name, availableEpisodes: { sub: n, dub: 0 } })) } } });
                }
                if (v.showId && !v.episodeString) {
                    const refusal = counted(s.show, v.showId);
                    if (refusal) return send(200, refusal);
                    return send(200, { data: { show: { _id: v.showId, availableEpisodesDetail: { sub: ['3', '1', '2'], dub: [] } } } });
                }
                return send(200, { data: {} });
            }
            if (u.pathname === '/anilist') {
                s.anilist.requests++;
                if (s.anilistRefuse) {
                    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30',
                                         'X-RateLimit-Limit': '30', 'X-RateLimit-Remaining': '0' });
                    return res.end('{"data":null,"errors":[{"message":"Too Many Requests.","status":429}]}');
                }
                let j = {}; try { j = JSON.parse(body); } catch (e) { /* answered as empty */ }
                const v = j.variables || {};
                /* English names for the library: the same variables as a details lookup,
                 * a different question. */
                if (Object.keys(v).some((k) => /^s\d+$/.test(k)) && !/description\(/.test(j.query || '')) {
                    s.anilist.nameRequests++;
                    const data = {};
                    for (const k of Object.keys(v)) {
                        s.anilist.names.push(v[k]);
                        const n = /^Favorite (\d+)$/.exec(String(v[k]));
                        const known = n && n[1] !== '07' && n[1] !== '29';
                        data['q' + k.slice(1)] = { media: known ? [
                            { title: { romaji: 'Something Else', english: 'Wrong Show' }, coverImage: { large: 'http://127.0.0.1/c/wrong.jpg' } },
                            { title: { romaji: v[k], english: v[k] + ' (EN)' }, coverImage: { large: 'http://127.0.0.1/c/n' + n[1] + '.jpg' } },
                        ] : [] };
                    }
                    return send(200, { data });
                }
                if (Object.keys(v).some((k) => /^s\d+$/.test(k))) s.anilist.detailRequests++;
                if (typeof v.search === 'string') {
                    s.anilist.searches.push(v.search);
                    return send(200, { data: { Page: { media: ANI[v.search.toLowerCase()] || [] } } });
                }
                if (Object.keys(v).some((k) => /^s\d+$/.test(k))) {
                    const data = {};
                    for (const k of Object.keys(v)) {
                        s.anilist.detailTitles.push(v[k]);
                        const n = /^Favorite (\d+)$/.exec(String(v[k]));
                        /* Favorites 7 and 29 are shows AniList has never heard of. */
                        const known = n && n[1] !== '07' && n[1] !== '29';
                        data['q' + k.slice(1)] = { media: known ? [{
                            id: 5000 + Number(n[1]), title: { romaji: v[k], english: null },
                            coverImage: { large: 'http://127.0.0.1/c/f' + n[1] + '.jpg', color: '#112233' },
                            description: 'about ' + v[k], genres: ['Action', 'Fantasy'], format: 'TV',
                            startDate: { year: 2001, month: 4, day: Number(n[1]) }, seasonYear: 2001, popularity: 77,
                        }] : [] };
                    }
                    return send(200, { data });
                }
                return send(200, { data: { Page: { pageInfo: { hasNextPage: false }, media: [], airingSchedules: [] } } });
            }
            if (u.pathname === '/hianime/search') {
                const q = String(u.searchParams.get('keyword') || '').toLowerCase();
                s.hianime.searches.push(q);
                const rows = Object.keys(HI).filter((k) => q.includes(k)).flatMap((k) => HI[k]);
                return send(200, '<html><body>' + rows.map(([slug, name]) =>
                    '<div class="flw-item"><h3 class="film-name">\n<a href="/watch/' + slug + '" title="' + name + '">' + name + '</a></h3></div>').join('')
                    + '<div id="main-sidebar"></div></body></html>', 'text/html');
            }
            if (u.pathname.startsWith('/hianime/api/theme/episode/list/')) {
                s.hianime.lists++;
                return send(200, { html: '<a data-number="1" data-id="9001"></a><a data-number="2" data-id="9002"></a>' });
            }
            send(404, { error: 'the stand-in has no ' + u.pathname });
        });
    });
    return s;
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-search-'));
    const servers = [];
    const src = makeSources();
    await new Promise((r) => src.server.listen(0, '127.0.0.1', r));
    const SRC = 'http://127.0.0.1:' + src.server.address().port;
    let seq = 0;
    /** A new server on an empty data folder: its request count starts clean. */
    async function boot(seed) {
        const dataDir = path.join(tmp, 'data-' + (++seq));
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'ani-mate-favorites.json'), JSON.stringify(seed || []));
        fs.writeFileSync(path.join(dataDir, 'ani-mate-history.json'), '[]');
        const sv = await env.appServer(dataDir, {
            ANI_MATE_TEST_ALLANIME: SRC + '/allanime',
            ANI_MATE_TEST_ANILIST: SRC + '/anilist',
            ANI_MATE_HIANIME: SRC + '/hianime',
        });
        servers.push(sv);
        sv.dataDir = dataDir;
        sv.get = async (p) => {
            const t0 = Date.now();
            const r = await fetch(sv.url.replace(/\/+$/, '') + p, { signal: AbortSignal.timeout(40000) });
            const j = await r.json();
            return { status: r.status, body: j, ms: Date.now() - t0 };
        };
        return sv;
    }
    const reset = () => {
        for (const k of ['shows', 'show']) { src[k].start = 0; src[k].n = 0; src[k].asked = []; src[k].refused = 0; }
        src.allanimeDown = false;
        src.anilist = { requests: 0, searches: [], detailTitles: [], detailRequests: 0, nameRequests: 0, names: [] };
        src.anilistRefuse = false;
        src.hianime = { searches: [], lists: 0 };
    };
    const ids = (r) => (r.body.results || []).map((x) => x.id);
    const isAllAnimeId = (id) => /^[A-Za-z0-9]{8,32}$/.test(String(id));

    try {
        // ── three searches, back to back ───────────────────────────────────────────
        section('three searches back to back');
        {
            const sv = await boot();
            reset();
            const a = await sv.get('/search?q=' + encodeURIComponent('apothecary diaries'));
            const b = await sv.get('/search?q=beastars');
            const c = await sv.get('/search?q=frieren');
            ok(AA['apothecary diaries'].every(([id]) => ids(a).includes(id)), 'the first has AllAnime\'s three seasons (' + ids(a).length + ' rows)');
            ok(AA.beastars.every(([id]) => ids(b).includes(id)), 'the second, straight after, has all four of its rows (' + ids(b).length + ')');
            ok(AA.frieren.every(([id]) => ids(c).includes(id)), 'and the third has its row (' + ids(c).length + ')');
            ok(src.shows.refused === 0, 'AllAnime refused nothing: the server stayed inside the count (' + src.shows.asked.length + ' searches sent, ' + src.shows.refused + ' refused)');
            ok(src.shows.asked.length <= 10, 'ten or fewer searches were sent for all three (' + src.shows.asked.length + ')');
            const lookups = src.shows.asked.filter((q) => EXTRAS.some((t) => t.toLowerCase() === q));
            ok(lookups.length === 6, 'of the nine titles only AniList named, six were looked up and three left for later (' + lookups.length + ')');
            ok(a.ms < 4000 && b.ms < 4000 && c.ms < 4000, 'none of them waited (' + [a.ms, b.ms, c.ms].join(', ') + ' ms)');

            section('a title AllAnime does not carry');
            const all = ids(a).concat(ids(b), ids(c));
            ok(all.every(isAllAnimeId), 'every row of all three searches is an AllAnime row');
            ok(src.hianime.searches.length === 0, 'and HiAnime was not asked for anything (' + src.hianime.searches.length + ' requests)');
            const s3 = (a.body.results || []).filter((r) => /3rd season|season 3/i.test(r.name));
            ok(s3.length === 1, 'season 3 is listed once: ' + JSON.stringify(s3.map((r) => r.name)));

            section('the same search again');
            const sentBefore = src.shows.asked.filter((q) => q === 'apothecary diaries').length;
            const again = await sv.get('/search?q=' + encodeURIComponent('apothecary diaries'));
            ok(AA['apothecary diaries'].every(([id]) => ids(again).includes(id)), 'answers the same rows');
            ok(src.shows.asked.filter((q) => q === 'apothecary diaries').length === sentBefore && sentBefore === 1,
               'without asking AllAnime for it a second time (sent ' + sentBefore + ' time)');
            ok(src.shows.refused === 0, 'and still nothing refused');
        }

        // ── someone else spent the budget ──────────────────────────────────────────
        section('the budget was spent by someone else (a phone on the same network)');
        {
            const sv = await boot();
            reset();
            src.fill('shows');
            const r = await sv.get('/search?q=beastars');
            ok(AA.beastars.every(([id]) => ids(r).includes(id)), 'the search still comes back with AllAnime\'s rows (' + ids(r).length + ')');
            ok(src.shows.refused >= 1, 'after being refused (' + src.shows.refused + ')');
            ok(r.ms >= 1000, 'and waiting the time the refusal named (' + r.ms + ' ms)');
            ok(ids(r).every(isAllAnimeId) && src.hianime.searches.length === 0, 'it did not switch to another source');
        }

        // ── no answer at all ───────────────────────────────────────────────────────
        section('AllAnime gives no answer (audit row 19)');
        {
            const sv = await boot();
            reset();
            src.allanimeDown = true;
            const r = await sv.get('/search?q=beastars');
            const rows = r.body.results || [];
            ok(rows.length === 2 && rows.every((x) => x.provider === 'HiAnime'),
               'the search shows what HiAnime has, marked as HiAnime\'s: ' + JSON.stringify(rows.map((x) => x.id)));
            ok(src.shows.asked.length === 2, 'AllAnime was asked twice (the search and one retry), not once per lookup (' + src.shows.asked.length + ')');
            ok(src.hianime.searches.length === 1, 'and HiAnime once (' + src.hianime.searches.length + ')');
            ok(r.ms < 6000, 'in ' + r.ms + ' ms');
            const eps = await sv.get('/episodes?id=' + encodeURIComponent(rows[0] ? rows[0].id : 'x') + '&title=' + encodeURIComponent(rows[0] ? rows[0].name : 'x'));
            ok(Array.isArray(eps.body.episodes) && eps.body.episodes.length === 2,
               'a row found that way lists its episodes: ' + JSON.stringify(eps.body.episodes) + (eps.body.error ? ' (' + eps.body.error + ')' : ''));
            src.allanimeDown = false;
            const back = await sv.get('/search?q=frieren');
            ok(AA.frieren.every(([id]) => ids(back).includes(id)), 'and the next search is AllAnime\'s again as soon as it answers');
        }

        // ── a refused episode list ─────────────────────────────────────────────────
        section('a refused episode list');
        {
            const sv = await boot();
            reset();
            src.fill('show');
            const r = await sv.get('/episodes?id=aaBeastarsS1xxxxxx&title=Beastars');
            ok(JSON.stringify(r.body.episodes) === JSON.stringify(['1', '2', '3']),
               'is waited out and answered by AllAnime, in order: ' + JSON.stringify(r.body.episodes));
            ok(src.show.refused >= 1 && r.ms >= 1000, 'after ' + src.show.refused + ' refusal and ' + r.ms + ' ms');
            ok(src.hianime.searches.length === 0, 'without going to another source for the list');
            const refusedBefore = src.show.refused;
            const many = [];
            for (let i = 0; i < 8; i++) many.push(sv.get('/episodes?id=aaBeastarsS1xxxxxx&title=Beastars'));
            const got = await Promise.all(many);
            ok(got.every((g) => (g.body.episodes || []).length === 3), 'eight lists asked at once are all answered');
            ok(src.show.refused === refusedBefore, 'and the server did not make the source refuse again');
        }

        // ── what a search costs AniList ────────────────────────────────────────────
        section('what one search spends of AniList\'s thirty a minute');
        {
            const sv = await boot();
            reset();
            const r = await sv.get('/search?q=' + encodeURIComponent('many shows'));
            ok((r.body.results || []).length === 22, 'a search that returns 22 rows (' + (r.body.results || []).length + ')');
            ok(src.anilist.detailTitles.length === 22, 'asks AniList for the details of all 22 (' + src.anilist.detailTitles.length + ')');
            ok(src.anilist.detailRequests === 1, 'in one request, where it used to take five (' + src.anilist.detailRequests + ')');
            ok(src.anilist.requests === 2, 'two requests in all: the search and the details (' + src.anilist.requests + ')');
        }

        section('AniList refuses');
        {
            const sv = await boot();
            reset();
            src.anilistRefuse = true;
            const r = await sv.get('/search?q=beastars');
            ok(AA.beastars.every(([id]) => ids(r).includes(id)), 'the search still shows AllAnime\'s four rows');
            ok(src.anilist.requests === 1, 'after one refused request, nothing else is sent (' + src.anilist.requests + ')');
            src.anilistRefuse = false;
            const r2 = await sv.get('/search?q=frieren');
            ok(AA.frieren.every(([id]) => ids(r2).includes(id)) && src.anilist.requests === 1,
               'and the next search leaves AniList alone for the time it named (' + src.anilist.requests + ' requests in all)');
        }

        // ── favorites past the 25th (audit row 18) ─────────────────────────────────
        section('favorites past the 25th get their details (audit row 18)');
        {
            const seed = [];
            for (let i = 1; i <= 30; i++) {
                seed.push({ id: 'favShow' + String(i).padStart(2, '0') + 'xx', name: 'Favorite ' + String(i).padStart(2, '0'),
                            episodes: 12, added: new Date(Date.now() - i * 3600000).toISOString() });
            }
            const sv = await boot(seed);
            reset();
            const file = path.join(sv.dataDir, 'ani-mate-favorites.json');
            const stored = () => JSON.parse(fs.readFileSync(file, 'utf8'));
            const first = await sv.get('/favorites');
            ok(first.status === 200, 'GET /favorites answers');
            let rows = stored();
            ok(rows.length === 30, 'all 30 favorites are still in the file');
            ok(rows.filter((f) => f.meta_at).length === 25, 'after one request, 25 have been looked up and it is written down (' + rows.filter((f) => f.meta_at).length + ')');
            ok(src.anilist.detailTitles.length === 25, 'AniList was asked about 25 titles (' + src.anilist.detailTitles.length + ')');
            await sv.get('/favorites');
            rows = stored();
            ok(rows.filter((f) => f.meta_at).length === 30, 'after a second request, all 30 (' + rows.filter((f) => f.meta_at).length + ')');
            ok(src.anilist.detailTitles.length === 30 && new Set(src.anilist.detailTitles).size === 30,
               'AniList was asked about the other five and about nobody twice (' + src.anilist.detailTitles.length + ' asked, ' + new Set(src.anilist.detailTitles).size + ' different)');
            const r30 = rows.find((f) => f.name === 'Favorite 30');
            ok(r30 && Array.isArray(r30.genres) && r30.genres.includes('Fantasy') && r30.start_key === 20010430 && r30.anilist_format === 'TV',
               'the 30th has its genres, year and format in the file: ' + JSON.stringify(r30 && [r30.genres, r30.start_key, r30.anilist_format]));
            const r7 = rows.find((f) => f.name === 'Favorite 07');
            ok(r7 && r7.meta_at && Array.isArray(r7.genres) && r7.genres.length === 0,
               'a show AniList does not know is marked as asked, so it is not asked about forever');
            const third = await sv.get('/favorites');
            ok(src.anilist.detailTitles.length === 30, 'a third request asks AniList nothing (' + src.anilist.detailTitles.length + ')');
            const list = Array.isArray(third.body) ? third.body : (third.body.favorites || third.body.results || []);
            const flat = [];
            (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.name && x.id) flat.push(x); Object.values(x).forEach((v) => { if (Array.isArray(v)) walk(v); }); } })(list);
            const sent30 = flat.find((f) => f.name === 'Favorite 30');
            ok(sent30 && Array.isArray(sent30.genres) && sent30.genres.length === 2,
               'and the page is sent the 30th with its genres: ' + JSON.stringify(sent30 && sent30.genres));
            ok(src.anilist.requests === 2, 'all of that in two requests, 25 titles and then 5 (' + src.anilist.requests + ')');

            section('English names for the library (POST /favorites/refresh)');
            const post = async () => {
                const r = await fetch(sv.url.replace(/\/+$/, '') + '/favorites/refresh', { method: 'POST', signal: AbortSignal.timeout(40000) });
                return r.json();
            };
            const before = src.anilist.requests;
            const done = await post();
            rows = stored();
            const named = rows.filter((f) => f.title_english);
            ok(named.length === 28, '28 of the 30 have an English name in the file (' + named.length + '), enriched: ' + done.enriched);
            ok(rows.find((f) => f.name === 'Favorite 30').title_english === 'Favorite 30 (EN)',
               'taken from the hit whose name matches, not from the first hit');
            ok(src.anilist.requests - before === 2 && src.anilist.names.length === 30,
               'in two requests for 30 names, where it used to send thirty (' + (src.anilist.requests - before) + ')');
            await post();
            ok(src.anilist.requests - before === 2,
               'and asking again sends nothing: the two AniList has no English name for are not asked about every time');
        }
    } catch (e) {
        fails++;
        console.log('  THREW ' + (e && e.stack || e));
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    for (const sv of servers) { try { sv.child.kill('SIGTERM'); } catch (e) { /* already gone */ } }
    src.server.close();
    setTimeout(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a file still open */ }
        process.exit(fails ? 1 : 0);
    }, 600);
})();
