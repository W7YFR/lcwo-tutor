/*
 * The questions the popup and the practice page actually ask.
 *
 * store.js fetches records and rollup.js adds them up; this composes the two
 * into the three answers the UI wants - what am I missing, what should I
 * send, and which pairs am I mixing up - so neither page has to know how the
 * pieces fit together, and both can be tested without a browser.
 */
(function (X, store, rollup, practice) {
  'use strict';

  /* The day windows worth offering, given how many days are on file. A
     14-day window over 10 days of practice is just "all time" wearing a hat. */
  const WINDOW_SIZES = [2, 3, 7, 14, 30];

  const loadViews = async (db, oid) =>
    (await store.loadAll(db, oid)).map(rollup.groupView);

  const windowsFor = views => {
    const n = rollup.practiceDays(views).length;
    return WINDOW_SIZES.filter(w => w < n);
  };

  /*
   * What you are missing, over the whole scope or the last N practice days.
   *
   * `days` counts days you practiced, not calendar days: skip a Tuesday and
   * it reaches back past it. The threshold applies to the total across the
   * window, not to each day inside it - two days at one miss each is a
   * character missed twice, which is the thing worth practicing.
   */
  async function troubleReport(db, opts) {
    const o = opts || {};
    const views = o.views || await loadViews(db, o.oid);
    const days = o.days ? rollup.lastDays(views, o.days) : null;
    const counts = rollup.counts(views, days);
    const trouble = rollup.troubleFrom(counts.miss, o.threshold);
    return {
      views: views,
      practiceDays: rollup.practiceDays(views),
      windows: windowsFor(views),
      window: o.days || null,
      inWindow: days ? Array.from(days).sort() : null,
      counts: counts,
      trouble: trouble,
      top: rollup.topHalf(trouble),
      table: rollup.charTable(views, days),
    };
  }

  const asList = trouble => trouble.map(t => t.char).join(',');

  /*
   * Sending practice, from the characters you miss on receive.
   *
   * `chars` overrides the stats entirely, for when you already know what you
   * want to drill.
   */
  async function practiceReport(db, opts) {
    const o = opts || {};
    const report = await troubleReport(db, o);

    let weights = {};
    if (o.chars && o.chars.length) {
      for (const ch of o.chars) weights[ch] = weights[ch] || 1;
    } else {
      for (const t of report.trouble) weights[t.char] = t.count;
    }

    const pairs = rollup.confusedPairs(report.counts.confusions,
                                       {minCount: o.pairMin, top: o.pairTop});
    return Object.assign(report, {
      chars: Object.keys(weights),
      set: practice.practiceSet(weights, {n: o.n, seed: o.seed}),
      pairs: pairs.length ? practice.pairDrill(pairs, {per: o.per, seed: o.seed}) : [],
    });
  }

  X.WINDOW_SIZES = WINDOW_SIZES;
  X.loadViews = loadViews;
  X.windowsFor = windowsFor;
  X.troubleReport = troubleReport;
  X.practiceReport = practiceReport;
  X.asList = asList;
})(typeof module === 'object' ? module.exports : (self.LCWO.analysis = {}),
   typeof require === 'function' ? require('./store.js') : self.LCWO.store,
   typeof require === 'function' ? require('../core/rollup.js') : self.LCWO.rollup,
   typeof require === 'function' ? require('../core/practice.js') : self.LCWO.practice);
