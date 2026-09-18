/*
 * The data layer, against an in-memory backend.
 *
 * All of it runs in node because store.js never touches IndexedDB - it talks
 * to the five-method backend in schema.js, and idb.js is the only file that
 * knows the difference.
 *
 *     node lcwo-tools/test/run.js store
 */
'use strict';

const {same} = require('./harness.js');
const {memoryBackend} = require('./memory.js');
const store = require('../src/data/store.js');
const rollup = require('../src/core/rollup.js');

const DAY = '2026-04-05T09:00:00-07:00';
const at = (n, h) => '2026-04-0' + n + 'T' + String(h || 9).padStart(2, '0') + ':00:00-07:00';

/* An operator with one group, ready to take sessions. */
async function fixture(opts) {
  const o = opts || {};
  const db = memoryBackend();
  const oid = await store.createOperator(db, 'Test Op', 'W0TST', {created_at: DAY});
  const gid = await store.createGroup(db, Object.assign({
    operator_id: oid, assignment: 'S1HW1', mode: 'letters',
    char_wpm: 25, eff_wpm: 8, created_at: DAY,
  }, o.group || {}));
  return {db, oid, gid};
}

exports.run = async function (check) {

  /* ---------- the backend contract ---------- */
  {
    const db = memoryBackend();
    const id = await db.put('groups', {assignment: 'S1HW1'});
    check('put hands back an id', id === 1);
    check('and the next one is different', await db.put('groups', {assignment: 'x'}) === 2);
    const rec = await db.get('groups', id);
    rec.assignment = 'mutated';
    check('a record read out is a copy, as it is in IndexedDB',
          (await db.get('groups', id)).assignment === 'S1HW1');
    check('a missing record is undefined', await db.get('groups', 99) === undefined);
    await db.put('groups', {id: 50, assignment: 'imported'});
    check('an explicit id is kept', (await db.get('groups', 50)).assignment === 'imported');
    check('and ids handed out afterwards do not collide with it',
          await db.put('groups', {assignment: 'next'}) === 51);
    await db.del('groups', 50);
    check('del removes it', await db.get('groups', 50) === undefined);
    await db.clear('groups');
    check('clear empties the store', (await db.all('groups')).length === 0);
    check('an index can be queried',
          (await db.all('groups', {index: 'by_operator', only: 1})).length === 0);
  }

  /* ---------- settings ---------- */
  {
    const db = memoryBackend();
    check('an unset setting is null', await store.getSetting(db, 'nope') === null);
    check('with a fallback if you want one',
          await store.getSetting(db, 'nope', 'x') === 'x');
    await store.setSetting(db, 'operator_id', 7);
    check('a setting comes back as a string', await store.getSetting(db, 'operator_id') === '7');
    await store.setSetting(db, 'operator_id', 9);
    check('and writing it again replaces it',
          await store.getSetting(db, 'operator_id') === '9'
          && (await db.all('settings')).length === 1);
  }

  /* ---------- operators ---------- */
  {
    const db = memoryBackend();
    const oid = await store.createOperator(db, ' Robert Reed ', ' w7 yfr ');
    const op = await store.getOperator(db, oid);
    check('call sign normalized', op.callsign === 'W7YFR');
    check('and the name trimmed', op.name === 'Robert Reed');
    let threw = null;
    try { await store.createOperator(db, 'Someone', 'w7yfr'); } catch (e) { threw = e; }
    check('the same call sign cannot be added twice', !!threw);
    for (const bad of [['', 'W0X'], ['Name', ''], [null, null]]) {
      let e2 = null;
      try { await store.createOperator(db, bad[0], bad[1]); } catch (e) { e2 = e; }
      check('an operator needs a name and a call sign (' + JSON.stringify(bad) + ')', !!e2);
    }

    check('found by id', (await store.findOperator(db, oid)).id === oid);
    check('found by call sign', (await store.findOperator(db, 'w7yfr')).id === oid);
    check('found by name', (await store.findOperator(db, 'robert reed')).id === oid);
    check('and not found when it is not there', await store.findOperator(db, 'K0NONE') === null);
    check('nothing asked for, nothing found', await store.findOperator(db, '') === null);
    check('an operator reads as name and call sign',
          store.opLabel(await store.getOperator(db, oid)) === 'Robert Reed - W7YFR');

    check('the only operator becomes current', (await store.currentOperator(db)).id === oid);
    const other = await store.createOperator(db, 'Other Op', 'K0OTH');
    check('current stays put when a second appears',
          (await store.currentOperator(db)).id === oid);
    await store.setCurrentOperator(db, other);
    check('switching operator sticks', (await store.currentOperator(db)).id === other);

    /* groups from before operators existed belong to whoever adopts them */
    await store.createGroup(db, {assignment: 'old', created_at: DAY});
    check('an unowned group is nobody\'s', (await store.liveGroups(db, oid)).length === 0);
    check('adopting claims the older groups', await store.adoptUnassigned(db, oid) === 1);
    check('and it is theirs afterwards', (await store.liveGroups(db, oid)).length === 1);
    check('adopting again finds nothing left', await store.adoptUnassigned(db, oid) === 0);
  }

  /* ---------- scoping ---------- */
  {
    const db = memoryBackend();
    const mine = await store.createOperator(db, 'Mine', 'W0ME');
    const yours = await store.createOperator(db, 'Yours', 'W0YOU');
    const g1 = await store.createGroup(db, {operator_id: mine, assignment: 'S1HW1', created_at: at(1)});
    await store.createGroup(db, {operator_id: yours, assignment: 'S9HW1', created_at: at(2)});
    check('listings are scoped to one operator',
          same((await store.liveGroups(db, mine)).map(g => g.id), [g1]));
    check('the other operator cannot see it',
          !(await store.liveGroups(db, yours)).some(g => g.id === g1));
    check('unscoped listings still see everyone', (await store.liveGroups(db)).length === 2);
    check('the next-assignment suggestion is per operator too',
          (await store.liveGroups(db, yours)).map(g => g.assignment).join() === 'S9HW1');
    const counts = await store.operatorCounts(db, mine);
    check('and so are the counts', same(counts, {groups: 1, sessions: 0, runs: 0}));
  }

  /* ---------- groups ---------- */
  {
    const {db, oid, gid} = await fixture();
    check('a group defaults its label to the assignment',
          (await store.getGroup(db, gid)).label === 'S1HW1');
    check('a group starts open', !(await store.getGroup(db, gid)).closed_at);
    await store.closeGroup(db, gid);
    check('closing stamps it', !!(await store.getGroup(db, gid)).closed_at);
    check('and it drops out of the open list', (await store.openGroups(db, oid)).length === 0);
    await store.reopenGroup(db, gid);
    check('reopen clears closed_at', !(await store.getGroup(db, gid)).closed_at);
    check('and it is back in the open list', (await store.openGroups(db, oid)).length === 1);

    /* the most recently worked group, not the most recently made one */
    const older = await store.createGroup(db, {operator_id: oid, assignment: 'S1HW0',
                                               created_at: at(1)});
    check('last_group finds the recent group', (await store.lastGroup(db, oid)).id === gid);
    await store.startSession(db, await store.getGroup(db, older), {started_at: at(9)});
    check('last_group follows the newer activity', (await store.lastGroup(db, oid)).id === older);
    await store.closeGroup(db, older);
    check('last_group still finds a closed group', (await store.lastGroup(db, oid)).id === older);
    check('nothing on file, nothing to find',
          await store.lastGroup(db, 999) === null);
  }

  /* ---------- sessions and runs ---------- */
  {
    const {db, oid, gid} = await fixture();
    let grp = await store.getGroup(db, gid);
    const s1 = await store.startSession(db, grp, {started_at: at(1)});
    check('sessions number from one', s1.seq === 1);
    check('group inherits the first session\'s settings',
          s1.char_wpm === 25 && s1.eff_wpm === 8 && s1.mode === 'letters');
    check('and the assignment comes with it', s1.assignment === 'S1HW1');

    /* a second session at a different speed and drill */
    grp = await store.getGroup(db, gid);
    const s2 = await store.startSession(db, grp, {mode: 'code_group', char_wpm: 22, eff_wpm: 10,
                                                  started_at: at(2)});
    check('sessions keep counting up', s2.seq === 2);
    check('one group holds two drills', s1.mode !== s2.mode);
    check('each session keeps its own speed',
          (await db.get('sessions', s1.id)).char_wpm === 25 && s2.char_wpm === 22);
    grp = await store.getGroup(db, gid);
    check('group default follows the latest session',
          grp.char_wpm === 22 && grp.eff_wpm === 10 && grp.mode === 'code_group');

    const last = await store.lastSettings(db, oid);
    check('last settings come from the most recent session',
          same(last, {mode: 'code_group', char_wpm: 22, eff_wpm: 10}));
    await store.startSession(db, grp, {char_wpm: 18, eff_wpm: 18, started_at: at(3)});
    check('and follow the newest one', (await store.lastSettings(db, oid)).char_wpm === 18);
    check('a session with no speed on file is skipped',
          (await store.lastSettings(db, 999)) === null);

    /* runs */
    const r1 = await store.addRun(db, s1.id, ['EH', 'SM', '.R']);
    check('runs number from one within a session',
          (await db.get('runs', r1)).seq === 1);
    check('a run is not final unless it says so', (await db.get('runs', r1)).is_final === 0);
    const r2 = await store.addRun(db, s1.id, ['EH', 'SM', 'TR'],
                                  {is_final: true, reported: [0, 0, 0], source: 'capture'});
    check('runs keep counting up', (await db.get('runs', r2)).seq === 2);
    check('the final run says so', (await db.get('runs', r2)).is_final === 1);
    check('LCWO\'s own error counts are kept',
          same((await db.get('runs', r2)).reported, [0, 0, 0]));
    check('and where the run came from', (await db.get('runs', r2)).source === 'capture');
    check('a run stores a copy of the attempt, not the caller\'s array',
          (await db.get('runs', r1)).attempt.length === 3);

    check('a session has no key until it is finished', !(await db.get('sessions', s1.id)).key);
    await store.finishSession(db, s1.id, ['EH', 'SM', 'TR']);
    const done = await db.get('sessions', s1.id);
    check('finishing stores the key', same(done.key, ['EH', 'SM', 'TR']));
    check('and stamps the end', !!done.ended_at);
  }

  /* ---------- loading and grading together ---------- */
  {
    const {db, gid} = await fixture();
    const s = await store.startSession(db, await store.getGroup(db, gid));
    await store.addRun(db, s.id, ['EH', 'SM', '.R'], {recorded_at: at(1)});
    await store.addRun(db, s.id, ['EH', 'SM', 'TR'], {is_final: true, recorded_at: at(1, 10)});
    await store.finishSession(db, s.id, ['EH', 'SM', 'TR']);

    const view = rollup.groupView(await store.loadGroup(db, gid));
    check('session loaded', view.sessions.length === 1 && view.sessions[0].runs.length === 2);
    check('earlier run graded retroactively', view.gradedRuns.length === 2);
    check('the miss in the first run is counted',
          rollup.counts([view]).miss['T'] === 1);

    /* R missed twice across two runs is trouble; once is not */
    const s2 = await store.startSession(db, await store.getGroup(db, gid), {started_at: at(2)});
    await store.addRun(db, s2.id, ['T.'], {recorded_at: at(2)});
    await store.addRun(db, s2.id, ['T.'], {is_final: true, recorded_at: at(2, 10)});
    await store.finishSession(db, s2.id, ['TR']);
    const views = [rollup.groupView(await store.loadGroup(db, gid))];
    check('R missed twice -> trouble',
          rollup.troubleFrom(rollup.counts(views).miss).map(t => t.char).join('') === 'R');

    check('loading a group that is not there is an error',
          await store.loadGroup(db, 999).then(() => false, () => true));
    check('loadAll walks every group', (await store.loadAll(db)).length === 1);
  }

  /* ---------- the bin ---------- */
  {
    const {db, oid, gid} = await fixture();
    const s = await store.startSession(db, await store.getGroup(db, gid));
    const r1 = await store.addRun(db, s.id, ['EH']);
    const r2 = await store.addRun(db, s.id, ['EH'], {is_final: true});
    await store.finishSession(db, s.id, ['EH']);

    const binned = await store.binRecord(db, 'group', gid);
    check('binning stamps a time', binned.changed && !!binned.at);
    check('binned group hidden from listings', (await store.liveGroups(db, oid)).length === 0);
    check('binned group hidden from getGroup', await store.getGroup(db, gid) === null);
    check('binned group still fetchable for restore',
          (await store.getGroupAny(db, gid)).id === gid);
    check('binned group\'s rows stay on disk', (await db.all('runs')).length === 2);
    // hiding is by containment: the session and runs were never touched
    check('binned group\'s sessions hidden', (await store.liveSessions(db)).length === 0);
    check('binned group\'s runs hidden by containment', (await store.liveRuns(db)).length === 0);
    check('and their own deleted_at is still empty',
          !(await db.get('sessions', s.id)).deleted_at);
    check('binning it again changes nothing',
          !(await store.binRecord(db, 'group', gid)).changed);
    check('binned group absent from the report payload',
          (await store.loadAll(db, oid)).length === 0);

    const back = await store.restoreRecord(db, 'group', gid);
    check('restore brings the group back', back.changed && !!(await store.getGroup(db, gid)));
    check('restore brings its runs back', (await store.liveRuns(db)).length === 2);
    check('restoring something that was not binned says so',
          !(await store.restoreRecord(db, 'group', gid)).changed);

    /* a single run, inside a live session */
    await store.binRecord(db, 'run', r1);
    check('binned run hidden, session still live',
          (await store.liveRuns(db)).length === 1
          && (await store.liveSessions(db)).length === 1);
    check('and the session still grades on what is left',
          rollup.groupView(await store.loadGroup(db, gid)).gradedRuns.length === 1);

    /* a child stays hidden while its parent is still binned */
    await store.binRecord(db, 'session', s.id);
    const blocked = await store.restoreRecord(db, 'run', r1);
    check('restoring a run inside a binned session warns about the parent',
          blocked.changed && same(blocked.blockedBy, {kind: 'session', id: s.id}));
    await store.restoreRecord(db, 'session', s.id);
    await store.binRecord(db, 'group', gid);
    const blocked2 = await store.restoreRecord(db, 'run', r2);
    check('and looks past the session to the group',
          same(blocked2.blockedBy, {kind: 'group', id: gid}));
    await store.restoreRecord(db, 'group', gid);

    const list = await store.trash(db);
    check('the bin lists what is in it, oldest first',
          list.length === 0 || list.every((x, i) => !i || list[i - 1].at <= x.at));
    check('an empty bin is empty', (await store.trash(db)).length === 0);

    /* purge */
    await store.binRecord(db, 'run', r1);
    await store.binRecord(db, 'group', gid);
    check('the bin holds both', (await store.trash(db)).length === 2);
    const gone = await store.purge(db);
    check('purge removes the rows for good',
          gone.group === 1 && gone.run >= 1 && (await db.all('groups')).length === 0);
    check('purge left no orphans',
          (await db.all('sessions')).length === 0 && (await db.all('runs')).length === 0);
    check('and the bin is empty afterwards', (await store.trash(db)).length === 0);
    check('purging an empty bin is harmless',
          same(await store.purge(db), {group: 0, session: 0, run: 0}));
  }

  /* ---------- prune ---------- */
  {
    const {db, gid} = await fixture();
    const kept = await store.startSession(db, await store.getGroup(db, gid));
    await store.addRun(db, kept.id, ['EH']);
    const empty = await store.startSession(db, await store.getGroup(db, gid),
                                           {started_at: at(2)});
    const emptyGroup = await store.createGroup(db, {assignment: 'abandoned', created_at: at(3)});

    const pruned = await store.pruneEmpty(db);
    check('prune removes the empty session and group',
          same(pruned, {sessions: 1, groups: 1}));
    check('the empty session is gone', await db.get('sessions', empty.id) === undefined);
    check('the empty group is gone', await db.get('groups', emptyGroup) === undefined);
    check('prune kept every run', (await db.all('runs')).length === 1);
    check('populated group survives prune', !!(await store.getGroup(db, gid)));
    check('prune is idempotent', same(await store.pruneEmpty(db), {sessions: 0, groups: 0}));

    /* the bin is not tidied away: things are in there on purpose */
    const binnedEmpty = await store.startSession(db, await store.getGroup(db, gid),
                                                 {started_at: at(4)});
    await store.binRecord(db, 'session', binnedEmpty.id);
    check('prune leaves binned rows alone',
          same(await store.pruneEmpty(db), {sessions: 0, groups: 0})
          && !!(await db.get('sessions', binnedEmpty.id)));
  }

  /* ---------- export and import ---------- */
  {
    const {db, oid, gid} = await fixture();
    const s = await store.startSession(db, await store.getGroup(db, gid));
    await store.addRun(db, s.id, ['EH', 'SM', '.R'], {recorded_at: at(1)});
    await store.addRun(db, s.id, ['EH', 'SM', 'TR'], {is_final: true, recorded_at: at(1, 10)});
    await store.finishSession(db, s.id, ['EH', 'SM', 'TR']);
    await store.setCurrentOperator(db, oid);

    const out = await store.dump(db);
    check('an export says what it is', out.format === 'lcwo-export' && out.version === 1);
    check('and when it was taken', !!out.exported_at);
    check('it carries every record',
          out.records.operators.length === 1 && out.records.groups.length === 1
          && out.records.sessions.length === 1 && out.records.runs.length === 2);
    check('including which operator was current',
          out.records.settings.some(r => r.key === 'operator_id'));

    const fresh = memoryBackend();
    const n = await store.load(fresh, JSON.parse(JSON.stringify(out)));
    check('import reports what it loaded', n === 5);
    check('ids survive the round trip, so the rows stay joined up',
          (await store.loadAll(fresh, oid)).length === 1);
    const before = rollup.counts([rollup.groupView(await store.loadGroup(db, gid))]).miss;
    const after = rollup.counts([rollup.groupView(await store.loadGroup(fresh, gid))]).miss;
    check('and it grades to exactly the same numbers', same(before, after));
    check('the current operator comes back too',
          (await store.currentOperator(fresh)).callsign === 'W0TST');

    /* re-importing the same export must not double anything */
    await store.load(fresh, JSON.parse(JSON.stringify(out)));
    check('importing the same export twice is not two databases',
          (await fresh.all('runs')).length === 2 && (await fresh.all('groups')).length === 1);

    check('and something that is not an export is refused',
          await store.load(fresh, {format: 'nope'}).then(() => false, () => true));
  }
};
