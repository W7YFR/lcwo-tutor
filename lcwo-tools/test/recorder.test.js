/*
 * Turning a page into rows.
 *
 * The cases that matter are the ones a person creates by using a browser
 * normally: reloading a graded page, going back to it, recording the same
 * clip twice, submitting without having recorded anything first.
 *
 *     node lcwo-tools/test/run.js recorder
 */
'use strict';

const {same} = require('./harness.js');
const {memoryBackend} = require('./memory.js');
const store = require('../src/data/store.js');
const rollup = require('../src/core/rollup.js');
const recorder = require('../src/data/recorder.js');

const KEY = ['MNO', 'PQR', 'STU', 'VWX'];
const sigOf = (key, attempt, reported) =>
  [key.join(' '), attempt.join(' '), reported.join('')].join('|');

const exercise = (attempt, key) => ({
  key: key || KEY, attempt: attempt, raw: attempt.join(' ').toLowerCase(),
  charWpm: 25, effWpm: 8, groups: (key || KEY).length,
});

const result = (attempt, reported, key) => ({
  key: key || KEY, attempt: attempt, reported: reported,
  charWpm: 25, effWpm: 8, seconds: 30, groups: (key || KEY).length, chars: 12,
  errors: reported.reduce((a, b) => a + b, 0), mode: 'custom', minutes: 2,
  signature: sigOf(key || KEY, attempt, reported),
});

async function fresh() {
  const db = memoryBackend();
  const oid = await store.createOperator(db, 'Test Op', 'W0TST');
  return {db, oid};
}

