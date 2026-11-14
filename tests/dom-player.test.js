// YASA PRESENTS
/* The player, for real: the page in a browser, playing a video.
 *
 *     node scripts/test-dom.js player          (or: npm run test:dom, which runs this first)
 *
 * scripts/test-dom.js makes everything this needs and takes it down afterwards: 24
 * seconds of test pattern cut into an HLS stream at two qualities, a stub host that
 * serves it the way the real hosts do (no cross-origin headers, so the page cannot
 * fetch it directly), a server whose stream chain answers with that stream, and a
 * headless browser with an empty profile. Nothing this suite CHECKS needs the network.
 *
 * WHAT IT IS HERE TO SEE. tests/page-playback.test.js proves the order of events with
 * the player faked. This is the other half: hls.js, a <video> element, the proxy, a
 * subtitle track, real seconds going by.
 *
 *   - the stream reaches the host through the app's proxy, carrying the stream's referer
 *   - a subtitle file the server holds is asked of the SERVER (it used to be wrapped in
 *     the proxy, which refused it: no external subtitle ever loaded)
 *   - the quality control changes the level hls.js plays (it used to do nothing)
 *   - progress is saved for the episode that is playing, and still is after the
 *     selection is cleared under it (what a search does)
 *   - an episode is marked watched at 80%
 *   - after an episode ends, closing the player does not file its end time anywhere
 *   - AUTO plays the next episode, and the grid follows
 *   - a resume from CONTINUE starts at its offset
 *   - a stream with no referer is tried directly, fails, and is rebuilt through the proxy
 *
 * Exit: 0 pass, 1 fail, 2 could not run.
 */
'use strict';
const { open, settle } = require('./cdp');

const CDP = process.env.ANIMATE_CDP || '';
const UI = process.env.ANIMATE_UI_URL || '';
const STUB = process.env.ANIMATE_STUB || '';
const SHOW = process.env.ANIMATE_PLAYER_SHOW || 'domPlayer1';

let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok    ' + m); }
                       else { fails++; console.log('  FAIL  ' + m); } };
const section = (s) => console.log('\n' + s);

if (!CDP || !UI || !STUB) {
    console.log('\n  SKIP: this suite is started by scripts/test-dom.js, which makes the stream,\n'
              + '  the stub host, the server and the browser it needs.\n');
    process.exit(2);
}

const seen = async () => (await fetch(STUB + '/__seen')).json();
const resetSeen = () => fetch(STUB + '/__reset');

