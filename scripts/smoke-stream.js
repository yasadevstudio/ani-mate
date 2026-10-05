#!/usr/bin/env node
'use strict';
/**
 * smoke-stream.js — does ANI-MATE actually play anything? One question, answered honestly.
 *
 * WHY THIS EXISTS (2026-10-05)
 *   On 2026-10-05 every stream source was down at once, for four unrelated reasons, and
 *   /health/sources reported `"ok": true`. Nobody knew until somebody tried to watch
 *   something. The sources break on other people's schedules — a rotated domain, a new
 *   crypto scheme, a maintenance window — so the only real question is whether we hear it
 *   from a test or from a black screen.
 *
 * WHAT IT ASSERTS, IN ORDER. A later step failing is a different problem from an earlier one.
 *   1. the server answers
 *   2. search returns a known show
 *   3. that show lists episodes
 *   4. /play returns a stream URL                 <-- the one that actually matters
 *   5. that URL serves a playlist or a video body <-- proves the URL is not a 404 page
 *
 * EXIT CODES, so CI can act on them
 *   0  a stream was produced and fetched
 *   1  the chain broke; stdout says exactly where
 *   2  the server could not be reached at all
 *
 * USAGE
 *   node scripts/smoke-stream.js                     against http://localhost:7890
 *   node scripts/smoke-stream.js --port 7891
 *   node scripts/smoke-stream.js --json              machine-readable, for CI
 */
const PORT = (() => {
    const i = process.argv.indexOf('--port');
    return i > -1 ? process.argv[i + 1] : (process.env.ANI_MATE_PORT || '7890');
})();
const BASE = `http://localhost:${PORT}`;
const JSON_OUT = process.argv.includes('--json');

// Cowboy Bebop: finished in 1999, 26 episodes, will never be unpublished. A failure here is
// always the SOURCE and never a missing episode.
// The title matters: HiAnime.at resolves by NAME, not by AllAnime's id, so a /play call
// without one can only use sources keyed on that id. The real client always sends it.
const SHOW = { q: 'cowboy bebop', expectId: 'PGcK4wGnqDoeihT6n', minEpisodes: 20,
               title: 'Cowboy Bebop' };

const steps = [];
function step(name, ok, detail) {
    steps.push({ name, ok, detail });
    if (!JSON_OUT) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    return ok;
}

async function get(path, ms = 30000) {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
}
async function post(path, payload, ms = 60000) {
    const r = await fetch(BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(ms),
    });
    return { status: r.status, body: await r.text() };
}

(async () => {
    if (!JSON_OUT) console.log(`ANI-MATE stream smoke test -> ${BASE}\n`);

    // 1. server
    try {
        const r = await get('/status', 8000);
        if (!step('server answers', r.status === 200, `HTTP ${r.status}`)) process.exit(2);
    } catch (e) {
        step('server answers', false, String(e.message || e));
        if (!JSON_OUT) console.log('\n  server unreachable — start it first');
        process.exit(2);
    }

    // 2. search
    let showId = null;
    try {
        const r = await get(`/search?q=${encodeURIComponent(SHOW.q)}`);
        const d = JSON.parse(r.body || '{}');
        const hits = d.results || [];
        showId = (hits.find((x) => x.id === SHOW.expectId) || hits[0] || {}).id || null;
        step('search returns results', hits.length > 0, `${hits.length} hits`);
    } catch (e) { step('search returns results', false, String(e.message || e)); }

    // 3. episodes
    if (showId) {
        try {
            const r = await get(`/episodes?id=${encodeURIComponent(showId)}`);
            const eps = (JSON.parse(r.body || '{}').episodes) || [];
            step('episode list', eps.length >= SHOW.minEpisodes, `${eps.length} episodes`);
        } catch (e) { step('episode list', false, String(e.message || e)); }
    } else {
        step('episode list', false, 'no show id from search');
    }

    // 4. THE ONE THAT MATTERS
    let streamUrl = null, playData = null;
    if (showId) {
        try {
            const r = await post('/play', {
                anime_id: showId, episode: '1', mode: 'sub',
                title: SHOW.title, title_english: SHOW.title,
            });
            const d = JSON.parse(r.body || '{}');
            // /play answers with `stream_url`. Reading `url` returned HTTP 200 and then
            // reported a failure, which is the worst kind of test result: it looks like the
            // app is broken when the test is.
            streamUrl = d.stream_url || d.url || d.stream || d.link ||
                (Array.isArray(d.sources) && d.sources[0] && d.sources[0].url) || null;
            const subs = (d.subtitles || []).length;
            step('/play returns a stream url', !!streamUrl,
                 streamUrl ? `${d.source || '?'} — ${streamUrl.slice(0, 48)}` : `HTTP ${r.status} ${(d.error || '').slice(0, 70)}`);
            if (streamUrl) step('subtitle track offered', subs > 0, `${subs} track(s)`);
        } catch (e) { step('/play returns a stream url', false, String(e.message || e)); }
    } else {
        step('/play returns a stream url', false, 'no show id');
    }

    // 5. the url is real
    if (streamUrl) {
        try {
            // The CDN rejects a request with no Referer, so use the one /play handed back.
            // Referer AND a browser User-Agent. The CDN 403s on either one missing, and
            // node's default agent is not one. Measured both ways 2026-10-05.
            const hdrs = {
                Range: 'bytes=0-2047',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                            + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            };
            if (playData && playData.referer) hdrs.Referer = playData.referer;
            // Go through /proxy-stream, because that is what the player does. A direct
            // fetch from node gets 403 where curl gets 200 — undici's TLS fingerprint — so
            // testing directly would measure the test harness, not the app.
            const viaProxy = `${BASE}/proxy-stream?url=${encodeURIComponent(streamUrl)}`
                + (playData && playData.referer ? `&referer=${encodeURIComponent(playData.referer)}` : '');
            const r = await fetch(viaProxy, { headers: hdrs, signal: AbortSignal.timeout(25000) });
            const body = await r.text();
            const looksReal = r.ok && (body.includes('#EXTM3U') || body.length > 200);
            step('stream url serves content', looksReal, `HTTP ${r.status}, ${body.length}b`);
        } catch (e) { step('stream url serves content', false, String(e.message || e)); }
    } else {
        step('stream url serves content', false, 'no url to fetch');
    }

    const failed = steps.filter((s) => !s.ok);
    if (JSON_OUT) {
        console.log(JSON.stringify({ ok: failed.length === 0, steps }, null, 1));
    } else {
        console.log(failed.length === 0
            ? '\n  ALL PASS — the app can play.'
            : `\n  ${failed.length} FAILED. First break: ${failed[0].name} (${failed[0].detail || ''})`);
    }
    process.exit(failed.length === 0 ? 0 : 1);
})();
