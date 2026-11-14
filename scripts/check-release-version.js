#!/usr/bin/env node
// YASA PRESENTS
/* check-release-version.js: every place the app states its version says the same thing.
 *
 *     node scripts/check-release-version.js            the four places agree with each other
 *     node scripts/check-release-version.js 0.8.0      ...and with this version (CI passes the tag)
 *
 * WHY THIS EXISTS. CLAUDE.md lists what a release commit has to change, and the list has
 * been missed before: v0.3.1 shipped with the old number in the page, so the installer
 * sat next to the previous version instead of replacing it and the "what is new" popup
 * never opened. The build jobs rewrite package.json from the tag, which HIDES a missed
 * bump there, and nothing rewrites the desktop page at all.
 *
 * The four places:
 *     package.json                       "version"
 *     ui/ani-mate-ui.html                const APP_VERSION = '...'
 *     ui/ani-mate-ui.html                the splash line, vX.Y.Z // YASA SYSTEMS ACTIVE
 *     mobile/www/js/ani-mate-ui.js       const APP_VERSION = '...'
 *
 * It does not, and cannot, check that the two CHANGELOG lists were written.
 * Exit 0 when they agree, 1 when they do not, with every disagreement named.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function find(file, re, what) {
    const m = read(file).match(re);
    return { where: file + ' (' + what + ')', value: m ? m[1] : null };
}

const places = [
    { where: 'package.json ("version")', value: JSON.parse(read('package.json')).version || null },
    find('ui/ani-mate-ui.html', /const APP_VERSION = '([^']*)'/, 'APP_VERSION'),
    find('ui/ani-mate-ui.html', /class="player-splash-ver">v([^\s<]+)\s*\/\//, 'the splash line'),
    find('mobile/www/js/ani-mate-ui.js', /const APP_VERSION = '([^']*)'/, 'APP_VERSION'),
];

const arg = (process.argv[2] || '').replace(/^v/, '');
if (arg && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(arg)) {
    console.error('  "' + process.argv[2] + '" is not a version (expected something like 0.8.0)');
    process.exit(1);
}
const want = arg || places[0].value;

let bad = 0;
console.log('\n  checking against ' + want + (arg ? ' (given)' : ' (package.json)') + '\n');
for (const p of places) {
    const ok = p.value === want;
    if (!ok) bad++;
    console.log('  ' + (ok ? 'ok   ' : 'WRONG') + '  ' + p.where + ': '
        + (p.value === null ? 'NOT FOUND' : p.value));
}
if (bad) {
    console.log('\n  ' + bad + ' of ' + places.length + ' do not say ' + want + '.'
        + '\n  A release changes all of them in one commit. See CLAUDE.md, "RELEASE = ONE ATOMIC COMMIT".\n');
    process.exit(1);
}
console.log('\n  all ' + places.length + ' agree\n');