exports.run = async function (check) {

  /* ---------- nothing on file yet ---------- */
  {
    const db = memoryBackend();
    const r = await recorder.recordRun(db, exercise(['MNO']));
    check('with no operator it refuses rather than inventing one',
          !r.ok && /no operator/.test(r.error));
    check('and so does recording a result',
          !(await recorder.recordResult(db, result(['MNO'], [0]))).ok);
  }

  /* ---------- the ordinary path: play, type, submit ---------- */
  {
    const {db, oid} = await fresh();
    const r = await recorder.recordResult(db, result(['MNO', 'PQR', 'ST.', 'VWX'],
                                                     [0, 0, 1, 0]));
    check('submitting with nothing recorded first still works', r.ok);
    check('it starts a group, since there was none', r.startedSession);
    check('the group is named for the first assignment',
          (await store.liveGroups(db, oid))[0].label === 'S1HW1');
    check('and the session is closed by the result', r.closed);

    const s = await store.getGroup(db, (await store.liveGroups(db, oid))[0].id);
    const view = rollup.groupView(await store.loadGroup(db, s.id));
    check('one session, one run', view.sessions.length === 1
          && view.sessions[0].runs.length === 1);
    check('the run is final', view.sessions[0].runs[0].is_final === 1);
    check('and it grades against the key it arrived with',
          view.gradedRuns.length === 1 && rollup.counts([view]).miss['U'] === 1);
    check('the speed LCWO reported is on the session',
          view.sessions[0].char_wpm === 25 && view.sessions[0].eff_wpm === 8);
  }

  /* ---------- a reload must not record it again ---------- */
  {
    const {db} = await fresh();
    const res = result(['MNO', 'PQR', 'STU', 'VWX'], [0, 0, 0, 0]);
    const first = await recorder.recordResult(db, res);
    const again = await recorder.recordResult(db, res);
    check('the same result a second time is skipped',
          again.ok && again.skipped === 'already recorded');
    check('and points at the run already stored', again.runId === first.runId);
    check('so there is still only one run', (await store.liveRuns(db)).length === 1);

    // going back to the page after starting another clip: same thing
    await recorder.recordResult(db, result(['AAA'], [0], ['AAA']));
    check('a different clip does record', (await store.liveRuns(db)).length === 2);
    check('and revisiting the first still does not',
          (await recorder.recordResult(db, res)).skipped === 'already recorded'
          && (await store.liveRuns(db)).length === 2);
  }

  /* ---------- recording runs before submitting ---------- */
  {
    const {db, oid} = await fresh();
    const a = await recorder.recordRun(db, exercise(['MNO', 'PQ.']));
    check('the first run starts a session', a.ok && a.startedSession && a.run === 1);
    const b = await recorder.recordRun(db, exercise(['MNO', 'PQR', 'ST.']));
    check('a second attempt at the same clip is another run, not another session',
          b.ok && !b.startedSession && b.run === 2 && b.sessionId === a.sessionId);
    check('there is one session', (await store.liveSessions(db)).length === 1);

    // the key is known from the start, so runs grade as they are recorded
    const gid = (await store.liveGroups(db, oid))[0].id;
    let view = rollup.groupView(await store.loadGroup(db, gid));
    check('runs grade before anything has been submitted',
          view.gradedRuns.length === 2);
    check('a short attempt counts the groups never reached as missed',
          view.sessions[0].runs[0].grade.wrongChars === 7);

    const r = await recorder.recordResult(db, result(['MNO', 'PQR', 'STU', 'VW.'],
                                                     [0, 0, 0, 1]));
    check('submitting adds the final run to that same session',
          r.ok && r.sessionId === a.sessionId && r.run === 3);
    view = rollup.groupView(await store.loadGroup(db, gid));
    check('all three runs are in one session', view.sessions[0].runs.length === 3);
    check('and the session is closed', !!view.sessions[0].ended_at);
    check('only the last is marked final',
          view.sessions[0].runs.filter(x => x.is_final).length === 1);
    check('what you typed is kept alongside the parsed groups',
          view.sessions[0].runs[0].raw_paste === 'mno pq.');

    // a new clip after that one starts a new session in the same group
    const next = await recorder.recordRun(db, exercise(['ABC'], ['ABC', 'DEF']));
    check('a different clip starts a new session',
          next.startedSession && next.sessionId !== a.sessionId);
    view = rollup.groupView(await store.loadGroup(db, gid));
    check('in the same group', view.sessions.length === 2);
    check('numbered in order', same(view.sessions.map(s => s.seq), [1, 2]));
  }

  /* ---------- refusals ---------- */
  {
    const {db} = await fresh();
    check('an empty page is not a run',
          !(await recorder.recordRun(db, {key: [], attempt: []})).ok);
    check('nor is a clip you have not typed into',
          /nothing typed/.test((await recorder.recordRun(db, exercise([]))).error));
    check('and a result needs groups',
          !(await recorder.recordResult(db, {key: [], attempt: []})).ok);
  }

  /* ---------- which group it lands in ---------- */
  {
    const {db, oid} = await fresh();
    await recorder.recordRun(db, exercise(['MNO']));
    const first = (await store.liveGroups(db, oid))[0];

    await recorder.recordRun(db, exercise(['AAA'], ['AAA']));
    check('later clips join the group already open',
          (await store.liveGroups(db, oid)).length === 1);

    await store.closeGroup(db, first.id);
    await recorder.recordRun(db, exercise(['BBB'], ['BBB']));
    const groups = await store.liveGroups(db, oid);
    check('once that group is closed, a new one is started', groups.length === 2);
    check('carrying the next assignment number',
          same(groups.map(g => g.label), ['S1HW1', 'S1HW2']));
    check('a closed group is never quietly reopened', !!(await store.getGroup(db, first.id)).closed_at);

    const made = await recorder.newGroup(db);
    check('asking for a new one suggests the number after that',
          made.ok && made.label === 'S1HW3');
    check('and it becomes the one being recorded into',
          (await recorder.context(db, {})).group.id === made.gid);
    const named = await recorder.newGroup(db, 'warm-up');
    check('a name of your own is kept', named.label === 'warm-up');
    check('switching back to an earlier open group sticks',
          (await recorder.useGroup(db, groups[1].id)).ok
          && (await recorder.context(db, {})).group.id === groups[1].id);
    check('switching to one that is not there fails',
          !(await recorder.useGroup(db, 9999)).ok);
    // saying ok and then recording somewhere else is worse than refusing
    check('and switching to a closed one is refused, not silently ignored',
          !(await recorder.useGroup(db, first.id)).ok
          && (await recorder.context(db, {})).group.id === groups[1].id);
    check('the suggestion follows the highest number, ignoring free-form names',
          await recorder.suggestLabel(db) === 'S2HW1');
  }

  /* ---------- what the bar shows ---------- */
  {
    const {db, oid} = await fresh();
    let ctx = await recorder.context(db, {key: KEY});
    check('before anything, there is an operator and no session',
          ctx.operator.callsign === 'W0TST' && ctx.session === null);
    check('and the next run would be the first', ctx.nextRun === 1);
    check('in the first session of the group', ctx.nextSession === 1);

    await recorder.recordRun(db, exercise(['MNO']));
    ctx = await recorder.context(db, {key: KEY});
    check('once recording has started the session shows', !!ctx.session);
    check('with the run count', ctx.runs === 1 && ctx.nextRun === 2);
    check('and its number in the group', ctx.session.seq === 1 && ctx.nextSession === 1);
    check('and the group it is in', ctx.group.label === 'S1HW1');
    check('open groups are offered for switching', ctx.openGroups.length === 1);

    await recorder.recordResult(db, result(['MNO', 'PQR', 'STU', 'VWX'], [0, 0, 0, 0]));
    ctx = await recorder.context(db, {key: KEY});
    check('a closed session is no longer the open one for that key',
          ctx.session === null && ctx.nextRun === 1);
    check('but the group is still where recording would go',
          ctx.group.label === 'S1HW1');
    check('and the next clip would be its second session', ctx.nextSession === 2);

    // the graded page still names the finished session until the next clip
    const graded = await recorder.context(db, {key: KEY, finished: true});
    check('a graded page keeps its session', graded.session && graded.session.seq === 1
          && graded.nextSession === 1);
    check('and names the final run rather than a next one',
          graded.runs === 2 && graded.run === 2);
    check('an exercise page names the run about to be recorded', ctx.run === 1);

    // a page with no exercise on it still describes where you are
    const bare = await recorder.context(db, {});
    check('a page with no clip still names the group', bare.group.label === 'S1HW1');
    check('and has no session', bare.session === null);

    check('an operator with nothing on file has no group',
          (await recorder.context(memoryBackend(), {})).operator === null);
    check('scoping is per operator', ctx.operator.id === oid);
  }

  /* ---------- the bar has to name where a run really lands ---------- */
  //
  // The case that caught this: every assignment closed except one left open
  // a week earlier. The bar listed that stale group and selected it, while
  // recording would have created a new one - so it named a destination the
  // data was not going to.
  {
    const {db, oid} = await fresh();
    const stale = await store.createGroup(db, {
      operator_id: oid, assignment: 'S2HW3', label: 'S2HW3',
      created_at: '2026-09-10T17:00:00-07:00'});
    const recent = await store.createGroup(db, {
      operator_id: oid, assignment: 'S4HW3', label: 'S4HW3',
      created_at: '2026-09-17T17:00:00-07:00'});
    const s = await store.startSession(db, await store.getGroup(db, recent),
                                       {started_at: '2026-09-17T17:30:00-07:00'});
    await store.addRun(db, s.id, ['AB']);
    await store.closeGroup(db, recent);

    let ctx = await recorder.context(db, {});
    check('with the latest assignment closed, the target is a new one',
          ctx.target.kind === 'new' && ctx.target.label === 'S5HW1',
          JSON.stringify(ctx.target));
    check('a stale open group is listed but is not the target',
          same(ctx.openGroups.map(g => g.label), ['S2HW3']) && ctx.group === null);
    // dumping today's practice into a week-old assignment would be worse
    // than starting the one you are actually on
    check('and recording really does go to the new one',
          (await recorder.targetGroup(db, oid, {})).label === 'S5HW1');
    // that call created it, so S5HW1 is on file from here on

    check('closed assignments are listed too, most recent first',
          same(ctx.closedGroups.map(g => g.label), ['S4HW3']));
    check('the suggestion is offered for the bar to label the option',
          ctx.suggestion === 'S5HW1');

    const back = await recorder.reopenGroup(db, recent);
    check('reopening one brings it back', back.ok && back.reopened);
    ctx = await recorder.context(db, {});
    check('and it becomes the target',
          ctx.target.kind === 'group' && ctx.target.label === 'S4HW3');
    check('now listed as open', same(ctx.openGroups.map(g => g.label).sort(),
                                     ['S2HW3', 'S4HW3', 'S5HW1']),
          ctx.openGroups.map(g => g.label).join(','));
    check('and no longer as closed', ctx.closedGroups.length === 0);
    check('a run lands there', (await recorder.targetGroup(db, oid, {})).id === recent);
    check('reopening one that is already open just selects it',
          (await recorder.reopenGroup(db, stale)).reopened === false
          && (await recorder.context(db, {})).target.id === stale);
    check('reopening something that is not there fails',
          !(await recorder.reopenGroup(db, 9999)).ok);
  }

  /* ---------- finishing an assignment ---------- */
  //
  // There was no way to do this from the browser at all: the CLI only ever
  // closed a group at the end of `record`, so an assignment left open stayed
  // open and kept collecting runs.
  {
    const {db, oid} = await fresh();
    await recorder.recordRun(db, exercise(['MNO']));
    const gid = (await store.liveGroups(db, oid))[0].id;
    check('it starts open', !(await store.getGroup(db, gid)).closed_at);
    check('and is where runs go',
          (await recorder.context(db, {})).target.id === gid);

    const done = await recorder.closeGroup(db, gid);
    check('closing it reports the assignment finished',
          done.ok && done.label === 'S1HW1');
    check('it is closed', !!(await store.getGroup(db, gid)).closed_at);
    const ctx = await recorder.context(db, {});
    check('and the next run starts the following assignment',
          ctx.target.kind === 'new' && ctx.target.label === 'S1HW2');
    check('it shows up under the closed ones',
          same(ctx.closedGroups.map(g => g.label), ['S1HW1']));

    // the setting pointed at it, and a stale pointer would resolve through a
    // closed group on every later run
    check('nothing is left pointing at it',
          await store.getSetting(db, 'group_id') === null);
    check('closing it twice is harmless',
          (await recorder.closeGroup(db, gid)).already === true);
    check('closing something that is not there fails',
          !(await recorder.closeGroup(db, 9999)).ok);

    // its runs are untouched; closing says "no more go here", nothing else
    check('the work inside it is still there',
          (await store.groupSessions(db, gid)).length === 1
          && (await store.liveRuns(db)).length === 1);
    check('and reopening puts it back in service',
          (await recorder.reopenGroup(db, gid)).reopened
          && (await recorder.context(db, {})).target.id === gid);
  }
};
