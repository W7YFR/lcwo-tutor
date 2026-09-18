/*
 * run -> session -> group -> all time.
 *
 * The store hands over plain records nested group > sessions > runs; this
 * grades them and adds up the counters. Nothing here touches storage, so it
 * runs the same over a live database, an import, or a test fixture.
 */
(function (X, grade, counter) {
  'use strict';

  const gradeRun = grade.gradeRun, tally = grade.tally;
  const merge = counter.merge, mergeDeep = counter.mergeDeep, ranked = counter.ranked;

  const TROUBLE_THRESHOLD = 2;  // missed this many times or more within the scope

  /*
   * Grade a nested group record.
   *
   * A session with no key yet has ungraded runs: `grade` is null and they
   * count toward nothing. The final run brings the key and grades every
   * earlier run in the session retroactively.
   */
  function groupView(group) {
    const sessions = (group.sessions || []).map(s => {
      const key = s.key && s.key.length ? s.key : null;
      const runs = (s.runs || []).map(r => Object.assign({}, r, {
        grade: key ? gradeRun(key, r.attempt, r.reported) : null,
        day: String(r.recorded_at || '').slice(0, 10),
      }));
      return Object.assign({}, s, {runs: runs}, sessionDerived(runs));
    });
    return Object.assign({}, group, {sessions: sessions}, groupDerived(sessions));
  }

  function sessionDerived(runs) {
    const graded = runs.filter(r => r.grade);
    let best = null, final = null;
    for (const r of graded) if (!best || r.grade.pctWrong < best.grade.pctWrong) best = r;
    for (const r of runs) if (r.is_final && r.grade) { final = r; break; }
    if (!final && runs.length && runs[runs.length - 1].grade) final = runs[runs.length - 1];
    return {graded: graded.length > 0, gradedRuns: graded, best: best, final: final};
  }

  function groupDerived(sessions) {
    const runs = [];
    for (const s of sessions) for (const r of s.gradedRuns) runs.push(r);
    return {gradedRuns: runs, graded: runs.length > 0};
  }

  /* Every graded run in scope, newest-agnostic - callers filter and sort. */
  const allRuns = views => views.reduce((acc, v) => acc.concat(v.gradedRuns), []);

  /* Days with at least one graded run, oldest first. */
  const practiceDays = views =>
    Array.from(new Set(allRuns(views).map(r => r.day))).sort();

  /* The last `n` days that actually had practice - days off do not count. */
  function lastDays(views, n) {
    const days = practiceDays(views);
    return n == null ? null : new Set(days.slice(Math.max(0, days.length - n)));
  }

  /* Counters over a scope, optionally limited to a set of days. */
  function counts(views, days) {
    const runs = allRuns(views).filter(r => !days || days.has(r.day));
    return tally(runs.map(r => r.grade));
  }

  /* Chars missed >= threshold times in scope, worst first then alphabetical.
   *
   * The threshold applies to the combined total across the whole scope, not to
   * each day inside it: two days at one miss each is a character you missed
   * twice, and that is the thing worth practicing. See DESIGN.md. */
  function troubleFrom(missCounts, threshold) {
    const t = threshold === undefined ? TROUBLE_THRESHOLD : threshold;
    return ranked(missCounts).filter(e => e[1] >= t).map(e => ({char: e[0], count: e[1]}));
  }

  /* The worse half of a trouble list, rounded up - a practice set small enough
     to actually work on, taken off a list that is already worst-first. */
  const topHalf = trouble =>
    trouble && trouble.length ? trouble.slice(0, Math.max(1, Math.ceil(trouble.length / 2))) : [];

  /*
   * Unordered pairs you mix up, worst first.
   *
   * H heard as S and S heard as H are the same two rhythms failing to
   * separate, so they are one drill and their counts add.
   */
  function confusedPairs(confusions, opts) {
    opts = opts || {};
    const minCount = opts.minCount === undefined ? 2 : opts.minCount;
    const top = opts.top === undefined ? 6 : opts.top;

    const merged = {};
    for (const k in confusions) {
      const parts = k.split('>');
      const key = parts[0] < parts[1] ? k : parts[1] + '>' + parts[0];
      merged[key] = (merged[key] || 0) + confusions[k];
    }
    return ranked(merged).slice(0, top)
      .filter(e => e[1] >= minCount)
      .map(e => ({a: e[0].split('>')[0], b: e[0].split('>')[1], count: e[1]}));
  }

  /* char -> {sent, missed, correct, pct} over a scope: the PRACTICE THESE table. */
  function charTable(views, days) {
    const t = counts(views, days);
    return ranked(t.miss).map(e => {
      const ch = e[0], missed = e[1], sent = t.sent[ch] || 0;
      return {
        char: ch, missed: missed, sent: sent,
        correct: Math.max(0, sent - missed),
        pct: sent ? Math.max(0, 100 * (sent - missed) / sent) : null,
        kinds: t.breakdown[ch] || {},
      };
    });
  }

  X.TROUBLE_THRESHOLD = TROUBLE_THRESHOLD;
  X.groupView = groupView;
  X.allRuns = allRuns;
  X.practiceDays = practiceDays;
  X.lastDays = lastDays;
  X.counts = counts;
  X.troubleFrom = troubleFrom;
  X.topHalf = topHalf;
  X.confusedPairs = confusedPairs;
  X.charTable = charTable;
  X.merge = merge;
  X.mergeDeep = mergeDeep;
})(typeof module === 'object' ? module.exports : (self.LCWO.rollup = {}),
   typeof require === 'function' ? require('./grade.js') : self.LCWO.grade,
   typeof require === 'function' ? require('./counter.js') : self.LCWO.counter);
