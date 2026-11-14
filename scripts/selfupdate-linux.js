#!/usr/bin/env node
// YASA PRESENTS
/* selfupdate-linux.js: AFTER A RELEASE, the AppImage of the release BEFORE it updating
 * itself, start to finish, the way a user's copy does: its own check finds the new
 * release, its own "Download now?" box is answered, the file is downloaded and checked
 * by its updater, its "Restart now?" box is answered, and the new version comes up in
 * its place with the library the old one had.
 *
 *     node scripts/selfupdate-linux.js <ANI-MATE-old.AppImage> <new version> [latest-linux.yml]
 *     node scripts/selfupdate-linux.js --deb <new version> [latest-linux.yml]
 *                                  the copy INSTALLED from the .deb (/opt/ANI-MATE): for a
 *                                  machine CI lends, because that update replaces the
 *                                  installed package (the updater runs dpkg as root)
 *
 *     curl -LO https://github.com/yasadevstudio/ani-mate/releases/download/v0.7.1/ANI-MATE-0.7.1.AppImage
 *     curl -LO https://github.com/yasadevstudio/ani-mate/releases/download/v0.7.2/latest-linux.yml
 *     node scripts/selfupdate-linux.js ANI-MATE-0.7.1.AppImage 0.7.2 latest-linux.yml
 *
 * WHY. Everything before a tag checks the build. Nothing checked that a copy people
 * already have can GET there: that the release is where the old updater looks, that the
 * file passes the old updater's checksum, that the old version lets go of its files, and
 * that what starts afterwards is the new version with the same library. First run
 * 2026-11-14 for 0.7.1 to 0.7.2.
 *
 * Everything is the app's own: nothing is called from outside unless one of its boxes
 * cannot be answered, and then that is said. The app gets a home, a config folder and a
 * display of its own (Xvfb), a COPY of the AppImage in a temp folder (the updater
 * replaces the file it runs from), and it is kept off port 7890, the port of the app the
 * user runs. It needs Xvfb (see scripts/smoke-electron.js for getting one without
 * installing it) and xdotool, and it downloads the new AppImage, about 130 MB.
 *
 * With --deb the update is the package itself: the updater asks to become root (pkexec, or
 * sudo where there is no pkexec) and runs dpkg, so that mode needs a machine where that
 * goes through without a person. Windows and Android: .github/workflows/selfupdate.yml.
 *
 * Exit code: 0 all passed, 1 a check failed, 2 it could not run.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const seed = require('../tests/smoke-seed');

const DEB = process.argv[2] === '--deb';
const OLD = DEB ? (process.env.ANIMATE_INSTALLED || '/opt/ANI-MATE/ani-mate') : process.argv[2];
const WANT = process.argv[3];
const YML = process.argv[4];
const packageVersion = () => (spawnSync('dpkg-query', ['-W', '-f=${Version}', 'ani-mate'], { encoding: 'utf8' }).stdout || '').trim();
const which = (name) => { const r = spawnSync('which', [name], { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : ''; };
const XVFB = process.env.ANIMATE_XVFB || which('Xvfb');
/** Every process of this user whose command line or environment names the temp folder.
 *  The environment is read too: the updated app is started by the old one with no
 *  arguments, from a mount whose path does not carry the folder's name. */
function holding(tmp) {
    const out = [];
    for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
        try {
            const cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8');
            let own = cmd.includes(tmp);
            if (!own) { try { own = fs.readFileSync('/proc/' + d + '/environ', 'utf8').includes(tmp); } catch (e) { /* not readable: Chromium's own main process */ } }
            if (own) out.push(Number(d));
        } catch (e) { /* not ours, or gone */ }
    }
    return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok    ' + m); } else { fails++; console.log('  FAIL  ' + m); } };
const section = (t) => console.log('\n' + t + ':');
async function until(what, fn, ms, every) {
    const stop = Date.now() + ms; let last = null;
    while (Date.now() < stop) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(every || 400); }
    throw new Error(what + ' did not happen in ' + Math.round(ms / 1000) + 's' + (last ? ' (' + (last.message || last) + ')' : ''));
}
const status = async (port) => { const r = await fetch('http://127.0.0.1:' + port + '/status', { signal: AbortSignal.timeout(2000) }); return r.ok ? r.json() : null; };
const get = async (port, p) => (await fetch('http://127.0.0.1:' + port + p, { signal: AbortSignal.timeout(15000) })).json();
const rowsOf = (answer) => { const out = []; const walk = (v) => { if (Array.isArray(v)) return v.forEach(walk); if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.name === 'string') out.push(v); for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') walk(v[k]); }; walk(answer); return out; };
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); }); }