(async () => {
    let page;
    try { page = await open(CDP, UI); }
    catch (e) { console.log('\n  SKIP: ' + e.message + '\n'); process.exit(2); }
    const { evalJs, until, thrown } = page;

    /* What the server has stored for the test show. */
    const stored = () => evalJs(`
        const d = await (await fetch('/history')).json();
        return (d.forge || []).find(h => h.anime_id === ${JSON.stringify(SHOW)}) || null;`);
    const playing = (min) => until(`
        const v = document.getElementById('video-player');
        return (!v.paused && v.currentTime > ${min || 0.5}) ? v.currentTime : 0;`, 20000);
    const openShow = async () => {
        await evalJs(`document.querySelector('[data-tab="favs"]').click(); return true;`);
        await until(`return !!document.querySelector('#results-container .result-card[data-id="${SHOW}"]');`, 8000);
        await evalJs(`document.querySelector('#results-container .result-card[data-id="${SHOW}"]').click(); return true;`);
        return until(`return document.querySelectorAll('#episode-grid .episode-btn').length;`, 8000);
    };
    const pick = (ep) => evalJs(`
        const b = document.querySelector('#episode-grid .episode-btn[data-ep="${ep}"]');
        if (b) b.click();
        return !!b;`);
    const pressPlay = () => evalJs(`document.getElementById('play-btn').click(); return true;`);
    const errorToasts = () => evalJs(`return [...document.querySelectorAll('.toast.error')].map(t => t.textContent);`);

    try {
        await until(`return !!document.getElementById('results-container');`, 15000);
        ok(thrown.length === 0, 'the page threw nothing while starting up'
            + (thrown.length ? ': ' + JSON.stringify(thrown.slice(0, 3)) : ''));

        // ── open and play ──────────────────────────────────────────────────────────
        section('opening a show and pressing PLAY');
        const count = await openShow();
        ok(count === 3, 'the show opens with its 3 episodes (' + count + ')');
        await pick('1');
        await resetSeen();
        await pressPlay();
        const t0 = await playing();
        ok(t0 > 0, 'the video is playing (at ' + (t0 || 0).toFixed(1) + 's)');
        ok((await errorToasts()).length === 0, 'with no error on screen');

        const log = await seen();
        const master = log.find(x => x.url === '/hls/master.m3u8');
        ok(!!master, 'the stub host was asked for the playlist');
        ok(master && master.referer === 'https://stream.example/',
           'with the STREAM\'s referer: ' + JSON.stringify(master && master.referer));
        ok(log.length > 0 && log.every(x => x.origin === null),
           'every request came from the app\'s proxy, none straight from the page (' + log.length + ' requests)');
        ok(log.filter(x => /\.ts$/.test(x.url)).every(x => x.referer === 'https://stream.example/'),
           'and every segment carried the referer too');

        const st = await evalJs(`
            return { playing: state.playing && { id: state.playing.anime.id, ep: state.playing.episode },
                     levels: (state.hlsInstance.levels || []).map(l => l.height),
                     label: document.getElementById('np-detail').textContent,
                     title: document.getElementById('np-title').textContent };`);
        ok(st.playing && st.playing.id === SHOW && st.playing.ep === '1', 'the page records episode 1 of this show as playing');
        ok(JSON.stringify(st.levels.slice().sort((a, b) => a - b)) === '[180,360]',
           'hls.js sees both qualities: ' + JSON.stringify(st.levels));
        ok(/^EP 1 \/\/ /.test(st.label) && / \/\/ SUB \/\/ test$/.test(st.label), 'the bar reads: ' + JSON.stringify(st.label));
        ok(st.title === 'Dom Player Show', 'under the show\'s title');

        // ── the subtitle the server holds ──────────────────────────────────────────
        section('a subtitle file held by the server');
        const sub = await until(`
            const v = document.getElementById('video-player');
            const t = v.querySelector('track');
            const tt = v.textTracks && v.textTracks[0];
            if (!t || !tt || !tt.cues || !tt.cues.length) return null;
            return { src: t.getAttribute('src'), cues: tt.cues.length, mode: tt.mode };`, 8000);
        ok(!!sub, 'a subtitle track loaded');
        ok(sub && /^\/subtitle\?t=domtest$/.test(sub.src),
           'it was asked of the server itself, not wrapped in the proxy: ' + JSON.stringify(sub && sub.src));
        ok(sub && sub.cues === 60 && sub.mode === 'showing', 'all 60 cues are there and the track is showing');

        // ── the quality control ────────────────────────────────────────────────────
        section('the quality control');
        const setQuality = (v) => evalJs(`
            const s = document.getElementById('quality-select');
            s.value = ${JSON.stringify(v)};
            s.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const h = state.hlsInstance;
            /* The HEIGHT of the level that is pinned (hls.js numbers its levels from the
             * lowest bitrate up, so an index says nothing by itself). 0 = not pinned. */
            return { pinned: h.manualLevel >= 0 ? h.levels[h.manualLevel].height : 0, auto: h.autoLevelEnabled,
                     label: document.getElementById('np-detail').textContent };`);
        let q = await setQuality('worst');
        ok(q.pinned === 180 && q.auto === false, 'WORST pins the 180p level (pinned: ' + q.pinned + 'p)');
        ok(/180P/.test(q.label), 'and the bar says 180P: ' + JSON.stringify(q.label));
        q = await setQuality('360');
        ok(q.pinned === 360, '360p pins the 360p level (pinned: ' + q.pinned + 'p)');
        q = await setQuality('1080');
        ok(q.pinned === 360, '1080p, which this stream does not have, takes the nearest below it (pinned: ' + q.pinned + 'p)');
        q = await setQuality('480');
        ok(q.pinned === 360, 'so does 480p (pinned: ' + q.pinned + 'p)');
        q = await setQuality('best');
        ok(q.pinned === 0 && q.auto === true, 'BEST hands the choice back to hls.js');

        // ── progress ───────────────────────────────────────────────────────────────
        section('progress');
        await evalJs(`document.getElementById('video-player').currentTime = 5;
                      await new Promise(r => setTimeout(r, 700)); saveProgress();
                      await new Promise(r => setTimeout(r, 400)); return true;`);
        let row = await stored();
        ok(row && row.playback_episode === '1' && row.playback_time >= 5 && row.playback_time <= 8,
           'a save files episode 1 at about 5s: ' + JSON.stringify(row && [row.playback_episode, row.playback_time]));
        ok(row && Array.isArray(row.episodes_watched) && row.episodes_watched.length === 0,
           'and starting it has not marked it watched');

        /* What a search does when its results arrive: it closes the open show. */
        await evalJs(`clearOpenShow(); setCenterView('browse');
                      document.getElementById('video-player').currentTime = 10;
                      await new Promise(r => setTimeout(r, 700)); saveProgress();
                      await new Promise(r => setTimeout(r, 400)); return true;`);
        row = await stored();
        const cleared = await evalJs(`return { sel: state.selectedAnime, playing: !!state.playing,
                                               title: document.getElementById('np-title').textContent };`);
        ok(cleared.sel === null && cleared.playing, 'with the selection cleared, the video is still recorded as playing');
        ok(row && row.playback_time >= 10 && row.playback_time <= 13,
           'and its progress is still saved: ' + JSON.stringify(row && row.playback_time));
        ok(cleared.title === 'Dom Player Show', 'the bar still names what is playing: ' + JSON.stringify(cleared.title));

        await evalJs(`document.getElementById('video-player').currentTime = 20; return true;`);   // 80% of 24s is 19.2
        row = null;
        for (let i = 0; i < 20 && !(row && row.episodes_watched.includes('1')); i++) { await settle(250); row = await stored(); }
        ok(row && row.episodes_watched.includes('1'), 'past 80% it is marked watched: ' + JSON.stringify(row && row.episodes_watched));

        // ── the end of an episode, AUTO off ────────────────────────────────────────
        section('an episode ends, AUTO off');
        await evalJs(`const v = document.getElementById('video-player'); v.currentTime = v.duration - 0.5; return true;`);
        const done = await until(`return state.playing && state.playing.finished === true;`, 8000);
        ok(!!done, 'the page knows the episode finished');
        await settle(500);
        await evalJs(`document.getElementById('player-back-btn').click(); return true;`);
        await settle(600);
        row = await stored();
        const after = await evalJs(`return { playing: state.playing, on: state.isPlaying };`);
        ok(after.playing === null && after.on === false, 'closing the player clears what was playing');
        ok(row && row.playback_time === 0,
           'and no end-of-video time was filed as a place to resume from (stored: ' + JSON.stringify(row && row.playback_time) + ')');

        // ── AUTO plays the next one ────────────────────────────────────────────────
        section('AUTO on');
        await openShow();
        await evalJs(`const t = document.getElementById('autoplay-toggle'); if (!t.checked) t.click(); return t.checked;`);
        await pick('1');
        await pressPlay();
        await playing();
        await evalJs(`const v = document.getElementById('video-player'); v.currentTime = v.duration - 0.5; return true;`);
        const next = await until(`
            const v = document.getElementById('video-player');
            return (state.playing && state.playing.episode === '2' && !v.paused && v.currentTime > 0.3 && v.currentTime < 8)
                ? { sel: state.selectedEpisode, label: document.getElementById('np-detail').textContent } : null;`, 20000);
        ok(!!next, 'when episode 1 ends, episode 2 starts by itself');
        ok(next && next.sel === '2', 'the grid\'s selection moved to 2 with it');
        ok(next && /^EP 2 \/\/ /.test(next.label), 'and the bar reads: ' + JSON.stringify(next && next.label));

        // ── resume from CONTINUE ───────────────────────────────────────────────────
        section('resume from CONTINUE');
        await evalJs(`document.getElementById('video-player').currentTime = 12;
                      await new Promise(r => setTimeout(r, 800));
                      document.getElementById('player-back-btn').click();
                      await new Promise(r => setTimeout(r, 600)); return true;`);
        row = await stored();
        ok(row && row.playback_episode === '2' && row.playback_time >= 12 && row.playback_time <= 15,
           'closing the player mid-episode files episode 2 at about 12s: ' + JSON.stringify(row && [row.playback_episode, row.playback_time]));
        await evalJs(`document.querySelector('[data-tab="continue"]').click(); return true;`);
        const card = await until(`
            const c = document.querySelector('#results-container .result-card[data-id="${SHOW}"]');
            return c ? c.textContent.replace(/\\s+/g, ' ').trim() : null;`, 8000);
        ok(card && /RESUME EP 2 at 0:1[2-5]/.test(card), 'CONTINUE offers: ' + JSON.stringify(card));
        await evalJs(`document.querySelector('#results-container .result-card[data-id="${SHOW}"]').click(); return true;`);
        const resumed = await until(`
            const v = document.getElementById('video-player');
            return (!v.paused && v.currentTime > 0.5 && state.playing) ? { t: v.currentTime, ep: state.playing.episode } : null;`, 20000);
        ok(resumed && resumed.ep === '2' && resumed.t >= 11.5,
           'tapping it plays episode 2 from its offset, not from 0:00 (first seen at ' + (resumed ? resumed.t.toFixed(1) : '?') + 's)');
        await evalJs(`hidePlayer(); return true;`);

        // ── a stream with no referer ───────────────────────────────────────────────
        section('a stream that comes with no referer');
        await resetSeen();
        await evalJs(`state.streamReferer = null; state.streamSubtitles = [];
                      showPlayer(${JSON.stringify(STUB + '/hls/master.m3u8')}); return true;`);
        const fell = await playing();
        const log2 = await seen();
        ok(log2.some(x => x.url === '/hls/master.m3u8' && x.origin !== null),
           'it is tried straight from the page first (which this host refuses, like the real ones)');
        ok(log2.some(x => x.url === '/hls/master.m3u8' && x.origin === null),
           'then asked for again through the app\'s proxy');
        ok(fell > 0, 'and it plays (at ' + (fell || 0).toFixed(1) + 's)');
        await evalJs(`hidePlayer(); return true;`);

        ok(thrown.length === 0, 'the page threw nothing during the whole run'
            + (thrown.length ? ': ' + JSON.stringify(thrown.slice(0, 5)) : ''));
    } catch (e) {
        ok(false, 'THREW: ' + (e && e.message || e));
    } finally {
        await page.close();
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})();
