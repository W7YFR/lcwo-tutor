/*
 * Tests for the page-side logic, run under node with a small DOM shim.
 *
 * The thing worth testing is the matching: LCWO's ids are not all the plain
 * character (`charquot` for `"`), the boxes sit among unrelated inputs, and
 * the change event has to fire or the page never offers to save.
 *
 *     node lcwo-tools/test/run.js ext
 */

const {parseChars, applyInPage, readInPage, planFor, pickLcwoTab, submitInPage,
       sameChars} = require('../src/ext/page.js');
const POPUP_HTML = require('fs').readFileSync(__dirname + '/../src/ext/popup.html', 'utf8');

exports.run = function (check) {

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

  /* ---------- where Apply should do its work ---------- */
  const plan = u => planFor(u);
  check('the settings page is handled in place, staying put',
        plan('https://lcwo.net/cwsettings').mode === 'inplace'
        && !plan('https://lcwo.net/cwsettings').back);
  check('a query string does not change that',
        plan('https://lcwo.net/cwsettings?saved=1').mode === 'inplace');
  check('another LCWO page means go, save, come back',
        JSON.stringify(plan('https://lcwo.net/groups'))
        === JSON.stringify({mode: 'roundtrip', back: 'https://lcwo.net/groups', from: '/groups'}));
  check('the return trip keeps the whole URL',
        plan('https://lcwo.net/courselesson?l=12#x').back === 'https://lcwo.net/courselesson?l=12#x');
  check('www is still LCWO', plan('https://www.lcwo.net/groups').mode === 'roundtrip');

  // Anywhere else opens a new tab and lands on Code Groups. The point is that
  // the page you were on is never navigated and never scripted.
  const elsewhere = ['https://example.com/', 'https://evil-lcwo.net/groups',
                     'https://lcwo.net.example.com/groups', 'http://lcwo.net/groups',
                     'chrome://extensions', '', undefined];
  check('anything else opens a new tab instead',
        elsewhere.every(u => plan(u).mode === 'newtab'),
        elsewhere.map(u => plan(u).mode).join(','));
  check('and that new tab ends up on Code Groups',
        elsewhere.every(u => plan(u).back === 'https://lcwo.net/groups'
                             && plan(u).from === '/groups'));
  check('a lookalike domain never counts as LCWO',
        plan('https://evil-lcwo.net/cwsettings').mode === 'newtab');

  /* ---------- reusing a tab instead of piling up new ones ---------- */
  const T = (id, url) => ({id, url});
  check('an LCWO tab already on the settings page is preferred',
        pickLcwoTab([T(1, 'https://lcwo.net/groups'),
                     T(2, 'https://lcwo.net/cwsettings')]).id === 2);
  check('otherwise the first LCWO tab will do',
        pickLcwoTab([T(3, 'https://lcwo.net/forum'),
                     T(4, 'https://lcwo.net/groups')]).id === 3);
  check('no LCWO tab means there is nothing to reuse',
        pickLcwoTab([]) === null && pickLcwoTab(null) === null
        && pickLcwoTab(undefined) === null);
  check('a tab whose url we cannot read does not throw',
        pickLcwoTab([T(5, undefined), T(6, 'https://lcwo.net/cwsettings')]).id === 6);

  /* ---------- submitting ---------- */
  (function () {
    const clicks = [];
    const form = {id: ''};
    const btn = {tag: 'input', type: 'submit', form, click: () => clicks.push(1)};
    // LCWO's character boxes sit outside the <form>, so form is null on them
    const orphan = n => ({tag: 'input', type: 'checkbox', name: 'char' + n, form: null,
                          attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }});
    const boxes = [orphan('L'), orphan('F')];
    const owned = {tag: 'input', type: 'checkbox', name: 'charU', form,
                   attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }};
    global.window = {};
    global.document = {
      querySelector: sel => (/submit/.test(sel) ? btn : null),
      querySelectorAll: () => [...boxes, owned],
    };
    const r = submitInPage();
    check('submit clicks the page\'s own button', r.ok === true && clicks.length === 1);
    check('and marks the document so the reload can be detected',
          global.window.__lcwoPending === 1);
    check('boxes outside the form are adopted so they get POSTed',
          r.adopted === 2 && boxes.every(b => b.attrs.form === 'lcwo-tools-form'));
    check('the form gets an id to be adopted into', form.id === 'lcwo-tools-form');
    check('a box the form already owns is left alone',
          owned.attrs.form === undefined);
    global.document = {querySelector: () => null, querySelectorAll: () => []};
    check('no Submit button is reported, not thrown', !!submitInPage().error);
  })();

  /* ---------- verifying the save ---------- */
  check('a matching read-back counts as saved', sameChars(['L', 'F', 'U'], ['U', 'L', 'F']));
  check('case does not matter', sameChars(['l', 'f'], ['F', 'L']));
  check('a missing character is not a match', !sameChars(['L', 'F'], ['L', 'F', 'U']));
  check('an extra character is not a match', !sameChars(['L', 'F', 'U'], ['L', 'F']));
  check('nothing back from an empty ask still matches', sameChars([], []));
  check('nothing back from a real ask does not', !sameChars([], ['L']));
  check('duplicates do not break the comparison', sameChars(['L', 'L', 'F'], ['F', 'L']));

  /* ---------- the wiring that made the first attempt fail ---------- */
  const MANIFEST = JSON.parse(require('fs').readFileSync(__dirname + '/../manifest.json', 'utf8'));
  const BG = require('fs').readFileSync(__dirname + '/../src/ext/background.js', 'utf8');
  const POPUP_JS = require('fs').readFileSync(__dirname + '/../src/ext/popup.js', 'utf8');

  // Navigating the active tab dismisses the popup, taking its JS with it - the
  // flow has to run somewhere that outlives it.
  check('a service worker is registered',
        !!(MANIFEST.background && MANIFEST.background.service_worker));
  // Chrome reports a bad path as a load failure with no hint which key is
  // wrong, and moving a file is exactly when this breaks.
  const named = [MANIFEST.background.service_worker, MANIFEST.action.default_popup,
                 MANIFEST.options_page]
    .concat(Object.values(MANIFEST.icons || {}))
    .filter(Boolean);
  const missing = named.filter(
    f => !require('fs').existsSync(__dirname + '/../' + f));
  check('every file the manifest names is really there',
        !missing.length, missing.join(', '));
  check('the worker, not the popup, drives the round trip',
        /chrome\.tabs\.update/.test(BG) && !/chrome\.tabs\.update/.test(POPUP_JS));
  check('the worker loads the shared page functions',
        /importScripts\('page\.js'\)/.test(BG));
  check('the popup asks the worker rather than doing it itself',
        /chrome\.runtime\.sendMessage/.test(POPUP_JS));
  check('the message listener keeps the channel open for its async reply',
        /return true;/.test(BG));
  check('a result the popup never hears is still recorded',
        /storage\.local\.set/.test(BG) && /setBadgeText/.test(BG));
  check('success ticks the badge and then clears it',
        /badge\('✓'/.test(BG)
        && /setTimeout\(\(\) => chrome\.action\.setBadgeText\(\{text: ''\}\), 1000\)/.test(BG));
  check('failure raises a mark and leaves it', /badge\('!'/.test(BG));
  // the in-place case used to hand back "click Submit yourself" and return early
  const beforeSubmit = BG.slice(BG.indexOf('async function applyFlow'),
                                BG.indexOf('submitInPage'));
  check('no mode reports success before it has submitted',
        !/return \{ok: true/.test(beforeSubmit));
  check('there is one submit for all three modes',
        (BG.match(/run\(target, submitInPage\)/g) || []).length === 1);
  check('only the new-tab mode creates a tab', /chrome\.tabs\.create/.test(BG));
  check('an open LCWO tab is looked for before a new one is made',
        BG.indexOf('chrome.tabs.query') > -1
        && BG.indexOf('chrome.tabs.query') < BG.indexOf('chrome.tabs.create'));
  check('the search is scoped to the window you were in',
        /chrome\.tabs\.query\(\{windowId, url: LCWO_TABS\}\)/.test(BG));
  check('and the popup passes that window along',
        /windowId: tab\.windowId/.test(POPUP_JS));
  check('the tab you were on is never scripted in new-tab mode',
        /target = \(await chrome\.tabs\.create/.test(BG));
  // planFor treats www.lcwo.net as LCWO, so the manifest has to let us script it
  check('host access covers both spellings of LCWO, over https only',
        JSON.stringify(MANIFEST.host_permissions)
        === '["https://lcwo.net/*","https://www.lcwo.net/*"]');
  check('every host pattern is one planFor would accept',
        MANIFEST.host_permissions.every(
          h => planFor(h.replace('/*', '/groups')).mode === 'roundtrip'));

  /* ---------- the popup itself ---------- */
  check('the settings page is a real link',
        /<a href="https:\/\/lcwo\.net\/cwsettings"/.test(POPUP_HTML));
  check('and it opens in a new tab rather than replacing the popup',
        /href="https:\/\/lcwo\.net\/cwsettings"[^>]*target="_blank"/s.test(POPUP_HTML));
  // MV3's content security policy refuses both, and the popup would look fine
  // while doing nothing at all
  check('no inline event handlers', !/<[^>]+\son[a-z]+=/i.test(POPUP_HTML));
  check('no inline script', !/<script(?![^>]*\ssrc=)/i.test(POPUP_HTML));
  check('page.js loads before popup.js',
        POPUP_HTML.indexOf('page.js') > -1
        && POPUP_HTML.indexOf('page.js') < POPUP_HTML.indexOf('popup.js'));

  /* ---------- the extension's own pages ---------- */
  //
  // Four pages now load the shared modules by hand, in dependency order,
  // because there is no bundler: each module reads what it needs off
  // self.LCWO, so a page that lists them in the wrong order throws on load
  // and only in a browser. That is what these check.
  const read = f => require('fs').readFileSync(__dirname + '/../src/ext/' + f, 'utf8');
  const PAGES = {'popup.html': POPUP_HTML, 'data.html': read('data.html'),
                 'report.html': read('report.html'), 'practice.html': read('practice.html')};

  const NEEDS = [['../core/counter.js', '../core/grade.js'],
                 ['../core/grade.js', '../core/rollup.js'],
                 ['../core/rng.js', '../core/practice.js'],
                 ['../core/rollup.js', '../data/analysis.js'],
                 ['../core/practice.js', '../data/analysis.js'],
                 ['../data/store.js', '../data/analysis.js'],
                 ['../data/schema.js', '../data/store.js'],
                 ['../core/clock.js', '../data/store.js'],
                 ['../core/assign.js', '../data/store.js'],
                 ['../data/schema.js', '../data/idb.js'],
                 ['../core/modes.js', '../report/payload.js'],
                 ['../core/rollup.js', '../report/payload.js']];

  for (const [name, html] of Object.entries(PAGES)) {
    const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g)).map(m => m[1]);
    check(name + ': no inline script or handlers',
          !/<script(?![^>]*\ssrc=)/i.test(html) && !/<[^>]+\son[a-z]+=/i.test(html));
    const missing = scripts.filter(
      f => !require('fs').existsSync(__dirname + '/../src/ext/' + f));
    check(name + ': every script it loads exists', !missing.length, missing.join(', '));
    if (scripts.some(f => f.startsWith('../'))) {
      check(name + ': the namespace prelude comes first', scripts[0] === '../ns.js');
    }
    const at = f => scripts.indexOf(f);
    const wrong = NEEDS.filter(([dep, mod]) => at(mod) > -1 && (at(dep) === -1 || at(dep) > at(mod)));
    check(name + ': every module loads after what it reads',
          !wrong.length, wrong.map(w => w[1] + ' before ' + w[0]).join(', '));
  }

  /* ---------- the popup reaches the rest ---------- */
  for (const page of ['report.html', 'practice.html', 'data.html']) {
    check('the popup links to ' + page,
          new RegExp('<a href="' + page.replace('.', '\\.') + '"').test(POPUP_HTML));
  }
  check('the manifest offers the data page as the options page',
        MANIFEST.options_page === 'src/ext/data.html');

  /* ---------- trouble letters, straight into the box ---------- */
  //
  // The whole point of the port: the list used to come off the clipboard.
  check('the popup has a window to pick',
        /id="window"/.test(POPUP_HTML) && /<select id="window">/.test(POPUP_HTML));
  check('and it reads them out of the database itself',
        /analysis\.troubleReport/.test(POPUP_JS));
  check('it fills the box rather than applying behind your back',
        /asList\(r\.top\)/.test(POPUP_JS) && /setChars\(list, true\)/.test(POPUP_JS)
        && !/sendMessage\([\s\S]{0,80}troubleReport/.test(POPUP_JS));
  check('the popup loads the analysis module it needs',
        /data\/analysis\.js/.test(POPUP_HTML));
  // a popup that throws on an empty database is worse than one that says so
  check('no data leaves the control disabled rather than broken',
        /sel\.disabled = true/.test(POPUP_JS));
  // changing the window has to change the letters, or you go hunting for a
  // button that commits it - and there is no longer one to find
  check('changing the window refills the box',
        /sel\.addEventListener\('change',[\s\S]{0,200}?refill\(\)/.test(POPUP_JS));
  check('the window is the only control left',
        !/id="use"/.test(POPUP_HTML) && !/\$\('use'\)/.test(POPUP_JS));
  check('an empty box on opening gets filled', /if \(!box\) await refill\(\)/.test(POPUP_JS));
  // the restore and the fill used to race; the fill has to know whether the
  // box already held something
  check('the saved list is restored before the box is judged empty',
        POPUP_JS.indexOf("if (saved.chars)") < POPUP_JS.indexOf('await setUpTrouble(saved)'));
  check('the threshold comes from the rollup, not a copy of it',
        /LCWO\.rollup\.TROUBLE_THRESHOLD/.test(POPUP_JS));

  // typing over the list means the window no longer describes what is there
  check('typing blanks the window',
        /addEventListener\('input', \(\) => showCustom\(true\)\)/.test(POPUP_JS));
  check('the blank option carries no label',
        /opt\.textContent = '';/.test(POPUP_JS));
  check('and picking a window again takes it away',
        /showCustom\(false\)/.test(POPUP_JS));
  check('a restored list that is not the trouble list opens blank too',
        /box !== \(saved\.troubleChars/.test(POPUP_JS));
  check('so the last filled list is remembered to compare against',
        /troubleChars: value/.test(POPUP_JS));

  // Reading the page fills the box with LCWO's current selection, which is
  // not your trouble list either - and a programmatic write fires no input
  // event, so it has to say so itself.
  check('reading the page blanks the window too',
        /setChars\(r\.chars\.join/.test(POPUP_JS));
  check('and filling from trouble does not',
        /setChars\(list, true\)/.test(POPUP_JS));
  // one way in, so the next thing that writes to the box cannot forget
  const writes = POPUP_JS.split('\n').filter(
    l => /\$\('chars'\)\.value =/.test(l));
  check('the box is only written through setChars, bar the restore on open',
        writes.length === 2, writes.map(l => l.trim()).join(' | '));
  check('and the restore is classified afterwards, once there is a window',
        /box !== \(saved\.troubleChars/.test(POPUP_JS));

  /* ---------- wrong page ---------- */
  page([], []);
  check('a page with no character boxes says so', !!applyInPage(['L'], true).error);
  check('and so does reading it', !!readInPage().error);
};