(async () => {
    if (!OLD || !fs.existsSync(OLD) || !WANT) { console.log('usage: node scripts/selfupdate-linux.js <old AppImage> <new version> [latest-linux.yml]   (or --deb <new version>)'); process.exit(2); }
    if (DEB && process.env.CI !== 'true' && !process.argv.includes('--throwaway-machine')) {
        console.log('\n  STOPPED: --deb lets the updater replace the INSTALLED package on this machine. It is for a machine'
            + '\n  nobody uses ANI-MATE on (CI=true, or --throwaway-machine).\n');
        process.exit(2);
    }
    if (!XVFB || !fs.existsSync(XVFB)) { console.log('\n  SKIP: Xvfb is needed (ANIMATE_XVFB=/path/to/Xvfb). See the header of scripts/smoke-electron.js.\n'); process.exit(2); }
    if (!which('xdotool')) { console.log('\n  SKIP: xdotool is needed to answer the app\'s two boxes.\n'); process.exit(2); }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-selfupdate-'));
    const appDir = path.join(tmp, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    /* An AppImage is copied, because its updater replaces the file it runs from. The
     * installed copy is run where it is. */
    const oldFile = DEB ? OLD : path.join(appDir, path.basename(OLD));
    if (!DEB) { fs.copyFileSync(OLD, oldFile); fs.chmodSync(oldFile, 0o755); }
    const packageWas = DEB ? packageVersion() : '';

    let display = 0;
    for (let n = 130; n < 150 && !display; n++) if (!fs.existsSync('/tmp/.X11-unix/X' + n)) display = n;
    const X = spawn(XVFB, [':' + display, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'],
                    { stdio: 'ignore', detached: true, env: Object.assign({}, process.env, { XVFB_OF: tmp }) });
    for (let i = 0; i < 40 && !fs.existsSync('/tmp/.X11-unix/X' + display); i++) await sleep(250);
    const xdo = (...a) => spawnSync('xdotool', a, { encoding: 'utf8', env: Object.assign({}, process.env, { DISPLAY: ':' + display }) });

    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const home = path.join(tmp, 'home'), config = path.join(tmp, 'config'), userData = path.join(config, 'ani-mate');
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
    const childEnv = Object.assign({}, process.env, {
        HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(tmp, 'cache'), XDG_DATA_HOME: path.join(tmp, 'share'),
        PATH: bin + ':/usr/local/bin:/usr/bin:/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(tmp, 'no-session-bus'),
        DISPLAY: ':' + display, ELECTRON_ENABLE_LOGGING: '1',
        /* The updated app is started by the old one with no arguments, so what the first
         * launch gets as flags has to be in the environment for the second. This machine
         * does not let an unpacked Chromium sandbox itself. */
        ELECTRON_DISABLE_SANDBOX: '1', ELECTRON_OZONE_PLATFORM_HINT: 'x11',
    });
    delete childEnv.WAYLAND_DISPLAY; delete childEnv.ELECTRON_RUN_AS_NODE;

    let stopped = false;
    const cleanup = async () => {
        if (stopped) return; stopped = true;
        for (const pid of holding(tmp)) { try { process.kill(pid, 'SIGTERM'); } catch (e) { /* gone */ } }
        await sleep(2000);
        for (const pid of holding(tmp)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
        try { process.kill(-X.pid, 'SIGTERM'); } catch (e) { /* gone */ }
        await sleep(800);
        const left = holding(tmp);
        if (left.length) console.log('  LEFT RUNNING: ' + left.join(' '));
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a file still open */ }
    };
    setTimeout(async () => { console.log('\n  STOPPED: the run passed 9 minutes.\n'); await cleanup(); process.exit(1); }, 9 * 60 * 1000).unref();

    try {
        /* Port 7890 belongs to the app the user runs. The old version takes it when it is
         * free, so it is held for the seconds that version needs to pick another. */
        const squatter = net.createServer();
        const held = await new Promise((res) => { squatter.once('error', () => res(false)); squatter.listen(7890, '127.0.0.1', () => res(true)); });
        console.log('\n  old app    ' + (DEB ? oldFile + '   (the installed package, version ' + packageWas + ')' : path.basename(oldFile) + '   in ' + appDir));
        console.log('  display    :' + display + ' (in memory)   port 7890 ' + (held ? 'held back for the user\'s own app' : 'is already in use by something else'));

        section('the released version starts and is given three favorites');
        const debug = await freePort();
        const app = spawn(oldFile, ['--no-sandbox', '--ozone-platform=x11', '--disable-gpu', '--mute-audio', '--inspect=' + debug],
                          { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let log = '';
        app.stdout.on('data', (d) => { log += d; });
        app.stderr.on('data', (d) => { log += d; });
        let oldExited = false;
        app.on('exit', () => { oldExited = true; });
        const oldPort = await until('its server', async () => { for (let p = 7891; p < 7900; p++) { try { if (await status(p)) return p; } catch (e) { /* next */ } } return 0; }, 60000);
        if (held) squatter.close();
        ok(!!oldPort, 'it is up, on port ' + oldPort);
        for (const f of seed.FAVORITES.slice().reverse()) {
            await fetch('http://127.0.0.1:' + oldPort + '/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
        }
        const before = rowsOf(await get(oldPort, '/favorites'));
        ok(seed.FAVORITES.every((f) => before.some((r) => r.id === f.id)), 'its own POST /favorites stored all three: ' + before.map((r) => r.name).join(', '));

        section('its own check, three seconds after its window opens');
        const found = await until('its updater to report', () => (/Found version (\S+)/.exec(log) || [])[1], 60000).catch(() => null);
        ok(found === WANT, 'its updater wrote "Found version ' + found + '"' + (found === WANT ? '' : ' (wanted ' + WANT + ')'));
        const line = log.split('\n').find((l) => /Found version/.test(l));
        if (line) console.log('        | ' + line.trim().slice(0, 200));

        section('its "Download now?" box, answered the way pressing Enter answers it');
        const press = async (title) => {
            const id = await until('the box titled ' + title, () => ((xdo('search', '--name', title).stdout || '').trim().split('\n').filter(Boolean).pop() || ''), 20000).catch(() => '');
            if (!id) return 'the box was not found';
            xdo('windowfocus', id); await sleep(400);
            xdo('key', 'Return');
            return 'Enter pressed in window ' + id + ' ("' + ((xdo('getwindowname', id).stdout || '').trim()) + '")';
        };
        let how = await press('Update Available');
        let started = await until('the download to start', () => /Downloading update from/i.test(log), 15000).catch(() => false);
        if (!started) {
            /* Said, and then done from outside so the rest can still be checked. */
            console.log('        (' + how + '; no download started, so the same function its button calls is called from outside)');
            const list = await (await fetch('http://127.0.0.1:' + debug + '/json')).json();
            const ws = new WebSocket(list[0].webSocketDebuggerUrl);
            await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'process.mainModule.require("electron-updater").autoUpdater.downloadUpdate().then(() => 1, () => 0)', awaitPromise: false } }));
            how = 'called from outside';
            started = await until('the download to start', () => /Downloading update from/i.test(log), 15000).catch(() => false);
            try { ws.close(); } catch (e) { /* closed */ }
        }
        ok(!!started, 'the download starts (' + how + ')');
        const done = await until('the download to finish', () => /New version \S+ has been downloaded/i.test(log) || /\[AutoUpdater\]|ERR_UPDATER|sha512 checksum mismatch/i.test(log), 6 * 60 * 1000, 1000).catch(() => false);
        const downloaded = /New version (\S+) has been downloaded to (\S+)/i.exec(log);
        ok(!!downloaded, 'its updater downloaded it and accepted its checksum' + (downloaded ? ': version ' + downloaded[1] : ''));
        const bad = log.split('\n').filter((l) => /\[AutoUpdater\]|ERR_UPDATER|checksum mismatch/i.test(l));
        ok(bad.length === 0, 'with no updater error in its output' + (bad.length ? ': ' + bad.slice(0, 2).join(' | ').slice(0, 300) : ''));

        section('its "Restart now?" box');
        const newPort = await freePort();
        /* 0.7.2 lives on the port in this file; without it the new version would come up on
         * 7890, the user's. (The old version does not read it.) */
        fs.writeFileSync(path.join(userData, 'port.json'), JSON.stringify({ port: newPort }));
        how = await press('Update Ready');
        const replaced = () => (DEB ? packageVersion() === WANT : fs.readdirSync(appDir).some((f) => f.includes(WANT)) && !fs.existsSync(oldFile));
        const swapped = await until('the new version to take the old one\'s place', replaced, DEB ? 120000 : 40000).catch(() => false);
        if (!swapped) {
            console.log('        (' + how + '; nothing was replaced, so the same function its button calls is called from outside)');
            try {
                const list = await (await fetch('http://127.0.0.1:' + debug + '/json')).json();
                const ws = new WebSocket(list[0].webSocketDebuggerUrl);
                await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
                ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'process.mainModule.require("electron-updater").autoUpdater.quitAndInstall()' } }));
                how = 'called from outside';
            } catch (e) { how = 'could not be called from outside either: ' + e.message; }
        }
        await until('the new version', replaced, DEB ? 120000 : 60000).catch(() => false);
        const files = fs.readdirSync(appDir);
        if (DEB) ok(packageVersion() === WANT, 'the installed package is now version ' + packageVersion() + ', it was ' + packageWas + ' (' + how + ')');
        else ok(files.some((f) => f.includes(WANT)) && !fs.existsSync(oldFile), 'the old file is gone and the new one is in its folder (' + how + '): ' + files.join(', '));

        section('what comes up in its place');
        const st = await until('the new version\'s server', () => status(newPort), 90000).catch(() => null);
        ok(!!st && st.version === WANT, 'the app restarts by itself as ' + (st && st.version) + ', on the port it was given (' + newPort + ')');
        await sleep(1500);
        ok(oldExited, 'the old version has exited');
        const after = st ? rowsOf(await get(newPort, '/favorites')) : [];
        ok(seed.FAVORITES.every((f) => after.some((r) => r.id === f.id)), 'the three favorites the old version held are still there: ' + after.map((r) => r.name).join(', '));
        let newFile = files.map((f) => path.join(appDir, f)).find((f) => f.includes(WANT));
        if (DEB) {
            /* What its updater downloaded and handed to dpkg is still in its cache. */
            const pending = path.join(tmp, 'cache', 'ani-mate-updater', 'pending');
            newFile = fs.existsSync(pending) ? fs.readdirSync(pending).map((f) => path.join(pending, f)).find((f) => /\.deb$/.test(f)) : null;
        }
        if (newFile && fs.existsSync(newFile) && YML && fs.existsSync(YML)) {
            const sum = crypto.createHash('sha512').update(fs.readFileSync(newFile)).digest('base64');
            const yml = fs.readFileSync(YML, 'utf8');
            const want = DEB ? (/\.deb\s*\n\s*sha512: (\S+)/.exec(yml) || [])[1] : (/sha512: (\S+)/.exec(yml) || [])[1];
            ok(sum === want, 'the file it ' + (DEB ? 'installed' : 'now runs from') + ' is the published ' + (DEB ? '.deb' : 'AppImage') + ', byte for byte (sha512 ' + sum.slice(0, 16) + '...)');
        }
        const servers = holding(tmp).filter((pid) => { try { return /ani-mate-server\.js/.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')); } catch (e) { return false; } });
        ok(servers.length === 1, 'one server is running, the new one (' + servers.length + ')');
        const from = servers.length ? fs.readFileSync('/proc/' + servers[0] + '/cmdline', 'utf8').split('\0').find((a) => /ani-mate-server\.js/.test(a)) : '';
        ok(/app\.asar\.unpacked/.test(from), 'and it is the server the new AppImage carries: ' + String(from).replace(/^.*?(resources\/.*)$/, '$1'));
    } catch (e) {
        fails++;
        console.log('  THREW ' + (e && e.stack || e));
    }
    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    await cleanup();
    process.exit(fails ? 1 : 0);
})();
