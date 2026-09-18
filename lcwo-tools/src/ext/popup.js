/*
 * lcwo-tools - the popup.
 *
 * Deliberately thin. Anything that navigates the active tab dismisses this
 * popup mid-flight, so the work happens in the service worker and this only
 * collects the list, kicks it off, and reports whatever it can still hear.
 * page.js is loaded first and provides parseChars / planFor.
 */

const $ = id => document.getElementById(id);
const say = (msg, kind = '') => { $('status').textContent = msg; $('status').className = kind; };

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab) throw new Error('no active tab');
  return tab;
};

const remember = () => chrome.storage.local.set(
  {chars: $('chars').value, replace: $('replace').checked});

const busy = on => { $('apply').disabled = on; $('read').disabled = on; };

$('apply').addEventListener('click', async () => {
  const chars = parseChars($('chars').value);
  if (!chars.length) return say('Paste a list first.', 'bad');
  busy(true);
  try {
    const tab = await activeTab();
    const plan = planFor(tab.url);
    remember();
    say({inplace: 'Ticking and saving…',
         roundtrip: 'Opening the settings page, saving, and coming back…',
         newtab: 'Opening LCWO in a new tab, saving, and going to Code Groups…',
        }[plan.mode]);
    // If the tab navigates, this popup closes and the reply never arrives -
    // the worker still finishes, and leaves the outcome on the badge.
    const r = await chrome.runtime.sendMessage(
      {type: 'apply', tabId: tab.id, windowId: tab.windowId, url: tab.url,
       chars, replace: $('replace').checked});
    if (r) say(r.message, r.ok ? 'ok' : 'bad');
  } catch (e) {
    say(String((e && e.message) || e), 'bad');
  } finally {
    busy(false);
  }
});

$('read').addEventListener('click', async () => {
  busy(true);
  try {
    const tab = await activeTab();
    const [out] = await chrome.scripting.executeScript(
      {target: {tabId: tab.id}, func: readInPage});
    const r = out && out.result;
    if (!r) return say('Nothing came back - is this an LCWO page?', 'bad');
    if (r.error) return say(r.error, 'bad');
    $('chars').value = r.chars.join(',');
    say(`${r.chars.length} character(s) currently ticked.`, 'ok');
    remember();
  } catch (e) {
    say(String((e && e.message) || e), 'bad');
  } finally {
    busy(false);
  }
});

$('chars').addEventListener('change', remember);
$('replace').addEventListener('change', remember);

/* Opening the popup clears the badge and shows what the worker did last, which
 * is the only way to see the result of a run that closed this popup. */
chrome.storage.local.get(['chars', 'replace', 'lastResult']).then(saved => {
  if (saved.chars) $('chars').value = saved.chars;
  if (saved.replace === false) $('replace').checked = false;
  const last = saved.lastResult;
  if (last && Date.now() - last.at < 10 * 60 * 1000) say(last.message, last.ok ? 'ok' : 'bad');
  chrome.action.setBadgeText({text: ''});
});
