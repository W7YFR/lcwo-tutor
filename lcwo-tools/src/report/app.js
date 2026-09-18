/*
 * The report: filtering, aggregation and rendering.
 *
 * Loaded two ways and it must not care which. `lcwo.py report` inlines this
 * into a single self-contained HTML file; the extension's report page loads
 * it as a script after building the payload out of IndexedDB. See
 * DESIGN.md - everything here runs in the browser either way, which is why
 * it was worth pulling out of the Python rather than writing twice.
 */
/* Two hosts. The CLI writes a self-contained file with the payload in a
   script tag; the extension builds it from IndexedDB first and hands it over,
   because reading IndexedDB is async and a script tag cannot wait. */
const DATA = typeof LCWO_DATA !== 'undefined' && LCWO_DATA
  ? LCWO_DATA
  : JSON.parse(document.getElementById('data').textContent);
const TH = DATA.troubleThreshold;
const MISS = {m:'missed', w:'wrong', t:'transposed'};
const byId = (a,k) => Object.fromEntries(a.map(x => [x[k], x]));
const G = byId(DATA.groups, 'id'), S = byId(DATA.sessions, 'id');
const O = byId(DATA.operators || [], 'id');
const graded = DATA.runs.filter(r => r.graded);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const day = iso => (iso || '').slice(0, 10);
const fmtDay = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined,
  {month:'short', day:'numeric', year:'numeric'}) : '-';
const wpm = g => g.charWpm == null ? 'speed not recorded'
  : `${+g.charWpm}/${+g.effWpm} wpm`;

/* ---------- aggregation: sum the per-character verdicts ---------- */
function stats(runs){
  const sent = new Map(), miss = new Map(), conf = new Map();
  let chars = 0, wrong = 0, grp = 0, clean = 0, transposed = 0;
  const bump = (m, k, n=1) => m.set(k, (m.get(k) || 0) + n);
  for (const r of runs) for (const [snt, rcv, kinds] of r.cells){
    if (snt) { grp++; }
    let bad = 0, extra = false;
    for (let i = 0; i < kinds.length; i++){
      const k = kinds[i], c = snt[i];
      if (k === 'x'){ extra = true; continue; }
      chars++; bump(sent, c);
      if (k !== 'c'){
        wrong++; bad++;
        if (!miss.has(c)) miss.set(c, {missed:0, wrong:0, transposed:0, total:0});
        const m = miss.get(c); m[MISS[k]]++; m.total++;
        if (k === 'w') bump(conf, c + '→' + (rcv[i] || '?'));
      }
    }
    if (snt && !bad && !extra) clean++;
    if (kinds.includes('t')) transposed++;
  }
  return {sent, miss, conf, chars, wrong, grp, clean, transposed,
          pctWrong: chars ? 100 * wrong / chars : 0,
          pctRight: chars ? 100 - 100 * wrong / chars : 0};
}
const trouble = st => [...st.miss.entries()]
  .filter(([, m]) => m.total >= TH)
  .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));

/* ---------- scopes ---------- */
const days = [...new Set(graded.map(r => r.day))].sort();
/* Windows count days you actually practiced, not calendar days: skip a
   Tuesday and "the last two days" still means your last two sessions' days,
   which is the question people actually ask of a practice log. */
const WINDOWS = [2, 3, 7, 14, 30].filter(n => n < days.length);
const fmtDayShort = d => d ? new Date(d + 'T12:00:00')
  .toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
const drills = [...new Set(DATA.sessions.map(s => s.mode).filter(Boolean))].sort();
const drillOf = r => S[r.sid].mode;
const opName = id => O[id] ? `${O[id].name} (${O[id].callsign})` : 'unassigned';
const opCall = id => O[id] ? O[id].callsign : 'unassigned';
const opOf = r => G[r.gid].op;
/* normally one - a report covers a single operator unless built --everyone */
const ops = [...new Set(DATA.groups.map(g => g.op))].map(String)
  .sort((a, b) => opName(a).localeCompare(opName(b)));
