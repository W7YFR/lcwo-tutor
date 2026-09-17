/*
 * Tests for the page-side logic, run under node with a small DOM shim.
 *
 * The thing worth testing is the matching: LCWO's ids are not all the plain
 * character (`charquot` for `"`), the boxes sit among unrelated inputs, and
 * the change event has to fire or the page never offers to save.
 *
 *     node lcwo-tools/test_popup.js
 */

const {parseChars, applyInPage, readInPage} = require('./popup.js');
const POPUP_HTML = require('fs').readFileSync(__dirname + '/popup.html', 'utf8');

let FAIL = 0;
const check = (name, ok, extra) => {
  if (ok) console.log('  ok   ' + name);
  else { FAIL++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
};

/* ---------- DOM shim ---------- */
// Supports exactly the selector forms popup.js uses: tag[attr=val][attr^=val].
function matches(el, sel) {
  const tag = (sel.match(/^[a-z]+/) || [''])[0];
  if (tag && el.tag !== tag) return false;
  for (const [, attr, op, val] of sel.matchAll(/\[([\w-]+)(\^?=)"?([^\]"]*)"?\]/g)) {
    const have = String(el[attr] ?? '');
    if (op === '=' ? have !== val : !have.startsWith(val)) return false;
  }
  return true;
}

function mkInput(tag, type, name, checked = false) {
  return {tag, type, name, checked, events: [],
          dispatchEvent(e) { this.events.push(e.type); return true; }};
}

function page(charNames, checkedNames = []) {
  const els = charNames.map(n => mkInput('input', 'checkbox', 'char' + n,
                                         checkedNames.includes(n)));
  // unrelated inputs that a careless selector would sweep up
  els.push(mkInput('input', 'text', 'speed'), mkInput('input', 'text', 'eff'),
           mkInput('input', 'radio', 'tonetype'), mkInput('input', 'checkbox', 'vvv'),
           mkInput('input', 'hidden', 'submitted'),
           mkInput('input', 'button', 'cyrillicchars'),
           mkInput('input', 'button', 'letters'));
  global.document = {querySelectorAll: sel => els.filter(e => matches(e, sel))};
  global.Event = class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
  return els;
}

const REAL = ['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'P', 'T', 'L', 'W', 'I', '.',
              'J', 'Z', '=', 'F', 'O', 'Y', ',', 'V', 'G', '5', '/', 'Q', '9', '2',
              'H', '3', '8', 'B', '?', '4', '7', 'C', '1', 'D', '6', '0', 'X',
              'quot', "'", '@', 'Ö', 'А', 'Б', 'ي'];
const ON_PAGE = ['U', 'R', 'L', 'F', 'Y', 'G', 'H', 'C', 'D'];   // as w7yfr's page loads

/* ---------- parsing ---------- */
check('a comma list parses', JSON.stringify(parseChars('L,F,U')) === '["L","F","U"]');
check('spaces and newlines parse the same',
      JSON.stringify(parseChars('L F\nU')) === '["L","F","U"]');
check('duplicates collapse', parseChars('L,L,F').length === 2);
check('empty input is empty', parseChars('').length === 0 && parseChars(null).length === 0);

/* ---------- applying ---------- */
let els = page(REAL, ON_PAGE);
let r = applyInPage(['L', 'F', 'U'], true);
const on = () => els.filter(e => e.checked).map(e => e.name.slice(4)).sort().join(',');
check('only the pasted characters end up ticked', on() === 'F,L,U', on());
check('it counts what it matched', r.matched === 3 && r.ticked === 0 && r.cleared === 6,
      JSON.stringify(r));
check('nothing is reported missing', r.missing.length === 0);
check('it left the unrelated inputs alone',
      els.filter(e => e.name === 'vvv')[0].checked === false);
check('a change event fires on every box it touched',
      els.filter(e => e.events.length).length === 6,
      String(els.filter(e => e.events.length).length));
check('and only a change event', els.every(e => e.events.every(t => t === 'change')));
check('a box already in the right state is not touched',
      els.filter(e => ['charU', 'charK'].includes(e.name)).every(e => !e.events.length));

els = page(REAL, ON_PAGE);
r = applyInPage(['Z'], false);
check('without replace, the existing selection stays',
      on() === 'C,D,F,G,H,L,R,U,Y,Z', on());
check('and only the new box is touched', r.ticked === 1 && r.cleared === 0);

/* ---------- the awkward characters ---------- */
els = page(REAL, []);
r = applyInPage(['l', 'f', 'u'], true);
check('lower case matches', on() === 'F,L,U', on());

els = page(REAL, []);
r = applyInPage(['"', '.', '/', '7', '@'], true);
check('a quote finds charquot', els.some(e => e.name === 'charquot' && e.checked));
check('punctuation and digits match', r.matched === 5 && r.missing.length === 0,
      JSON.stringify(r.missing));

els = page(REAL, []);
r = applyInPage(['А'], true);   // Cyrillic A, not Latin
check('Cyrillic does not collide with Latin',
      els.filter(e => e.checked).map(e => e.name) + '' === 'charА');

els = page(REAL, []);
r = applyInPage(['L', 'ZZ', '~'], true);
check('unknown tokens are reported, not silently dropped',
      r.matched === 1 && r.missing.join(',') === 'ZZ,~', JSON.stringify(r.missing));

/* ---------- reading back ---------- */
els = page(REAL, ON_PAGE);
check('reading the page returns what is ticked',
      readInPage().chars.sort().join(',') === [...ON_PAGE].sort().join(','));
applyInPage(['"', 'Ö'], true);
check('reading turns charquot back into a quote',
      readInPage().chars.sort().join(',') === '",Ö');
check('read output feeds straight back in',
      applyInPage(parseChars(readInPage().chars.join(',')), true).missing.length === 0);

/* ---------- the popup itself ---------- */
check('the settings page is a real link',
      /<a href="https:\/\/lcwo\.net\/cwsettings"/.test(POPUP_HTML));
check('and it opens in a new tab rather than replacing the popup',
      /href="https:\/\/lcwo\.net\/cwsettings"[^>]*target="_blank"/s.test(POPUP_HTML));
// MV3's content security policy refuses both, and the popup would look fine
// while doing nothing at all
check('no inline event handlers', !/<[^>]+\son[a-z]+=/i.test(POPUP_HTML));
check('no inline script', !/<script(?![^>]*\ssrc=)/i.test(POPUP_HTML));

/* ---------- wrong page ---------- */
page([], []);
check('a page with no character boxes says so', !!applyInPage(['L'], true).error);
check('and so does reading it', !!readInPage().error);

console.log(FAIL ? `\n  ${FAIL} failure(s)` : '\n  all extension checks passed');
process.exit(FAIL ? 1 : 0);
