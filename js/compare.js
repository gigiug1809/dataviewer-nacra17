/* CONFRONTO DEI TRATTI (stessa uscita): una finestra con
   - "Cosa cambia": frasi semplici su cosa distingue il tratto migliore dagli altri;
   - tabella: una colonna per tratto, il valore migliore di ogni riga in verde;
   - grafici sovrapposti, allineati dal secondo 0 di ogni tratto;
   - "di solito": per ogni tratto dove sta la velocità (o l'heel, il trim) 8 secondi su 10;
   - tracce dei tratti.
   Si confrontano solo i secondi in cui si naviga (sopra 4 kn, fuori dalle manovre); con il vento noto
   si può scegliere l'andatura (solo bolina, solo poppa…), perché confrontare bolina e poppa non ha senso. */
'use strict';

const CMP_MODES = [['tutto', 'tutto il navigato'], ['bolina', 'solo bolina'], ['traverso', 'solo traverso'], ['poppa', 'solo poppa']];

/* secondi navigati di un tratto (ogni 0,5 s) e maschera a 100 ms per le misure di oscillazione */
function sailedSamples(S, a, b, mode) {
  const ch = pickChannels(S), step = 500, out = [];
  const st = S.wind ? sailStates(S, a, b, step) : null;
  const man = st ? null : maneuverWindows(S);
  const n = Math.max(0, Math.floor((b - a) / step));
  for (let k = 0; k < n; k++) {
    const t = a + k * step;
    let s;
    if (st) {
      s = st[k];
      if (!s || s.mode === 'lento' || s.mode === 'manovra' || (mode !== 'tutto' && s.mode !== mode)) continue;
    } else {
      const v = ch.sog ? interp(ch.sog, t) : NaN;
      if (!(v >= SAIL_MIN_KN) || man.some(([x, y]) => t >= x && t <= y)) continue;
      s = { v, t, mode: 'tutto' };
    }
    const hv = ch.heel ? interp(ch.heel, t) : NaN, pv = ch.pitch ? interp(ch.pitch, t) : NaN;
    out.push({ t, v: s.v, vmg: s.vmg, A: s.A, tack: s.tack, mode: s.mode,
      heel: isFinite(hv) ? (s.tack ? (s.tack === 'dritta' ? -hv : hv) : Math.abs(hv)) : NaN, pitch: pv });
  }
  const m = Math.max(0, Math.floor((b - a) / 100)), mask = new Uint8Array(m).fill(1);
  for (const s of out) { const k0 = Math.floor((s.t - a) / 100); for (let k = k0; k < Math.min(m, k0 + 5); k++) mask[k] = 0; }
  return { out, mask };
}
function sdOf(arr) { const m = meanOf(arr); return arr.length > 1 ? Math.sqrt(arr.reduce((x, v) => x + (v - m) * (v - m), 0) / arr.length) : NaN; }
function maxOf(arr) { let m = -Infinity; for (const v of arr) if (v > m) m = v; return m; }

