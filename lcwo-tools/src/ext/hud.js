/*
 * lcwo-tools - the bar on lcwo.net/groups.
 *
 * Reads the page and asks the service worker to store things. It cannot
 * touch the database itself: a content script's `indexedDB` belongs to the
 * page's origin, so writing there would put your practice inside lcwo.net's
 * site data, to be cleared with it. Everything persistent happens in the
 * worker.
 *
 * capture.js is loaded alongside this and supplies readStateInPage,
 * readExerciseInPage and readGradedInPage.
 */

(() => {
  'use strict';

  const ask = message => chrome.runtime.sendMessage(Object.assign({scope: 'lcwo'}, message));

  let bar = null;
  let els = {};
  // typing changes whether there is anything to record, but every refresh is
  // a round trip to the worker, so wait until the keys stop
  let typing = null;

  function build() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'lcwo-tools-bar';
    bar.innerHTML =
      '<span class="lt-mark">LCWO-TOOLS</span>' +
      '<span class="lt-where"></span>' +
      '<button type="button" class="lt-record lt-primary">Record run</button>' +
      '<select class="lt-groups"></select>' +
      '<button type="button" class="lt-close-group"></button>' +
      '<span class="lt-status"></span>' +
      '<button type="button" class="lt-close" title="Hide until the next page load">&times;</button>';
    document.body.appendChild(bar);
    document.body.classList.add('lcwo-tools-shifted');

    els = {
      where: bar.querySelector('.lt-where'),
      record: bar.querySelector('.lt-record'),
      groups: bar.querySelector('.lt-groups'),
      closeGroup: bar.querySelector('.lt-close-group'),
      status: bar.querySelector('.lt-status'),
      close: bar.querySelector('.lt-close'),
    };
    els.record.addEventListener('click', recordRun);
    els.groups.addEventListener('change', switchGroup);
    els.closeGroup.addEventListener('click', finishGroup);
    els.close.addEventListener('click', () => {
      bar.classList.add('is-hidden');
      document.body.classList.remove('lcwo-tools-shifted');
    });
    return bar;
  }

  const say = (message, kind) => {
    els.status.textContent = message || '';
    els.status.className = 'lt-status' + (kind ? ' is-' + kind : '');
  };

  function drawWhere(ctx) {
    if (!ctx.operator) {
      els.where.innerHTML = '<b>no operator yet</b>';
      return;
    }
    const bits = ['<b>' + esc(ctx.operator.callsign) + '</b>'];
    if (ctx.group) bits.push('<b>' + esc(ctx.group.label) + '</b>');

    if (!ctx.group && ctx.target) bits.push('<b>' + esc(ctx.target.label) + '</b> (new)');
    bits.push(ctx.session ? 'session ' + ctx.session.seq : 'new session');
    bits.push('run ' + ctx.nextRun);
    els.where.innerHTML = bits.join('<span class="lt-sep">·</span>');
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

  function drawGroups(ctx) {
    const sel = els.groups;
    sel.innerHTML = '';
    const add = (parent, value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      parent.appendChild(opt);
      return opt;
    };
    const group = (label) => {
      const g = document.createElement('optgroup');
      g.label = label;
      sel.appendChild(g);
      return g;
    };

    if ((ctx.openGroups || []).length) {
      const open = group('Open');
      for (const g of ctx.openGroups) add(open, String(g.id), g.label);
    }
    add(sel, 'new', 'New: ' + (ctx.suggestion || 'assignment') + '…');
    // closed ones are listed so you can see where your last homework went,
    // and reopen it on purpose rather than by accident
    if ((ctx.closedGroups || []).length) {
      const done = group('Closed');
      for (const g of ctx.closedGroups) add(done, 'reopen:' + g.id, g.label);
    }

    sel.value = ctx.target && ctx.target.kind === 'group'
      ? String(ctx.target.id) : 'new';
  }

  /* ---------- what the page currently is ---------- */

  const pageKey = () => {
    const ex = readExerciseInPage();
    return ex.error ? null : ex;
  };

  async function refresh(message, kind) {
    const ex = pageKey();
    const ctx = await ask({action: 'context', page: ex ? {key: ex.key} : {}});
    if (!ctx) return;
    drawWhere(ctx);
    drawGroups(ctx);
    els.record.disabled = !ex || !ex.attempt.length || !ctx.operator;
    // only an assignment that exists can be finished
    const open = ctx.target && ctx.target.kind === 'group';
    els.closeGroup.disabled = !open;
    els.closeGroup.textContent = open ? 'Close ' + ctx.target.label : 'Close';
    els.closeGroup.title = open
      ? 'Finish ' + ctx.target.label + ' — later runs start the next assignment'
      : 'Nothing to close: the next run starts a new assignment';
    if (typeof message === 'string') say(message, kind);
    else if (message === false) { /* leave what is on screen */ }
    else if (!ctx.operator) say('Add an operator on the extension\'s data page first.', 'bad');
    else if (!ex) say('No exercise loaded — press Continue Training.');
    else if (!ex.attempt.length) say('Nothing typed yet.');
    else say(ex.attempt.length + ' of ' + ex.key.length + ' groups typed.');
    return ctx;
  }

  /*
   * Finishing an assignment.
   *
   * Only ever the one being recorded into, so there is no list of things to
   * close by accident - to finish a different one, select it first. No
   * confirmation: reopening it is one press away, in the same control.
   */
  async function finishGroup() {
    const gid = Number(els.groups.value);
    if (!gid) return;
    const r = await ask({action: 'close-group', gid: gid});
    return refresh(r && r.ok ? 'Closed ' + r.label + '.'
                   : (r && r.error) || 'Could not close that.',
                   r && r.ok ? 'ok' : 'bad');
  }

  /* ---------- the two things it does ---------- */

  async function recordRun() {
    const ex = pageKey();
    if (!ex) return say('No exercise on this page.', 'bad');
    els.record.disabled = true;
    clearTimeout(typing);
    const r = await ask({action: 'record-run', exercise: ex});
    if (!r || !r.ok) return refresh((r && r.error) || 'Could not record that.', 'bad');
    // the attempt is stored, so the box starts empty for the replay
    clearAttemptInPage();
    await refresh('Run ' + r.run + ' recorded'
                  + (r.startedSession ? ', new session started' : '')
                  + ' — box cleared for the next copy.', 'ok');
  }

  /*
   * Picking up the grading.
   *
   * Only when the page has a result and no exercise form - that is the state
   * submitting leaves you in. An exercise page also carries a results table,
   * the *previous* one, and recording that would file last attempt's work
   * against this clip. The signature check in the worker then covers
   * reloading the graded page.
   */
  async function pickUpResult(state) {
    if (!state.result || state.exercise) return false;
    const graded = readGradedInPage();
    if (graded.error) return false;
    const r = await ask({action: 'record-result', result: graded});
    if (!r) return false;
    if (!r.ok) { say(r.error || 'Could not record the result.', 'bad'); return true; }
    if (r.skipped) { say('Already recorded — ' + graded.key.length + ' groups.'); return true; }
    say('Recorded: ' + graded.key.length + ' groups, ' + graded.errors + ' errors at '
        + graded.charWpm + '/' + graded.effWpm + ' wpm. Session closed.', 'ok');
    return true;
  }

  async function switchGroup() {
    const value = els.groups.value;
    if (value.startsWith('reopen:')) {
      const gid = Number(value.slice(7));
      const label = els.groups.selectedOptions[0].textContent;
      if (!window.confirm('Reopen ' + label + ' and record into it?')) return refresh();
      const back = await ask({action: 'reopen-group', gid: gid});
      return refresh(back && back.ok ? 'Reopened ' + back.label + '.'
                     : (back && back.error) || 'Could not reopen that.',
                     back && back.ok ? 'ok' : 'bad');
    }
    if (value === 'new') {
      const suggested = (await ask({action: 'suggest'})) || '';
      const label = window.prompt('Name for the new assignment', suggested);
      if (label === null) return refresh();
      const made = await ask({action: 'new-group', label: label});
      return refresh(made && made.ok ? 'Recording into ' + made.label + '.'
                     : (made && made.error) || 'Could not start that.',
                     made && made.ok ? 'ok' : 'bad');
    }
    const used = await ask({action: 'use-group', gid: Number(value)});
    return refresh(used && used.ok ? 'Recording into ' + used.label + '.'
                   : (used && used.error) || 'Could not switch.',
                   used && used.ok ? 'ok' : 'bad');
  }

  /* ---------- start ---------- */

  async function start() {
    const state = readStateInPage();
    if (!state.exercise && !state.result) return;   // not a page worth a bar
    build();
    // a result already reported leaves its message up; refresh only redraws
    const handled = await pickUpResult(state);
    await refresh(handled ? false : undefined);
  }

  document.addEventListener('input', event => {
    if (!bar || !event.target || event.target.id !== 'textinput') return;
    clearTimeout(typing);
    typing = setTimeout(() => refresh().catch(() => {}), 400);
  });

  start().catch(err => {
    if (bar) say(String((err && err.message) || err), 'bad');
  });
})();
