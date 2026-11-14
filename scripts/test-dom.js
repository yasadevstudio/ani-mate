#!/usr/bin/env node
// YASA PRESENTS
/* test-dom.js: start what the browser suites need, run them, take it all down.
 *
 *     npm run test:dom                 both suites
 *     node scripts/test-dom.js player  just the player
 *     node scripts/test-dom.js ui      just the pages
 *     ANIMATE_BROWSER=/usr/bin/chromium npm run test:dom
 *
 * The suites drive the real page in a real browser:
 *
 *     tests/dom-player.test.js   plays a video. Needs NO network: the stream is made here
 *                                with ffmpeg and served by a stub host on this machine.
 *     tests/dom-ui.test.js       the browse tabs, the season bar, favorites. Opening a
 *                                show asks the REAL sources for its seasons, so this one
 *                                uses the network, the same way the app does.
 *
 * They need a server and a browser with a debugging port, and the first of them used to
 * leave both to whoever ran it, with three commands in its header. Two were traps:
 *
 *   - the browser line had no --user-data-dir. On a machine where that browser is
 *     already open, the command hands the address to the RUNNING browser and exits: no
 *     debugging port, and a tab opened in the user's own session.
 *   - the server line copied the user's real library into /tmp as the test data.
 *
 * So everything here is disposable, and made here:
 *
 *   data      a new temp folder per suite, seeded by this file
 *   server    this repo's server/ani-mate-server.js, on a free port, on that folder
 *   browser   headless, on a free debugging port, with a new empty profile
 *   stream    24 seconds of test pattern in two qualities, cut into HLS by ffmpeg
 *
 * Nothing of the user's is read or written, and the app they are running is not touched.
 * The temp folder is removed at the end, whatever happened.
 *
 * Exit code: 0 every suite passed, 1 one failed, 2 nothing could run (no browser).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const env = require('./test-env');

const ROOT = env.ROOT;
const OVERALL_LIMIT_MS = 9 * 60 * 1000;
const which = env.which;

const makeStream = env.makeStream;          // 24 seconds of test pattern, two qualities, as HLS

/* Sixty cues, one every 0.4 seconds: a subtitle file the player treats as dialogue. */
function makeSubtitles() {
    const stamp = (s) => '00:00:' + String(Math.floor(s)).padStart(2, '0') + '.' + String(Math.round((s % 1) * 1000)).padStart(3, '0');
    let out = 'WEBVTT\n\n';
    for (let i = 0; i < 60; i++) out += stamp(i * 0.4) + ' --> ' + stamp(i * 0.4 + 0.35) + '\nline ' + (i + 1) + '\n\n';
    return out;
}

/* ── the stub video host ────────────────────────────────────────────────────────────
 * Serves the stream from /hls/, keeps a list of what it was asked and with which
 * Referer, and sends NO cross-origin headers, exactly like the hosts the app plays
 * from. So a request made straight from the page fails, and the app has to do what it
 * does in real life: go through its own proxy. */
function startStub(mediaDir, port) {
    const seen = [];
    const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' };
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/__seen') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(seen));
            return;
        }
        if (u.pathname === '/__reset') { seen.length = 0; res.writeHead(204); res.end(); return; }
        seen.push({ url: u.pathname, referer: req.headers.referer || null, origin: req.headers.origin || null });
        const name = path.basename(u.pathname);
        const file = path.join(mediaDir, name);
        if (!u.pathname.startsWith('/hls/') || !fs.existsSync(file)) { res.writeHead(404); res.end('no'); return; }
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream',
                             'Content-Length': body.length });
        res.end(body);
    });
    return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

/* ── the seeds ──────────────────────────────────────────────────────────────────────
 * Rows that are markup. If any of these is ever written into the page as HTML, the page
 * will try to load the image "animate-dom-probe" and the suite will see it. */
const HOSTILE_NAME = 'Probe <img src="animate-dom-probe" onerror="window.__probeRan=1"> Show';
const HOSTILE_ID = 'probe"><img src="animate-dom-probe" onerror="window.__probeRan=2">';

/* The page suites are seeded from a private library file that is kept out of the
 * repository (.gitignore names it); without it there is nothing to seed the page with,
 * and this runner says so before it starts anything. */
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'favorites-24.json');

function seedUi(dataDir) {
    const favs = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    favs.push({ id: HOSTILE_ID, name: HOSTILE_NAME, title_english: HOSTILE_NAME + ' (EN)',
                episodes: 3, added: new Date().toISOString(),
                franchise_id: 'x"><img src="animate-dom-probe" onerror="window.__probeRan=3">' });
    fs.writeFileSync(path.join(dataDir, 'ani-mate-favorites.json'), JSON.stringify(favs, null, 1));
    const now = new Date().toISOString();
    const history = [
        { anime_id: HOSTILE_ID, title: HOSTILE_NAME,
          episode: '1"><img src="animate-dom-probe" onerror="window.__probeRan=4">',
          mode: '<b>sub</b>', timestamp: now, episodes_watched: ['1'], total_episodes: 3,
          playback_time: 0, playback_episode: '1' },
        { anime_id: favs[0].id, title: favs[0].name, episode: '2', mode: 'sub', timestamp: now,
          episodes_watched: ['1', '2'], total_episodes: favs[0].episodes || 12,
          playback_time: 300, playback_episode: '3' },
    ];
    fs.writeFileSync(path.join(dataDir, 'ani-mate-history.json'), JSON.stringify(history, null, 1));
}

