/*
 * Reading an exercise off the LCWO page.
 *
 * Run against markup, not a mock: test/dom.js parses real HTML, so a
 * selector that would miss on the live page misses here too. The committed
 * fixtures carry the structure of a real page with invented groups - a real
 * capture has a call sign and whatever else LCWO puts around the edges in
 * it, which is not something to keep in a repository.
 *
 * If saved pages are sitting in lcwo-html/ the same checks run against those
 * as well, which is how the fixtures were shown to be faithful.
 *
 *     node lcwo-tools/test/run.js capture
 */
'use strict';

const fs = require('fs');
const {same} = require('./harness.js');
const {documentFrom} = require('./dom.js');
const {gradeRun} = require('../src/core/grade.js');
const {readExerciseInPage, readGradedInPage, readStateInPage,
       clearAttemptInPage, signatureOf} = require('../src/ext/capture.js');

const FIXTURES = __dirname + '/fixtures/';
const SAVED = __dirname + '/../../lcwo-html/';

/* Put a page in front of the capture functions. */
function on(html) {
  global.document = documentFrom(html);
  global.location = {href: 'https://lcwo.net/groups'};
}

const fixture = name => fs.readFileSync(FIXTURES + name, 'utf8');

/* Chrome's "view source" saves the markup escaped, one line per table row. */
function unwrapViewSource(html) {
  if (!html.includes('line-content')) return html;
  const out = [];
  for (const m of html.matchAll(/<td class="line-content">([\s\S]*?)<\/td>/g)) {
    out.push(m[1].replace(/<[^>]+>/g, '')
      .replace(/&(amp|lt|gt|quot|#39);/g,
        e => ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}[e])));
  }
  return out.join('\n');
}

