#!/usr/bin/env node
// YASA PRESENTS
/* smoke-android.js: the phone app on Android, started for real and examined.
 *
 *     node scripts/smoke-android.js --seed       on an OLDER build: put a small library in it
 *     node scripts/smoke-android.js              start the installed build and check it
 *     node scripts/smoke-android.js --seeded     and it must still hold that library
 *
 *     --no-sync         leave out the part that uses the live sync server
 *     --updater accept --update-url <a release's APK address>
 *     --updater refuse --update-url <the same>
 *                       drive the app's own updater with a real release file. `accept` is
 *                       for a build signed with the release key (the file is signed by
 *                       the same key, and must reach Android's installer); `refuse` is
 *                       for a debug build (another key, and it must be turned away)
 *     --shot <file>     save a picture of the screen
 *     --state <file>    where --seed writes down what it did (default: the temp folder)
 *
 * WHY. npm run test:phone runs the phone's page in a desktop browser with stand-ins for
 * everything native. That is the page's logic and nothing else: until this existed no
 * version of the phone app had been started on Android by anything but a person. This
 * starts the installed app on a device adb can see, opens its page over the debugging
 * bridge (what chrome://inspect uses), and asks the page itself.
 *
 * IT NEEDS one device on adb and a DEBUG build installed (a release build does not let
 * its page be examined; see scripts/build-phone-signed.sh --inspect for a signed one).
 *
 * ⛔ FOR AN EMULATOR, NOT FOR A PHONE SOMEONE USES. It closes the app, adds favorites and
 * history rows of its own to the app's library, and (unless --no-sync) makes a sync
 * account on the live server and deletes it again. It refuses a device that is not an
 * emulator unless --throwaway-device is given. To measure one thing on a real phone and
 * change nothing, use scripts/phone-referer-check.js.
 *
 * WHAT IT CHECKS
 *   - Android starts the app, the page loads with no uncaught error, and it says the
 *     version in package.json (the page's own constant, and what Android has on record)
 *   - Capacitor's bridge is the Android one, and the native plugins answer
 *   - the library is the phone's own files: a favorite and a resume point written through
 *     the page are on disk, and are still there after the app is closed and started again
 *   - with --seeded: the favorites and history an older build wrote are all still there
 *   - the page's requests leave through the native HTTP layer and reach the edge server
 *   - which Referer leaves the app (the measurement of tests/referer-probe.js)
 *   - with --updater: the updater turns away an address that is not this project's
 *     release page; downloads a real release file through GitHub's redirects; and then
 *     either hands it to Android's installer (same key) or refuses it (another key)
 *   - sync with the live server: an account made on the phone, a second device (this
 *     computer, running the same engine) joined with the key, favorites and watched
 *     episodes across in both directions, a removal that stays removed. The account is
 *     deleted at the end whatever happened.
 *   - (not counted) a search, an episode list and a playing stream: other people's servers
 *   - nothing of the app's is in Android's crash log
 *
 * Exit code: 0 all passed, 1 a check failed, 2 it could not run.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const seed = require('../tests/smoke-seed');
const probe = require('../tests/referer-probe');
const ENGINE = require('../server/ani-mate-sync.js');

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP = 'com.yasa.animate';
const EDGE = process.env.ANIMATE_EDGE || 'https://ani-mate.yasadevstudio.workers.dev';
const ECHO = opt('--echo', 'https://httpbin.org/headers');
const STATE = opt('--state', path.join(os.tmpdir(), 'animate-smoke-phone-seed.json'));
const SHOT = opt('--shot', '');
const UPDATER = opt('--updater', '');
const UPDATE_URL = opt('--update-url', '');
const NOW_FAVORITE = { id: 'smokeNowBebop0001', name: 'Cowboy Bebop', title_english: 'Cowboy Bebop', episodes: 26 };

function findAdb() {
    if (process.env.ADB) return process.env.ADB;
    const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.HOME || '', 'android-toolchain', 'sdk');
    const inSdk = path.join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    return fs.existsSync(inSdk) ? inSdk : 'adb';
}
const ADB = findAdb();
const adb = (...a) => spawnSync(ADB, a, { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => ((adb('shell', cmd).stdout) || '').replace(/\r/g, '').trim();

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
/* For what this cannot answer for (other people's servers): said, not counted. */
const note = (cond, msg) => console.log((cond ? '  ok    ' : '  note  ') + msg + (cond ? '' : '   (not counted)'));
const section = (t) => console.log('\n' + t + ':');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}
async function until(what, fn, ms, every) {
    const stop = Date.now() + ms;
    let last = null;
    while (Date.now() < stop) {
        try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
        await sleep(every || 500);
    }
    throw new Error(what + ' did not happen in ' + Math.round(ms / 1000) + 's' + (last ? ' (' + (last.message || last) + ')' : ''));
}

