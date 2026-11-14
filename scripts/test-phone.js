#!/usr/bin/env node
// YASA PRESENTS
/* test-phone.js: the PHONE's page, driven in a desktop browser.
 *
 *     npm run test:phone
 *
 * mobile/www is a web page. Capacitor wraps it in an app, but the page itself starts
 * without Capacitor (it was written to: storage falls back to localStorage, the network
 * layer to fetch). So everything that is the page's own logic can be run here: search,
 * opening a show, playing, what is stored, the star, the switches.
 *
 * WHAT IT STARTS, all on this machine, all thrown away afterwards:
 *     a file server   mobile/www, as is
 *     a video host    24 seconds of test pattern cut into HLS by ffmpeg, served with
 *                     the cross-origin header a phone does not need and a browser does.
 *                     The same stream is also served under /gated/, where every request
 *                     must carry the stream's Referer or gets 403, the way real video
 *                     hosts behave; and /__echo answers with the headers it was sent.
 *     Capacitor's     its own page-side script (native-bridge.js, out of
 *     request patch   mobile/node_modules) on a blank page, with a stand-in for the
 *                     native half that forwards a request the way
 *                     WebViewLocalServer.java reads: the headers the browser put on it
 *     a browser       headless, phone-sized, empty profile
 *     a second phone  the same page on a second port, which the browser treats as a
 *                     different site with its own storage: a second device
 *     the Worker      worker/src, run by `wrangler dev` on a LOCAL database in the temp
 *                     folder, for the part where the two phones sync. Skipped, and said
 *                     so, when wrangler is not installed. Nothing is deployed.
 * then runs tests/dom-phone.test.js, which answers every outside address the page asks
 * for (the edge Worker, AllAnime, AniList, GitHub) from stand-ins of its own. No request
 * leaves this machine.
 *
 * ⛔ WHAT THIS IS NOT. It is not Android. The WebView, Capacitor's bridge and its HTTP
 * patch, the native installer and what Referer leaves the phone are not here; those need
 * a device (see app/src/androidTest/.../RefererTest.java).
 *
 * Exit code: the suite's (0 pass, 1 fail), or 2 when there is no browser or no ffmpeg.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const env = require('./test-env');

const ROOT = env.ROOT;
const WWW = path.join(ROOT, 'mobile', 'www');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
                '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

function serve(dir, extraHeaders) {
    const srv = http.createServer((req, res) => {
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.join(dir, p === '/' ? 'index.html' : p);
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no'); }
        res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                                           'Cache-Control': 'no-store' }, extraHeaders || {}));
        res.end(fs.readFileSync(file));
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const STREAM_REFERER = 'https://stream.example/';

/** The video host: the stream, the same stream behind a Referer check, and an echo. */
function videoHost(media) {
    const gated = [];
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        if (u.pathname === '/__echo') {
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
            return res.end(JSON.stringify({ headers: req.headers, via: u.searchParams.get('via') }));
        }
        if (u.pathname === '/__gated-log') {
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
            return res.end(JSON.stringify(gated));
        }
        const isGated = u.pathname.startsWith('/gated/');
        const file = path.join(media, path.basename(u.pathname));
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, cors); return res.end('no'); }
        if (isGated) {
            const ok = String(req.headers.referer || '').startsWith(STREAM_REFERER);
            gated.push({ file: path.basename(u.pathname), referer: req.headers.referer || null, ok });
            if (!ok) { res.writeHead(403, cors); return res.end('this host wants its own page as the Referer'); }
        }
        res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }, cors));
        res.end(fs.readFileSync(file));
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

/** The phone's page, plus a blank page that carries Capacitor's own page-side script,
 *  plus a stand-in for what Capacitor's native side does with a proxied request. */
function phoneHost() {
    const BRIDGE = path.join(ROOT, 'mobile', 'node_modules', '@capacitor', 'android', 'capacitor', 'src', 'main', 'assets', 'native-bridge.js');
    const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/__blank.html') {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            /* After its bridge script, Android injects a few lines per plugin that give
             * the page Capacitor.Plugins.<name>.<method>, each a call to nativePromise
             * (JSExport.getPluginJS). The same lines, for the one plugin this page uses. */
            return res.end('<!doctype html><meta charset="utf-8"><title>blank, with Capacitor\'s bridge</title>'
                + '<script src="/__native-bridge.js"></script>'
                + '<script>(function(w){var a=(w.Capacitor=w.Capacitor||{});var p=(a.Plugins=a.Plugins||{});var t=(p["CapacitorHttp"]={});'
                + '["request","get","post","put","patch","delete"].forEach(function(m){t[m]=function(o){return w.Capacitor.nativePromise("CapacitorHttp",m,o);};});})(window);</script>'
                + '<body>blank</body>');
        }
        if (u.pathname === '/__native-bridge.js') {
            if (!fs.existsSync(BRIDGE)) { res.writeHead(404); return res.end('// run npm install in mobile/ first'); }
            res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
            return res.end(fs.readFileSync(BRIDGE));
        }
        if (u.pathname === '/_capacitor_http_interceptor_') {
            /* What WebViewLocalServer.handleCapacitorHttpRequest does, as its source
             * reads (Capacitor 8.6.2, lines 291 to 306): take the real address out of
             * `u`, copy the headers the WebView put on this request, and if the page
             * sent `x-cap-user-agent`, use it as the User-Agent. Nothing else. */
            const target = u.searchParams.get('u');
            const headers = {};
            for (const [k, v] of Object.entries(req.headers)) {
                if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
                headers[k] = v;
            }
            if (headers['x-cap-user-agent']) { headers['user-agent'] = headers['x-cap-user-agent']; delete headers['x-cap-user-agent']; }
            try {
                const r = await fetch(target, { method: req.method, headers, signal: AbortSignal.timeout(15000) });
                const body = Buffer.from(await r.arrayBuffer());
                res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
                return res.end(body);
            } catch (e) { res.writeHead(502); return res.end(String(e && e.message || e)); }
        }
        const p = decodeURIComponent(u.pathname);
        const file = path.join(WWW, p === '/' ? 'index.html' : p);
        if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file));
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