exports.run = function (check) {

  /* ---------- after submitting ---------- */
  on(fixture('groups-graded.html'));
  const g = readGradedInPage();

  check('the sent groups are the key', same(g.key, ['MNO', 'PQR', 'STU', 'VWX']));
  check('the received groups are the attempt',
        same(g.attempt, ['MNO', 'PQ.', 'SXU', '...']));
  check('a character not copied stays a dot, which the grader reads as missed',
        g.attempt[1].endsWith('.'));
  check('LCWO\'s own error count per group comes too', same(g.reported, [0, 1, 1, 3]));
  check('the header carries the speed it was sent at',
        g.charWpm === 25 && g.effWpm === 8);
  check('and the summary how long it took', g.seconds === 30);
  check('the totals are read rather than recomputed',
        g.groups === 4 && g.chars === 12 && g.errors === 5);
  check('the drill and its length come off the form',
        g.mode === 'custom' && g.minutes === 2);

  // the point of capturing LCWO's counts at all: they are a second opinion
  const graded = gradeRun(g.key, g.attempt, g.reported);
  check('our grading agrees with LCWO on the total',
        graded.wrongChars === g.errors && graded.totalChars === g.chars);
  check('and on every single group', graded.disagreements.length === 0);
  check('the misses land on the right characters',
        same(graded.missCounts(), {R: 1, T: 1, V: 1, W: 1, X: 1}));
  // T copied as X is a confusion; R and the VWX group were simply not copied
  check('a substitution is a confusion, a dot is not',
        same(graded.confusions(), {'T>X': 1}));

  /* ---------- while an exercise is loaded ---------- */
  on(fixture('groups-exercise.html'));
  document.getElementById('textinput').attrs.value = 'mno pq. stu';
  const e = readExerciseInPage();
  check('the groups being sent are readable before submitting',
        same(e.key, ['MNO', 'PQR', 'STU', 'VWX']));
  check('so is what has been typed so far',
        same(e.attempt, ['MNO', 'PQ.', 'STU']));
  check('typing is upper-cased, as the grader expects', e.attempt[0] === 'MNO');
  check('and the raw text is kept as typed', e.raw === 'mno pq. stu');
  check('a part-finished copy is shorter than the key',
        e.attempt.length < e.key.length);

  // the key being settled before you submit is what makes a second attempt
  // at the same clip possible, which is the run model the CLI already has
  const partial = gradeRun(e.key, e.attempt);
  check('a part-finished attempt still grades',
        partial.totalChars === 12 && partial.wrongChars === 4);
  check('the exercise page states the speed it will send at',
        e.charWpm === 25 && e.effWpm === 8);
  check('and how many groups are coming', e.groups === 4);

  /* ---------- clearing out for the next copy ---------- */
  //
  // Recording a run stores what you typed, so leaving it on screen means the
  // next attempt starts by deleting it.
  on(fixture('groups-exercise.html'));
  document.getElementById('textinput').value = 'mno pq. stu';
  const cleared = clearAttemptInPage();
  check('clearing reports what it removed',
        cleared.ok && cleared.cleared === 'mno pq. stu');
  check('the box is empty afterwards', readExerciseInPage().raw === '');
  check('and reads as nothing typed', same(readExerciseInPage().attempt, []));
  // the clip has not changed, so this is still the same session
  check('the key is untouched, so it is still the same clip',
        same(readExerciseInPage().key, ['MNO', 'PQR', 'STU', 'VWX']));
  check('the cursor goes back to the box', document.getElementById('textinput').focused > 0);
  check('clearing an empty box is harmless', clearAttemptInPage().ok);
  on('<html><body><p>nothing</p></body></html>');
  check('and with no exercise it says so', /no exercise/.test(clearAttemptInPage().error));

  /* ---------- what is on the page ---------- */
  on(fixture('groups-graded.html'));
  check('a graded page offers a result and no exercise',
        same(readStateInPage(), {exercise: false, result: true,
                                 href: 'https://lcwo.net/groups'}));
  on(fixture('groups-exercise.html'));
  const state = readStateInPage();
  // the page keeps the last result while you work on the next one
  check('a page mid-exercise has both', state.exercise && state.result);

  /* ---------- telling one result from another ---------- */
  //
  // A result sits on the page until it is replaced, and a reload serves it
  // again, so "there is a table" cannot mean "there is something new".
  const sig = (k, a, r) => signatureOf(k, a, r);
  check('the same result signs the same',
        sig(['AB'], ['AB'], [0]) === sig(['AB'], ['AB'], [0]));
  check('different sent groups sign differently',
        sig(['AB'], ['AB'], [0]) !== sig(['CD'], ['CD'], [0]));
  check('so does the same clip copied differently',
        sig(['AB'], ['AB'], [0]) !== sig(['AB'], ['A.'], [1]));
  on(fixture('groups-exercise.html'));
  check('the stale table on an exercise page signs as itself, not as new',
        readGradedInPage().signature === sig(['ABC'], ['ABC'], [0]));

  /* ---------- pages that are not what we hoped ---------- */
  on('<html><body><h1>LCWO</h1><p>nothing here</p></body></html>');
  check('no results table says so rather than returning nothing',
        /no results table/.test(readGradedInPage().error));
  check('and no exercise likewise', /no exercise/.test(readExerciseInPage().error));
  check('with the state reporting neither',
        !readStateInPage().exercise && !readStateInPage().result);
  on('<html><body><form id="eform"><input name="nope" value="x"></form></body></html>');
  check('a form of the wrong shape is refused, not half-read',
        /not the shape expected/.test(readExerciseInPage().error));
  on('<html><body><table><tr><th>Sent Group</th></tr></table></body></html>');
  check('a header with no rows under it is not a result',
        /no rows/.test(readGradedInPage().error));

  /* ---------- the real pages, when they are here ---------- */
  //
  // Gitignored, so this is a bonus pass rather than a requirement: it is
  // what proves the fixtures above still describe the real thing.
  let real = 0;
  // a live DOM dump, which is the only place the exercise form exists
  try {
    on(fs.readFileSync(SAVED + 'live.html', 'utf8'));
    const live = readExerciseInPage();
    real++;
    check('live: the exercise form is found', !live.error);
    check('live: the key is readable before submitting',
          live.key.length === 19 && live.key.every(g => /^[A-Z]{3}$/.test(g)),
          JSON.stringify(live.key.slice(0, 3)));
    check('live: the speed is on the page', live.charWpm > 0 && live.effWpm > 0);
    check('live: nothing typed yet reads as nothing, not as an error',
          same(live.attempt, []) && live.raw === '');
    check('live: the stale results table is not mistaken for this exercise',
          readStateInPage().exercise);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const name of ['lcwo-groups-graded', 'lcwo-groups-ungraded']) {
    let html;
    try { html = unwrapViewSource(fs.readFileSync(SAVED + name + '.html', 'utf8')); }
    catch (err) { continue; }
    real++;
    on(html);
    const r = readGradedInPage();
    check(name + ': the table is found', !r.error && r.key.length === 20);
    check(name + ': every row has a sent group, a copy and a count',
          r.key.length === r.attempt.length && r.key.length === r.reported.length);
    check(name + ': the speed is read', r.charWpm === 30 && r.effWpm === 7);
    check(name + ': the totals are read', r.chars === 60 && r.seconds > 0);
    const rg = gradeRun(r.key, r.attempt, r.reported);
    check(name + ': our count matches LCWO\'s exactly',
          rg.wrongChars === r.errors && rg.totalChars === r.chars,
          rg.wrongChars + ' vs ' + r.errors);
    check(name + ': and agrees group by group', rg.disagreements.length === 0);
  }
  if (!real) console.log('  --   no saved pages in lcwo-html/, fixture checks only');
};
