/*
 * lcwo-tools - the data page.
 *
 * Operators, import and export, and a count of what is in here. This is the way in for
 * practice recorded before the extension existed, and the way out to a file
 * you keep: the database lives in this browser profile, so an export is what
 * makes it yours rather than Chrome's.
 */

const store = LCWO.store;
const idb = LCWO.idb;
const {nowIso} = LCWO.clock;

const $ = id => document.getElementById(id);
const say = (msg, kind) => { $('status').textContent = msg; $('status').className = kind || ''; };

let db = null;

async function render() {
  const s = await store.summary(db);
  for (const k of ['operators', 'groups', 'sessions', 'runs', 'days']) {
    $('n-' + k).textContent = s[k];
  }
  $('span').textContent = s.lastDay
    ? 'Practice from ' + s.firstDay + ' to ' + s.lastDay
      + (s.binned ? '  ·  ' + s.binned + ' in the bin' : '')
    : 'Nothing recorded yet — import a file, or record a session.';

  const age = store.daysSinceExport(s);
  $('exported').textContent = age === null
    ? 'never exported'
    : age === 0 ? 'exported today'
    : 'last exported ' + age + (age === 1 ? ' day ago' : ' days ago');

  await renderOperators();
}

async function renderOperators() {
  const ops = await store.listOperators(db);
  const current = await store.currentOperator(db);
  const sel = $('current');
  sel.innerHTML = '';
  // with several on file and none chosen, recording waits for a choice
  if (!current) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'choose…';
    sel.appendChild(none);
  }
  for (const op of ops) {
    const opt = document.createElement('option');
    opt.value = String(op.id);
    opt.textContent = store.opLabel(op);
    sel.appendChild(opt);
  }
  sel.value = current ? String(current.id) : '';
  $('current-row').hidden = !ops.length;
  $('no-ops').hidden = ops.length > 0;
}

async function addOperator(event) {
  event.preventDefault();
  try {
    const oid = await store.createOperator(db, $('op-name').value, $('op-call').value);
    const ops = await store.listOperators(db);
    let adopted = 0;
    if (ops.length === 1) {
      // groups imported before any operator existed belong to the first one
      adopted = await store.adoptUnassigned(db, oid);
      await store.setCurrentOperator(db, oid);
    }
    const op = await store.getOperator(db, oid);
    $('add-op').reset();
    await render();
    say('added ' + store.opLabel(op)
        + (adopted ? ', and gave them ' + adopted + ' groups with no operator' : ''), 'ok');
  } catch (e) {
    say(e.message, 'bad');
  }
}

async function chooseOperator() {
  const oid = Number($('current').value);
  if (!oid) return;
  await store.setCurrentOperator(db, oid);
  await render();
  say('recording as ' + store.opLabel(await store.getOperator(db, oid)), 'ok');
}

async function importFile(file) {
  say('reading ' + file.name + '…');
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    return say('that file is not JSON (' + e.message + ')', 'bad');
  }
  try {
    const counts = await store.load(db, data);
    await render();
    say('imported ' + counts.groups + ' groups, ' + counts.sessions + ' sessions and '
        + counts.runs + ' runs from ' + file.name, 'ok');
  } catch (e) {
    say(e.message, 'bad');
  }
}

async function exportFile() {
  try {
    const data = await store.dump(db);
    const blob = new Blob([JSON.stringify(data, null, 1)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lcwo-' + data.exported_at.slice(0, 10) + '.json';
    a.click();
    // revoking straight away can cancel the download in flight
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    await store.setSetting(db, 'exported_at', nowIso());
    await render();
    say('downloaded ' + a.download, 'ok');
  } catch (e) {
    say(e.message, 'bad');
  }
}

(async () => {
  try {
    db = await idb.open();
  } catch (e) {
    return say('could not open the database: ' + e.message, 'bad');
  }
  await render();
  $('file').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (file) importFile(file);
    e.target.value = '';   // so picking the same file again still fires
  });
  $('export').addEventListener('click', exportFile);
  $('add-op').addEventListener('submit', addOperator);
  $('current').addEventListener('change', chooseOperator);
})();
