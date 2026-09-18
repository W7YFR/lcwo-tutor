/*
 * Build a shareable extension zip - but only if the tests pass.
 *
 *     node lcwo-tools/build.js [--skip-tests]
 *
 * Nothing here compiles or bundles: Chrome loads the sources as they are, so
 * a build is a check and a zip. The point is the gate. A release that fails
 * its own grading checks would hand somebody wrong numbers about their copy,
 * which is worse than no release, so the tests run first and a failure stops
 * the build.
 *
 * Development does not need this at all - load the unpacked extension from
 * this directory and it picks up edits on reload.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {execFileSync, spawnSync} = require('child_process');

const HERE = __dirname;
const DIST = path.join(HERE, 'dist');

/* What goes in the zip: sources, manifest, icons. Not the tests. */
const INCLUDE = ['manifest.json', 'icons', 'src'];

function fail(msg) {
  console.error('\n  ' + msg);
  process.exit(1);
}

function runTests() {
  console.log('  running the checks first\n');
  const r = spawnSync(process.execPath, [path.join(HERE, 'test', 'run.js')],
                      {stdio: 'inherit'});
  if (r.status !== 0) fail('the checks did not pass, so there is nothing to release');
}

/* Every path the manifest names has to exist, or Chrome refuses to load with
   no hint about which key is wrong. */
function checkManifest(manifest) {
  const named = [manifest.background && manifest.background.service_worker,
                 manifest.action && manifest.action.default_popup]
    .concat(Object.values(manifest.icons || {}))
    .concat(...(manifest.content_scripts || []).map(cs => (cs.js || []).concat(cs.css || [])))
    .filter(Boolean);
  const missing = named.filter(f => !fs.existsSync(path.join(HERE, f)));
  if (missing.length) fail('the manifest names files that are not there: ' + missing.join(', '));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) {
    fail('version should be x.y.z, not ' + JSON.stringify(manifest.version));
  }
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--skip-tests')) runTests();

  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
  checkManifest(manifest);

  for (const item of INCLUDE) {
    if (!fs.existsSync(path.join(HERE, item))) fail('missing from the source tree: ' + item);
  }

  fs.mkdirSync(DIST, {recursive: true});
  const name = manifest.name + '-' + manifest.version + '.zip';
  const out = path.join(DIST, name);
  fs.rmSync(out, {force: true});

  // `zip` ships with macOS and every Linux worth naming; writing a zip
  // container by hand to avoid it would be its own small liability.
  try {
    execFileSync('zip', ['-q', '-r', '-X', out].concat(INCLUDE), {cwd: HERE});
  } catch (e) {
    fail('could not run `zip` (' + e.message + ')');
  }

  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log('\n  built ' + path.relative(process.cwd(), out) + '  (' + kb + ' KB)');
  console.log('  load unpacked from ' + path.relative(process.cwd(), HERE)
              + ' for development; the zip is for sharing');
}

main();
