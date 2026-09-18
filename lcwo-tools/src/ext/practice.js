/*
 * lcwo-tools - the sending practice page.
 *
 * `make practice`, in the browser and off the same numbers. The set is drawn
 * from what you miss on receive, weighted so the worst characters come round
 * most, and every set is seeded so the one on screen can be reproduced.
 */

const {analysis, idb} = LCWO;

const $ = id => document.getElementById(id);
const say = (msg, kind) => { $('status').textContent = msg; $('status').className = kind || ''; };
const show = (id, on) => { $(id).hidden = !on; };

let db = null;
let seed = String(Date.now());

const windowLabel = n => n ? 'the last ' + n + ' days' : 'all time';

function render(report) {
  $('set').textContent = '';
  for (const group of report.set) {
    const el = document.createElement('span');
    el.textContent = group;
    $('set').appendChild(el);
  }
  show('set-box', report.set.length > 0);

  $('pairs').textContent = '';
  for (const p of report.pairs) {
    const row = document.createElement('div');
    row.className = 'pair';
    const name = document.createElement('b');
    name.textContent = p.a + ' / ' + p.b;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = 'mixed up ' + p.count + '×';
    const g = document.createElement('span');
    g.className = 'g';
    g.textContent = p.groups.join('   ');
    row.append(name, n, g);
    $('pairs').appendChild(row);
  }
  show('pairs-box', report.pairs.length > 0);

  $('trouble').textContent = '';
  for (const t of report.trouble) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = t.char + ' ';
    const n = document.createElement('i');
    n.textContent = '×' + t.count;
    chip.appendChild(n);
    $('trouble').appendChild(chip);
  }
  show('trouble-box', report.trouble.length > 0);
  $('trouble-note').textContent = report.trouble.length
    ? 'Missed twice or more over ' + windowLabel(report.window)
      + ', worst first. Counted across the whole window rather than day by day.'
    : '';
}

async function build() {
  if (!db) return;
  const days = Number($('window').value) || null;
  const typed = ($('chars').value || '').toUpperCase().replace(/[^A-Z0-9.,?/=]/g, '');
  const chars = typed ? Array.from(new Set(Array.from(typed.replace(/,/g, '')))) : null;

  const report = await analysis.practiceReport(db, {
    days, chars, seed, n: Math.max(1, Math.min(200, Number($('count').value) || 24)),
  });
  render(report);

  if (chars) say('Built from the ' + chars.length + ' characters you typed.');
  else if (!report.trouble.length) {
    say('Nothing missed twice or more ' + windowLabel(days)
        + ' — type some characters to drill instead.', 'ok');
  } else {
    say(report.set.length + ' groups from ' + report.trouble.length
        + ' characters, ' + windowLabel(days) + '.');
  }
}

(async () => {
  try {
    db = await idb.open();
  } catch (e) {
    return say('Could not open the database: ' + e.message, 'bad');
  }

  const views = await analysis.loadViews(db);
  const sel = $('window');
  for (const n of analysis.windowsFor(views).concat([0])) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n ? 'last ' + n + ' days' : 'all time';
    sel.appendChild(opt);
  }

  if (!LCWO.rollup.practiceDays(views).length) {
    say('No practice recorded in this browser yet. Import an export on the '
        + 'data page, and this fills itself in.', 'bad');
    for (const box of ['set-box', 'pairs-box', 'trouble-box']) show(box, false);
  }

  sel.addEventListener('change', build);
  $('count').addEventListener('change', build);
  $('chars').addEventListener('input', build);
  $('again').addEventListener('click', () => {
    seed = String(Math.floor(Math.random() * 1e9));   // a different draw, same weights
    build();
  });
  $('copy').addEventListener('click', async () => {
    const text = Array.from($('set').children).map(el => el.textContent).join(' ');
    if (!text) return say('Nothing to copy yet.', 'bad');
    try {
      await navigator.clipboard.writeText(text);
      say('Copied ' + text.split(' ').length + ' groups.', 'ok');
    } catch (e) {
      say('Could not reach the clipboard: ' + e.message, 'bad');
    }
  });

  await build();
})();
