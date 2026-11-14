// YASA PRESENTS
/* budget.test.js: the request counter and the answer memory, on a clock that does not wait.
 *
 *     node tests/budget.test.js
 *
 * The limits used here are the ones measured from AllAnime on 2026-11-12 (see the header
 * of server/ani-mate-budget.js). The "source" in these tests is a function that counts
 * the way AllAnime was seen to count: N per window, then a refusal that names the
 * seconds left. Every check is about what the app must do in front of that.
 */
'use strict';
const path = require('path');
const B = require(path.join(__dirname, '..', 'server', 'ani-mate-budget.js'));

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want),
    msg + (JSON.stringify(got) === JSON.stringify(want) ? '' : '  [got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ']'));

/* A clock the test owns. sleep() moves it; nothing here waits for real. */
function clock() {
    const c = { t: 1_000_000, slept: [] };
    c.now = () => c.t;
    c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
    return c;
}

/* The source: `max` questions per fixed ten second window, then the refusal AllAnime
 * sends, with the seconds left in the window. */
function source(c, max) {
    const s = { asked: 0, answered: 0, refused: 0, windowStart: null, inWindow: 0, down: false };
    s.send = async () => {
        s.asked++;
        if (s.down) throw new Error('no answer');
        if (s.windowStart === null || c.t - s.windowStart >= 10000) { s.windowStart = c.t; s.inWindow = 0; }
        if (s.inWindow >= max) {
            s.refused++;
            const left = Math.ceil((s.windowStart + 10000 - c.t) / 1000);
            return { errors: [{ message: 'Too many requests, please try again in ' + left + ' seconds.' }], data: null };
        }
        s.inWindow++; s.answered++;
        c.t += 200;                                   // a request takes a moment
        return { data: { shows: { edges: [{ n: s.answered }] } } };
    };
    return s;
}

