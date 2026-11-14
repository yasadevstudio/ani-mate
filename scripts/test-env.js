// YASA PRESENTS
/* test-env.js: the disposable pieces the browser suites are run on, in one place.
 *
 * Used by scripts/test-dom.js and scripts/test-sync.js. Everything it starts lives in a
 * temp folder it is handed and dies with the launcher:
 *
 *     appServer()   this repo's server/ani-mate-server.js on a free port and its own data
 *     browser()     a headless Chromium-family browser with a new, empty profile
 *
 * ⛔ NOTHING HERE MAY TOUCH THE USER'S OWN APP OR BROWSER. The server gets an explicit
 * data folder (never the default one), a free port (never 7890), and the browser gets
 * --user-data-dir. Without that last flag, on a machine where the browser is already
 * open, the command hands the address to the RUNNING browser and exits: there is no
 * debugging port, and a tab has been opened in the user's own session.
 */
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function which(names) {
    for (const name of names) {
        /* `where` is Windows' `which` (scripts/smoke-windows.js makes its test stream
         * with the same ffmpeg call as everything else). */
        const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
        const found = (r.stdout || '').trim().split(/\r?\n/)[0];
        if (r.status === 0 && found) return found;
    }
    return null;
}

function findBrowser() {
    const named = process.env.ANIMATE_BROWSER;
    if (named) return fs.existsSync(named) ? named : null;
    return which(['brave-browser', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
}

async function waitFor(what, fn, ms) {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) {
        try { if (await fn()) return; } catch (e) { last = e; }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(what + ' did not come up in ' + Math.round(ms / 1000) + 's'
        + (last ? ' (' + (last.message || last) + ')' : ''));
}

/* ⛔ A TEST SERVER TALKS TO NO REAL SOURCE UNLESS THE SUITE SAYS SO. Five seconds after
 * it starts on an empty data folder, the server fills its content index from AniList:
 * twelve requests. Every disposable server did that against the real AniList, which
 * allows this address thirty a minute and is the same allowance the user's own running
 * app lives on. A run of the browser suites used it up (2026-11-12: the sync suite's
 * second run in a row was refused). The page's first tab asks AllAnime too.
 * So by default both addresses point at a port nothing listens on, and a request to
 * either fails at once. A suite that is ABOUT the real sources passes LIVE_SOURCES. */
const NOWHERE = 'http://127.0.0.1:9/';
const OFFLINE_SOURCES = { ANI_MATE_TEST_ALLANIME: NOWHERE, ANI_MATE_TEST_ANILIST: NOWHERE, ANI_MATE_TEST_NO_SEED: '1' };
/* The real sources, and still no seeding of the content index: that is twelve requests
 * no suite is about. */
const LIVE_SOURCES = { ANI_MATE_TEST_ALLANIME: '', ANI_MATE_TEST_ANILIST: '', ANI_MATE_TEST_NO_SEED: '1' };

/**
 * Start the app's server on its own data folder.
 * @returns {{ child, port, url, log: () => string }}
 */
async function appServer(dataDir, extraEnv) {
    const downloads = path.join(dataDir, '..', path.basename(dataDir) + '-downloads');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(downloads, { recursive: true });
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'ani-mate-server.js')], {
        env: Object.assign({}, process.env, OFFLINE_SOURCES, {
            ANI_MATE_PORT: String(port),
            ANI_MATE_UI_DIR: path.join(ROOT, 'ui'),
            ANI_MATE_DATA_DIR: dataDir,
            ANI_MATE_DOWNLOAD_DIR: downloads,
        }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    await waitFor('the test server', () => /Server online/.test(log), 15000);
    return { child, port, url: 'http://localhost:' + port + '/', log: () => log };
}

/**
 * Start a headless browser with an empty profile and a debugging port.
 * @returns {{ child, cdp: string, binary: string }}
 */
async function browser(profileDir) {
    const binary = findBrowser();
    if (!binary) return null;
    fs.mkdirSync(profileDir, { recursive: true });
    const port = await freePort();
    /* ⛔ THE THING THAT IS STARTED IS OFTEN NOT THE BROWSER. /usr/bin/brave-browser is a
     * shell script whose last line runs the real binary as a CHILD and waits for it, so
     * a signal sent to "the browser" stopped the script and left the browser running.
     * Found 2026-11-12: ten headless browsers from ten runs of these suites, 105
     * processes, still up an hour later. So the browser is started as the leader of its
     * own process group, and stopping it signals the whole group. reaper() then looks
     * for anything still holding the temp folder and stops that too. */
    const started = spawn(binary, [
        '--headless=new',
        '--remote-debugging-port=' + port,
        '--user-data-dir=' + profileDir,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--mute-audio', '--disable-extensions',
        '--autoplay-policy=no-user-gesture-required',
        'about:blank',
    ], { stdio: 'ignore', detached: true });
    const child = {
        pid: started.pid,
        kill(signal) {
            try { process.kill(-started.pid, signal || 'SIGTERM'); }
            catch (e) { try { started.kill(signal || 'SIGTERM'); } catch (e2) { /* already gone */ } }
        },
    };
    const cdp = 'http://127.0.0.1:' + port;
    try {
        await waitFor('the browser', async () => {
            const r = await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(1500) });
            return r.ok;
        }, 30000);
    } catch (e) {
        child.kill('SIGKILL');
        throw e;
    }
    return { child, cdp, binary };
}

