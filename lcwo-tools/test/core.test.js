/*
 * The grading engine and the rollups on top of it.
 *
 * These are the checks the CLI's selftest runs, moved across: the grader is
 * the one part of this where a quiet mistake shows up as a wrong number on a
 * report rather than as an error, so the port has to be provably the same.
 *
 *     node lcwo-tools/test/run.js core
 */
'use strict';

const {same, near} = require('./harness.js');
const counter = require('../src/core/counter.js');
const clock = require('../src/core/clock.js');
const {gradeGroup, gradeRun} = require('../src/core/grade.js');
const rollup = require('../src/core/rollup.js');
const practice = require('../src/core/practice.js');
const {rngFrom} = require('../src/core/rng.js');
const assign = require('../src/core/assign.js');

/* LCWO's own sample results table, as capture will hand it over: the key, what
   was copied, and LCWO's per-group error counts. */
const SAMPLE_KEY = ['EH', 'SM', 'TR', 'BU', 'EQ', 'KJ', 'VL', 'HR',
                    'CF', 'YC', 'TB', 'GR', 'JZ', 'NF', 'NM', 'WM'];
const SAMPLE_RECV = SAMPLE_KEY.map((g, i) => i === 7 ? 'SR' : g);
const SAMPLE_REPORTED = SAMPLE_KEY.map((g, i) => i === 7 ? 1 : 0);

/* One run on a given day, as the store nests it. */
const run = (day, key, attempt, opts) => Object.assign({
  id: 0, seq: 1, is_final: 1, attempt: attempt,
  recorded_at: day + 'T10:00:00-07:00',
}, opts || {});

const session = (key, runs) => ({id: 0, seq: 1, key: key, runs: runs});