/* ── the app, and its page ───────────────────────────────────────────────────────── */
let forwarded = 0;
const letGo = () => { if (forwarded) { adb('forward', '--remove', 'tcp:' + forwarded); forwarded = 0; } };

/** Close the app if it is open, start it, and open its page. */
async function startApp() {
    letGo();
    adb('shell', 'am', 'force-stop', APP);
    await sleep(1000);
    const r = adb('shell', 'am', 'start', '-W', '-n', APP + '/.MainActivity');
    const said = ((r.stdout || '') + (r.stderr || '')).replace(/\r/g, '');
    if (!/Status: ok/.test(said)) throw new Error('Android did not start it: ' + said.trim().split('\n').slice(0, 4).join(' | '));
    const took = (/TotalTime: (\d+)/.exec(said) || [])[1];
    const pid = await until('the app\'s process', () => (sh('pidof ' + APP).split(/\s+/)[0] || null), 30000);
    await until('the page to allow being examined (is this a debug build?)',
                () => sh('cat /proc/net/unix').includes('webview_devtools_remote_' + pid), 60000);
    forwarded = await freePort();
    const f = adb('forward', 'tcp:' + forwarded, 'localabstract:webview_devtools_remote_' + pid);
    if (f.status !== 0) throw new Error('adb could not reach the page: ' + ((f.stderr || f.stdout || '').trim()));
    const cdp = 'http://127.0.0.1:' + forwarded;
    const target = await until('the app\'s page', async () => {
        const list = await (await fetch(cdp + '/json', { signal: AbortSignal.timeout(4000) })).json();
        return list.find((t) => t.type === 'page' && String(t.url).startsWith('https://localhost'));
    }, 60000);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not open the page\'s debugging socket')); });
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
        return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout: ' + method)); }, 150000); });
    };
    const evalJs = async (body) => {
        const r = await send('Runtime.evaluate', { expression: '(async () => { ' + body + ' })()', awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails).slice(0, 400));
        return r.result && r.result.value;
    };
    const pageUntil = async (body, ms) => {
        const stop = Date.now() + (ms || 15000);
        let last = null;
        while (Date.now() < stop) { last = await evalJs(body); if (last) return last; await sleep(400); }
        return last;
    };
    const booted = `return typeof window.API === 'object' && typeof window.Storage === 'object' && !!document.getElementById('search-input') && document.readyState === 'complete';`;
    await send('Runtime.enable');
    await send('Page.enable');
    await pageUntil(booted, 60000);
    /* Loaded again now that errors are being recorded, so what it throws while starting
     * is seen too. */
    await send('Page.reload', { ignoreCache: true });
    await sleep(1500);
    const up = await pageUntil(booted, 60000);
    await sleep(1200);
    return { pid, took, url: target.url, up: !!up, evalJs, until: pageUntil, thrown, send, close: () => { try { ws.close(); } catch (e) { /* closed */ } } };
}

/** A file in the app's private storage, read from outside the app. Only a debug build
 *  allows that; for any other this answers null and the check that wanted it says so. */
const outsideAccess = () => adb('shell', 'run-as', APP, 'true').status === 0;
const appFile = (rel) => {
    const r = adb('shell', 'run-as', APP, 'cat', 'files/' + rel);
    return r.status === 0 ? (r.stdout || '') : null;
};
/** Which screen is in front, and the words on it. */
const inFront = () => sh('dumpsys window').split('\n').filter((l) => /mCurrentFocus|mFocusedApp/.test(l)).map((l) => l.trim()).join(' ');
function wordsOnScreen() {
    adb('shell', 'uiautomator', 'dump', '/sdcard/animate-smoke-window.xml');
    const xml = sh('cat /sdcard/animate-smoke-window.xml');
    adb('shell', 'rm', '-f', '/sdcard/animate-smoke-window.xml');
    const out = [];
    const re = /\btext="([^"]+)"/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1].replace(/&#10;/g, ' ').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"'));
    return out;
}

/** A picture of the screen as it is. */
function takePicture(file) {
    try {
        const r = spawnSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
        if (r.status === 0 && r.stdout && r.stdout.length > 1000) { fs.writeFileSync(file, r.stdout); console.log('        (picture of the screen: ' + file + ')'); }
    } catch (e) { console.log('        (no picture: ' + e.message + ')'); }
}

