/*
 * Replaying sent groups on the graded page.
 *
 * The audio is LCWO's own jscwlib and cannot run here, so this checks what
 * gets handed to it - which groups, at what speed - and that the cells the
 * buttons live in do not break recording the result.
 *
 *     node lcwo-tools/test/run.js replay
 */
'use strict';

const fs = require('fs');
const {same} = require('./harness.js');
const {documentFrom} = require('./dom.js');
const {rowsInPage, speedInPage, pick, textOf, groupAt} = require('../src/ext/replay.js');
const {readGradedInPage} = require('../src/ext/capture.js');

const FIXTURES = __dirname + '/fixtures/';
const fixture = name => fs.readFileSync(FIXTURES + name, 'utf8');
const on = html => { global.document = documentFrom(html); };

// what the page looks like once replay.js has added its buttons
const withButtons = html => html
  .replace(/(<td>\d+<\/td>)<\/tr>/g, '$1<td data-lt=""><button>▶</button></td></tr>')
  .replace(/(<th colspan="2">Errors<\/th>)/, '$1<th data-lt=""></th>');

exports.run = function (check) {
  on(fixture('groups-graded.html'));
  const rows = rowsInPage();

  check('every sent group gets a row',
        same(rows.map(r => r.sent), ['MNO', 'PQR', 'STU', 'VWX']));
  check('with LCWO\'s error count for it', same(rows.map(r => r.errors), [0, 1, 1, 3]));

  check('a row button plays just that group', textOf(pick(rows, 1)) === 'PQR');
  check('replaying misses skips the groups copied clean',
        textOf(pick(rows, 'misses')) === 'PQR STU VWX');
  check('replaying all plays them in the order sent',
        textOf(pick(rows, 'all')) === 'MNO PQR STU VWX');
  check('a row that is not there plays nothing', pick(rows, 9).length === 0);
  check('a clean result has no misses to play',
        pick([{sent: 'ABC', errors: 0}], 'misses').length === 0);

  /* ---------- following along ---------- */
  // 'PQR STU VWX': jscwlib reports each character's position as it sounds
  const misses = pick(rows, 'misses');
  check('the first letters light the first group',
        groupAt(misses, 0) === 0 && groupAt(misses, 2) === 0);
  check('the gap between groups lights nothing new', groupAt(misses, 3) === null);
  check('the next group lights as its first letter sounds',
        groupAt(misses, 4) === 1 && groupAt(misses, 8) === 2 && groupAt(misses, 10) === 2);
  check('past the end is nothing', groupAt(misses, 11) === null);
  check('groups of different lengths still line up',
        groupAt([{sent: 'A'}, {sent: 'BCDE'}, {sent: 'F'}], 7) === 2
        && groupAt([{sent: 'A'}, {sent: 'BCDE'}, {sent: 'F'}], 5) === 1);
  const src0 = fs.readFileSync(__dirname + '/../src/ext/replay.js', 'utf8');
  check('the callback is in place before play() schedules it',
        src0.indexOf('player.onCharacterPlay =') > -1
        && src0.indexOf('player.onCharacterPlay =') < src0.indexOf('make().play('));

  const speed = speedInPage();
  check('it plays at the speed the result says it was sent at',
        speed.wpm === 25 && speed.eff === 8);
  check('and follows LCWO\'s real-speed switch, off here', speed.real === false);
  on(fixture('groups-graded.html').replace('value="real" >', 'value="real" checked>'));
  check('and on when it is ticked', speedInPage().real === true);

  /* ---------- the buttons must not cost us the recording ---------- */
  const plain = (on(fixture('groups-graded.html')), readGradedInPage());
  const buttoned = (on(withButtons(fixture('groups-graded.html'))), readGradedInPage());
  check('the fixture really did get a button cell per row',
        (withButtons(fixture('groups-graded.html')).match(/data-lt/g) || []).length === 5);
  check('capture reads the same result with the play buttons in the table',
        !buttoned.error && same(buttoned.key, plain.key)
        && same(buttoned.reported, plain.reported) && buttoned.signature === plain.signature);
  check('and replay reads its own rows back the same way',
        same(rowsInPage().map(r => r.errors), [0, 1, 1, 3]));

  /* ---------- wiring ---------- */
  const manifest = JSON.parse(fs.readFileSync(__dirname + '/../manifest.json', 'utf8'));
  const entry = manifest.content_scripts.find(c => c.js.includes('src/ext/replay.js'));
  check('it runs in the page\'s world, where jscw is',
        entry && entry.world === 'MAIN');
  check('and only on the groups page', entry && entry.matches.every(m => /\/groups\*$/.test(m)));
  const src = fs.readFileSync(__dirname + '/../src/ext/replay.js', 'utf8');
  check('declares nothing among LCWO\'s globals',
        /^(\/\*[\s\S]*?\*\/\s*)\(\(\) => \{/.test(src) && /\}\)\(\);\s*$/.test(src));
  check('stays off an exercise page, whose table is the previous attempt',
        /getElementById\('eform'\)\) return;/.test(src));
};
