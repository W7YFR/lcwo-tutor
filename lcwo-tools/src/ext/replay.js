/*
 * lcwo-tools - replaying what was sent, on LCWO's own results.
 *
 * Two pages: the graded Code Groups page, and Callsign Training once an
 * attempt is over. Each gets a play button per row, the misses shaded, and
 * Replay misses / Replay all / Stop above the table, with the row sounding
 * now highlighted as it goes.
 *
 * LCWO synthesizes its audio in the browser with jscwlib (Fabian Kurz,
 * DJ5CW), which every page loads in its <head>. So rather than ship a second
 * Morse generator, this borrows theirs: a player built from the page's own
 * `jscw` sounds exactly like the exercise did.
 *
 * That is why this runs in the page's world ("world": "MAIN" in the
 * manifest) rather than beside hud.js. A content script's isolated world
 * cannot see the page's globals, and `jscw` is one. Two prices: there is no
 * chrome.* here (none is needed, it only reads the table and plays), and
 * anything declared at the top level would land among LCWO's own globals -
 * hence the one closure.
 *
 * Code Groups only on the graded page. An exercise page also carries the
 * previous attempt's table, and a play button there would be one stray
 * click from playing you the answers to something else. The cells added are
 * marked data-lt, and capture.js skips them: the error count has to stay the
 * last cell of the row for the result to be recorded.
 */
