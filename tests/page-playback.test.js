// YASA PRESENTS
/* The desktop page's play and stop functions, lifted out of the page and run in Node.
 *
 *     node tests/page-playback.test.js          # offline: no server, no browser
 *
 * WHAT THIS IS FOR. On 2026-11-12 the page's playback bookkeeping was rebuilt around one
 * idea: what is PLAYING (state.playing) is not what is SELECTED, and a play request is
 * answered only if nothing has replaced it. Every case below is a sequence of clicks
 * that, BY A READING OF THE CODE AS IT WAS, ended in the wrong episode playing, the wrong
 * episode being marked, or a resume offset turning up in a later play. (That is a
 * reading, not a run: the old functions had a different shape and cannot be loaded by
 * this file.)
 *
 * The functions are the page's own, lifted by tests/lift-js.js, not copies. What is
 * faked is everything around them: the server (each /play is a promise this file
 * resolves when it chooses, which is how "A answers after B" is staged), the player
 * (showPlayer only records what it was asked to show), and the handful of elements the
 * functions touch.
 *
 * ⚠ THIS IS NOT A BROWSER. It proves the order of events and the bookkeeping. It says
 * nothing about hls.js, the video element or the layout: tests/dom-ui.test.js is the
 * suite that sees the real page.
 */
'use strict';
const { lift } = require('./lift-js');

