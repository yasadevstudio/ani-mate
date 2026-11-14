// YASA PRESENTS
/* Sync, end to end: two real pages, the real engine, the real Worker (run locally).
 *
 *     npm run test:sync          (scripts/test-sync.js starts everything this needs)
 *
 * worker/tests/sync-engine.test.mjs proves the engine's rules with two simulated devices
 * in one process. This is what that cannot show: the actual pages, their actual adapter
 * over /sync/local, HTTP to the actual Worker, the panel's actual buttons.
 *
 * THE SETUP. A and B are two devices of one person.
 *     A  favorites: Cowboy Bebop, Trigun           history: Bebop, episode 3 at 10:00, watched 1-2
 *     B  favorites: Cowboy Bebop, Monster          history: Bebop, episode 5, watched 4-5
 * and B knows Cowboy Bebop under a DIFFERENT id than A does, the way the phone does.
 *
 * ANILIST IS PLAYED BY THIS FILE. What lines the two ids up is the show's AniList id,
 * which each page looks up from AniList itself. AniList allows an address 30 requests a
 * minute, and the first time this suite ran twice in a row the second run was refused
 * and the two devices never lined up. That refusal turned out to be a real fault (see
 * the next list), so the outage is now staged on purpose, and the suite needs no network.
 *
 * WHAT IT CHECKS, each one a fault measured or read on 2026-11-12:
 *   - a double click on SYNC MY STUFF makes one account
 *   - pairing by code, through both panels
 *   - while AniList cannot be reached, nothing is lost: each device holds both copies
 *   - once it can, the same show under two ids ends as ONE row on each device, each
 *     under the id that device can open (this is the fault the refusal exposed: the
 *     copies used to stay two for good)
 *   - episodes watched on both devices are both kept
 *   - a change made right after a sync is not undone by the next sync (the echo)
 *   - an un-starred show goes away on the other device and does not come back
 *   - a switch nobody touched is not synced as "off"; one that was flipped is, and takes
 *     effect on the other device, not just on its checkbox
 *   - RENAME, COPY KEY on the sign-out screen, the two-tap NEW RECOVERY KEY
 *   - against a Worker with no account routes, the panel says sync is not available
 *
 * Exit: 0 pass, 1 fail, 2 could not run.
 */
'use strict';
const { open, settle } = require('./cdp');

const CDP = process.env.ANIMATE_CDP || '';
const URLS = { a: process.env.ANIMATE_A || '', b: process.env.ANIMATE_B || '', c: process.env.ANIMATE_C || '' };

let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok    ' + m); }
                       else { fails++; console.log('  FAIL  ' + m); } };
const section = (s) => console.log('\n' + s);

if (!CDP || !URLS.a || !URLS.b || !URLS.c) {
    console.log('\n  SKIP: this suite is started by scripts/test-sync.js (npm run test:sync).\n');
    process.exit(2);
}

/* What one device holds, read the way sync reads it (no side effects on the library). */
const localOf = (p) => p.evalJs(`
    const d = await (await fetch('/sync/local')).json();
    const eps = (v) => { try { return JSON.parse(v || '[]'); } catch (e) { return []; } };
    return {
        favorites: d.favorites.map(r => ({ key: r.anime_id, lid: r._lid, title: r.title })),
        watch: d.watch.map(r => ({ key: r.anime_id, lid: r._lid, title: r.title, episode: r.episode,
                                   position: r.position, watched: eps(r.episodes_watched).map(String).sort() })),
        deleted: d.deleted,
    };`);
const syncOnce = (p) => p.evalJs(`
    try { const s = await SYNC.sync(); await syncRefreshViews(); return { ok: true, s }; }
    catch (e) { return { ok: false, error: e.message }; }`);
const view = (p) => p.evalJs(`return syncPanelEl ? syncPanelEl.dataset.modal : null;`);
const click = (p, sel) => p.evalJs(`const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e;`);
const openPanel = async (p) => {
    await p.evalJs(`if (!syncPanelEl) document.getElementById('sync-btn').click(); return true;`);
    return p.until(`return syncPanelEl ? syncPanelEl.dataset.modal : null;`, 5000);
};
const titles = (rows) => rows.map(r => r.title).sort();

