/*
 * Every query and mutation, as logic over plain records.
 *
 * Nothing here knows what IndexedDB is: it talks to the five-method backend
 * described in schema.js. That is what makes the whole data layer testable
 * under node, where IndexedDB does not exist.
 *
 * Deleting is soft, and hiding is by containment: a run is hidden when its
 * own, its session's, or its group's `deleted_at` is set. So binning a group
 * is one field write rather than a cascade, and restoring it brings back
 * exactly what was there - the CLI's live_groups / live_sessions / live_runs
 * views, moved to read time.
 */
(function (X, schema, clock, assign) {
  'use strict';

  const nowIso = clock.nowIso;
  const normalizeCall = assign.normalizeCall;

  const byId = (a, b) => a.id - b.id;
  const bySeq = (a, b) => (a.seq - b.seq) || byId(a, b);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /* ---------- settings ---------- */

  async function getSetting(db, key, fallback) {
    const row = await db.get('settings', key);
    return row === undefined || row === null ? (fallback === undefined ? null : fallback)
                                             : row.value;
  }

  async function setSetting(db, key, value) {
    await db.put('settings', {key: key, value: value == null ? null : String(value)});
  }

  /* ---------- operators ---------- */

  async function createOperator(db, name, callsign, opts) {
    opts = opts || {};
    name = String(name || '').trim();
    callsign = normalizeCall(callsign);
    if (!name || !callsign) throw new Error('an operator needs both a name and a call sign');
    const clash = (await db.all('operators')).find(o => o.callsign === callsign);
    if (clash) throw new Error('call sign already on file: ' + callsign);
    return db.put('operators', {
      callsign: callsign, name: name,
      created_at: opts.created_at || nowIso(), notes: opts.notes || null,
    });
  }

  const listOperators = db => db.all('operators').then(rows => rows.sort(byId));

  async function getOperator(db, oid) {
    if (oid == null || oid === '') return null;
    const op = await db.get('operators', Number(oid));
    return op === undefined ? null : op;
  }

  /* By id, then call sign, then name - whatever the caller had to hand. */
  async function findOperator(db, token) {
    if (token == null || token === '') return null;
    const ops = await listOperators(db);
    const n = Number(token);
    if (Number.isInteger(n) && n > 0) {
      const hit = ops.find(o => o.id === n);
      if (hit) return hit;
    }
    const call = normalizeCall(token);
    const byCall = ops.find(o => o.callsign === call);
    if (byCall) return byCall;
    const name = String(token).trim().toLowerCase();
    return ops.find(o => o.name.toLowerCase() === name) || null;
  }

  const opLabel = op => op ? op.name + ' - ' + op.callsign : 'nobody';

  /* Who new groups are recorded for, or null if nobody is on file yet. */
  async function currentOperator(db) {
    const op = await getOperator(db, await getSetting(db, 'operator_id'));
    if (op) return op;
    const ops = await listOperators(db);
    if (ops.length === 1) {  // only one candidate: adopt it rather than asking
      await setCurrentOperator(db, ops[0].id);
      return ops[0];
    }
    return null;
  }

  const setCurrentOperator = (db, oid) => setSetting(db, 'operator_id', oid);

  /* Hand groups recorded before operators existed to their first owner. */
  async function adoptUnassigned(db, oid) {
    const orphans = (await db.all('groups')).filter(g => g.operator_id == null);
    for (const g of orphans) await db.put('groups', Object.assign({}, g, {operator_id: oid}));
    return orphans.length;
  }

  async function operatorCounts(db, oid) {
    const groups = await liveGroups(db, oid);
    const ids = new Set(groups.map(g => g.id));
    const sessions = (await liveSessions(db)).filter(s => ids.has(s.group_id));
    const sids = new Set(sessions.map(s => s.id));
    const runs = (await liveRuns(db)).filter(r => sids.has(r.session_id));
    return {groups: groups.length, sessions: sessions.length, runs: runs.length};
  }

  /* ---------- live filtering ---------- */

  async function liveGroups(db, oid) {
    const rows = (await db.all('groups')).filter(g => !g.deleted_at);
    const mine = oid == null ? rows : rows.filter(g => g.operator_id === Number(oid));
    return mine.sort((a, b) => cmp(a.created_at, b.created_at) || byId(a, b));
  }

  async function liveSessions(db) {
    const live = new Set((await db.all('groups')).filter(g => !g.deleted_at).map(g => g.id));
    return (await db.all('sessions'))
      .filter(s => !s.deleted_at && live.has(s.group_id)).sort(bySeq);
  }

  async function liveRuns(db) {
    const live = new Set((await liveSessions(db)).map(s => s.id));
    return (await db.all('runs'))
      .filter(r => !r.deleted_at && live.has(r.session_id)).sort(bySeq);
  }

  /* ---------- groups ---------- */

  function createGroup(db, fields) {
    const f = fields || {};
    const assignment = f.assignment == null ? '' : String(f.assignment);
    return db.put('groups', {
      operator_id: f.operator_id == null ? null : Number(f.operator_id),
      label: f.label || assignment,
      // mode/speed on a group are only the defaults carried into the next
      // session; each session records its own
      mode: f.mode || null,
      assignment: assignment,
      char_wpm: f.char_wpm == null ? null : f.char_wpm,
      eff_wpm: f.eff_wpm == null ? null : f.eff_wpm,
      created_at: f.created_at || nowIso(),
      closed_at: f.closed_at || null,
      notes: f.notes || null,
      source: f.source || null,
      deleted_at: null,
    });
  }

  async function getGroup(db, gid) {
    const g = await db.get('groups', Number(gid));
    return g === undefined || !g || g.deleted_at ? null : g;
  }

  /* Including binned, for restore and trash listings. */
  async function getGroupAny(db, gid) {
    const g = await db.get('groups', Number(gid));
    return g === undefined ? null : g;
  }

  const openGroups = (db, oid) =>
    liveGroups(db, oid).then(rows => rows.filter(g => !g.closed_at).reverse());

  /* The most recently worked group, open or closed. */
  async function lastGroup(db, oid) {
    const groups = await liveGroups(db, oid);
    if (!groups.length) return null;
    const sessions = await liveSessions(db);
    const latest = {};
    for (const s of sessions) {
      if (!latest[s.group_id] || s.started_at > latest[s.group_id]) {
        latest[s.group_id] = s.started_at;
      }
    }
    const activity = g => latest[g.id] || g.created_at;
    return groups.slice().sort((a, b) =>
      cmp(activity(b), activity(a)) || (b.id - a.id))[0];
  }

  async function updateGroup(db, gid, fields) {
    const g = await getGroupAny(db, gid);
    if (!g) throw new Error('no such group: ' + gid);
    await db.put('groups', Object.assign({}, g, fields));
  }

  const closeGroup = (db, gid, at) => updateGroup(db, gid, {closed_at: at || nowIso()});
  const reopenGroup = (db, gid) => updateGroup(db, gid, {closed_at: null});

  /* ---------- sessions and runs ---------- */

  /*
   * Drill and speed from the most recent session, whichever group it was in.
   * Used to seed a brand-new assignment: the speed you finished at yesterday
   * is nearly always the speed you are starting at today.
   */
  async function lastSettings(db, oid) {
    const mine = new Set((await liveGroups(db, oid)).map(g => g.id));
    const rows = (await liveSessions(db))
      .filter(s => mine.has(s.group_id) && s.char_wpm != null)
      .sort((a, b) => cmp(a.started_at, b.started_at) || byId(a, b));
    if (!rows.length) return null;
    const s = rows[rows.length - 1];
    return {mode: s.mode, char_wpm: s.char_wpm, eff_wpm: s.eff_wpm};
  }

  const nextSeq = (rows, field, id) =>
    rows.filter(r => r[field] === id).reduce((n, r) => Math.max(n, r.seq || 0), 0) + 1;

  /* Binned sessions keep their number, so a restore never collides. */
  const nextSessionSeq = async (db, gid) =>
    nextSeq(await db.all('sessions'), 'group_id', Number(gid));

  async function startSession(db, grp, opts) {
    const o = opts || {};
    const seq = await nextSessionSeq(db, grp.id);
    const mode = o.mode || grp.mode;
    const charWpm = o.char_wpm === undefined ? grp.char_wpm : o.char_wpm;
    const effWpm = o.eff_wpm === undefined ? grp.eff_wpm : o.eff_wpm;
    const id = await db.put('sessions', {
      group_id: grp.id, seq: seq, mode: mode, assignment: grp.assignment,
      char_wpm: charWpm, eff_wpm: effWpm,
      started_at: o.started_at || nowIso(), ended_at: null,
      // captured from the browser the key is known up front, which is what
      // lets every run in the session grade as it is recorded
      key: o.key ? o.key.slice() : null,
      notes: o.notes || null, deleted_at: null,
    });
    // the group carries the latest settings forward as next session's default
    await updateGroup(db, grp.id, {mode: mode, char_wpm: charWpm, eff_wpm: effWpm});
    return db.get('sessions', id);
  }

  async function addRun(db, sid, attempt, opts) {
    const o = opts || {};
    const seq = nextSeq(await db.all('runs'), 'session_id', sid);
    return db.put('runs', {
      session_id: sid, seq: seq,
      is_final: o.is_final ? 1 : 0,
      recorded_at: o.recorded_at || nowIso(),
      attempt: attempt.slice(),
      reported: o.reported == null ? null : o.reported.slice(),
      source: o.source || null,   // 'capture' | 'import' - how it got here
      // identifies the graded result this run came from, so the same one
      // cannot be stored twice when the page is reloaded
      signature: o.signature || null,
      // what you actually typed, before it was split into groups - the same
      // evidence the CLI keeps, so a captured run is no thinner than a pasted one
      raw_paste: o.raw_paste == null ? null : String(o.raw_paste),
      deleted_at: null,
    });
  }

  /* The live session already carrying this key, if there is one.
     A session is one clip, and the clip's groups are its identity: LCWO
     settles them when the page loads, so an attempt at the same key is
     another run rather than another session. */
  async function openSessionForKey(db, key, oid) {
    const open = (await sessionsForKey(db, key, oid)).filter(s => !s.ended_at);
    return open.length ? open[open.length - 1] : null;
  }

  /* The latest session with this key, finished or not: what a graded page
     is showing the result of. */
  async function lastSessionForKey(db, key, oid) {
    const all = await sessionsForKey(db, key, oid);
    return all.length ? all[all.length - 1] : null;
  }

  async function sessionsForKey(db, key, oid) {
    const want = (key || []).join(' ');
    if (!want) return [];
    const mine = new Set((await liveGroups(db, oid)).map(g => g.id));
    return (await liveSessions(db)).filter(
      s => mine.has(s.group_id) && (s.key || []).join(' ') === want);
  }

  /* Has this exact graded result already been stored? The page keeps showing
     a result until it is replaced, and a reload serves it again. */
  async function runBySignature(db, signature) {
    if (!signature) return null;
    return (await liveRuns(db)).find(r => r.signature === signature) || null;
  }

  async function updateSession(db, sid, fields) {
    const s = await db.get('sessions', Number(sid));
    if (!s) throw new Error('no such session: ' + sid);
    await db.put('sessions', Object.assign({}, s, fields));
  }

  const closeSession = (db, sid, at) => updateSession(db, sid, {ended_at: at || nowIso()});

  async function finishSession(db, sid, key, at) {
    const s = await db.get('sessions', Number(sid));
    if (!s) throw new Error('no such session: ' + sid);
    await db.put('sessions', Object.assign({}, s, {
      key: key.slice(), ended_at: at || nowIso(),
    }));
  }

  const groupSessions = (db, gid) =>
    liveSessions(db).then(rows => rows.filter(s => s.group_id === Number(gid)));

  const sessionRuns = (db, sid) =>
    liveRuns(db).then(rows => rows.filter(r => r.session_id === Number(sid)));

  /* ---------- the bin ---------- */

  const KINDS = {group: 'groups', session: 'sessions', run: 'runs'};

  async function binRecord(db, kind, id) {
    const store = KINDS[kind];
    if (!store) throw new Error('not a thing that can be binned: ' + kind);
    const rec = await db.get(store, Number(id));
    if (!rec) throw new Error('no such ' + kind + ': ' + id);
    if (rec.deleted_at) return {changed: false, at: rec.deleted_at};
    const at = nowIso();
    await db.put(store, Object.assign({}, rec, {deleted_at: at}));
    return {changed: true, at: at};
  }

  async function restoreRecord(db, kind, id) {
    const store = KINDS[kind];
    if (!store) throw new Error('not a thing that can be restored: ' + kind);
    const rec = await db.get(store, Number(id));
    if (!rec) throw new Error('no such ' + kind + ': ' + id);
    const was = !!rec.deleted_at;
    if (was) await db.put(store, Object.assign({}, rec, {deleted_at: null}));
    // a child stays hidden while its parent is still binned
    let blocked = null;
    if (kind === 'session') {
      const g = await db.get('groups', rec.group_id);
      if (g && g.deleted_at) blocked = {kind: 'group', id: g.id};
    } else if (kind === 'run') {
      const s = await db.get('sessions', rec.session_id);
      if (s && s.deleted_at) blocked = {kind: 'session', id: s.id};
      else if (s) {
        const g = await db.get('groups', s.group_id);
        if (g && g.deleted_at) blocked = {kind: 'group', id: g.id};
      }
    }
    return {changed: was, blockedBy: blocked};
  }

  async function trash(db) {
    const out = [];
    for (const kind in KINDS) {
      for (const rec of await db.all(KINDS[kind])) {
        if (rec.deleted_at) out.push({kind: kind, id: rec.id, at: rec.deleted_at});
      }
    }
    return out.sort((a, b) => cmp(a.at, b.at) || cmp(a.kind, b.kind) || (a.id - b.id));
  }

  /*
   * Permanently remove everything in the bin. The only destructive call.
   *
   * Parents first, then sweep whatever they orphaned. SQLite gave the CLI
   * this for free through ON DELETE CASCADE; here it has to be written out,
   * and it has to run downwards - removing a group's sessions before the
   * group itself leaves its runs pointing at nothing.
   *
   * Being interrupted half way just leaves fewer rows to purge next time:
   * every pass removes binned rows and anything already orphaned, so running
   * it again finishes the job.
   */
  async function purge(db) {
    const removed = {group: 0, session: 0, run: 0};

    for (const g of await db.all('groups')) {
      if (g.deleted_at) { await db.del('groups', g.id); removed.group++; }
    }
    const groups = new Set((await db.all('groups')).map(g => g.id));
    for (const s of await db.all('sessions')) {
      if (s.deleted_at || !groups.has(s.group_id)) {
        await db.del('sessions', s.id); removed.session++;
      }
    }
    const sessions = new Set((await db.all('sessions')).map(s => s.id));
    for (const r of await db.all('runs')) {
      if (r.deleted_at || !sessions.has(r.session_id)) {
        await db.del('runs', r.id); removed.run++;
      }
    }
    return removed;
  }

  /*
   * Drop sessions with no runs and groups with no sessions.
   *
   * An interrupted recording leaves a session (and possibly a group) holding
   * nothing at all. They carry no data, so clearing them on the way in and out
   * keeps an abandoned start from turning into a permanent empty group.
   * Binned rows are left alone: they are in the bin on purpose.
   */
  async function pruneEmpty(db) {
    const runs = await db.all('runs');
    const haveRuns = new Set(runs.map(r => r.session_id));
    let sessions = 0, groups = 0;
    for (const s of await db.all('sessions')) {
      if (!haveRuns.has(s.id) && !s.deleted_at) { await db.del('sessions', s.id); sessions++; }
    }
    const haveSessions = new Set((await db.all('sessions')).map(s => s.group_id));
    for (const g of await db.all('groups')) {
      if (!haveSessions.has(g.id) && !g.deleted_at) { await db.del('groups', g.id); groups++; }
    }
    return {sessions: sessions, groups: groups};
  }

  /* ---------- loading for the rollups ---------- */

  /* One group as a nested record: group > sessions > runs. rollup.groupView
     grades it. */
  async function loadGroup(db, gid) {
    const g = await getGroup(db, gid);
    if (!g) throw new Error('no such group: ' + gid);
    const sessions = [];
    for (const s of await groupSessions(db, g.id)) {
      sessions.push(Object.assign({}, s, {runs: await sessionRuns(db, s.id)}));
    }
    return Object.assign({}, g, {sessions: sessions});
  }

  async function loadAll(db, oid) {
    const out = [];
    for (const g of await liveGroups(db, oid)) out.push(await loadGroup(db, g.id));
    return out;
  }

  /* ---------- export and import ---------- */

  /*
   * The whole database as one JSON-able object.
   *
   * Export is a deliberate act, not a background job: nothing here runs on a
   * schedule. `exported_at` is what the popup counts days from.
   */
  async function dump(db) {
    const out = {format: 'lcwo-export', version: 1, exported_at: nowIso(), records: {}};
    for (const store of schema.RECORD_STORES) out.records[store] = await db.all(store);
    out.records.settings = await db.all('settings');
    return out;
  }

  /*
   * Load a dump, replacing everything.
   *
   * Ids are kept as they are so groups, sessions and runs stay joined up, and
   * so re-importing the same export twice is the same database rather than a
   * doubled one.
   *
   * A file from a newer version is refused rather than half-read: the failure
   * mode of guessing is a database that looks fine and grades wrong.
   */
  async function load(db, data) {
    if (!data || data.format !== schema.EXPORT_FORMAT) throw new Error('not an lcwo export');
    const version = Number(data.version);
    if (!(version >= 1)) throw new Error('that export does not say what version it is');
    if (version > schema.EXPORT_VERSION) {
      throw new Error('that export was written by a newer version of lcwo (format '
                      + version + ', this reads ' + schema.EXPORT_VERSION + ')');
    }
    const recs = data.records || {};
    const counts = {};
    for (const store of schema.RECORD_STORES.concat(['settings'])) {
      await db.clear(store);
      const rows = recs[store] || [];
      for (const rec of rows) await db.put(store, rec);
      counts[store] = rows.length;
    }
    if (data.exported_at) await setSetting(db, 'imported_from', data.exported_at);
    return counts;
  }

  /* What is in here, for the data page. Counts rows rather than grading them:
     it runs on every page load and nothing here needs the numbers. */
  async function summary(db) {
    const groups = (await db.all('groups')).filter(g => !g.deleted_at);
    const sessions = await liveSessions(db);
    const runs = await liveRuns(db);
    const days = Array.from(new Set(runs.map(r => String(r.recorded_at || '').slice(0, 10))))
      .filter(Boolean).sort();
    return {
      operators: (await db.all('operators')).length,
      groups: groups.length,
      sessions: sessions.length,
      runs: runs.length,
      days: days.length,
      firstDay: days[0] || null,
      lastDay: days.length ? days[days.length - 1] : null,
      binned: (await trash(db)).length,
      importedFrom: await getSetting(db, 'imported_from'),
      exportedAt: await getSetting(db, 'exported_at'),
    };
  }

  /* Days since the last export, or null if there has never been one. Export
     is a deliberate act - this is the nudge, not a scheduler. */
  function daysSinceExport(summaryRow, today) {
    if (!summaryRow || !summaryRow.exportedAt) return null;
    const then = Date.parse(summaryRow.exportedAt);
    if (Number.isNaN(then)) return null;
    const now = today === undefined ? Date.now() : today;
    return Math.max(0, Math.floor((now - then) / 86400000));
  }

  Object.assign(X, {
    getSetting, setSetting,
    createOperator, listOperators, getOperator, findOperator, opLabel,
    nextSessionSeq, lastSessionForKey, currentOperator, setCurrentOperator, adoptUnassigned, operatorCounts,
    liveGroups, liveSessions, liveRuns,
    createGroup, getGroup, getGroupAny, openGroups, lastGroup, updateGroup,
    closeGroup, reopenGroup,
    lastSettings, startSession, addRun, finishSession, groupSessions, sessionRuns,
    openSessionForKey, runBySignature, updateSession, closeSession,
    binRecord, restoreRecord, trash, purge, pruneEmpty,
    loadGroup, loadAll, dump, load, summary, daysSinceExport,
    KINDS,
  });
})(typeof module === 'object' ? module.exports : (self.LCWO.store = {}),
   typeof require === 'function' ? require('./schema.js') : self.LCWO.schema,
   typeof require === 'function' ? require('../core/clock.js') : self.LCWO.clock,
   typeof require === 'function' ? require('../core/assign.js') : self.LCWO.assign);
