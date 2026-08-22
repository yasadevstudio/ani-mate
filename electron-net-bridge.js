'use strict';
/**
 * electron-net-bridge.js — perform source-API requests through Chromium, not bare Node HTTP.
 *
 * WHY THIS EXISTS (diagnosed 2026-08-20, root-caused 2026-08-22):
 *   ANI-MATE's data source sits behind a Cloudflare browser check. The app was getting
 *   HTTP 403 "Just a moment..." on every search/episode/stream call.
 *
 *   The cause is architectural, not a stale constant. `main.js` opens a BrowserWindow, but
 *   the API server runs as a `fork()`ed Node child with NO browser context: no cookie jar,
 *   no Chromium TLS/HTTP2 fingerprint, no ability to carry a clearance cookie. A full
 *   browser engine ships inside this app and the requests were routing around it.
 *
 *   The 2026-08-20 diagnosis assumed a domain/Referer fix. Those were already correct in
 *   this build (`allmanga.to`), and updating them changes nothing — a bare Node request is
 *   simply not a browser. Upstream `ani-cli` has since abandoned AllAnime for `anidb.app`,
 *   which is behind the same protection, so switching source does not help either.
 *
 * WHAT THIS DOES:
 *   The forked server hands the request to the Electron main process over the IPC channel
 *   that `fork(..., stdio: [...,'ipc'])` already provides. Main issues it with Electron's
 *   `net` module bound to `session.defaultSession` and `useSessionCookies`, so it travels
 *   the same Chromium network stack the visible window uses, sharing its cookie jar.
 *
 *   If a response still comes back as a challenge page, a hidden BrowserWindow loads the
 *   site origin once so Chromium can complete the check the normal way. The resulting
 *   cookie lands in the shared session and the request is retried. Solving is single-flight
 *   — five concurrent API calls do not open five windows.
 *
 * FAILURE BEHAVIOUR: never throws into the server. Every path resolves to
 * {status, body, error}; status 0 means the request did not complete. The server surfaces
 * that to the UI instead of returning an empty list, so the next upstream rotation is
 * immediately visible rather than looking like the app broke.
 */
const { net, session, BrowserWindow } = require('electron');

const CHALLENGE_RE = /Just a moment|__cf_chl|cf-browser-verification|Checking your browser|cf_chl_opt/i;
const REQ_TIMEOUT_MS = 20000;
const CHALLENGE_TIMEOUT_MS = 30000;
const CHALLENGE_SETTLE_MS = 4000;

let solving = null;          // single-flight challenge solve

// The site's own calls carry `Origin: https://allmanga.to`; ANI-MATE only ever sent
// `Referer`. Without Origin the edge answers 403 with a browser check; WITH it the same
// request reaches GraphQL (the site's own calls come back 400 on a persisted-query miss,
// which is an application response, not a block).
//
// `Origin` is a FORBIDDEN header -- Chromium owns it and `net.request().setHeader('Origin')`
// makes the request fail outright (observed: status 0). The supported way to set it is a
// session-level onBeforeSendHeaders rule, which is what this installs. It also aligns the
// User-Agent with the Chromium actually doing the sending; the hardcoded Firefox UA
// contradicted Chromium's own sec-ch-ua client hints on every request.
const SOURCE_ORIGIN = 'https://allmanga.to';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
                  'Chrome/130.0.6723.191 Safari/537.36';
let headerRulesInstalled = false;

function installHeaderRules(ses) {
    if (headerRulesInstalled) return;
    const target = ses || session.defaultSession;
    try {
        target.webRequest.onBeforeSendHeaders(
            { urls: ['*://api.allanime.day/*', '*://*.allanime.day/*'] },
            (details, callback) => {
                const h = details.requestHeaders || {};
                h['Origin'] = SOURCE_ORIGIN;
                h['Referer'] = SOURCE_ORIGIN + '/';
                h['User-Agent'] = CHROME_UA;
                h['Accept'] = h['Accept'] || '*/*';
                h['Accept-Language'] = h['Accept-Language'] || 'en-US';
                h['Sec-Fetch-Site'] = 'cross-site';
                h['Sec-Fetch-Mode'] = 'cors';
                h['Sec-Fetch-Dest'] = 'empty';
                callback({ requestHeaders: h });
            }
        );
        headerRulesInstalled = true;
    } catch (e) {
        headerRulesInstalled = false;
    }
}

