/* Worker test runner.
 *
 *     node worker/tests/run.mjs            # all suites
 *     node worker/tests/run.mjs approve    # suites whose name contains "approve"
 *
 * ⛔ THIS FILE EXISTS BECAUSE THE SUITES DID NOT. The accounts work was tested on
 * 2026-11-08 and every one of those tests lived in a throwaway scratch directory, so
 * what was actually committed to the repo was untested code plus a claim that it had
 * been tested. A suite that is not in the repository did not run for anyone but me, once.
 *
 * It needs node:sqlite, i.e. Node 22.5+. No network, no wrangler, no deploy.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';

let pass = 0, fail = 0;
const failures = [];

function harness(suite) {
    return {
        ok(cond, msg) {
            if (cond) { pass++; console.log('    ok    ' + msg); }
            else { fail++; failures.push(suite + ': ' + msg); console.log('    FAIL  ' + msg); }
        },
        eq(got, want, msg) {
            this.ok(got === want, msg + (got === want ? '' : '  [got ' + JSON.stringify(got)
                + ', want ' + JSON.stringify(want) + ']'));
        },
    };
}

const files = readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort();
if (!files.length) { console.log('no *.test.mjs in ' + HERE); process.exit(1); }

for (const f of files) {
    /* ⛔ FILTER BEFORE IMPORTING. This used to import every suite and filter afterwards,
     * so `run.mjs approve` still loaded the suites it was told to skip — and one bad
     * import in a skipped file killed the run. */
    if (filter && !f.includes(filter)) continue;
    const mod = await import(join(HERE, f));
    const suite = mod.name || f;
    console.log('\n  ' + suite + '  (' + f + ')');
    try {
        await mod.run(harness(suite));
    } catch (e) {
        fail++;
        failures.push(suite + ': THREW ' + (e && e.message));
        console.log('    THREW  ' + (e && e.stack || e));
    }
}

console.log('\n  ' + pass + ' passing, ' + fail + ' failing');
if (failures.length) {
    console.log('\n  failures:');
    for (const x of failures) console.log('    - ' + x);
}
console.log('');
process.exit(fail ? 1 : 0);
