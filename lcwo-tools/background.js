/*
 * lcwo-tools - the service worker.
 *
 * The round trip (settings -> tick -> save -> back) lives here rather than in
 * the popup because navigating the active tab dismisses the popup, and a
 * dismissed popup takes its JavaScript context with it. Run from there, the
 * flow died immediately after the first navigation: you landed on the settings
 * page with nothing ticked. The worker outlives the popup, so it finishes.
 *
 * Progress comes back two ways: the reply to the popup's message if it is
 * still open, and a badge plus a stored result if it is not.
 */

importScripts('page.js');

const SETTINGS = 'https://lcwo.net/cwsettings';
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

async function applyFlow({tabId, url, chars, replace}) {
  const plan = planFor(url);

  // get a tab that is showing the settings page, without touching anyone else's
  let target = tabId;
  if (plan.mode === 'newtab') {
    target = (await chrome.tabs.create({url: SETTINGS, active: true})).id;
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
          + `${plan.mode === 'newtab' ? 'and opened' : 'and back to'} ${plan.from}.`};
}

async function badge(text, colour) {
  await chrome.action.setBadgeText({text});
  if (colour) await chrome.action.setBadgeBackgroundColor({color: colour});
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'apply') return false;
  badge('…', '#1aa9ff');
  applyFlow(msg)
    .catch(e => ({ok: false, message: String((e && e.message) || e)}))
    .then(async result => {
      await chrome.storage.local.set({lastResult: {...result, at: Date.now()}});
      await badge(result.ok ? '✓' : '!', result.ok ? '#1aa9ff' : '#c0392b');
      try { respond(result); } catch (e) { /* popup already gone; the badge has it */ }
    });
  return true;   // keep the message channel open for the async reply
});