(() => {
  'use strict';

  /* ---------- what to play: plain functions, tested under node ---------- */

  /* The results table, a row per group, with the row element kept for drawing. */
  function rowsInPage() {
    const tables = Array.from(document.querySelectorAll('table'))
      .filter(t => /Sent Group/.test(t.textContent));
    const table = tables[tables.length - 1];
    if (!table) return [];
    const rows = [];
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      const td = Array.from(tr.querySelectorAll('td')).filter(c => !c.hasAttribute('data-lt'));
      if (td.length < 3) continue;
      const errs = td[td.length - 1].textContent.trim();
      if (!/^\d+$/.test(errs)) continue;
      const sent = td[0].textContent.trim().toUpperCase();
      if (!sent) continue;
      rows.push({tr: tr, sent: sent, errors: Number(errs)});
    }
    return rows;
  }

  /* How it was sent: the result's own speeds, and LCWO's real-speed switch. */
  function speedInPage() {
    const text = document.body.textContent.replace(/\s+/g, ' ');
    const speed = /Result \(([\d.]+)\/([\d.]+) WPM\)/.exec(text);
    const real = document.querySelector('input[name=real]');
    return {
      wpm: speed ? Number(speed[1]) : null,
      eff: speed ? Number(speed[2]) : null,
      real: !!(real && real.checked),
    };
  }

  /* Which rows a button plays: one row by index, every miss, or the lot. */
  function pick(rows, which) {
    if (typeof which === 'number') return rows[which] ? [rows[which]] : [];
    if (which === 'misses') return rows.filter(r => r.errors > 0);
    return rows.slice();
  }

  /* Groups go out as words, the way LCWO sent them. */
  const textOf = rows => rows.map(r => r.sent).join(' ');

  /*
   * Which of the rows being played holds character `n` of textOf(rows).
   *
   * jscwlib calls onCharacterPlay with the position of each character in the
   * text as it starts to sound, which is how the highlight follows along. A
   * space between groups belongs to none of them: null, and the highlight
   * stays where it is until the next group starts.
   */
  function groupAt(rows, n) {
    let start = 0;
    for (let i = 0; i < rows.length; i++) {
      const end = start + rows[i].sent.length;
      if (n >= start && n < end) return i;
      start = end + 1;
    }
    return null;
  }

  /* ---------- callsign training ---------- */

  /*
   * The call table, a row per call already answered. The rest of the 25 sit
   * there as dashes until you get to them.
   */
  function callRowsInPage() {
    const table = document.getElementById('calltable');
    if (!table) return [];
    const rows = [];
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      const td = Array.from(tr.querySelectorAll('td')).filter(c => !c.hasAttribute('data-lt'));
      if (td.length < 3) continue;                       // the header row
      const clean = el => el.textContent.replace(/ /g, ' ').trim().toUpperCase();
      const sent = clean(td[0]);
      if (!sent || sent === '-') continue;
      const recv = clean(td[1]);
      rows.push({tr: tr, sent: sent, recv: recv, wpm: Number(clean(td[2])) || null,
                 errors: recv === sent ? 0 : 1});
    }
    return rows;
  }

  /*
   * How LCWO sent one call: the WPM column is the effective speed, and the
   * characters themselves never go slower than the page's mincharspeed -
   * the same sum its own playcall() does.
   */
  function callSpeed(row, minChar) {
    const eff = row.wpm || minChar || 20;
    return {wpm: Math.max(eff, minChar || 0), eff: eff};
  }

  const api = {rowsInPage, speedInPage, pick, textOf, groupAt, callRowsInPage, callSpeed};
  if (typeof module === 'object') { module.exports = api; return; }

  /* ---------- playing: shared by both pages ---------- */

  if (typeof jscw !== 'function') return;               // nothing to play with

  // a breath between calls, which LCWO sends one at a time
  const CALL_GAP_MS = 900;

  // LCWO's own player, if the page left one on window, knows the tone you set
  let theirs = null;
  try { theirs = Object.values(window).find(v => v instanceof jscw) || null; } catch (e) { /* default tone */ }

  /*
   * A replay is a list of steps, each one play() of the library. The groups
   * go out as a single clip, the way they were sent; calls go one per step,
   * because each was sent at its own speed.
   */
  let player = null;
  let queue = [];        // the rows in this replay
  let current = null;    // the one sounding now
  let steps = [];
  let gap = null;

  function clear() {
    clearTimeout(gap);
    gap = null;
    queue.forEach(r => r.tr.classList.remove('lcwo-tools-queued', 'lcwo-tools-playing'));
    queue = [];
    current = null;
    steps = [];
  }

  function light(row) {
    if (!row || row === current) return;
    // a row already played drops out, so what is tinted is what is left
    if (current) current.tr.classList.remove('lcwo-tools-queued', 'lcwo-tools-playing');
    current = row;
    current.tr.classList.add('lcwo-tools-playing');
  }

  function make() {
    if (player) return player;
    // made on the first click, so the AudioContext it opens has a gesture behind it
    player = new jscw();
    if (theirs && theirs.freq) player.setFreq(theirs.freq);
    player.onFinished = () => { gap = setTimeout(next, steps.length ? CALL_GAP_MS : 0); };
    return player;
  }

  function next() {
    const step = steps.shift();
    if (!step) return clear();
    const p = make();
    p.setWpm(step.wpm);
    p.setEff(step.eff || step.wpm);
    p.setReal(!!step.real);
    // read when play() schedules its timers, so it has to be set before then
    p.onCharacterPlay = c => light(step.rows.length === 1 ? step.rows[0]
                                   : step.rows[groupAt(step.rows, c.n)]);
    light(step.rows[0]);     // lit straight away, not after the first character
    p.play(step.text);
  }

  function stop() {
    if (player) player.stop();
    clear();
  }

  /* Wire up a table: a play button per row, misses shaded, the bar above it. */
  function decorate(rows, stepsFor, noun) {
    const play = which => {
      const chosen = pick(rows, which);
      if (!chosen.length) return;
      stop();
      // LCWO's own player would talk over ours
      if (theirs && theirs.stop) { try { theirs.stop(); } catch (e) { /* not started */ } }
      queue = chosen;
      queue.forEach(r => r.tr.classList.add('lcwo-tools-queued'));
      steps = stepsFor(chosen);
      next();
    };

    const button = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lcwo-tools-replay';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };

    rows.forEach((r, i) => {
      const td = document.createElement('td');
      td.setAttribute('data-lt', '');
      td.appendChild(button('▶', 'Play ' + r.sent, () => play(i)));
      r.tr.appendChild(td);
      if (r.errors) r.tr.classList.add('lcwo-tools-missed');
    });
    const table = rows[0].tr.closest('table');
    const head = table.querySelector('tr');
    if (head && head.querySelector('th')) {
      const th = document.createElement('th');
      th.setAttribute('data-lt', '');
      head.appendChild(th);
    }

    const misses = rows.filter(r => r.errors).length;
    const bar = document.createElement('p');
    bar.className = 'lcwo-tools-replay-bar';
    if (misses) {
      bar.appendChild(button('▶ Replay misses (' + misses + ')',
                             'Play just the ' + noun + ' you got wrong', () => play('misses')));
    }
    bar.appendChild(button('▶ Replay all', 'Play every one of the ' + noun + ' again',
                           () => play('all')));
    bar.appendChild(button('■ Stop', 'Stop playing', stop));
    table.parentNode.insertBefore(bar, table);
  }

  /* ---------- code groups: the graded page ---------- */

  function codeGroups() {
    if (document.getElementById('eform')) return;       // not the graded page
    const rows = rowsInPage();
    if (!rows.length) return;
    const speed = speedInPage();
    if (!speed.wpm) return;
    decorate(rows, chosen => [{rows: chosen, text: textOf(chosen),
                               wpm: speed.wpm, eff: speed.eff, real: speed.real}], 'groups');
  }

  /*
   * Callsign training: once the attempt is over.
   *
   * The table fills in as you answer, and LCWO's own player is busy with
   * the next call, so replaying mid-attempt would talk over the exercise.
   * The page says it is finished by putting a "New attempt" link in
   * #newattemptdiv; until then, watch for it.
   */
  function callsigns() {
    const finished = () => !!document.getElementById('newattempt');
    const setUp = () => {
      const rows = callRowsInPage();
      if (!rows.length) return;
      const minChar = Number(window.mincharspeed) || 0;
      decorate(rows, chosen => chosen.map(r => Object.assign({rows: [r], text: r.sent},
                                                             callSpeed(r, minChar))), 'calls');
      // LCWO's own call links play through its player; stop ours so the two
      // never talk over each other. Its javascript: href runs as the click's
      // default action, after this listener, so the order works out.
      document.getElementById('calltable').addEventListener('click', event => {
        if (event.target.closest && event.target.closest('a')) stop();
      });
    };
    if (finished()) return setUp();
    const box = document.getElementById('newattemptdiv');
    if (!box) return;
    const watch = new MutationObserver(() => {
      if (!finished()) return;
      watch.disconnect();
      setUp();
    });
    watch.observe(box, {childList: true, subtree: true});
  }

  if (/^\/callsigns/.test(location.pathname)) callsigns();
  else codeGroups();
})();
