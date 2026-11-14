#!/usr/bin/env node
// YASA PRESENTS
/* smoke-windows.js: the desktop app on Windows, started for real and examined.
 *
 *     node scripts/smoke-windows.js --seed                on an OLDER installed version:
 *                                                         put a small library in it
 *     node scripts/smoke-windows.js --installed           the installed app
 *     node scripts/smoke-windows.js --installed --seeded  and it must still hold that library
 *     node scripts/smoke-windows.js                       this folder, on its own Electron
 *
 *     --exe <path>      another executable (a built dist\win-unpacked\ANI-MATE.exe)
 *     --shot <file>     save a picture of the window
 *     --state <file>    where --seed writes down what it did (default: the temp folder)
 *
 * WHY. Every release has been built for Windows by CI and started there by nobody: the
 * suites and smoke-electron.js are written for Linux (Xvfb, /proc, signals). This is the
 * same idea for a Windows machine, and the one it is written for is the machine CI lends
 * for a few minutes (.github/workflows/smoke.yml).
 *
 * ⛔ NOT FOR A MACHINE WHERE SOMEONE USES ANI-MATE. smoke-electron.js gives the app a data
 * folder, a port and a screen of its own. This does not: an installed app can only be
 * checked where it really lives, so it uses %APPDATA%\ani-mate and port 7890, writes a
 * library there, and kills the app more than once. It refuses to start unless CI says
 * this is its machine (CI=true) or --throwaway-machine is given.
 *
 * WHAT IT CHECKS
 *   - the app starts, forks its server, and the page loads with no uncaught error
 *   - the server reports the version in package.json; a built app runs the server it
 *     shipped with
 *   - with --seeded: the favorites and history an older version wrote are all still
 *     there, with what was watched and where to resume
 *   - a favorite added now is still there after the app is killed and started again
 *   - this Electron plays video (an HLS stream made here with ffmpeg; skipped without it)
 *   - a permission the app does not need is refused
 *   - a second launch exits and leaves the first running, with one server
 *   - the server is brought back when it dies; it stops when the app is killed; and the
 *     app closed the ordinary way leaves nothing running
 *   - (not counted) a search reaches the sources: that depends on what they make of this
 *     machine's address
 *
 * Exit code: 0 all passed, 1 a check failed, 2 it could not run.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const testEnv = require('./test-env');
const seed = require('../tests/smoke-seed');

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT = (PKG.build && PKG.build.productName) || PKG.name;
const USERDATA = path.join(process.env.APPDATA || '', PKG.name);
const DATA = path.join(USERDATA, 'data');
const STATE = opt('--state', path.join(os.tmpdir(), 'animate-smoke-seed.json'));
const SHOT = opt('--shot', '');
const NOW_FAVORITE = { id: 'smokeNowBebop0001', name: 'Cowboy Bebop', title_english: 'Cowboy Bebop', episodes: 26 };

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
/* For what this machine cannot answer for (other people's servers): said, not counted. */
const note = (cond, msg) => console.log((cond ? '  ok    ' : '  note  ') + msg + (cond ? '' : '   (not counted)'));
const section = (t) => console.log('\n' + t + ':');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}
async function until(what, fn, ms) {
    const stop = Date.now() + ms;
    let last = null;
    while (Date.now() < stop) {
        try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
        await sleep(300);
    }
    throw new Error(what + ' did not happen in ' + Math.round(ms / 1000) + 's' + (last ? ' (' + (last.message || last) + ')' : ''));
}