(async () => {
    console.log('\nwhat a refusal looks like:');
    eq(B.refusalSeconds({ errors: [{ message: 'Too many requests, please try again in 8 seconds.' }], data: null }), 8,
       'the seconds are read out of AllAnime\'s own message');
    eq(B.refusalSeconds({ errors: [{ message: 'Too many requests' }] }), 10, 'a refusal that names no number counts as ten');
    eq(B.refusalSeconds({ errors: [{ message: 'AA_CRYPTO_MISSING' }], data: { episode: null } }), 0,
       'another error is not a refusal');
    eq(B.refusalSeconds({ data: { shows: { edges: [] } } }), 0, 'an empty result is not a refusal');
    eq(B.refusalSeconds(null), 0, 'nothing is not a refusal');

    console.log('\nthe app never makes the source refuse:');
    {
        const c = clock(), src = source(c, 10);
        const b = B.create(B.ALLANIME, c);
        const got = [];
        for (let i = 0; i < 25; i++) got.push(await b.ask('shows', src.send, { need: 'user' }));
        ok(got.every((g) => g && g.data && g.data.shows), '25 searches in a row were all answered');
        eq(src.refused, 0, 'and the source refused none of them');
        ok(c.slept.length >= 2, 'because the app waited for the window to turn (' + c.slept.length + ' waits)');
    }

    console.log('\nwhat one search may spend:');
    {
        const c = clock(), src = source(c, 10);
        const b = B.create(B.ALLANIME, c);
        await b.ask('shows', src.send, { need: 'user' });                    // the query itself
        const lookups = [];
        for (let i = 0; i < 8; i++) lookups.push(await b.ask('shows', src.send, { need: 'spare' }));
        eq(lookups.filter(Boolean).length, 6, 'of eight lookups, six are asked (the window may be 7 full for them)');
        eq(lookups.filter((x) => x === null).length, 2, 'and two are not asked at all, rather than refused');
        const slept = c.slept.length;
        const second = await b.ask('shows', src.send, { need: 'user' });
        ok(second && second.data && c.slept.length === slept, 'a second search straight after is answered without waiting');
        await b.ask('shows', src.send, { need: 'user' });
        await b.ask('shows', src.send, { need: 'user' });
        eq(src.refused, 0, 'and a third and a fourth, with no refusal');
        eq(await b.ask('shows', src.send, { need: 'spare' }), null, 'a lookup now is skipped: nothing to spare');
    }

    console.log('\nsomeone else spent the budget (a phone on the same network):');
    {
        const c = clock(), src = source(c, 10);
        const b = B.create(B.ALLANIME, c);
        src.windowStart = c.t; src.inWindow = 10;                            // the source's window is already full
        const a = await b.ask('shows', src.send, { need: 'user' });
        ok(a && a.data && a.data.shows, 'the search is still answered');
        eq(src.refused, 1, 'after one refusal');
        ok(c.slept.some((ms) => ms >= 10000 && ms <= 10400), 'and a wait of the seconds the source named (' + JSON.stringify(c.slept) + ')');
        let threw = null;
        src.inWindow = 10; src.windowStart = c.t;
        try { await b.ask('shows', src.send, { need: 'spare' }); } catch (e) { threw = e; }
        ok(threw instanceof B.Refused, 'a spare lookup that is refused gives up at once');
        const before = src.asked;
        eq(await b.ask('shows', src.send, { need: 'spare' }), null, 'and the next spare lookup is not even sent while the source is resting');
        eq(src.asked, before, '(no request was made)');
    }

    console.log('\nthe source keeps refusing:');
    {
        const c = clock();
        let asked = 0;
        const always = async () => { asked++; return { errors: [{ message: 'Too many requests, please try again in 9 seconds.' }] }; };
        const b = B.create(B.ALLANIME, c);
        let threw = null;
        const t0 = c.t;
        try { await b.ask('shows', always, { need: 'user' }); } catch (e) { threw = e; }
        ok(threw instanceof B.Refused, 'the search gives up with a refusal, so the caller can ask another source');
        ok(asked === 2, 'after asking twice (' + asked + ')');
        ok(c.t - t0 <= 12500, 'and inside its patience of 12 seconds (' + (c.t - t0) + ' ms)');
    }

    console.log('\nno answer at all:');
    {
        const c = clock(), src = source(c, 10);
        const b = B.create(B.ALLANIME, c);
        src.down = true;
        let threw = null;
        try { await b.ask('shows', src.send, { need: 'user' }); } catch (e) { threw = e; }
        ok(threw && threw.message === 'no answer' && src.asked === 2, 'a search asks once more, then reports the failure (' + src.asked + ' requests)');
        const before = src.asked;
        eq(await b.ask('shows', src.send, { need: 'spare' }), null,
           'and for the next half minute the spare lookups do not ask a source that is not answering');
        eq(src.asked, before, '(no request was made)');
        c.t += 31000;
        threw = null;
        try { await b.ask('shows', src.send, { need: 'spare' }); } catch (e) { threw = e; }
        ok(threw && src.asked === before + 1, 'after that a spare lookup asks once, and does not ask again when it fails');
        src.down = false;
        const back = await b.ask('shows', src.send, { need: 'user' });
        ok(back && back.data, 'a search is always asked, and is answered the moment the source is back');
    }

    console.log('\nepisode lists have their own count:');
    {
        const c = clock(), shows = source(c, 10), show = source(c, 6);
        const b = B.create(B.ALLANIME, c);
        for (let i = 0; i < 10; i++) await b.ask('shows', shows.send, { need: 'user' });
        const slept = c.slept.length;
        const ep = await b.ask('show', show.send, { need: 'user' });
        ok(ep && c.slept.length === slept, 'with search used up, an episode list is asked at once');
        for (let i = 0; i < 12; i++) await b.ask('show', show.send, { need: 'user' });
        eq(show.refused, 0, '13 episode lists in a row, none refused');
    }

    console.log('\nAniList: thirty a minute, and it says how many are left:');
    {
        const c = clock();
        let asked = 0;
        const send = async () => { asked++; return { data: { ok: true } }; };
        const b = B.create(B.ANILIST, { now: c.now, sleep: c.sleep, patienceMs: 5000 });
        const spare = [];
        for (let i = 0; i < 25; i++) spare.push(await b.ask('anilist', send, { need: 'spare' }));
        eq(spare.filter(Boolean).length, 20, 'spare lookups stop at twenty in a minute');
        for (let i = 0; i < 10; i++) await b.ask('anilist', send, { need: 'user' });
        eq(asked, 30, 'which leaves ten for what someone is waiting on');
        let threw = null;
        try { await b.ask('anilist', send, { need: 'user' }); } catch (e) { threw = e; }
        ok(threw instanceof B.Refused && asked === 30,
           'the 31st is not sent, and is refused here at once rather than waited on for a minute');
        c.t += 61500;
        ok((await b.ask('anilist', send, { need: 'user' })) && asked === 31, 'a minute later it is asked again');
    }
    {
        const c = clock();
        let asked = 0;
        const send = async () => { asked++; return { data: { ok: true } }; };
        const b = B.create(B.ANILIST, { now: c.now, sleep: c.sleep, patienceMs: 5000 });
        await b.ask('anilist', send, { need: 'user' });
        b.note('anilist', { limit: 30, remaining: 4 });          // the page and the phone spent the rest
        eq(await b.ask('anilist', send, { need: 'spare' }), null, 'told that 4 of 30 are left, a spare lookup is not sent');
        ok((await b.ask('anilist', send, { need: 'user' })) && asked === 2, 'and a search still is');
        b.note('anilist', { limit: 90, remaining: 80 });
        eq([b._state.anilist.max, b._state.anilist.spare], [90, 60], 'a different limit in the header moves both lines (90 and 60)');
        b.note('anilist', { remaining: undefined });
        b.note('nothing', { remaining: 1 });
        ok(true, 'a missing header and an unknown budget are ignored');
    }

    console.log('\nthe memory of answers:');
    {
        const c = clock();
        const m = B.memo({ ttlMs: 300000, emptyTtlMs: 120000, keep: 3, now: c.now });
        eq(m.recall('a'), null, 'nothing remembered is null, not an empty list');
        const rows = [{ id: 'x', name: 'X' }];
        m.remember('a', rows);
        rows[0].name = 'changed after';
        const out = m.recall('a');
        eq(out, [{ id: 'x', name: 'X' }], 'what went in comes out');
        out[0].name = 'changed by the caller';
        eq(m.recall('a'), [{ id: 'x', name: 'X' }], 'and a caller writing on its copy does not change the memory');
        c.t += 299000;
        ok(m.recall('a') !== null, 'still there at 4:59');
        c.t += 2000;
        eq(m.recall('a'), null, 'gone at 5:01');
        m.remember('none', []);
        eq(m.recall('none'), [], 'an empty answer is remembered as an answer');
        c.t += 121000;
        eq(m.recall('none'), null, 'for two minutes');
        m.remember('1', rows); m.remember('2', rows); m.remember('3', rows); m.remember('4', rows);
        ok(m.recall('1') === null && m.recall('4') !== null && m.size === 3, 'and it keeps the newest three');
    }

    console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
    process.exit(fails ? 1 : 0);
})();
