// YASA PRESENTS
/* The phone's page, in a browser: search, open, play, what is stored, the switches.
 *
 *     npm run test:phone          (scripts/test-phone.js starts what this needs)
 *
 * Every outside address the page asks for is answered here. The stand-in for the edge
 * Worker writes down what it was asked, because several of these checks are about
 * exactly that: what the phone sends when a show is opened and played.
 *
 * WHAT IT CHECKS, each one read or measured on 2026-11-12 and never run until now:
 *   - the page starts without Capacitor and throws nothing
 *   - a release note that is markup is shown as text (audit row 29)
 *   - a search draws what the edge returned, with a hostile name as text
 *   - opening and playing sends the show's TITLE to the edge every time, and its other
 *     title, so a show that was not opened from a search can still play (row 11)
 *   - an episode is watched at 80% of its length, not when it starts (rows 6, 12)
 *   - finishing an episode leaves no resume point at its end (row 12)
 *   - a favorite whose id is not a source's id (a row that arrived by sync) opens and
 *     plays by its name (row 11, the case from the audit)
 *   - the 18+ switch reaches the edge on the episode list and on play (row 22)
 *   - with the edge refusing, the phone searches AllAnime itself, stays inside AllAnime's
 *     count, and asks AniList for details in one request (the budget, on the phone)
 *   - WHAT CAPACITOR'S OWN REQUEST PATCH DOES WITH A REFERER (audit row 23). Its real
 *     page-side script, loaded in this browser, with a stand-in for its native half that
 *     forwards what the script hands it. Measured here, not on Android.
 *   - a stream whose host refuses every request without its Referer still plays: the
 *     player's first attempt is refused, and its second loader, which goes through the
 *     native HTTP plugin (a stand-in here), gets through (row 23, what the app does)
 *   - TWO PHONES SYNC, through the phone's own storage adapter and its own panel, against
 *     the real Worker run locally: an account made on one, joined from the other with
 *     the recovery key, one row per show on each though they knew it under different
 *     ids, watched episodes from both, the list on screen following a sync, a removal
 *     that stays removed, RENAME and COPY in the panel (audit rows 1, 2, 5, 10)
 *
 * ⛔ NOT ANDROID. See scripts/test-phone.js.
 */
'use strict';
const cdp = require('./cdp');
const refererProbe = require('./referer-probe');

const CDP = process.env.ANIMATE_CDP;
const PHONE = (process.env.ANIMATE_PHONE || '').replace(/\/+$/, '');
const STREAM = process.env.ANIMATE_STREAM;
const PHONE2 = (process.env.ANIMATE_PHONE2 || '').replace(/\/+$/, '');
const EDGE = (process.env.ANIMATE_EDGE || '').replace(/\/+$/, '');
const VIDEO_HOST = (process.env.ANIMATE_VIDEO_HOST || '').replace(/\/+$/, '');
const STREAM_REFERER = process.env.ANIMATE_STREAM_REFERER || '';
if (!CDP || !PHONE || !STREAM) { console.log('\n  This suite is started by scripts/test-phone.js (npm run test:phone).\n'); process.exit(2); }

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
const section = (t) => console.log('\n' + t + ':');

