/*
 * Assignment labels and operator identity.
 *
 * CW Academy numbers homework S<session>HW<1-3>: three assignments per
 * session, then the session rolls over. Anything not in that shape is left
 * alone.
 */
(function (X) {
  'use strict';

  const ASSIGNMENT_RE = /^\s*S(\d+)HW([1-3])\s*$/i;
  const HW_PER_SESSION = 3;

  /*
   * The assignment after the highest-numbered one on file.
   *
   * Highest rather than most recent: going back to redo S1HW2 should not make
   * the next new assignment S1HW3 when you have already worked through S2.
   */
  function nextAssignment(labels) {
    let best = null;
    for (const label of labels || []) {
      const m = ASSIGNMENT_RE.exec(String(label == null ? '' : label));
      if (!m) continue;
      const pair = [Number(m[1]), Number(m[2])];
      if (!best || pair[0] > best[0] || (pair[0] === best[0] && pair[1] > best[1])) best = pair;
    }
    if (!best) return null;
    const s = best[0], hw = best[1];
    return hw < HW_PER_SESSION ? 'S' + s + 'HW' + (hw + 1) : 'S' + (s + 1) + 'HW1';
  }

  const normalizeCall = s => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

  /* Python's %g: 20 not 20.0, 7.5 stays 7.5. */
  const fmtWpm = v => v == null ? '?' : String(Number(v));

  X.ASSIGNMENT_RE = ASSIGNMENT_RE;
  X.HW_PER_SESSION = HW_PER_SESSION;
  X.nextAssignment = nextAssignment;
  X.normalizeCall = normalizeCall;
  X.fmtWpm = fmtWpm;
})(typeof module === 'object' ? module.exports : (self.LCWO.assign = {}));
