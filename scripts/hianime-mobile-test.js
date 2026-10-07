// Run the MOBILE hianime provider against the live site, in Node, with a stubbed window.
//
// WHY: the port from server/hianime-at.js swapped Buffer for atob + Uint8Array + TextDecoder.
// That is exactly the kind of change that looks right and silently corrupts any byte over
// 0x7F. This runs the real chain — search, episodes, stream, XOR decode — so a porting bug
// shows up here instead of on a phone.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = '/home/yasa/ANIMATE/ani-mate-release/mobile/www/js/ani-mate-sources.js';

// --- minimal browser surface -------------------------------------------------
const store = {};
global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
};
global.window = { Capacitor: null, localStorage: global.localStorage };

// NET.get, referer-capable, the one thing the provider depends on.
global.NET = global.window.NET = {
    transports: { node: true },
    async get(url, opts = {}) {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
                        + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
            'Accept': opts.html ? 'text/html,application/xhtml+xml,*/*;q=0.8'
                                : 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
        };
        if (opts.referer) headers['Referer'] = opts.referer;
        try {
            const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
            const body = await r.text();
            return { ok: r.ok, status: r.status, body, via: 'node' };
        } catch (e) {
            return { ok: false, status: 0, body: '', via: 'node', error: String(e) };
        }
    },
    async json(url, opts) { const r = await this.get(url, opts); try { return JSON.parse(r.body); } catch { return null; } },
    async html(url, opts) { const r = await this.get(url, { ...opts, html: true }); return r.ok ? r.body : ''; },
    reset() {},
};

// --- load the module ---------------------------------------------------------
const code = fs.readFileSync(SRC, 'utf8');
// The IIFE closes over `NET` and `window`; both are globals here.
eval(code);
const SOURCES = global.window.SOURCES;

(async () => {
    const list = SOURCES.list();
    const ha = list.find(p => p.id === 'hianime');
    console.log('providers:', list.map(p => `${p.id}${p.enabled ? '' : '(off)'}`).join(' '));
    console.log('hianime enabled:', ha && ha.enabled);
    console.log('');

    let fails = 0;
    const step = (name, ok, detail) => {
        if (!ok) fails++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    };

    // reach into the provider directly so the chain under test is hianime, not whatever wins
    const prov = (function () {
        // SOURCES.search walks providers; call the module's own tagged form instead
        return null;
    })();

    // search
    let hits = [];
    try {
        hits = await SOURCES.search('cowboy bebop', 'sub');
        const h = (hits || []).filter(x => String(x.id || '').startsWith('hianime:'));
        step('search returns hianime hits', h.length > 0, `${h.length} of ${(hits || []).length}`);
        hits = h;
    } catch (e) { step('search returns hianime hits', false, String(e.message || e)); }

    if (!hits.length) { console.log(`\n${fails} FAILED`); process.exit(fails ? 1 : 0); }

    // episodes
    let eps = [];
    try {
        eps = await SOURCES.episodes(hits[0].id, 'sub');
        step('episode list', (eps || []).length > 0, `${(eps || []).length} episodes`);
    } catch (e) { step('episode list', false, String(e.message || e)); }

    if (!eps.length) { console.log(`\n${fails} FAILED`); process.exit(1); }

    // stream + the XOR decode, which is the part the port could have broken
    try {
        const s = await SOURCES.stream(eps[0].id, 'sub');
        step('stream resolves', !!(s && s.url), s ? String(s.url).slice(0, 52) : 'null');
        if (s) {
            step('referer returned', !!s.referer, s.referer || '');
            step('subtitles returned', Array.isArray(s.subtitles) && s.subtitles.length > 0,
                 `${(s.subtitles || []).length} track(s)`);
            // the decode produced real JSON with a usable src, so atob+XOR+TextDecoder is right
            step('decoded src looks like a playlist', /\.m3u8|master|\/p\//.test(s.url || ''));
            if (s.subtitles && s.subtitles[0]) {
                const v = await global.NET.get(s.subtitles[0].src, { referer: s.referer });
                step('subtitle fetches with referer', v.ok && /^\s*WEBVTT/.test(v.body),
                     `HTTP ${v.status}, ${v.body.length} bytes`);
                const bare = await global.NET.get(s.subtitles[0].src);
                step('subtitle 403s WITHOUT referer (proves the gate is real)', bare.status === 403,
                     `HTTP ${bare.status}`);
            }
            const m = await global.NET.get(s.url, { referer: s.referer });
            step('playlist fetches with referer', m.ok, `HTTP ${m.status}, ${m.body.length} bytes`);
        }
    } catch (e) { step('stream resolves', false, String(e.message || e)); }

    console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
    process.exit(fails ? 1 : 0);
})();