const HOSTILE = 'Probe <img src="animate-dom-probe" onerror="window.__probeRan=1"> Show';
const CORS = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' },
              { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' }];
const json = (obj, status) => ({ status: status || 200, headers: CORS.concat([{ name: 'Content-Type', value: 'application/json' }]), body: JSON.stringify(obj) });

/* What the stand-ins were asked. */
const asked = { search: [], episodes: [], play: [], allanime: [], allanimeRefused: 0, anilistDetails: 0, anilistRequests: 0, github: 0, other: [] };
const world = { edgeDown: false, aaWindowStart: 0, aaInWindow: 0 };

function answer(req) {
    let u;
    try { u = new URL(req.url); } catch (e) { return null; }
    if (req.url.startsWith(PHONE) || req.url.startsWith(STREAM.replace(/\/[^/]*$/, ''))) return null;      // the page and the video
    if ((PHONE2 && req.url.startsWith(PHONE2)) || (EDGE && req.url.startsWith(EDGE))) return null;           // the second phone, the local Worker
    if (req.method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
    const q = Object.fromEntries(u.searchParams.entries());

    if (u.hostname === 'ani-mate.yasadevstudio.workers.dev') {
        if (world.edgeDown) return json({ error: 'stand-in: the edge is refusing' }, 503);
        if (u.pathname === '/api/search') {
            asked.search.push(q);
            if (/gated/i.test(q.q || '')) return json({ results: [{ id: 'gatedShowIdAAAAA', name: 'Gated Show' }] });
            return json({ results: [{ id: 'beastarsS1idAAAA', name: 'Beastars' }, { id: 'probeShowIdAAAAA', name: HOSTILE }] });
        }
        if (u.pathname === '/api/episodes') { asked.episodes.push(q); return json({ episodes: ['1', '2', '3'] }); }
        if (u.pathname === '/api/play') {
            asked.play.push(q);
            /* One show's stream sits on a host that wants its own page as the Referer. */
            if (q.title === 'Gated Show') {
                return json({ url: VIDEO_HOST + '/gated/master.m3u8', referer: STREAM_REFERER, subtitles: [], quality: '360p', source: 'stand-in' });
            }
            return json({ url: STREAM, referer: null, subtitles: [], quality: '360p', source: 'stand-in' });
        }
        return json({ ok: true, service: 'stand-in edge' });
    }
    if (u.hostname === 'graphql.anilist.co') {
        asked.anilistRequests++;
        let v = {};
        try { v = JSON.parse(req.postData || '{}').variables || {}; } catch (e) { /* answered as empty */ }
        const keys = Object.keys(v).filter((k) => /^s\d+$/.test(k));
        if (keys.length) {
            asked.anilistDetails++;
            const data = {};
            /* One id per title, whoever asks and in whatever order: two devices have to
             * be told the same thing about the same show. */
            const KNOWN = { 'cowboy bebop': 5, 'trigun': 6, 'monster': 19, 'sousou no frieren': 154587 };
            const idOf = (title) => KNOWN[String(title).toLowerCase()]
                || (9000 + [...String(title)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 90000, 7));
            for (const k of keys) {
                data['q' + k.slice(1)] = { media: [{ id: idOf(v[k]), synonyms: [], title: { romaji: v[k], english: v[k] + ' (EN)' },
                    coverImage: { large: PHONE + '/no-cover.png', color: '#223344' }, description: 'about it', genres: ['Drama'],
                    format: 'TV', startDate: { year: 2019, month: 10, day: 10 }, seasonYear: 2019, popularity: 5 }] };
            }
            return json({ data });
        }
        return json({ data: { Page: { pageInfo: { hasNextPage: false }, media: [], airingSchedules: [] }, Media: null } });
    }
    if (u.hostname === 'api.allanime.day') {
        let body = {};
        try { body = JSON.parse(req.postData || '{}'); } catch (e) { /* answered as empty */ }
        const v = body.variables || {};
        if (v.search) {
            /* Counts the way AllAnime was measured to: ten a window, then a refusal. */
            const now = Date.now();
            if (!world.aaWindowStart || now - world.aaWindowStart >= 10000) { world.aaWindowStart = now; world.aaInWindow = 0; }
            asked.allanime.push(String(v.search.query));
            if (world.aaInWindow >= 10) {
                asked.allanimeRefused++;
                return json({ errors: [{ message: 'Too many requests, please try again in 9 seconds.' }], data: null });
            }
            world.aaInWindow++;
            const rows = Array.from({ length: 22 }, (_, i) => ({ _id: 'localShow' + String(i + 1).padStart(2, '0') + 'abc',
                name: String(v.search.query).toUpperCase() + ' Local ' + String(i + 1).padStart(2, '0'), availableEpisodes: { sub: 12 + i, dub: 0 } }));
            return json({ data: { shows: { edges: rows } } });
        }
        if (v.showId) return json({ data: { show: { _id: v.showId, availableEpisodesDetail: { sub: ['1', '2', '3'], dub: [] } } } });
        return json({ data: { queryPopular: { recommendations: [] } } });
    }
    if (u.hostname === 'api.github.com') {
        asked.github++;
        return json({ tag_name: 'v9.9.9', name: 'v9.9.9', html_url: 'https://github.com/YASADevStudio/ani-mate/releases/tag/v9.9.9',
                      body: 'Fixed things.\n<img src="animate-dom-probe" onerror="window.__probeRan=2"> <b>bold</b>',
                      assets: [{ name: 'ANI-MATE-9.9.9-mobile.apk',
                                 browser_download_url: 'https://github.com/yasadevstudio/ani-mate/releases/download/v9.9.9/ANI-MATE-9.9.9-mobile.apk' }] });
    }
    /* A show's description comes from AniList, and from MyAnimeList (through Jikan) when
     * AniList has none. The AniList stand-in has none. */
    if (u.hostname === 'api.jikan.moe') { asked.jikan = (asked.jikan || 0) + 1; return json({ data: [] }); }
    if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return { status: 200, headers: CORS.concat([{ name: 'Content-Type', value: 'text/css' }]), body: '' };
    asked.other.push(u.hostname);
    return json({ error: 'stand-in: nothing here' }, 503);
}

/* ── WHAT STANDS IN FOR CAPACITOR'S NATIVE HTTP PLUGIN ─────────────────────────────────
 * On a phone, CapacitorHttp makes the request from native code, where any header can be
 * set. Here the request is made from this Node process, which can do the same. The
 * answer has the shape HttpRequestHandler.buildResponse gives: status, headers, url, and
 * `data` as base64 for a binary response type, parsed for JSON, text otherwise. */
async function nativeHttp(opts) {
    const method = String(opts.method || 'GET').toUpperCase();
    const body = opts.data === undefined || opts.data === null ? undefined
        : (typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data));
    const canned = answer({ url: String(opts.url), method, postData: body });      // the stand-ins the page's own requests get
    let status, buf, type, finalUrl = String(opts.url);
    if (canned) {
        status = canned.status;
        buf = Buffer.from(String(canned.body || ''), 'utf8');
        type = ((canned.headers || []).find((h) => /^content-type$/i.test(h.name)) || {}).value || '';
    } else {
        const r = await fetch(String(opts.url), { method, headers: opts.headers || {}, body, signal: AbortSignal.timeout(15000) });
        status = r.status; buf = Buffer.from(await r.arrayBuffer()); type = r.headers.get('content-type') || ''; finalUrl = r.url;
    }
    const want = String(opts.responseType || '').toLowerCase();
    let data;
    if (want === 'arraybuffer' || want === 'blob') data = buf.toString('base64');
    else {
        data = buf.toString('utf8');
        if (want === 'json' || /json/i.test(type)) { try { data = JSON.parse(data); } catch (e) { /* left as text */ } }
    }
    return { status, url: finalUrl, headers: { 'Content-Type': type }, data };
}

/* The least of Capacitor the phone's page needs to believe it has the native HTTP plugin:
 * that plugin and nothing else. Storage, the app plugin and the rest stay absent, so the
 * page keeps using what a browser has. */
const MINIMAL_CAPACITOR = `(() => {
    let n = 0; const waiting = {};
    window.__nativeDone = (id, result, error) => { const w = waiting[id]; delete waiting[id]; if (w) (error ? w.rej(new Error(error)) : w.res(result)); };
    const call = (method, o) => new Promise((res, rej) => { const id = ++n; waiting[id] = { res, rej };
        window.__nativeCall(JSON.stringify({ id, opts: Object.assign({ method }, o) })); });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android',
        Plugins: { CapacitorHttp: { get: (o) => call('GET', o), post: (o) => call('POST', o), request: (o) => call((o && o.method) || 'GET', o) } } };
})();`;

/* What Android gives Capacitor's real script before it runs: the bridge object it posts
 * plugin calls to, the switch that says CapacitorHttp is enabled, and the app's address. */
const ANDROID_FOR_THE_BRIDGE = `
    window.WEBVIEW_SERVER_URL = location.origin;
    window.CapacitorHttpAndroidInterface = { isEnabled: () => true };
    window.CapacitorCookiesAndroidInterface = { isEnabled: () => false, getCookies: () => '', setCookie: () => {} };
    window.androidBridge = { postMessage: (json) => window.__nativeCall(json) };`;

(async () => {
    const page = await cdp.open(CDP, 'about:blank');
    try {
        await page.intercept('http', answer);
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

        const load = async () => {
            await page.send('Page.navigate', { url: PHONE + '/index.html' });
            await page.until(`return typeof window.API === 'object' && !!document.getElementById('search-input') && document.readyState === 'complete';`, 15000);
            await page.settle(600);
        };
        const stored = (name) => page.evalJs(`try { return JSON.parse(localStorage.getItem('animate_${name}') || 'null'); } catch (e) { return 'unreadable'; }`);
        const probe = () => page.evalJs(`return { ran: window.__probeRan || 0, tags: document.querySelectorAll('img[src*="animate-dom-probe"]').length };`);
        const search = async (text) => {
            await page.evalJs(`const i = document.getElementById('search-input'); i.value = ${JSON.stringify(text)};
                i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
            return page.until(`return document.querySelectorAll('#results-container .result-card').length;`, 20000);
        };
        const open = async (id) => {
            await page.evalJs(`const c = [...document.querySelectorAll('.result-card')].find(x => x.dataset.id === ${JSON.stringify(id)});
                if (!c) return false; c.click(); return true;`);
            return page.until(`return document.querySelectorAll('#episode-grid .episode-btn').length;`, 20000);
        };
        const play = async (ep) => {
            await page.evalJs(`const b = [...document.querySelectorAll('#episode-grid .episode-btn')].find(x => x.dataset.ep === ${JSON.stringify(String(ep))});
                if (b) b.click(); await new Promise(r => setTimeout(r, 150)); const p = document.getElementById('play-btn'); if (p) p.click(); return !!b;`);
            return page.until(`const v = document.getElementById('video-player'); return v && v.currentTime > 1 ? v.currentTime : 0;`, 30000);
        };
        const video = (body) => page.evalJs(`const v = document.getElementById('video-player'); ${body}`);
        const closePlayer = async () => { await page.evalJs(`const b = document.getElementById('player-back'); if (b) b.click(); return true;`); await page.settle(500); };
        const closePanel = async () => { await page.evalJs(`const b = document.getElementById('panel-back'); if (b) b.click(); return true;`); await page.settle(300); };

        // ── it starts ──────────────────────────────────────────────────────────────
        section('the page starts without Capacitor');
        await load();
        const boot = await page.evalJs(`return { title: document.title, capacitor: typeof window.Capacitor,
            tabs: [...document.querySelectorAll('[data-tab]')].map(e => e.dataset.tab), budget: typeof window.AniMateBudget,
            door: typeof (window.API && window.API.anilistPost) };`);
        ok(boot.title === 'ANI-MATE' && boot.capacitor === 'undefined', 'the page loads with no Capacitor around it ("' + boot.title + '")');
        ok(boot.tabs.join(',') === 'search,continue,daily,releases,favs', 'with its five tabs: ' + boot.tabs.join(' '));
        ok(boot.budget === 'object' && boot.door === 'function', 'the shared request counter and the AniList door are loaded');
        ok(page.thrown.length === 0, 'and nothing is thrown while it starts' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 3)) : ''));

        section('a new release whose notes are markup (audit row 29)');
        await page.until(`return !!document.getElementById('update-dialog-overlay');`, 12000);
        const up = await page.evalJs(`const o = document.getElementById('update-dialog-overlay'); if (!o) return null;
            const n = o.querySelector('#update-notes');
            return { version: (o.querySelector('.update-dialog-version') || {}).textContent || '',
                     notes: n ? n.textContent : '', elementsInNotes: n ? n.querySelectorAll('*').length : -1,
                     buttons: [...o.querySelectorAll('button')].map(b => b.textContent.trim()) };`);
        ok(asked.github === 1, 'the page asked GitHub for the latest release, once');
        ok(!!up && /9\.9\.9/.test(up.version), 'and offers the update: "' + (up && up.version.trim()) + '"');
        ok(!!up && up.notes.includes('<b>bold</b>') && up.elementsInNotes === 0,
           'the release notes are there as text, markup and all: ' + JSON.stringify(up && up.notes.slice(0, 70)));
        let pr = await probe();
        ok(pr.ran === 0 && pr.tags === 0, 'and none of it was drawn as markup (probe ran ' + pr.ran + ', tags ' + pr.tags + ')');
        ok(!!up && up.buttons.includes('LATER') && up.buttons.includes('UPDATE NOW'), 'with its two choices: ' + JSON.stringify(up && up.buttons));
        await page.evalJs(`const b = document.getElementById('update-later'); if (b) b.click(); return true;`);
        ok(await page.evalJs(`return !document.getElementById('update-dialog-overlay');`), 'LATER puts it away');

        // ── search ─────────────────────────────────────────────────────────────────
        section('a search');
        const n = await search('beastars');
        ok(n >= 2, 'draws what the edge returned (' + n + ' cards)');
        ok(asked.search.length === 1 && asked.search[0].q === 'beastars', 'after asking the edge once: ' + JSON.stringify(asked.search[0]));
        const names = await page.evalJs(`return [...document.querySelectorAll('#results-container .result-card')].map(c => c.dataset.title);`);
        ok(names.includes(HOSTILE), 'a name that is markup is there as a name');
        pr = await probe();
        ok(pr.ran === 0 && pr.tags === 0, 'and was not drawn as markup');
        ok(asked.anilistDetails === 1, 'details for the cards came from AniList in one request (' + asked.anilistDetails + ')');

        // ── open and play ──────────────────────────────────────────────────────────
        section('opening and playing a show');
        const eps = await open('beastarsS1idAAAA');
        ok(eps === 3, 'the episode list is drawn (' + eps + ' episodes)');
        const e0 = asked.episodes[asked.episodes.length - 1] || {};
        ok(e0.id === 'beastarsS1idAAAA' && e0.title === 'Beastars', 'the edge was asked with the id AND the title: ' + JSON.stringify(e0));
        const t = await play(1);
        ok(t > 1, 'episode 1 plays (' + (t && t.toFixed ? t.toFixed(1) : t) + 's in)');
        const p0 = asked.play[asked.play.length - 1] || {};
        ok(p0.title === 'Beastars' && p0.episode === '1' && !p0.nsfw, 'play was asked by title, with 18+ off: ' + JSON.stringify(p0));
        ok(p0.alt === 'Beastars (EN)', 'and carried the show\'s other title, so a source that lists it in English can match: ' + JSON.stringify(p0.alt));

        section('when an episode counts as watched, and where it resumes');
        const length = await video(`return v.duration || 0;`);
        let hist = await stored('history.json');
        let row = (hist || []).find((h) => h.anime_id === 'beastarsS1idAAAA') || {};
        ok(!(row.episodes_watched || []).includes('1'), 'not when it starts: ' + JSON.stringify(row.episodes_watched || []));
        await video(`v.currentTime = v.duration * 0.4; return true;`);
        await page.settle(1200);
        await closePlayer();
        hist = await stored('history.json'); row = (hist || []).find((h) => h.anime_id === 'beastarsS1idAAAA') || {};
        ok(Number(row.playback_time) >= 8 && Number(row.playback_time) <= 13 && String(row.playback_episode) === '1',
           'closing the player at 40% keeps the place (' + row.playback_time + 's of episode ' + row.playback_episode + ', the episode is ' + Math.round(length) + 's)');
        ok(!(row.episodes_watched || []).includes('1'), 'and the episode is not watched yet');
        const again = await play(1);
        ok(again > 1, 'playing it again starts (' + (again && again.toFixed ? again.toFixed(1) : again) + 's in)');
        await video(`v.currentTime = v.duration * 0.85; return true;`);
        await page.until(`try { const h = JSON.parse(localStorage.getItem('animate_history.json') || '[]').find(x => x.anime_id === 'beastarsS1idAAAA');
            return h && (h.episodes_watched || []).includes('1'); } catch (e) { return false; }`, 12000);
        hist = await stored('history.json'); row = (hist || []).find((h) => h.anime_id === 'beastarsS1idAAAA') || {};
        ok((row.episodes_watched || []).includes('1'), 'at 85% it is watched: ' + JSON.stringify(row.episodes_watched || []));

        section('when an episode ends (AUTO off)');
        await video(`v.currentTime = Math.max(0, v.duration - 0.4); return true;`);
        await page.until(`const v = document.getElementById('video-player'); return v && v.ended;`, 12000);
        await page.settle(1500);
        hist = await stored('history.json'); row = (hist || []).find((h) => h.anime_id === 'beastarsS1idAAAA') || {};
        ok(length > 20 && !(Number(row.playback_time) > length - 3),
           'no resume point is left at the end of the episode (' + row.playback_time + 's saved, the episode is ' + Math.round(length) + 's)');
        ok(asked.play.length === 2, 'and with AUTO off nothing else was started (' + asked.play.length + ' play requests: the two this suite made)');
        await closePlayer();
        await closePanel();

        // ── a row that is not a source's row ───────────────────────────────────────
        section('a favorite that arrived by sync, under an id no source issued (audit row 11)');
        await page.evalJs(`localStorage.setItem('animate_favorites.json', JSON.stringify([
            { id: 'al:5', name: 'Cowboy Bebop', title_english: 'Cowboy Bebop', episodes: 26, added: new Date().toISOString(), from_sync: true },
            { id: 'AAdesktopOnlyId01', name: 'Trigun', title_english: 'Trigun', episodes: 26, added: new Date().toISOString(), from_sync: true }]));
            localStorage.setItem('ani-mate-update-checked', String(Date.now())); return true;`);
        await load();
        await page.evalJs(`document.querySelector('[data-tab="favs"]').click(); return true;`);
        const favs = await page.until(`return document.querySelectorAll('#results-container .result-card').length;`, 15000);
        ok(favs === 2, 'FAVS shows both (' + favs + ')');
        const before = { e: asked.episodes.length, p: asked.play.length };
        const eps2 = await open('al:5');
        ok(eps2 === 3, 'the one with the sync id opens to its episodes (' + eps2 + ')');
        const e1 = asked.episodes[asked.episodes.length - 1] || {};
        ok(asked.episodes.length === before.e + 1 && !e1.id && e1.title === 'Cowboy Bebop',
           'the edge was asked by name, and was not sent an id it could only miss on: ' + JSON.stringify(e1));
        const t2 = await play(2);
        const p1 = asked.play[asked.play.length - 1] || {};
        ok(t2 > 1 && p1.title === 'Cowboy Bebop' && p1.episode === '2', 'and it plays (' + (t2 && t2.toFixed ? t2.toFixed(1) : t2) + 's in): ' + JSON.stringify(p1));
        await closePlayer();
        await closePanel();

        // ── 18+ ────────────────────────────────────────────────────────────────────
        section('the 18+ switch (audit row 22)');
        await page.evalJs(`document.querySelector('[data-tab="search"]').click(); return true;`);
        await search('beastars');
        await open('beastarsS1idAAAA');
        await page.evalJs(`const c = document.getElementById('nsfw-toggle'); if (!c.checked) c.click(); return c.checked;`);
        await page.settle(400);
        await closePanel();
        await search('beastars');
        await open('beastarsS1idAAAA');
        const e2 = asked.episodes[asked.episodes.length - 1] || {};
        ok(e2.nsfw === 'true', 'with it on, the episode list is asked for with nsfw=true: ' + JSON.stringify(e2));
        const t3 = await play(1);
        const p2 = asked.play[asked.play.length - 1] || {};
        ok(t3 > 1 && p2.nsfw === 'true', 'and so is play: ' + JSON.stringify(p2));
        ok(await page.evalJs(`return localStorage.getItem('ani-mate-nsfw');`) === 'true', 'the switch is remembered');
        await closePlayer();
        await closePanel();

        // ── the edge refuses ───────────────────────────────────────────────────────
        section('the edge refuses, and the phone asks the sources itself');
        world.edgeDown = true;
        const sent0 = asked.allanime.length, d0 = asked.anilistDetails;
        const local = await search('frieren');
        const ids = await page.evalJs(`return [...document.querySelectorAll('#results-container .result-card')].map(c => c.dataset.id);`);
        ok(local >= 1 && ids.some((id) => /^localShow\d\dabc$/.test(id)), 'a search still shows rows, AllAnime\'s own (' + local + ' cards)');
        await search('trigun');
        await search('monster');
        ok(asked.allanimeRefused === 0, 'three searches in a row and AllAnime refused none (' + (asked.allanime.length - sent0) + ' searches sent)');
        ok(asked.allanime.length - sent0 <= 10, 'the phone stayed inside ten');
        ok(asked.anilistDetails - d0 <= 3, 'and asked AniList for details once per search, not five times (' + (asked.anilistDetails - d0) + ' requests for three searches)');

        // ── Capacitor's own request patch, and a Referer ─────────────────────────────
        section('what Capacitor\'s own request patch does with a Referer (its real script, in this browser; audit row 23)');
        {
            const pb = await cdp.open(CDP, 'about:blank');
            try {
                await pb.intercept('http', answer);
                await pb.send('Runtime.addBinding', { name: '__nativeCall' });
                pb.on('Runtime.bindingCalled', async (ev) => {
                    if (ev.name !== '__nativeCall') return;
                    let call = {};
                    try { call = JSON.parse(ev.payload); } catch (e) { return; }
                    let result;
                    try {
                        if (call.pluginId !== 'CapacitorHttp') throw new Error(call.pluginId + ' is not in this stand-in');
                        const o = call.options || {};
                        const data = await nativeHttp(Object.assign({ method: call.methodName === 'request' ? (o.method || 'GET') : call.methodName }, o));
                        result = { callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, success: true, data, save: false };
                    } catch (e) {
                        result = { callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, success: false,
                                   error: { message: String(e && e.message || e) }, save: false };
                    }
                    await pb.evalJs('window.androidBridge.onmessage({ data: ' + JSON.stringify(JSON.stringify(result)) + ' }); return true;').catch(() => null);
                });
                await pb.send('Page.addScriptToEvaluateOnNewDocument', { source: ANDROID_FOR_THE_BRIDGE });
                await pb.send('Page.navigate', { url: PHONE + '/__blank.html' });
                await pb.until(`return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.getPlatform);`, 10000);
                const out = await pb.evalJs(refererProbe.probeBody(VIDEO_HOST + '/__echo', STREAM_REFERER));
                for (const l of refererProbe.lines(out, STREAM_REFERER)) console.log('        ' + l);
                ok(out.capacitor && out.platform === 'android' && out.xhrIsBrowsersOwn === false && out.fetchIsBrowsersOwn === false,
                   'Capacitor\'s script is loaded as on Android and has replaced XMLHttpRequest and fetch');
                ok(refererProbe.seen(out.xhr) !== STREAM_REFERER && !out.xhr.error,
                   'the Referer the player sets does NOT arrive through XMLHttpRequest: the host saw ' + JSON.stringify(refererProbe.seen(out.xhr)));
                ok(refererProbe.header(out.xhr, 'user-agent') === refererProbe.AGENT,
                   'a User-Agent set on the same request DOES arrive: it is the one header the patch carries across');
                ok(refererProbe.seen(out.fetchHeader) !== STREAM_REFERER && !out.fetchHeader.error,
                   'nor does the Referer arrive through fetch: the host saw ' + JSON.stringify(refererProbe.seen(out.fetchHeader)));
                ok(refererProbe.seen(out.nativeGet) === STREAM_REFERER,
                   'it DOES arrive through CapacitorHttp.get, the call the second loader makes: ' + JSON.stringify(refererProbe.seen(out.nativeGet)));
                ok(pb.thrown.length === 0, 'and the script threw nothing' + (pb.thrown.length ? ': ' + JSON.stringify(pb.thrown.slice(0, 3)) : ''));
            } finally { await pb.close(); }
        }

        // ── a host that demands its Referer ────────────────────────────────────────
        section('a stream whose host refuses requests without its Referer (audit row 23, what the app does about it)');
        {
            const pg = await cdp.open(CDP, 'about:blank');
            try {
                world.edgeDown = false;
                await pg.intercept('http', answer);
                await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
                await pg.send('Runtime.addBinding', { name: '__nativeCall' });
                let nativeCalls = 0;
                pg.on('Runtime.bindingCalled', async (ev) => {
                    if (ev.name !== '__nativeCall') return;
                    let call = {};
                    try { call = JSON.parse(ev.payload); } catch (e) { return; }
                    nativeCalls++;
                    try {
                        const r = await nativeHttp(call.opts || {});
                        await pg.evalJs('window.__nativeDone(' + JSON.stringify(call.id) + ', ' + JSON.stringify(r) + '); return true;');
                    } catch (e) {
                        await pg.evalJs('window.__nativeDone(' + JSON.stringify(call.id) + ', null, ' + JSON.stringify(String(e && e.message || e)) + '); return true;').catch(() => null);
                    }
                });
                await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: MINIMAL_CAPACITOR });
                /* The second origin: its storage is its own, so nothing from the runs above is in it. */
                const HERE = PHONE2 || PHONE;
                await pg.send('Page.navigate', { url: HERE + '/css/ani-mate.css' });
                await pg.settle(400);
                await pg.evalJs(`localStorage.clear(); localStorage.setItem('ani-mate-update-dismissed', JSON.stringify({ version: '9.9.9', at: Date.now() }));
                    localStorage.setItem('ani-mate-update-checked', String(Date.now())); return true;`);
                await pg.send('Page.navigate', { url: HERE + '/index.html' });
                await pg.until(`return typeof window.API === 'object' && !!document.getElementById('search-input') && document.readyState === 'complete';`, 15000);
                await pg.settle(600);
                ok(await pg.evalJs(`return typeof window.AniMateNativeHlsLoader === 'function';`), 'with the native HTTP plugin present, the page has its second loader');
                ok(pg.thrown.length === 0, 'and starts without throwing' + (pg.thrown.length ? ': ' + JSON.stringify(pg.thrown.slice(0, 3)) : ''));

                await pg.evalJs(`const i = document.getElementById('search-input'); i.value = 'gated';
                    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
                await pg.until(`return document.querySelectorAll('#results-container .result-card').length;`, 20000);
                await pg.evalJs(`const c = [...document.querySelectorAll('.result-card')].find(x => x.dataset.id === 'gatedShowIdAAAAA'); if (c) c.click(); return !!c;`);
                await pg.until(`return document.querySelectorAll('#episode-grid .episode-btn').length;`, 20000);
                await pg.evalJs(`const b = [...document.querySelectorAll('#episode-grid .episode-btn')].find(x => x.dataset.ep === '1'); if (b) b.click();
                    await new Promise(r => setTimeout(r, 150)); document.getElementById('play-btn').click(); return true;`);
                const t = await pg.until(`const v = document.getElementById('video-player'); return v && v.currentTime > 1.5 ? v.currentTime : 0;`, 60000);
                const log = await (await fetch(VIDEO_HOST + '/__gated-log')).json();
                const refused = log.filter((r) => !r.ok), let_in = log.filter((r) => r.ok);
                ok(t > 1.5, 'the episode plays (' + (t && t.toFixed ? t.toFixed(1) : t) + 's in)');
                ok(refused.length >= 1 && refused.every((r) => r.referer !== STREAM_REFERER),
                   'the player\'s first attempt was refused by the host, ' + refused.length + ' time(s), arriving with Referer ' + JSON.stringify(refused[0] && refused[0].referer));
                ok(let_in.length >= 3 && let_in.every((r) => r.referer === STREAM_REFERER),
                   'its second loader got through: ' + let_in.length + ' requests, every one with the stream\'s Referer');
                ok(log.findIndex((r) => r.ok) > log.findIndex((r) => !r.ok), 'in that order: refused first, then let in');
                ok(let_in.some((r) => /\.ts$/.test(r.file)) && let_in.some((r) => /\.m3u8$/.test(r.file)),
                   'playlists and video segments both (' + let_in.filter((r) => /\.ts$/.test(r.file)).length + ' segments, decoded from the plugin\'s base64)');
                ok(nativeCalls >= 3, 'all of them made through the native HTTP plugin (' + nativeCalls + ' calls)');
                const more = await pg.until(`const v = document.getElementById('video-player'); return v && v.currentTime > 5 ? v.currentTime : 0;`, 30000);
                ok(more > 5, 'and it keeps playing (' + (more && more.toFixed ? more.toFixed(1) : more) + 's)');
                ok(pg.thrown.length === 0, 'with nothing thrown' + (pg.thrown.length ? ': ' + JSON.stringify(pg.thrown.slice(0, 3)) : ''));
            } finally { await pg.close(); }
        }

        // ── two phones ─────────────────────────────────────────────────────────────
        if (!EDGE || !PHONE2) {
            console.log('\n  (two phones syncing: SKIPPED, wrangler is not installed and the Worker could not be run)');
        } else {
            section('two phones sync (the phone\'s own storage and panel, the real Worker run locally)');
            world.edgeDown = false;
            const p2 = await cdp.open(CDP, 'about:blank');
            try {
                await p2.intercept('http', answer);
                await p2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
                const HOUR = 3600 * 1000, now = Date.now();
                const iso = (ms) => new Date(ms).toISOString();
                const devices = [
                    { p: page, origin: PHONE,
                      favs: [{ id: 'cowboy-bebop-1281', name: 'Cowboy Bebop', episodes: 26, added: iso(now - 30 * HOUR) },
                             { id: 'monster-19', name: 'Monster', episodes: 74, added: iso(now - 29 * HOUR) }],
                      hist: [{ anime_id: 'cowboy-bebop-1281', title: 'Cowboy Bebop', episode: '3', mode: 'sub', quality: 'best',
                               timestamp: iso(now - 2 * HOUR), episodes_watched: ['1', '2'], total_episodes: 26, playback_time: 300, playback_episode: '3' }] },
                    { p: p2, origin: PHONE2,
                      favs: [{ id: 'AAbebopFromAllAnime', name: 'Cowboy Bebop', episodes: 26, added: iso(now - 20 * HOUR) },
                             { id: 'trigun-22', name: 'Trigun', episodes: 26, added: iso(now - 19 * HOUR) }],
                      hist: [{ anime_id: 'AAbebopFromAllAnime', title: 'Cowboy Bebop', episode: '4', mode: 'sub', quality: 'best',
                               timestamp: iso(now - 5 * HOUR), episodes_watched: ['4'], total_episodes: 26, playback_time: 0, playback_episode: null }] },
                ];
                for (const d of devices) {
                    /* Every document on these two pages gets the local Worker as its sync
                     * server, the way the desktop page gets its own from /sync/config.js. */
                    await d.p.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.ANI_MATE_EDGE = ' + JSON.stringify(EDGE) + ';' });
                    await d.p.send('Page.navigate', { url: d.origin + '/css/ani-mate.css' });
                    await d.p.settle(500);
                    await d.p.evalJs(`localStorage.clear();
                        localStorage.setItem('animate_favorites.json', ${JSON.stringify(JSON.stringify(d.favs))});
                        localStorage.setItem('animate_history.json', ${JSON.stringify(JSON.stringify(d.hist))});
                        localStorage.setItem('ani-mate-update-dismissed', JSON.stringify({ version: '9.9.9', at: Date.now() }));
                        localStorage.setItem('ani-mate-update-checked', String(Date.now())); return true;`);
                    await d.p.send('Page.navigate', { url: d.origin + '/index.html' });
                    await d.p.until(`return typeof window.SYNC === 'object' && !!document.getElementById('sync-open-btn');`, 15000);
                }
                const [A, B] = devices.map((d) => d.p);
                const tap = (p, id) => p.evalJs(`const e = document.getElementById(${JSON.stringify(id)}); if (!e) return false; e.click(); return true;`);
                const waitFor = (p, id) => p.until(`return !!document.getElementById(${JSON.stringify(id)});`, 15000);
                const openPanel = async (p) => { await tap(p, 'sync-open-btn'); await p.settle(300); if (await tap(p, 's-intro-yes')) await p.settle(300); };
                const sync = (p) => p.evalJs(`try { const r = await window.SYNC.sync(); return { ok: !r || r.ok !== false, error: r && r.error || null }; }
                    catch (e) { return { ok: false, error: String(e && e.message || e) }; }`);
                const lists = (p) => p.evalJs(`const j = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } };
                    return { favs: j('animate_favorites.json'), hist: j('animate_history.json') };`);
                const namesOf = (l) => l.favs.map((f) => f.name).sort();

                await openPanel(A);
                ok(await waitFor(A, 's-create'), 'the first phone\'s panel offers SYNC MY STUFF');
                await tap(A, 's-create');
                const key = await A.until(`const e = document.querySelector('.sync-secret'); return e ? e.textContent.trim() : '';`, 20000);
                const shape = String(key || '').replace(/[A-Za-z0-9]/g, 'X');
                ok(String(key || '').replace(/[^A-Za-z0-9]/g, '').length >= 20 && /^X+(-X+)+$/.test(shape),
                   'and making an account shows a recovery key (shaped ' + shape + ')');
                await tap(A, 's-copy');
                await A.settle(500);
                const copied = await A.evalJs(`const b = document.getElementById('s-copy'); const sel = String(window.getSelection());
                    return { label: b ? b.textContent.trim() : '', selected: sel.replace(/\s+/g, '') };`);
                ok(copied.label === 'COPIED' || /^SELECTED/.test(copied.label),
                   'COPY copies the key, or says it selected it when the clipboard refuses: "' + copied.label + '"');
                await tap(A, 's-key-done');
                ok(await waitFor(A, 's-now'), 'then the panel shows the account');
                await tap(A, 's-x');
                await A.settle(300);
                ok(await A.evalJs(`return window.SYNC.state().signedIn && document.getElementById('sync-open-btn').classList.contains('on');`),
                   'and with the panel closed, the sync button in the tab bar is lit');
                let ra = await sync(A);
                ok(ra.ok, 'the first phone syncs' + (ra.ok ? '' : ': ' + ra.error));

                await openPanel(B);
                await waitFor(B, 's-recover');
                await tap(B, 's-recover');
                await waitFor(B, 's-key-in');
                await B.evalJs(`document.getElementById('s-key-in').value = ${JSON.stringify(String(key))}; return true;`);
                await tap(B, 's-key-go');
                ok(await B.until(`return window.SYNC.state().signedIn;`, 25000), 'the second phone joins with the key');
                await tap(B, 's-x');
                let rb;
                for (let i = 0; i < 3; i++) { rb = await sync(B); ra = await sync(A); }
                ok(ra.ok && rb.ok, 'both sync without an error' + (ra.ok && rb.ok ? '' : ': ' + JSON.stringify([ra.error, rb.error])));
                let la = await lists(A), lb = await lists(B);
                const all = ['Cowboy Bebop', 'Monster', 'Trigun'];
                ok(JSON.stringify(namesOf(la)) === JSON.stringify(all), 'the first phone has three favorites, one per show: ' + JSON.stringify(namesOf(la)));
                ok(JSON.stringify(namesOf(lb)) === JSON.stringify(all), 'so has the second: ' + JSON.stringify(namesOf(lb)));
                const idOfShow = (l, name) => (l.favs.find((f) => f.name === name) || {}).id;
                ok(idOfShow(la, 'Cowboy Bebop') === 'cowboy-bebop-1281' && idOfShow(lb, 'Cowboy Bebop') === 'AAbebopFromAllAnime',
                   'each kept its own id for the show both had: ' + JSON.stringify([idOfShow(la, 'Cowboy Bebop'), idOfShow(lb, 'Cowboy Bebop')]));
                const ha = la.hist.filter((h) => h.title === 'Cowboy Bebop'), hb = lb.hist.filter((h) => h.title === 'Cowboy Bebop');
                ok(ha.length === 1 && hb.length === 1, 'one history row for it on each (' + ha.length + ', ' + hb.length + ')');
                const watched = (h) => JSON.stringify(((h[0] || {}).episodes_watched || []).slice().sort());
                ok(watched(ha) === '["1","2","4"]' && watched(hb) === '["1","2","4"]', 'holding what was watched on both: ' + watched(ha) + ' and ' + watched(hb));

                section('the list on screen follows a sync');
                await tap(B, 's-x');
                await B.evalJs(`document.querySelector('[data-tab="favs"]').click(); return true;`);
                const shownBefore = await B.until(`return document.querySelectorAll('#results-container .result-card').length;`, 15000);
                await A.evalJs(`await window.Storage.addFavorite({ id: 'frieren-1', name: 'Sousou no Frieren', episodes: 28 }); return true;`);
                await sync(A);
                await openPanel(B);
                await waitFor(B, 's-now');
                await tap(B, 's-now');
                await B.until(`try { return JSON.parse(localStorage.getItem('animate_favorites.json') || '[]').some(f => f.name === 'Sousou no Frieren'); } catch (e) { return false; }`, 25000);
                await B.settle(1200);
                await tap(B, 's-x');
                const shownAfter = await B.evalJs(`return document.querySelectorAll('#results-container .result-card').length;`);
                ok(shownAfter === shownBefore + 1, 'SYNC NOW brought a favorite in and FAVS drew it without a reload (' + shownBefore + ' cards, then ' + shownAfter + ')');

                section('a removal stays removed');
                await A.evalJs(`await window.Storage.removeFavorite('monster-19'); return true;`);
                for (let i = 0; i < 2; i++) { await sync(A); await sync(B); }
                la = await lists(A); lb = await lists(B);
                ok(!namesOf(la).includes('Monster') && !namesOf(lb).includes('Monster'),
                   'removed on one phone, gone from both: ' + JSON.stringify([namesOf(la), namesOf(lb)]));
                for (let i = 0; i < 2; i++) { await sync(B); await sync(A); }
                la = await lists(A); lb = await lists(B);
                ok(!namesOf(la).includes('Monster') && !namesOf(lb).includes('Monster') && namesOf(la).length === 3 && namesOf(lb).length === 3,
                   'and two more rounds do not bring it back, or lose anything else (' + namesOf(la).length + ' and ' + namesOf(lb).length + ' favorites)');

                section('RENAME in the phone\'s panel');
                await openPanel(B);
                await B.until(`return document.querySelectorAll('[data-rename]').length;`, 15000);
                await B.evalJs(`const row = [...document.querySelectorAll('.sync-dev')].find(r => r.querySelector('[data-current="1"]')) || document.querySelector('.sync-dev');
                    row.querySelector('[data-rename]').click(); await new Promise(r => setTimeout(r, 200));
                    const i = row.querySelector('input.sync-input'); if (!i) return false; i.value = 'Second Test Phone';
                    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
                const renamed = await B.until(`return [...document.querySelectorAll('.sync-dev-name')].some(e => e.textContent.trim() === 'Second Test Phone');`, 15000);
                ok(!!renamed, 'a device is renamed in its own row, and the list shows the new name');
                ok(A.thrown.length === 0 && B.thrown.length === 0, 'neither phone threw' + (A.thrown.length + B.thrown.length ? ': ' + JSON.stringify(A.thrown.concat(B.thrown).slice(0, 3)) : ''));
            } finally {
                await p2.close();
            }
        }

        section('all the way through');
        pr = await probe();
        ok(pr.ran === 0 && pr.tags === 0, 'no stored or fetched text was ever drawn as markup');
        ok(page.thrown.length === 0, 'nothing was thrown' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 4)) : ''));
        const strays = [...new Set(asked.other)];
        ok(strays.length === 0, 'and the page asked no outside address this suite did not expect' + (strays.length ? ': ' + strays.join(', ') : ''));
    } catch (e) {
        fails++;
        console.log('  THREW ' + (e && e.stack || e));
    }
    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    await page.close();
    process.exit(fails ? 1 : 0);
})();
