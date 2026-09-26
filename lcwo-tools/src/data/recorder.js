/*
 * Turning what is on the LCWO page into rows in the database.
 *
 * All of it runs in the service worker, because a content script's
 * `indexedDB` is the *page's* storage - lcwo.net's, cleared with its site
 * data - not the extension's. The page side reads the DOM and sends what it
 * found here; nothing on lcwo.net ever holds your practice.
 *
 * The mapping, now that the browser gives more than a pasted table did:
 *
 *   session   one clip. LCWO settles the groups it will send when the page
 *             loads and keeps them in a hidden field, so the key is known
 *             from the start and is the session's identity. Replay and copy
 *             it again and that is another run, not another session.
 *
 *   run       one attempt at that clip. Because the key is known up front,
 *             every run grades the moment it is recorded rather than waiting
 *             for the results table.
 *
 *   result    submitting closes the session: LCWO's grading arrives as the
 *             final run, carrying its own error counts as a second opinion.
 */
(function (X, store, assign, clock) {
  'use strict';

  const nowIso = clock.nowIso;

  /* ---------- where a new session should go ---------- */

  /*
   * The group to record into: whichever was chosen, else the one last worked
   * on if it is still open, else a new one carrying the next assignment
   * number. Closing a group is how you say "that homework is done", so a
   * closed one is never silently reopened.
   */
  async function currentGroup(db, oid, gid) {
    if (gid) {
      const picked = await store.getGroup(db, gid);
      if (picked && !picked.closed_at) return picked;
    }
    const chosen = await store.getSetting(db, 'group_id');
    if (chosen) {
      const g = await store.getGroup(db, chosen);
      if (g && !g.closed_at && (oid == null || g.operator_id === oid)) return g;
    }
    const last = await store.lastGroup(db, oid);
    return last && !last.closed_at ? last : null;
  }

  async function targetGroup(db, oid, opts) {
    const o = opts || {};
    const open = await currentGroup(db, oid, o.gid);
    if (open) return open;

    const labels = (await store.liveGroups(db, oid)).map(g => g.label || g.assignment);
    const next = assign.nextAssignment(labels) || o.label || 'S1HW1';
    const speeds = (await store.lastSettings(db, oid)) || {};
    const gid = await store.createGroup(db, {
      operator_id: oid, assignment: next, label: next,
      mode: o.mode || speeds.mode || 'code_group',
      char_wpm: o.charWpm == null ? speeds.char_wpm : o.charWpm,
      eff_wpm: o.effWpm == null ? speeds.eff_wpm : o.effWpm,
    });
    await store.setSetting(db, 'group_id', gid);
    return store.getGroup(db, gid);
  }

  /* The open session for this clip, started if there is not one yet. */
  async function sessionForKey(db, oid, key, opts) {
    const found = await store.openSessionForKey(db, key, oid);
    if (found) return {session: found, started: false};
    const group = await targetGroup(db, oid, opts);
    const o = opts || {};
    const session = await store.startSession(db, group, {
      key: key,
      mode: o.mode || group.mode,
      char_wpm: o.charWpm == null ? group.char_wpm : o.charWpm,
      eff_wpm: o.effWpm == null ? group.eff_wpm : o.effWpm,
      started_at: o.at,
    });
    return {session: session, started: true};
  }

  /* ---------- what the page can ask for ---------- */

  /*
   * Enough to draw the bar on the page: who, where, and how far in.
   *
   * A graded page (`page.finished`) still describes the session it graded,
   * so the bar moves on only when the next exercise loads.
   */
  async function context(db, page) {
    const op = await store.currentOperator(db);
    const key = (page && page.key) || null;
    const finished = !!(page && page.finished);
    const session = !key || !op ? null
      : finished ? await store.lastSessionForKey(db, key, op.id)
      : await store.openSessionForKey(db, key, op.id);
    const group = session ? await store.getGroup(db, session.group_id)
      : (op ? await currentGroup(db, op.id) : null);
    const runs = session ? (await store.sessionRuns(db, session.id)).length : 0;
    const all = op ? await store.liveGroups(db, op.id) : [];
    const name = g => g.label || g.assignment;
    const brief = g => ({id: g.id, label: name(g)});
    return {
      operator: op ? {id: op.id, callsign: op.callsign, name: op.name} : null,
      group: group ? {id: group.id, label: name(group), closed: !!group.closed_at} : null,
      // what a run would land in, which is a group that does not exist yet
      // when everything on file has been closed
      target: group ? {kind: 'group', id: group.id, label: name(group)}
                    : {kind: 'new', label: await suggestLabel(db)},
      suggestion: await suggestLabel(db),
      openGroups: all.filter(g => !g.closed_at).map(brief),
      closedGroups: all.filter(g => g.closed_at).map(brief).reverse(),
      session: session ? {id: session.id, seq: session.seq} : null,
      // the number the next session in this group would get
      nextSession: session ? session.seq
        : group ? await store.nextSessionSeq(db, group.id) : 1,
      runs: runs,
      nextRun: runs + 1,
      // the run the bar names: the last one once graded, else the next one
      run: finished && session ? runs : runs + 1,
    };
  }

  /* ---------- recording ---------- */

  async function recordRun(db, exercise, opts) {
    const op = await store.currentOperator(db);
    if (!op) return {ok: false, error: 'no operator on file - add one on the data page'};
    if (!exercise || !exercise.key || !exercise.key.length) {
      return {ok: false, error: 'no exercise on the page'};
    }
    if (!exercise.attempt || !exercise.attempt.length) {
      return {ok: false, error: 'nothing typed yet'};
    }

    const o = Object.assign({charWpm: exercise.charWpm, effWpm: exercise.effWpm},
                            opts || {});
    const {session, started} = await sessionForKey(db, op.id, exercise.key, o);
    const id = await store.addRun(db, session.id, exercise.attempt, {
      source: 'capture', recorded_at: o.at, raw_paste: exercise.raw,
    });
    const runs = await store.sessionRuns(db, session.id);
    return {ok: true, runId: id, sessionId: session.id, startedSession: started,
            run: runs.length};
  }

  /*
   * Submitting closed a clip. Store LCWO's grading as the final run.
   *
   * Refuses to store the same result twice: the page keeps a result up until
   * it is replaced and a reload serves it again, so the signature is checked
   * before anything is written.
   */
  async function recordResult(db, result, opts) {
    const op = await store.currentOperator(db);
    if (!op) return {ok: false, error: 'no operator on file - add one on the data page'};
    if (!result || !result.key || !result.key.length) {
      return {ok: false, error: 'no result on the page'};
    }
    const already = await store.runBySignature(db, result.signature);
    if (already) return {ok: true, skipped: 'already recorded', runId: already.id};

    const o = Object.assign({charWpm: result.charWpm, effWpm: result.effWpm,
                             mode: result.mode ? 'code_group' : undefined}, opts || {});
    const {session, started} = await sessionForKey(db, op.id, result.key, o);

    const id = await store.addRun(db, session.id, result.attempt, {
      is_final: true, reported: result.reported, source: 'capture',
      signature: result.signature, recorded_at: o.at,
    });
    // LCWO reports what it actually sent, which beats what the settings page
    // said it would
    await store.updateSession(db, session.id, {
      key: result.key.slice(),
      char_wpm: result.charWpm == null ? session.char_wpm : result.charWpm,
      eff_wpm: result.effWpm == null ? session.eff_wpm : result.effWpm,
      ended_at: o.at || nowIso(),
    });
    const runs = await store.sessionRuns(db, session.id);
    return {ok: true, runId: id, sessionId: session.id, startedSession: started,
            run: runs.length, closed: true};
  }

  /* ---------- the bar's own controls ---------- */

  async function newGroup(db, label) {
    const op = await store.currentOperator(db);
    if (!op) return {ok: false, error: 'no operator on file'};
    const labels = (await store.liveGroups(db, op.id)).map(g => g.label || g.assignment);
    const name = (label || '').trim() || assign.nextAssignment(labels) || 'S1HW1';
    const speeds = (await store.lastSettings(db, op.id)) || {};
    const gid = await store.createGroup(db, {
      operator_id: op.id, assignment: name, label: name,
      mode: speeds.mode || 'code_group',
      char_wpm: speeds.char_wpm, eff_wpm: speeds.eff_wpm,
    });
    await store.setSetting(db, 'group_id', gid);
    return {ok: true, gid: gid, label: name};
  }

  async function useGroup(db, gid) {
    const g = await store.getGroup(db, gid);
    if (!g) return {ok: false, error: 'no such group'};
    if (g.closed_at) {
      return {ok: false, error: (g.label || g.assignment) + ' is closed - '
                                + 'reopen it before recording into it'};
    }
    await store.setSetting(db, 'group_id', g.id);
    return {ok: true, gid: g.id, label: g.label || g.assignment};
  }

  /*
   * Finish an assignment.
   *
   * Sessions inside it are left alone - a session closes when it is graded,
   * and one still open is either unfinished or abandoned, which `pruneEmpty`
   * and the bin are for. Closing only says "no more runs go here".
   */
  async function closeGroup(db, gid) {
    const g = await store.getGroup(db, gid);
    if (!g) return {ok: false, error: 'no such group'};
    if (g.closed_at) return {ok: true, label: g.label || g.assignment, already: true};
    await store.closeGroup(db, g.id);
    // stop pointing at it, or every later run resolves through a closed group
    if (String(await store.getSetting(db, 'group_id')) === String(g.id)) {
      await store.setSetting(db, 'group_id', null);
    }
    return {ok: true, gid: g.id, label: g.label || g.assignment};
  }

  /* Closing a group says that homework is done, so reopening is deliberate
     rather than something recording does on your behalf. */
  async function reopenGroup(db, gid) {
    const g = await store.getGroup(db, gid);
    if (!g) return {ok: false, error: 'no such group'};
    if (g.closed_at) await store.reopenGroup(db, g.id);
    await store.setSetting(db, 'group_id', g.id);
    return {ok: true, gid: g.id, label: g.label || g.assignment,
            reopened: !!g.closed_at};
  }

  /* What the next assignment would be called, for the bar to suggest. */
  async function suggestLabel(db) {
    const op = await store.currentOperator(db);
    const labels = (await store.liveGroups(db, op ? op.id : null))
      .map(g => g.label || g.assignment);
    return assign.nextAssignment(labels) || 'S1HW1';
  }

  Object.assign(X, {targetGroup, currentGroup, sessionForKey, context, recordRun, recordResult,
                    newGroup, useGroup, closeGroup, reopenGroup, suggestLabel});
})(typeof module === 'object' ? module.exports : (self.LCWO.recorder = {}),
   typeof require === 'function' ? require('./store.js') : self.LCWO.store,
   typeof require === 'function' ? require('../core/assign.js') : self.LCWO.assign,
   typeof require === 'function' ? require('../core/clock.js') : self.LCWO.clock);
