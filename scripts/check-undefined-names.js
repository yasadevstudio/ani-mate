#!/usr/bin/env node
// YASA PRESENTS
/* check-undefined-names.js: does any script use a name that nothing defines?
 *
 *     npm run test:names
 *
 * WHY THIS EXISTS. Three bugs of exactly this shape were sitting in shipped code on
 * 2026-11-12, and nothing could see them:
 *
 *     renderSearch()   desktop page, the English-title switch on the search tab
 *     showToast()      phone, after removing a show from CONTINUE by long press
 *     video            desktop page, the quality control (a variable from another function)
 *
 * Each one is a line that only runs when a particular button is pressed, so the page
 * loads, every syntax check passes, and the handler throws in the user's hands. A parse
 * says the file is well formed. It does not say the names in it exist.
 *
 * HOW. The TypeScript compiler reads plain JavaScript and reports a name it cannot
 * resolve. Nothing here is TypeScript and nothing is compiled; only that one class of
 * report is kept (and "used before it is declared"). TypeScript is already in
 * node_modules, brought in by electron-builder.
 *
 * Exit code: 0 clean, 1 something is undefined (each one is printed with file and line),
 * 2 TypeScript is not installed (run `npm install`). 2 is not a pass.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* ANIMATE_TYPESCRIPT names a copy somewhere else. CI uses it: one package in a temp
 * folder, instead of installing Electron and everything else to read some scripts. */
const TS_AT = process.env.ANIMATE_TYPESCRIPT || path.join(ROOT, 'node_modules', 'typescript');
let ts;
try { ts = require(TS_AT); }
catch (e) {
    console.log('\n  COULD NOT RUN: TypeScript is not at ' + TS_AT + ' (' + e.code + ').'
        + '\n  It arrives with `npm install`. This check did not run, and that is not a pass.\n');
    process.exit(2);
}

/* 2304 / 2552  cannot find name (2552 adds "did you mean")
 * 2448 / 2454  used before its declaration / before it is assigned */
const WANTED = new Set([2304, 2552, 2448, 2454]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-names-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ } };

/* The desktop page's script lives inside the HTML. Written out with the same line
 * numbers it has in the page, so a report points at the real line. */
function pageScript() {
    const html = fs.readFileSync(path.join(ROOT, 'ui', 'ani-mate-ui.html'), 'utf8');
    const a = html.lastIndexOf('<script>'), b = html.lastIndexOf('</script>');
    if (a < 0 || b < a) throw new Error('ui/ani-mate-ui.html has no inline script');
    const out = path.join(tmp, 'ani-mate-ui.html.js');
    fs.writeFileSync(out, '\n'.repeat(html.slice(0, a).split('\n').length - 1) + html.slice(a + 8, b));
    return out;
}
function declare(name, names) {
    const f = path.join(tmp, name + '.d.ts');
    fs.writeFileSync(f, names.map(n => 'declare const ' + n + ': any;').join('\n') + '\n');
    return f;
}

/* Names a file is ENTITLED to find undefined, because another script on the same page
 * defines them at run time. Keep these lists short: every name added here is a name
 * this check can no longer catch. */
const BROWSER = ['Hls', 'AniMateFranchise'];
const PHONE = BROWSER.concat(['API', 'NET', 'SOURCES']);
const NODE = ['require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename'];

const phoneDir = path.join(ROOT, 'mobile', 'www', 'js');
const phoneFiles = fs.readdirSync(phoneDir)
    .filter(f => f.endsWith('.js'))
    /* The shared engines are byte-identical copies of server/ files (verify-shared
     * checks that) and are checked there, as the modules they are. */
    .filter(f => f !== 'ani-mate-sync.js' && f !== 'ani-mate-franchise.js' && f !== 'ani-mate-budget.js')
    .map(f => path.join(phoneDir, f));
const serverDir = path.join(ROOT, 'server');
const nodeFiles = ['main.js', 'preload.js', 'electron-net-bridge.js'].map(f => path.join(ROOT, f))
    .concat(fs.readdirSync(serverDir).filter(f => f.endsWith('.js')).map(f => path.join(serverDir, f)))
    .concat(fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => path.join(__dirname, f)));

const groups = [
    { what: 'the desktop page', lib: true, globals: declare('page', BROWSER), each: [pageScript()],
      show: () => 'ui/ani-mate-ui.html' },
    { what: 'the phone scripts', lib: true, globals: declare('phone', PHONE), each: phoneFiles },
    { what: 'Electron, the server and the scripts', lib: true, globals: declare('node', NODE), each: nodeFiles },
];

const options = {
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    /* Each file stands alone, the way a <script> tag does. Following imports would
     * report one file's problems under another's name. */
    noResolve: true, types: [],
};

let found = 0, files = 0;
try {
    for (const g of groups) {
        for (const file of g.each) {
            files++;
            const program = ts.createProgram([g.globals, file], options);
            const source = program.getSourceFile(file);
            const diags = ts.getPreEmitDiagnostics(program, source).filter(d => WANTED.has(d.code));
            for (const d of diags) {
                found++;
                const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0 };
                const shown = g.show ? g.show() : path.relative(ROOT, file);
                console.log('  UNDEFINED  ' + shown + ':' + (pos.line + 1) + '  '
                    + ts.flattenDiagnosticMessageText(d.messageText, ' '));
            }
        }
    }
} finally { cleanup(); }

console.log('\n  ' + files + ' files read, ' + found + ' undefined name' + (found === 1 ? '' : 's') + '\n');
process.exit(found ? 1 : 0);
