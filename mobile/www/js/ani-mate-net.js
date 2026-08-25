// YASA PRESENTS
// ani-mate-net.js — redundant transport layer for ANI-MATE
//
// WHY THIS EXISTS (2026-08-25)
//   Measured this day, every source the app can use is gated:
//     anidb.app          403  Cloudflare "Just a moment..."
//     api.allanime.day   403  Cloudflare "Just a moment..."
//     animepahe.su       200  DDoS-Guard interstitial, not the API payload
//     animeheaven.me     200  real page, but the results are rendered by JS
//   Plain HTTP cannot clear any of them. Headers make no difference — the same request
//   with a Firefox agent, an Android Chrome agent and full Accept/Referer headers all
//   return the identical 5.8 KB interstitial. What passes is a real browser: TLS
//   fingerprint, cookie jar, and a JS engine to run the challenge.
//
//   Desktop already had one (Electron's net module on session.defaultSession).
//   Android now has one too (WebFetch.java — an off-screen WebView).
//
// WHAT THIS MODULE DOES
//   Presents one call, netGet(url, opts), and picks a transport underneath it.
//   Cheap transports are tried first and PROMOTED OUT of the way per-host the moment a
//   host is seen to challenge, so a challenged host pays the WebView cost once and every
//   later request goes straight there. The knowledge persists across launches.

(function () {
    'use strict';

    const WebFetchPlugin = window.Capacitor?.Plugins?.WebFetch || null;
    const CapHttp        = window.Capacitor?.Plugins?.CapacitorHttp || null;
    const ElectronNet    = window.electronNet || null;   // desktop bridge, if present

    const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

    // Markers that mean "a bot wall answered, not the origin".
    const WALL_RE = /Just a moment|Checking your browser|Verifying you are human|Attention Required|DDoS-Guard|__ddg\d?_|cf-mitigated|Enable JavaScript and cookies/i;

    // ── per-host memory ────────────────────────────────────────────────────
    // 'browser' -> only the browser transport works here. 'cheap' -> plain HTTP is fine.
    const HOST_MODE_KEY = 'ani-mate-host-mode';
    let hostMode = {};
    try { hostMode = JSON.parse(localStorage.getItem(HOST_MODE_KEY) || '{}'); } catch { hostMode = {}; }

    function hostOf(url) {
        try { return new URL(url).host; } catch { return url; }
    }
    function markHost(url, mode) {
        const h = hostOf(url);
        if (hostMode[h] === mode) return;
        hostMode[h] = mode;
        try { localStorage.setItem(HOST_MODE_KEY, JSON.stringify(hostMode)); } catch { /* full or private */ }
    }

    // Hosts we already know challenge, so the very first request skips the wasted attempt.
    const KNOWN_BROWSER_ONLY = ['anidb.app', 'api.allanime.day', 'allanime.day',
                                'animepahe.su', 'animepahe.ru', 'animeheaven.me'];
    for (const h of KNOWN_BROWSER_ONLY) if (!hostMode[h]) hostMode[h] = 'browser';

    function looksLikeWall(body) {
        return !body || body.length < 60 || WALL_RE.test(body.slice(0, 4000));
    }

    // ── transports ─────────────────────────────────────────────────────────
    // Each returns { ok, status, body } or throws.

    async function viaWebFetch(url, opts) {
        if (!WebFetchPlugin) throw new Error('no WebFetch');
        const r = await WebFetchPlugin.fetch({
            url,
            html: !!opts.html,
            referer: opts.referer || '',
            timeoutMs: opts.timeout || 20000
        });
        return { ok: !!(r && r.status === 200 && r.body), status: r?.status || 0, body: r?.body || '' };
    }

    async function viaElectron(url, opts) {
        if (!ElectronNet || typeof ElectronNet.get !== 'function') throw new Error('no electronNet');
        const r = await ElectronNet.get(url, {
            referer: opts.referer || '',
            timeout: opts.timeout || 15000
        });
        return { ok: !!(r && r.ok), status: r?.status || 0, body: r?.body || '' };
    }

    async function viaCapHttp(url, opts) {
        if (!CapHttp) throw new Error('no CapacitorHttp');
        const r = await CapHttp.get({
            url,
            headers: baseHeaders(opts),
            responseType: 'text',
            connectTimeout: opts.timeout || 9000,
            readTimeout: opts.timeout || 9000
        });
        const body = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data ?? '');
        return { ok: r.status >= 200 && r.status < 300, status: r.status || 0, body };
    }

    async function viaFetch(url, opts) {
        const r = await fetch(url, {
            headers: baseHeaders(opts),
            signal: AbortSignal.timeout(opts.timeout || 9000)
        });
        return { ok: r.ok, status: r.status, body: await r.text() };
    }

    function baseHeaders(opts) {
        const h = {
            'User-Agent': UA_MOBILE,
            'Accept': opts.html ? 'text/html,application/xhtml+xml,*/*;q=0.8'
                                : 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9'
        };
        if (opts.referer) h['Referer'] = opts.referer;
        return h;
    }

    const CHEAP   = [['capHttp', viaCapHttp], ['fetch', viaFetch]];
    const BROWSER = [['webFetch', viaWebFetch], ['electron', viaElectron]];

    /**
     * netGet — fetch a URL through whichever transport can actually reach it.
     * @returns {Promise<{ok:boolean,status:number,body:string,via:string}>} never throws
     */
    async function netGet(url, opts = {}) {
        const mode = hostMode[hostOf(url)];
        const order = mode === 'browser' ? [...BROWSER, ...CHEAP]
                    : mode === 'cheap'   ? [...CHEAP, ...BROWSER]
                                         : [...CHEAP, ...BROWSER];
        let last = { ok: false, status: 0, body: '', via: 'none' };

        for (const [name, fn] of order) {
            let r;
            try { r = await fn(url, opts); }
            catch { continue; }                       // transport unavailable here
            if (r.ok && !looksLikeWall(r.body)) {
                if (name === 'capHttp' || name === 'fetch') markHost(url, 'cheap');
                return { ...r, via: name };
            }
            // A wall, or a hard failure. If a cheap transport saw a wall, remember it:
            // every later request for this host goes to the browser transport first.
            if ((name === 'capHttp' || name === 'fetch') &&
                (r.status === 403 || r.status === 503 || looksLikeWall(r.body))) {
                markHost(url, 'browser');
            }
            last = { ...r, via: name };
        }
        return last;
    }

    /** netJson — netGet plus a parse, null when either step fails. */
    async function netJson(url, opts = {}) {
        const r = await netGet(url, { ...opts, html: false });
        if (!r.ok) return null;
        try { return JSON.parse(r.body); } catch { return null; }
    }

    /** netHtml — netGet asking for rendered markup rather than text. */
    async function netHtml(url, opts = {}) {
        const r = await netGet(url, { ...opts, html: true });
        return r.ok ? r.body : '';
    }

    /** Forget what we learned about hosts, and drop challenge cookies with it. */
    async function resetTransportMemory() {
        hostMode = {};
        try { localStorage.removeItem(HOST_MODE_KEY); } catch { /* ignore */ }
        for (const h of KNOWN_BROWSER_ONLY) hostMode[h] = 'browser';
        try { await WebFetchPlugin?.clearCookies(); } catch { /* ignore */ }
    }

    window.NET = {
        get: netGet,
        json: netJson,
        html: netHtml,
        reset: resetTransportMemory,
        hostMode: () => ({ ...hostMode }),
        transports: {
            webFetch: !!WebFetchPlugin,
            electron: !!ElectronNet,
            capHttp: !!CapHttp,
            fetch: typeof fetch === 'function'
        }
    };
})();
