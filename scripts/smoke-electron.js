#!/usr/bin/env node
// YASA PRESENTS
/* smoke-electron.js: start the real app (main.js, on a real Electron) where nobody can see
 * it, and check what main.js is responsible for.
 *
 *     npm run smoke:electron
 *     ANIMATE_ELECTRON=/path/to/electron ANIMATE_APP=/path/to/a/copy npm run smoke:electron
 *
 * The second form is for trying another Electron version: install it into a COPY of the
 * repo and point both variables there. Nothing has to be installed into the folder the
 * user's own app is running from.
 *
 *     ANIMATE_PACKAGED=1 ANIMATE_ELECTRON=dist/linux-unpacked/ani-mate npm run smoke:electron
 *
 * runs a BUILT app (electron-builder --dir) instead: its own executable, its own copy
 * of the server from app.asar.unpacked. A built app also asks GitHub whether there is
 * an update, three seconds after it starts.
 *
 * ⛔ NOTHING HERE MAY TOUCH THE APP THE USER HAS OPEN, THEIR FILES, OR THEIR SCREEN.
 *
 *   their data     HOME and XDG_CONFIG_HOME point into a temp folder, so this instance's
 *                  userData (settings, data files, the single-instance lock) is its own.
 *                  A second copy sharing the real userData would be handed over to the
 *                  running app and would raise ITS window.
 *   their port     the temp userData holds a port.json naming a free port
 *   their screen   the window is opened on a private X display made by Xvfb, which
 *                  draws into memory. DISPLAY is that display, never the user's.
 *                  (Electron 33 cannot do this without one: with
 *                  --ozone-platform=headless it dies in `new BrowserWindow`, measured
 *                  2026-11-12.)
 *   their browser  main.js sends web links to the system browser (shell.openExternal).
 *                  PATH starts with a folder holding an `xdg-open` that only writes down
 *                  what it was asked to open, and the session bus address points nowhere.
 *
 * WHAT IT CHECKS
 *   - the app starts, forks the server on the port from port.json, and the page loads
 *     with no uncaught error
 *   - the server reports the version from package.json (it reported 0.4.0 for years)
 *   - the server does NOT inherit the test-only switches (ANI_MATE_TEST_*), although the
 *     app itself was started with them set
 *   - window.open() of a web address opens no window and goes to the system browser;
 *     the main window cannot be navigated off the app
 *   - a permission the app does not need (notifications) is refused
 *   - a second launch exits and leaves the first running
 *   - the server is brought back when it dies
 *   - with the home port busy the app starts on another, and does not move its home
 *
 *   - the server does not outlive the app when the app is killed
 *   - this Electron plays video: an HLS stream made here (H.264 and AAC, two qualities)
 *     through the page's own hls.js. Needs ffmpeg; skipped without it.
 *
 * IT NEEDS Xvfb. If that is not installed, it does not have to be:
 *     mkdir /tmp/xvfb && cd /tmp/xvfb && apt-get download xvfb && dpkg-deb -x xvfb_*.deb .
 *     ANIMATE_XVFB=/tmp/xvfb/usr/bin/Xvfb npm run smoke:electron
 *
 * Exit code: 0 all passed, 1 a check failed, 2 it could not run (no Electron, no Xvfb).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const testEnv = require('./test-env');
const APP = path.resolve(process.env.ANIMATE_APP || path.join(__dirname, '..'));
const BIN = process.env.ANIMATE_ELECTRON || path.join(APP, 'node_modules', 'electron', 'dist', 'electron');
const PKG = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
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
        await sleep(250);
    }
    throw new Error(what + ' did not happen in ' + Math.round(ms / 1000) + 's' + (last ? ' (' + (last.message || last) + ')' : ''));
}
const childrenOf = (pid) => (spawnSync('ps', ['-o', 'pid=,args=', '--ppid', String(pid)], { encoding: 'utf8' }).stdout || '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ pid: Number(l.split(/\s+/)[0]), args: l.replace(/^\d+\s+/, '') }));
const serverChild = (pid) => childrenOf(pid).find((c) => /ani-mate-server\.js/.test(c.args));
/* Where the running server was loaded from: the repo in development, app.asar.unpacked
 * in a built app. */
