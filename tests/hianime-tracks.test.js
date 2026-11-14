// YASA PRESENTS
/* hianime-tracks.test.js: WHICH subtitle track an episode is played with.
 *
 *     node tests/hianime-tracks.test.js          offline; the host is a stand-in below
 *
 * server/hianime-at.js is handed a fetch function, so the whole chain runs here against
 * canned answers shaped like the host's: a search page, an episode list, a server list,
 * the two kinds of embed page, and subtitle files.
 *
 * WHY IT EXISTS. "The subtitles are gone" has been reported for this app five times, and
 * each time a track was loaded and showing. The fault was always WHICH track. On
 * 2026-11-14 it was an episode whose first English track is 13 signs, whose own servers
 * list the real subtitles further down under the same label, and which was played with a
 * machine transcript of the English dub from the other mode's servers: nothing on screen
 * before 1:54. Every case below is one of those choices, with the requests counted so a
 * fix cannot quietly start fetching more than it needs on an episode that was fine.
 */
'use strict';
process.env.ANI_MATE_HIANIME = 'https://hi.test';
const { makeProvider } = require('../server/hianime-at');

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); } else { fails++; console.log('  FAIL  ' + msg); } };
const section = (t) => console.log('\n' + t + ':');

const KEY = Buffer.from('otaku-embed-v1');
const scramble = (obj) => {
    const raw = Buffer.from(JSON.stringify(obj), 'utf8');
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ KEY[i % KEY.length];
    return out.toString('base64');
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const vtt = (n) => 'WEBVTT\n\n' + Array.from({ length: n }, (_, i) =>
    '00:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + '.000 --> 00:'
    + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + '.900\nline ' + (i + 1)).join('\n\n') + '\n';

/** A stand-in host for ONE episode of one show.
 *  own:   the English tracks the SUB servers list, in order: ZokoAnime's, then HD-1's
 *  other: what the DUB servers list
 *  files: address -> number of cues, or 'broken' */
function site({ zoko, hd1, dub, files }) {
    const asked = [];
    const answers = {
        'https://hi.test/api/theme/episode/list/100': JSON.stringify({ html: '<a data-number="1" data-id="5001"></a>' }),
        'https://hi.test/api/theme/episode/servers?episodeId=5001': JSON.stringify({ html:
            '<div data-type="sub" data-server-name="ZokoAnime" data-hash="' + b64('https://zoko.test/e/sub') + '"></div>'
            + '<div data-type="sub" data-server-name="HD-1" data-hash="' + b64('https://mega.test/stream/s-2/777/sub') + '"></div>'
            + '<div data-type="dub" data-server-name="ZokoAnime" data-hash="' + b64('https://zoko.test/e/dub') + '"></div>' }),
        'https://zoko.test/e/sub': '<script>window.__P="' + scramble({ src: 'https://cdn.test/sub/master.m3u8', subtitles: zoko }) + '"</script>',
        'https://zoko.test/e/dub': '<script>window.__P="' + scramble({ src: 'https://cdn.test/dub/master.m3u8', subtitles: dub }) + '"</script>',
        'https://mega.test/stream/s-2/777/sub': '<div id="player" data-id="777"></div>',
        'https://mega.test/stream/getSources?id=777': JSON.stringify({ tracks: hd1.concat([{ file: 'https://subs.test/thumbs.vtt', kind: 'thumbnails' }]) }),
    };
    const afetch = async (url) => {
        asked.push(url);
        if (/^https:\/\/hi\.test\/search\?keyword=/.test(url)) {
            return { status: 200, body: '<h3 class="film-name"> <a href="/watch/show-one-100" title="Show One">Show One</a></h3><div id="main-sidebar"></div>' };
        }
        if (Object.prototype.hasOwnProperty.call(files, url)) {
            if (files[url] === 'broken') throw new Error('connection reset');
            return { status: 200, body: vtt(files[url]) };
        }
        if (Object.prototype.hasOwnProperty.call(answers, url)) return { status: 200, body: answers[url] };
        return { status: 404, body: '' };
    };
    return { afetch, asked, count: (re) => asked.filter((u) => re.test(u)).length };
}
const SIGNS = { lang: 'en', label: 'English', src: 'https://cdn.test/sub/signs.vtt', default: true };
const AI = { lang: 'en', label: 'English (AI)', src: 'https://cdn.test/dub/ai.vtt', default: true };
const flags = (list) => list.filter((s) => s.default).map((s) => s.label).join(',');

(async () => {
    // ── the case of 2026-11-14 ─────────────────────────────────────────────────────
    section('the first English track is signs, and the episode\'s own servers list the real one further down');
    {
        const s = site({
            zoko: [SIGNS],
            hd1: [{ file: 'https://subs.test/ar.vtt', label: 'Arabic' }, { file: 'https://subs.test/full.vtt', label: 'English' },
                  { file: 'https://subs.test/dub-script.vtt', label: 'English 2' }, { file: 'https://subs.test/cc.vtt', label: 'English 3' },
                  { file: 'https://subs.test/signs4.vtt', label: 'English 4' }],
            dub: [AI],
            files: { 'https://cdn.test/sub/signs.vtt': 13, 'https://subs.test/full.vtt': 329, 'https://subs.test/dub-script.vtt': 382,
                     'https://subs.test/cc.vtt': 442, 'https://subs.test/signs4.vtt': 13, 'https://cdn.test/dub/ai.vtt': 372 },
        });
        const got = await makeProvider(s.afetch).streamByTitle('Show One', 1, 'sub');
        const first = got && got.subtitles && got.subtitles[0];
        ok(!!got && got.url === 'https://cdn.test/sub/master.m3u8', 'the sub stream is what plays');
        ok(!!first && first.src === 'https://subs.test/full.vtt' && first.label === 'English', 'the track put first is the episode\'s own full English one: ' + (first && first.src));
        ok(!!first && first.default === true && flags(got.subtitles) === 'English' && got.subtitles.filter((x) => x.default).length === 1,
           'it alone carries the flag the player breaks ties on (the signs track lost it)');
        ok(first && first.referer === 'https://mega.test/', 'with the referer its own host wants: ' + (first && first.referer));
        ok(got.subsQuality === 'dialogue' && got.subsCues === 329, 'the stream is marked as having a script, 329 cues (' + got.subsQuality + ', ' + got.subsCues + ')');
        ok(!got.subtitles.some((x) => /dub server/.test(x.label)), 'no track from the dub servers is in the list');
        ok(s.count(/zoko\.test\/e\/dub/) === 0 && s.count(/cdn\.test\/dub/) === 0, 'and the dub servers were never asked');
        ok(s.count(/subs\.test\/(dub-script|cc|signs4|ar)\.vtt/) === 0, 'nor any track after the first full one');
        ok(got.subtitles.length === 6, 'every other track is still offered (' + got.subtitles.length + ' in all)');
    }

    section('none of its own English tracks is a script: the other mode\'s servers are asked, as before');
    {
        const s = site({
            zoko: [SIGNS], hd1: [{ file: 'https://subs.test/signs4.vtt', label: 'English 4' }, { file: 'https://subs.test/fr.vtt', label: 'French' }], dub: [AI],
            files: { 'https://cdn.test/sub/signs.vtt': 7, 'https://subs.test/signs4.vtt': 7, 'https://cdn.test/dub/ai.vtt': 336 },
        });
        const got = await makeProvider(s.afetch).streamByTitle('Show One', 1, 'sub');
        const first = got.subtitles[0];
        ok(first.src === 'https://cdn.test/dub/ai.vtt' && /\(dub server\)$/.test(first.label), 'the dub servers\' track is used and says where it is from: "' + first.label + '"');
        ok(first.default === true && got.subtitles.filter((x) => x.default).length === 1, 'and it alone is flagged');
        ok(got.subsQuality === 'dialogue' && got.subsCues === 336, 'marked as a script, 336 cues');
        ok(got.url === 'https://cdn.test/sub/master.m3u8', 'over the SUB stream: only the track is borrowed');
    }

    section('the first English track is a script: nothing else is fetched');
    {
        const s = site({
            zoko: [{ lang: 'en', label: 'English', src: 'https://cdn.test/sub/full.vtt', default: true }],
            hd1: [{ file: 'https://subs.test/full.vtt', label: 'English' }, { file: 'https://subs.test/dub-script.vtt', label: 'English 2' }], dub: [AI],
            files: { 'https://cdn.test/sub/full.vtt': 300, 'https://subs.test/full.vtt': 300, 'https://subs.test/dub-script.vtt': 350, 'https://cdn.test/dub/ai.vtt': 372 },
        });
        const got = await makeProvider(s.afetch).streamByTitle('Show One', 1, 'sub');
        ok(got.subtitles[0].src === 'https://cdn.test/sub/full.vtt' && got.subsCues === 300, 'it is played with that track (300 cues)');
        ok(s.count(/subs\.test\//) === 0 && s.count(/zoko\.test\/e\/dub/) === 0, 'no other subtitle file and no dub server was asked for');
        ok(got.subtitles.length === 3 && got.subtitles[0].default === true, 'the list is as the host gave it');
    }

    section('its first full sibling cannot be read: the next one is taken');
    {
        const s = site({
            zoko: [SIGNS], hd1: [{ file: 'https://subs.test/full.vtt', label: 'English' }, { file: 'https://subs.test/dub-script.vtt', label: 'English 2' }], dub: [AI],
            files: { 'https://cdn.test/sub/signs.vtt': 13, 'https://subs.test/full.vtt': 'broken', 'https://subs.test/dub-script.vtt': 382, 'https://cdn.test/dub/ai.vtt': 372 },
        });
        const got = await makeProvider(s.afetch).streamByTitle('Show One', 1, 'sub');
        ok(got.subtitles[0].src === 'https://subs.test/dub-script.vtt' && got.subsCues === 382, 'a track that will not load is passed over for the next script: "' + got.subtitles[0].label + '"');
        ok(s.count(/zoko\.test\/e\/dub/) === 0, 'still without asking the dub servers');
    }

    section('a plain English track is preferred to one for the hard of hearing, and a forced one is never taken');
    {
        const s = site({
            zoko: [SIGNS],
            hd1: [{ file: 'https://subs.test/forced.vtt', label: 'English (Forced)' }, { file: 'https://subs.test/sdh.vtt', label: 'English (SDH)' },
                  { file: 'https://subs.test/full.vtt', label: 'English' }], dub: [AI],
            files: { 'https://cdn.test/sub/signs.vtt': 13, 'https://subs.test/forced.vtt': 60, 'https://subs.test/sdh.vtt': 400, 'https://subs.test/full.vtt': 329, 'https://cdn.test/dub/ai.vtt': 372 },
        });
        const got = await makeProvider(s.afetch).streamByTitle('Show One', 1, 'sub');
        ok(got.subtitles[0].src === 'https://subs.test/full.vtt', 'the plain one is shown though the SDH one is listed first: "' + got.subtitles[0].label + '"');
        ok(s.count(/forced\.vtt/) === 0, 'and the forced one was not even counted');
    }

    section('the same rule when the DUB is what is being watched');
    {
        const s = site({
            zoko: [{ lang: 'en', label: 'English', src: 'https://cdn.test/sub/full.vtt', default: true }], hd1: [],
            dub: [{ lang: 'en', label: 'English', src: 'https://cdn.test/dub/signs.vtt', default: true }, { lang: 'en', label: 'English (AI)', src: 'https://cdn.test/dub/ai.vtt' }],
            files: { 'https://cdn.test/dub/signs.vtt': 9, 'https://cdn.test/dub/ai.vtt': 372, 'https://cdn.test/sub/full.vtt': 300 },
        });
        const got = await makeProvider(s.afetch).streamByTitle('Show One', 1, 'dub');
        ok(got.url === 'https://cdn.test/dub/master.m3u8' && got.subtitles[0].src === 'https://cdn.test/dub/ai.vtt' && got.subsCues === 372,
           'the dub\'s own second English track is used: "' + got.subtitles[0].label + '"');
        ok(s.count(/zoko\.test\/e\/sub/) === 0, 'and the sub servers were not asked');
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('  THREW ' + (e && e.stack || e)); process.exit(1); });
