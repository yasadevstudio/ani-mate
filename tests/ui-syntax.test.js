/* Does the shipped UI actually PARSE?
 *
 *     node tests/ui-syntax.test.js
 *
 * ⛔ WHY A SYNTAX TEST IS WORTH A FILE. On 2026-11-09 the franchise logic was extracted
 * into server/ani-mate-franchise.js and the UI's own copies were replaced by one-line
 * delegations. Two of the originals sat outside the replaced span and survived, so the
 * page carried
 *
 *     const seasonLabel = ...        and   function seasonLabel(...)
 *     const franchiseSiblings = ...  and   function franchiseSiblings(...)
 *
 * which is a hard SyntaxError: the page would not have run AT ALL. No unit test can see
 * that, because a file that does not parse cannot be imported to be tested.
 *
 * ⚠ AND IT WAS MASKED FOR SEVERAL STEPS BY A CHECK THAT PASSED ON NOTHING. The helper
 * that pulled the inline script out of the HTML wrote one file per <script> tag, and the
 * four `<script src=...>` tags produce EMPTY files; adding a tag shifted the numbering
 * and `node --check` ran against a 0-byte file. An empty file is valid JavaScript, so it
 * passed, and "UI parses" was said about a page that did not. This file therefore refuses
 * to check a block it would be meaningless to check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok    ' + m); }
                       else { fails++; console.log('  FAIL  ' + m); } };

function parses(code, label) {
    try { new vm.Script(code, { filename: label }); return null; }
    catch (e) { return e.message; }
}

/* ── the desktop page's inline script ───────────────────────────────────────────── */
const html = fs.readFileSync(path.join(ROOT, 'ui', 'ani-mate-ui.html'), 'utf8');
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const bodies = blocks.filter(b => b.trim().length > 0);

console.log('\nui/ani-mate-ui.html: ' + blocks.length + ' <script> tags, '
    + bodies.length + ' with a body');
ok(bodies.length >= 1, 'at least one script block has a body');

const main = bodies.reduce((a, b) => (b.length > a.length ? b : a), '');
/* The real inline block is ~165 KB. A threshold here is what stops this file from ever
 * reporting a pass on an empty extraction again. */
ok(main.length > 50000, 'the main block is ' + main.length
    + ' bytes — large enough to be the real one, not an empty src= tag');
const err = parses(main, 'ani-mate-ui.html inline script');
ok(!err, 'the desktop UI parses' + (err ? ': ' + err : ''));

/* ── no duplicate top-level declaration ────────────────────────────────────────── */
/* Indentation is the scope proxy: the page's top level is one IIFE at 4 spaces, so a
 * name declared twice at exactly 4 spaces is a collision. Anything deeper is a local. */
function topLevelNames(src) {
    const seen = new Map();
    const re = /^ {4}(?:(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=)/gm;
    let m;
    while ((m = re.exec(src))) {
        const n = m[1] || m[2];
        const line = src.slice(0, m.index).split('\n').length;
        if (!seen.has(n)) seen.set(n, []);
        seen.get(n).push(line);
    }
    return seen;
}
for (const [label, src] of [['ui/ani-mate-ui.html', main],
                            ['mobile/www/js/ani-mate-ui.js',
                             fs.readFileSync(path.join(ROOT, 'mobile/www/js/ani-mate-ui.js'), 'utf8')]]) {
    const dups = [...topLevelNames(src)].filter(([, lines]) => lines.length > 1);
    ok(dups.length === 0, label + ': no name declared twice at the top level'
        + (dups.length ? ' — ' + dups.map(([n, l]) => n + ' @ ' + l.join(',')).join('; ') : ''));
}

/* ── every other shipped JS file ────────────────────────────────────────────────── */
const FILES = ['server/ani-mate-franchise.js', 'server/ani-mate-sync.js',
               'server/ani-mate-server.js', 'mobile/www/js/ani-mate-ui.js',
               'mobile/www/js/ani-mate-sync.js', 'scripts/verify-shared.js',
               'tests/lift-js.js'];
console.log('');
for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { ok(false, 'missing: ' + f); continue; }
    const e = parses(fs.readFileSync(p, 'utf8'), f);
    ok(!e, f + ' parses' + (e ? ': ' + e : ''));
}

/* ── the shared module really is loadable and complete ─────────────────────────── */
const FR = require(path.join(ROOT, 'server', 'ani-mate-franchise.js'));
console.log('');
for (const n of ['franchiseName', 'franchiseBase', 'seasonOrdinal', 'seasonLabel',
                 'isSeasonSpine', 'sortSeasons', 'franchiseIndex', 'groupFranchises',
                 'siblingsOf']) {
    ok(typeof FR[n] === 'function', 'ani-mate-franchise.js exports ' + n + '()');
}

/* ── and both pages actually LOAD it ───────────────────────────────────────────── */
ok(/<script src="\/ani-mate-franchise\.js">/.test(html),
   'ui/ani-mate-ui.html has the <script> tag for it — without it FR falls back and '
   + 'franchise features switch off');
const mi = fs.readFileSync(path.join(ROOT, 'mobile/www/index.html'), 'utf8');
ok(/<script src="js\/ani-mate-franchise\.js">/.test(mi),
   'mobile/www/index.html has the <script> tag for it');
const srv = fs.readFileSync(path.join(ROOT, 'server/ani-mate-server.js'), 'utf8');
ok(srv.includes("pathname === '/ani-mate-franchise.js'"),
   'server/ani-mate-server.js serves it — a page asking for a route the server does not '
   + 'have gets a 404 and silently loses the feature');

console.log('\n  ' + passes + ' passing, ' + fails + ' failing\n');
process.exit(fails ? 1 : 0);