/* ── Windows' own tools ──────────────────────────────────────────────────────────── */
function powershell(script) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
                        { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').trim();
}
function processes(filter) {
    const out = powershell('Get-CimInstance Win32_Process -Filter "' + filter + '" | '
        + 'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress');
    if (!out) return [];
    try { const j = JSON.parse(out); return Array.isArray(j) ? j : [j]; } catch (e) { return []; }
}
const childrenOf = (pid) => processes('ParentProcessId=' + pid);
const serverChild = (pid) => childrenOf(pid).find((c) => /ani-mate-server\.js/.test(c.CommandLine || ''));
const named = (name) => processes("Name='" + name + "'");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const fileVersion = (exe) => powershell("(Get-Item '" + exe.replace(/'/g, "''") + "').VersionInfo.ProductVersion");
const killTree = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
/* What clicking the window's X does: Windows asks the window to close. Returns what
 * taskkill said, because where there is no desktop to deliver that to it says so. */
const askToClose = (pid) => {
    const r = spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
    return ((r.stdout || '') + ' ' + (r.stderr || '')).trim();
};
/* The same request made from inside: the page closes its own window, which is the event
 * the X button ends in. Used when Windows could not deliver the first one. */
async function closeFromThePage(debugPort) {
    try {
        const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
        const target = list.find((t) => t.type === 'page' && /^http:\/\/localhost:/.test(String(t.url)));
        if (!target) return 'no page to ask';
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.close()', userGesture: true } }));
        await sleep(500);
        try { ws.close(); } catch (e) { /* the window went, and the socket with it */ }
        return 'asked through the page';
    } catch (e) { return 'could not ask through the page: ' + (e && e.message || e); }
}

function installed() {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Programs');
    const out = [];
    try {
        for (const d of fs.readdirSync(base)) {
            const exe = path.join(base, d, PRODUCT + '.exe');
            if (fs.existsSync(exe)) out.push(exe);
        }
    } catch (e) { /* no such folder: nothing installed */ }
    return out;
}
function homePort() {
    try {
        const p = Number(JSON.parse(fs.readFileSync(path.join(USERDATA, 'port.json'), 'utf8')).port);
        return Number.isInteger(p) && p > 1023 && p < 65536 ? p : 7890;
    } catch (e) { return 7890; }
}

/* ── the app's own server, asked the way a local program asks ────────────────────── */
const status = async (port) => {
    const r = await fetch('http://127.0.0.1:' + port + '/status', { signal: AbortSignal.timeout(2500) });
    return r.ok ? r.json() : null;
};
async function api(port, route, init) {
    const r = await fetch('http://127.0.0.1:' + port + route, Object.assign({ signal: AbortSignal.timeout(20000) }, init || {}));
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return { http: r.status, raw: text.slice(0, 200) }; }
}
const post = (port, route, body) => api(port, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/* The server's answers are wrapped: /history is { native, forge } (forge is the app's own
 * list), /continue is { continue_list }. */
const historyRows = (answer) => (Array.isArray(answer) ? answer : (answer && answer.forge) || []);
const continueRows = (answer) => (Array.isArray(answer) ? answer : (answer && answer.continue_list) || []);
/* /favorites is { favorites }, and each row's `name` is the title as the page shows it
 * (the English one when there is one), so rows are matched by id. Every favorite row,
 * wherever it sits. */
function favoriteRows(answer) {
    const out = [];
    const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== 'object') return;
        if (typeof v.id === 'string' && typeof v.name === 'string') out.push(v);
        for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') walk(v[k]);
    };
    walk(answer);
    return out;
}

