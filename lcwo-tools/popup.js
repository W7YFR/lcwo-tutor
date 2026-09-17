/*
 * lcwo-tools - tick LCWO's custom-character boxes from a pasted list.
 *
 * LCWO's cwsettings page lays its ~150 character checkboxes out in Koch order,
 * not alphabetical order, so selecting a set by hand means hunting. This takes
 * the comma-separated list `lcwo.py trouble --list` prints and does it.
 */

/* Split on anything a list might reasonably be separated by, keep order, drop
 * duplicates. Tolerates the whole "L,F,U" line, "L F U", or one per line. */
function parseChars(text) {
  return [...new Set((text || '').split(/[\s,;|]+/).filter(Boolean))];
}

/*
 * Runs in the page, so it has to be self-contained - chrome.scripting
 * serialises the function and nothing from this file's scope comes with it.
 * That is why the alias map is repeated rather than shared.
 */
function applyInPage(wanted, replace) {
  const ALIAS = {quot: '"'};  // an id cannot hold a quote, so LCWO spells it out
  const boxes = [...document.querySelectorAll('input[type=checkbox][name^="char"]')];
  if (!boxes.length) return {error: 'no character checkboxes here - open lcwo.net/cwsettings'};

  const byChar = new Map();
  for (const b of boxes) {
    const raw = b.name.slice(4);
    byChar.set((ALIAS[raw] || raw).toUpperCase(), b);
  }

  const want = new Set();
  const missing = [];
  for (const token of wanted) {
    const box = byChar.get(token.toUpperCase());
    if (box) want.add(box); else missing.push(token);
  }

  let ticked = 0, cleared = 0;
  for (const b of boxes) {
    const should = want.has(b) || (!replace && b.checked);
    if (b.checked === should) continue;
    b.checked = should;
    // LCWO hangs value_changed() off onchange; assigning .checked fires nothing,
    // and without the event its "click to save modified settings" hint never
    // appears - you would tick everything and then lose it on reload.
    b.dispatchEvent(new Event('change', {bubbles: true}));
    if (should) ticked++; else cleared++;
  }
  return {total: boxes.length, matched: want.size, missing, ticked, cleared};
}

/* Also self-contained: reads the page's current selection back out. */
function readInPage() {
  const ALIAS = {quot: '"'};
  const boxes = [...document.querySelectorAll('input[type=checkbox][name^="char"]')];
  if (!boxes.length) return {error: 'no character checkboxes here - open lcwo.net/cwsettings'};
  const on = boxes.filter(b => b.checked)
    .map(b => { const raw = b.name.slice(4); return ALIAS[raw] || raw; });
  return {chars: on};
}

if (typeof module !== 'undefined') {           // for the node test; inert in Chrome
  module.exports = {parseChars, applyInPage, readInPage};
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.scripting) {
  const $ = id => document.getElementById(id);
  const say = (msg, kind = '') => { $('status').textContent = msg; $('status').className = kind; };

  const activeTabId = async () => {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) throw new Error('no active tab');
    return tab.id;
  };

  /* activeTab is granted by the click that opened this popup, so no host
   * permission is needed and the extension can see nothing until you ask. */
  const run = async (func, args = []) => {
    const [out] = await chrome.scripting.executeScript({target: {tabId: await activeTabId()}, func, args});
    return out && out.result;
  };

  const remember = () => chrome.storage.local.set(
    {chars: $('chars').value, replace: $('replace').checked});

  $('apply').addEventListener('click', async () => {
    const chars = parseChars($('chars').value);
    if (!chars.length) return say('Paste a list first.', 'bad');
    try {
      const r = await run(applyInPage, [chars, $('replace').checked]);
      if (!r) return say('Nothing came back - is this an LCWO page?', 'bad');
      if (r.error) return say(r.error, 'bad');
      const bits = [`${r.matched} of ${chars.length} matched`,
                    `${r.ticked} ticked`,
                    r.cleared ? `${r.cleared} cleared` : null,
                    r.missing.length ? `not on the page: ${r.missing.join(' ')}` : null];
      say(bits.filter(Boolean).join(' · ') + '. Click Submit on the page to save.',
          r.missing.length ? '' : 'ok');
      remember();
    } catch (e) {
      say(String(e.message || e), 'bad');
    }
  });

  $('read').addEventListener('click', async () => {
    try {
      const r = await run(readInPage);
      if (!r) return say('Nothing came back - is this an LCWO page?', 'bad');
      if (r.error) return say(r.error, 'bad');
      $('chars').value = r.chars.join(',');
      say(`${r.chars.length} character(s) currently ticked.`, 'ok');
      remember();
    } catch (e) {
      say(String(e.message || e), 'bad');
    }
  });

  $('chars').addEventListener('change', remember);
  $('replace').addEventListener('change', remember);

  chrome.storage.local.get(['chars', 'replace']).then(saved => {
    if (saved.chars) $('chars').value = saved.chars;
    if (saved.replace === false) $('replace').checked = false;
  });
}
