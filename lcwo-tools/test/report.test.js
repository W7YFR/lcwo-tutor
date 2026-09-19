/*
 * The report, which now has two hosts.
 *
 * `lcwo.py report` inlines app.js into a self-contained file; the extension
 * loads the same app.js after building the payload out of IndexedDB. What can
 * go wrong is drift between those two - a control renamed in one shell, a
 * payload field shaped differently - so that is what these check. The
 * behaviour of app.js itself is covered by test_report.py, which drives it
 * against a real DOM shim.
 *
 *     node lcwo-tools/test/run.js report
 */
'use strict';

const fs = require('fs');
const {same} = require('./harness.js');
const {memoryBackend} = require('./memory.js');
const store = require('../src/data/store.js');
const rollup = require('../src/core/rollup.js');
const modes = require('../src/core/modes.js');
const {buildPayload} = require('../src/report/payload.js');

const SRC = __dirname + '/../src/';
const APP = fs.readFileSync(SRC + 'report/app.js', 'utf8');
const CSS = fs.readFileSync(SRC + 'report/report.css', 'utf8');
const PAGE = fs.readFileSync(SRC + 'ext/report.html', 'utf8');
const LCWO_PY = fs.readFileSync(__dirname + '/../../lcwo.py', 'utf8');

/* The CLI's shell, pulled straight out of the Python so the two cannot drift
   without this noticing. */
function pythonShell() {
  const start = LCWO_PY.indexOf('HTML_SHELL = """');
  const from = start + 'HTML_SHELL = """'.length;
  return LCWO_PY.slice(from, LCWO_PY.indexOf('\n"""', from));
}

