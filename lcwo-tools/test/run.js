/*
 * The test runner.
 *
 *     node lcwo-tools/test/run.js [name ...]
 *
 * Every *.test.js in this directory exports `run(check)`. A non-zero exit is
 * what stops `make build` from producing a release.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {harness} = require('./harness.js');

async function main(only) {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js'))
    .filter(f => !only.length || only.some(o => f.includes(o)))
    .sort();

  if (!files.length) {
    console.log('no test files matched ' + only.join(', '));
    return 1;
  }

  const {check, failed, count} = harness();
  for (const file of files) {
    console.log('\n' + path.basename(file, '.test.js'));
    await require(path.join(__dirname, file)).run(check);
  }

  console.log(failed.length
    ? '\n  ' + failed.length + ' failure(s): ' + failed.join(', ')
    : '\n  all ' + count() + ' checks passed');
  return failed.length ? 1 : 0;
}

main(process.argv.slice(2)).then(code => process.exit(code), err => {
  console.error('\n  the suite itself blew up:\n', err);
  process.exit(2);
});