/* ── a second device: this computer, running the same engine the apps run ────────── */
function nodeDevice(label) {
    const ls = new Map(), m = new Map();
    const d = { label, favs: [], hist: [], journal: { favorites: {}, watch: {} } };
    const { create, shape, settingsAdapter } = ENGINE;
    d.shape = shape;
    d.engine = create({
        endpoint: EDGE, platform: 'electron', fetch: (u, i) => fetch(u, i),
        store: { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) },
        adapter: Object.assign({
            loadFavorites: async () => shape.favoritesOut(d.favs),
            loadWatch: async () => shape.watchOut(d.hist),
            loadDeleted: async () => JSON.parse(JSON.stringify(d.journal)),
            applyFavorites: async (rows) => { d.favs = shape.applyFavorites(d.favs, rows); },
            applyWatch: async (rows) => { d.hist = shape.applyWatch(d.hist, rows); },
            saveIdentity: async (kind, updates) => {
                if (kind === 'favorites') d.favs = shape.setIdentity(kind, d.favs, updates);
                else d.hist = shape.setIdentity(kind, d.hist, updates);
            },
            clearDeleted: async (kind, keys) => { for (const k of keys) delete d.journal[kind][k]; },
        }, settingsAdapter({ getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) }, () => {})),
    });
    return d;
}