const PLAYER_SHOW = 'domPlayer1';
function seedPlayer(dataDir) {
    fs.writeFileSync(path.join(dataDir, 'ani-mate-favorites.json'), JSON.stringify([
        { id: PLAYER_SHOW, name: 'Dom Player Show', title_english: 'Dom Player Show', episodes: 3,
          added: new Date().toISOString() },
    ], null, 1));
    fs.writeFileSync(path.join(dataDir, 'ani-mate-history.json'), '[]');
    /* A subtitle file the SERVER holds, the way an external subtitle is held: the page
     * is given /subtitle?t=domtest and has to ask this server for it, not the proxy. */
    fs.mkdirSync(path.join(dataDir, 'subcache'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'subcache', 'domtest.vtt'), makeSubtitles());
}

(async () => {
    const want = process.argv.slice(2).filter(a => a === 'player' || a === 'ui');
    if (!env.findBrowser()) {
        console.log('\n  SKIP: no Chromium-family browser found (looked for brave-browser, google-chrome, chromium).'
            + '\n  Name one with ANIMATE_BROWSER=/path/to/it\n');
        process.exit(2);
    }
    if (!fs.existsSync(FIXTURE)) {
        console.log('\n  SKIP: tests/fixtures/favorites-24.json is not here. It is a private file, kept out of'
            + '\n  the repository; the page suites are seeded from it and run where the file is.\n');
        process.exit(2);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-dom-'));
    const media = path.join(tmp, 'media');
    fs.mkdirSync(media, { recursive: true });
    const { children, closers, stop } = env.reaper(tmp, OVERALL_LIMIT_MS);

    /** One suite, on its own fresh server and data folder. Resolves with its exit code. */
    async function runSuite(name, file, seed, serverEnv, suiteEnv) {
        const dataDir = path.join(tmp, 'data-' + name);
        fs.mkdirSync(dataDir, { recursive: true });
        seed(dataDir);
        const server = await env.appServer(dataDir, serverEnv);
        children.push(server.child);
        console.log('\n── ' + name + ' ── server ' + server.url + '   data ' + dataDir);

        const code = await new Promise((resolve) => {
            const suite = spawn(process.execPath, [path.join(ROOT, 'tests', file)], {
                env: Object.assign({}, process.env, {
                    ANIMATE_UI_URL: server.url,
                    ANIMATE_DATA_DIR: dataDir,
                    ANIMATE_DOM_SEEDED: '1',
                }, suiteEnv || {}),
                stdio: 'inherit',
            });
            children.push(suite);
            suite.on('exit', (c) => resolve(c === null ? 1 : c));
        });
        try { server.child.kill('SIGTERM'); } catch (e) { /* already gone */ }
        return code;
    }

    try {
        const br = await env.browser(path.join(tmp, 'profile'));
        children.push(br.child);
        console.log('\n  browser ' + br.binary + '   (new empty profile, debugging at ' + br.cdp + ')');

        const codes = [];

        if (!want.length || want.includes('player')) {
            if (!makeStream(media)) {
                console.log('\n── player ── SKIPPED: ffmpeg is needed to make the test stream, and was not found.');
                codes.push(2);
            } else {
                const stubPort = await env.freePort();
                const stub = await startStub(media, stubPort);
                closers.push(() => stub.close());
                const STUB = 'http://127.0.0.1:' + stubPort;
                codes.push(await runSuite('player', 'dom-player.test.js', seedPlayer, {
                    /* The proxy will fetch from the stub, and the stream chain answers
                     * with the stub's stream: both are test-only switches (see the
                     * TEST HOOK notes in server/ani-mate-server.js). */
                    ANI_MATE_PROXY_TEST_HOSTS: '127.0.0.1:' + stubPort,
                    ANI_MATE_TEST_STREAM: JSON.stringify({
                        url: STUB + '/hls/master.m3u8',
                        referer: 'https://stream.example/',
                        subtitles: [{ src: '/subtitle?t=domtest', lang: 'en', label: 'English' }],
                        show_id: PLAYER_SHOW,
                        episodes: ['1', '2', '3'],
                    }),
                }, { ANIMATE_CDP: br.cdp, ANIMATE_STUB: STUB, ANIMATE_PLAYER_SHOW: PLAYER_SHOW }));
            }
        }

        if (!want.length || want.includes('ui')) {
            /* This one opens real shows, so its server is given the real sources. */
            codes.push(await runSuite('ui', 'dom-ui.test.js', seedUi, env.LIVE_SOURCES, { ANIMATE_CDP: br.cdp }));
        }

        const ran = codes.filter(c => c !== 2);
        stop(codes.some(c => c === 1) ? 1 : (ran.length ? 0 : 2));
    } catch (e) {
        console.log('\n  COULD NOT START: ' + (e && e.message || e) + '\n');
        stop(1);
    }
})();
