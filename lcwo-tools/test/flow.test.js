/*
 * A session from end to end, off the page and into the database.
 *
 * capture.js is checked against markup and recorder.js against the store;
 * this joins them, walking the sequence a person actually produces - load
 * the clip, type, record, type more, record, submit, reload the graded page,
 * come back to it later - and then asks whether the database says what
 * happened.
 *
 * Everything but the chrome messaging is real: the same page functions, the
 * same recorder, the same store. Only the transport is missing.
 *
 *     node lcwo-tools/test/run.js flow
 */
'use strict';

const fs = require('fs');
const {same, near} = require('./harness.js');
const {documentFrom} = require('./dom.js');
const {memoryBackend} = require('./memory.js');
const store = require('../src/data/store.js');
const rollup = require('../src/core/rollup.js');
const recorder = require('../src/data/recorder.js');
const {readExerciseInPage, readGradedInPage, readStateInPage} =
  require('../src/ext/capture.js');

const FIXTURES = __dirname + '/fixtures/';
const page = name => {
  global.document = documentFrom(fs.readFileSync(FIXTURES + name, 'utf8'));
  global.location = {href: 'https://lcwo.net/groups'};
  return global.document;
};
const type = text => { document.getElementById('textinput').attrs.value = text; };

/* What the bar does on load: pick the grading up, but only in the state
   submitting leaves you in. */
async function onLoad(db) {
  const state = readStateInPage();
  if (state.result && !state.exercise) {
    return {kind: 'result', outcome: await recorder.recordResult(db, readGradedInPage())};
  }
  return {kind: state.exercise ? 'exercise' : 'nothing'};
}

exports.run = async function (check) {
  const db = memoryBackend();
  await store.createOperator(db, 'Test Op', 'W0TST');

  /* ---------- the clip loads ---------- */
  page('groups-exercise.html');
  let load = await onLoad(db);
  check('an exercise page is not mistaken for a finished one', load.kind === 'exercise');
  // it carries the previous attempt's table, which must not be recorded
  check('the stale result on it is left alone', (await store.liveRuns(db)).length === 0);

  let ctx = await recorder.context(db, {key: readExerciseInPage().key});
  check('the bar knows who is copying', ctx.operator.callsign === 'W0TST');
  check('and that this clip has not been started', ctx.session === null && ctx.nextRun === 1);

  /* ---------- a first, partial attempt ---------- */
  type('mno pq. stu');
  let r = await recorder.recordRun(db, readExerciseInPage());
  check('recording the first run starts a session', r.ok && r.startedSession);
  check('it is run one', r.run === 1);

  /* ---------- play it again, copy more of it ---------- */
  type('mno pqr stu vw.');
  r = await recorder.recordRun(db, readExerciseInPage());
  check('a second copy of the same clip is run two, same session',
        r.run === 2 && !r.startedSession);
  check('one session so far', (await store.liveSessions(db)).length === 1);

  ctx = await recorder.context(db, {key: readExerciseInPage().key});
  check('the bar counts the runs', ctx.runs === 2 && ctx.nextRun === 3);

  /* ---------- submit: LCWO grades it ---------- */
  page('groups-graded.html');
  load = await onLoad(db);
  check('the graded page is recognised', load.kind === 'result');
  check('and the result stored', load.outcome.ok && !load.outcome.skipped);
  check('as the third run of the same session', load.outcome.run === 3);
  check('which is now closed', load.outcome.closed);

  /* ---------- reload it, come back to it ---------- */
  page('groups-graded.html');
  const again = await onLoad(db);
  check('reloading the graded page records nothing further',
        again.outcome.skipped === 'already recorded');
  check('still three runs', (await store.liveRuns(db)).length === 3);
  page('groups-exercise.html');
  await onLoad(db);
  check('and going back to an exercise page does not either',
        (await store.liveRuns(db)).length === 3);

  /* ---------- what is in the database ---------- */
  const gid = (await store.liveGroups(db))[0].id;
  const view = rollup.groupView(await store.loadGroup(db, gid));
  check('one group', (await store.liveGroups(db)).length === 1);
  check('named for the first assignment', view.label === 'S1HW1');
  check('holding one session', view.sessions.length === 1);
  check('of three runs', view.sessions[0].runs.length === 3);
  check('the last of which is final',
        same(view.sessions[0].runs.map(x => x.is_final), [0, 0, 1]));
  check('the session carries the speed LCWO reported',
        view.sessions[0].char_wpm === 25 && view.sessions[0].eff_wpm === 8);
  check('and the key it was sent',
        same(view.sessions[0].key, ['MNO', 'PQR', 'STU', 'VWX']));

  /* every run grades, including the ones recorded before submitting */
  check('all three runs are graded', view.gradedRuns.length === 3);
  const [one, two, three] = view.sessions[0].runs;
  // three groups copied clean but for R, and the fourth never reached
  check('the first attempt left the last group entirely uncopied',
        one.grade.totalChars === 12 && one.grade.wrongChars === 4);
  check('the second got further', two.grade.wrongChars === 1);
  check('and the graded one matches what LCWO said',
        three.grade.wrongChars === 5 && three.grade.disagreements.length === 0);
  check('the best run is the second, not the last',
        view.sessions[0].best.seq === 2);

  /* the numbers the report and the trouble list are built from */
  const counts = rollup.counts([view]);
  check('misses add up across every run',
        same(counts.miss, {R: 2, T: 1, V: 2, W: 2, X: 3}),
        JSON.stringify(counts.miss));
  check('the substitution is recorded as a confusion',
        same(counts.confusions, {'T>X': 1}));
  check('a day of practice is on the books', rollup.practiceDays([view]).length === 1);
  check('and characters missed twice are trouble',
        same(rollup.troubleFrom(counts.miss).map(t => t.char), ['X', 'R', 'V', 'W']));

  /* ---------- a new clip, same sitting ---------- */
  const doc = page('groups-exercise.html');
  doc.querySelector('[name=text]').attrs.value = 'AAA BBB CCC';
  type('aaa bbb ccc');
  r = await recorder.recordRun(db, readExerciseInPage());
  check('a different clip starts a second session', r.startedSession);
  check('in the same group',
        (await store.liveGroups(db)).length === 1
        && (await store.groupSessions(db, gid)).length === 2);
  check('numbered two', (await store.groupSessions(db, gid))[1].seq === 2);
};
