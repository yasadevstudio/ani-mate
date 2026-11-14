#!/usr/bin/env node
/* YASA PRESENTS
 *
 * verify-shared.js -- every file that exists in more than one place must be identical.
 *
 *     npm run sync:verify              (exits non-zero on drift)
 *     node scripts/verify-shared.js --release   (also fails when the APK copy is absent)
 *
 * ⛔ WHY THIS IS A RELEASE GATE AND NOT A NICETY. Two platforms that disagree about
 * shared code do not produce a broken half; they produce two devices that behave
 * differently on the same data. For the sync engine that means two devices disagreeing
 * about what the user deleted. For the franchise module it means the same library
 * grouped two different ways, which is the bug reported on 2026-11-09.
 *
 * ⛔ AND IT CHECKS THE WHOLE PAGE, NOT TWO FILES. On 2026-11-12 this passed, "4 copies
 * compared, 0 problems", while the APK's copy of index.html was five days old and did
 * not load the sync engine, the franchise module or the sync panel at all. It compared
 * the two shared files and never looked at the page that loads them. A gate that checks
 * part of what it is believed to cover is the check that passes without testing the
 * thing. So: the two shared engines against their phone copies, and then EVERY file
 * under mobile/www against the APK copy, in both directions.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = ['ani-mate-sync.js', 'ani-mate-franchise.js', 'ani-mate-budget.js'];
const WWW = path.join(ROOT, 'mobile', 'www');
const PUB = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'assets', 'public');
const SKIP = (name) => /\.bak-/.test(name);
const GENERATED = new Set(['cordova.js', 'cordova_plugins.js']);
const strict = process.argv.includes('--release');

function walk(dir, base = dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, base, out);
        else if (e.isFile()) out.push(path.relative(base, full));
    }
    return out;
}

let problems = 0, checked = 0;
const bad = (msg) => { console.error(msg + '  -- run `npm run sync:shared`'); problems++; };

function same(a, b, label) {
    checked++;
    const x = fs.readFileSync(a), y = fs.readFileSync(b);
    if (Buffer.compare(x, y) !== 0) {
        bad('DRIFT: ' + label + '  (' + y.length + ' vs ' + x.length + ' bytes)');
        return false;
    }
    return true;
}

// 1. the shared engines, source against the phone's copy
for (const f of SHARED) {
    const src = path.join(ROOT, 'server', f), copy = path.join(WWW, 'js', f);
    if (!fs.existsSync(src)) { bad('MISSING SOURCE: server/' + f); continue; }
    if (!fs.existsSync(copy)) { bad('MISSING: mobile/www/js/' + f); continue; }
    if (same(src, copy, 'mobile/www/js/' + f + ' != server/' + f)) console.log('  identical  mobile/www/js/' + f);
}

// 2. the phone's page, every file, against what the APK will ship
if (!fs.existsSync(PUB)) {
    /* Build output, not in git, so legitimately absent on a clean checkout. */
    if (strict) bad('MISSING: the APK asset folder ' + path.relative(ROOT, PUB));
    else console.log('  (absent, build output) ' + path.relative(ROOT, PUB));
} else {
    const wanted = walk(WWW).filter((rel) => !SKIP(rel));
    let pageOk = 0;
    for (const rel of wanted) {
        const copy = path.join(PUB, rel);
        if (!fs.existsSync(copy)) { bad('MISSING IN APK: ' + rel); continue; }
        if (same(path.join(WWW, rel), copy, 'APK copy of ' + rel + ' != mobile/www/' + rel)) pageOk++;
    }
    const keep = new Set(wanted);
    for (const rel of walk(PUB)) {
        if (keep.has(rel) || GENERATED.has(rel)) continue;
        bad('STALE IN APK (not in mobile/www): ' + rel);
    }
    console.log('  identical  ' + pageOk + ' of ' + wanted.length + ' page files in the APK copy');
}

console.log('\n' + checked + ' files compared, ' + problems + ' problem(s)'
    + (strict ? '  [--release: the APK copy is required]' : ''));
process.exit(problems ? 1 : 0);
