// YASA PRESENTS
/* notes.test.js: a release's notes as the phone's update box shows them.
 *
 *     node tests/notes.test.js
 *
 * The box showed the first 300 characters of the release page's text as typed, so a phone
 * read "## The right subtitles" and stopped in the middle of a sentence (seen 2026-11-14).
 * mobile/www/js/ani-mate-notes.js takes the marks off and cuts where a thought ends. This
 * holds down three things: what comes off, what must be left alone, and where it stops.
 *
 * The notes arrive over the network. Nothing in them may become an element, so the
 * function returns a string and HTML comes out as the characters that were typed.
 */
'use strict';
const path = require('path');
const N = require(path.join(__dirname, '..', 'mobile', 'www', 'js', 'ani-mate-notes.js'));

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ok    ' + msg); }
                            else { fails++; console.log('  FAIL  ' + msg); } };
const eq = (got, want, msg) => ok(got === want,
    msg + (got === want ? '' : '  [got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ']'));
const section = (t) => console.log('\n' + t);

section('the marks a release page draws come off');
eq(N.plain('## The right subtitles'), 'The right subtitles', 'a heading loses its hashes');
eq(N.plain('# One\n\n### Three'), 'One\n\nThree', 'at any depth');
eq(N.plain('- one\n* two\n+ three'), '• one\n• two\n• three', 'list items get a dot, whichever mark they were typed with');
eq(N.plain('- [x] done\n- [ ] not yet'), '• done\n• not yet', 'a ticked list loses its boxes');
eq(N.plain('- outer\n  - inner'), '• outer\n  • inner', 'an item inside an item keeps its place');
eq(N.plain('The **SYNC** button and *this* one'), 'The SYNC button and this one', 'bold and slanted words lose their stars');
eq(N.plain('- **No email, no password.** You get a key.'), '• No email, no password. You get a key.', 'an item that opens in bold is still an item');
eq(N.plain('__bold__ and _slanted_'), 'bold and slanted', 'the underscore spellings too');
eq(N.plain('***both***'), 'both', 'and three stars');
eq(N.plain('run `npm test` now'), 'run npm test now', 'code loses its ticks');
eq(N.plain('see [the page](https://example.test/x) for more'), 'see the page for more', 'a link is its words');
eq(N.plain('![a poster](https://example.test/p.png)'), 'a poster', 'a picture is its description');
eq(N.plain('> quoted words'), 'quoted words', 'a quoted line loses its mark');
eq(N.plain('one\n\n---\n\ntwo'), 'one\n\ntwo', 'a ruled line says nothing');
eq(N.plain('Title\n=====\n\ntext'), 'Title\n\ntext', 'nor does an underline');
eq(N.plain('## A\r\n\r\ntext\r\n'), 'A\n\ntext', 'Windows line ends are line ends');
eq(N.plain('\n\na\n\n\n\nb\n\n'), 'a\n\nb', 'one blank line between things, none at either end');

section('what it must leave alone');
for (const same of ['5 * 3 * 2 = 30', 'the file is my_file_name.txt', 'issue #12, C# and #1', '2 - 1 = 1',
                    'a line with * one star', 'half **open', 'v0.7.2 -> v0.7.3', 'Posters are 36x50.']) {
    eq(N.plain(same), same, JSON.stringify(same));
}
const html = 'Fixed things.\n<img src="x" onerror="window.__ran=1"> <b>bold</b>';
eq(N.plain(html), html, 'HTML comes out as the characters that were typed');
ok(typeof N.plain(html) === 'string', 'and what comes back is a string, never an element');
eq(N.plain('```\n## not a heading\n- not an item\n```\nafter'), '## not a heading\n- not an item\nafter', 'what is inside a code block is left as typed');

section('nothing to show');
for (const [v, name] of [[null, 'null'], [undefined, 'undefined'], ['', 'an empty string'], ['  \n\n \n', 'only blank lines'], ['---', 'only a ruled line']]) {
    eq(N.plain(v, 300), '', name + ' gives an empty string');
}
eq(N.plain(42, 300), '42', 'and something that is not text is shown as text');

section('where it stops');
const LONG = '## The right subtitles\n\nSome episodes were being shown the wrong English track.\n\n'
    + 'When an episode\'s first English track holds only on-screen signs, ANI-MATE went to the dub\'s servers and used '
    + 'a transcript of the English dub instead. On some episodes that put nothing on screen for the first two minutes. '
    + 'It now looks at the other English tracks the same servers list first.';
const whole = N.plain(LONG);
eq(N.plain(LONG, 0), whole, 'no limit, the whole text');
eq(N.plain(LONG, 5000), whole, 'a limit it fits in, the whole text');
{
    const got = N.plain(LONG, 300);
    ok(got.length <= 300, 'cut to the limit (' + got.length + ' of 300)');
    ok(whole.startsWith(got), 'what is kept is the start of the text, unchanged');
    ok(/\.$/.test(got) && /^\s/.test(whole.slice(got.length)), 'and it stops at the end of a sentence: ' + JSON.stringify(got.slice(-42)));
    ok(got.length >= 120, 'the last one that fits, not the first (' + got.length + ' characters kept)');
    ok(!/…/.test(got), 'with no mark, because nothing was cut mid-thought');
}
{
    const list = ['## What changed', ''].concat(Array.from({ length: 12 }, (_, i) => '- item number ' + (i + 1) + ' of the list, with no full stop')).join('\n');
    const got = N.plain(list, 200);
    const lines = got.split('\n');
    ok(got.length <= 200 && /^• item number \d+ of the list, with no full stop$/.test(lines[lines.length - 1]),
       'a list stops at the end of an item: ' + JSON.stringify(lines[lines.length - 1]));
}
{
    const run = Array.from({ length: 90 }, (_, i) => 'word' + i).join(' ');
    const got = N.plain(run, 300);
    ok(got.length <= 300 && /…$/.test(got), 'with no sentence or line end in reach it stops between two words and says so (' + got.length + ' of 300)');
    const last = got.replace(/…$/, '').split(' ').pop();
    ok(run.split(' ').includes(last), 'the last word is a whole word: ' + JSON.stringify(last));
}
{
    const early = 'Short. ' + Array.from({ length: 90 }, (_, i) => 'word' + i).join(' ');
    const got = N.plain(early, 300);
    ok(got.length > 120 && /…$/.test(got), 'a sentence that ends in the first few words is not where it stops (' + got.length + ' kept)');
}
{
    const exact = 'A'.repeat(98) + '. ' + 'B'.repeat(300);
    eq(N.plain(exact, 99), 'A'.repeat(98) + '.', 'a sentence that ends exactly at the limit is kept whole');
}
{
    const dangling = 'The first part is here, and it is long enough to be worth keeping on its own for anyone reading it.\n\n'
        + '## The next part\n\n' + Array.from({ length: 90 }, (_, i) => 'word' + i).join(' ');
    const got = N.plain(dangling, 150);
    eq(got, 'The first part is here, and it is long enough to be worth keeping on its own for anyone reading it.',
       'a heading left with nothing under it is taken off the end');
}
{
    const marked = '**' + 'bold words '.repeat(20).trim() + '**';
    const got = N.plain(marked, 5000);
    eq(got.length, marked.length - 4, 'the limit counts what is shown, not the marks');
}

section('the notes of the last three releases, the way they open');
for (const [tag, body, first] of [
    ['v0.7.3', '## The right subtitles\n\nSome episodes were being shown the wrong English track.\n', 'The right subtitles'],
    ['v0.7.2', '## Sync across your devices\n\nFavorites, watch history and your exact resume position now stay the same on the desktop and the phone.\n\n'
        + '- ANI-MATE asks you once, on first launch, whether you want sync on. Say no and nothing changes. The **SYNC** button is there whenever you change your mind.\n'
        + '- **No email, no password, no username.** You get a recovery key to write down.\n', 'Sync across your devices'],
    ['v0.7.1', '## The browse screen\n\nIt was built like a monitoring dashboard. Now it is a full-width poster wall.\n\n'
        + '- Posters are **more than twice the size**.\n- Each card shows the **year, the format and its genres**.\n', 'The browse screen'],
]) {
    const got = N.plain(body, 300);
    ok(got.split('\n')[0] === first && !/(^|\n)#{1,6} |\*\*|(^|\n)- /.test(got),
       tag + ' opens with "' + first + '" and has no hashes, stars or dashes left');
}

console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
process.exit(fails ? 1 : 0);