function netRequest({ url, method, headers, body }) {
    return new Promise((resolve) => {
        let req;
        try {
            req = net.request({
                method: method || 'GET',
                url,
                session: session.defaultSession,
                useSessionCookies: true,
                redirect: 'follow'
            });
        } catch (e) {
            return resolve({ status: 0, body: '', error: String(e) });
        }
        for (const [k, v] of Object.entries(headers || {})) {
            try { req.setHeader(k, v); } catch { /* header rejected by Chromium; skip */ }
        }
        const chunks = [];
        let settled = false;
        const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
        const timer = setTimeout(() => {
            try { req.abort(); } catch { }
            finish({ status: 0, body: '', error: 'request timeout' });
        }, REQ_TIMEOUT_MS);

        req.on('response', (res) => {
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => finish({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8')
            }));
            res.on('error', (e) => finish({ status: 0, body: '', error: String(e) }));
        });
        req.on('error', (e) => finish({ status: 0, body: '', error: String(e) }));
        if (body) { try { req.write(body); } catch { } }
        try { req.end(); } catch (e) { finish({ status: 0, body: '', error: String(e) }); }
    });
}

function cookieFor(url, name) {
    return session.defaultSession.cookies.get({ url, name })
        .then((c) => (c && c.length ? c[0] : null))
        .catch(() => null);
}

/**
 * Load `origin` in a real window and wait for the check to complete.
 *
 * Waits on the SUCCESS CONDITION (a clearance cookie appearing for that origin), not on
 * load events. `did-fail-load` fires for an HTTP 403 even though the interstitial HTML did
 * load and its script is about to run — the first version bailed there and never gave the
 * check a chance. Poll instead, and give up on a wall-clock deadline.
 */
function solveChallenge(origin) {
    if (solving) return solving;                     // single-flight
    solving = new Promise((resolve) => {
        let win = null, done = false, poll = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(bail);
            if (poll) clearInterval(poll);
            try { if (win && !win.isDestroyed()) win.destroy(); } catch { }
            solving = null;
            resolve(ok);
        };
        const bail = setTimeout(() => finish(false), CHALLENGE_TIMEOUT_MS);
        try {
            win = new BrowserWindow({
                show: false, width: 1280, height: 800,
                webPreferences: { nodeIntegration: false, contextIsolation: true }
            });
        } catch (e) {
            return finish(false);
        }
        // Poll for the clearance cookie. did-fail-load is NOT treated as fatal: a 403
        // interstitial reports as a failed load while still executing its script.
        poll = setInterval(async () => {
            const c = await cookieFor(origin, 'cf_clearance');
            if (c) finish(true);
        }, 1000);
        try {
            const p = win.loadURL(origin);
            if (p && typeof p.catch === 'function') p.catch(() => { /* keep polling */ });
        } catch (e) {
            finish(false);
        }
    });
    return solving;
}

/** Wire the bridge to a forked server child process. */
function attach(child) {
    if (!child || typeof child.on !== 'function') return false;
    installHeaderRules();
    child.on('message', async (msg) => {
        if (!msg || msg.type !== 'net-request') return;
        let r;
        try {
            r = await netRequest(msg);
            if (r.status === 403 && CHALLENGE_RE.test(r.body || '')) {
                const ok = await solveChallenge(msg.challengeOrigin || 'https://allmanga.to');
                if (ok) r = await netRequest(msg);
            }
        } catch (e) {
            r = { status: 0, body: '', error: String(e) };
        }
        try {
            child.send({
                type: 'net-response', id: msg.id,
                status: r.status, body: r.body, error: r.error || null
            });
        } catch { /* child gone */ }
    });
    return true;
}

module.exports = { attach, netRequest, solveChallenge, installHeaderRules };
