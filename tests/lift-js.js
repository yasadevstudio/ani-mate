/* Run the app's franchise code in Node, without a browser.
 *
 * TWO SOURCES, DELIBERATELY:
 *
 *   the shared module   require('../server/ani-mate-franchise.js') — the pure logic, the
 *                       same file the desktop serves and the APK ships
 *   the UI file         lifted out of ui/ani-mate-ui.html by text — the platform glue
 *                       that reads `state`, the DOM and the network, which only exists
 *                       inline in that file
 *
 * ⛔ NEITHER IS A COPY. tests/franchise-regression.py used to carry `card_opens()`, a
 * Python port of groupByFranchise. Its own docstring records the port drifting once and
 * "reported a working fix as a failure" — and by 2026-11-09 it had drifted again, still
 * grouping only `if r.get("franchise_id")` after the JS stopped doing that. A port is a
 * second implementation that nothing tests.
 *
 *   const api = require('./lift-js').lift(['groupByFranchise']);
 *   node tests/lift-js.js group [score|first] < rows.json     # CLI, for the Python suite
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'ui', 'ani-mate-ui.html');
const SHARED = path.join(__dirname, '..', 'server', 'ani-mate-franchise.js');
const AniMateFranchise = require(SHARED);

/* Lift one top-level declaration by text: `function N(`, `async function N(`, or
 * `const N = ...;`.
 *
 * The const form is not optional. The UI's franchise entry points are arrow delegations
 * to the shared module, and a lifter that only understood `function` would report them
 * as missing from a file that has them — a test failure blamed on the app. */
function functionText(src, name) {
    const fnAt = src.indexOf('function ' + name + '(');
    const constRe = new RegExp('^[ \\t]*const ' + name + '[ \\t]*=', 'm');
    const constM = src.match(constRe);
    const constAt = constM ? constM.index : -1;

    if (fnAt >= 0 && (constAt < 0 || fnAt < constAt)) {
        let at = fnAt;
        if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;   // keep the async
        let depth = 0, inStr = null, prev = '';
        for (let j = src.indexOf('{', at); j < src.length; j++) {
            const c = src[j];
            if (inStr) { if (c === inStr && prev !== '\\') inStr = null; }
            else if (c === '"' || c === "'" || c === '`') inStr = c;
            else if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; prev = ''; continue; }
            else if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); prev = ''; continue; }
            else if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
            prev = c;
        }
        throw new Error('unbalanced braces while lifting ' + name);
    }

    if (constAt >= 0) {
        let depth = 0, inStr = null, prev = '';
        for (let j = constAt; j < src.length; j++) {
            const c = src[j];
            if (inStr) { if (c === inStr && prev !== '\\') inStr = null; }
            else if (c === '"' || c === "'" || c === '`') inStr = c;
            else if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; prev = ''; continue; }
            else if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); prev = ''; continue; }
            else if ('([{'.indexOf(c) >= 0) depth++;
            else if (')]}'.indexOf(c) >= 0) depth--;
            else if (c === ';' && depth === 0) return src.slice(constAt, j + 1);
            prev = c;
        }
        throw new Error('no terminating semicolon while lifting const ' + name);
    }

    throw new Error('ui/ani-mate-ui.html declares neither `function ' + name
                  + '(` nor `const ' + name + ' =`');
}

/* Names the shared module owns. Asking for one of these lifts nothing — it comes
 * straight from server/ani-mate-franchise.js, so a test exercising it is exercising the
 * file both platforms load. */
const FROM_SHARED = new Set(['franchiseName', 'franchiseBase', 'seasonOrdinal', 'seasonLabel',
                             'isSeasonSpine', 'sortSeasons', 'franchiseIndex',
                             'groupFranchises', 'siblingsOf',
                             // moved into the module on 2026-11-12
                             'partOrdinal', 'commonPrefixWords', 'isStarMember',
                             'formatRank', 'poolOf', 'stripOf']);

/* Glue the UI file owns, always lifted so the lifted code's own dependencies resolve to
 * the real thing rather than to undefined. */
const LOCAL_DEPS = ['franchisePool', 'franchiseKeyOf', 'groupByFranchise', 'franchiseSiblings'];

/**
 * @param names   functions to expose; shared names come from the module, the rest are
 *                lifted out of the UI file
 * @param stateIn initial `state`
 * @param shims   anything non-franchise the lifted code calls (apiCall, toast, ...).
 *                There is no DOM here on purpose: a stub that quietly returns undefined
 *                is how a test passes while the real path is dead.
 * @param prelude raw code, for the module-scope `let`s the lifted code mutates
 *                (`favGen++` cannot be satisfied by a const shim)
 */
function lift(names, stateIn, shims, prelude) {
    const src = fs.readFileSync(HTML, 'utf8');
    const wantLocal = [...new Set([...LOCAL_DEPS,
                                   ...(names || []).filter(n => !FROM_SHARED.has(n))])];
    const body = wantLocal.map(n => functionText(src, n)).join('\n\n');

    /* The shared names go into SCOPE, not just onto the return value: the lifted glue
     * calls `franchiseIndex(pool)` directly, and putting it only on the result object
     * gave "ReferenceError: franchiseIndex is not defined" from inside the real code. */
    const given = Object.assign({ AniMateFranchise: AniMateFranchise, FR: AniMateFranchise },
                                shims || {});
    for (const n of FROM_SHARED) if (!(n in given)) given[n] = AniMateFranchise[n];
    const shimNames = Object.keys(given);
    const code = `
        const state = Object.assign({ results: [], dailyResults: [], releasesResults: [],
                                      favorites: [], continueResults: [] }, STATE_IN);
        const franchiseCache = {};
        ${shimNames.map((n, i) => `const ${n} = SHIMS[${i}];`).join('\n        ')}
        ${prelude || ''}
        ${body}
        return { ${wantLocal.join(', ')}, state, franchiseCache };`;
    const out = new Function('STATE_IN', 'SHIMS', code)(stateIn || {},
                                                        shimNames.map(n => given[n]));
    /* Shared names are attached from the module, never from the page. */
    for (const n of FROM_SHARED) out[n] = AniMateFranchise[n];
    return out;
}

module.exports = { lift, functionText, HTML, SHARED, AniMateFranchise };

if (require.main === module) {
    const mode = process.argv[2];
    const stdin = fs.readFileSync(0, 'utf8');
    const rows = stdin.trim() ? JSON.parse(stdin) : [];
    if (mode === 'group') {
        const { groups, ungrouped } = AniMateFranchise.groupFranchises(
            rows, rows, process.argv[3] || 'score');
        process.stdout.write(JSON.stringify({
            groups: groups.map(g => ({ franchise_id: g.franchise_id, parent: g.parent,
                                       members: g.members })),
            ungrouped,
        }));
    } else if (mode === 'base') {
        process.stdout.write(JSON.stringify(rows.map(t => AniMateFranchise.franchiseBase(t))));
    } else {
        process.stderr.write('usage: node tests/lift-js.js group|base [parentMode] < rows.json\n');
        process.exit(2);
    }
}
