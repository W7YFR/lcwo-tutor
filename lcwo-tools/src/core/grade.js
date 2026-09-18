/*
 * The grading engine: pure functions, no storage and no DOM.
 *
 * Grading is always derived, never stored. A run keeps only what you typed;
 * the session keeps the key. That way fixing a grading bug re-grades your
 * whole history instead of leaving old sessions wrong for ever.
 */
(function (X, counter) {
  'use strict';

  const bump = counter.bump, merge = counter.merge, mergeDeep = counter.mergeDeep;

  const MISS_KINDS = ['missed', 'wrong', 'transposed'];
  const isMiss = kind => MISS_KINDS.indexOf(kind) !== -1;

  const letters = s => Array.from(s).sort().join('');

  /* One group: the sent text against what you copied, character by character. */
  function gradeGroup(idx, sent, recv, reported) {
    sent = String(sent == null ? '' : sent).toUpperCase();
    recv = String(recv == null ? '' : recv).toUpperCase();

    // A transposition is the same characters in the wrong order - you knew
    // them all, you just wrote them down swapped. Worth separating from a
    // real miss.
    const transposed = sent.length >= 2
      && recv.length === sent.length
      && sent !== recv
      && recv.indexOf('.') === -1
      && letters(sent) === letters(recv);

    const cells = [];
    for (let pos = 0; pos < Math.max(sent.length, recv.length); pos++) {
      const s = sent[pos] || '';
      const r = recv[pos] || '';
      let kind;
      if (!s) kind = 'extra';              // copied a character never sent
      else if (r === s) kind = 'correct';
      else if (r === '' || r === '.') kind = 'missed';  // flagged "didn't know"
      else if (transposed) kind = 'transposed';
      else kind = 'wrong';                 // heard it as something else
      cells.push({pos: pos, sent: s, recv: r, kind: kind, miss: isMiss(kind)});
    }

    const wrong = cells.filter(c => c.miss).length;
    const rep = reported === undefined ? null : reported;
    return {
      idx: idx, sent: sent, recv: recv, cells: cells, transposed: transposed,
      reported: rep,
      wrong: wrong,
      clean: wrong === 0 && !cells.some(c => c.kind === 'extra'),
      disagrees: rep != null && rep !== wrong,
    };
  }

  /* Grade one run's `attempt` against the session's `key`, aligned by index. */
  function gradeRun(key, attempt, reported) {
    key = key || [];
    attempt = attempt || [];
    const n = Math.max(key.length, attempt.length);
    const groups = [];
    for (let i = 0; i < n; i++) {
      groups.push(gradeGroup(i, key[i], attempt[i],
                             reported && i < reported.length ? reported[i] : null));
    }
    return runGrade(groups);
  }

  /* The totals every view of a run is built from. */
  function runGrade(groups) {
    const totalChars = groups.reduce((n, g) => n + g.sent.length, 0);
    const wrongChars = groups.reduce((n, g) => n + g.wrong, 0);
    const sentGroups = groups.filter(g => g.sent);

    return {
      groups: groups,
      totalChars: totalChars,
      wrongChars: wrongChars,
      rightChars: totalChars - wrongChars,
      totalGroups: sentGroups.length,
      cleanGroups: sentGroups.filter(g => g.clean).length,
      wrongGroups: sentGroups.length - sentGroups.filter(g => g.clean).length,
      pctWrong: totalChars ? 100 * wrongChars / totalChars : 0,
      pctRight: totalChars ? 100 - (100 * wrongChars / totalChars) : 0,
      transposedGroups: groups.filter(g => g.transposed),
      disagreements: groups.filter(g => g.disagrees),

      /* char -> times it was sent but not copied correctly */
      missCounts() {
        const c = {};
        for (const g of groups) for (const cell of g.cells) if (cell.miss) bump(c, cell.sent);
        return c;
      },
      /* char -> counter of miss kinds */
      missBreakdown() {
        const out = {};
        for (const g of groups) {
          for (const cell of g.cells) {
            if (cell.miss) bump(out[cell.sent] || (out[cell.sent] = {}), cell.kind);
          }
        }
        return out;
      },
      sentCounts() {
        const c = {};
        for (const g of groups) for (const ch of g.sent) bump(c, ch);
        return c;
      },
      /* "H>S" -> count, for genuine substitutions only */
      confusions() {
        const c = {};
        for (const g of groups) {
          for (const cell of g.cells) if (cell.kind === 'wrong') bump(c, cell.sent + '>' + cell.recv);
        }
        return c;
      },
    };
  }

  /* Fold a list of run grades into one set of counters. */
  function tally(grades) {
    const out = {miss: {}, sent: {}, confusions: {}, breakdown: {}};
    for (const g of grades) {
      if (!g) continue;
      merge(out.miss, g.missCounts());
      merge(out.sent, g.sentCounts());
      merge(out.confusions, g.confusions());
      mergeDeep(out.breakdown, g.missBreakdown());
    }
    return out;
  }

  X.MISS_KINDS = MISS_KINDS;
  X.isMiss = isMiss;
  X.gradeGroup = gradeGroup;
  X.gradeRun = gradeRun;
  X.runGrade = runGrade;
  X.tally = tally;
})(typeof module === 'object' ? module.exports : (self.LCWO.grade = {}),
   typeof require === 'function' ? require('./counter.js') : self.LCWO.counter);
