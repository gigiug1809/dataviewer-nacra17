/* PRESTAZIONI: analisi della VELOCITÀ (tratti di navigazione dritta) e delle MANOVRE, sul modello di Vantage Sailing,
   su tutta l'uscita oppure su più tratti a confronto (un colore per gruppo).
   - Velocità: solo i tratti dritti (almeno 20 s con stessa andatura e mure, rotta entro ±20°, sopra 4 kn, fuori dalle manovre),
     separati per bolina/poppa e mure; box plot, violin, dispersione; filtri Top 50% / Top 20% per VMG;
     stabilità del timone (variazione della velocità di rotazione), dell'heel e della velocità (variazione dell'accelerazione).
   - Manovre: ogni virata e strambata allineata a metà rotazione; velocità in entrata/minima/in uscita, VMG medio e minimo,
     metri guadagnati lungo l'asse del vento, rotazione massima, angolo, heel massimo, decelerazione e accelerazione massime;
     curve sovrapposte con mediana e fascia centrale, tracce nel riferimento del vento, box plot per misura. */
'use strict';

const PERF_TOP = [[1, 'Tutto'], [0.5, 'Top 50%'], [0.2, 'Top 20%']];
const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, at = {}, ...kids) { const e = document.createElementNS(SVGNS, tag); for (const k in at) if (at[k] != null) e.setAttribute(k, at[k]); for (const c of kids) if (c != null) e.append(c); return e; }
function svText(x, y, txt, at = {}) { return sv('text', Object.assign({ x, y, 'font-size': 11, fill: 'currentColor' }, at), String(txt)); }
function niceTicks(lo, hi, n = 5) { const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), f = step0 / mag, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag; const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v); return { ticks: out, step }; }
function lighten(hex, f = 0.45) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, m = c => Math.round(c + (255 - c) * f); return `rgb(${m(r)},${m(g)},${m(b)})`; }

/* prua (bussola, se affidabile) o rotta, media circolare su ±half ms */
function perfCourseCh(S) { const c = S.channels.find(x => x.role === 'hdg' && !x.derived); return S.twaFrom === 'bussola' && c ? c : S.cog; }
function courseAt(S, t, half = 1000, ch = perfCourseCh(S)) {
  if (!ch) return NaN;
  const i0 = idxAt(ch.t, t - half), i1 = idxAt(ch.t, t + half);
  let x = 0, y = 0, n = 0;
  for (let i = i0; i < i1; i++) { const r = ch.v[i] * Math.PI / 180; if (isFinite(r)) { x += Math.cos(r); y += Math.sin(r); n++; } }
  return n ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : interp(ch, t);
}

