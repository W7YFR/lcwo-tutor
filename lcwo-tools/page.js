/*
 * lcwo-tools - the page-side half.
 *
 * These functions are handed to chrome.scripting.executeScript, which
 * serialises them and runs them inside the LCWO page. Each one has to be
 * entirely self-contained: nothing from this file's scope travels with it,
 * which is why small things like the alias map are repeated rather than shared.
 *
 * Loaded three ways: by popup.html, by the service worker via importScripts,
 * and by test_popup.js under node.
 */

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

/*
 * Where Apply should do its work, decided from the tab's URL alone. Every mode
 * ticks and saves; they differ only in which tab and where you end up.
 *
 *   on /cwsettings      - tick, save, stay put
 *   elsewhere on LCWO   - go to the settings, tick, save, come back here
 *   anywhere else       - open a new tab, tick, save, land on Code Groups;
 *                         the tab you were on is never touched
 */
function planFor(urlString) {
  let u;
  try { u = new URL(urlString || ''); } catch (e) { u = null; }
  // The hostname test is anchored: "evil-lcwo.net" is not LCWO, and falling
  // through to a new tab means a page like that is never scripted at all.
  const lcwo = u && u.protocol === 'https:' && /^(www\.)?lcwo\.net$/i.test(u.hostname);
  if (!lcwo) return {mode: 'newtab', back: 'https://lcwo.net/groups', from: '/groups'};
  return u.pathname === '/cwsettings'
    ? {mode: 'inplace'}
    : {mode: 'roundtrip', back: u.href, from: u.pathname};
}

/* Which already-open LCWO tab to reuse, given the ones in this window.
 * One already sitting on the settings page saves a navigation; otherwise any
 * LCWO tab will do. */
function pickLcwoTab(tabs) {
  if (!tabs || !tabs.length) return null;
  const onSettings = tabs.find(t => {
    try { return new URL(t.url || '').pathname === '/cwsettings'; } catch (e) { return false; }
  });
  return onSettings || tabs[0];
}

/* Self-contained: clicks the page's own Submit, the way you would. The marker
 * is how the caller knows the POST has landed - the reload wipes it. */
function submitInPage() {
  const btn = document.querySelector('input[type=submit]');
  if (!btn) return {error: 'no Submit button on this page'};

  /* LCWO closes </form> before the table cell holding the character boxes, so
   * by the DOM those boxes have no form owner and a submit would leave them
   * out. A `form` attribute re-associates them; boxes already owned are left
   * alone, so this is a no-op if the page is ever fixed. */
  let adopted = 0;
  const form = btn.form;
  if (form) {
    if (!form.id) form.id = 'lcwo-tools-form';
    for (const b of document.querySelectorAll('input[type=checkbox][name^="char"]')) {
      if (b.form !== form) { b.setAttribute('form', form.id); adopted++; }
    }
  }

  window.__lcwoPending = 1;
  btn.click();
  return {ok: true, adopted};
}

/* Did the settings page come back holding what we asked for? */
function sameChars(after, wanted) {
  const norm = a => [...new Set((a || []).map(c => c.toUpperCase()))].sort().join(',');
  return norm(after) === norm(wanted);
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
  module.exports = {parseChars, planFor, pickLcwoTab, applyInPage, submitInPage,
                    readInPage, sameChars};
}