/** The page of the app's own window, over the debugging port. */
async function attach(cdp, origin) {
    const target = await until('the app window', async () => {
        const list = await (await fetch(cdp + '/json/list', { signal: AbortSignal.timeout(2000) })).json();
        return list.find((t) => t.type === 'page' && String(t.url).startsWith(origin));
    }, 45000);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let idc = 0;
    const pending = new Map();
    const thrown = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.exceptionThrown') {
            const d = (m.params && m.params.exceptionDetails) || {};
            thrown.push(((d.exception && d.exception.description) || d.text || 'unknown').split('\n')[0]);
        }
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    const send = (method, params = {}) => {
        const id = ++idc;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout: ' + method)); }, 40000); });
    };
    const evalJs = async (body) => {
        const r = await send('Runtime.evaluate', { expression: '(async () => { ' + body + ' })()', awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
        return r.result && r.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    await sleep(1500);
    return { evalJs, thrown, send, close: () => { try { ws.close(); } catch (e) { /* closed */ } } };
}

(async () => {
    if (process.platform !== 'win32') { console.log('\n  SKIP: this is the Windows check. On Linux: npm run smoke:electron\n'); process.exit(2); }
    if (process.env.CI !== 'true' && !has('--throwaway-machine')) {
        console.log('\n  STOPPED: this uses the app\'s real data folder and port and kills the app. It is for a'
            + '\n  machine nobody uses ANI-MATE on. See the header of this file.\n');
        process.exit(2);
    }

    const started = [];
    const closers = [];
    let finished = false;
    const finish = (code) => {
        if (finished) return;
        finished = true;
        for (const fn of closers) { try { fn(); } catch (e) { /* closed */ } }
        for (const c of started) { if (c.pid && alive(c.pid)) killTree(c.pid); }
        setTimeout(() => process.exit(code), 800);
    };
    setTimeout(() => { console.log('\n  STOPPED: the run passed 8 minutes.\n'); finish(1); }, 8 * 60 * 1000).unref();

    /** Start the app. `debug`: a debugging port, for the launches this script needs to
     *  look inside or to close from the page. */
    function launch(exe, appDir, debug) {
        const env = Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '1' });
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(exe, (appDir ? [appDir] : []).concat(debug ? ['--remote-debugging-port=' + debug] : []),
                            { env, stdio: ['ignore', 'pipe', 'pipe'] });
        started.push(child);
        const out = { child, log: '', debug: debug || 0 };
        child.stdout.on('data', (d) => { out.log += d; });
        child.stderr.on('data', (d) => { out.log += d; });
        child.on('error', (e) => { out.log += '\n[could not start] ' + e.message; });
        out.exited = new Promise((resolve) => child.on('exit', (code, sig) => { out.code = code; out.signal = sig; resolve(code); }));
        return out;
    }
    /** Ask the window to close, and say what was left. */
    async function closeOrdinary(run, imageName) {
        const sv = serverChild(run.child.pid);
        let how = askToClose(run.child.pid);
        let code = await Promise.race([run.exited, sleep(8000).then(() => 'still running')]);
        if (code === 'still running' && run.debug) {
            how += ' | ' + await closeFromThePage(run.debug);
            code = await Promise.race([run.exited, sleep(15000).then(() => 'still running')]);
        }
        let serverGone = false, left = [];
        for (let i = 0; i < 12; i++) {
            serverGone = !sv || !alive(sv.ProcessId);
            left = imageName ? named(imageName) : [];
            if (serverGone && left.length === 0) break;
            await sleep(1000);
        }
        return { code, serverGone, serverPid: sv && sv.ProcessId, left, how: how.replace(/\s+/g, ' ').slice(0, 160) };
    }

    try {
        // ── which app ──────────────────────────────────────────────────────────────
        let exe = opt('--exe', '');
        let appDir = null;
        let packaged = !!exe;
        if (!exe && (has('--installed') || has('--seed'))) {
            const found = installed();
            if (found.length !== 1) {
                console.log('\n  Expected one installed ' + PRODUCT + ' under %LOCALAPPDATA%\\Programs, found ' + found.length + ': ' + JSON.stringify(found) + '\n');
                return finish(has('--seeded') || has('--installed') ? 1 : 2);
            }
            exe = found[0];
            packaged = true;
        }
        if (!exe) { exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'); appDir = ROOT; }
        if (!fs.existsSync(exe)) { console.log('\n  SKIP: nothing to start at ' + exe + '\n'); return finish(2); }
        const image = path.basename(exe);
        const port = homePort();

        console.log('\n  app        ' + exe + (appDir ? '   ' + appDir : ''));
        console.log('  its file   version ' + (fileVersion(exe) || '(none)') + (packaged ? '' : '   (Electron itself: the app is this folder, ' + PKG.version + ')'));
        console.log('  data       ' + DATA + (fs.existsSync(DATA) ? '   (exists)' : '   (not there yet)'));
        console.log('  port       ' + port);

        // ── --seed: an older version, given a library ──────────────────────────────
        if (has('--seed')) {
            section('the older version starts and is given three favorites');
            let run = launch(exe, null, await freePort());
            let st = null;
            try { st = await until('its server', () => status(port), 90000); }
            catch (e) {
                console.log('  it did not come up: ' + e.message);
                console.log(run.log.split('\n').slice(-25).map((l) => '    | ' + l).join('\n'));
                return finish(2);
            }
            console.log('        (it calls itself ' + st.version + '; versions before 0.7.2 said 0.4.0 whatever they were)');
            for (const f of seed.FAVORITES.slice().reverse()) await post(port, '/favorites', f);
            let favs = favoriteRows(await api(port, '/favorites'));
            ok(seed.FAVORITES.every((f) => favs.some((r) => r.id === f.id)),
               'its own POST /favorites stored all three: ' + favs.map((r) => r.name).join(', '));
            let closed = await closeOrdinary(run, image);
            note(closed.code !== 'still running' && closed.serverGone && closed.left.length === 0,
                 'closed the ordinary way, it stops and leaves nothing running (exit ' + closed.code + ', server gone ' + closed.serverGone + ', processes left ' + closed.left.length + '; ' + closed.how + ')');
            for (const p of named(image)) killTree(p.ProcessId);
            await sleep(1200);

            section('and two history rows, written the way it writes them');
            /* History is only ever written by playing something, which needs the sources.
             * The rows are put in its file while it is closed, and then it is started again
             * and asked for them: if it does not hand them back, the rows are not what
             * this version writes and the upgrade check would mean nothing. */
            fs.mkdirSync(DATA, { recursive: true });
            fs.writeFileSync(path.join(DATA, 'ani-mate-history.json'), JSON.stringify(seed.history(), null, 2));
            run = launch(exe, null, await freePort());
            try { await until('its server', () => status(port), 90000); }
            catch (e) { console.log('  it did not come up the second time: ' + e.message); return finish(2); }
            const kept = seed.historyKept(historyRows(await api(port, '/history')));
            ok(kept.both && kept.watched && kept.resume, 'it reads them back as its own: ' + kept.saw);
            const fr = continueRows(await api(port, '/continue')).find((c) => c.anime_id === 'smokeSeedFrieren01');
            ok(!!fr && String(fr.resume_episode) === '4' && Number(fr.resume_time) === 312.5,
               'and offers to resume episode 4 at 312.5 seconds: ' + JSON.stringify(fr && { e: fr.resume_episode, t: fr.resume_time }));
            favs = favoriteRows(await api(port, '/favorites'));
            ok(seed.FAVORITES.every((f) => favs.some((r) => r.id === f.id)), 'the three favorites are still there after its restart');
            closed = await closeOrdinary(run, image);
            for (const p of named(image)) killTree(p.ProcessId);
            await sleep(1200);
            const files = fs.readdirSync(DATA).map((f) => f + ' ' + fs.statSync(path.join(DATA, f)).size).join(', ');
            console.log('        (its data folder now: ' + files + ')');
            fs.writeFileSync(STATE, JSON.stringify({ from: fileVersion(exe), favorites: seed.FAVORITES.map((f) => f.id), at: new Date().toISOString() }));
            console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
            return finish(fails ? 1 : 0);
        }

        // ── it starts ──────────────────────────────────────────────────────────────
        section('the app starts');
        if (has('--seeded')) {
            let from = null;
            try { from = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* said below */ }
            ok(!!from, 'an older version was here first and left a library' + (from ? ' (file version ' + from.from + ', seeded ' + from.at + ')' : ': NO, --seed has not run'));
            ok(installed().length === 1, 'and there is one installed copy, not two side by side: ' + JSON.stringify(installed()));
            ok(String(fileVersion(exe)).startsWith(PKG.version), 'which is now version ' + fileVersion(exe));
        }
        const debug = await freePort();
        const A = launch(exe, appDir, debug);
        let st = null;
        try { st = await until('the server', () => status(port), 90000); }
        catch (e) {
            console.log('  the app did not come up: ' + e.message);
            console.log(A.log.split('\n').slice(-30).map((l) => '    | ' + l).join('\n'));
            return finish(1);
        }
        ok(!!st, 'main.js forked the server on port ' + port);
        ok(st.version === PKG.version, 'the server reports the version from package.json: ' + st.version);
        ok(fs.existsSync(DATA), 'its data folder is ' + DATA);
        const page = await attach('http://127.0.0.1:' + debug, 'http://localhost:' + port);
        closers.push(page.close);
        const boot = await until('the page', () => page.evalJs(
            `return typeof state !== 'undefined' && typeof apiCall === 'function' && document.title;`), 30000);
        ok(!!boot, 'the window loaded the app page: "' + boot + '"');
        ok(page.thrown.length === 0, 'with no uncaught error' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 3)) : ''));
        console.log('        (' + await page.evalJs(`return navigator.userAgent;`) + ')');
        const sv = serverChild(A.child.pid);
        ok(!!sv, 'the server is a child of the app (pid ' + (sv && sv.ProcessId) + ')');
        if (packaged) {
            ok(!!sv && /resources[\\/]app\.asar\.unpacked[\\/]server/i.test(sv.CommandLine || ''),
               'and is the one the built app shipped with: ' + String(sv && sv.CommandLine).replace(/^.*?(resources[\\/].*)$/i, '$1').slice(0, 90));
        }

        // ── the library an older version left ──────────────────────────────────────
        if (has('--seeded')) {
            section('the library the older version left');
            const favs = favoriteRows(await api(port, '/favorites'));
            ok(seed.FAVORITES.every((f) => favs.some((r) => r.id === f.id)),
               'all three favorites are there: ' + favs.map((r) => r.name).join(', '));
            const kept = seed.historyKept(historyRows(await api(port, '/history')));
            ok(kept.both, 'both history rows are there');
            ok(kept.watched, 'with what was watched: ' + kept.saw);
            ok(kept.resume, 'and where to resume (episode 4 at 312.5 seconds)');
            const fr = continueRows(await api(port, '/continue')).find((c) => c.anime_id === 'smokeSeedFrieren01');
            ok(!!fr && String(fr.resume_episode) === '4' && Number(fr.resume_time) === 312.5,
               'CONTINUE offers the same: ' + JSON.stringify(fr && { e: fr.resume_episode, t: fr.resume_time }));
            const seen = await page.evalJs(`try { const d = await apiCall('/favorites'); return JSON.stringify(d).length; } catch (e) { return 'failed: ' + e.message; }`);
            ok(typeof seen === 'number' && seen > 50, 'and the page itself can read the library (' + seen + ' characters of favorites)');
        }

        // ── a favorite added now ───────────────────────────────────────────────────
        section('a favorite added now');
        const added = await page.evalJs(`try { const d = await apiCall('/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: ${JSON.stringify(JSON.stringify(NOW_FAVORITE))} }); return d && d.status; } catch (e) { return 'failed: ' + e.message; }`);
        ok(added === 'added', 'the page adds one through the server: ' + added);
        ok(favoriteRows(await api(port, '/favorites')).some((r) => r.id === NOW_FAVORITE.id), 'and it is in the list');

        // ── video ──────────────────────────────────────────────────────────────────
        section('this Electron plays video');
        {
            const media = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-media-'));
            if (!testEnv.makeStream(media)) {
                console.log('  (skipped: ffmpeg was not found, and the test stream is made with it)');
            } else {
                const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
                const host = http.createServer((req, res) => {
                    const file = path.join(media, path.basename(new URL(req.url, 'http://x').pathname));
                    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
                    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
                    res.end(fs.readFileSync(file));
                });
                await new Promise((r) => host.listen(0, '127.0.0.1', r));
                closers.push(() => host.close());
                const played = await page.evalJs(`
                    if (typeof Hls === 'undefined' || !Hls.isSupported()) return { error: 'hls.js says this browser cannot play' };
                    const v = document.createElement('video');
                    v.muted = true; v.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:99999';
                    document.body.appendChild(v);
                    const h = new Hls();
                    try {
                        await new Promise((res, rej) => {
                            h.on(Hls.Events.MANIFEST_PARSED, res);
                            h.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) rej(new Error(d.type + ' / ' + d.details)); });
                            setTimeout(() => rej(new Error('no manifest in 10s')), 10000);
                            h.loadSource('http://127.0.0.1:${host.address().port}/master.m3u8');
                            h.attachMedia(v);
                        });
                        await v.play();
                        const stop = Date.now() + 20000;
                        while (v.currentTime < 1.5 && Date.now() < stop) await new Promise(r => setTimeout(r, 200));
                        return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, levels: h.levels.length, version: Hls.version };
                    } catch (e) { return { error: String(e && e.message || e) }; }
                    finally { try { h.destroy(); } catch (e) {} v.remove(); }`);
                ok(played && !played.error && played.time >= 1.5, 'an H.264 and AAC stream plays through the page\'s hls.js: ' + JSON.stringify(played));
                ok(played && played.levels === 2 && played.width > 0, 'with both qualities seen and a picture decoded (' + (played && played.width) + 'x' + (played && played.height) + ')');
            }
        }

        section('permissions');
        const perm = await page.evalJs(`try { return await Notification.requestPermission(); } catch (e) { return 'threw: ' + e.message; }`);
        ok(perm === 'denied', 'a notification permission request is refused: ' + perm);

        section('the sources, through the app (other people\'s servers)');
        const found = await page.evalJs(`try { const d = await apiCall('/search?q=frieren'); return (d.results || []).map(r => r.name); } catch (e) { return 'failed: ' + e.message; }`);
        note(Array.isArray(found) && found.length > 0, 'a search comes back with rows: ' + (Array.isArray(found) ? found.length + (found.length ? ' (' + String(found[0]).slice(0, 40) + ', ...)' : '') : found));
        note(/\[main\] net bridge attached/.test(A.log), 'the app said its network bridge attached' + (A.log ? '' : ' (this window\'s output could not be read)'));

        if (SHOT) {
            try {
                const shot = await page.send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
                console.log('\n        (picture of the window: ' + SHOT + ')');
            } catch (e) { console.log('\n        (no picture: ' + e.message + ')'); }
        }

        // ── a second launch ────────────────────────────────────────────────────────
        section('a second launch');
        const B = launch(exe, appDir, 0);
        const code = await Promise.race([B.exited, sleep(20000).then(() => 'still running')]);
        ok(code === 0, 'exits at once with code 0 (' + code + ')');
        ok(!!(await status(port)) && A.child.exitCode === null, 'and the first is still running, on the same port');
        ok(childrenOf(A.child.pid).filter((c) => /ani-mate-server\.js/.test(c.CommandLine || '')).length === 1, 'with one server, not two');

        // ── the server dies ────────────────────────────────────────────────────────
        section('the server dies');
        const firstPid = serverChild(A.child.pid).ProcessId;
        process.kill(firstPid, 'SIGKILL');
        const back = await until('a new server', async () => {
            const c = serverChild(A.child.pid);
            return c && c.ProcessId !== firstPid && (await status(port)) ? c : null;
        }, 20000).catch(() => null);
        ok(!!back, 'main.js starts it again on the same port (pid ' + firstPid + ' -> ' + (back && back.ProcessId) + ')');
        const live = await page.evalJs(`try { const r = await apiCall('/status'); return r && r.status; } catch (e) { return 'failed: ' + e.message; }`);
        ok(live === 'online', 'and the open window can use it without being reloaded: ' + live);

        // ── the app is killed ──────────────────────────────────────────────────────
        section('the app is killed outright');
        const orphan = serverChild(A.child.pid);
        page.close();
        process.kill(A.child.pid, 'SIGKILL');
        const gone = await until('its server to stop', () => !alive(orphan.ProcessId), 12000).catch(() => false);
        ok(gone === true, 'its server (pid ' + orphan.ProcessId + ') stops too, instead of keeping the port and the data files');
        await sleep(1500);
        const freed = await new Promise((resolve) => {
            const t = net.createServer();
            t.once('error', () => resolve(false));
            t.listen(port, '127.0.0.1', () => t.close(() => resolve(true)));
        });
        ok(freed, 'and port ' + port + ' is free for the next launch');

        // ── started again, and closed the ordinary way ─────────────────────────────
        section('started again, then closed the ordinary way');
        const C = launch(exe, appDir, await freePort());
        const again = await until('the server', () => status(port), 90000).catch(() => null);
        ok(!!again, 'it starts again after being killed');
        const favs2 = again ? favoriteRows(await api(port, '/favorites')) : [];
        ok(favs2.some((r) => r.id === NOW_FAVORITE.id), 'the favorite added before the kill is still there');
        if (has('--seeded')) ok(seed.FAVORITES.every((f) => favs2.some((r) => r.id === f.id)), 'and so are the three from the older version');
        const closed = await closeOrdinary(C, packaged ? image : null);
        ok(closed.code !== 'still running', 'asked to close, the app exits (code ' + closed.code + '; ' + closed.how + ')');
        ok(closed.serverGone, 'and takes its server with it (pid ' + closed.serverPid + ')');
        if (packaged) ok(closed.left.length === 0, 'nothing named ' + image + ' is left running, so an installer can replace it (' + closed.left.length + ' left)');
        for (const f of ['ani-mate-favorites.json', 'ani-mate-history.json']) {
            const p = path.join(DATA, f);
            if (!fs.existsSync(p)) continue;
            let parsed = null;
            try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* said below */ }
            ok(Array.isArray(parsed), f + ' on disk is a whole, readable list (' + (Array.isArray(parsed) ? parsed.length + ' rows' : 'NOT readable') + ')');
        }
        const stray = fs.readdirSync(DATA).filter((f) => /\.tmp/.test(f));
        ok(stray.length === 0, 'and no half-written file was left beside them' + (stray.length ? ': ' + stray.join(', ') : ''));
    } catch (e) {
        fails++;
        console.log('  THREW ' + (e && e.stack || e));
    }
    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    finish(fails ? 1 : 0);
})();
