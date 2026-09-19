/*
 * The report payload.
 *
 * One shape, built two ways: `lcwo.py report` builds it from SQLite and
 * embeds it in a file, this builds it from IndexedDB for the extension's
 * report page. app.js consumes it and cannot tell which made it - so the
 * shapes have to match exactly, down to nulls, and the check that they do is
 * building both from the same database and diffing.
 */
(function (X, rollup, modes, clock) {
  'use strict';

  const MODE_LABEL = modes.MODE_LABEL, KIND_CODE = modes.KIND_CODE;

  const label = m => (m == null ? null : (MODE_LABEL[m] === undefined ? m : MODE_LABEL[m]));
  const nul = v => (v === undefined ? null : v);

  /*
   * `views` are rollup.groupView results; `operators` are operator records.
   * `generated` can be passed in so a caller comparing two payloads is not
   * defeated by the clock.
   */
  function buildPayload(views, operators, opts) {
    const o = opts || {};
    const groups = [], sessions = [], runs = [];

    for (const v of views) {
      groups.push({
        id: v.id, op: nul(v.operator_id), label: nul(v.label),
        mode: label(v.mode), assignment: nul(v.assignment),
        charWpm: nul(v.char_wpm), effWpm: nul(v.eff_wpm),
        created: nul(v.created_at), closed: nul(v.closed_at), notes: nul(v.notes),
      });

      for (const s of v.sessions) {
        sessions.push({
          id: s.id, gid: v.id, seq: s.seq, at: nul(s.started_at), notes: nul(s.notes),
          mode: nul(s.mode),
          // an unset drill reads as a dash here, unlike on the group
          modeLabel: s.mode == null ? '-' : label(s.mode),
          charWpm: nul(s.char_wpm), effWpm: nul(s.eff_wpm),
        });

        for (const r of s.runs) {
          const cells = [];
          if (r.grade) {
            for (const g of r.grade.groups) {
              cells.push([g.sent, g.recv, g.cells.map(c => KIND_CODE[c.kind]).join('')]);
            }
          }
          runs.push({
            sid: s.id, gid: v.id, seq: r.seq, final: !!r.is_final,
            at: nul(r.recorded_at), day: clock.dayOf(r.recorded_at),
            graded: !!r.grade, cells: cells,
          });
        }
      }
    }

    return {
      generated: o.generated || clock.nowIso(),
      troubleThreshold: rollup.TROUBLE_THRESHOLD,
      modes: Object.assign({}, MODE_LABEL),
      operators: (operators || []).map(op => ({id: op.id, callsign: op.callsign,
                                               name: op.name})),
      groups: groups, sessions: sessions, runs: runs,
    };
  }

  X.buildPayload = buildPayload;
})(typeof module === 'object' ? module.exports : (self.LCWO.payload = {}),
   typeof require === 'function' ? require('../core/rollup.js') : self.LCWO.rollup,
   typeof require === 'function' ? require('../core/modes.js') : self.LCWO.modes,
   typeof require === 'function' ? require('../core/clock.js') : self.LCWO.clock);
