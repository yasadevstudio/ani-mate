#!/usr/bin/env node
// YASA PRESENTS
/* phone-referer-check.js: ON A REAL PHONE, which Referer leaves the app.
 *
 *     bash scripts/build-phone-signed.sh --inspect --install     once
 *     (open ANI-MATE on the phone)
 *     node scripts/phone-referer-check.js
 *
 * WHY. Video hosts refuse a segment request that does not carry their player page as its
 * Referer. Whether the phone's player can send one was argued from a reading of
 * Capacitor's source on 2026-11-12, then measured on 2026-11-14 in a desktop browser with
 * Capacitor's own script (npm run test:phone): the Referer the player sets did not
 * arrive, a direct CapacitorHttp.get carried it. That is still not Android. This is the
 * same measurement (tests/referer-probe.js), run in the app's own page on the phone.
 *
 * HOW. An --inspect build lets this computer open the app's page over USB (Android's
 * WebView debugging, the thing chrome://inspect uses). This script finds that page,
 * runs the measurement in it, prints what arrived, and lets go.
 *
 * ⛔ IT ONLY READS. It installs nothing, changes nothing on the phone, and does not start
 * or stop the app. It asks one outside address, an echo that answers with the headers it
 * was sent (https://httpbin.org/headers, or --echo <https address>); the Referer it
 * sends is a made-up one. The echo has to be HTTPS: the app does not allow plain HTTP.
 *
 *     --echo <url>              another echo that answers {"headers":{...}}
 *     --cdp <http://host:port>  skip adb and attach to a debugging port directly
 *     --match <text>            with --cdp: pick the page whose address contains this
 *
 * Exit code: 0 measured, 1 measured but something failed, 2 could not attach.
 */
'use strict';
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const probe = require(path.join(__dirname, '..', 'tests', 'referer-probe.js'));

const APP = 'com.yasa.animate';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const ECHO = opt('--echo', 'https://httpbin.org/headers');
const ADB = process.env.ADB || path.join(process.env.ANDROID_HOME || path.join(process.env.HOME || '', 'android-toolchain', 'sdk'), 'platform-tools', 'adb');

const adb = (...a) => spawnSync(ADB, a, { encoding: 'utf8' });
const stop = (code, msg) => { if (msg) console.log('\n  ' + msg + '\n'); process.exit(code); };
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

(async () => {
    let cdp = opt('--cdp', '');
    let match = opt('--match', 'https://localhost');
    let forwarded = 0;
    if (!cdp) {
        const list = adb('devices');
        if (list.error) stop(2, 'adb was not found at ' + ADB + ' (set ANDROID_HOME or ADB).');
        const phones = (list.stdout || '').split('\n').slice(1).filter((l) => /\tdevice$/.test(l.trim()));
        if (phones.length !== 1) stop(2, 'This needs exactly one phone on USB with USB debugging on; adb sees ' + phones.length + '.');
        const pid = (adb('shell', 'pidof', APP).stdout || '').trim().split(/\s+/)[0];
        if (!pid) stop(2, 'ANI-MATE is not open on the phone. Open it and run this again.');
        const sockets = adb('shell', 'cat', '/proc/net/unix').stdout || '';
        if (!sockets.includes('webview_devtools_remote_' + pid)) {
            stop(2, 'The app on the phone does not let its page be examined. Install a build made with\n'
                + '      bash scripts/build-phone-signed.sh --inspect --install\n  open it, and run this again.');
        }
        forwarded = await freePort();
        const f = adb('forward', 'tcp:' + forwarded, 'localabstract:webview_devtools_remote_' + pid);
        if (f.status !== 0) stop(2, 'adb could not reach the app\'s page: ' + (f.stderr || f.stdout || '').trim());
        cdp = 'http://127.0.0.1:' + forwarded;
    }
    const letGo = () => { if (forwarded) adb('forward', '--remove', 'tcp:' + forwarded); };

    let code = 0;
    try {
        const targets = await (await fetch(cdp + '/json', { signal: AbortSignal.timeout(8000) })).json();
        const page = targets.find((t) => t.type === 'page' && String(t.url).includes(match)) || targets.find((t) => t.type === 'page');
        if (!page) { letGo(); stop(2, 'No page was found to examine (' + targets.length + ' targets).'); }
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not open the page\'s debugging socket')); });
        const result = await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('the page did not answer in 90 seconds')), 90000);
            ws.onmessage = (ev) => {
                const m = JSON.parse(ev.data);
                if (m.id !== 1) return;
                clearTimeout(timer);
                if (m.error) return rej(new Error(m.error.message));
                if (m.result.exceptionDetails) return rej(new Error(JSON.stringify(m.result.exceptionDetails.exception || m.result.exceptionDetails).slice(0, 300)));
                res(m.result.result.value);
            };
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
                expression: '(async () => { const __out = await (async () => { ' + probe.probeBody(ECHO, probe.REFERER) + ' })();'
                    + ' __out.agent = navigator.userAgent; return __out; })()',
                awaitPromise: true, returnByValue: true } }));
        });
        try { ws.close(); } catch (e) { /* closed */ }

        console.log('\n  the page examined   ' + page.url + (forwarded ? '   (on the phone, over USB)' : '   (' + cdp + ')'));
        console.log('  its browser         ' + result.agent);
        console.log('  the echo            ' + ECHO + '\n');
        for (const l of probe.lines(result, probe.REFERER)) console.log('  ' + l);
        const x = probe.seen(result.xhr), n = probe.seen(result.nativeGet);
        const where = forwarded ? 'on this phone' : 'in this page';
        console.log('');
        if (result.xhr && result.xhr.error) { code = 1; console.log('  The player\'s way could not be measured: ' + result.xhr.error); }
        else if (x === probe.REFERER) console.log('  READING: ' + where + ' the player\'s own requests DO carry the stream\'s Referer.');
        else console.log('  READING: ' + where + ' the player\'s own requests do NOT carry the stream\'s Referer; the host sees ' + JSON.stringify(x) + '.');
        if (result.nativeGet && result.nativeGet.error) { code = 1; console.log('  The second loader\'s way could not be measured: ' + result.nativeGet.error); }
        else if (n === probe.REFERER) console.log('           The second loader\'s call (CapacitorHttp.get) does carry it.');
        else console.log('           The second loader\'s call (CapacitorHttp.get) does NOT carry it either; the host sees ' + JSON.stringify(n) + '.');
        console.log('');
    } catch (e) {
        code = 2;
        console.log('\n  Could not measure: ' + (e && e.message || e) + '\n');
    }
    letGo();
    process.exit(code);
})();