let fails = 0, passes = 0;
function ok(cond, msg) {
    if (cond) { passes++; console.log('  ok    ' + msg); }
    else { fails++; console.log('  FAIL  ' + msg); }
}
function eq(got, want, msg) {
    const same = JSON.stringify(got) === JSON.stringify(want);
    ok(same, msg + (same ? '' : '   [got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ']'));
}
const section = (s) => console.log('\n' + s);
const tick = () => new Promise(r => setImmediate(r));

/* One fresh page per case, so no case inherits another's state. */
function page(stateIn) {
    const played = [];            // what showPlayer was asked to show
    const requests = [];          // every apiCall, with the handles to answer it
    const posts = [];             // every POST made with fetch (save-progress, mark-watched)
    const toasts = [];
    const video = { currentTime: 0, ended: false, duration: 1440,
                    pause() {}, load() {}, removeAttribute() {} };
    const els = {};
    const el = (id) => els[id] || (els[id] = id === 'video-player' ? video : {
        value: id === 'quality-select' ? 'best' : id === 'audio-select' ? 'sub' : '',
        textContent: '', style: {}, disabled: false,
        classList: { add() {}, remove() {}, toggle() {} },
    });
    const document = { getElementById: el, querySelectorAll: () => [] };

    function apiCall(endpoint, options) {
        return new Promise((resolve, reject) => {
            requests.push({ endpoint, body: options && options.body ? JSON.parse(options.body) : null,
                            resolve, reject });
        });
    }
    function fetch(url, options) {
        posts.push({ url: String(url).replace('http://test', ''),
                     body: options && options.body ? JSON.parse(options.body) : null });
        return Promise.resolve({ ok: true, json: async () => ({}) });
    }

    const api = lift(
        ['playEpisode', 'hidePlayer', 'saveProgress', 'watchTimeHandler', 'noteWatchedLocally',
         'postJson', 'showingPlaying', 'countOf', 'countLabel', 'setNowPlaying', 'describeSelection'],
        Object.assign({
            mode: 'sub', nsfw: false, preferEnglish: true, isPlaying: false, history: [],
            episodes: ['1', '2', '3', '4', '5', '6'], hlsInstance: null,
            selectedAnime: { id: 'showA', title: 'Show A', titleEnglish: '', epCount: 6 },
            selectedEpisode: '4', pendingResumeTime: 0, watchedMarked: false,
        }, stateIn || {}),
        { document, apiCall, fetch, API: 'http://test',
          toast: (m, k) => toasts.push((k || 'info') + ': ' + m),
          showPlayer: (url) => { played.push({ url, resumeAt: api.state.pendingResumeTime,
                                               playing: api.state.playing && api.state.playing.episode });
                                 api.state.isPlaying = true; api.state.pendingResumeTime = 0; },
          updatePlayButton: () => {}, loadHistory: () => {}, unlockOrientation: () => {},
          renderEpisodeGrid: () => {}, renderHistory: () => {} },
        'let playSeq = 0; let playPending = null; let continueFetchedAt = 0;');
    return { api, state: api.state, played, requests, posts, toasts, video, els };
}
const stream = (n) => ({ stream_url: 'https://cdn.test/ep' + n + '.m3u8', provider: 'Test', referer: null, subtitles: [] });

(async () => {
    // ── the newest request is the one that plays ────────────────────────────────────
    section('a second episode asked for while the first is still loading');
    {
        const p = page();
        p.api.playEpisode();                               // episode 4
        p.state.selectedEpisode = '5';                     // the user clicks 5 ...
        p.api.playEpisode();                               // ... and presses PLAY again
        eq(p.requests.map(r => r.body.episode), ['4', '5'], 'both were asked for');
        p.requests[1].resolve(stream(5));                  // 5 answers first
        await tick();
        p.requests[0].resolve(stream(4));                  // 4 answers late
        await tick();
        eq(p.played.map(x => x.url), ['https://cdn.test/ep5.m3u8'], 'only episode 5 was played');
        eq(p.state.playing && p.state.playing.episode, '5', 'and 5 is what the page says is playing');
        eq(p.state.selectedEpisode, '5', 'the selection is still 5');
    }
    {
        const p = page();
        p.api.playEpisode();
        p.state.selectedEpisode = '5';
        p.api.playEpisode();
        p.requests[0].resolve(stream(4));                  // this time 4 answers FIRST
        await tick();
        eq(p.played.length, 0, 'the earlier answer arriving first plays nothing');
        p.requests[1].resolve(stream(5));
        await tick();
        eq(p.played.map(x => x.playing), ['5'], 'episode 5 plays when its own answer arrives');
    }
    {
        const p = page();
        p.api.playEpisode();
        p.api.playEpisode();                               // a double press on PLAY
        eq(p.requests.length, 1, 'pressing PLAY twice on the same episode asks the server once');
    }

    // ── what plays is what was asked for, whatever is selected by then ──────────────
    section('the selection changes while one request is loading');
    {
        const p = page();
        p.api.playEpisode();                               // episode 4
        p.state.selectedEpisode = '5';                     // clicked, but PLAY not pressed
        p.requests[0].resolve(stream(4));
        await tick();
        eq(p.state.playing.episode, '4', 'episode 4 plays, as asked');
        eq(p.state.selectedEpisode, '4', 'and the grid\'s selection goes back to what is playing');
        p.video.currentTime = 1200;                        // past 80% of 1440
        p.api.watchTimeHandler();
        const mark = p.posts.find(x => x.url === '/mark-watched');
        eq(mark && mark.body, { anime_id: 'showA', episode: '4' }, 'episode 4 is the one marked watched');
    }

    // ── a search clears the selection; the video keeps its bookkeeping ──────────────
    section('the selection is cleared under a playing video (a search finishing)');
    {
        const p = page();
        p.api.playEpisode();
        p.requests[0].resolve(stream(4));
        await tick();
        p.state.selectedAnime = null;                      // what clearOpenShow() does
        p.state.selectedEpisode = null;
        p.state.episodes = [];
        p.video.currentTime = 600;
        p.api.saveProgress();
        const saved = p.posts.find(x => x.url === '/save-progress');
        eq(saved && saved.body, { anime_id: 'showA', episode: '4', playback_time: 600 },
           'progress is still saved, for the episode that is playing');
        p.video.currentTime = 1300;
        p.api.watchTimeHandler();
        ok(p.posts.some(x => x.url === '/mark-watched' && x.body.episode === '4'),
           'and it is still marked watched at 80%');
    }
    {
        const p = page();
        p.api.playEpisode();
        p.state.selectedAnime = null;                      // cleared WHILE the request is out
        p.state.selectedEpisode = null;
        let threw = null;
        p.requests[0].resolve(stream(4));
        try { await tick(); } catch (e) { threw = e; }
        ok(!threw && p.played.length === 1, 'an answer that arrives after the selection was cleared still plays, and throws nothing');
    }

    // ── closing the player calls off a request that is still out ────────────────────
    section('the player is closed before the answer arrives');
    {
        const p = page();
        p.api.playEpisode();
        p.api.hidePlayer();
        p.requests[0].resolve(stream(4));
        await tick();
        eq(p.played.length, 0, 'nothing opens after the user closed it');
        eq(p.state.playing, null, 'and nothing is recorded as playing');
    }

    // ── the resume offset belongs to one request ────────────────────────────────────
    section('a resume offset does not outlive the play it was for');
    {
        const p = page();
        p.api.playEpisode({ anime: p.state.selectedAnime, episode: '3', episodes: p.state.episodes, resumeAt: 300 });
        p.requests[0].reject(new Error('No streams available'));
        await tick();
        eq(p.state.pendingResumeTime, 0, 'a failed resume leaves no offset armed');
        p.api.playEpisode();                               // an ordinary play, episode 4
        p.requests[1].resolve(stream(4));
        await tick();
        eq(p.played[0] && p.played[0].resumeAt, 0, 'the next episode starts at 0:00');
    }
    {
        const p = page();
        p.api.playEpisode({ anime: p.state.selectedAnime, episode: '3', episodes: p.state.episodes, resumeAt: 300 });
        p.requests[0].resolve(stream(3));
        await tick();
        eq(p.played[0] && [p.played[0].playing, p.played[0].resumeAt], ['3', 300],
           'a resume that succeeds starts episode 3 at its offset');
    }
    {
        /* CONTINUE asked for A at 300s; before it answered, the user played B. */
        const p = page();
        p.api.playEpisode({ anime: p.state.selectedAnime, episode: '3', episodes: p.state.episodes, resumeAt: 300 });
        const other = { id: 'showB', title: 'Show B', titleEnglish: '', epCount: 12 };
        p.state.selectedAnime = other; p.state.selectedEpisode = '1'; p.state.episodes = ['1', '2'];
        p.api.playEpisode();
        p.requests[1].resolve(stream(1));
        await tick();
        p.requests[0].resolve(stream(3));
        await tick();
        eq(p.played.map(x => [x.playing, x.resumeAt]), [['1', 0]],
           'the other show plays from 0:00; the first show\'s offset went nowhere');
        eq(p.state.playing.anime.id, 'showB', 'and the page says show B is playing');
    }

    // ── the end of a video is not a place to resume from ────────────────────────────
    section('after an episode has ended');
    {
        const p = page();
        p.api.playEpisode();
        p.requests[0].resolve(stream(4));
        await tick();
        p.video.currentTime = 1440; p.video.ended = true;
        p.state.selectedEpisode = '5';                     // the 'ended' handler moves the selection on
        p.posts.length = 0;
        p.api.hidePlayer();
        eq(p.posts.filter(x => x.url === '/save-progress').length, 0,
           'closing the player saves nothing: not for 4, and not 4\'s end time under 5');
    }

    // ── the total sent to the server is a number or nothing ─────────────────────────
    section('the episode total sent with a play');
    {
        const p = page({ selectedAnime: { id: 'showA', title: 'Show A', titleEnglish: '', epCount: 0 } });
        p.api.playEpisode();
        eq(p.requests[0].body.total_episodes, 6, 'an unknown count is filled from the episode list (6), never "?"');
        const q = page({ selectedAnime: { id: 'showA', title: 'Show A', titleEnglish: '', epCount: '?' }, episodes: [] });
        q.state.selectedEpisode = '1';
        q.api.playEpisode();
        eq(q.requests[0].body.total_episodes, null, 'and is null when nothing is known');
    }

    // ── a film is watched at 80%, not at minute 20 ──────────────────────────────────
    section('the watched rule');
    {
        const p = page();
        p.api.playEpisode();
        p.requests[0].resolve(stream(4));
        await tick();
        p.video.duration = 7200;                           // a two hour film
        p.video.currentTime = 1300;                        // minute 21
        p.api.watchTimeHandler();
        ok(!p.posts.some(x => x.url === '/mark-watched'), 'a two hour film is not watched at minute 21');
        p.video.currentTime = 5800;                        // past 80%
        p.api.watchTimeHandler();
        ok(p.posts.some(x => x.url === '/mark-watched'), 'it is watched at 80%');
    }
    {
        const p = page();
        p.api.playEpisode();
        p.requests[0].resolve(stream(4));
        await tick();
        p.video.duration = NaN;                            // length not known
        p.video.currentTime = 1100;
        p.api.watchTimeHandler();
        ok(!p.posts.some(x => x.url === '/mark-watched'), 'with no known length, not before minute 20');
        p.video.currentTime = 1201;
        p.api.watchTimeHandler();
        ok(p.posts.some(x => x.url === '/mark-watched'), 'and at minute 20 when the length is unknown');
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.log('\n  THREW: ' + (e && e.stack || e) + '\n'); process.exit(1); });
