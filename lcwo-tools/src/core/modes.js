/*
 * Drill types and the per-character verdict codes.
 *
 * Both are part of the report payload's shape, so they have to agree with the
 * Python's MODES and KIND_CODE. Nothing checks that statically - what checks
 * it is building the payload both ways from the same database and diffing.
 */
(function (X) {
  'use strict';

  /* Extend as new LCWO drills get added. Stored as a plain string, so old
     rows keep working. */
  const MODES = [
    ['letters', 'Letters'],
    ['code_group', 'Code group'],
    ['custom', 'Error practice'],
  ];

  const MODE_LABEL = {};
  for (const pair of MODES) MODE_LABEL[pair[0]] = pair[1];

  /* One letter per character in a group, so the payload stays small. */
  const KIND_CODE = {correct: 'c', missed: 'm', wrong: 'w', transposed: 't', extra: 'x'};

  X.MODES = MODES;
  X.MODE_LABEL = MODE_LABEL;
  X.KIND_CODE = KIND_CODE;
})(typeof module === 'object' ? module.exports : (self.LCWO.modes = {}));
