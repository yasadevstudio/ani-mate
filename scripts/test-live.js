#!/usr/bin/env node
// YASA PRESENTS
/* test-live.js: the three suites that ask the REAL sources, on a server of their own.
 *
 *     npm run test:live
 *     ANIMATE_API=http://localhost:7890 npm run test:live     against an app already up
 *
 * These suites search AllAnime and AniList through the app's server, because what they
 * check is how real data groups into franchises and seasons:
 *
 *     tests/season-nav-e2e.test.js       every season reachable from every season
 *     tests/favorites-franchise.test.js  starring a show stars its whole franchise
 *     tests/franchise-regression.py      the reported grouping bugs, one case each
 *
 * The first two are written against a private library file and are kept on the machine
 * that has it (.gitignore names them). Where they are missing this says so and runs the
 * rest.
 *
 * ⛔ THEY USED TO BE POINTED AT PORT 7890, which is the app the user is running. All
 * three only read, but a test run then competes with the user for the sources' rate
 * limits, and its result depends on what that app happens to have cached. So this file
 * starts this repo's server on a free port with an empty data folder, hands its address
 * to the suites, and takes it down again. Nothing of the user's is read or written.
 * (tests/favorites-franchise.test.js still READS the user's real favorites file, twice,
 * to prove it did not change it.)
 *
 * They use the network. A source that is down or rate limiting fails them; that is a
 * failure of the run, not of the code.
 *
 * ⚠ ANILIST ALLOWS THIS ADDRESS 30 REQUESTS A MINUTE, and the app the user has open
 * spends from the same thirty. One run of these suites costs 13 (measured 2026-11-12;
 * it was over 40 before the details lookup was batched). So this file asks AniList how
 * many it has left before it starts, and waits for the minute to turn when there are
 * not enough: a run that starts short fails three grouping cases for a reason that has
 * nothing to do with grouping.
 *
 * Exit code: 0 all passed, 1 one failed.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const env = require('./test-env');

const ROOT = env.ROOT;
const SUITES = [
    ['node', ['tests/season-nav-e2e.test.js']],
    ['node', ['tests/favorites-franchise.test.js']],
    ['python3', ['tests/franchise-regression.py']],
];

function run(cmd, args, api) {
    return new Promise((resolve) => {
        const bin = cmd === 'node' ? process.execPath : cmd;
        const child = spawn(bin, args, {
            cwd: ROOT, stdio: 'inherit',
            env: Object.assign({}, process.env, { ANIMATE_API: api }),
        });
        child.on('error', (e) => { console.log('  could not run ' + cmd + ': ' + e.message); resolve(1); });
        child.on('exit', (code) => resolve(code === null ? 1 : code));
    });
}

/** How many requests AniList will still take this minute, or null when it did not say. */
async function anilistLeft() {
    try {
        const r = await fetch('https://graphql.anilist.co', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: '{ Media(id: 1) { id } }' }), signal: AbortSignal.timeout(8000),
        });
        const left = r.headers.get('x-ratelimit-remaining');
        if (r.status === 429) return 0;
        return left === null ? null : parseInt(left, 10);
    } catch (e) { return null; }
}
const NEEDED = 16;          // 13 for the suites, and a little for whatever else is running

(async () => {
    let left = await anilistLeft();
    if (left === null) console.log('\n  AniList did not say how many requests it has left; going ahead.');
    for (let tries = 0; left !== null && left < NEEDED && tries < 3; tries++) {
        console.log('\n  AniList has ' + left + ' of its 30 requests left this minute and a run needs ' + NEEDED
            + '. Waiting 61 seconds.');
        await new Promise((r) => setTimeout(r, 61000));
        left = await anilistLeft();
    }
    if (left !== null) console.log('\n  AniList has ' + left + ' requests left this minute.');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-live-'));
    const { children, stop } = env.reaper(tmp, 25 * 60 * 1000);
    try {
        let api = (process.env.ANIMATE_API || '').replace(/\/+$/, '');
        if (api) {
            console.log('\n  using the server at ' + api + ' (ANIMATE_API is set)');
        } else {
            const dataDir = path.join(tmp, 'data');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'ani-mate-favorites.json'), '[]');
            fs.writeFileSync(path.join(dataDir, 'ani-mate-history.json'), '[]');
            const server = await env.appServer(dataDir, env.LIVE_SOURCES);
            children.push(server.child);
            api = server.url.replace(/\/+$/, '');
            console.log('\n  a server of its own: ' + api + '   data ' + dataDir);
        }
        let failed = 0, ran = 0;
        for (const [cmd, args] of SUITES) {
            console.log('\n── ' + args[0] + ' ──');
            if (!fs.existsSync(path.join(ROOT, args[0]))) {
                console.log('  SKIPPED: this suite is kept on the machine it was written on and is not in the repository.');
                continue;
            }
            ran++;
            const code = await run(cmd, args, api);
            if (code !== 0) { failed++; console.log('  (exit ' + code + ')'); }
        }
        console.log('\n  ' + (ran - failed) + ' of ' + ran + ' live suites passed'
            + (ran < SUITES.length ? ' (' + (SUITES.length - ran) + ' not here)' : '') + '\n');
        stop(failed ? 1 : 0);
    } catch (e) {
        console.log('\n  COULD NOT START: ' + (e && e.message || e) + '\n');
        stop(1);
    }
})();
