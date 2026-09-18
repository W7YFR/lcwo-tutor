/*
 * lcwo-tools - the popup.
 *
 * Deliberately thin. Anything that navigates the active tab dismisses this
 * popup mid-flight, so the work happens in the service worker and this only
 * collects the list, kicks it off, and reports whatever it can still hear.
 * page.js is loaded first and provides parseChars / planFor.
 *
 * It also reads your own trouble letters out of IndexedDB, which is the
 * point of the whole port: the list used to come off the clipboard from
 * `make trouble`, and now the characters you are missing go to the settings
 * page without leaving the browser.
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

let db = null;   // IndexedDB, opened once the popup is up

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
    setChars(r.chars.join(','));
    say(`${r.chars.length} character(s) currently ticked.`, 'ok');
  } catch (e) {
    say(String((e && e.message) || e), 'bad');
  } finally {
    busy(false);
  }
});

/* ---------- your trouble letters ---------- */
//
// Changing the window refills the box. The control says "your trouble
// letters" and has a window next to it, so changing the window has to change
// the letters.
//
// Type over the box and the window goes blank, because what is in there is
// no longer your trouble list and a window still showing "last 7 days" would
// be claiming otherwise. Picking a window again takes the blank option away.
//
// It only ever fills the box; Apply is a separate press. Seeing which
// characters you are about to set on yourself is the point, and silently
// ticking thirteen boxes you never read is not an improvement on pasting
// them.

const TROUBLE_THRESHOLD = LCWO.rollup.TROUBLE_THRESHOLD;
const windowLabel = n => n ? `last ${n} days` : 'all time';
const chosenWindow = () => Number($('window').value) || null;

const CUSTOM = 'custom';   // the blank option, present only while it applies

/*
 * The one way to write to the box.
 *
 * Every write has to say whether what it is putting there is the trouble
 * list, because the window beside it is a claim about exactly that. Reading
 * the page fills the box too, and that is LCWO's selection, not your trouble
 * letters - going through here is what stops the next one forgetting.
 */
function setChars(value, fromTrouble) {
  $('chars').value = value;
  showCustom(!fromTrouble);
  // remembered so the next opening can tell a trouble list from your own edit
  if (fromTrouble) chrome.storage.local.set({troubleChars: value});
  remember();
}

function showCustom(on) {
  const sel = $('window');
  if (sel.disabled) return;   // nothing to qualify: there is no window to show
  const existing = sel.querySelector(`option[value="${CUSTOM}"]`);
  if (!on) return existing && existing.remove();
  if (!existing) {
    const opt = document.createElement('option');
    opt.value = CUSTOM;
    opt.textContent = '';   // deliberately blank: this is not a window
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = CUSTOM;
}

async function fillFromTrouble() {
  if (!db) return;
  const days = chosenWindow();
  const r = await LCWO.analysis.troubleReport(db, {days});
  if (!r.top.length) {
    return say(`Nothing missed ${TROUBLE_THRESHOLD}+ times ${windowLabel(days)}`
               + ' — nothing to drill.', 'ok');
  }
  const list = LCWO.analysis.asList(r.top);   // the worse half of the list
  setChars(list, true);
  say(`${r.top.length} of ${r.trouble.length} trouble characters, ${windowLabel(days)}.`,
      'ok');
}

const refill = () => fillFromTrouble().catch(
  e => say(String((e && e.message) || e), 'bad'));

async function setUpTrouble(saved) {
  const sel = $('window');
  try {
    db = await LCWO.idb.open();
  } catch (e) {
    sel.disabled = true;
    return;
  }
  const views = await LCWO.analysis.loadViews(db);
  if (!LCWO.rollup.practiceDays(views).length) {
    sel.innerHTML = '<option>no data yet</option>';
    sel.disabled = true;
    return;
  }

  sel.innerHTML = '';
  for (const n of LCWO.analysis.windowsFor(views).concat([0])) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = windowLabel(n);
    sel.appendChild(opt);
  }
  if (saved.window !== undefined
      && sel.querySelector(`option[value="${saved.window}"]`)) {
    sel.value = String(saved.window);
  }

  sel.addEventListener('change', () => {
    if (sel.value === CUSTOM) return;
    showCustom(false);
    chrome.storage.local.set({window: chosenWindow() || 0});
    refill();
  });

  // typing makes it yours, not the trouble list. `input` does not fire when
  // the value is set from code, so getting here means somebody typed.
  $('chars').addEventListener('input', () => showCustom(true));

  const box = $('chars').value.trim();
  if (!box) await refill();                      // nobody's careful edit
  else if (box !== (saved.troubleChars || '')) showCustom(true);
}

$('chars').addEventListener('change', remember);
$('replace').addEventListener('change', remember);

/* Opening the popup clears the badge and shows what the worker did last, which
 * is the only way to see the result of a run that closed this popup. */
(async () => {
  const saved = await chrome.storage.local.get(
    ['chars', 'replace', 'window', 'troubleChars', 'lastResult']);
  if (saved.chars) $('chars').value = saved.chars;
  if (saved.replace === false) $('replace').checked = false;
  const last = saved.lastResult;
  if (last && Date.now() - last.at < 10 * 60 * 1000) say(last.message, last.ok ? 'ok' : 'bad');
  chrome.action.setBadgeText({text: ''});

  // after the restore, so it can tell a restored trouble list from an edit
  await setUpTrouble(saved);
})().catch(() => { $('window').disabled = true; });
