#!/usr/bin/env node
// YASA PRESENTS
/* local-suite.js: run a suite that is kept on one machine and not in the repository.
 *
 *     node scripts/local-suite.js tests/franchise-ui.test.js
 *
 * A few suites are written against a private library file, and name what is in it
 * (.gitignore lists them and the file). Where the suite is not there, this says so and
 * passes, so `npm run test:offline` works from a clone; where it is, it runs it and passes
 * its result on.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const given = process.argv[2];
if (!given) { console.log('usage: node scripts/local-suite.js <suite> [its arguments]'); process.exit(2); }
const file = path.resolve(given);
if (!fs.existsSync(file)) {
    console.log('\n  SKIPPED, 0 checks run: ' + given + ' is kept on the machine it was written on and is'
        + '\n  not in the repository.\n');
    process.exit(0);
}
const r = spawnSync(process.execPath, [file].concat(process.argv.slice(3)), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
