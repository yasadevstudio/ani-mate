// YASA PRESENTS
/* Who can reach the desktop server, what one request can do to it, and what it stores.
 *
 *     node tests/server-net.test.js
 *
 * It starts its OWN server on a free port with an empty data folder in the system temp
 * directory, and a stub that plays the part of a video host. Nothing here touches the
 * app that is running, its port, or ~/.config/ani-mate. No request leaves this machine.
 *
 * ⛔ EVERY CASE IS SOMETHING THE SERVER DID WRONG ON 2026-11-12:
 *   - it listened on every address the machine has, with no login and a CORS wildcard
 *   - GET /history/clear emptied the history, so an <img> on any web page could
 *   - one /proxy-stream request for a URL that answers 204 ended the process
 *   - the proxy checked its host list once and then followed redirects anywhere
 *   - Range was not forwarded, so an MP4 could not seek
 *   - a playlist the host refused was served back as a 200 playlist
 *   - '?' was stored as an episode total and the show vanished from CONTINUE
 *   - DELETE /favorites/<id> compared the id undecoded, so ids with ':' never matched
 *   - POST /download answered 500 in every release from 0.6.0 to 0.7.1, and built its
 *     file name out of text it had not cleaned
 */
'use strict';
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok    ' + m); } else { fails++; console.log('  FAIL  ' + m); } };
const eq = (got, want, m) => ok(got === want, m + (got === want ? '' : '  [got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ']'));

const freePort = () => new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/** One request with full control of the headers, including Host. */
function ask(port, method, target, { headers = {}, body, host = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
        const h = Object.assign({ Host: 'localhost:' + port }, headers);
        const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
        if (data !== null) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
        const req = http.request({ host, port, method, path: target, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        if (data !== null) req.write(data);
        req.end();
    });
}

(async () => {
    const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-net-'));
    const PORT = await freePort();
    const STUB = await freePort();
    let child = null, stub = null;
    const seen = [];                       // what the stub was asked, with headers

    try {
        /* An index with 200 entries, so the server does not go and seed one from AniList. */
        const byId = {};
        for (let i = 1; i <= 200; i++) byId[i] = { id: i, t: 'x' + i, pop: 1 };
        fs.writeFileSync(path.join(DATA, 'search-index.json'), JSON.stringify({ byId, saved_at: Date.now() }));
        fs.writeFileSync(path.join(DATA, 'ani-mate-favorites.json'), JSON.stringify([
            { id: 'AAone', name: 'Show One', episodes: 12, added: '2026-11-01T00:00:00.000Z' },
            { id: 'anidb:12', name: 'Colon Id', episodes: 3, added: '2026-11-02T00:00:00.000Z' },
        ]));
        fs.writeFileSync(path.join(DATA, 'ani-mate-history.json'), JSON.stringify([
            { anime_id: 'AAone', title: 'Show One', episode: '2', quality: 'best', mode: 'sub',
              timestamp: '2026-11-10T00:00:00.000Z', episodes_watched: ['1'], total_episodes: '?',
              playback_time: 0, playback_episode: null },
            { anime_id: 'AAtwo', title: 'Show Two', episode: '1', quality: 'best', mode: 'sub',
              timestamp: '2026-11-09T00:00:00.000Z', episodes_watched: [], total_episodes: 12,
              playback_time: 0, playback_episode: null },
        ]));

        // ── the stub video host ──────────────────────────────────────────────────
        stub = http.createServer((req, res) => {
            seen.push({ url: req.url, range: req.headers.range || null, referer: req.headers.referer || null });
            const body = Buffer.alloc(1000, 'x');
            if (req.url === '/ok.ts') {
                const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
                if (m) {
                    const a = Number(m[1]), b = m[2] ? Number(m[2]) : body.length - 1;
                    res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': `bytes ${a}-${b}/${body.length}`,
                                         'Content-Length': b - a + 1 });
                    res.end(body.subarray(a, b + 1));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
                res.end(body);
            } else if (req.url === '/redir-ok') { res.writeHead(302, { Location: '/ok.ts' }); res.end();
            } else if (req.url === '/redir-out') { res.writeHead(302, { Location: 'http://example.org/elsewhere' }); res.end();
            } else if (req.url === '/redir-local') { res.writeHead(302, { Location: 'http://127.0.0.1:' + PORT + '/history' }); res.end();
            } else if (req.url === '/nobody') { res.writeHead(204); res.end();
            } else if (req.url === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>window.x=1</script>');
            } else if (req.url === '/dir/list.m3u8') {
                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg1.ts\n/root/seg2.ts\nhttp://127.0.0.1:' + STUB + '/abs/seg3.ts\n');
            } else if (req.url === '/denied.m3u8') { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>denied</html>');
            } else if (req.url === '/video.mp4') {
                /* The episode the canned stream chain points at (see ANI_MATE_TEST_STREAM). */
                const film = Buffer.alloc(5000, 'v');
                res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': film.length });
                res.end(film);
            } else { res.writeHead(404); res.end('nope'); }
        });
        await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

        // ── the server under test ────────────────────────────────────────────────
        child = spawn(process.execPath, [path.join(ROOT, 'server', 'ani-mate-server.js')], {
            env: Object.assign({}, process.env, {
                ANI_MATE_PORT: String(PORT), ANI_MATE_DATA_DIR: DATA, ANI_MATE_UI_DIR: path.join(ROOT, 'ui'),
                ANI_MATE_DOWNLOAD_DIR: path.join(DATA, 'dl'), ANI_MATE_VERSION: '9.9.9-test',
                ANI_MATE_PROXY_TEST_HOSTS: '127.0.0.1:' + STUB,
                /* "No request leaves this machine" was not true until these two lines:
                 * five seconds after it starts on an empty folder the server fills its
                 * content index from AniList. Both sources now point at a port nothing
                 * listens on. */
                ANI_MATE_TEST_ALLANIME: 'http://127.0.0.1:9/', ANI_MATE_TEST_ANILIST: 'http://127.0.0.1:9/',
                /* What the stream chain answers, instead of asking a real source. */
                ANI_MATE_TEST_STREAM: JSON.stringify({ url: 'http://127.0.0.1:' + STUB + '/video.mp4',
                                                       referer: 'https://stream.example/' }),
            }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        child.stderr.on('data', (d) => { log += d; });
        await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('server did not start: ' + log.slice(-300))), 20000);
            child.stdout.on('data', (d) => { if (String(d).includes('Server online')) { clearTimeout(to); resolve(); } });
            child.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + log.slice(-300))));
        });
        const alive = async () => { try { return (await ask(PORT, 'GET', '/status')).status === 200; } catch (e) { return false; } };
        const viaProxy = (u, extra) => '/proxy-stream?url=' + encodeURIComponent('http://127.0.0.1:' + STUB + u) + (extra || '');

        console.log('\nwho can reach it');
        const st = await ask(PORT, 'GET', '/status');
        eq(st.status, 200, 'it answers on 127.0.0.1');
        eq(st.json && st.json.version, '9.9.9-test', 'and reports the version it was started with, not a fallback');
        const lan = Object.values(os.networkInterfaces()).flat()
            .find((i) => i && i.family === 'IPv4' && !i.internal);
        if (lan) {
            let reached = false;
            try { await ask(PORT, 'GET', '/status', { host: lan.address }); reached = true; } catch (e) { reached = false; }
            ok(!reached, 'it does NOT answer on this machine\'s network address');
        } else {
            console.log('  (no network address on this machine to try)');
        }
        eq((await ask(PORT, 'GET', '/status', { headers: { Host: 'evil.example:' + PORT } })).status, 403,
           'a request that names another host is refused (a DNS name pointed at 127.0.0.1)');
        eq((await ask(PORT, 'GET', '/favorites', { headers: { Origin: 'https://evil.example' } })).status, 403,
           'a request from another origin is refused');
        eq((await ask(PORT, 'GET', '/history', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403,
           'so is one a browser marks cross-site (an <img> or a form on another page)');
        eq((await ask(PORT, 'GET', '/history', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403,
           'and one from another port on localhost');
        eq((await ask(PORT, 'POST', '/favorites', { headers: { Origin: 'http://localhost:' + PORT, 'Sec-Fetch-Site': 'same-origin' },
                                                    body: { id: 'own', name: 'Own Page' } })).status, 200,
           'the page itself is let through');
        const cors = await ask(PORT, 'GET', '/history');
        ok(!('access-control-allow-origin' in cors.headers), 'no answer carries a CORS header');
        const pre = await ask(PORT, 'OPTIONS', '/favorites', { headers: { 'Access-Control-Request-Method': 'POST' } });
        ok(!('access-control-allow-origin' in pre.headers), 'and a preflight is not granted');

        console.log('\nwhat a GET can no longer do');
        eq((await ask(PORT, 'GET', '/history/clear')).status, 404, 'GET /history/clear is not a route');
        eq((await ask(PORT, 'GET', '/history/remove?id=AAtwo')).status, 404, 'GET /history/remove is not a route');
        eq(JSON.parse(fs.readFileSync(path.join(DATA, 'ani-mate-history.json'), 'utf8')).length, 2, 'and the history is untouched');

        console.log('\nwhat it stores');
        const cont = await ask(PORT, 'GET', '/continue');
        const one = ((cont.json && cont.json.continue_list) || []).find((c) => c.anime_id === 'AAone');
        ok(!!one, 'a show whose total was stored as "?" is still in CONTINUE');
        eq(one && one.total_episodes, null, 'and its total reads as unknown, not as "?"');
        eq((await ask(PORT, 'POST', '/favorites', { body: { id: 'bad', name: { not: 'text' } } })).status, 400,
           'a favorite whose name is not text is refused');
        eq((await ask(PORT, 'POST', '/favorites', { body: { id: 'f9', name: 'Nine', franchise_id: 'fp:', cover: 'javascript:1', episodes: '?' } })).status, 200,
           'a favorite with a junk franchise id, cover and count is accepted');
        const f9 = JSON.parse(fs.readFileSync(path.join(DATA, 'ani-mate-favorites.json'), 'utf8')).find((f) => f.id === 'f9');
        ok(f9 && f9.franchise_id === undefined && f9.cover === undefined && f9.episodes === 0, 'with the junk left out: ' + JSON.stringify(f9));
        await ask(PORT, 'POST', '/save-progress', { body: { anime_id: 'AAtwo', episode: '<img src=x onerror=1>', playback_time: 'abc' } });
        const h2 = JSON.parse(fs.readFileSync(path.join(DATA, 'ani-mate-history.json'), 'utf8')).find((h) => h.anime_id === 'AAtwo');
        ok(/^[A-Za-z0-9._-]{1,12}$/.test(h2.playback_episode) && h2.playback_time === 0,
           'an episode label is stored as a short label and a bad time as 0: ' + JSON.stringify([h2.playback_episode, h2.playback_time]));

        console.log('\ndeletes are recorded, and ids with a colon can be deleted');
        const del = await ask(PORT, 'DELETE', '/favorites/' + encodeURIComponent('anidb:12'));
        eq(del.status, 200, 'DELETE /favorites/anidb%3A12 answers');
        ok(!JSON.parse(fs.readFileSync(path.join(DATA, 'ani-mate-favorites.json'), 'utf8')).some((f) => f.id === 'anidb:12'),
           'and the favorite is actually gone (the id used to be compared undecoded)');
        eq((await ask(PORT, 'POST', '/history/remove?id=AAtwo')).status, 200, 'POST /history/remove removes');
        const local = (await ask(PORT, 'GET', '/sync/local')).json;
        ok(local && local.deleted && local.deleted.favorites['anidb:12'] > 0 && local.deleted.watch['AAtwo'] > 0,
           'both removals are in the delete journal that sync reads: ' + JSON.stringify(local && local.deleted));

        console.log('\nthe local side of sync');
        ok(Array.isArray(local.favorites) && local.favorites.every((r) => r.anime_id && r._lid !== undefined),
           '/sync/local returns favorites as sync rows that carry their local id');
        await ask(PORT, 'POST', '/sync/local', { body: {
            favorites: [{ anime_id: 'al:5', title: 'From Phone', episodes: 26, added_at: 1794000000000, updated_at: 1794000000000 }],
            watch: [{ anime_id: 'AAone', title: 'Show One', episode: '4', position: 90, mode: 'sub',
                      episodes_watched: '["1","2","3"]', total_episodes: 12, updated_at: 1794000000000 }],
            identity: { watch: [{ id: 'AAone', anilist_id: 77 }] },
            clear_deleted: { favorites: ['anidb:12'] },
        } });
        const after = (await ask(PORT, 'GET', '/sync/local')).json;
        ok(after.favorites.some((r) => r.anime_id === 'al:5' && r.title === 'From Phone'), 'a pulled favorite is stored');
        const w = after.watch.find((r) => r._lid === 'AAone');
        ok(w && w.anime_id === 'al:77' && w.episode === '4' && w.position === 90,
           'a pulled watch row is applied, and the row now syncs under its AniList id: ' + JSON.stringify(w && [w.anime_id, w.episode, w.position]));
        ok(after.deleted.favorites['anidb:12'] === undefined && after.deleted.watch['AAtwo'] > 0,
           'a cleared journal entry is gone and the other one stays');
        fs.writeFileSync(path.join(DATA, 'ani-mate-favorites.json'), '{ this is not json');
        eq((await ask(PORT, 'GET', '/sync/local')).status, 500,
           'a favorites file that will not parse is an ERROR to sync, not an empty library');
        fs.writeFileSync(path.join(DATA, 'ani-mate-favorites.json'), '[]');

        console.log('\nthe stream proxy');
        eq((await ask(PORT, 'GET', '/proxy-stream?url=' + encodeURIComponent('http://127.0.0.1:1/x'))).status, 403,
           'a host that is not on the list is refused');
        eq((await ask(PORT, 'GET', '/proxy-stream?url=' + encodeURIComponent('file:///etc/hostname'))).status, 403,
           'so is anything that is not http(s)');
        eq((await ask(PORT, 'GET', '/proxy-stream?url=' + encodeURIComponent('/subtitle?t=x'))).status, 400,
           'and a relative address');
        const okTs = await ask(PORT, 'GET', viaProxy('/ok.ts', '&referer=' + encodeURIComponent('https://zokoanime.video/')));
        eq(okTs.status, 200, 'an allowed segment is passed through');
        eq(okTs.text.length, 1000, 'whole');
        eq(seen[seen.length - 1].referer, 'https://zokoanime.video/', 'with the referer the stream needs');
        const part = await ask(PORT, 'GET', viaProxy('/ok.ts'), { headers: { Range: 'bytes=100-199' } });
        eq(part.status, 206, 'a Range request is answered 206 (it used to be answered 200 from byte 0)');
        eq(part.text.length, 100, 'with exactly the bytes asked for');
        eq(part.headers['content-range'], 'bytes 100-199/1000', 'and the Content-Range header');
        eq((await ask(PORT, 'GET', viaProxy('/redir-ok'))).status, 200, 'a redirect to an allowed host is followed');
        eq((await ask(PORT, 'GET', viaProxy('/redir-out'))).status, 403, 'a redirect to a host that is NOT allowed is refused');
        eq((await ask(PORT, 'GET', viaProxy('/redir-local'))).status, 403, 'including a redirect back at this server');
        const nobody = await ask(PORT, 'GET', viaProxy('/nobody'));
        eq(nobody.status, 204, 'a 204 from the host is passed on');
        ok(await alive(), 'and THE SERVER IS STILL RUNNING afterwards (this request used to end the process)');
        const page = await ask(PORT, 'GET', viaProxy('/page.html'));
        ok(!/html/i.test(page.headers['content-type'] || ''), 'a web page is never answered as text/html from this origin: ' + page.headers['content-type']);
        eq(page.headers['x-content-type-options'], 'nosniff', 'and the browser is told not to guess');
        const list = await ask(PORT, 'GET', viaProxy('/dir/list.m3u8', '&referer=' + encodeURIComponent('https://r.example/')));
        const lines = list.text.split('\n');
        const dec = (l) => decodeURIComponent((/url=([^&"]+)/.exec(l) || [])[1] || '');
        eq(dec(lines[2]), 'http://127.0.0.1:' + STUB + '/dir/seg1.ts', 'a relative playlist line is resolved against the playlist');
        eq(dec(lines[3]), 'http://127.0.0.1:' + STUB + '/root/seg2.ts', 'a root-relative line against the host (it used to be glued onto the folder)');
        eq(dec(lines[4]), 'http://127.0.0.1:' + STUB + '/abs/seg3.ts', 'an absolute line is kept');
        ok(/URI="\/proxy-stream\?url=/.test(lines[1]) && dec(lines[1]).endsWith('/dir/key.bin'), 'a key URI is routed through the proxy too');
        ok(lines.slice(1, 5).every((l) => l.includes('referer=' + encodeURIComponent('https://r.example/'))), 'and every line carries the referer on');
        eq((await ask(PORT, 'GET', viaProxy('/denied.m3u8'))).status, 502, 'a playlist the host refused is an error, not a 200 playlist');

        console.log('\nplay and download (the stream chain is answered by the stub)');
        const play = await ask(PORT, 'POST', '/play', { body: {
            anime_id: 'AAplay', episode: '3', title: 'Play Show', title_english: 'Play Show EN',
            quality: 'best', sub_or_dub: 'sub', total_episodes: '?', nsfw: false } });
        eq(play.status, 200, 'POST /play answers');
        eq(play.json && play.json.stream_url, 'http://127.0.0.1:' + STUB + '/video.mp4', 'with the stream address');
        eq(play.json && play.json.referer, 'https://stream.example/', 'and the referer the page has to route it with');
        ok(play.json && !('all_links' in play.json) && !('resolution' in play.json),
           'it does not claim a list of alternative links or a resolution it does not have');
        const played = JSON.parse(fs.readFileSync(path.join(DATA, 'ani-mate-history.json'), 'utf8')).find((h) => h.anime_id === 'AAplay');
        ok(played && played.episodes_watched.length === 0, 'starting an episode does not mark it watched');
        eq(played && played.total_episodes, null, 'and a total of "?" is stored as unknown');

        const dlDir = path.join(DATA, 'dl');
        const dl = await ask(PORT, 'POST', '/download', { body: {
            anime_id: 'AAplay', episode: '3', title: 'Play Show', quality: 'best', sub_or_dub: 'sub' } });
        eq(dl.status, 200, 'POST /download answers 200 (it was a 500)');
        eq(dl.json && dl.json.filename, 'Play Show - EP3 [best].mp4', 'with the file name it will write');
        let state = null;
        for (let i = 0; i < 40; i++) {
            state = (await ask(PORT, 'GET', '/download-status?id=' + encodeURIComponent(dl.json.download_id))).json;
            if (state && state.status !== 'downloading') break;
            await new Promise((r) => setTimeout(r, 150));
        }
        eq(state && state.status, 'complete', 'the download finishes' + (state && state.error ? ' [' + state.error + ']' : ''));
        const written = path.join(dlDir, 'Play Show - EP3 [best].mp4');
        ok(fs.existsSync(written) && fs.statSync(written).size === 5000, 'and the file holds every byte the host sent');
        eq((seen.filter((x) => x.url === '/video.mp4').pop() || {}).referer, 'https://stream.example/',
           'the host was asked with the stream\'s own referer, not a fixed one');

        const sneaky = await ask(PORT, 'POST', '/download', { body: {
            anime_id: 'AAplay', episode: '1]/../../../escape[', title: '../../Up', quality: '..\\..\\q' } });
        eq(sneaky.status, 200, 'a download whose episode, title and quality are path fragments is accepted');
        ok(sneaky.json && !/[\\/]/.test(sneaky.json.filename), 'under a file name with no path in it: ' + JSON.stringify(sneaky.json && sneaky.json.filename));
        for (let i = 0; i < 40; i++) {
            state = (await ask(PORT, 'GET', '/download-status?id=' + encodeURIComponent(sneaky.json.download_id))).json;
            if (state && state.status !== 'downloading') break;
            await new Promise((r) => setTimeout(r, 150));
        }
        ok(fs.readdirSync(dlDir).length === 2 && fs.readdirSync(DATA).every((f) => !/escape|Up/.test(f)),
           'and both files are inside the download folder, nowhere else: ' + JSON.stringify(fs.readdirSync(dlDir)));
        eq((await ask(PORT, 'POST', '/download', { body: { title: 'no id' } })).status, 400, 'a download with no show or episode is refused');

        ok(await alive(), 'the server is still running at the end');
    } catch (e) {
        fails++;
        console.log('  THREW  ' + (e && e.stack || e));
    } finally {
        if (child) child.kill();
        if (stub) stub.close();
        try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* temp folder */ }
    }
    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})();