/* ---------- tratti di navigazione dritta ---------- */
function straightSegments(S, a, b) {
  const ch = pickChannels(S), cch = perfCourseCh(S);
  let st = S.wind ? sailStates(S, a, b, 1000) : null;
  if (!st) { // senza vento: niente andature né mure, solo la navigazione regolare
    const man = maneuverWindows(S); st = [];
    for (let t = a; t < b; t += 1000) { const v = ch.sog ? interp(ch.sog, t) : NaN; st.push(isFinite(v) && v >= SAIL_MIN_KN && !man.some(([x, y]) => t >= x && t <= y) ? { mode: 'tutto', tack: null, v, t } : null); }
  }
  const out = []; let cur = null;
  const close = () => { if (cur && cur.pts.length >= 20) out.push(cur); cur = null; };
  for (const s of st) {
    if (!s || s.mode === 'lento' || s.mode === 'manovra' || s.mode === 'traverso') { close(); continue; }
    const c = courseAt(S, s.t, 1000, cch);
    if (cur && (cur.mode !== s.mode || cur.tack !== s.tack || !(Math.abs(angDiff(c, cur.c0)) <= 20))) close();
    if (!cur) cur = { mode: s.mode, tack: s.tack, c0: c, pts: [] };
    cur.pts.push(Object.assign({}, s, { c }));
  }
  close();
  const yaw = ch.yaw;
  return out.map(sg => {
    const P = sg.pts, a0 = P[0].t, a1 = P[P.length - 1].t + 1000;
    for (const p of P) {
      const hv = ch.heel ? interp(ch.heel, p.t) : NaN;
      p.heel = isFinite(hv) ? (p.tack ? (p.tack === 'dritta' ? -hv : hv) : Math.abs(hv)) : NaN;
      p.pitch = ch.pitch ? interp(ch.pitch, p.t) : NaN;
      p.vmgUp = sg.mode === 'poppa' ? -p.vmg : p.vmg;   // VMG "buono" positivo sia di bolina sia di poppa
    }
    // stabilità: variazione della velocità di rotazione, dell'heel e dell'accelerazione
    const rate = [], acc = [], heelV = [];
    for (let t = a0 + 500; t < a1 - 500; t += 500) {
      const r = yaw ? interp(yaw, t) : angDiff(courseAt(S, t + 500, 500, cch), courseAt(S, t - 500, 500, cch));
      if (isFinite(r)) rate.push(r);
      const v1 = interp(S.sog, t + 1000), v0 = interp(S.sog, t - 1000); if (isFinite(v1) && isFinite(v0)) acc.push((v1 - v0) / 2);
    }
    for (const p of P) if (isFinite(p.heel)) heelV.push(p.heel);
    const f = k => meanOf(P.map(p => p[k]).filter(isFinite));
    return Object.assign(sg, { a: a0, b: a1, dur: a1 - a0, v: f('v'), vmg: f('vmgUp'), A: f('A'), heel: f('heel'), pitch: f('pitch'),
      steerStab: sdOf(rate), heelStab: sdOf(heelV), speedStab: sdOf(acc) });
  });
}
/* tieni la parte migliore (per VMG, o velocità senza vento) di ogni gruppo, andatura e mura */
function topSegments(segs, frac) {
  if (frac >= 1) return segs;
  const keep = [], by = new Map();
  for (const s of segs) { const k = s.mode + '|' + s.tack; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
  for (const list of by.values()) {
    const key = list.every(s => isFinite(s.vmg)) ? 'vmg' : 'v';
    const tot = list.reduce((x, s) => x + s.dur, 0); let acc = 0;
    for (const s of [...list].sort((x, y) => y[key] - x[key])) { if (acc >= tot * frac) break; keep.push(s); acc += s.dur; }
  }
  return keep;
}

/* ---------- grafici ---------- */
/* box plot o violin: categorie [{label, sub, color, values}] sulla stessa scala */
function distChart(cats, { kind = 'box', unit = '', dec = 1, title = '' } = {}) {
  // una mura con pochi valori (es. 2 tratti dritti) si mostra lo stesso, a punti: non deve sparire
  cats = cats.filter(c => c.values.length >= 1);
  if (!cats.length || cats.reduce((a, c) => a + c.values.length, 0) < 3) return null;
  const all = cats.flatMap(c => c.values);
  let lo = Math.min(...cats.map(c => pctl(c.values, 0))), hi = Math.max(...cats.map(c => pctl(c.values, 1)));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const head = title + (unit ? ` (${unit})` : '');
  const cw = 82, L = 46, R = 10, T = 22, B = 40, H = 210, W = Math.max(L + R + cats.length * cw, Math.ceil(head.length * 7.2) + 12); // il titolo deve starci tutto
  const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = sv('svg', { width: W, height: H, class: 'pf-svg' });
  svg.append(svText(4, 13, head, { 'font-weight': 700, 'font-size': 12 }));
  const { ticks, step } = niceTicks(lo, hi, 5);
  const td = Math.max(0, Math.min(3, -Math.floor(Math.log10(step) + 1e-9))); // decimali quanti ne servono al passo (0,02 → 2)
  for (const tv of ticks) { const y = Y(tv); svg.append(sv('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'pf-grid' }), svText(L - 6, y + 4, fmtNum(tv, td), { 'text-anchor': 'end', class: 'pf-ax' })); }
  cats.forEach((c, i) => {
    const x = L + i * cw + cw / 2, v = c.values, q1 = pctl(v, 0.25), q2 = pctl(v, 0.5), q3 = pctl(v, 0.75), iq = q3 - q1;
    const wl = Math.min(...v.filter(x => x >= q1 - 1.5 * iq)), wh = Math.max(...v.filter(x => x <= q3 + 1.5 * iq));
    const g = sv('g'); g.append(sv('title', {}, `${c.label}${c.sub ? ' · ' + c.sub : ''}\nmediana ${fmtNum(q2, dec)} · metà centrale ${fmtNum(q1, dec)}–${fmtNum(q3, dec)} · ${v.length} valori`));
    if (v.length < 5) {
      // troppo pochi per una scatola: i singoli valori e la mediana
      v.forEach((z, k) => g.append(sv('circle', { cx: x + (k - (v.length - 1) / 2) * 7, cy: Y(z), r: 3.2, fill: c.light || c.color, 'fill-opacity': 0.8, stroke: c.color, 'stroke-width': 1.2 })));
      g.append(sv('line', { x1: x - 17, x2: x + 17, y1: Y(q2), y2: Y(q2), stroke: c.color, 'stroke-width': 2.5 }));
    } else if (kind === 'violin') {
      const sd = sdOf(v) || (hi - lo) / 20, bw = Math.max(1e-6, 1.06 * sd * Math.pow(v.length, -0.2)), N = 48, dens = [];
      const a = Math.min(...v), bb = Math.max(...v);
      for (let k = 0; k <= N; k++) { const y = a + (bb - a) * k / N; let s = 0; for (const z of v) s += Math.exp(-0.5 * ((y - z) / bw) ** 2); dens.push([y, s]); }
      const mx = Math.max(...dens.map(d => d[1])) || 1, half = cw * 0.42;
      const pts = dens.map(([y, d]) => `${(x + d / mx * half).toFixed(1)},${Y(y).toFixed(1)}`).concat([...dens].reverse().map(([y, d]) => `${(x - d / mx * half).toFixed(1)},${Y(y).toFixed(1)}`));
      g.append(sv('polygon', { points: pts.join(' '), fill: c.light || c.color, 'fill-opacity': 0.55, stroke: c.color, 'stroke-width': 1.2 }));
      g.append(sv('line', { x1: x - 8, x2: x + 8, y1: Y(q2), y2: Y(q2), stroke: c.color, 'stroke-width': 2.5 }));
    } else {
      g.append(sv('line', { x1: x, x2: x, y1: Y(wl), y2: Y(q1), stroke: c.color, 'stroke-width': 1.3 }), sv('line', { x1: x, x2: x, y1: Y(q3), y2: Y(wh), stroke: c.color, 'stroke-width': 1.3 }));
      for (const w of [wl, wh]) g.append(sv('line', { x1: x - 8, x2: x + 8, y1: Y(w), y2: Y(w), stroke: c.color, 'stroke-width': 1.3 }));
      g.append(sv('rect', { x: x - 17, y: Y(q3), width: 34, height: Math.max(1, Y(q1) - Y(q3)), rx: 3, fill: c.light || c.color, 'fill-opacity': 0.55, stroke: c.color, 'stroke-width': 1.3 }));
      g.append(sv('line', { x1: x - 17, x2: x + 17, y1: Y(q2), y2: Y(q2), stroke: c.color, 'stroke-width': 2.5 }));
      v.filter(z => z < wl || z > wh).forEach((o, k) => g.append(sv('circle', { cx: x + ((k % 5) - 2) * 2.5, cy: Y(o), r: 2, fill: c.color, 'fill-opacity': 0.6 })));
    }
    g.append(svText(x, H - B + 16, c.label, { 'text-anchor': 'middle', class: 'pf-cat' }), svText(x, H - B + 29, c.sub || '', { 'text-anchor': 'middle', class: 'pf-ax' }));
    svg.append(g);
  });
  return h('div', { class: 'pf-chart' }, svg);
}
/* dispersione: serie [{label, color, hollow, pts:[[x,y]]}] */
function scatterChart(series, { xl, yl, xd = 1, yd = 1 }) {
  const all = series.flatMap(s => s.pts); if (all.length < 3) return null;
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  let x0 = pctl(xs, 0.005), x1 = pctl(xs, 0.995), y0 = pctl(ys, 0.005), y1 = pctl(ys, 0.995);
  if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; } if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const px = (x1 - x0) * 0.05, py = (y1 - y0) * 0.05; x0 -= px; x1 += px; y0 -= py; y1 += py;
  const W = 640, H = 330, L = 50, R = 12, T = 12, B = 38, X = v => L + (v - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const svg = sv('svg', { width: W, height: H, class: 'pf-svg' });
  for (const tv of niceTicks(y0, y1, 5).ticks) svg.append(sv('line', { x1: L, x2: W - R, y1: Y(tv), y2: Y(tv), class: 'pf-grid' }), svText(L - 6, Y(tv) + 4, fmtNum(tv, yd), { 'text-anchor': 'end', class: 'pf-ax' }));
  for (const tv of niceTicks(x0, x1, 6).ticks) svg.append(sv('line', { x1: X(tv), x2: X(tv), y1: T, y2: H - B, class: 'pf-grid' }), svText(X(tv), H - B + 14, fmtNum(tv, xd), { 'text-anchor': 'middle', class: 'pf-ax' }));
  svg.append(svText((L + W - R) / 2, H - 6, xl, { 'text-anchor': 'middle', 'font-weight': 600 }), svText(12, (T + H - B) / 2, yl, { 'text-anchor': 'middle', 'font-weight': 600, transform: `rotate(-90 12 ${(T + H - B) / 2})` }));
  for (const s of series) for (const [x, y] of s.pts) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) svg.append(sv('circle', { cx: X(x).toFixed(1), cy: Y(y).toFixed(1), r: 2.4, fill: s.hollow ? 'none' : s.color, stroke: s.color, 'stroke-width': 1, 'fill-opacity': 0.55 }));
  return h('div', { class: 'pf-chart' }, svg);
}

/* ---------- manovre ---------- */
function maneuverDetail(S, t, type) {
  const ch = pickChannels(S), cch = perfCourseCh(S), vmgCh = S.ch('calc:vmg'), twa = S.ch('calc:twa');
  const meanCourse = (x0, x1) => { const v = []; for (let x = x0; x <= x1; x += 500) { const c = courseAt(S, x, 300, cch); if (isFinite(c)) v.push(c); } return circMean(v); };
  const Ce = meanCourse(t - 14000, t - 8000), Cx = meanCourse(t + 8000, t + 14000), turn = angDiff(Cx, Ce);
  if (!isFinite(turn)) return null;
  const sg = Math.sign(turn) || 1;
  // allineamento: il momento in cui la barca ha girato di metà dell'angolo
  let t0 = t;
  for (let x = t - 9000; x <= t + 9000; x += 100) { if (angDiff(courseAt(S, x, 300, cch), Ce) * sg >= Math.abs(turn) / 2) { t0 = x; break; } }
  const twaIn = twa ? nearestVal(twa, t0 - 10000, 3000) : NaN;
  const down = type === 'strambata' || (type !== 'virata' && isFinite(twaIn) && Math.abs(twaIn) > 90);
  const kind = type === 'manovra' && isFinite(twaIn) ? (down ? 'strambata' : 'virata') : type;
  const vs = down ? -1 : 1, from = isFinite(twaIn) ? (twaIn > 0 ? 'dritta' : 'sinistra') : null;
  const sog = x => interp(S.sog, x), vmg = x => vmgCh ? vs * interp(vmgCh, x) : NaN;
  const win = (x0, x1, f, step = 250) => { const o = []; for (let x = t0 + x0; x <= t0 + x1; x += step) { const v = f(x); if (isFinite(v)) o.push([x, v]); } return o; };
  const ap = win(-15000, -6000, sog), ce = win(-6000, 8000, sog), ex = win(8000, 18000, sog);
  if (ap.length < 5 || ce.length < 5) return null;
  const minP = ce.reduce((m, p) => p[1] < m[1] ? p : m, ce[0]);
  const vi = win(-15000, 18000, vmg), vc = win(-6000, 8000, vmg);
  const dvmg = vi.reduce((s, p) => s + p[1] / KN * 0.25, 0);                 // metri lungo l'asse del vento (passo 0,25 s)
  let maxRate = NaN;
  if (ch.yaw) { for (const [, v] of win(-6000, 8000, x => interp(ch.yaw, x), 100)) maxRate = Math.max(isFinite(maxRate) ? maxRate : 0, Math.abs(v)); }
  else { for (const [x] of win(-6000, 8000, x => x, 250)) { const r = Math.abs(angDiff(courseAt(S, x + 250, 250, cch), courseAt(S, x - 250, 250, cch))) / 0.5; if (isFinite(r)) maxRate = Math.max(isFinite(maxRate) ? maxRate : 0, r); } }
  let maxHeel = NaN; if (ch.heel) for (const [, v] of win(-6000, 8000, x => interp(ch.heel, x), 100)) maxHeel = Math.max(isFinite(maxHeel) ? maxHeel : 0, Math.abs(v));
  const accAt = x => { const a = interp(S.sog, x + 500), b = interp(S.sog, x - 500); return isFinite(a) && isFinite(b) ? (a - b) : NaN; };
  let dec = NaN, acc = NaN;
  for (let x = t0 - 8000; x <= minP[0]; x += 250) { const v = accAt(x); if (isFinite(v)) dec = Math.min(isFinite(dec) ? dec : 0, v); }
  for (let x = minP[0]; x <= t0 + 14000; x += 250) { const v = accAt(x); if (isFinite(v)) acc = Math.max(isFinite(acc) ? acc : 0, v); }
  const mm = maneuverMetrics(S.sog, t0);
  // curve da -15 a +20 s (rotta e heel girati in modo che tutte le manovre vadano nello stesso verso)
  const curves = { sog: [], vmg: [], course: [], heel: [], pitch: [] };
  for (let k = -15000; k <= 20000; k += 250) {
    const x = t0 + k;
    curves.sog.push(sog(x)); curves.vmg.push(vmg(x));
    curves.course.push(angDiff(courseAt(S, x, 300, cch), Ce) * sg);
    const hv = ch.heel ? interp(ch.heel, x) : NaN; curves.heel.push(from ? (from === 'dritta' ? -hv : hv) : hv * sg);
    curves.pitch.push(ch.pitch ? interp(ch.pitch, x) : NaN);
  }
  // traccia nel riferimento del vento (in alto = verso il vento), tutte girate dallo stesso lato
  let track = null;
  if (S.pos && S.wind) {
    const { lat, lon } = S.pos, la0 = interp(lat, t0), lo0 = interp(lon, t0), w = S.twdAt(t0) * Math.PI / 180;
    if (isFinite(la0) && isFinite(lo0)) {
      track = [];
      const kx = Math.cos(la0 * Math.PI / 180) * 111320, ky = 110540, mir = from === 'sinistra' ? -1 : 1;
      for (let k = -15000; k <= 18000; k += 500) {
        const a = interp(lat, t0 + k), b = interp(lon, t0 + k); if (!isFinite(a) || !isFinite(b)) continue;
        const e = (b - lo0) * kx, n = (a - la0) * ky;
        // asse y verso il vento: ruoto di -twd
        const up = e * Math.sin(w) + n * Math.cos(w), cross = e * Math.cos(w) - n * Math.sin(w);
        track.push([cross * mir, up]);
      }
    }
  }
  return { t: t0, type: kind, from, turn: Math.abs(turn), entry: meanOf(ap.map(p => p[1])), min: minP[1], exit: ex.length ? meanOf(ex.map(p => p[1])) : NaN,
    avgVmg: vi.length ? meanOf(vi.map(p => p[1])) : NaN, minVmg: vc.length ? Math.min(...vc.map(p => p[1])) : NaN, vmgDist: vi.length > 20 ? dvmg : NaN,
    maxRate, maxHeel, dec, acc, below90: mm ? mm.rec : NaN, lost: mm ? mm.lost : NaN, curves, track };
}
const MAN_METRICS = [
  ['entry', 'Velocità in entrata', 'kn', 1, 'alto'], ['min', 'Velocità minima', 'kn', 1, 'alto'], ['exit', 'Velocità in uscita', 'kn', 1, 'alto'],
  ['avgVmg', 'VMG medio', 'kn', 1, 'alto'], ['minVmg', 'VMG minimo', 'kn', 1, 'alto'], ['vmgDist', 'Metri lungo il vento', 'm', 0, 'alto'],
  ['maxRate', 'Rotazione massima', '°/s', 0, null], ['turn', 'Angolo di manovra', '°', 0, null], ['maxHeel', 'Heel massimo', '°', 1, null],
  ['dec', 'Decelerazione massima', 'kn/s', 2, null], ['acc', 'Accelerazione massima', 'kn/s', 2, 'alto'], ['below90', 'Sotto il 90%', 's', 0, 'basso'], ['lost', 'Metri persi', 'm', 0, 'basso']
];
/* curve sovrapposte: tutte sottili, la mediana spessa, la fascia della metà centrale */
function maneuverTimeChart(groups, key, { unit, dec, label }) {
  const N = 141, ts = Array.from({ length: N }, (_, k) => -15 + k * 0.25);
  const stats = groups.map(g => { const M = g.items.map(m => m.curves[key]); const q = [0.25, 0.5, 0.75].map(p => ts.map((_, k) => { const v = M.map(c => c[k]).filter(isFinite); return v.length >= 2 ? pctl(v, p) : NaN; })); return { g, M, q }; });
  const vals = stats.flatMap(s => s.M.flat()).filter(isFinite); if (vals.length < 10) return null;
  let lo = pctl(vals, 0.01), hi = pctl(vals, 0.99); if (hi - lo < 1e-9) { lo -= 1; hi += 1; } const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const W = 680, H = 250, L = 46, R = 12, T = 22, B = 30, X = s => L + (s + 15) / 35 * (W - L - R), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = sv('svg', { width: W, height: H, class: 'pf-svg' });
  svg.append(svText(4, 13, `${label}${unit ? ` (${unit})` : ''}`, { 'font-weight': 700, 'font-size': 12 }));
  for (const tv of niceTicks(lo, hi, 5).ticks) svg.append(sv('line', { x1: L, x2: W - R, y1: Y(tv), y2: Y(tv), class: 'pf-grid' }), svText(L - 6, Y(tv) + 4, fmtNum(tv, dec), { 'text-anchor': 'end', class: 'pf-ax' }));
  for (let s = -15; s <= 20; s += 5) svg.append(sv('line', { x1: X(s), x2: X(s), y1: T, y2: H - B, class: s === 0 ? 'pf-zero' : 'pf-grid' }), svText(X(s), H - B + 14, (s > 0 ? '+' : '') + s + ' s', { 'text-anchor': 'middle', class: 'pf-ax' }));
  const path = arr => { let d = '', pen = false; arr.forEach((v, k) => { if (!isFinite(v)) { pen = false; return; } d += (pen ? 'L' : 'M') + X(ts[k]).toFixed(1) + ' ' + Y(clamp(v, lo, hi)).toFixed(1); pen = true; }); return d; };
  for (const { g, M } of stats) for (const c of M) svg.append(sv('path', { d: path(c), fill: 'none', stroke: g.color, 'stroke-width': 1, 'stroke-opacity': 0.22 }));
  for (const { g, q } of stats) {
    let d = ''; const up = q[2], lw = q[0], ok = ts.map((_, k) => isFinite(up[k]) && isFinite(lw[k]));
    let started = false; ts.forEach((s, k) => { if (!ok[k]) return; d += (started ? 'L' : 'M') + X(s).toFixed(1) + ' ' + Y(clamp(up[k], lo, hi)).toFixed(1); started = true; });
    for (let k = ts.length - 1; k >= 0; k--) if (ok[k]) d += 'L' + X(ts[k]).toFixed(1) + ' ' + Y(clamp(lw[k], lo, hi)).toFixed(1);
    if (d) svg.append(sv('path', { d: d + 'Z', fill: g.color, 'fill-opacity': 0.14, stroke: 'none' }));
    svg.append(sv('path', { d: path(q[1]), fill: 'none', stroke: g.color, 'stroke-width': 2.6 }));
  }
  // lettura col mouse
  const cur = sv('line', { y1: T, y2: H - B, class: 'pf-cur', visibility: 'hidden' }); svg.append(cur);
  const tip = h('div', { class: 'sa-tip pf-tip', hidden: true }), box = h('div', { class: 'pf-chart', style: { position: 'relative' } }, svg, tip);
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width, s = clamp((x - L) / (W - L - R) * 35 - 15, -15, 20), k = Math.round((s + 15) / 0.25);
    cur.setAttribute('x1', X(ts[k])); cur.setAttribute('x2', X(ts[k])); cur.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.textContent = ''; tip.append(h('div', { class: 'muted' }, `${ts[k] > 0 ? '+' : ''}${fmtNum(ts[k], 1)} s`), ...stats.map(({ g, q }) => h('div', null, h('span', { class: 'dot', style: { background: g.color, width: '7px', height: '7px', marginRight: '5px' } }), `${g.name}: ${fmtNum(q[1][k], dec)} ${unit}`)));
    tip.style.left = clamp(x / W * r.width, 80, r.width - 80) + 'px';
  });
  svg.addEventListener('pointerleave', () => { cur.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  return box;
}
/* tracce delle manovre nel riferimento del vento (vento dall'alto), tutte dallo stesso lato */
function maneuverTrackChart(groups) {
  const all = groups.flatMap(g => g.items.map(m => m.track).filter(Boolean)); if (!all.length) return null;
  let ext = 10; for (const tr of all) for (const [x, y] of tr) ext = Math.max(ext, Math.abs(x), Math.abs(y));
  ext = Math.min(ext, 160) * 1.05;
  const S = 360, C = S / 2, k = (S / 2 - 16) / ext;
  const svg = sv('svg', { width: S, height: S, class: 'pf-svg' });
  svg.append(sv('line', { x1: C, x2: C, y1: 8, y2: S - 8, class: 'pf-grid' }), sv('line', { x1: 8, x2: S - 8, y1: C, y2: C, class: 'pf-grid' }));
  svg.append(svText(C, 14, '↓ vento', { 'text-anchor': 'middle', class: 'pf-ax' }), svText(S - 8, S - 8, `${Math.round(ext)} m`, { 'text-anchor': 'end', class: 'pf-ax' }));
  for (const g of groups) for (const m of g.items) if (m.track && m.track.length > 3) svg.append(sv('polyline', { points: m.track.map(([x, y]) => `${(C + x * k).toFixed(1)},${(C - y * k).toFixed(1)}`).join(' '), fill: 'none', stroke: g.color, 'stroke-width': 1.6, 'stroke-opacity': 0.7 }));
  svg.append(sv('circle', { cx: C, cy: C, r: 3, fill: 'currentColor' }));
  return h('div', { class: 'pf-chart' }, svg, h('div', { class: 'faint small' }, 'Il punto è metà della rotazione; tutte le manovre girate dallo stesso lato. Più la traccia sale (verso il vento) di bolina, meglio è.'));
}

/* ---------- la finestra ---------- */
function showPerformance(V, { tab = 'velocita', segs = null } = {}) {
  const S = V.S, all = S.meta.events.filter(e => e.type === 'tratto' && e.t2 != null && e.t2 - e.t >= 20000);
  // un intervallo non salvato (selezione I–O) entra come tratto temporaneo
  for (const e of segs || []) if (!e.id || !all.some(x => x.id === e.id)) all.push(Object.assign({ id: uid('tmp'), note: e.note || 'Selezione' }, e));
  let chosen = (segs && segs.length ? all.filter(x => (segs || []).some(e => (e.id && e.id === x.id) || (e.t === x.t && e.t2 === x.t2))) : []).map(e => e.id);
  const st = { tab, mode: 'bolina', top: 1, kind: 'box', xs: 'heel', ys: 'v', mtype: 'virata', mtop: 1, mview: 'sog' };
  const body = h('div', { class: 'pf' });
  const groupsNow = () => {
    const list = chosen.length ? all.filter(e => chosen.includes(e.id)) : [];
    if (!list.length) return [{ name: 'Tutta l\'uscita', a: S.t0, b: S.t1, color: seriesColor(0) }];
    return list.map((e, i) => ({ name: e.note || `Tratto ${all.indexOf(e) + 1}`, a: e.t, b: e.t2, color: seriesColor(i) }));
  };
  const seg = (opts, cur, set) => h('div', { class: 'pf-seg' }, opts.map(([v, l]) => h('button', { class: 'btn sm' + (cur === v ? ' primary' : ''), onclick: () => { set(v); draw(); } }, l)));
  const cache = new Map();
  const segsOf = g => { const k = 's' + g.a + '|' + g.b; if (!cache.has(k)) cache.set(k, straightSegments(S, g.a, g.b)); return cache.get(k); };
  const mansOf = g => { const k = 'm' + g.a + '|' + g.b; if (!cache.has(k)) cache.set(k, segmentManeuvers(S, g.a, g.b).map(m => maneuverDetail(S, m.t, m.type)).filter(Boolean)); return cache.get(k); };
  const draw = () => {
    body.textContent = '';
    const G = groupsNow();
    // gruppi: tutta l'uscita o i tratti
    const chips = h('div', { class: 'pf-chips' }, h('span', { class: 'muted' }, 'Analizza:'),
      h('button', { class: 'btn sm' + (!chosen.length ? ' primary' : ''), onclick: () => { chosen = []; draw(); } }, 'tutta l\'uscita'),
      all.map((e, i) => h('button', { class: 'btn sm' + (chosen.includes(e.id) ? ' primary' : ''), title: `${fmtClock(e.t)} · ${fmtDur(e.t2 - e.t)}`, onclick: () => { chosen = chosen.includes(e.id) ? chosen.filter(x => x !== e.id) : [...chosen, e.id].slice(-6); draw(); } }, e.note || `Tratto ${i + 1}`)));
    body.append(chips, h('div', { class: 'pf-legend' }, G.map(g => h('span', null, h('i', { style: { background: g.color } }), g.name))),
      h('div', { class: 'pf-tabs' }, seg([['velocita', 'Velocità'], ['manovre', 'Manovre']], st.tab, v => { st.tab = v; })));
    if (st.tab === 'velocita') drawSpeed(G); else drawMans(G);
  };
  const drawSpeed = G => {
    const modes = S.wind ? [['bolina', 'Bolina'], ['poppa', 'Poppa']] : [['tutto', 'Tutto il navigato']];
    if (!S.wind) st.mode = 'tutto';
    body.append(h('div', { class: 'pf-ctrl' }, seg(modes, st.mode, v => { st.mode = v; }), seg(PERF_TOP.map(([f, l]) => [f, l]), st.top, v => { st.top = v; }),
      seg([['box', 'Box'], ['violin', 'Violin'], ['scatter', 'Dispersione']], st.kind, v => { st.kind = v; })));
    const per = G.map(g => ({ g, segs: topSegments(segsOf(g).filter(s => s.mode === st.mode), st.top) }));
    const tacks = S.wind ? ['dritta', 'sinistra'] : [null];
    const tot = per.reduce((x, p) => x + p.segs.reduce((y, s) => y + s.dur, 0), 0);
    if (!tot) { body.append(h('p', { class: 'muted' }, `Nessun tratto di navigazione dritta${st.mode !== 'tutto' ? ' di ' + st.mode : ''} (almeno 20 s con la stessa mura, sopra ${SAIL_MIN_KN} kn).`)); return; }
    body.append(h('div', { class: 'faint small' }, `Tratti dritti: almeno 20 s con la stessa andatura e la stessa mura, rotta entro ±20°, sopra ${SAIL_MIN_KN} kn, manovre escluse.${st.top < 1 ? ` ${PERF_TOP.find(x => x[0] === st.top)[1]}: per ogni mura tengo i tratti con il VMG più alto, fino a quella parte del tempo.` : ''}`));
    // numeri per gruppo e mura
    const rows = [];
    for (const { g, segs } of per) for (const tk of tacks) {
      const L = segs.filter(s => s.tack === tk); if (!L.length) continue;
      const P = L.flatMap(s => s.pts), w = (k) => { let s = 0, n = 0; for (const x of L) if (isFinite(x[k])) { s += x[k] * x.dur; n += x.dur; } return n ? s / n : NaN; };
      rows.push({ g, tk, n: L.length, dur: L.reduce((x, s) => x + s.dur, 0), P, v: meanOf(P.map(p => p.v)), vmg: meanOf(P.map(p => p.vmgUp).filter(isFinite)), A: meanOf(P.map(p => p.A).filter(isFinite)),
        heel: meanOf(P.map(p => p.heel).filter(isFinite)), pitch: meanOf(P.map(p => p.pitch).filter(isFinite)), steer: w('steerStab'), hs: w('heelStab'), ss: w('speedStab') });
    }
    const f = (v, d) => isFinite(v) ? fmtNum(v, d) : '—';
    const best = (k, hiGood) => { const v = rows.map(r => r[k]).filter(isFinite); return v.length >= 2 ? (hiGood ? Math.max(...v) : Math.min(...v)) : NaN; };
    const bv = { v: best('v', true), vmg: best('vmg', true), steer: best('steer', false), hs: best('hs', false), ss: best('ss', false) };
    const cell = (r, k, d, u = '') => h('td', { class: 'num' + (isFinite(bv[k]) && r[k] === bv[k] ? ' cmp-best' : '') }, f(r[k], d) + u);
    body.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'ev-table cmp-table' },
      h('thead', null, h('tr', null, ['', 'tempo', 'velocità', 'VMG', 'TWA', 'heel', 'trim', 'stab. timone', 'stab. heel', 'stab. velocità'].map((x, i) => h('th', { style: i ? { textAlign: 'right' } : null, title: i >= 7 ? 'variazione: più basso = più regolare' : null }, x)))),
      h('tbody', null, rows.map(r => h('tr', null, h('td', null, h('i', { class: 'cmp-sw', style: { background: r.g.color } }), r.g.name, r.tk ? h('span', { class: 'muted' }, ` · mure a ${r.tk}`) : null),
        h('td', { class: 'num' }, fmtDur(r.dur)), cell(r, 'v', 1, ' kn'), cell(r, 'vmg', 1, ' kn'), h('td', { class: 'num' }, f(r.A, 0) + '°'), h('td', { class: 'num' }, f(r.heel, 1) + '°'), h('td', { class: 'num' }, f(r.pitch, 1) + '°'),
        cell(r, 'steer', 1, ' °/s'), cell(r, 'hs', 1, '°'), cell(r, 'ss', 2, ' kn/s')))))),
      h('div', { class: 'faint small' }, 'Heel sottovento positivo. Stabilità = quanto variano velocità di rotazione, heel e accelerazione nei tratti dritti: più basso è più regolare (in verde il migliore).'));
    if (st.kind === 'scatter') {
      const AX = [['v', 'Velocità (kn)', 1], ['vmgUp', 'VMG (kn)', 1], ['A', 'Angolo al vento (°)', 0], ['heel', 'Heel sottovento (°)', 1], ['pitch', 'Trim (°)', 1]];
      const sel = (cur, set) => h('select', { onchange: e => { set(e.target.value); draw(); } }, AX.map(([k, l]) => h('option', { value: k, selected: k === cur }, l)));
      body.append(h('div', { class: 'pf-ctrl' }, h('label', { class: 'row', style: { gap: '6px' } }, 'Asse X', sel(st.xs, v => { st.xs = v; })), h('label', { class: 'row', style: { gap: '6px' } }, 'Asse Y', sel(st.ys, v => { st.ys = v; }))));
      const ax = k => AX.find(a => a[0] === k);
      const ser = rows.map(r => ({ color: r.g.color, hollow: r.tk === 'sinistra', pts: r.P.map(p => [p[st.xs], p[st.ys]]).filter(([x, y]) => isFinite(x) && isFinite(y)) }));
      const c = scatterChart(ser, { xl: ax(st.xs)[1], yl: ax(st.ys)[1], xd: ax(st.xs)[2], yd: ax(st.ys)[2] });
      body.append(c || h('p', { class: 'muted' }, 'Pochi punti per la dispersione.'), h('div', { class: 'faint small' }, 'Un punto ogni secondo dei tratti dritti. Pieno = mure a dritta, vuoto = mure a sinistra. Una relazione non dice la causa: con più vento crescono insieme heel e velocità.'));
    } else {
      const charts = [['v', 'Velocità', 'kn', 1], ['vmgUp', 'VMG', 'kn', 1], ['A', 'Angolo al vento', '°', 0], ['heel', 'Heel sottovento', '°', 1], ['pitch', 'Trim', '°', 1]]
        .map(([k, l, u, d]) => distChart(rows.map(r => ({ label: G.length > 1 ? r.g.name.slice(0, 13) : (r.tk ? r.tk : 'tutto'), sub: G.length > 1 ? (r.tk || '') : (r.tk ? 'mure' : ''), color: r.g.color, light: r.tk === 'sinistra' ? lighten(r.g.color, 0.55) : null, values: r.P.map(p => p[k]).filter(isFinite) })), { kind: st.kind, unit: u, dec: d, title: l }));
      const stab = [['steerStab', 'Stabilità del timone', '°/s', 1], ['heelStab', 'Stabilità dell\'heel', '°', 1], ['speedStab', 'Stabilità della velocità', 'kn/s', 2]]
        .map(([k, l, u, d]) => distChart(rows.map(r => ({ label: G.length > 1 ? r.g.name.slice(0, 13) : (r.tk ? r.tk : 'tutto'), sub: G.length > 1 ? (r.tk || '') : (r.tk ? 'mure' : ''), color: r.g.color, light: r.tk === 'sinistra' ? lighten(r.g.color, 0.55) : null, values: per.find(p => p.g === r.g).segs.filter(s => s.tack === r.tk).map(s => s[k]).filter(isFinite) })), { kind: st.kind, unit: u, dec: d, title: l + ' (per tratto dritto)' }));
      body.append(h('div', { class: 'pf-grid2' }, ...charts.filter(Boolean)), h('div', { class: 'sm-gh', style: { marginTop: '8px' } }, 'Stabilità (più basso = più regolare)'), h('div', { class: 'pf-grid2' }, ...stab.filter(Boolean)),
        h('div', { class: 'faint small' }, st.kind === 'box' ? 'Box: la riga è la mediana, la scatola la metà centrale dei valori, i baffi arrivano agli estremi entro 1,5 volte la scatola, i punti sono i valori fuori. Colore pieno = mure a dritta, chiaro = mure a sinistra.' : 'Violin: più largo dove i valori sono più frequenti; la riga è la mediana. Colore pieno = mure a dritta, chiaro = mure a sinistra.'));
    }
  };
  const drawMans = G => {
    const types = S.wind ? [['virata', 'Virate'], ['strambata', 'Strambate'], ['tutte', 'Tutte']] : [['tutte', 'Tutte']];
    if (!S.wind) st.mtype = 'tutte';
    body.append(h('div', { class: 'pf-ctrl' }, seg(types, st.mtype, v => { st.mtype = v; }), seg(PERF_TOP.map(([f, l]) => [f, l]), st.mtop, v => { st.mtop = v; })));
    const per = G.map(g => {
      let items = mansOf(g).filter(m => st.mtype === 'tutte' || m.type === st.mtype);
      if (st.mtop < 1 && items.length) { const key = items.every(m => isFinite(m.vmgDist)) ? 'vmgDist' : 'min'; items = [...items].sort((x, y) => y[key] - x[key]).slice(0, Math.max(1, Math.round(items.length * st.mtop))); }
      return Object.assign({}, g, { items: items.sort((x, y) => x.t - y.t) });
    });
    const n = per.reduce((x, g) => x + g.items.length, 0);
    if (!n) { body.append(h('p', { class: 'muted' }, 'Nessuna manovra di questo tipo (prova "Trova manovre" nel pannello Eventi).')); return; }
    body.append(h('div', { class: 'faint small' }, `${n} ${n === 1 ? 'manovra' : 'manovre'}, allineate a metà rotazione (0 s). Avvicinamento da −15 a −6 s, rotazione da −6 a +8 s, uscita da +8 a +18 s.${st.mtop < 1 ? ' Top: le migliori per metri guadagnati lungo il vento.' : ''}`));
    // medie per gruppo
    const f = (v, d) => isFinite(v) ? fmtNum(v, d) : '—';
    const avg = (g, k) => meanOf(g.items.map(m => m[k]).filter(isFinite));
    body.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'ev-table cmp-table' },
      h('thead', null, h('tr', null, h('th', null, ''), MAN_METRICS.map(([, l, u]) => h('th', { style: { textAlign: 'right' } }, l, h('div', { class: 'faint' }, u))))),
      h('tbody', null, per.map(g => h('tr', null, h('td', null, h('i', { class: 'cmp-sw', style: { background: g.color } }), `${g.name} (${g.items.length})`), MAN_METRICS.map(([k, , , d]) => h('td', { class: 'num' }, f(avg(g, k), d)))))))),
      h('div', { class: 'faint small' }, 'Medie delle manovre. "Metri lungo il vento": quanto la barca avanza verso il vento (virate) o sotto vento (strambate) da −15 a +18 s, non il confronto con una manovra perfetta. Decelerazione: la frenata più forte prima del minimo; accelerazione: la ripresa più forte dopo.'));
    // curve sovrapposte
    const views = [['sog', 'Velocità', 'kn', 1], ['vmg', 'VMG', 'kn', 1], ['course', 'Rotazione dalla rotta d\'entrata', '°', 0], ['heel', 'Heel (positivo = sottovento in entrata)', '°', 1], ['pitch', 'Trim', '°', 1]];
    const v = views.find(x => x[0] === st.mview) || views[0];
    body.append(h('div', { class: 'sm-gh', style: { marginTop: '6px' } }, 'Nel tempo'), h('div', { class: 'pf-ctrl' }, seg(views.map(([k, l]) => [k, l.split(' (')[0]]), st.mview, x => { st.mview = x; })));
    body.append(h('div', { class: 'pf-cols' }, maneuverTimeChart(per, v[0], { label: v[1], unit: v[2], dec: v[3] }) || h('p', { class: 'muted' }, 'Dati insufficienti.'), maneuverTrackChart(per)),
      h('div', { class: 'faint small' }, 'Linee sottili: ogni manovra. Linea spessa: la mediana. Fascia: la metà centrale delle manovre. Passa sopra il grafico per leggere i valori.'));
    // box per misura
    const boxes = MAN_METRICS.filter(([k]) => ['entry', 'min', 'exit', 'vmgDist', 'maxRate', 'maxHeel', 'below90', 'lost'].includes(k))
      .map(([k, l, u, d]) => distChart(per.map(g => ({ label: G.length > 1 ? g.name.slice(0, 13) : (st.mtype === 'tutte' ? 'manovre' : st.mtype === 'virata' ? 'virate' : 'strambate'), color: g.color, values: g.items.map(m => m[k]).filter(isFinite) })), { kind: 'box', unit: u, dec: d, title: l }));
    body.append(h('div', { class: 'sm-gh', style: { marginTop: '8px' } }, 'Distribuzione'), h('div', { class: 'pf-grid4' }, ...boxes.filter(Boolean)));
    // elenco
    body.append(h('div', { class: 'sm-gh', style: { marginTop: '8px' } }, 'Una per una'), h('div', { class: 'tbl-wrap' }, h('table', { class: 'ev-table cmp-table' },
      h('thead', null, h('tr', null, h('th', null, ''), ['entrata', 'minima', 'uscita', 'm lungo il vento', 'rotaz. max', 'angolo', 'heel max', 'sotto il 90%'].map(x => h('th', { style: { textAlign: 'right' } }, x)))),
      h('tbody', null, per.flatMap(g => g.items.map(m => h('tr', null,
        h('td', null, h('i', { class: 'cmp-sw', style: { background: g.color } }), h('button', { class: 'sa-go', onclick: () => V.seek(m.t - 8000) }, fmtClock(m.t)), h('span', { class: 'muted' }, ` ${m.type}${m.from ? ' da mure a ' + m.from : ''}`)),
        h('td', { class: 'num' }, f(m.entry, 1)), h('td', { class: 'num' }, f(m.min, 1)), h('td', { class: 'num' }, f(m.exit, 1)), h('td', { class: 'num' }, f(m.vmgDist, 0)),
        h('td', { class: 'num' }, f(m.maxRate, 0) + '°/s'), h('td', { class: 'num' }, f(m.turn, 0) + '°'), h('td', { class: 'num' }, f(m.maxHeel, 1) + '°'), h('td', { class: 'num' }, isFinite(m.below90) ? f(m.below90, 0) + ' s' : '—'))))))));
  };
  draw();
  modal({ title: 'Prestazioni: velocità e manovre', body, wide: true, actions: [{ label: 'Chiudi', kind: 'primary' }] });
}