/* tutte le misure di un tratto per il confronto */
function compareMeasures(S, seg, mode) {
  const a = seg.t, b = seg.t2, ch = pickChannels(S);
  const { out, mask } = sailedSamples(S, a, b, mode);
  const fin = arr => arr.filter(isFinite);
  const v = fin(out.map(s => s.v)), heel = fin(out.map(s => s.heel)), pitch = fin(out.map(s => s.pitch));
  const vmg = mode === 'bolina' ? fin(out.map(s => s.vmg)) : mode === 'poppa' ? fin(out.map(s => -s.vmg)) : [];
  const A = mode === 'bolina' || mode === 'poppa' ? fin(out.map(s => s.A)) : [];
  const r = { seg, a, b, n: out.length, time: out.length * 500, out };
  if (v.length) Object.assign(r, { v: meanOf(v), vMax: maxOf(v), v10: pctl(v, 0.1), v50: pctl(v, 0.5), v90: pctl(v, 0.9), vSd: sdOf(v), dist: v.reduce((x, y) => x + y, 0) * 0.5 / 3600 * 1852 });
  if (vmg.length) Object.assign(r, { vmg: meanOf(vmg), vmg10: pctl(vmg, 0.1), vmg90: pctl(vmg, 0.9) });
  if (A.length) r.A = meanOf(A);
  if (heel.length) Object.assign(r, { heel: meanOf(heel), heelSd: sdOf(heel), heel10: pctl(heel, 0.1), heel50: pctl(heel, 0.5), heel90: pctl(heel, 0.9), heelMax: maxOf(heel) });
  if (pitch.length) Object.assign(r, { pitch: meanOf(pitch), pitchSd: sdOf(pitch), pitch10: pctl(pitch, 0.1), pitch50: pctl(pitch, 0.5), pitch90: pctl(pitch, 0.9) });
  const hw = wobble(ch.heel, a, b, false, mask), pw = wobble(ch.pitch, a, b, false, mask);
  if (hw) { r.heelW = hw.sd; r.heelEvery = hw.perMin > 0 ? 60 / hw.perMin : NaN; }
  if (pw) r.pitchW = pw.sd;
  if (ch.yaw) { const st = steadyStats(ch, a, b, mask); if (st.turns != null) r.turns = st.turns; }
  if (ch.peak) { let c = 0, last = -1e9; const i0 = idxAt(ch.peak.t, a), i1 = idxAt(ch.peak.t, b); for (let i = i0; i < i1; i++) if (ch.peak.v[i] > 3 && ch.peak.t[i] - last > 5000) { c++; last = ch.peak.t[i]; } r.hits = c / Math.max(1, (b - a) / 60000); }
  const mans = segmentManeuvers(S, a, b).filter(x => x.m && isFinite(x.m.sIn));
  r.nMan = mans.length;
  if (mans.length) r.manLost = meanOf(mans.map(x => x.m.lost));
  const Q = dataQuality(S, a, b); if (Q) r.quality = Q.good;
  return r;
}

/* righe della tabella: [nome, valore, decimali, unità, meglio: 'alto' | 'basso' | null, solo se] */
const CMP_ROWS = [
  ['Tempo navigato', r => r.time, 'dur', '', null],
  ['Distanza', r => r.dist, 0, 'm', null],
  ['Velocità media', r => r.v, 1, 'kn', 'alto'],
  ['Velocità: di solito', r => isFinite(r.v10) ? [r.v10, r.v90] : NaN, 1, 'kn', null],
  ['Velocità massima', r => r.vMax, 1, 'kn', 'alto'],
  ['Velocità: deviazione', r => r.vSd, 2, 'kn', 'basso'],
  ['VMG medio', r => r.vmg, 1, 'kn', 'alto', m => m === 'bolina' || m === 'poppa'],
  ['Angolo al vento (TWA)', r => r.A, 0, '°', null, m => m === 'bolina' || m === 'poppa'],
  ['Heel medio (sottovento +)', r => r.heel, 1, '°', null],
  ['Heel: oscillazione', r => r.heelW, 1, '°', 'basso'],
  ['Heel: massimo', r => r.heelMax, 1, '°', null],
  ['Trim medio (prua su +)', r => r.pitch, 1, '°', null],
  ['Trim: oscillazione', r => r.pitchW, 1, '°', 'basso'],
  ['Correzioni di timone', r => r.turns, 0, '/min', 'basso'],
  ['Colpi forti (> 3 g)', r => r.hits, 1, '/min', null],
  ['Manovre', r => r.nMan, 0, '', null],
  ['Manovre: metri persi in media', r => r.manLost, 0, 'm', 'basso'],
  ['Dati affidabili', r => isFinite(r.quality) ? r.quality * 100 : NaN, 0, '%', null]
];
function cmpFmt(v, dec, unit) {
  if (Array.isArray(v)) return `${fmtNum(v[0], dec)}–${fmtNum(v[1], dec)}${unit ? ' ' + unit : ''}`;
  if (!isFinite(v)) return '—';
  if (dec === 'dur') return fmtDur(v);
  return fmtNum(v, dec) + (unit ? (unit === '°' ? '°' : ' ' + unit) : '');
}