(async () => {
    let A, B, C;
    try {
        A = await open(CDP, URLS.a); B = await open(CDP, URLS.b); C = await open(CDP, URLS.c);
    } catch (e) { console.log('\n  SKIP: ' + e.message + '\n'); process.exit(2); }

    try {
        /* AniList, as far as the three pages can tell. Down until the test says otherwise. */
        const KNOWN = { 'cowboy bebop': 1, 'trigun': 6, 'monster': 19 };
        const anilist = { up: false, calls: 0 };
        const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' },
                      { name: 'Access-Control-Allow-Headers', value: '*' },
                      { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
                      { name: 'Content-Type', value: 'application/json' }];
        const answer = (req) => {
            if (req.method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
            anilist.calls++;
            if (!anilist.up) return { status: 429, headers: cors, body: '{"errors":[{"message":"Too Many Requests."}]}' };
            let variables = {};
            try { variables = JSON.parse(req.postData || '{}').variables || {}; } catch (e) { /* answer nothing */ }
            const data = {};
            for (const k of Object.keys(variables)) {
                const id = KNOWN[String(variables[k]).toLowerCase().trim()];
                data['q' + k.slice(1)] = { media: id ? [{ id, title: { romaji: variables[k], english: variables[k] }, synonyms: [] }] : [] };
            }
            return { status: 200, headers: cors, body: JSON.stringify({ data }) };
        };
        for (const p of [A, B, C]) await p.intercept('graphql.anilist.co', answer);

        for (const p of [A, B, C]) await p.until(`return typeof SYNC !== 'undefined' && !!SYNC;`, 15000);
        /* The first-run question would sit over everything. Answer it "not now", the
         * way a user who wants to look around first would. */
        for (const p of [A, B, C]) await p.evalJs(`SYNC.setChoice('later'); if (syncPanelEl) syncClose(); return true;`);

        // ── a backend that has no accounts ─────────────────────────────────────────
        section('a Worker from before accounts existed');
        await openPanel(C);
        await click(C, '#sync-do-create');
        const said = await C.until(`const e = document.querySelector('.sync-err'); return e ? e.textContent : null;`, 10000);
        ok(/not available on the server yet/i.test(said || ''), 'the panel says: ' + JSON.stringify(said));
        ok((await C.evalJs(`return SYNC.state().signedIn;`)) === false, 'and nothing was signed in');

        // ── create, with a double click ────────────────────────────────────────────
        section('device A turns sync on');
        await A.evalJs(`
            window.__accountPosts = 0;
            const real = window.fetch;
            window.fetch = function (u, o) {
                if (/\\/api\\/account(\\?|$)/.test(String(u)) && o && String(o.method).toUpperCase() === 'POST') window.__accountPosts++;
                return real.apply(this, arguments);
            };
            return true;`);
        ok((await openPanel(A)) === 'off', 'the panel opens on the signed-out screen');
        await A.evalJs(`const c = document.getElementById('sync-do-create'); c.click(); c.click(); return true;`);
        const key1 = await A.until(`
            const e = syncPanelEl && syncPanelEl.dataset.modal === 'key' && syncPanelEl.querySelector('.sync-secret');
            return e ? e.textContent.trim() : null;`, 30000);
        ok(/^[0-9A-Z-]{26,40}$/.test(key1 || ''), 'a recovery key is shown (' + String(key1 || '').length + ' characters)');
        ok((await A.evalJs(`return window.__accountPosts;`)) === 1, 'two clicks on SYNC MY STUFF made ONE account request');
        await click(A, '#sync-key-done');
        ok((await A.until(`return syncPanelEl && syncPanelEl.dataset.modal === 'on';`, 8000)) === true, 'and the panel moves on to the device list');

        // ── pairing ────────────────────────────────────────────────────────────────
        section('device B joins by code');
        await openPanel(B);
        await click(B, '#sync-do-pair');
        const code = await B.until(`
            const e = syncPanelEl && syncPanelEl.dataset.modal === 'pair' && syncPanelEl.querySelector('.sync-code');
            return e ? e.textContent.replace(/\\D/g, '') : null;`, 15000);
        ok(/^\d{6}$/.test(code || ''), 'B shows a six digit code');
        await click(A, '#sync-add');
        await A.until(`return !!document.getElementById('sync-code-in');`, 5000);
        await A.evalJs(`document.getElementById('sync-code-in').value = ${JSON.stringify(code)};
                        document.getElementById('sync-code-go').click(); return true;`);
        ok((await A.until(`return syncPanelEl && syncPanelEl.dataset.modal === 'joined';`, 15000)) === true, 'A approves it');
        ok((await B.until(`return SYNC.state().signedIn && syncPanelEl && syncPanelEl.dataset.modal === 'on';`, 30000)) === true,
           'and B is signed in without ever seeing a key');
        ok((await B.evalJs(`return SYNC.state().hasKey;`)) === false, 'B holds no recovery key, and says so');

        // ── AniList cannot be reached ──────────────────────────────────────────────
        section('while AniList cannot be reached');
        let ra, rb;
        for (let i = 0; i < 2; i++) { ra = await syncOnce(A); rb = await syncOnce(B); }
        ok(ra.ok && rb.ok, 'both devices still sync' + (ra.ok && rb.ok ? '' : ': ' + JSON.stringify([ra.error, rb.error])));
        ok(anilist.calls > 0, 'each asked AniList and was refused (' + anilist.calls + ' requests)');
        const all = ['Cowboy Bebop', 'Monster', 'Trigun'];
        const doubled = ['Cowboy Bebop', 'Cowboy Bebop', 'Monster', 'Trigun'];
        let la = await localOf(A), lb = await localOf(B);
        ok(JSON.stringify(titles(la.favorites)) === JSON.stringify(doubled) && JSON.stringify(titles(lb.favorites)) === JSON.stringify(doubled),
           'nothing is lost: each device has every favorite, with the shared show under both ids for now');

        // ── and then it can ────────────────────────────────────────────────────────
        section('once AniList answers, the two libraries become one');
        anilist.up = true;
        for (let i = 0; i < 3; i++) { ra = await syncOnce(A); rb = await syncOnce(B); }
        ok(ra.ok && rb.ok, 'both devices sync without an error' + (ra.ok && rb.ok ? '' : ': ' + JSON.stringify([ra.error, rb.error])));
        la = await localOf(A); lb = await localOf(B);
        ok(JSON.stringify(titles(la.favorites)) === JSON.stringify(all), 'A has three favorites, one per show: ' + JSON.stringify(titles(la.favorites)));
        ok(JSON.stringify(titles(lb.favorites)) === JSON.stringify(all), 'B has three favorites, one per show: ' + JSON.stringify(titles(lb.favorites)));
        ok(la.favorites.filter(f => f.title === 'Cowboy Bebop').length === 1 && lb.favorites.filter(f => f.title === 'Cowboy Bebop').length === 1,
           'Cowboy Bebop is ONE row on each device, though the two knew it under different ids');
        const ka = la.favorites.find(f => f.title === 'Cowboy Bebop'), kb = lb.favorites.find(f => f.title === 'Cowboy Bebop');
        ok(ka && kb && ka.key === kb.key && /^al:\d+$/.test(ka.key) && ka.lid === 'AAbebop' && kb.lid === 'cowboy-bebop-1281',
           'both sync it under one key (' + (ka && ka.key) + ') and each keeps its own id (' + (ka && ka.lid) + ' / ' + (kb && kb.lid) + ')');
        const lids = (l) => l.favorites.map(f => f.lid).sort();
        ok(lids(la).includes('AAtrigun') && lids(lb).includes('monster-19'),
           'each device also kept its own id for the show only it had: ' + JSON.stringify([lids(la), lids(lb)]));
        const wa = la.watch.find(w => w.title === 'Cowboy Bebop'), wb = lb.watch.find(w => w.title === 'Cowboy Bebop');
        ok(la.watch.length === 1 && lb.watch.length === 1, 'one history row for it on each device');
        ok(wa && JSON.stringify(wa.watched) === '["1","2","4","5"]', 'A keeps the episodes watched on BOTH devices: ' + JSON.stringify(wa && wa.watched));
        ok(wb && JSON.stringify(wb.watched) === '["1","2","4","5"]', 'so does B: ' + JSON.stringify(wb && wb.watched));
        /* Which device's resume point survives a FIRST meeting is not something this
         * protocol can get right every time: a row's time is stamped by the server when
         * it is pushed, so on first contact "newer" means "pushed later", not "watched
         * later". What must hold is that the two devices end up agreeing. */
        ok(wa && wb && wa.episode === wb.episode && wa.position === wb.position,
           'and the two agree on where the show stands: episode ' + (wa && wa.episode) + ' at ' + (wa && wa.position) + 's'
           + ' (B: episode ' + (wb && wb.episode) + ' at ' + (wb && wb.position) + 's)');

        // ── the echo ───────────────────────────────────────────────────────────────
        section('a change made between two syncs');
        const progress = (t) => A.evalJs(`
            await fetch('/save-progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anime_id: 'AAbebop', episode: '3', playback_time: ${t} }) });
            return true;`);
        await progress(700);
        await syncOnce(A);                                   // pushes 700
        await progress(800);                                 // then the user watches on
        ok((await localOf(A)).watch[0].position === 800, 'A stands at 800s');
        await syncOnce(A);                                   // the pull brings A's own 700 back
        await syncOnce(A);
        const afterEcho = (await localOf(A)).watch[0];
        ok(afterEcho.position === 800,
           'and still stands at 800s after two more syncs: its own earlier push did not roll it back (' + afterEcho.position + ')');
        await A.evalJs(`
            await fetch('/mark-watched', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anime_id: 'AAbebop', episode: '3' }) });
            return true;`);
        await syncOnce(A); await syncOnce(A);
        const marked = (await localOf(A)).watch[0];
        ok(JSON.stringify(marked.watched) === '["1","2","3","4","5"]',
           'a watched mark made after a push survives the next two syncs: ' + JSON.stringify(marked.watched));
        await syncOnce(B);
        const bEcho = (await localOf(B)).watch[0];
        ok(JSON.stringify(bEcho.watched) === '["1","2","3","4","5"]' && bEcho.position === marked.position,
           'and B receives both: ' + JSON.stringify([bEcho.watched, bEcho.position]));

        // ── a delete ───────────────────────────────────────────────────────────────
        section('un-starring a show');
        await A.evalJs(`await fetch('/favorites/AAtrigun', { method: 'DELETE' }); return true;`);
        await syncOnce(A); await syncOnce(B); await syncOnce(A); await syncOnce(B);
        const da = await localOf(A), db = await localOf(B);
        ok(!titles(da.favorites).includes('Trigun'), 'Trigun is gone from A');
        ok(!titles(db.favorites).includes('Trigun'), 'and from B');
        ok(titles(da.favorites).length === 2 && titles(db.favorites).length === 2,
           'nothing else went with it: ' + JSON.stringify([titles(da.favorites), titles(db.favorites)]));
        await syncOnce(A); await syncOnce(B);
        ok(!titles((await localOf(A)).favorites).includes('Trigun') && !titles((await localOf(B)).favorites).includes('Trigun'),
           'and two syncs later it has not come back on either');

        // ── settings ───────────────────────────────────────────────────────────────
        section('settings');
        const en = async (p) => p.evalJs(`return { stored: localStorage.getItem('ani-mate-english-titles'), on: state.preferEnglish,
                                                   box: document.getElementById('english-title-toggle').checked };`);
        const ea = await en(A), eb = await en(B);
        ok(ea.stored === null && eb.stored === null && ea.on && eb.on && ea.box && eb.box,
           'English titles, which nobody touched, are still ON and still unset on both: ' + JSON.stringify([ea, eb]));
        await A.evalJs(`const t = document.getElementById('nsfw-toggle'); if (!t.checked) t.click(); return t.checked;`);
        await syncOnce(A); await syncOnce(B);
        const nb = await B.evalJs(`return { on: state.nsfw, box: document.getElementById('nsfw-toggle').checked,
                                            stored: localStorage.getItem('ani-mate-nsfw') };`);
        ok(nb.on === true && nb.box === true && nb.stored === 'true',
           'the 18+ switch flipped on A is ON for B: the checkbox AND what searches will send: ' + JSON.stringify(nb));

        // ── the panel's buttons ────────────────────────────────────────────────────
        section('the device list');
        await A.evalJs(`if (syncPanelEl) syncClose(); return true;`);
        await openPanel(A);
        await A.until(`return syncPanelEl.querySelectorAll('[data-rename]').length >= 2;`, 10000);
        const devs = await A.evalJs(`return [...syncPanelEl.querySelectorAll('.sync-dev-name')].map(x => x.textContent);`);
        ok(devs.length === 2, 'A lists both devices: ' + JSON.stringify(devs));
        await A.evalJs(`
            const row = [...syncPanelEl.querySelectorAll('.sync-dev')].find(r => r.querySelector('.sync-dev-here'));
            row.querySelector('[data-rename]').click();
            return true;`);
        const box = await A.until(`const i = syncPanelEl.querySelector('.sync-dev input'); return i ? { value: i.value } : null;`, 4000);
        ok(!!box && box.value.length > 0, 'RENAME turns the name into a box holding the current name: ' + JSON.stringify(box && box.value));
        await A.evalJs(`
            const row = [...syncPanelEl.querySelectorAll('.sync-dev')].find(r => r.querySelector('input'));
            row.querySelector('input').value = 'Desk One';
            row.querySelector('[data-rename]').click();
            return true;`);
        const renamed = await A.until(`
            return [...syncPanelEl.querySelectorAll('.sync-dev-name')].some(x => x.textContent === 'Desk One');`, 8000);
        ok(renamed === true, 'SAVE renames the device');
        await B.evalJs(`if (syncPanelEl) syncClose(); return true;`);
        await openPanel(B);
        ok((await B.until(`return [...syncPanelEl.querySelectorAll('.sync-dev-name')].some(x => x.textContent === 'Desk One');`, 8000)) === true,
           'and B sees the new name');

        section('the sign-out screen');
        await A.evalJs(`syncPanelEl.querySelector('[data-revoke][data-current="1"]').click(); return true;`);
        ok((await A.until(`return syncPanelEl.dataset.modal === 'signout';`, 4000)) === true, 'SIGN OUT on this device asks first');
        const shown = await A.evalJs(`return (syncPanelEl.querySelector('.sync-secret') || {}).textContent || '';`);
        ok(shown.trim() === key1, 'and shows the recovery key');
        await click(A, '#sync-copy');
        const copy = await A.until(`const b = document.getElementById('sync-copy'); return b && b.textContent !== 'COPY KEY' ? b.textContent : null;`, 4000);
        ok(copy === 'COPIED' || /^SELECTED/.test(copy || ''), 'COPY KEY does something now: the button reads ' + JSON.stringify(copy));
        if (/^SELECTED/.test(copy || '')) {
            ok((await A.evalJs(`return String(window.getSelection());`)).trim() === key1, 'the clipboard was refused here, so the key is selected instead');
        }
        await click(A, '#sync-back');

        section('a new recovery key');
        await A.until(`return !!document.getElementById('sync-newkey');`, 8000);
        await click(A, '#sync-newkey');
        const armed = await A.evalJs(`return { text: document.getElementById('sync-newkey').textContent, key: SYNC.recoveryKey() };`);
        ok(/TAP AGAIN/.test(armed.text) && armed.key === key1, 'the first tap only asks: ' + JSON.stringify(armed.text));
        await click(A, '#sync-newkey');
        const key2 = await A.until(`
            const e = syncPanelEl.dataset.modal === 'key' && syncPanelEl.querySelector('.sync-secret');
            return e ? e.textContent.trim() : null;`, 10000);
        ok(!!key2 && key2 !== key1, 'the second tap makes a different key');

        for (const [name, p] of [['A', A], ['B', B], ['C', C]]) {
            ok(p.thrown.length === 0, 'page ' + name + ' threw nothing' + (p.thrown.length ? ': ' + JSON.stringify(p.thrown.slice(0, 3)) : ''));
        }
    } catch (e) {
        ok(false, 'THREW: ' + (e && e.message || e));
    } finally {
        for (const p of [A, B, C]) { try { await p.close(); } catch (e) { /* closing */ } }
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})();