exports.run = function (check) {

  /* ---------- counters ---------- */
  check('bump counts from nothing', same(counter.bump({}, 'A'), {A: 1}));
  check('bump adds to what is there', same(counter.bump({A: 1}, 'A', 2), {A: 3}));
  check('merge adds every key', same(counter.merge({A: 1}, {A: 2, B: 1}), {A: 3, B: 1}));
  check('mergeDeep goes one level down',
        same(counter.mergeDeep({A: {missed: 1}}, {A: {missed: 1, wrong: 2}}),
             {A: {missed: 2, wrong: 2}}));
  check('ranked puts the worst first, then alphabetical',
        same(counter.ranked({B: 3, A: 1, C: 3}), [['B', 3], ['C', 3], ['A', 1]]));

  /* ---------- timestamps ---------- */
  // Local, not UTC: every day-windowed number comes from slicing this, and a
  // 9pm session stamped in UTC files itself under tomorrow.
  const stamp = clock.nowIso(new Date(2026, 3, 1, 21, 30, 5));
  check('a timestamp starts with its local date', stamp.slice(0, 10) === '2026-04-01', stamp);
  check('and keeps the local wall clock', stamp.slice(11, 19) === '21:30:05', stamp);
  check('with an offset, not a Z', /[+-]\d\d:\d\d$/.test(stamp), stamp);
  check('the day is the first ten characters',
        clock.dayOf('2026-04-01T21:30:05-07:00') === '2026-04-01');
  check('and nothing at all is not a day', clock.dayOf(null) === '');

  /* ---------- grading a results table ---------- */
  let g = gradeRun(SAMPLE_KEY, SAMPLE_RECV, SAMPLE_REPORTED);
  check('32 chars', g.totalChars === 32);
  check('1 wrong char', g.wrongChars === 1);
  check('pct wrong', near(g.pctWrong, 3.125));
  check('pct right is the rest of it', near(g.pctRight, 96.875));
  check('15/16 clean groups', g.cleanGroups === 15 && g.totalGroups === 16);
  check('H counted as missed once', g.missCounts()['H'] === 1);
  check('confusion H->S', g.confusions()['H>S'] === 1);
  check('no LCWO disagreement', g.disagreements.length === 0);
  check('every sent character is counted',
        counter.total(g.sentCounts()) === 32 && g.sentCounts()['H'] === 2);
  check('the miss is broken down by kind', same(g.missBreakdown(), {H: {wrong: 1}}));

  /* ---------- the kinds of mistake ---------- */
  g = gradeRun(['EH', 'SM', 'TR', 'BU', 'EH'], ['EH', 'SM', '.R', 'BU', 'HE']);
  check('dot = missed', g.groups[2].cells[0].kind === 'missed');
  check('an untouched group is clean', g.groups[3].clean);
  check('transposition flagged', g.groups[4].transposed);
  check('transposed chars counted',
        g.missCounts()['E'] === 1 && g.missCounts()['H'] === 1);
  check('wrong char T', g.missCounts()['T'] === 1);
  check('a transposition is not a confusion', same(g.confusions(), {}));

  const short = gradeRun(['EH', 'SM', 'TR'], ['EH']);
  check('short attempt = all missed', short.wrongChars === 4);
  check('and the empty groups still count as sent', short.totalGroups === 3);

  const extra = gradeRun(['EH'], ['EHX']);
  check('extra char flagged', extra.groups[0].cells[2].kind === 'extra');
  check('extra is not clean', !extra.groups[0].clean);
  check('but an extra character is not a miss', extra.wrongChars === 0);

  check('LCWO disagreement caught', gradeGroup(0, 'EH', 'EX', 0).disagrees);
  check('and agreement is not', !gradeGroup(0, 'EH', 'EX', 1).disagrees);
  check('no reported count means nothing to disagree with',
        !gradeGroup(0, 'EH', 'EX').disagrees);
  check('lower case is graded the same',
        gradeGroup(0, 'eh', 'eh').clean && gradeGroup(0, 'eh', 'eh').sent === 'EH');
  check('a one-character group cannot be a transposition',
        !gradeGroup(0, 'E', 'E').transposed);
  check('a dot never reads as a transposition',
        !gradeGroup(0, 'EH', '.H').transposed);

  /* ---------- trouble lists ---------- */
  check('trouble threshold', same(rollup.troubleFrom({A: 2, B: 1}), [{char: 'A', count: 2}]));
  check('worst first, then alphabetical',
        rollup.troubleFrom({B: 3, A: 3, C: 9}).map(t => t.char).join('') === 'CAB');
  check('a custom threshold is honored',
        rollup.troubleFrom({A: 2, B: 1}, 1).length === 2);
  const four = [{char: 'A'}, {char: 'B'}, {char: 'C'}, {char: 'D'}];
  check('top half of an even list',
        rollup.topHalf(four).map(t => t.char).join('') === 'AB');
  check('top half of an odd list rounds up',
        rollup.topHalf(four.slice(0, 3)).map(t => t.char).join('') === 'AB');
  check('a single trouble letter is its own half',
        rollup.topHalf([{char: 'A'}]).length === 1);
  check('nothing in, nothing out', rollup.topHalf([]).length === 0);

  /* ---------- confusion pairs ---------- */
  // H heard as S and S heard as H are the same two rhythms failing to separate.
  check('confusions merge in both directions',
        same(rollup.confusedPairs({'H>S': 1, 'S>H': 2}), [{a: 'H', b: 'S', count: 3}]));
  check('pairs come worst first',
        rollup.confusedPairs({'H>S': 2, 'A>N': 5}).map(p => p.a + p.b).join(',') === 'AN,HS');
  check('a one-off pair is below the threshold',
        rollup.confusedPairs({'H>S': 1}).length === 0);
  check('top caps the list',
        rollup.confusedPairs({'H>S': 9, 'A>N': 8, 'E>I': 7}, {top: 2}).length === 2);
  check('no confusions, no pairs', rollup.confusedPairs({}).length === 0);

  /* ---------- days and windows ---------- */
  //
  // A misses one a day on all three days; B only ever on the first; C once a
  // day on the last two. So a two-day window has to reach A and C and must
  // not reach B - and A qualifies as trouble only once the two days are added
  // together, which is the whole point of the threshold.
  const DAYS = ['2026-04-01', '2026-04-03', '2026-04-06'];  // with days off between
  const views = [rollup.groupView({
    id: 1, assignment: 'S1HW1',
    sessions: [
      session(['AB', 'BC', 'BD'], [run(DAYS[0], null, ['.B', '.C', '.D'])]),
      session(['AX', 'CY'], [run(DAYS[1], null, ['.X', '.Y'])]),
      session(['AX', 'CY'], [run(DAYS[2], null, ['.X', '.Y'])]),
    ],
  })];

  check('practice days are the days with graded runs',
        same(rollup.practiceDays(views), DAYS));
  const all = rollup.counts(views).miss;
  check('every day counts toward the all-time list', same(all, {A: 3, B: 2, C: 2}));
  check('all-time trouble is worst first',
        rollup.troubleFrom(all).map(t => t.char).join('') === 'ABC');

  const win2 = rollup.lastDays(views, 2);
  check('a window skips over days off', same(Array.from(win2).sort(), [DAYS[1], DAYS[2]]));
  const in2 = rollup.counts(views, win2).miss;
  check('the window drops the oldest day\'s characters', in2['B'] === undefined);
  check('the window keeps only its own misses', same(in2, {A: 2, C: 2}));
  check('an oversized window is just everything',
        same(rollup.counts(views, rollup.lastDays(views, 99)).miss, all));
  check('no window at all is also everything', same(rollup.counts(views).miss, all));

  // The one semantic worth spelling out: the threshold applies to the total
  // across the window, not to each day inside it. Two days at one miss each
  // is a character missed twice, and that is what you want to practice.
  check('a window thresholds the combined total, not each day',
        rollup.troubleFrom(in2).map(t => t.char).join('') === 'AC');
  const perDay = DAYS.slice(1).map(d => rollup.troubleFrom(rollup.counts(views, new Set([d])).miss));
  check('which no single day inside it would have found',
        perDay.every(t => t.length === 0));

  /* ---------- the PRACTICE THESE table ---------- */
  const table = rollup.charTable(views);
  const A = table.find(r => r.char === 'A');
  check('the table is ordered worst first',
        table.map(r => r.char).join('') === 'ABC');
  check('it carries what was sent as well as what was missed',
        A.sent === 3 && A.missed === 3);
  check('correct is the difference', A.correct === 0 && near(A.pct, 0));
  const B = table.find(r => r.char === 'B');
  check('a character mostly copied right scores high',
        B.sent === 3 && B.missed === 2 && near(B.pct, 100 / 3));
  check('and the kinds of miss come with it', same(B.kinds, {missed: 2}));

  /* ---------- a session with no key yet ---------- */
  const pending = rollup.groupView({
    id: 2, sessions: [session(null, [run('2026-04-07', null, ['AB'])])],
  });
  check('an ungraded session grades nothing', pending.gradedRuns.length === 0);
  check('and does not count as a practice day',
        rollup.practiceDays([pending]).length === 0);
  check('nor is the group graded', !pending.graded);

  /* the final run brings the key and grades the earlier ones retroactively */
  const closed = rollup.groupView({
    id: 3, sessions: [session(['AB', 'CD'], [
      run('2026-04-07', null, ['.B', 'CD'], {seq: 1, is_final: 0}),
      run('2026-04-07', null, ['.B', '.D'], {seq: 2, is_final: 1}),
    ])],
  });
  check('earlier run graded retroactively', closed.gradedRuns.length === 2);
  check('the best run is the best one, not the last',
        closed.sessions[0].best.seq === 1);
  check('and the final run is the one flagged final',
        closed.sessions[0].final.seq === 2);
  check('both runs count toward the misses',
        rollup.counts([closed]).miss['A'] === 2 && rollup.counts([closed]).miss['C'] === 1);

  /* ---------- sending practice ---------- */
  const COUNTS = {A: 9, B: 5, C: 3, D: 1};
  const set = practice.practiceSet(COUNTS, {n: 24, seed: 'fixed'});
  check('practice set is the size asked for', set.length === 24);
  check('practice groups only use the given characters',
        set.every(w => Array.from(w).every(ch => COUNTS[ch] !== undefined)));
  check('every character gets a run of its own first',
        same(set.slice(0, 4).map(w => w[0]), ['A', 'B', 'C', 'D']));
  check('the worst character leads', set[0][0] === 'A');
  check('those opening runs really are solo',
        set.slice(0, 4).every(w => new Set(w).size === 1));
  check('group lengths stay in range', set.every(w => w.length >= 2 && w.length <= 3));
  const used = {};
  for (const w of set) for (const ch of w) counter.bump(used, ch);
  check('weighting favors the worse character', used['A'] > used['D']);
  check('mixed groups appear', set.some(w => new Set(w).size > 1));
  check('a seed repeats a practice set',
        same(practice.practiceSet(COUNTS, {n: 24, seed: 'fixed'}), set));
  check('a different seed does not',
        !same(practice.practiceSet(COUNTS, {n: 24, seed: 'other'}), set));
  check('no characters, no practice', practice.practiceSet({}, {n: 10}).length === 0);
  check('nothing asked for, nothing made',
        practice.practiceSet(COUNTS, {n: 0}).length === 0);
  check('lengths can be asked for',
        practice.practiceSet(COUNTS, {n: 6, seed: 'x', minLen: 4, maxLen: 4})
          .every(w => w.length === 4));
  // a long trouble list must not spend the whole drill on solo runs
  const many = {};
  for (const ch of 'ABCDEFGHIJKLMNOP') many[ch] = 2;
  const big = practice.practiceSet(many, {n: 10, seed: 'x'});
  check('a long trouble list still plants everything it can',
        big.length === 10 && new Set(big.join('')).size > 5);

  /* ---------- confusion pair drills ---------- */
  const pairs = [{a: 'H', b: 'S', count: 4}, {a: 'A', b: 'N', count: 2}];
  const drills = practice.pairDrill(pairs, {per: 3, seed: 'fixed'});
  check('one drill per pair', drills.length === 2);
  check('the pair and its count come through',
        drills[0].a === 'H' && drills[0].b === 'S' && drills[0].count === 4);
  check('pair groups use only their two characters',
        drills.every(d => d.groups.every(w => Array.from(w).every(c => c === d.a || c === d.b))));
  check('every pair group holds both characters',
        drills.every(d => d.groups.every(w => w.includes(d.a) && w.includes(d.b))));
  check('as many groups as asked for', drills.every(d => d.groups.length === 3));
  check('a seed repeats a pair drill',
        same(practice.pairDrill(pairs, {per: 3, seed: 'fixed'}), drills));
  check('no pairs, no drill', practice.pairDrill([], {seed: 'x'}).length === 0);

  /* ---------- the seeded generator itself ---------- */
  const r1 = rngFrom('abc'), r2 = rngFrom('abc');
  check('the same seed gives the same sequence',
        same([r1(), r1(), r1()], [r2(), r2(), r2()]));
  check('and it stays inside [0, 1)', Array.from({length: 200}, () => rngFrom('s')())
        .every(v => v >= 0 && v < 1));

  /* ---------- assignment numbering ---------- */
  const next = assign.nextAssignment;
  check('next after HW1', next(['S1HW1']) === 'S1HW2');
  check('HW rolls over into the next session', next(['S1HW3']) === 'S2HW1');
  check('it follows the highest, not the most recent',
        next(['S2HW2', 'S1HW2']) === 'S2HW3');
  check('lower case is fine', next(['s1hw1']) === 'S1HW2');
  check('double-digit sessions carry', next(['S12HW3']) === 'S13HW1');
  check('free-form labels are ignored', next(['warm-up', 'S1HW1']) === 'S1HW2');
  check('an out-of-range HW is not the pattern', next(['S1HW4']) === null);
  check('nothing to go on, no suggestion', next([]) === null && next(['lesson 4']) === null);
  check('and neither is nothing at all', next([null, undefined, '']) === null);

  /* ---------- call signs ---------- */
  check('call sign normalized', assign.normalizeCall(' w7 yfr ') === 'W7YFR');
  check('nothing normalizes to nothing', assign.normalizeCall(null) === '');
  check('wpm prints without a trailing zero', assign.fmtWpm(20) === '20');
  check('but keeps a real fraction', assign.fmtWpm(7.5) === '7.5');
  check('and says so when there is none', assign.fmtWpm(null) === '?');
};