/* frasi: cosa distingue il tratto migliore */
function compareInsights(R, mode, names) {
  const out = [], f = (v, d) => fmtNum(v, d);
  const ok = R.filter(r => r.n >= 60 && isFinite(r.v));
  if (ok.length < 2) { out.push({ kind: 'warn', text: 'Per confrontare servono almeno due tratti con un minuto di navigazione' + (mode !== 'tutto' ? ` di ${mode}` : '') + '.' }); return out; }
  const others = (r, k) => meanOf(ok.filter(x => x !== r).map(x => x[k]).filter(isFinite));
  const key = (mode === 'bolina' || mode === 'poppa') && ok.every(r => isFinite(r.vmg)) ? 'vmg' : 'v';
  const best = [...ok].sort((x, y) => y[key] - x[key])[0], worst = [...ok].sort((x, y) => x[key] - y[key])[0];
  const nm = r => `«${names[R.indexOf(r)]}»`;
  const diff = best[key] - others(best, key);
  if (Math.abs(best[key] - worst[key]) < 0.2) out.push({ kind: 'good', text: `I tratti sono molto simili: ${key === 'vmg' ? 'VMG' : 'velocità media'} tra ${f(worst[key], 1)} e ${f(best[key], 1)} kn.` });
  else {
    // cosa ha di diverso il migliore rispetto agli altri
    const why = [];
    const cmp = (k, label, d, thr, fmt) => { const o = others(best, k); if (isFinite(best[k]) && isFinite(o) && Math.abs(best[k] - o) >= thr) why.push(fmt(best[k] - o, o)); };
    cmp('heel', 'heel', 1, 1.5, (x) => `heel ${f(Math.abs(x), 1)}° ${x > 0 ? 'più alto' : 'più basso'}`);
    cmp('pitch', 'trim', 1, 0.6, (x) => `prua ${f(Math.abs(x), 1)}° più ${x > 0 ? 'su' : 'giù'}`);
    cmp('heelW', 'osc', 1, 0.5, (x) => `heel ${x < 0 ? 'più stabile' : 'meno stabile'} (±${f(best.heelW, 1)}° contro ±${f(best.heelW - x, 1)}°)`);
    cmp('turns', 'timone', 0, 3, (x, o) => `timone ${x < 0 ? 'più tranquillo' : 'più nervoso'} (${f(best.turns, 0)} contro ${f(o, 0)} correzioni al minuto)`);
    if (key === 'vmg' && mode === 'bolina') cmp('A', 'twa', 0, 2, (x) => `${x < 0 ? 'stringe' : 'apre'} ${f(Math.abs(x), 0)}° ${x < 0 ? 'di più' : ''}`.trim());
    if (key === 'vmg') cmp('v', 'vel', 1, 0.4, (x) => `velocità ${x > 0 ? '+' : '−'}${f(Math.abs(x), 1)} kn`);
    out.push({ kind: 'info', text: `${nm(best)} è il ${key === 'vmg' ? 'migliore come VMG' : 'più veloce'}: ${f(best[key], 1)} kn, ${f(diff, 1)} kn in più della media degli altri${why.length ? '. Rispetto agli altri: ' + why.join(', ') : ''}.` });
    if (ok.length > 2) out.push({ kind: 'info', text: `${key === 'vmg' ? 'Il VMG più basso è di' : 'Il più lento è'} ${nm(worst)} (${f(worst[key], 1)} kn).` });
  }
  // di bolina: stringere o andare veloci? (due modi diversi di fare lo stesso VMG)
  if (mode === 'bolina' && ok.every(r => isFinite(r.A) && isFinite(r.vmg))) {
    const high = [...ok].sort((x, y) => x.A - y.A)[0], fast = [...ok].sort((x, y) => y.v - x.v)[0];
    if (high !== fast && fast.A - high.A >= 2 && fast.v - high.v >= 0.4)
      out.push({ kind: 'info', text: `${nm(high)} stringe di più (${f(high.A, 0)}° dal vento) ma va più piano (${f(high.v, 1)} kn); ${nm(fast)} apre di ${f(fast.A - high.A, 0)}° e va ${f(fast.v - high.v, 1)} kn più veloce. VMG: ${f(high.vmg, 1)} contro ${f(fast.vmg, 1)} kn${Math.abs(high.vmg - fast.vmg) < 0.3 ? ': due modi diversi di ottenere quasi lo stesso risultato' : high.vmg > fast.vmg ? ': qui conviene stringere' : ': qui conviene andare veloci'}.` });
  }
  // il più regolare
  const reg = ok.filter(r => isFinite(r.heelW)).sort((x, y) => x.heelW - y.heelW);
  if (reg.length >= 2 && reg[reg.length - 1].heelW - reg[0].heelW >= 0.5) out.push({ kind: 'good', text: `Il più regolare è ${nm(reg[0])}: heel che oscilla di ±${f(reg[0].heelW, 1)}° (il meno regolare ±${f(reg[reg.length - 1].heelW, 1)}°).` });
  // più veloce o solo più costante?
  const sp = ok.filter(r => isFinite(r.v90) && isFinite(r.v10));
  if (sp.length >= 2) { const top = [...sp].sort((x, y) => y.v90 - x.v90)[0]; if (top !== best && key === 'v') out.push({ kind: 'info', text: `${nm(top)} ha le punte più alte (8 secondi su 10 sotto i ${f(top.v90, 1)} kn) ma una media più bassa: veloce a tratti, meno costante.` }); }
  // qualità
  for (const r of R) if (isFinite(r.quality) && r.quality < 0.95) out.push({ kind: 'warn', text: `In ${nm(r)} solo il ${f(r.quality * 100, 0)}% dei dati è affidabile: i suoi numeri vanno presi con cautela.` });
  return out;
}

