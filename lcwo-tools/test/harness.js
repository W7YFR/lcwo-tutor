/*
 * The check function every test file is handed.
 *
 * Same shape as the CLI's selftest - a name and a condition - so a check can
 * move between the two suites unchanged while the port is in progress.
 */
'use strict';

function harness() {
  const failed = [];
  let passed = 0;

  function check(name, ok, extra) {
    if (ok) { passed++; console.log('  ok   ' + name); }
    else { failed.push(name); console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
  }

  return {check, failed, count: () => passed};
}

/* Deep equality, enough for records and arrays of them. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => same(a[k], b[k]));
}

const near = (a, b, tol) => Math.abs(a - b) < (tol === undefined ? 1e-9 : tol);

module.exports = {harness, same, near};