(async () => {
    // ── is there a device, and is it one this may be run on ────────────────────────
    const list = adb('devices');
    if (list.error) { console.log('\n  SKIP: adb was not found (' + ADB + '). Set ANDROID_HOME or ADB.\n'); process.exit(2); }
    const devices = (list.stdout || '').split('\n').slice(1).filter((l) => /\tdevice\s*$/.test(l));
    if (devices.length !== 1) { console.log('\n  SKIP: this needs exactly one device on adb; adb sees ' + devices.length + '.\n'); process.exit(2); }
    const emulator = sh('getprop ro.kernel.qemu') === '1' || sh('getprop ro.boot.qemu') === '1' || /^emulator-/.test(devices[0]);
    if (!emulator && !has('--throwaway-device')) {
        console.log('\n  STOPPED: the device on adb is not an emulator. This closes the app and writes test rows into'
            + '\n  its library. See the header of this file.\n');
        process.exit(2);
    }
    if (!sh('pm path ' + APP).startsWith('package:')) { console.log('\n  SKIP: ' + APP + ' is not installed on the device.\n'); process.exit(2); }

    let page = null;
    let finished = false;
    const finish = (code) => {
        if (finished) return;
        finished = true;
        if (page) page.close();
        letGo();
        setTimeout(() => process.exit(code), 300);
    };
    setTimeout(() => { console.log('\n  STOPPED: the run passed 14 minutes.\n'); finish(1); }, 14 * 60 * 1000).unref();

    /* The account made on the live server, if one was: cleaned up whatever happens. */
    let recoveryKey = null;
    let other = null;
    const removeAccount = async () => {
        if (!recoveryKey) return null;
        try {
            if (!other) other = nodeDevice('cleanup');
            if (!other.engine.state().signedIn) await other.engine.recover(recoveryKey, 'android smoke cleanup (delete me)');
            await other.engine.deleteAccount();
            recoveryKey = null;
            return true;
        } catch (e) { return 'could not: ' + (e && e.message || e); }
    };

    try {
        adb('logcat', '-c');
        console.log('\n  device     Android ' + sh('getprop ro.build.version.release') + ' (API ' + sh('getprop ro.build.version.sdk') + '), '
            + sh('getprop ro.product.model') + (emulator ? ', an emulator' : ''));
        console.log('  WebView    ' + (sh('dumpsys webviewupdate').split('\n').find((l) => /Current WebView package/.test(l)) || '(not reported)').trim());
        console.log('  the app    ' + (sh('dumpsys package ' + APP).split('\n').filter((l) => /versionName=|versionCode=/.test(l)).map((l) => l.trim()).join('  ') || '(no record)'));

        // ── it starts ──────────────────────────────────────────────────────────────
        section('Android starts the app');
        try { page = await startApp(); }
        catch (e) {
            ok(false, 'the app starts and its page opens: ' + e.message);
            /* Errors and the page's own console only. Capacitor's general log repeats
             * every native call with its arguments, and this output may be public. */
            console.log(sh("logcat -d -t 200 AndroidRuntime:E chromium:E Capacitor/Console:V '*:S'").split('\n').slice(-25).map((l) => '    | ' + l).join('\n'));
            console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
            return finish(1);
        }
        ok(true, 'the app starts' + (page.took ? ' (' + page.took + ' ms)' : '') + ' and its page opens at ' + page.url);
        ok(page.up, 'the page finishes loading: its storage, its API and its search box are there');
        const boot = await page.evalJs(`return {
            title: document.title, tabs: [...document.querySelectorAll('[data-tab]')].map(e => e.dataset.tab),
            version: await (async () => { try { const t = await (await fetch('js/ani-mate-ui.js')).text();
                return (/const APP_VERSION = '([^']*)'/.exec(t) || [])[1] || null; } catch (e) { return null; } })(),
            platform: window.Capacitor && Capacitor.getPlatform ? Capacitor.getPlatform() : null,
            native: !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()),
            agent: navigator.userAgent };`);
        console.log('        (' + boot.agent + ')');
        ok(boot.title === 'ANI-MATE' && boot.tabs.join(',') === 'search,continue,daily,releases,favs', 'it is the app\'s page, with its five tabs: ' + boot.tabs.join(' '));
        if (has('--seed')) console.log('        (this build calls itself ' + boot.version + ')');
        else ok(boot.version === PKG.version, 'the page the app carries says version ' + boot.version + ' (package.json: ' + PKG.version + ')');
        ok(boot.platform === 'android' && boot.native, 'Capacitor\'s bridge is the Android one (' + boot.platform + ')');
        /* For the build under test this counts. For an OLDER build (--seed) it is said
         * and not counted: that build is what it is, and reloading its page from here
         * can catch its bridge between two states. */
        if (has('--seed')) note(page.thrown.length === 0, 'nothing is thrown while it starts' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 3)) : ''));
        else ok(page.thrown.length === 0, 'nothing is thrown while it starts' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 3)) : ''));
        const info = await page.evalJs(`try { const i = await Capacitor.Plugins.App.getInfo(); return { id: i.id, version: i.version, build: i.build }; } catch (e) { return { error: String(e && e.message || e) }; }`);
        if (has('--seed')) ok(info.id === APP, 'Android has it on record as ' + info.id + ' ' + info.version + ' (' + info.build + ')');
        else ok(info.id === APP && info.version === PKG.version, 'Android has it on record as ' + info.id + ' ' + info.version + ' (build ' + info.build + ')');
        const plugins = await page.evalJs(`const out = {};
            const tryIt = async (name, fn) => { try { await fn(); out[name] = 'ok'; } catch (e) { out[name] = String(e && e.message || e).slice(0, 80); } };
            const P = Capacitor.Plugins;
            await tryIt('Filesystem', () => P.Filesystem.readdir({ path: '', directory: 'DATA' }));
            await tryIt('Preferences', () => P.Preferences.keys());
            await tryIt('CapacitorHttp', () => P.CapacitorHttp.get({ url: ${JSON.stringify(EDGE + '/health')} }));
            await tryIt('StatusBar', () => P.StatusBar.getInfo());
            await tryIt('ScreenOrientation', () => P.ScreenOrientation.orientation());
            out.headers = (Capacitor.PluginHeaders || []).map(h => h.name);
            return out;`);
        const answered = ['Filesystem', 'Preferences', 'CapacitorHttp', 'StatusBar', 'ScreenOrientation'].filter((n) => plugins[n] === 'ok');
        ok(answered.length === 5, 'the native plugins answer: ' + answered.join(', ')
            + (answered.length === 5 ? '' : '; NOT ' + JSON.stringify(Object.fromEntries(Object.entries(plugins).filter(([k, v]) => k !== 'headers' && v !== 'ok')))));
        ok(plugins.headers.includes('ApkInstaller') && plugins.headers.includes('WebFetch'),
           'and the app\'s own two are registered (ApkInstaller, WebFetch): ' + plugins.headers.join(' '));

        // ── --seed: an older build, given a library ────────────────────────────────
        if (has('--seed')) {
            section('the older build is given three favorites and two history rows');
            await page.evalJs(`for (const f of ${JSON.stringify(seed.FAVORITES.slice().reverse())}) await window.Storage.addFavorite(f);
                await window.Storage.saveHistory(${JSON.stringify(seed.history())}); return true;`);
            const back = await page.evalJs(`return { favs: await window.Storage.loadFavorites(), hist: await window.Storage.loadHistory(), cont: await window.Storage.getContinueList() };`);
            ok(seed.FAVORITES.every((f) => back.favs.some((r) => r.id === f.id && r.name === f.name)), 'its own addFavorite stored all three: ' + back.favs.map((r) => r.name).join(', '));
            const kept = seed.historyKept(back.hist);
            ok(kept.both && kept.watched && kept.resume, 'and it reads the history rows back as its own: ' + kept.saw);
            const fr = (back.cont || []).find((c) => c.anime_id === 'smokeSeedFrieren01');
            ok(!!fr && String(fr.resume_episode) === '4' && Number(fr.resume_time) === 312.5, 'offering to resume episode 4 at 312.5 seconds');
            page.close();
            page = await startApp();
            const again = await page.evalJs(`return { favs: (await window.Storage.loadFavorites()).map(f => f.id), hist: (await window.Storage.loadHistory()).map(h => h.anime_id) };`);
            ok(seed.FAVORITES.every((f) => again.favs.includes(f.id)) && again.hist.length === 2, 'all of it is still there after the app is closed and started again');
            const onDisk = appFile('ani-mate-data/favorites.json');
            ok(!!onDisk && seed.FAVORITES.every((f) => onDisk.includes(f.id)), 'and it is in the app\'s own files on the device (favorites.json, ' + (onDisk ? onDisk.length : 0) + ' characters)');
            fs.writeFileSync(STATE, JSON.stringify({ from: boot.version, android: info, at: new Date().toISOString() }));
            if (SHOT) { await sleep(1500); takePicture(SHOT); }
            console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
            return finish(fails ? 1 : 0);
        }

        // ── the library an older build left ────────────────────────────────────────
        if (has('--seeded')) {
            section('the library the older build left');
            let from = null;
            try { from = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* said below */ }
            ok(!!from, 'an older build was here first' + (from ? ' (it called itself ' + from.from + ', seeded ' + from.at + ')' : ': NO, --seed has not run'));
            const lib = await page.evalJs(`return { favs: await window.Storage.loadFavorites(), hist: await window.Storage.loadHistory(), cont: await window.Storage.getContinueList() };`);
            ok(seed.FAVORITES.every((f) => lib.favs.some((r) => r.id === f.id && r.name === f.name)), 'all three favorites are there: ' + lib.favs.map((r) => r.name).join(', '));
            const kept = seed.historyKept(lib.hist);
            ok(kept.both, 'both history rows are there');
            ok(kept.watched, 'with what was watched: ' + kept.saw);
            ok(kept.resume, 'and where to resume (episode 4 at 312.5 seconds)');
            const fr = (lib.cont || []).find((c) => c.anime_id === 'smokeSeedFrieren01');
            ok(!!fr && String(fr.resume_episode) === '4' && Number(fr.resume_time) === 312.5, 'CONTINUE offers the same: ' + JSON.stringify(fr && { e: fr.resume_episode, t: fr.resume_time }));
            /* The tab is tapped at once, which on a slow device is before the app has
             * finished reading its two lists. It must fill in when they arrive (it used
             * to stay on "No favorites yet"); how long that took is said. */
            const tapped = Date.now();
            await page.evalJs(`document.querySelector('[data-tab="favs"]').click(); return true;`);
            const cards = await page.until(`return document.querySelectorAll('#results-container .result-card').length;`, 90000);
            const took = ((Date.now() - tapped) / 1000).toFixed(1);
            const titles = await page.evalJs(`return [...document.querySelectorAll('#results-container .result-card')].map(c => c.dataset.title || c.textContent.trim().slice(0, 40));`);
            const shown = cards ? '' : await page.evalJs(`return (document.getElementById('results-container') || {}).innerText || '';`);
            ok(cards >= 3, 'and the FAVS tab draws them: ' + cards + ' cards, ' + took + ' s after the tap (' + titles.slice(0, 4).join(' | ') + ')'
                + (cards ? '' : '; the tab says: ' + JSON.stringify(String(shown).slice(0, 120))));
            await page.evalJs(`document.querySelector('[data-tab="search"]').click(); return true;`);
        }

        // ── its storage ────────────────────────────────────────────────────────────
        section('the library is the phone\'s own files');
        await page.evalJs(`await window.Storage.addFavorite(${JSON.stringify(NOW_FAVORITE)});
            await window.Storage.addToHistory({ anime_id: ${JSON.stringify(NOW_FAVORITE.id)}, title: 'Cowboy Bebop', episode: 2, total_episodes: 26, mode: 'sub', skip_watched: true });
            await window.Storage.saveProgress(${JSON.stringify(NOW_FAVORITE.id)}, 2, 95.5); return true;`);
        const wrote = await page.evalJs(`return { favs: (await window.Storage.loadFavorites()).map(f => f.id), cont: (await window.Storage.getContinueList()).find(c => c.anime_id === ${JSON.stringify(NOW_FAVORITE.id)}) || null };`);
        ok(wrote.favs.includes(NOW_FAVORITE.id), 'a favorite added through the page is in the list');
        ok(!!wrote.cont && String(wrote.cont.resume_episode) === '2' && Number(wrote.cont.resume_time) === 95.5, 'and a resume point is kept: ' + JSON.stringify(wrote.cont && { e: wrote.cont.resume_episode, t: wrote.cont.resume_time }));
        if (outsideAccess()) {
            const disk = appFile('ani-mate-data/favorites.json');
            ok(!!disk && disk.includes(NOW_FAVORITE.id), 'read from outside the app, favorites.json on the device holds it (' + (disk ? disk.length + ' characters' : 'the file could not be read') + ')');
        } else {
            const disk = await page.evalJs(`try { const r = await Capacitor.Plugins.Filesystem.readFile({ path: 'ani-mate-data/favorites.json', directory: 'DATA', encoding: 'utf8' }); return String(r.data); } catch (e) { return ''; }`);
            ok(disk.includes(NOW_FAVORITE.id), 'favorites.json in the app\'s own files holds it (' + disk.length + ' characters; this build cannot be read from outside, so the native file plugin read it)');
        }
        page.close();
        page = await startApp();
        const after = await page.evalJs(`return { favs: (await window.Storage.loadFavorites()).map(f => f.id), cont: (await window.Storage.getContinueList()).find(c => c.anime_id === ${JSON.stringify(NOW_FAVORITE.id)}) || null };`);
        ok(after.favs.includes(NOW_FAVORITE.id) && !!after.cont && Number(after.cont.resume_time) === 95.5, 'both are still there after the app is closed and started again');
        ok(page.thrown.length === 0, 'and the second start throws nothing either' + (page.thrown.length ? ': ' + JSON.stringify(page.thrown.slice(0, 3)) : ''));

        // ── the network ────────────────────────────────────────────────────────────
        section('the page\'s requests leave the way a phone\'s do');
        const net1 = await page.evalJs(`const out = { fetchIsBrowsersOwn: /\\[native code\\]/.test(Function.prototype.toString.call(window.fetch)) };
            try { const r = await fetch(${JSON.stringify(EDGE + '/health')}); out.status = r.status; const j = await r.json(); out.api = j.api; out.features = (j.features || []).length; }
            catch (e) { out.error = String(e && e.message || e); }
            return out;`);
        ok(net1.status === 200 && net1.api === 2, 'the edge server answers the page (HTTP ' + net1.status + ', api ' + net1.api + ', ' + net1.features + ' features)' + (net1.error ? ': ' + net1.error : ''));
        ok(net1.fetchIsBrowsersOwn === false, 'through Capacitor\'s replacement for fetch, which is the native HTTP layer');

        section('the Referer that leaves the app (audit row 23)');
        const measured = await page.evalJs(probe.probeBody(ECHO, probe.REFERER)).catch((e) => ({ failed: String(e && e.message || e) }));
        if (measured.failed) note(false, 'the measurement did not run: ' + measured.failed);
        else {
            for (const l of probe.lines(measured, probe.REFERER)) console.log('        ' + l);
            const viaPlayer = probe.seen(measured.xhr), viaNative = probe.seen(measured.nativeGet);
            if (/^\(/.test(viaNative)) note(false, 'the echo could not be reached, so nothing is concluded: ' + viaNative);
            else {
                ok(viaNative === probe.REFERER, 'a direct CapacitorHttp.get carries the stream\'s Referer, which the second loader relies on');
                console.log('        READING: on this Android the player\'s own requests ' + (viaPlayer === probe.REFERER ? 'DO' : 'do NOT')
                    + ' carry the stream\'s Referer (the host sees ' + JSON.stringify(viaPlayer) + ').');
            }
        }

        // ── the updater ────────────────────────────────────────────────────────────
        if (UPDATER) {
            section('the updater, given a real release file');
            const update = (url) => page.evalJs(`try { const out = { percent: 0 };
                const l = await Capacitor.Plugins.ApkInstaller.addListener('downloadProgress', (d) => { out.percent = d.percent; });
                try { out.result = await Capacitor.Plugins.ApkInstaller.downloadAndInstall({ url: ${JSON.stringify(url)} }); }
                finally { try { await l.remove(); } catch (e) {} }
                return out; } catch (e) { return { error: String(e && e.message || e) }; }`);
            const elsewhere = await update('https://example.com/ANI-MATE-9.9.9-mobile.apk');
            ok(/not a download from this app's release page/.test(String(elsewhere.error)), 'an address that is not this project\'s release page is turned away: ' + (elsewhere.error || JSON.stringify(elsewhere)));
            if (!/^https:\/\/github\.com\//i.test(UPDATE_URL)) ok(false, '--update-url has to be a release file\'s address; got ' + JSON.stringify(UPDATE_URL));
            else {
                console.log('        (the file: ' + UPDATE_URL + ')');
                const got = await update(UPDATE_URL);
                if (UPDATER === 'refuse') {
                    ok(/not signed by the makers of this app/.test(String(got.error)),
                       'the release file is downloaded, found to be signed with another key than this build, and refused: ' + (got.error || JSON.stringify(got)));
                    ok(inFront().includes(APP), 'and Android\'s installer was not opened');
                    if (outsideAccess()) {
                        const left = sh('run-as ' + APP + ' ls cache/updates');
                        ok(!/\.apk/.test(left), 'the refused file is not left behind in the app\'s cache' + (left ? ': ' + left : ''));
                    }
                } else {
                    ok(!!got.result && got.result.success === true, 'the release file is downloaded, found to be this app under the same key, and handed over'
                        + (got.error ? ': ' + got.error : ' (progress reached ' + got.percent + '%)'));
                    let front = '';
                    for (let i = 0; i < 20 && !/packageinstaller/i.test(front); i++) { await sleep(1000); front = inFront(); }
                    ok(/packageinstaller/i.test(front), 'Android\'s installer comes to the front: ' + front.slice(0, 150));
                    await sleep(2500);
                    const words = wordsOnScreen();
                    console.log('        (it says: ' + words.join(' | ').slice(0, 220) + ')');
                    ok(words.length > 0 && !/problem|corrupt|can.t open|not installed/i.test(words.join(' ')), 'and it could read the file: no parsing or opening error on its screen');
                    adb('shell', 'input', 'keyevent', '4');
                    await sleep(1500);
                    adb('shell', 'input', 'keyevent', '4');
                }
            }
            page.close();
            page = await startApp();
        }

        // ── sync ───────────────────────────────────────────────────────────────────
        if (!has('--no-sync')) {
            section('sync with the live server (a throwaway account, deleted at the end)');
            const phoneSync = () => page.evalJs(`try { const r = await window.SYNC.sync(); return { ok: !r || r.ok !== false, error: r && r.error || null }; }
                catch (e) { return { ok: false, error: String(e && e.message || e) }; }`);
            const phoneLists = () => page.evalJs(`return { favs: await window.Storage.loadFavorites(), hist: await window.Storage.loadHistory(), state: window.SYNC.state() };`);
            const made = await page.evalJs(`try { if (window.SYNC.state().signedIn) return { error: 'this app is already signed in to an account' };
                const a = await window.SYNC.createAccount('android smoke (delete me)'); return { key: a && a.recovery_key || null }; }
                catch (e) { return { error: String(e && e.message || e) }; }`);
            recoveryKey = made.key || null;
            ok(!!recoveryKey, 'an account is made from the phone, and a recovery key comes back' + (made.error ? ': ' + made.error : ''));
            if (recoveryKey) {
                let r = await phoneSync();
                ok(r.ok, 'the phone syncs its library up' + (r.error ? ': ' + r.error : ''));
                other = nodeDevice('second device');
                other.favs.unshift({ id: 'smokeOtherTrigun01', name: 'Trigun', title_english: 'Trigun', episodes: 26, added: new Date(Date.now() - 7200e3).toISOString() });
                other.hist.unshift({ anime_id: 'smokeOtherTrigun01', title: 'Trigun', episode: '5', quality: 'best', mode: 'sub',
                                     timestamp: new Date(Date.now() - 5400e3).toISOString(), episodes_watched: ['1', '2', '5'], total_episodes: 26,
                                     playback_time: 0, playback_episode: null });
                await other.engine.recover(recoveryKey, 'android smoke, second device (delete me)');
                ok(other.engine.state().signedIn, 'a second device joins with the key');
                for (let i = 0; i < 3; i++) { await other.engine.sync(); r = await phoneSync(); }
                ok(r.ok, 'both sync, three rounds' + (r.error ? ': ' + r.error : ''));
                let phone = await phoneLists();
                const names = (rows) => rows.map((f) => f.name);
                ok(names(phone.favs).includes('Trigun'), 'the other device\'s favorite arrives on the phone: ' + names(phone.favs).join(', '));
                const expected = ['Cowboy Bebop'].concat(has('--seeded') ? seed.FAVORITES.map((f) => f.name) : []);
                ok(expected.every((n) => names(other.favs).includes(n)), 'the phone\'s favorites arrive on the other device: ' + names(other.favs).join(', '));
                const tr = phone.hist.find((h) => h.title === 'Trigun');
                ok(!!tr && (tr.episodes_watched || []).map(String).sort().join(',') === '1,2,5', 'with what was watched there: ' + JSON.stringify(tr && tr.episodes_watched));
                const bb = other.hist.find((h) => h.title === 'Cowboy Bebop');
                ok(!!bb && Number(bb.playback_time) === 95.5 && String(bb.playback_episode) === '2', 'and the phone\'s resume point (episode 2 at 95.5 seconds): ' + JSON.stringify(bb && { e: bb.playback_episode, t: bb.playback_time }));
                if (has('--seeded')) {
                    const fr = other.hist.find((h) => h.title === 'Sousou no Frieren');
                    ok(!!fr && (fr.episodes_watched || []).map(String).sort().join(',') === '1,2,3' && Number(fr.playback_time) === 312.5,
                       'the history the older build left goes up too: ' + JSON.stringify(fr && { w: fr.episodes_watched, t: fr.playback_time }));
                }
                const sameCount = new Set(names(phone.favs)).size === phone.favs.length && new Set(names(other.favs)).size === other.favs.length;
                ok(sameCount, 'no show is listed twice on either (' + phone.favs.length + ' on the phone, ' + other.favs.length + ' on the other)');

                /* A removal, made on the phone with the button's own function. */
                await page.evalJs(`const f = (await window.Storage.loadFavorites()).find(x => x.name === 'Trigun'); if (f) await window.Storage.removeFavorite(f.id); return !!f;`);
                for (let i = 0; i < 2; i++) { r = await phoneSync(); await other.engine.sync(); }
                phone = await phoneLists();
                ok(!names(phone.favs).includes('Trigun') && !names(other.favs).includes('Trigun'), 'a favorite removed on the phone is gone from both, and stays gone');
                ok(names(phone.favs).includes('Cowboy Bebop') && names(other.favs).includes('Cowboy Bebop'), 'and nothing else went with it');
            }
            const removed = await removeAccount();
            if (removed !== null) ok(removed === true, 'the throwaway account is deleted' + (removed === true ? '' : ': ' + removed + '. It has to be removed by hand.'));
            await page.evalJs(`try { if (window.SYNC.state().signedIn) await window.SYNC.signOut(); } catch (e) {} return true;`);
        }

        // ── other people's servers ─────────────────────────────────────────────────
        section('a search, an episode list, a stream (other people\'s servers)');
        try {
            await page.evalJs(`document.querySelector('[data-tab="search"]').click(); const i = document.getElementById('search-input'); i.value = 'frieren';
                i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
            const cards = await page.until(`return document.querySelectorAll('#results-container .result-card').length;`, 40000);
            note(cards > 0, 'a search for "frieren" draws ' + (cards || 0) + ' results');
            if (cards > 0) {
                await page.evalJs(`document.querySelector('#results-container .result-card').click(); return true;`);
                const eps = await page.until(`return document.querySelectorAll('#episode-grid .episode-btn').length;`, 40000);
                note(eps > 0, 'opening the first one lists ' + (eps || 0) + ' episodes');
                if (eps > 0) {
                    await page.evalJs(`const b = [...document.querySelectorAll('#episode-grid .episode-btn')].find(x => x.dataset.ep === '1') || document.querySelector('#episode-grid .episode-btn');
                        b.click(); await new Promise(r => setTimeout(r, 200)); const p = document.getElementById('play-btn'); if (p) p.click(); return true;`);
                    const t = await page.until(`const v = document.getElementById('video-player'); return v && v.currentTime > 1 ? v.currentTime : 0;`, 75000);
                    const v = await page.evalJs(`const v = document.getElementById('video-player'); return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, err: v.error ? v.error.code : null } : null;`);
                    note(t > 0, 'episode 1 plays: ' + JSON.stringify(v));
                    await page.evalJs(`const b = document.getElementById('player-back'); if (b) b.click(); return true;`);
                    await sleep(800);
                }
                await page.evalJs(`const b = document.getElementById('panel-back'); if (b) b.click(); return true;`);
            }
        } catch (e) { note(false, 'this part stopped: ' + (e && e.message || e)); }

        // ── what Android wrote down ────────────────────────────────────────────────
        section('what Android logged');
        const crashes = sh('logcat -d -b crash').split('\n').filter((l) => l.includes(APP) || /FATAL EXCEPTION/.test(l));
        const ours = crashes.filter((l) => l.includes(APP));
        ok(ours.length === 0, 'nothing of the app\'s is in the crash log' + (ours.length ? ': ' + ours.slice(0, 3).join(' | ') : ''));
        const errors = sh('logcat -d -s Capacitor/Console:E').split('\n').filter((l) => /Capacitor\/Console/.test(l));
        console.log('        (' + errors.length + ' error lines from the page\'s console' + (errors.length ? ', the first: ' + errors.slice(0, 3).map((l) => l.replace(/^.*Capacitor\/Console[^:]*:\s*/, '').slice(0, 150)).join(' || ') : '') + ')');

        if (SHOT) {
            /* Two pictures: the screen as the app left it, and the library with the
             * first-run panels put away. */
            takePicture(SHOT.replace(/\.png$/, '-as-opened.png'));
            try {
                await page.evalJs(`for (const id of ['sync-intro-no', 's-intro-no', 'changelog-close', 'changelog-ok']) { const b = document.getElementById(id); if (b) b.click(); }
                    for (const b of document.querySelectorAll('button')) { if (/^(NOT NOW|GOT IT|OK|CLOSE)$/i.test(b.textContent.trim())) b.click(); }
                    document.querySelector('[data-tab="favs"]').click(); return true;`);
                await sleep(2500);
            } catch (e) { /* the picture is taken anyway */ }
            takePicture(SHOT);
        }
    } catch (e) {
        fails++;
        console.log('  THREW ' + (e && e.stack || e));
    }
    if (recoveryKey) {
        const removed = await removeAccount();
        console.log(removed === true ? '  (the throwaway account was deleted)' : '  ⛔ THE THROWAWAY ACCOUNT WAS NOT DELETED: ' + removed);
        if (removed !== true) fails++;
    }
    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    finish(fails ? 1 : 0);
})();
