/*
 * lcwo-tools - the service worker.
 *
 * The round trip (settings -> tick -> save -> back) lives here rather than in
 * the popup because navigating the active tab dismisses the popup, and a
 * dismissed popup takes its JavaScript context with it. Run from there, the
 * flow died immediately after the first navigation: you landed on the settings
 * page with nothing ticked. The worker outlives the popup, so it finishes.
 *
 * The popup is usually gone by the time this finishes, since the navigation
 * dismisses it. So the result is stored for the next time the popup opens, and
 * the toolbar badge carries the outcome: a tick that blinks and goes, or a
 * failure mark that waits to be read.
 */

importScripts(
  'page.js',
  '../ns.js',
  '../core/counter.js', '../core/clock.js', '../core/grade.js', '../core/assign.js',
  '../core/rng.js', '../core/practice.js', '../core/rollup.js',
  '../data/schema.js', '../data/store.js', '../data/idb.js', '../data/recorder.js');

/*
 * The database lives here, not in the content script.
 *
 * A content script's `indexedDB` is the page's - lcwo.net's - so recording
 * from there would keep your practice inside their site data. The worker
 * runs in the extension's own origin. It is also stopped when idle, so the
 * connection is opened on demand and the promise kept for as long as this
 * instance lives.
 */
let dbPromise = null;
const database = () => (dbPromise || (dbPromise = LCWO.idb.open().catch(err => {
  dbPromise = null;          // a failed open must not be remembered as one
  throw err;
})));

const RECORDING = {
  context: (db, msg) => LCWO.recorder.context(db, msg.page || {}),
  'record-run': (db, msg) => LCWO.recorder.recordRun(db, msg.exercise),
  'record-result': (db, msg) => LCWO.recorder.recordResult(db, msg.result),
  'new-group': (db, msg) => LCWO.recorder.newGroup(db, msg.label),
  'use-group': (db, msg) => LCWO.recorder.useGroup(db, msg.gid),
  'close-group': (db, msg) => LCWO.recorder.closeGroup(db, msg.gid),
  'reopen-group': (db, msg) => LCWO.recorder.reopenGroup(db, msg.gid),
  suggest: db => LCWO.recorder.suggestLabel(db),
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.scope !== 'lcwo') return false;
  const handler = RECORDING[msg.action];
  if (!handler) return false;
  database()
    .then(db => handler(db, msg))
    .then(respond, err => respond({ok: false, error: String((err && err.message) || err)}));
  return true;   // answering later
});

const SETTINGS = 'https://lcwo.net/cwsettings';
const LCWO_TABS = ['https://lcwo.net/*', 'https://www.lcwo.net/*'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(tabId, func, args = []) {
  const [out] = await chrome.scripting.executeScript({target: {tabId}, func, args});
  return out && out.result;
}

/* Poll the page rather than listen for tab events: reading a URL off an event
 * needs the broad "tabs" permission, injecting a one-liner does not. A page
 * mid-navigation throws, which simply means "not yet". */
async function waitInPage(tabId, func, what, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await run(tabId, func)) return true; } catch (e) { /* still loading */ }
    await sleep(120);
  }
  throw new Error('timed out waiting for ' + what);
}

const atSettings = () => document.readyState === 'complete'
  && location.pathname === '/cwsettings';
const reloaded = () => document.readyState === 'complete' && !window.__lcwoPending;

const tally = (r, chars) => [
  `${r.matched} of ${chars.length} matched`,
  r.ticked ? `${r.ticked} ticked` : null,
  r.cleared ? `${r.cleared} cleared` : null,
  r.missing.length ? `not on the page: ${r.missing.join(' ')}` : null,
].filter(Boolean).join(' · ');

async function applyFlow({tabId, windowId, url, chars, replace}) {
  const plan = planFor(url);

  // get a tab showing the settings page, without touching anyone else's
  let target = tabId;
  if (plan.mode === 'newtab') {
    // an LCWO tab already open in this window is the one to use - opening a
    // second copy of a site you already have open is just clutter
    const open = pickLcwoTab(
      await chrome.tabs.query({windowId, url: LCWO_TABS}));
    if (open) {
      target = open.id;
      await chrome.tabs.update(target, {url: SETTINGS, active: true});
    } else {
      target = (await chrome.tabs.create({url: SETTINGS, active: true})).id;
    }
  } else if (plan.mode === 'roundtrip') {
    await chrome.tabs.update(target, {url: SETTINGS});
  }
  if (plan.mode !== 'inplace') await waitInPage(target, atSettings, 'the settings page');

  const r = await run(target, applyInPage, [chars, replace]);
  if (!r || r.error) return {ok: false, message: (r && r.error) || 'Could not reach the page.'};

  const s = await run(target, submitInPage);
  if (s && s.error) return {ok: false, message: s.error};
  await waitInPage(target, reloaded, 'the save to finish');

  // trust nothing: read the reloaded page back before going anywhere
  const after = await run(target, readInPage);
  if (!(after && !after.error && sameChars(after.chars, chars))) {
    return {ok: false,
            message: `Applied, but the settings page came back with `
                     + `${after && after.chars && after.chars.length
                          ? after.chars.join(',') : 'nothing'}`
                     + ` - left you on it to look.`};
  }

  if (!plan.back) return {ok: true, message: `${tally(r, chars)}. Saved.`};
  await chrome.tabs.update(target, {url: plan.back});
  return {ok: true, message: `${tally(r, chars)}. Saved, `
          + `${plan.mode === 'newtab' ? 'now on' : 'and back to'} ${plan.from}.`};
}

async function badge(text, color) {
  await chrome.action.setBadgeText({text});
  if (color) await chrome.action.setBadgeBackgroundColor({color: color});
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'apply') return false;
  badge('…', '#1aa9ff');
  applyFlow(msg)
    .catch(e => ({ok: false, message: String((e && e.message) || e)}))
    .then(async result => {
      await chrome.storage.local.set({lastResult: {...result, at: Date.now()}});
      if (result.ok) {
        await badge('✓', '#1aa9ff');
        // long enough to catch, short enough not to nag
        setTimeout(() => chrome.action.setBadgeText({text: ''}), 1000);
      } else {
        // a failure waits until you open the popup and read it - an error
        // nobody saw is the worse bug
        await badge('!', '#c0392b');
      }
      try { respond(result); } catch (e) { /* popup already gone; the badge has it */ }
    });
  return true;   // keep the message channel open for the async reply
});
