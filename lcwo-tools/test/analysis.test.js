/*
 * The questions the popup and the practice page ask.
 *
 * store + rollup are checked on their own elsewhere; what matters here is
 * that the composition answers the same things `make trouble` and
 * `make practice` answer, with the same window semantics.
 *
 *     node lcwo-tools/test/run.js analysis
 */
'use strict';

const {same} = require('./harness.js');
const {memoryBackend} = require('./memory.js');
const store = require('../src/data/store.js');
const rollup = require('../src/core/rollup.js');
const analysis = require('../src/data/analysis.js');

const DAYS = ['2026-04-01', '2026-04-03', '2026-04-06'];  // with days off between

/*
 * A misses one a day on all three days, B only on the first, C once a day on
 * the last two. So a two-day window has to reach A and C but not B - and A is
 * only trouble once the two days are added together.
 */
async function fixture() {
  const db = memoryBackend();
  const oid = await store.createOperator(db, 'Test Op', 'W0TST');
  const gid = await store.createGroup(db, {operator_id: oid, assignment: 'S1HW1',
                                           mode: 'letters', char_wpm: 25, eff_wpm: 8,
                                           created_at: DAYS[0] + 'T08:00:00-07:00'});
  const plan = [
    [DAYS[0], ['AB', 'BC', 'BD'], ['.B', '.C', '.D']],
    [DAYS[1], ['AX', 'CY'], ['.X', '.Y']],
    [DAYS[2], ['AX', 'CY'], ['.X', '.Y']],
  ];
  for (const [day, key, attempt] of plan) {
    const s = await store.startSession(db, await store.getGroup(db, gid),
                                       {started_at: day + 'T09:00:00-07:00'});
    await store.addRun(db, s.id, attempt,
                       {is_final: true, recorded_at: day + 'T09:10:00-07:00'});
    await store.finishSession(db, s.id, key);
  }
  return {db, oid, gid};
}

exports.run = async function (check) {
  const {db, oid} = await fixture();
  const chars = list => list.map(t => t.char).join('');

  /* ---------- which windows are worth offering ---------- */
  const views = await analysis.loadViews(db);
  check('views come back graded', views.length === 1 && views[0].gradedRuns.length === 3);
  check('only windows shorter than the practice you have are offered',
        same(analysis.windowsFor(views), [2]), JSON.stringify(analysis.windowsFor(views)));
  check('a fresh database offers none', same(analysis.windowsFor([]), []));

  /* ---------- trouble ---------- */
  const all = await analysis.troubleReport(db, {});
  check('all time counts every day', same(all.counts.miss, {A: 3, B: 2, C: 2}));
  check('the trouble list is worst first', chars(all.trouble) === 'ABC');
  check('the top half is the half worth working on', chars(all.top) === 'AB');
  check('it reports the days it drew from', same(all.practiceDays, DAYS));
  check('and that no window was applied', all.window === null && all.inWindow === null);

  const two = await analysis.troubleReport(db, {days: 2});
  check('a window counts practice days, not calendar days',
        same(two.inWindow, [DAYS[1], DAYS[2]]));
  check('the window drops what falls outside it', two.counts.miss['B'] === undefined);
  // the semantic that matters: one miss a day for two days is a character
  // missed twice, and neither day on its own would have found it
  check('a window thresholds the combined total, not each day',
        chars(two.trouble) === 'AC');
  check('which no single day inside it would have found',
        [DAYS[1], DAYS[2]].every(d =>
          rollup.troubleFrom(rollup.counts(views, new Set([d])).miss).length === 0));
  check('an oversized window is just everything',
        same((await analysis.troubleReport(db, {days: 99})).counts.miss, all.counts.miss));
  check('the threshold can be moved',
        chars((await analysis.troubleReport(db, {threshold: 3})).trouble) === 'A');
  check('the character table comes with it',
        all.table[0].char === 'A' && all.table[0].sent === 3);

  check('a list is what the settings page wants', analysis.asList(all.top) === 'A,B');
  check('an empty list is an empty string', analysis.asList([]) === '');

  /* ---------- scoping ---------- */
  const other = await store.createOperator(db, 'Other', 'K0OTH');
  check('another operator has no trouble of their own',
        (await analysis.troubleReport(db, {oid: other})).trouble.length === 0);
  check('while yours is unchanged',
        chars((await analysis.troubleReport(db, {oid})).trouble) === 'ABC');

  /* ---------- practice ---------- */
  const p = await analysis.practiceReport(db, {n: 12, seed: 'fixed'});
  check('a practice set is the size asked for', p.set.length === 12);
  check('built from the trouble characters',
        p.set.every(g => Array.from(g).every(c => 'ABC'.includes(c))));
  check('the worst character leads', p.set[0][0] === 'A');
  check('a seed repeats the set',
        same((await analysis.practiceReport(db, {n: 12, seed: 'fixed'})).set, p.set));
  check('a different seed gives a different one',
        !same((await analysis.practiceReport(db, {n: 12, seed: 'other'})).set, p.set));
  check('the trouble it was built from comes back too', chars(p.trouble) === 'ABC');

  /* typing characters in overrides the statistics entirely */
  const typed = await analysis.practiceReport(db, {n: 9, seed: 'x', chars: ['K', 'Y', 'V']});
  check('typed characters override the stats',
        typed.set.every(g => Array.from(g).every(c => 'KYV'.includes(c))));
  check('and every one of them is used',
        same(Array.from(new Set(typed.set.join(''))).sort(), ['K', 'V', 'Y']));
  check('the trouble list is still reported alongside', chars(typed.trouble) === 'ABC');

  /* these misses are all dropped characters, so there is nothing to confuse */
  check('no confusions, no pair drills', p.pairs.length === 0);

  /* ---------- pairs, where there are some ---------- */
  {
    const db2 = memoryBackend();
    const g2 = await store.createGroup(db2, {assignment: 'X',
                                             created_at: '2026-04-01T08:00:00-07:00'});
    const s = await store.startSession(db2, await store.getGroup(db2, g2),
                                       {started_at: '2026-04-01T09:00:00-07:00'});
    // H heard as S twice, and S heard as H once: one pair, counts added
    await store.addRun(db2, s.id, ['SR', 'SR', 'HX'],
                       {is_final: true, recorded_at: '2026-04-01T09:10:00-07:00'});
    await store.finishSession(db2, s.id, ['HR', 'HR', 'SX']);

    const pr = await analysis.practiceReport(db2, {n: 6, per: 3, seed: 'x'});
    check('confusions become one drill per pair', pr.pairs.length === 1);
    check('and both directions are counted together',
          pr.pairs[0].a === 'H' && pr.pairs[0].b === 'S' && pr.pairs[0].count === 3);
    check('every pair group holds both characters',
          pr.pairs[0].groups.every(g => g.includes('H') && g.includes('S')));
    check('a rare pair is below the threshold',
          (await analysis.practiceReport(db2, {seed: 'x', pairMin: 4})).pairs.length === 0);
  }

  /* ---------- an empty database ---------- */
  {
    const empty = memoryBackend();
    const r = await analysis.troubleReport(empty, {});
    check('nothing recorded, nothing to practice',
          r.trouble.length === 0 && r.top.length === 0 && r.practiceDays.length === 0);
    check('and no windows to offer', same(r.windows, []));
    const pe = await analysis.practiceReport(empty, {n: 10});
    check('and no set to build', same(pe.set, []) && same(pe.pairs, []));
  }
};