/* ---------- the filter ----------
   Every dimension is independent and they AND together, so "the last two days,
   letters only" is a combination rather than a scope somebody had to predefine.
   null means "don't care". */
const EMPTY = {from:null, to:null, op:null, gid:null, sid:null, drill:null};
const DIMS = Object.keys(EMPTY);
const isEmpty = f => DIMS.every(k => f[k] == null);

function filterRuns(f){
  return graded.filter(r =>
       (!f.from  || r.day >= f.from)
    && (!f.to    || r.day <= f.to)
    && (!f.op    || String(opOf(r)) === String(f.op))
    && (!f.gid   || r.gid === +f.gid)
    && (!f.sid   || r.sid === +f.sid)
    && (!f.drill || drillOf(r) === f.drill));
}

function filterLabel(f){
  const bits = [];
  if (f.from || f.to){
    const a = f.from || days[0], b = f.to || days[days.length - 1];
    bits.push(a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`);
  }
  if (f.op) bits.push(opName(f.op));
  if (f.sid) bits.push(`${G[S[f.sid].gid].label} · session ${S[f.sid].seq}`);
  else if (f.gid) bits.push(G[f.gid].label);
  if (f.drill) bits.push(DATA.modes[f.drill] || f.drill);
  return bits.length ? bits.join(' · ') : 'All time';
}

/* The breakdown columns show the level below whatever is pinned: runs inside a
   session, sessions inside an assignment, otherwise days if the range spans
   more than one, and assignments if it does not. */
function children(f, runs){
  const by = (keyOf, name, short) => {
    const out = new Map();
    for (const r of runs){
      const k = keyOf(r);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return [...out.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, {numeric:true}))
      .map(([k, rs]) => ({k, name: name(k), short: short(k), runs: rs}));
  };
  if (f.sid) return by(r => r.seq, k => 'Run ' + k, k => 'R' + k);
  if (f.gid) return by(r => r.sid, k => 'Session ' + S[k].seq, k => 'S' + S[k].seq);
  if (new Set(runs.map(r => r.day)).size > 1) return by(r => r.day, fmtDay, fmtDayShort);
  return by(r => r.gid, k => G[k].label, k => G[k].label.replace(/ · .*/, ''));
}

/* ---------- speed ----------
   Speed is a property of the session, so any scope wider than one can hold
   several. The tile averages over runs (a session you ran three times counts
   three times, because that is how much practice happened at that speed) and
   the breakdown at the bottom shows the split. */
const speedOf = r => S[r.sid];
const hasSpeed = r => speedOf(r).charWpm != null;

function meanSpeed(runs){
  const known = runs.filter(hasSpeed);
  if (!known.length) return null;
  const mean = k => known.reduce((n, r) => n + +speedOf(r)[k], 0) / known.length;
  const range = k => {
    const v = known.map(r => +speedOf(r)[k]);
    return [Math.min(...v), Math.max(...v)];
  };
  return {char: mean('charWpm'), eff: mean('effWpm'),
          charRange: range('charWpm'), effRange: range('effWpm'),
          known: known.length, missing: runs.length - known.length};
}

/* one entry per distinct char/eff pair, most practiced first */
function speedSplit(runs){
  const out = new Map();
  for (const r of runs.filter(hasSpeed)){
    const s = speedOf(r), k = `${+s.charWpm}/${+s.effWpm}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return [...out.entries()]
    .map(([k, rs]) => ({k, runs: rs, sessions: new Set(rs.map(r => r.sid)).size}))
    .sort((a, b) => b.runs.length - a.runs.length || a.k.localeCompare(b.k));
}

const num = v => Number.isInteger(v) ? String(v) : v.toFixed(1);

/* ---------- render helpers ---------- */
const tile = (n, l, d) => `<div class="tile"><div class="n">${esc(n)}</div>
  <div class="l">${esc(l)}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
/* red -> green by score. `floor` sets where the scale bottoms out: run
   accuracy is interesting between 50-100%, miss rate between 0-40%. */
const hue = (pct, floor) => Math.max(0, Math.min(130, (pct - floor) / (100 - floor) * 130));
const bar = (f, pct, floor = 50) => `<div class="bar-g"><i style="width:${
  Math.max(0, Math.min(1, f)) * 100}%;background:hsl(${hue(pct, floor).toFixed(0)} 62% var(--barL))"></i></div>`;
const table = (head, rows) => rows.length
  ? `<div class="scroll"><table><thead><tr>${head}</tr></thead>
     <tbody>${rows.join('')}</tbody></table></div>` : '';

function sparkline(f, runs){
  if (runs.length < 2) return '';
  const pts = runs.map(r => stats([r]).pctRight);
  const w = 640, h = 96, pad = 16;
  const lo = Math.min(...pts, 99), span = Math.max(100 - lo, 1);
  const step = (w - 2 * pad) / (pts.length - 1);
  const xy = pts.map((v, i) => [pad + i * step, pad + (100 - v) / span * (h - 2 * pad - 10)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const lbl = runs.map(r => f.sid ? 'R' + r.seq
    : `S${S[r.sid].seq}R${r.seq}`);  // how much context a tick needs
  // Per-point labels collide badly past a handful of runs, so only the two ends
  // are drawn; everything else is on hover, reported in the caption above.
  const ends = [0, xy.length - 1].map(i => `<text x="${xy[i][0].toFixed(1)}" y="${h - 2}"
    font-size="10" text-anchor="${i ? 'end' : 'start'}"
    fill="var(--muted)">${esc(lbl[i])}</text>`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="accuracy per run">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"
      fill="var(--accent)"/>`).join('')}
    ${xy.map(([x, y], i) => `<circle class="hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}"
      r="11" fill="transparent" data-lbl="${esc(lbl[i])}" data-val="${pts[i].toFixed(1)}"
      ><title>${esc(lbl[i])}: ${pts[i].toFixed(1)}%</title></circle>`).join('')}
    ${ends}
  </svg>`;
}

function recvCells(snt, rcv, kinds){
  let out = '';
  for (let i = 0; i < kinds.length; i++)
    out += `<span class="ch k-${kinds[i]}">${esc(rcv[i] || '_')}</span>`;
  return `<span class="mono">${out}</span>`;
}
function whatHappened(snt, rcv, kinds){
  const m = [], w = [], x = [];
  for (let i = 0; i < kinds.length; i++){
    if (kinds[i] === 'm') m.push(snt[i]);
    else if (kinds[i] === 'w') w.push(`${snt[i]}→${rcv[i]}`);
    else if (kinds[i] === 'x') x.push(rcv[i]);
  }
  if (kinds.includes('t')) return '<span class="pill trans">transposed</span>';
  if (!m.length && !w.length && !x.length) return '<span class="pill ok">clean</span>';
  const bits = [];
  if (m.length) bits.push('missed ' + m.join(', '));
  if (w.length) bits.push('heard ' + w.join(', '));
  if (x.length) bits.push('extra ' + x.join(', '));
  return esc(bits.join('; ')).replace(/→/g, '&rarr;');
}
/* ---------- panels ---------- */
function panelHeadline(runs, st){
  const perRun = runs.map(r => stats([r]).pctRight);
  let delta = '';
  if (perRun.length > 1){
    const d = perRun[perRun.length - 1] - perRun[0];
    delta = `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'}
             ${Math.abs(d).toFixed(1)} pts</span>`;
  }
  const best = perRun.length ? Math.max(...perRun) : 0;
  const sp = meanSpeed(runs);
  let spTile;
  if (!sp){
    spTile = tile('—', 'wpm', 'speed not recorded');
  } else {
    const vary = sp.charRange[0] !== sp.charRange[1] || sp.effRange[0] !== sp.effRange[1];
    const note = vary
      ? `average of ${speedSplit(runs).length} speeds`
      : 'character / effective';
    spTile = tile(`${num(sp.char)}/${num(sp.eff)}`, 'wpm',
                  note + (sp.missing ? ` · ${sp.missing} run(s) unrecorded` : ''));
  }
  return `<div class="tiles">
    ${spTile}
    ${tile(st.chars, 'chars copied')}
    ${tile(st.wrong, 'chars wrong')}
    ${tile(st.pctWrong.toFixed(1) + '%', 'percent wrong')}
    ${tile(st.pctRight.toFixed(1) + '%', 'accuracy', delta)}
    ${tile(best.toFixed(1) + '%', 'best run')}
    ${tile(trouble(st).length, 'trouble letters')}</div>`;
}

function panelPractice(f, runs, st){
  const tr = trouble(st);
  const chips = tr.length
    ? `<div class="trouble">${tr.map(([c, m]) =>
        `<span class="tr-chip">${esc(c)}<small>&times;${m.total}</small></span>`).join('')}</div>`
    : `<p class="none">nothing missed ${TH}+ times in this scope.</p>`;

  const kids = children(f, runs);
  // the split columns need something to split; Sent/Missed/Correct do not
  const kidStats = kids.length > 1 ? kids.map(k => ({...k, st: stats(k.runs)})) : [];
  const head = `<th>Char</th>${kidStats.map(k =>
      `<th class="num" title="${esc(k.name)}">${esc(k.short)}</th>`).join('')}
    <th class="num">Sent</th><th class="num">Missed</th><th class="num">Correct</th>`;
  const rows = tr.map(([c, m]) => {
    const sent = st.sent.get(c) || 0;
    const right = sent ? Math.max(0, 100 * (sent - m.total) / sent) : null;
    return `<tr><td class="mono" style="font-weight:700">${esc(c)}</td>
    ${kidStats.map(k => `<td class="num">${k.st.miss.get(c)?.total || ''}</td>`).join('')}
    <td class="num">${sent}</td>
    <td class="num" style="font-weight:700">${m.total}</td>
    <td class="num" style="font-weight:700${right == null ? ''
      : `;color:hsl(${hue(right, 50).toFixed(0)} 62% var(--barL))`}">${
      right == null ? '&mdash;' : right.toFixed(0) + '%'}</td></tr>`;
  });

  const conf = [...st.conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const confHtml = conf.length
    ? table('<th>Sent &rarr; Heard</th><th class="num">Times</th>',
        conf.map(([k, n]) => `<tr><td class="mono">${esc(k).replace('→', ' &rarr; ')}</td>
          <td class="num">${n}</td></tr>`))
    : `<p class="none">no substitutions &mdash; every error was a
       "didn't know" or a transposition.</p>`;

  return `<div class="cols">
    <div class="panel"><h3>Practice these (missed ${TH}+ times)</h3>${chips}
      ${table(head, rows)}</div>
    <div class="panel"><h3>Confusions &mdash; heard as something else</h3>${confHtml}</div>
  </div>`;
}

function panelProgress(f, runs){
  const spark = sparkline(f, runs);
  if (!spark) return '';
  const pts = runs.map(r => stats([r]).pctRight);
  const cap = `${runs.length} runs · ${pts[0].toFixed(1)}% → ${pts[pts.length - 1].toFixed(1)}%`
    + ` · best ${Math.max(...pts).toFixed(1)}%`;
  return `<div class="panel"><h3>Accuracy per run</h3>
    <div class="sparkcap" id="sparkcap" data-default="${esc(cap)}">${esc(cap)}</div>
    ${spark}</div>`;
}

function panelRuns(f, runs){
  const anyTrans = runs.some(r => r.cells.some(([, , k]) => k.includes('t')));
  const rows = runs.map((r, i) => {
    const st = stats([r]);
    const s = S[r.sid];
    const drill = f.drill || drills.length < 2 ? ''
      : ` <span class="pill drill">${esc(s.modeLabel)}</span>`;
    const who = f.op || ops.length < 2 ? ''
      : ` <span class="pill op">${esc(opCall(G[r.gid].op))}</span>`;
    const where = f.sid ? `Run ${r.seq}`
      : `S${s.seq} R${r.seq}`
        + (f.gid ? '' : ` <span class="pill pending">${esc(G[r.gid].label)}</span>`)
        + drill + who;
    const missed = [...stats([r]).miss.keys()].sort().join(' ');
    return `<tr class="click" data-run="${i}">
      <td>${where} ${r.final ? '<span class="pill trans">final</span>' : ''}</td>
      <td class="num">${st.chars - st.wrong}/${st.chars}</td>
      <td class="num">${st.pctRight.toFixed(1)}%</td>
      <td class="num">${st.clean}/${st.grp}</td>
      ${anyTrans ? `<td class="num">${st.transposed || ''}</td>` : ''}
      <td class="mono">${esc(missed) || '&mdash;'}</td>
      <td style="width:110px">${bar(st.pctRight / 100, st.pctRight)}</td></tr>
      <tr id="d${i}" hidden><td colspan="${anyTrans ? 7 : 6}">${runDetail(r)}</td></tr>`;
  });
  return `<div class="panel"><h3>Runs in scope (click one for detail)</h3>
    ${table(`<th>Run</th><th class="num">Chars right</th><th class="num">Correct</th>
      <th class="num">Clean groups</th>${anyTrans ? '<th class="num">Transposed</th>' : ''}
      <th>Chars missed</th><th>Accuracy</th>`, rows)}</div>`;
}

function runDetail(r){
  const head = `<th class="num">#</th><th>Sent</th><th>You copied</th>
    <th class="num">Wrong</th><th>What happened</th>`;
  const row = ([snt, rcv, kinds], i) => `<tr><td class="num">${i + 1}</td>
    <td class="mono">${esc(snt) || '&mdash;'}</td><td>${recvCells(snt, rcv, kinds)}</td>
    <td class="num">${(kinds.match(/[mwt]/g) || []).length || ''}</td>
    <td>${whatHappened(snt, rcv, kinds)}</td></tr>`;
  const bad = r.cells.map((c, i) => [c, i]).filter(([c]) => /[mwtx]/.test(c[2]));
  return (bad.length
      ? table(head, bad.map(([c, i]) => row(c, i)))
      : '<p class="none">perfect run &mdash; nothing missed.</p>')
    + `<details><summary>Show all ${r.cells.length} groups</summary>
       ${table(head, r.cells.map(row))}
       <div class="legend">
         <span><span class="ch k-c">A</span> correct</span>
         <span><span class="ch k-m">.</span> missed</span>
         <span><span class="ch k-w">X</span> heard wrong</span>
         <span><span class="ch k-t">X</span> transposed</span>
         <span><span class="ch k-x">X</span> extra</span></div></details>`;
}

function panelChars(st){
  const chars = [...st.sent.keys()].sort((a, b) =>
    (st.miss.get(b)?.total || 0) - (st.miss.get(a)?.total || 0) || a.localeCompare(b));
  // A column of nothing but blanks is noise - only show a breakdown that happened.
  const kinds = [['missed', "Didn't know"], ['wrong', 'Heard wrong'],
                 ['transposed', 'Transposed']]
    .filter(([k]) => [...st.miss.values()].some(m => m[k] > 0));
  const rows = chars.map(c => {
    const m = st.miss.get(c) || {missed:0, wrong:0, transposed:0, total:0};
    const n = st.sent.get(c), rate = m.total / n;
    return `<tr${m.total >= TH ? ' style="font-weight:700"' : ''}>
      <td class="mono">${esc(c)}</td><td class="num">${n}</td>
      <td class="num">${m.total || ''}</td><td class="num">${(rate * 100).toFixed(0)}%</td>
      ${kinds.map(([k]) => `<td class="num">${m[k] || ''}</td>`).join('')}
      <td style="width:110px">${bar(rate, 100 - rate * 100, 60)}</td></tr>`;
  });
  return `<div class="panel"><h3>Every character in scope</h3>
    <details><summary>Show exposure and miss rate for all ${chars.length} characters</summary>
    ${table(`<th>Char</th><th class="num">Sent</th><th class="num">Missed</th>
      <th class="num">Miss %</th>
      ${kinds.map(([, l]) => `<th class="num">${l}</th>`).join('')}
      <th>Miss rate</th>`, rows)}
    </details></div>`;
}

function panelSpeeds(runs){
  const split = speedSplit(runs);
  if (split.length < 2) return '';  // the tile already says it
  const rows = split.map(s => {
    const st = stats(s.runs);
    const days = [...new Set(s.runs.map(r => r.day))].sort();
    return `<tr><td class="mono" style="font-weight:700">${esc(s.k)}</td>
      <td class="num">${s.sessions}</td>
      <td class="num">${s.runs.length}</td>
      <td class="num">${st.chars}</td>
      <td class="num">${st.wrong}</td>
      <td class="num" style="font-weight:700;color:hsl(${
        hue(st.pctRight, 50).toFixed(0)} 62% var(--barL))">${st.pctRight.toFixed(1)}%</td>
      <td>${esc(days.length > 1 ? `${fmtDayShort(days[0])} – ${fmtDayShort(days[days.length - 1])}`
                                : fmtDayShort(days[0]))}</td></tr>`;
  });
  return `<div class="panel"><h3>Speeds in scope</h3>
    ${table(`<th>wpm</th><th class="num">Sessions</th><th class="num">Runs</th>
      <th class="num">Chars</th><th class="num">Wrong</th>
      <th class="num">Correct</th><th>When</th>`, rows)}
    <p class="none" style="margin:.6rem 0 0">Character speed / effective (Farnsworth)
    speed. The tile at the top averages these across runs.</p></div>`;
}

function panelContext(f, runs){
  // only one assignment (or one session of it) maps onto one set of settings
  const gid = f.sid ? S[f.sid].gid : f.gid;
  if (!gid) return '';
  const g = G[gid];
  const mine = DATA.sessions.filter(x => f.sid ? x.id === +f.sid : x.gid === +gid);
  const uniq = a => [...new Set(a)].join(', ') || '-';
  const bits = [
    ...(ops.length > 1 ? [`<span>Operator <b>${esc(opName(g.op))}</b></span>`] : []),
    `<span>Assignment <b>${esc(g.assignment)}</b></span>`,
    `<span>Drill <b>${esc(uniq(mine.map(x => x.modeLabel)))}</b></span>`,
    `<span>Speed <b>${esc(uniq(mine.map(x => x.charWpm == null ? 'not recorded'
      : `${+x.charWpm}/${+x.effWpm} wpm`)))}</b></span>`];
  const note = f.sid ? S[f.sid].notes : g.notes;
  return `<div class="panel"><h3>About this ${f.sid ? 'session' : 'assignment'}</h3>
    <div class="scopeline" style="flex:1">${bits.join(' &middot; ')}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;
}
/* ---------- controller ---------- */
let F = {...EMPTY};

const ctl = k => document.getElementById('f-' + k);

function buildControls(){
  const opt = (v, label, n, cur) =>
    `<option value="${esc(v)}"${String(cur ?? '') === String(v) ? ' selected' : ''}>`
    + `${esc(label)}${n == null ? '' : ` (${n})`}</option>`;
  /* Counts are computed with that one dimension replaced, so a choice that
     would empty the page says so before you pick it. */
  const n = over => filterRuns({...F, ...over}).length;

  let h = opt('', 'Earliest', null, F.from);
  for (const d of days) h += opt(d, fmtDay(d), null, F.from);
  ctl('from').innerHTML = h;

  h = opt('', 'Latest', null, F.to);
  for (const d of [...days].reverse()) h += opt(d, fmtDay(d), null, F.to);
  ctl('to').innerHTML = h;

  h = opt('', 'Everyone', n({op:null}), F.op);
  for (const o of ops) h += opt(o, opName(o), n({op:o}), F.op);
  ctl('op').innerHTML = h;
  document.getElementById('w-op').hidden = ops.length < 2;

  h = opt('', 'All assignments', n({gid:null, sid:null}), F.gid);
  for (const g of [...DATA.groups].reverse())
    h += opt(g.id, g.label, n({gid:g.id, sid:null}), F.gid);
  ctl('gid').innerHTML = h;

  // sessions cascade off the assignment, and drop out when nothing is left
  h = opt('', 'All sessions', n({sid:null}), F.sid);
  for (const s of [...DATA.sessions].reverse()){
    if (F.gid && s.gid !== +F.gid) continue;
    const c = n({sid:s.id});
    if (c || String(F.sid) === String(s.id))
      h += opt(s.id, `${F.gid ? '' : G[s.gid].label + ' · '}session ${s.seq}`, c, F.sid);
  }
  ctl('sid').innerHTML = h;

  h = opt('', 'All drills', n({drill:null}), F.drill);
  for (const d of drills) h += opt(d, DATA.modes[d] || d, n({drill:d}), F.drill);
  ctl('drill').innerHTML = h;
  document.getElementById('w-drill').hidden = drills.length < 2;
}

function wireControls(){
  for (const k of DIMS) ctl(k).onchange = () => {
    const v = ctl(k).value || null;
    const next = {...F, [k]: v};
    // keep the combination coherent rather than silently empty
    if (k === 'gid' && next.sid && S[next.sid] && String(S[next.sid].gid) !== String(v))
      next.sid = null;
    if (k === 'sid' && v) next.gid = String(S[v].gid);
    if (k === 'from' && v && next.to && v > next.to) next.to = null;
    if (k === 'to' && v && next.from && v < next.from) next.from = null;
    setFilter(next);
  };
  document.getElementById('clear').onclick = () => setFilter({...EMPTY});
}

function buildQuick(){
  const last = graded[graded.length - 1];
  const items = [['All time', {...EMPTY}]];
  if (days.length > 1){
    const d = days[days.length - 1];
    items.push([fmtDay(d), {...EMPTY, from:d, to:d}]);
  }
  for (const w of WINDOWS.filter(w => w === 2 || w === 7))
    items.push([`Last ${w} days`, {...EMPTY, from: days[days.length - w]}]);
  if (last){
    items.push(['Latest assignment', {...EMPTY, gid: String(last.gid)}]);
    items.push(['Latest session',
                {...EMPTY, gid: String(S[last.sid].gid), sid: String(last.sid)}]);
  }
  document.getElementById('quick').innerHTML = items.map(([l, s], i) =>
    `<button data-i="${i}">${esc(l)}</button>`).join('');
  document.querySelectorAll('#quick button').forEach(b => {
    b.onclick = () => setFilter(items[+b.dataset.i][1]);
  });
  return items;
}

/* ---------- the URL carries the whole filter ---------- */
function hashOf(f){
  const parts = DIMS.filter(k => f[k] != null && f[k] !== '')
    .map(k => `${k}=${encodeURIComponent(f[k])}`);
  return parts.length ? '#' + parts.join('&') : '#all';
}

function validFilter(f){
  return (!f.from || days.includes(f.from))
    && (!f.to || days.includes(f.to))
    && (!f.op || ops.includes(String(f.op)))
    && (!f.gid || !!G[f.gid])
    && (!f.sid || !!S[f.sid])
    && (!f.drill || drills.includes(f.drill));
}

function filterFromHash(){
  const raw = (location.hash || '').slice(1);
  if (!raw) return null;
  if (raw === 'all') return {...EMPTY};
  if (raw.includes('=')){
    const f = {...EMPTY};
    let any = false;
    for (const part of raw.split('&')){
      const [k, v] = part.split('=');
      if (!DIMS.includes(k) || !v) continue;
      f[k] = decodeURIComponent(v);
      any = true;
    }
    return any && validFilter(f) ? f : null;
  }
  // links written before the filter bar existed: #group:8, #day:2026-09-10
  const [t, k] = raw.split(':');
  if (!t || !k) return null;
  const legacy = {
    day: () => ({from:k, to:k}),
    group: () => ({gid:k}),
    session: () => S[k] ? {gid:String(S[k].gid), sid:k} : null,
    drill: () => ({drill:k}),
    operator: () => ({op:k}),
    last: () => days.length > +k ? {from: days[days.length - +k]} : null,
  };
  const made = legacy[t] && legacy[t]();
  const f = made && {...EMPTY, ...made};
  return f && validFilter(f) ? f : null;
}

function setFilter(next){
  F = {...EMPTY, ...next};
  buildControls();
  document.querySelectorAll('#quick button').forEach((b, i) => {
    b.setAttribute('aria-pressed', String(hashOf(QUICK[i][1]) === hashOf(F)));
  });
  try { history.replaceState(null, '', hashOf(F)); } catch (e) {}
  render();
}

function render(){
  const runs = filterRuns(F);
  const st = stats(runs);
  const sess = new Set(runs.map(r => r.sid)).size;
  const grps = new Set(runs.map(r => r.gid)).size;
  const dys = [...new Set(runs.map(r => r.day))].sort();
  const span = dys.length > 1 ? `${fmtDay(dys[0])} – ${fmtDay(dys[dys.length - 1])}`
    : fmtDay(dys[0]);
  const sp = meanSpeed(runs);
  const varies = sp && (sp.charRange[0] !== sp.charRange[1]
                        || sp.effRange[0] !== sp.effRange[1]);
  document.getElementById('scopeline').innerHTML =
    `<b>${esc(filterLabel(F))}</b> — ${grps} group${grps === 1 ? '' : 's'},
     ${sess} session${sess === 1 ? '' : 's'}, ${runs.length} run${runs.length === 1 ? '' : 's'}
     · ${esc(span)}`
    + (sp ? ` · <b>${varies ? 'avg ' : ''}${num(sp.char)}/${num(sp.eff)} wpm</b>` : '');

  const app = document.getElementById('app');
  if (!runs.length){
    app.innerHTML = '<p class="none">No graded runs match these filters.</p>';
    return;
  }
  app.innerHTML = panelHeadline(runs, st) + panelPractice(F, runs, st)
    + panelProgress(F, runs) + panelRuns(F, runs) + panelChars(st)
    + panelSpeeds(runs) + panelContext(F, runs);

  app.querySelectorAll('tr.click').forEach(tr => {
    tr.onclick = () => {
      const d = document.getElementById('d' + tr.dataset.run);
      d.hidden = !d.hidden;
    };
  });

  const cap = document.getElementById('sparkcap');
  if (cap){
    app.querySelectorAll('circle.hit').forEach(c => {
      c.onmouseenter = () => {
        cap.textContent = `${c.getAttribute('data-lbl')} — ${c.getAttribute('data-val')}% correct`;
      };
    });
    const svg = app.querySelector('.spark');
    if (svg) svg.onmouseleave = () => { cap.textContent = cap.getAttribute('data-default'); };
  }
}

document.getElementById('sub').textContent =
  (ops.length === 1 && O[ops[0]] ? opName(ops[0]) + ' · ' : '')
  + `${DATA.groups.length} group(s), ${DATA.sessions.length} session(s), `
  + `${graded.length} graded run(s) · generated `
  + new Date(DATA.generated).toLocaleString();

wireControls();
const QUICK = buildQuick();
setFilter(filterFromHash() || {...EMPTY});

// following a link into a tab that already has the report open would otherwise
// change the URL and nothing else
if (typeof window !== 'undefined' && window.addEventListener)
  window.addEventListener('hashchange', () => {
    const next = filterFromHash();
    if (next && hashOf(next) !== hashOf(F)) setFilter(next);
  });