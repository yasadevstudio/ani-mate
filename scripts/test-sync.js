#!/usr/bin/env node
// YASA PRESENTS
/* test-sync.js: sync, end to end. Real pages, the real engine, the real Worker.
 *
 *     npm run test:sync
 *
 * WHAT IT STARTS, all of it on this machine and all of it thrown away afterwards:
 *
 *     the Worker    worker/src, run by `wrangler dev` with a LOCAL database in a temp
 *                   folder. Nothing is deployed and the production database is not
 *                   contacted.
 *     an old one    a stub that answers /health the way a Worker without the account
 *                   routes does, for the "sync is not available yet" case
 *     three apps    server/ani-mate-server.js three times, each on its own data folder:
 *                   A and B are two devices of one person, C points at the old backend
 *     a browser     headless, empty profile
 *
 * then runs tests/dom-sync.test.js against them.
 *
 * It needs no network. Two devices know a show under different ids, and what lets sync
 * line them up is the show's AniList id, which each page looks up from AniList itself;
 * the suite answers those lookups in AniList's place (and refuses them, for the part of
 * the test that is about AniList being unreachable).
 *
 * ⛔ B STANDS IN FOR THE PHONE. It is a second desktop instance whose ids are written the
 * way the phone writes them. The phone's own storage adapter is not exercised here.
 *
 * Exit code: the suite's (0 pass, 1 fail), or 2 when wrangler or a browser is missing.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const env = require('./test-env');

const ROOT = env.ROOT;
const WORKER = path.join(ROOT, 'worker');
const HOUR = 3600 * 1000;

function seedA(dir) {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'ani-mate-favorites.json'), JSON.stringify([
        { id: 'AAbebop', name: 'Cowboy Bebop', episodes: 26, added: new Date(now - 30 * HOUR).toISOString() },
        { id: 'AAtrigun', name: 'Trigun', episodes: 26, added: new Date(now - 29 * HOUR).toISOString() },
    ], null, 1));
    fs.writeFileSync(path.join(dir, 'ani-mate-history.json'), JSON.stringify([
        { anime_id: 'AAbebop', title: 'Cowboy Bebop', episode: '3', quality: 'best', mode: 'sub',
          timestamp: new Date(now - 1 * HOUR).toISOString(), episodes_watched: ['1', '2'],
          total_episodes: 26, playback_time: 600, playback_episode: '3' },
    ], null, 1));
}
/* The same person's other device. The same show, under the id the phone would give it. */
function seedB(dir) {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'ani-mate-favorites.json'), JSON.stringify([
        { id: 'cowboy-bebop-1281', name: 'Cowboy Bebop', episodes: 26, added: new Date(now - 20 * HOUR).toISOString() },
        { id: 'monster-19', name: 'Monster', episodes: 74, added: new Date(now - 19 * HOUR).toISOString() },
    ], null, 1));
    fs.writeFileSync(path.join(dir, 'ani-mate-history.json'), JSON.stringify([
        { anime_id: 'cowboy-bebop-1281', title: 'Cowboy Bebop', episode: '5', quality: 'best', mode: 'sub',
          timestamp: new Date(now - 5 * HOUR).toISOString(), episodes_watched: ['4', '5'],
          total_episodes: 26, playback_time: 0, playback_episode: null },
    ], null, 1));
}
function seedC(dir) {
    fs.writeFileSync(path.join(dir, 'ani-mate-favorites.json'), '[]');
    fs.writeFileSync(path.join(dir, 'ani-mate-history.json'), '[]');
}