/* grafici sovrapposti: un colore per tratto, asse x = secondi dall'inizio del tratto */
function overlayChart(S, segs, colors, { ch, label, unit = '', dec = 1, val }) {
  const step = 500, series = [];
  let dur = 0, lo = Infinity, hi = -Infinity;
  for (const g of segs) {
    const n = Math.max(2, Math.floor((g.t2 - g.t) / step)), y = new Float64Array(n);
    for (let k = 0; k < n; k++) { const t = g.t + k * step, v = val ? val(t) : interp(ch, t); y[k] = v; if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    series.push(y); dur = Math.max(dur, n * step);
  }
  if (!isFinite(lo)) return null;
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const W = 1000, H = 160, X = s => s / dur * W, Y = v => H - (v - lo) / (hi - lo) * H;
  const ns = 'http://www.w3.org/2000/svg', el = (tag, at) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'cmp-svg' });
  if (lo < 0 && hi > 0) svg.append(el('line', { x1: 0, x2: W, y1: Y(0), y2: Y(0), class: 'sa-zero', 'vector-effect': 'non-scaling-stroke' }));
  series.forEach((y, i) => {
    let d = '', pen = false;
    for (let k = 0; k < y.length; k++) { if (!isFinite(y[k])) { pen = false; continue; } d += (pen ? 'L' : 'M') + X(k * step).toFixed(1) + ' ' + Y(y[k]).toFixed(1); pen = true; }
    svg.append(el('path', { d, fill: 'none', stroke: colors[i], 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke' }));
  });
  const show = v => isFinite(v) ? fmtNum(v, dec) + (unit ? (unit === '°' ? '°' : ' ' + unit) : '') : '—';
  const cur = h('div', { class: 'sa-cur', hidden: true }), tip = h('div', { class: 'sa-tip cmp-tip', hidden: true });
  const box = h('div', { class: 'sa-chart cmp-chart' }, svg, h('span', { class: 'sa-ax top' }, show(hi)), h('span', { class: 'sa-ax bot' }, show(lo)), cur, tip);
  box.addEventListener('pointermove', e => {
    const r = box.getBoundingClientRect(), fx = clamp((e.clientX - r.left) / r.width, 0, 1), k = Math.round(fx * dur / step);
    cur.hidden = tip.hidden = false; cur.style.left = (fx * 100) + '%';
    tip.textContent = '';
    tip.append(h('div', { class: 'muted' }, `dopo ${fmtDur(k * step)}`), ...series.map((y, i) => h('div', null, h('span', { class: 'dot', style: { background: colors[i], width: '7px', height: '7px', marginRight: '5px' } }), show(y[k]))));
    tip.style.left = clamp(fx * r.width, 70, r.width - 70) + 'px';
  });
  box.addEventListener('pointerleave', () => { cur.hidden = tip.hidden = true; });
  return h('div', { class: 'cmp-ov' }, h('div', { class: 'sm-label' }, label), box, h('div', { class: 'cmp-axis' }, h('span', null, '0'), h('span', null, fmtDur(dur / 2)), h('span', null, fmtDur(dur))));
}

/* "di solito": barra 10–90% con la mediana, per ogni tratto, sulla stessa scala */
function rangeBars(R, colors, names, { label, k10, k50, k90, mean, dec = 1, unit = '' }) {
  const rows = R.filter(r => isFinite(r[k10]) && isFinite(r[k90]));
  if (rows.length < 1) return null;
  let lo = Math.min(...rows.map(r => r[k10])), hi = Math.max(...rows.map(r => r[k90]));
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const P = v => ((v - lo) / (hi - lo) * 100).toFixed(2) + '%', u = unit === '°' ? '°' : unit ? ' ' + unit : '';
  return h('div', { class: 'cmp-rb' }, h('div', { class: 'sm-label' }, label),
    rows.map(r => { const i = R.indexOf(r); return h('div', { class: 'cmp-rb-row' },
      h('span', { class: 'cmp-rb-name' }, h('i', { style: { background: colors[i] } }), names[i]),
      h('div', { class: 'cmp-rb-track' },
        h('div', { class: 'cmp-rb-bar', style: { left: P(r[k10]), width: `calc(${P(r[k90])} - ${P(r[k10])})`, background: colors[i] + '55', borderColor: colors[i] } }),
        h('div', { class: 'cmp-rb-med', style: { left: P(r[k50]), background: colors[i] }, title: 'mediana' }),
        isFinite(r[mean]) ? h('div', { class: 'cmp-rb-mean', style: { left: P(r[mean]), borderColor: colors[i] }, title: 'media' }) : null),
      h('span', { class: 'cmp-rb-val num' }, `${fmtNum(r[k10], dec)}–${fmtNum(r[k90], dec)}${u}`)); }));
}

/* tracce dei tratti (proiezione piana), inizio segnato con un punto */
function tracksSvg(S, segs, colors) {
  if (!S.pos) return null;
  const { lat, lon } = S.pos, rad = Math.PI / 180, pts = [];
  for (const g of segs) { const p = []; for (let t = g.t; t <= g.t2; t += 1000) { const a = interp(lat, t), b = interp(lon, t); if (isFinite(a) && isFinite(b)) p.push([a, b]); } pts.push(p); }
  const all = pts.flat(); if (all.length < 2) return null;
  const la0 = all[0][0], kx = Math.cos(la0 * rad);
  const xy = pts.map(p => p.map(([a, b]) => [b * kx, -a]));
  const xs = xy.flat().map(p => p[0]), ys = xy.flat().map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sz = Math.max(x1 - x0, y1 - y0) || 1e-4, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, half = sz * 0.55;
  const W = 300, M = p => [((p[0] - (cx - half)) / (2 * half) * W).toFixed(1), ((p[1] - (cy - half)) / (2 * half) * W).toFixed(1)];
  const ns = 'http://www.w3.org/2000/svg', el = (tag, at) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${W}`, class: 'cmp-map' });
  xy.forEach((p, i) => {
    if (!p.length) return;
    svg.append(el('polyline', { points: p.map(q => M(q).join(',')).join(' '), fill: 'none', stroke: colors[i], 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
    const [sx, sy] = M(p[0]); svg.append(el('circle', { cx: sx, cy: sy, r: 4, fill: colors[i] }));
  });
  const meters = sz * 111320;
  return h('div', { class: 'cmp-mapbox' }, svg, h('div', { class: 'faint small' }, `nord in alto · il riquadro è largo circa ${meters >= 1000 ? fmtNum(meters / 1000, 1) + ' km' : fmtNum(meters, 0) + ' m'} · il punto è l'inizio`));
}

/* la finestra del confronto */
function showCompare(V, segs) {
  const S = V.S;
  segs = segs.filter(e => e.t2 != null && e.t2 - e.t >= 10000).sort((x, y) => x.t - y.t).slice(0, 6);
  if (segs.length < 2) { toast('Scegli almeno due tratti finiti.'); return; }
  const colors = segs.map((_, i) => seriesColor(i)), names = segs.map((e, i) => e.note || `Tratto ${i + 1}`);
  // andatura di partenza: se tutti i tratti sono soprattutto della stessa andatura, quella
  let mode = 'tutto';
  if (S.wind) {
    const main = segs.map(g => { const c = {}; for (const s of sailStates(S, g.t, g.t2, 1000)) if (s && s.mode !== 'lento' && s.mode !== 'manovra') c[s.mode] = (c[s.mode] || 0) + 1; const tot = Object.values(c).reduce((x, y) => x + y, 0); const top = Object.entries(c).sort((x, y) => y[1] - x[1])[0]; return top && top[1] / tot >= 0.6 ? top[0] : null; });
    if (main[0] && main.every(m => m === main[0])) mode = main[0];
  }
  const body = h('div', { class: 'cmp' });
  const draw = () => {
    body.textContent = '';
    const R = segs.map(g => compareMeasures(S, g, mode));
    const modeSel = h('select', { onchange: e => { mode = e.target.value; draw(); } }, CMP_MODES.filter(([k]) => k === 'tutto' || S.wind).map(([k, l]) => h('option', { value: k, selected: k === mode }, l)));
    body.append(...[
      h('div', { class: 'cmp-head' },
        h('div', { class: 'cmp-legend' }, segs.map((g, i) => h('span', null, h('i', { style: { background: colors[i] } }), h('b', null, names[i]), h('span', { class: 'faint' }, ` ${fmtClock(g.t)} · ${fmtDur(g.t2 - g.t)}`)))),
        h('label', { class: 'row', style: { gap: '8px' } }, 'Confronta', modeSel)),
      !S.wind ? h('div', { class: 'faint small' }, 'Senza vento (indicato o stimato) non si può separare bolina e poppa: confronto tutto il navigato.') : null,
      h('div', { class: 'faint small' }, `Contano solo i secondi in cui si naviga (sopra ${SAIL_MIN_KN} kn, fuori dalle manovre)${mode !== 'tutto' ? `, di ${mode}` : ''}.`)].filter(Boolean));
    // cosa cambia
    const ins = compareInsights(R, mode, names);
    body.append(h('div', { class: 'sm-sec' }, h('div', { class: 'sm-gh' }, 'Cosa cambia'), h('ul', { class: 'tk-ins' }, ins.map(x => h('li', { class: x.kind }, x.text)))));
    // tabella
    const rows = CMP_ROWS.filter(rw => !rw[5] || rw[5](mode));
    const tb = h('table', { class: 'ev-table cmp-table' }, h('thead', null, h('tr', null, h('th', null, ''), segs.map((g, i) => h('th', { style: { textAlign: 'right' } }, h('i', { class: 'cmp-sw', style: { background: colors[i] } }), names[i])))));
    const tbody = h('tbody');
    for (const [label, get, dec, unit, better] of rows) {
      const vals = R.map(r => r.n >= 20 ? get(r) : NaN);
      if (vals.every(v => !Array.isArray(v) && !isFinite(v))) continue;
      const nums = vals.map(v => Array.isArray(v) ? NaN : v).filter(isFinite);
      const bestV = better && nums.length >= 2 && Math.max(...nums) - Math.min(...nums) > 1e-9 ? (better === 'alto' ? Math.max(...nums) : Math.min(...nums)) : NaN;
      tbody.append(h('tr', null, h('td', null, label), vals.map(v => h('td', { class: 'num' + (isFinite(bestV) && v === bestV ? ' cmp-best' : '') }, cmpFmt(v, dec, unit)))));
    }
    tb.append(tbody);
    body.append(h('div', { class: 'sm-sec' }, h('div', { class: 'sm-gh' }, 'I numeri'), h('div', { class: 'tbl-wrap' }, tb),
      h('div', { class: 'faint small' }, 'Verde = il migliore della riga (velocità e VMG più alti; oscillazioni, correzioni e metri persi più bassi). Heel sottovento: positivo quando la barca sbanda dalla parte giusta.')));
    // grafici sovrapposti
    const ch = pickChannels(S), twa = S.ch('calc:twa');
    const leeHeel = t => { const v = interp(ch.heel, t); if (!isFinite(v)) return NaN; const a = twa ? nearestVal(twa, t, 2000) : NaN; return isFinite(a) ? (a > 0 ? -v : v) : v; };
    const charts = [
      ch.sog ? overlayChart(S, segs, colors, { ch: ch.sog, label: 'Velocità', unit: 'kn', dec: 1 }) : null,
      S.ch('calc:vmg') && (mode === 'bolina' || mode === 'poppa') ? overlayChart(S, segs, colors, { ch: S.ch('calc:vmg'), label: 'VMG', unit: 'kn', dec: 1, val: mode === 'poppa' ? t => -interp(S.ch('calc:vmg'), t) : null }) : null,
      ch.heel ? overlayChart(S, segs, colors, { ch: ch.heel, label: twa ? 'Heel sottovento (positivo = dalla parte giusta)' : 'Heel (positivo = a dritta)', unit: '°', dec: 1, val: twa ? leeHeel : null }) : null,
      ch.pitch ? overlayChart(S, segs, colors, { ch: ch.pitch, label: 'Trim (positivo = prua su)', unit: '°', dec: 1 }) : null
    ].filter(Boolean);
    if (charts.length) body.append(h('div', { class: 'sm-sec' }, h('div', { class: 'sm-gh' }, 'Nel tempo, dall\'inizio di ogni tratto'), ...charts,
      h('div', { class: 'faint small' }, 'Passa sopra un grafico per leggere i valori di tutti i tratti allo stesso secondo. Qui ci sono anche manovre e soste.')));
    // di solito
    const bars = [
      rangeBars(R, colors, names, { label: 'Velocità (kn)', k10: 'v10', k50: 'v50', k90: 'v90', mean: 'v', dec: 1, unit: 'kn' }),
      rangeBars(R, colors, names, { label: 'Heel sottovento (°)', k10: 'heel10', k50: 'heel50', k90: 'heel90', mean: 'heel', dec: 1, unit: '°' }),
      rangeBars(R, colors, names, { label: 'Trim (°)', k10: 'pitch10', k50: 'pitch50', k90: 'pitch90', mean: 'pitch', dec: 1, unit: '°' })
    ].filter(Boolean);
    const map = tracksSvg(S, segs, colors);
    if (bars.length || map) body.append(h('div', { class: 'sm-sec cmp-cols' },
      h('div', null, h('div', { class: 'sm-gh' }, 'Di solito (8 secondi su 10)'), ...bars,
        h('div', { class: 'faint small' }, 'La barra va dal 10% al 90% dei valori, la tacca è la mediana, il cerchio la media. Barra corta = tratto regolare; barra più a destra = valori più alti.')),
      map ? h('div', null, h('div', { class: 'sm-gh' }, 'Tracce'), map) : null));
  };
  draw();
  modal({ title: `Confronto di ${segs.length} tratti`, body, wide: true, actions: [
    { label: 'Velocità e manovre nel dettaglio', run: () => { setTimeout(() => showPerformance(V, { segs, tab: 'velocita' }), 30); } },
    { label: 'Chiudi', kind: 'primary' }] });
}

/* scelta dei tratti da confrontare (se nel pannello Eventi non ne è spuntato nessuno) */
function pickSegmentsToCompare(V, pre = []) {
  const S = V.S, segs = S.meta.events.filter(e => e.type === 'tratto' && e.t2 != null);
  if (segs.length < 2) { toast('Servono almeno due tratti salvati (segnati dal Live, dal telefono o con "Salva come tratto").', 6000); return; }
  const sel = new Set(pre.length >= 2 ? pre : segs.map(e => e.id).slice(0, 6));
  const list = h('div', { style: { display: 'grid', gap: '6px' } }, segs.map((e, i) => h('label', { class: 'row', style: { gap: '8px' } },
    h('input', { type: 'checkbox', checked: sel.has(e.id), onchange: ev => { if (ev.target.checked) sel.add(e.id); else sel.delete(e.id); } }),
    h('b', null, e.note || `Tratto ${i + 1}`), h('span', { class: 'faint' }, `${fmtClock(e.t)} · ${fmtDur(e.t2 - e.t)}`))));
  modal({ title: 'Quali tratti confrontare?', body: h('div', { style: { display: 'grid', gap: '10px' } }, h('p', { class: 'muted', style: { margin: 0 } }, 'Da 2 a 6 tratti.'), list),
    actions: [{ label: 'Annulla' }, { label: 'Confronta', kind: 'primary', run: () => {
      const chosen = segs.filter(e => sel.has(e.id));
      if (chosen.length < 2) { toast('Scegli almeno due tratti.'); return false; }
      setTimeout(() => showCompare(V, chosen), 30);
    } }] });
}