(async () => {
    if (!env.findBrowser()) {
        console.log('\n  SKIP: no Chromium-family browser found. Name one with ANIMATE_BROWSER=/path/to/it\n');
        process.exit(2);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-phone-'));
    const { children, closers, stop } = env.reaper(tmp, 6 * 60 * 1000);
    try {
        const media = path.join(tmp, 'media');
        fs.mkdirSync(media, { recursive: true });
        if (!env.makeStream(media)) {
            console.log('\n  SKIP: ffmpeg is needed to make the test stream, and was not found.\n');
            return stop(2);
        }
        const www = await phoneHost();
        const www2 = await serve(WWW);
        const video = await videoHost(media);
        closers.push(() => www.close(), () => www2.close(), () => video.close());

        /* The Worker, for sync. The same two steps scripts/test-sync.js takes. */
        let EDGE = '';
        const wrangler = env.which(['wrangler']);
        if (wrangler) {
            const WORKER = path.join(ROOT, 'worker');
            const state = path.join(tmp, 'wrangler');
            fs.mkdirSync(state, { recursive: true });
            const made = spawnSync(wrangler, ['d1', 'execute', 'ani-mate-accounts', '--local', '--persist-to', state, '--file', 'schema.sql'],
                                   { cwd: WORKER, encoding: 'utf8' });
            if (made.status !== 0) throw new Error('could not create the local database: ' + (made.stderr || made.stdout || '').slice(-300));
            const wport = await env.freePort();
            const worker = spawn(wrangler, ['dev', '--ip', '127.0.0.1', '--port', String(wport), '--inspector-port', String(await env.freePort()),
                                            '--persist-to', state, '--log-level', 'warn', '--show-interactive-dev-session=false'],
                                 { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
                                   env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', CI: '1' }) });
            children.push({ pid: worker.pid, kill: (sig) => { try { process.kill(-worker.pid, sig || 'SIGTERM'); } catch (e) { /* gone */ } } });
            EDGE = 'http://127.0.0.1:' + wport;
            await env.waitFor('the local Worker', async () => {
                const r = await fetch(EDGE + '/health', { signal: AbortSignal.timeout(2000) });
                const j = await r.json();
                return r.ok && j && j.api >= 2;
            }, 90000);
        }
        const br = await env.browser(path.join(tmp, 'profile'));
        children.push(br.child);
        const PHONE = 'http://127.0.0.1:' + www.address().port;
        const PHONE2 = 'http://127.0.0.1:' + www2.address().port;
        const STREAM = 'http://127.0.0.1:' + video.address().port + '/master.m3u8';
        console.log('\n  the phone page  ' + PHONE + '   (mobile/www, as is)');
        console.log('  a second phone  ' + PHONE2);
        console.log('  the stream      ' + STREAM);
        console.log('  the Worker      ' + (EDGE ? EDGE + '   (local database)' : 'not started: wrangler is not installed, the sync part is skipped'));
        console.log('  browser         ' + br.binary + '   (new empty profile, phone-sized)');
        const suite = spawn(process.execPath, [path.join(ROOT, 'tests', 'dom-phone.test.js')], {
            env: Object.assign({}, process.env, { ANIMATE_CDP: br.cdp, ANIMATE_PHONE: PHONE, ANIMATE_PHONE2: PHONE2,
                                                  ANIMATE_STREAM: STREAM, ANIMATE_EDGE: EDGE,
                                                  ANIMATE_VIDEO_HOST: 'http://127.0.0.1:' + video.address().port,
                                                  ANIMATE_STREAM_REFERER: STREAM_REFERER }),
            stdio: 'inherit',
        });
        children.push(suite);
        suite.on('exit', (code) => stop(code === null ? 1 : code));
    } catch (e) {
        console.log('\n  COULD NOT START: ' + (e && e.message || e) + '\n');
        stop(1);
    }
})();