(async () => {
    const wrangler = env.which(['wrangler']);
    if (!wrangler) {
        console.log('\n  SKIP: wrangler is not installed, and this suite runs the Worker with it.\n');
        process.exit(2);
    }
    if (!env.findBrowser()) {
        console.log('\n  SKIP: no Chromium-family browser found. Name one with ANIMATE_BROWSER=/path/to/it\n');
        process.exit(2);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-sync-'));
    const state = path.join(tmp, 'wrangler');
    fs.mkdirSync(state, { recursive: true });
    const { children, closers, stop } = env.reaper(tmp, 8 * 60 * 1000);

    try {
        /* The schema, into a database that exists only in the temp folder. */
        const made = spawnSync(wrangler, ['d1', 'execute', 'ani-mate-accounts', '--local',
                                          '--persist-to', state, '--file', 'schema.sql'],
                               { cwd: WORKER, encoding: 'utf8' });
        if (made.status !== 0) throw new Error('could not create the local database: ' + (made.stderr || made.stdout || '').slice(-300));

        const wport = await env.freePort();
        const iport = await env.freePort();
        const worker = spawn(wrangler, ['dev', '--ip', '127.0.0.1', '--port', String(wport),
                                        '--inspector-port', String(iport), '--persist-to', state,
                                        '--log-level', 'warn', '--show-interactive-dev-session=false'],
                             { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'],
                               env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', CI: '1' }) });
        children.push(worker);
        let wlog = '';
        worker.stdout.on('data', (d) => { wlog += d; });
        worker.stderr.on('data', (d) => { wlog += d; });
        const EDGE = 'http://127.0.0.1:' + wport;
        try {
            await env.waitFor('the local Worker', async () => {
                const r = await fetch(EDGE + '/health', { signal: AbortSignal.timeout(2000) });
                const j = await r.json();
                return r.ok && j && j.api >= 2;
            }, 90000);
        } catch (e) {
            throw new Error(e.message + '\n' + wlog.slice(-600));
        }

        /* A Worker from before accounts existed: /health with no `api` field. */
        const oldPort = await env.freePort();
        const old = http.createServer((req, res) => {
            const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
                           'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
            if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
            /* By path, the way a real Worker routes: the engine now adds `?v=2` to every
             * address, and an exact match on the whole address answered 404 to that. */
            if (new URL(req.url, 'http://x').pathname === '/health') {
                res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
                res.end(JSON.stringify({ service: 'ani-mate edge api', ok: true }));
                return;
            }
            res.writeHead(404, Object.assign({ 'Content-Type': 'application/json' }, cors));
            res.end(JSON.stringify({ error: 'not found', path: req.url }));
        });
        await new Promise((r) => old.listen(oldPort, '127.0.0.1', r));
        closers.push(() => old.close());

        const dirs = { a: path.join(tmp, 'data-a'), b: path.join(tmp, 'data-b'), c: path.join(tmp, 'data-c') };
        for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
        seedA(dirs.a); seedB(dirs.b); seedC(dirs.c);
        const A = await env.appServer(dirs.a, { ANI_MATE_EDGE: EDGE });
        const B = await env.appServer(dirs.b, { ANI_MATE_EDGE: EDGE });
        const C = await env.appServer(dirs.c, { ANI_MATE_EDGE: 'http://127.0.0.1:' + oldPort });
        children.push(A.child, B.child, C.child);

        const br = await env.browser(path.join(tmp, 'profile'));
        children.push(br.child);

        console.log('\n  Worker (local database)  ' + EDGE);
        console.log('  device A ' + A.url + '   device B ' + B.url + '   old backend ' + C.url);
        console.log('  browser  ' + br.binary + '   (new empty profile)');

        const suite = spawn(process.execPath, [path.join(ROOT, 'tests', 'dom-sync.test.js')], {
            env: Object.assign({}, process.env, {
                ANIMATE_CDP: br.cdp, ANIMATE_A: A.url, ANIMATE_B: B.url, ANIMATE_C: C.url, ANIMATE_EDGE: EDGE,
            }),
            stdio: 'inherit',
        });
        children.push(suite);
        suite.on('exit', (code) => stop(code === null ? 1 : code));
    } catch (e) {
        console.log('\n  COULD NOT START: ' + (e && e.message || e) + '\n');
        stop(1);
    }
})();