const idsIn = html => new Set(Array.from(html.matchAll(/id="([^"]+)"/g)).map(m => m[1]));

exports.run = async function (check) {

  /* ---------- the two shells have to offer app.js the same page ---------- */
  const shell = pythonShell();
  check('the CLI shell was found in lcwo.py', shell.length > 200);

  // every control app.js reaches for by name, plus the filter selects it
  // builds from DIMS as `f-<key>`
  const NEEDED = ['quick', 'filters', 'scopeline', 'sub', 'app', 'clear',
                  'w-op', 'w-drill',
                  'f-from', 'f-to', 'f-op', 'f-gid', 'f-sid', 'f-drill'];
  const cli = idsIn(shell), ext = idsIn(PAGE);
  check('the CLI report has every control',
        NEEDED.every(id => cli.has(id)), NEEDED.filter(id => !cli.has(id)).join(', '));
  check('and so does the extension page',
        NEEDED.every(id => ext.has(id)), NEEDED.filter(id => !ext.has(id)).join(', '));

  // anything app.js looks up statically must exist in both, bar the two that
  // are host-specific or made at run time
  const looked = Array.from(APP.matchAll(/getElementById\('([^']+)'\)/g)).map(m => m[1]);
  const HOST_ONLY = ['data', 'sparkcap'];
  const wanted = Array.from(new Set(looked)).filter(id => !HOST_ONLY.includes(id));
  check('every element app.js looks up exists in the CLI report',
        wanted.every(id => cli.has(id)), wanted.filter(id => !cli.has(id)).join(', '));
  check('and in the extension page',
        wanted.every(id => ext.has(id)), wanted.filter(id => !ext.has(id)).join(', '));
  check('the data script tag is the CLI\'s alone',
        cli.has('data') && !ext.has('data'));
  check('app.js still reads that tag when nothing is handed to it',
        /getElementById\('data'\)/.test(APP) && /LCWO_DATA/.test(APP));

  /* ---------- the assets the Python now reads off disk ---------- */
  check('lcwo.py loads the shared stylesheet', LCWO_PY.includes('asset("report.css")'));
  check('and the shared application code', LCWO_PY.includes('asset("app.js")'));
  check('it no longer carries its own copy',
        !/^APP_JS\d? = /m.test(LCWO_PY) && !/^CSS = """/m.test(LCWO_PY));
  check('the stylesheet came across', CSS.includes('.bar') && CSS.length > 500);
  check('and the application code', APP.includes('function stats(') && APP.length > 5000);

  /* ---------- the extension page loads what it needs, in order ---------- */
  const scripts = Array.from(PAGE.matchAll(/<script src="([^"]+)"/g)).map(m => m[1]);
  check('the namespace prelude is first', scripts[0] === '../ns.js');
  check('report.js is last', scripts[scripts.length - 1] === 'report.js');
  check('app.js is not loaded by the markup',
        !scripts.includes('../report/app.js'));
  // it cannot be: the payload is read out of IndexedDB, and a script tag
  // cannot wait for that
  check('report.js appends it once the payload is ready',
        /report\/app\.js/.test(fs.readFileSync(SRC + 'ext/report.js', 'utf8')));
  const missing = scripts.filter(f => !fs.existsSync(SRC + 'ext/' + f));
  check('every script it names exists', !missing.length, missing.join(', '));
  const order = (a, b) => scripts.indexOf(a) > -1 && scripts.indexOf(a) < scripts.indexOf(b);
  check('modules load after what they read',
        order('../core/counter.js', '../core/grade.js')
        && order('../core/grade.js', '../core/rollup.js')
        && order('../core/rollup.js', '../report/payload.js')
        && order('../core/modes.js', '../report/payload.js')
        && order('../data/schema.js', '../data/store.js'));
  check('the stylesheet is linked', /<link rel="stylesheet" href="\.\.\/report\/report\.css">/.test(PAGE));
  check('no inline script or handlers',
        !/<script(?![^>]*\ssrc=)/i.test(PAGE) && !/<[^>]+\son[a-z]+=/i.test(PAGE));

  /* ---------- the payload ---------- */
  const db = memoryBackend();
  const oid = await store.createOperator(db, 'Test Op', 'W0TST',
                                         {created_at: '2026-04-01T09:00:00-07:00'});
  const gid = await store.createGroup(db, {
    operator_id: oid, assignment: 'S1HW1', label: 'S1HW1', mode: 'letters',
    char_wpm: 25, eff_wpm: 8, created_at: '2026-04-01T09:00:00-07:00', notes: 'a note',
  });
  const s1 = await store.startSession(db, await store.getGroup(db, gid),
                                      {started_at: '2026-04-01T09:00:00-07:00'});
  await store.addRun(db, s1.id, ['EH', 'SM', '.R'],
                     {recorded_at: '2026-04-01T09:10:00-07:00'});
  await store.addRun(db, s1.id, ['EH', 'SX', 'TRX'],
                     {is_final: true, reported: [0, 1, 1],
                      recorded_at: '2026-04-01T09:20:00-07:00'});
  await store.finishSession(db, s1.id, ['EH', 'SM', 'TR']);
  /* a second session with no key yet - its runs are in the payload, ungraded */
  const s2 = await store.startSession(db, await store.getGroup(db, gid),
                                      {mode: null, char_wpm: null, eff_wpm: null,
                                       started_at: '2026-04-02T09:00:00-07:00'});
  await store.addRun(db, s2.id, ['AB'], {recorded_at: '2026-04-02T09:05:00-07:00'});

  const views = (await store.loadAll(db)).map(rollup.groupView);
  const pay = buildPayload(views, await store.listOperators(db), {generated: 'FIXED'});

  check('the payload has the shape app.js expects',
        same(Object.keys(pay).sort(),
             ['generated', 'groups', 'modes', 'operators', 'runs', 'sessions',
              'troubleThreshold']));
  check('the trouble threshold travels with it',
        pay.troubleThreshold === rollup.TROUBLE_THRESHOLD);
  check('so do the drill labels', same(pay.modes, modes.MODE_LABEL));
  check('and the operators, without their notes',
        same(pay.operators, [{id: oid, callsign: 'W0TST', name: 'Test Op'}]));

  const g = pay.groups[0];
  check('a group carries its own keys',
        same(Object.keys(g).sort(),
             ['assignment', 'charWpm', 'closed', 'created', 'effWpm', 'id',
              'label', 'mode', 'notes', 'op']));
  check('a group names its operator', g.op === oid);
  check('a group\'s drill is the label, not the code', g.mode === 'Letters');
  check('an open group has no closed date', g.closed === null);

  const [a, b] = pay.sessions;
  check('a session carries its own keys',
        same(Object.keys(a).sort(),
             ['at', 'charWpm', 'effWpm', 'gid', 'id', 'mode', 'modeLabel', 'notes', 'seq']));
  check('a session keeps both the drill code and its label',
        a.mode === 'letters' && a.modeLabel === 'Letters');
  check('a session with no speed carries nulls, not zeroes',
        b.charWpm === null && b.effWpm === null);

  const bare = buildPayload([rollup.groupView({
    id: 9, operator_id: null, label: null, mode: null, assignment: 'X',
    char_wpm: null, eff_wpm: null, created_at: '2026-04-01T09:00:00-07:00',
    closed_at: null, notes: null,
    sessions: [{id: 90, seq: 1, mode: null, char_wpm: null, eff_wpm: null,
                started_at: '2026-04-01T09:00:00-07:00', notes: null, key: null,
                runs: []}],
  })], [], {generated: 'FIXED'});
  check('a session with no drill reads as a dash, not as null',
        bare.sessions[0].mode === null && bare.sessions[0].modeLabel === '-');
  check('but a group with no drill stays null, as the CLI writes it',
        bare.groups[0].mode === null);
  check('an unowned group carries a null operator', bare.groups[0].op === null);
  check('an unknown drill code passes through rather than vanishing',
        buildPayload([rollup.groupView({id: 1, mode: 'morse_tennis', sessions: []})],
                     []).groups[0].mode === 'morse_tennis');
  check('sessions point back at their group', a.gid === gid && b.gid === gid);

  const runs = pay.runs;
  check('every run is in the payload, graded or not', runs.length === 3);
  check('a run points at its session and group',
        runs[0].sid === a.id && runs[0].gid === gid);
  check('the final run is flagged, as a boolean',
        runs[1].final === true && runs[0].final === false);
  check('a run carries the day it was recorded', runs[0].day === '2026-04-01');
  check('a run with no key yet is not graded',
        runs[2].graded === false && same(runs[2].cells, []));
  check('a graded run carries sent, received and a verdict per character',
        same(runs[0].cells, [['EH', 'EH', 'cc'], ['SM', 'SM', 'cc'], ['TR', '.R', 'mc']]));
  check('a substitution reads as w, an extra character as x',
        same(runs[1].cells, [['EH', 'EH', 'cc'], ['SM', 'SX', 'cw'], ['TR', 'TRX', 'ccx']]));
  check('every verdict code is one app.js knows',
        runs.every(r => r.cells.every(c => Array.from(c[2])
          .every(k => Object.values(modes.KIND_CODE).includes(k)))));

  /* the payload is what gets embedded in a file, so it has to survive JSON */
  check('the payload round-trips through JSON unchanged',
        same(JSON.parse(JSON.stringify(pay)), pay));
  check('and a generated stamp can be pinned for comparison',
        pay.generated === 'FIXED');
  check('while the default is a real timestamp',
        /^\d{4}-\d\d-\d\dT/.test(buildPayload([], []).generated));
  check('an empty database still makes a valid payload',
        same(buildPayload([], []).runs, []));
};