/**
 * Every process whose command line names this folder. The temp folder's name is random
 * and belongs to one run, so nothing else on the machine can match.
 * @returns {number[]} process ids, this process left out
 */
function holding(tmp) {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return (r.stdout || '').split('\n')
        .map((l) => l.trim()).filter((l) => l.includes(tmp))
        .map((l) => Number(l.split(/\s+/)[0]))
        .filter((pid) => pid && pid !== process.pid);
}

/* ── the stream ─────────────────────────────────────────────────────────────────────
 * A test pattern with a tone, 24 seconds, at 640x360 and 320x180, in two second
 * segments. Two qualities, so the quality control has something to choose between. */
function makeStream(dir) {
    const ffmpeg = which(['ffmpeg']);
    if (!ffmpeg) return false;
    const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '24',
        '-filter_complex', '[0:v]split=2[v1][v2];[v2]scale=320:180[v2s]',
        '-map', '[v1]', '-map', '1:a', '-map', '[v2s]', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
        '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
        '-b:v:0', '600k', '-b:v:1', '200k', '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', 'v%v_%03d.ts', '-master_pl_name', 'master.m3u8',
        '-var_stream_map', 'v:0,a:0 v:1,a:1', 'v%v.m3u8',
    ], { cwd: dir, encoding: 'utf8' });
    return r.status === 0 && fs.existsSync(path.join(dir, 'master.m3u8'));
}

/** Everything a launcher needs to end cleanly, whatever happened. */
function reaper(tmp, limitMs) {
    const children = [];
    const closers = [];
    let finished = false;
    const stop = (code) => {
        if (finished) return;
        finished = true;
        for (const c of children) { try { c.kill('SIGTERM'); } catch (e) { /* already gone */ } }
        for (const fn of closers) { try { fn(); } catch (e) { /* already closed */ } }
        setTimeout(() => {
            for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* already gone */ } }
            /* Whatever was started through a wrapper, or forked off by something that
             * was: anything still naming the temp folder is this run's, and goes. */
            for (const pid of holding(tmp)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
            setTimeout(() => {
                const left = holding(tmp);
                if (left.length) console.log('\n  LEFT RUNNING: ' + left.length + ' process(es) of this run could not be stopped: ' + left.join(' ') + '\n');
                try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a busy profile file */ }
                process.exit(left.length && !code ? 1 : code);
            }, 400);
        }, 1500);
    };
    process.on('SIGINT', () => stop(130));
    process.on('SIGTERM', () => stop(143));
    const watchdog = setTimeout(() => {
        console.log('\n  STOPPED: the run passed ' + Math.round(limitMs / 60000) + ' minutes.\n');
        stop(1);
    }, limitMs);
    watchdog.unref();
    return { children, closers, stop };
}

module.exports = { ROOT, freePort, which, findBrowser, waitFor, appServer, browser, reaper, holding, makeStream,
                   LIVE_SOURCES, OFFLINE_SOURCES };