const serverPathOf = (pid) => { const c = serverChild(pid); const m = c && /(\S*ani-mate-server\.js)/.exec(c.args); return m ? m[1] : null; };
const environOf = (pid) => { try { return fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0'); } catch (e) { return null; } };
/** Every process of this user whose command line or environment names the temp folder.
 *  The folder's name is random and belongs to this run, so nothing else can match. The
 *  environment is read too because the app's server names the folder only there. */
function holding(tmp) {
    const out = [];
    for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
        try {
            const cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8');
            const env = fs.readFileSync('/proc/' + d + '/environ', 'utf8');
            if (cmd.includes(tmp) || env.includes(tmp)) out.push(Number(d));
        } catch (e) { /* not ours, or gone */ }
    }
    return out;
}
function findXvfb() {
    if (process.env.ANIMATE_XVFB) return fs.existsSync(process.env.ANIMATE_XVFB) ? process.env.ANIMATE_XVFB : null;
    const r = spawnSync('which', ['Xvfb'], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : null;
}

/** The page of the app's own window, over the debugging port. */
async function attach(cdp, origin) {
    const target = await until('the app window', async () => {
        const list = await (await fetch(cdp + '/json/list', { signal: AbortSignal.timeout(2000) })).json();
        return list.find((t) => t.type === 'page' && String(t.url).startsWith(origin));
    }, 30000);
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
        return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout: ' + method)); }, 20000); });
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
    return { evalJs, thrown, send, targets: async () => (await (await fetch(cdp + '/json/list')).json()), close: () => { try { ws.close(); } catch (e) { /* closed */ } } };
}

(async () => {
    if (!fs.existsSync(BIN)) { console.log('\n  SKIP: no Electron at ' + BIN + '\n'); process.exit(2); }
    const xvfb = findXvfb();
    if (!xvfb) {
        console.log('\n  SKIP: Xvfb is needed to open the window where nobody sees it, and was not found.'
            + '\n  It does not have to be installed: see the header of this file.\n');
        process.exit(2);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-electron-'));
    const started = [];
    const closers = [];
    let finished = false;
    const finish = (code) => {
        if (finished) return;
        finished = true;
        for (const c of started) { try { process.kill(-c.pid, 'SIGTERM'); } catch (e) { try { c.kill('SIGTERM'); } catch (e2) { /* gone */ } } }
        for (const fn of closers) { try { fn(); } catch (e) { /* closed */ } }
        setTimeout(() => {
            for (const c of started) { try { process.kill(-c.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
            /* Anything this run started that is still up: helpers of a crashed app, a
             * server whose app died. They name the temp folder; nothing else does. */
            for (const pid of holding(tmp)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
            setTimeout(() => {
                const left = holding(tmp);
                if (left.length) console.log('  LEFT RUNNING: ' + left.join(' '));
                try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a file still open */ }
                process.exit(left.length && !code ? 1 : code);
            }, 500);
        }, 2500);
    };
    process.on('SIGINT', () => finish(130));
    process.on('SIGTERM', () => finish(143));
    setTimeout(() => { console.log('\n  STOPPED: the run passed 4 minutes.\n'); finish(1); }, 4 * 60 * 1000).unref();

    /* The private display. */
    let display = 0;
    for (let n = 90; n < 110 && !display; n++) if (!fs.existsSync('/tmp/.X11-unix/X' + n)) display = n;
    const X = spawn(xvfb, [':' + display, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'],
                    { stdio: 'ignore', detached: true, env: Object.assign({}, process.env, { XVFB_OF: tmp }) });
    started.push(X);
    try { await until('the private display', () => fs.existsSync('/tmp/.X11-unix/X' + display), 10000); }
    catch (e) { console.log('\n  Xvfb did not start: ' + e.message + '\n'); return finish(2); }

    /* An `xdg-open` that opens nothing. */
    const bin = path.join(tmp, 'bin');
    const opened = path.join(tmp, 'opened.txt');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'xdg-open'), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "' + opened + '"\n', { mode: 0o755 });
    const openedList = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean) : []);

    /** One isolated launch. `name` keeps each launch's folders apart. */
    function launch(name, homePort, extraArgs) {
        const home = path.join(tmp, name, 'home');
        const config = path.join(tmp, name, 'config');
        const userData = path.join(config, PKG.name);
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(userData, { recursive: true });
        if (homePort) fs.writeFileSync(path.join(userData, 'port.json'), JSON.stringify({ port: homePort }));
        const env = Object.assign({}, process.env, {
            HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(tmp, name, 'cache'),
            XDG_DATA_HOME: path.join(tmp, name, 'share'),
            PATH: bin + ':/usr/local/bin:/usr/bin:/bin',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(tmp, 'no-session-bus'),
            /* Test-only switches, set on purpose: main.js must not pass them on. */
            ANI_MATE_TEST_STREAM: JSON.stringify({ url: 'http://127.0.0.1:9/never.m3u8' }),
            ANI_MATE_PROXY_TEST_HOSTS: '127.0.0.1:9',
            ELECTRON_ENABLE_LOGGING: '1',
        });
        env.DISPLAY = ':' + display;
        delete env.WAYLAND_DISPLAY; delete env.ELECTRON_RUN_AS_NODE;
        /* A built app is its own executable and takes no app folder. */
        const child = spawn(BIN, (process.env.ANIMATE_PACKAGED ? [] : [APP])
            .concat(['--no-sandbox', '--ozone-platform=x11', '--disable-gpu', '--mute-audio'])
            .concat(extraArgs || []), { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        started.push(child);
        const out = { child, userData, home, log: '' };
        child.stdout.on('data', (d) => { out.log += d; });
        child.stderr.on('data', (d) => { out.log += d; });
        out.exited = new Promise((resolve) => child.on('exit', (code, sig) => { out.code = code; out.signal = sig; resolve(code); }));
        return out;
    }
    const status = async (port) => {
        const r = await fetch('http://127.0.0.1:' + port + '/status', { signal: AbortSignal.timeout(2500) });
        return r.ok ? r.json() : null;
    };

    try {
        let ev = '(version not found)';
        try { ev = fs.readFileSync(path.join(path.dirname(BIN), 'version'), 'utf8').trim(); } catch (e) { /* printed as is */ }
        console.log('\n  Electron ' + ev + '   ' + BIN);
        console.log('  app      ' + (process.env.ANIMATE_PACKAGED ? 'the built app (its own executable)' : APP) + '   (' + PKG.name + ' ' + PKG.version + ')');
        console.log('  display  :' + display + '   (' + xvfb + ', in memory)');

        // ── it starts ──────────────────────────────────────────────────────────────
        section('the app starts, on a display of its own and data of its own');
        const port = await freePort();
        const debug = await freePort();
        const A = launch('a', port, ['--remote-debugging-port=' + debug]);
        let st = null;
        try {
            st = await until('the server', () => status(port), 30000);
        } catch (e) {
            console.log('  the app did not come up: ' + e.message);
            console.log(A.log.split('\n').slice(-25).map((l) => '    | ' + l).join('\n'));
            return finish(2);
        }
        ok(!!st, 'main.js forked the server on the port in port.json (' + port + ')');
        ok(st.version === PKG.version, 'the server reports the version from package.json: ' + st.version);
        ok(fs.existsSync(path.join(A.userData, 'data')), 'its data folder is inside the temp userData: ' + path.join(A.userData, 'data'));
        const page = await attach('http://127.0.0.1:' + debug, 'http://localhost:' + port);
        closers.push(page.close);
        const boot = await until('the page', () => page.evalJs(
            `return typeof state !== 'undefined' && typeof apiCall === 'function' && document.title;`), 20000);
        ok(!!boot, 'the window loaded the app page: "' + boot + '"');
        ok(page.thrown.length === 0, 'with no uncaught error' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 3)) : ''));
        const versions = await page.evalJs(`return navigator.userAgent;`);
        console.log('        (' + versions + ')');

        // ── what the server inherits ───────────────────────────────────────────────
        section('the server does not inherit test switches');
        /* launch() started the app with ANI_MATE_TEST_STREAM and ANI_MATE_PROXY_TEST_HOSTS
         * set. (The app's own environment cannot be read back to show it: Chromium makes
         * its main process unreadable to other processes. The server's can.) */
        const sv = serverChild(A.child.pid);
        const svEnv = sv ? environOf(sv.pid) : null;
        ok(!!svEnv && svEnv.some((e) => e.startsWith('ANI_MATE_DATA_DIR=')) && !svEnv.some((e) => /^ANI_MATE_(TEST_|PROXY_TEST_)/.test(e)),
           'the server (pid ' + (sv && sv.pid) + ') has no ANI_MATE_TEST_ or ANI_MATE_PROXY_TEST_ name in its environment, though the app was started with two');
        ok(!!svEnv && svEnv.includes('ANI_MATE_VERSION=' + PKG.version) && svEnv.includes('ANI_MATE_PORT=' + port),
           'but does have the version and the port');
        if (process.env.ANIMATE_PACKAGED) {
            const from = serverPathOf(A.child.pid);
            ok(!!from && from.includes(path.join('resources', 'app.asar.unpacked', 'server')),
               'the built app runs the server it shipped with: ' + from);
        }

        // ── links and navigation ───────────────────────────────────────────────────
        section('links leave through the system browser, and nothing else opens');
        const before = (await page.targets()).filter((t) => t.type === 'page').length;
        const opener = await page.evalJs(`const w = window.open('https://example.invalid/from-window-open'); return w === null;`);
        await sleep(1200);
        const after = (await page.targets()).filter((t) => t.type === 'page').length;
        ok(opener === true && after === before, 'window.open() of a web address returns null and opens no window (' + before + ' before, ' + after + ' after)');
        ok(openedList().includes('https://example.invalid/from-window-open'),
           'the address was handed to xdg-open instead: ' + JSON.stringify(openedList()));
        await page.evalJs(`setTimeout(() => { location.href = 'https://example.invalid/navigated-away'; }, 50); return true;`);
        await sleep(1500);
        const where = await page.evalJs(`return location.origin;`);
        ok(where === 'http://localhost:' + port, 'the window cannot be navigated off the app (still at ' + where + ')');
        ok(openedList().includes('https://example.invalid/navigated-away'), 'and that address went to xdg-open too');
        const same = await page.evalJs(`const w = window.open(location.origin + '/status'); return w === null;`);
        ok(same === true && !openedList().some((u) => u.includes('/status')), 'an address of the app itself opens no window and is not sent to the browser');

        // ── the network bridge ─────────────────────────────────────────────────────
        /* The one check here that uses the network. In the app the server does not
         * fetch from the sources itself: it asks main.js to, through Chromium's network
         * stack (electron-net-bridge.js). A search that returns rows has been through
         * the server, the channel, the bridge, and back. */
        section('the server reaches the sources through the app (uses the network)');
        const found = await page.evalJs(`try { const d = await apiCall('/search?q=frieren'); return (d.results || []).map(r => r.name); } catch (e) { return 'failed: ' + e.message; }`);
        ok(Array.isArray(found) && found.length > 0,
           'a search comes back with rows: ' + (Array.isArray(found) ? found.length + ' (' + String(found[0]).slice(0, 40) + ', ...)' : found));
        ok(/\[main\] net bridge attached/.test(A.log) && !/net bridge FAILED/.test(A.log), 'and the bridge reported itself attached');

        // ── video ──────────────────────────────────────────────────────────────────
        section('this Electron plays video');
        {
            const media = path.join(tmp, 'media');
            fs.mkdirSync(media, { recursive: true });
            if (!testEnv.makeStream(media)) {
                console.log('  (skipped: ffmpeg was not found, and the test stream is made with it)');
            } else {
                const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
                const host = http.createServer((req, res) => {
                    const file = path.join(media, path.basename(new URL(req.url, 'http://x').pathname));
                    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
                    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
                                         'Access-Control-Allow-Origin': '*' });
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
                            setTimeout(() => rej(new Error('no manifest in 8s')), 8000);
                            h.loadSource('http://127.0.0.1:${host.address().port}/master.m3u8');
                            h.attachMedia(v);
                        });
                        await v.play();
                        const stop = Date.now() + 12000;
                        while (v.currentTime < 1.5 && Date.now() < stop) await new Promise(r => setTimeout(r, 200));
                        return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, levels: h.levels.length,
                                 audio: (h.audioTracks || []).length, version: Hls.version };
                    } catch (e) { return { error: String(e && e.message || e) }; }
                    finally { try { h.destroy(); } catch (e) {} v.remove(); }`);
                ok(played && !played.error && played.time >= 1.5,
                   'an H.264 and AAC stream plays through the page\'s hls.js: ' + JSON.stringify(played));
                ok(played && played.levels === 2 && played.width > 0, 'with both qualities seen and a picture decoded (' + (played && played.width) + 'x' + (played && played.height) + ')');
            }
        }

        section('permissions');
        const note = await page.evalJs(`try { return await Notification.requestPermission(); } catch (e) { return 'threw: ' + e.message; }`);
        ok(note === 'denied', 'a notification permission request is refused: ' + note);
        const geo = await page.evalJs(`return await new Promise((res) => { navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res('refused, code ' + e.code), { timeout: 3000 }); });`);
        ok(/^refused/.test(geo), 'so is the location: ' + geo);
        /* The two the app does need. */
        const full = await page.evalJs(`try { await document.documentElement.requestFullscreen(); const on = !!document.fullscreenElement;
            await document.exitFullscreen(); return on ? 'granted' : 'no element'; } catch (e) { return 'refused: ' + e.message; }`);
        ok(full === 'granted', 'the app\'s own page may go fullscreen: ' + full);
        const clip = await page.evalJs(`try { await navigator.clipboard.writeText('ani-mate smoke test'); return 'written'; } catch (e) { return String(e.name + ': ' + e.message); }`);
        /* A window on a display with no window manager may not hold the keyboard
         * focus, and the browser refuses the clipboard to an unfocused page before it
         * ever asks for the permission. That is not the permission being refused. */
        ok(clip === 'written' || /not focused/i.test(clip), 'and may write the clipboard (COPY KEY): ' + clip);

        // ── a second launch ────────────────────────────────────────────────────────
        section('a second launch');
        const B = launch('a', null, []);
        const code = await Promise.race([B.exited, sleep(15000).then(() => 'still running')]);
        ok(code === 0, 'exits at once with code 0 (' + code + ')');
        ok(!!(await status(port)) && A.child.exitCode === null, 'and the first is still running, on the same port');
        ok(childrenOf(A.child.pid).filter((c) => /ani-mate-server\.js/.test(c.args)).length === 1, 'with one server, not two');

        // ── the server dies ────────────────────────────────────────────────────────
        section('the server dies');
        const firstPid = serverChild(A.child.pid).pid;
        process.kill(firstPid, 'SIGKILL');
        const back = await until('a new server', async () => {
            const c = serverChild(A.child.pid);
            return c && c.pid !== firstPid && (await status(port)) ? c : null;
        }, 15000).catch(() => null);
        ok(!!back, 'main.js starts it again on the same port (pid ' + firstPid + ' -> ' + (back && back.pid) + ')');
        const alive = await page.evalJs(`try { const r = await apiCall('/status'); return r && r.status; } catch (e) { return 'failed: ' + e.message; }`);
        ok(alive === 'online', 'and the open window can use it without being reloaded: ' + alive);

        // ── the home port is busy ──────────────────────────────────────────────────
        section('the home port is busy');
        const busy = await freePort();
        const squatter = http.createServer((req, res) => { res.writeHead(200); res.end('someone else'); });
        await new Promise((r) => squatter.listen(busy, '127.0.0.1', r));
        closers.push(() => squatter.close());
        const C = launch('c', busy, []);
        const moved = await until('the second app\'s server', async () => {
            const c = serverChild(C.child.pid);
            if (!c) return null;
            const e = environOf(c.pid) || [];
            const p = (e.find((x) => x.startsWith('ANI_MATE_PORT=')) || '').split('=')[1];
            return p && (await status(Number(p))) ? Number(p) : null;
        }, 30000).catch(() => null);
        ok(!!moved && moved !== busy, 'the app still starts, on another port (' + moved + ', home was ' + busy + ')');
        await sleep(800);
        const home = JSON.parse(fs.readFileSync(path.join(C.userData, 'port.json'), 'utf8')).port;
        ok(home === busy, 'and its home is still ' + home + ': a port that was busy once is not where the app lives now');
        ok((await (await fetch('http://127.0.0.1:' + busy + '/')).text()) === 'someone else', 'the other program was left alone');

        // ── the app is killed ──────────────────────────────────────────────────────
        section('the app is killed outright');
        const orphan = serverChild(C.child.pid);
        process.kill(C.child.pid, 'SIGKILL');
        const gone = await until('its server to stop', () => !fs.existsSync('/proc/' + orphan.pid), 8000).catch(() => false);
        ok(gone === true, 'its server (pid ' + orphan.pid + ') stops too, instead of keeping the port and the data files');
        const freed = await new Promise((resolve) => {
            const t = net.createServer();
            t.once('error', () => resolve(false));
            t.listen(moved, '127.0.0.1', () => t.close(() => resolve(true)));
        });
        ok(freed, 'and port ' + moved + ' is free for the next launch');

        // ── it stops ───────────────────────────────────────────────────────────────
        section('closing');
        const svPid = serverChild(A.child.pid).pid;
        A.child.kill('SIGTERM');
        await Promise.race([A.exited, sleep(8000)]);
        await sleep(700);
        ok(A.child.exitCode !== null || A.signal, 'the app exits');
        ok(!fs.existsSync('/proc/' + svPid), 'and takes its server with it (pid ' + svPid + ')');
    } catch (e) {
        fails++;
        console.log('  THREW ' + (e && e.stack || e));
    }
    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    finish(fails ? 1 : 0);
})();
