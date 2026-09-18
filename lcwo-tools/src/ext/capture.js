/*
 * Reading a code-group exercise off the LCWO page.
 *
 * Everything here is serialized into the page by chrome.scripting, so each
 * function has to be self-contained: no imports, no closure over this file.
 * Same rule as page.js.
 *
 * What LCWO gives us, and where:
 *
 *   during an exercise   a form #eform holding a hidden `text` field - the
 *                        groups it is sending - and a textarea `input` you
 *                        type into. The text is settled when the page loads,
 *                        so replaying and trying again is a second attempt at
 *                        the same clip: exactly the run model the CLI has.
 *
 *                        Note the typed answer is only ever a DOM property.
 *                        The markup never carries it, so nothing can be read
 *                        out of saved HTML - it has to come from the live
 *                        page.
 *
 *   after submitting     a results table - sent group, received group, a
 *                        per-character verdict, and LCWO's own error count -
 *                        plus a summary carrying the speed it was sent at and
 *                        how long it took.
 *
 * The catch is that the results table stays on the page for the *previous*
 * attempt while you work on the next one. A table being present says nothing
 * about whether it is new, so every result carries a signature and the
 * recorder checks it before storing anything.
 */

/* ---------- during an exercise ---------- */

function readExerciseInPage() {
  const form = document.getElementById('eform');
  if (!form) return {error: 'no exercise on this page'};
  // `text` is a hidden field holding the groups being sent, settled when the
  // page loaded; `input` is the textarea you type into
  const sent = form.querySelector('[name=text]');
  const typed = form.querySelector('[name=input]');
  if (!sent || !typed) return {error: 'the exercise form is not the shape expected'};
  const split = s => String(s || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const key = split(sent.value);

  // The page states the speed it is set to send at. Only a fallback: the
  // graded page reports what it actually sent, which is what a closed
  // session stores.
  const text = document.body.textContent.replace(/\s+/g, ' ');
  const speed = /Character Speed = ([\d.]+) WPM, Effective Speed = ([\d.]+) WPM/.exec(text);

  return {
    key: key,
    attempt: split(typed.value),
    raw: String(typed.value || ''),
    charWpm: speed ? Number(speed[1]) : null,
    effWpm: speed ? Number(speed[2]) : null,
    groups: key.length,
    signature: signatureOf(key, [], []),
  };
}

/* ---------- after submitting ---------- */

function readGradedInPage() {
  // innermost table holding the header: the results sit nested inside the
  // page's layout tables, which also "contain" that text
  const tables = Array.from(document.querySelectorAll('table'))
    .filter(t => /Sent Group/.test(t.textContent));
  const table = tables[tables.length - 1];
  if (!table) return {error: 'no results table on this page'};

  const key = [], attempt = [], reported = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const td = Array.from(tr.querySelectorAll('td'));
    if (td.length < 3) continue;                       // the header row
    const errs = td[td.length - 1].textContent.trim();
    if (!/^\d+$/.test(errs)) continue;
    const sent = td[0].textContent.trim().toUpperCase();
    if (!sent) continue;
    key.push(sent);
    // a character not copied comes back as '.', which is what the grader
    // already reads as "missed"
    attempt.push(td[1].textContent.trim().toUpperCase());
    reported.push(Number(errs));
  }
  if (!key.length) return {error: 'the results table had no rows'};

  const text = document.body.textContent.replace(/\s+/g, ' ');
  const num = m => (m ? Number(m[1]) : null);
  const speed = /Result \(([\d.]+)\/([\d.]+) WPM\)/.exec(text);
  const real = /Real speed: (\d+) characters \/ ([\d.]+) seconds/.exec(text);
  const tally = /Groups: (\d+) \((\d+) characters\), Errors: (\d+)/.exec(text);
  const paris = /PARIS: ([\d.]+) WPM/.exec(text);
  const sel = name => {
    const el = document.querySelector('select[name=' + name + ']');
    return el ? el.value : null;
  };

  return {
    key: key, attempt: attempt, reported: reported,
    charWpm: speed ? Number(speed[1]) : null,
    effWpm: speed ? Number(speed[2]) : (paris ? Number(paris[1]) : null),
    seconds: real ? Number(real[2]) : null,
    groups: tally ? Number(tally[1]) : key.length,
    chars: tally ? Number(tally[2]) : null,
    errors: tally ? Number(tally[3]) : reported.reduce((a, b) => a + b, 0),
    mode: sel('mode'),
    minutes: num(/^(\d+)$/.exec(sel('duration') || '')),
    signature: signatureOf(key, attempt, reported),
  };
}

/*
 * What makes one result distinguishable from another.
 *
 * The page keeps showing the last result while you work on the next, and a
 * reload re-serves it, so "is there a table?" cannot be the test for "is
 * there something new?". Sent groups are randomly generated, so the sent
 * text alone is near enough unique; what was copied and the error counts go
 * in too, so that re-copying the same clip is still a distinct attempt.
 */
function signatureOf(key, attempt, reported) {
  return [key.join(' '), attempt.join(' '), reported.join('')].join('|');
}

/* ---------- what is on the page at all ---------- */

function readStateInPage() {
  const form = document.getElementById('eform');
  const tables = Array.from(document.querySelectorAll('table'))
    .filter(t => /Sent Group/.test(t.textContent));
  return {
    exercise: !!form,
    result: tables.length > 0,
    href: location.href,
  };
}

if (typeof module === 'object') {
  module.exports = {readExerciseInPage, readGradedInPage, readStateInPage, signatureOf};
}
