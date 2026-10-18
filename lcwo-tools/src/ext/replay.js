/*
 * lcwo-tools - replaying sent groups on the graded page.
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
 * Only on the graded page. An exercise page also carries the previous
 * attempt's table, and a play button there would be one stray click from
 * playing you the answers to something else.
 *
 * The cells it adds are marked data-lt, and capture.js skips them: the error
 * count has to stay the last cell of the row for the result to be recorded.
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

  const api = {rowsInPage, speedInPage, pick, textOf, groupAt};
  if (typeof module === 'object') { module.exports = api; return; }

  /* ---------- the page side ---------- */

  if (typeof jscw !== 'function') return;               // nothing to play with
  if (document.getElementById('eform')) return;         // not the graded page

  const rows = rowsInPage();
  if (!rows.length) return;
  const speed = speedInPage();
  if (!speed.wpm) return;

  // LCWO's own player, if the page left one on window, knows the tone you set
  let theirs = null;
  try { theirs = Object.values(window).find(v => v instanceof jscw) || null; } catch (e) { /* default tone */ }

  let player = null;
  // the rows in this replay, and which of them is sounding
  let queue = [];
  let current = null;
  const done = () => {
    queue.forEach(r => r.tr.classList.remove('lcwo-tools-queued', 'lcwo-tools-playing'));
    queue = [];
    current = null;
  };
  function light(i) {
    if (i === null || !queue[i] || queue[i] === current) return;
    // a group already played drops out, so what is tinted is what is left
    if (current) current.tr.classList.remove('lcwo-tools-queued', 'lcwo-tools-playing');
    current = queue[i];
    current.tr.classList.add('lcwo-tools-playing');
  }

  function make() {
    if (player) return player;
    // made on the first click, so the AudioContext it opens has a gesture behind it
    player = new jscw();
    if (theirs && theirs.freq) player.setFreq(theirs.freq);
    player.setWpm(speed.wpm);
    player.setEff(speed.eff || speed.wpm);
    player.setReal(speed.real);
    player.onFinished = done;
    // read when play() schedules its timers, so it has to be set before then
    player.onCharacterPlay = c => light(groupAt(queue, c.n));
    return player;
  }

  function stop() {
    if (player) player.stop();
    done();
  }

  function play(which) {
    const chosen = pick(rows, which);
    if (!chosen.length) return;
    stop();
    queue = chosen;
    queue.forEach(r => r.tr.classList.add('lcwo-tools-queued'));
    light(0);     // lit straight away, not after the start delay
    make().play(textOf(chosen));
  }

  const button = (label, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lcwo-tools-replay';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  // a play button at the end of each row, misses marked so they stand out
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
                           'Play just the groups you got wrong', () => play('misses')));
  }
  bar.appendChild(button('▶ Replay all', 'Play every group again', () => play('all')));
  bar.appendChild(button('■ Stop', 'Stop playing', stop));
  table.parentNode.insertBefore(bar, table);
})();
