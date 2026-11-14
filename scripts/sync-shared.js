#!/usr/bin/env node
// YASA PRESENTS
/* sync-shared.js -- put every copy where it has to be.
 *
 *     npm run sync:shared
 *
 * Two copies exist because two platforms need real files:
 *
 *   1. server/ani-mate-sync.js and server/ani-mate-franchise.js are the shared engines.
 *      The desktop serves them out of server/; the phone needs them inside mobile/www/js/.
 *   2. mobile/www/ is the phone's page. The APK ships the copy of it under
 *      mobile/android/app/src/main/assets/public/, which is build output and not in git.
 *
 * ⛔ THIS USED TO BE ONE LINE OF `cp` IN package.json AND IT WAS WRONG THREE WAYS.
 * Measured 2026-11-12:
 *   - it copied js/*.js and css/*.css and NOT index.html, so the APK copy of the page was
 *     still the one from 2026-11-07, without the <script> tags for the sync engine, the
 *     franchise module and the sync panel. A locally built APK had no sync at all.
 *   - it ended in `|| true`, so a failed copy anywhere in the chain exited 0.
 *   - `npm run sync:verify` compared two files and passed through all of it.
 * This copies the WHOLE page, removes what is no longer in it, and exits non-zero on any
 * failure. scripts/verify-shared.js checks the same whole tree.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = ['ani-mate-sync.js', 'ani-mate-franchise.js', 'ani-mate-budget.js'];
const WWW = path.join(ROOT, 'mobile', 'www');
const PUB = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'assets', 'public');

/* Working backups (`*.bak-*`) are never part of the app. Capacitor writes these two into
 * the asset folder itself; they are not ours to remove. */
const SKIP = (name) => /\.bak-/.test(name);
const GENERATED = new Set(['cordova.js', 'cordova_plugins.js']);

function walk(dir, base = dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, base, out);
        else if (e.isFile()) out.push(path.relative(base, full));
    }
    return out;
}

let copied = 0, removed = 0, same = 0;
function put(from, to) {
    const a = fs.readFileSync(from);
    if (fs.existsSync(to) && Buffer.compare(a, fs.readFileSync(to)) === 0) { same++; return; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, a);
    copied++;
    console.log('  copied   ' + path.relative(ROOT, to));
}

try {
    for (const f of SHARED) put(path.join(ROOT, 'server', f), path.join(WWW, 'js', f));

    const wanted = walk(WWW).filter((rel) => !SKIP(rel));
    for (const rel of wanted) put(path.join(WWW, rel), path.join(PUB, rel));

    /* A file that left mobile/www must leave the APK too, or it ships forever. */
    const keep = new Set(wanted);
    for (const rel of walk(PUB)) {
        if (keep.has(rel) || GENERATED.has(rel)) continue;
        fs.unlinkSync(path.join(PUB, rel));
        removed++;
        console.log('  removed  ' + path.relative(ROOT, path.join(PUB, rel)));
    }
} catch (e) {
    console.error('sync:shared FAILED: ' + (e && e.message || e));
    process.exit(1);
}
console.log('\nsync:shared: ' + copied + ' copied, ' + removed + ' removed, ' + same + ' already identical');
