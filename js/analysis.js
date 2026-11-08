/* Analisi di un intervallo di tempo: le stesse misure servono per
   - il riepilogo di un tratto selezionato (Maiusc + trascina su un grafico)
   - il pannello "Medie 10 s / 30 s" del live
   - i tratti segnati dall'allenatore (Inizia / Fine tratto) */
'use strict';

// i canali da usare per ogni misura (preferisco il telefono fissato alla barca)
function pickChannels(S) {
  const pref = list => list.sort((a, b) => (/^live:|iPhone/.test(b.srcKind || '') ? 1 : 0) - (/^live:|iPhone/.test(a.srcKind || '') ? 1 : 0))[0] || null;
  const by = (test) => pref(S.channels.filter(test));
  return {
    sog: S.sog,
    heel: by(c => c.role === 'heel'),
    pitch: by(c => c.role === 'pitch'),
    yaw: by(c => /(yaw_rate_dps|:yaw)$/.test(c.id)),
    cog: S.cog,
    peak: by(c => /(acc_peak_g|:acc)$/.test(c.id)),
    hr: by(c => c.role === 'hr'),
    loads: S.channels.filter(c => c.role === 'load')
  };
}
// quanta parte dell'intervallo è coperta da dati (per sapere se le medie sono affidabili)
function coverageOf(ch, a, b) {
  if (!ch) return 0;
  const i0 = idxAt(ch.t, a), i1 = idxAt(ch.t, b);
  const expected = Math.max(1, (b - a) / ch.step);
  return Math.min(1, (i1 - i0) / expected);
}
// oscillazioni al minuto: quante volte il valore attraversa la sua media (dopo una leggera media mobile)
function oscillations(ch, a, b) {
  if (!ch || b - a < 4000) return NaN;
  const step = 100, n = Math.floor((b - a) / step);
  const r = resample(ch, a, step, n);
  const sm = new Float64Array(n);
  for (let k = 0; k < n; k++) { let s = 0, c = 0; for (let j = k - 3; j <= k + 3; j++) if (j >= 0 && j < n && isFinite(r[j])) { s += r[j]; c++; } sm[k] = c ? s / c : NaN; }
  let mean = 0, m = 0; for (const v of sm) if (isFinite(v)) { mean += v; m++; }
  if (m < n * 0.5) return NaN;
  mean /= m;
  // isteresi: conto un attraversamento solo se supera la media di almeno 0,3 unità
  let side = 0, cross = 0;
  for (const v of sm) { if (!isFinite(v)) continue; const d = v - mean; const s = d > 0.3 ? 1 : d < -0.3 ? -1 : 0; if (s && s !== side) { if (side) cross++; side = s; } }
  return cross / 2 / ((b - a) / 60000);
}
function boatStats(S, a, b, chans = pickChannels(S)) {
  const st = (ch) => ch ? stats(ch, a, b) : null;
  const out = { a, b, dur: b - a };
  if (chans.sog) {
    const s = st(chans.sog);
    let dist = 0; for (let t = a; t < b; t += 1000) { const v = interp(chans.sog, t); if (isFinite(v)) dist += v / 3600; } // miglia
    out.sog = { mean: s.mean, max: s.max, min: s.min, sd: s.sd, dist, cov: coverageOf(chans.sog, a, b) };
  }
  for (const k of ['heel', 'pitch']) {
    const ch = chans[k]; if (!ch) continue;
    const s = st(ch);
    out[k] = { mean: s.mean, range: s.max - s.min, min: s.min, max: s.max, sd: s.sd, osc: oscillations(ch, a, b), cov: coverageOf(ch, a, b) };
  }
  if (chans.yaw) {
    const s = st(chans.yaw);
    let absMax = 0; const i0 = idxAt(chans.yaw.t, a), i1 = idxAt(chans.yaw.t, b);
    for (let i = i0; i < i1; i++) absMax = Math.max(absMax, Math.abs(chans.yaw.v[i]));
    out.steer = { activity: s.sd, violence: absMax, cov: coverageOf(chans.yaw, a, b) };
  }
  if (chans.cog) {
    // quanto oscilla la rotta: deviazione standard circolare
    let x = 0, y = 0, n = 0; const i0 = idxAt(chans.cog.t, a), i1 = idxAt(chans.cog.t, b);
    for (let i = i0; i < i1; i++) { const r = chans.cog.v[i] * Math.PI / 180; x += Math.cos(r); y += Math.sin(r); n++; }
    if (n > 2) { const R = Math.min(1, Math.hypot(x, y) / n); out.steer = Object.assign(out.steer || {}, { cogSd: Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))) * 180 / Math.PI }); }
  }
  if (chans.peak) out.impact = { max: st(chans.peak).max, cov: coverageOf(chans.peak, a, b) };
  if (chans.hr) { const s = st(chans.hr); out.hr = { mean: s.mean, max: s.max, cov: coverageOf(chans.hr, a, b) }; }
  out.loads = chans.loads.map(c => { const s = st(c); return { name: c.name, unit: c.unit, mean: s.mean, max: s.max }; });
  out.maneuvers = S.meta.events.filter(e => e.t >= a && e.t <= b && ['virata', 'strambata', 'manovra'].includes(e.type)).length;
  return out;
}

/* Righe da mostrare (nome, valore per ogni intervallo) */
const STAT_ROWS = [
  ['Velocità media', r => r.sog && fmtNum(r.sog.mean, 1), 'kn', r => r.sog && r.sog.cov],
  ['Velocità massima', r => r.sog && fmtNum(r.sog.max, 1), 'kn', r => r.sog && r.sog.cov],
  ['Stabilità velocità (dev. std)', r => r.sog && fmtNum(r.sog.sd, 2), 'kn', r => r.sog && r.sog.cov],
  ['Distanza', r => r.sog && fmtNum(r.sog.dist * 1852, 0), 'm', r => r.sog && r.sog.cov],
  ['Heel medio', r => r.heel && fmtNum(r.heel.mean, 1), '°', r => r.heel && r.heel.cov],
  ['Heel: ampiezza', r => r.heel && fmtNum(r.heel.range, 1), '°', r => r.heel && r.heel.cov],
  ['Heel: oscillazioni', r => r.heel && fmtNum(r.heel.osc, 0), '/min', r => r.heel && r.heel.cov],
  ['Trim medio', r => r.pitch && fmtNum(r.pitch.mean, 1), '°', r => r.pitch && r.pitch.cov],
  ['Trim: ampiezza', r => r.pitch && fmtNum(r.pitch.range, 1), '°', r => r.pitch && r.pitch.cov],
  ['Trim: oscillazioni', r => r.pitch && fmtNum(r.pitch.osc, 0), '/min', r => r.pitch && r.pitch.cov],
  ['Timone: attività', r => r.steer && r.steer.activity != null && fmtNum(r.steer.activity, 1), '°/s', r => r.steer && r.steer.cov],
  ['Timone: rotazione più brusca', r => r.steer && r.steer.violence != null && fmtNum(r.steer.violence, 0), '°/s', r => r.steer && r.steer.cov],
  ['Rotta: oscillazione', r => r.steer && r.steer.cogSd != null && fmtNum(r.steer.cogSd, 1), '°', r => r.sog && r.sog.cov],
  ['Impatti: picco', r => r.impact && fmtNum(r.impact.max, 2), 'g', r => r.impact && r.impact.cov],
  ['Frequenza cardiaca media', r => r.hr && fmtNum(r.hr.mean, 0), 'bpm', r => r.hr && r.hr.cov],
  ['Frequenza cardiaca max', r => r.hr && fmtNum(r.hr.max, 0), 'bpm', r => r.hr && r.hr.cov]
];
const STAT_HELP = 'Ampiezza = differenza tra massimo e minimo. Oscillazioni = quante volte al minuto il valore va avanti e indietro attorno alla sua media. Timone: non c\'è un sensore sul timone, si misura dalla barca: "attività" è quanto varia la velocità di rotazione, "rotazione più brusca" la correzione più violenta. Un valore grigio vuol dire che in quell\'intervallo è arrivato meno dell\'80% dei dati: non è affidabile.';

function statsTable(cols) {
  // cols: [{label, r}]
  const tb = h('table', { class: 'ev-table stat-table' }, h('thead', null, h('tr', null, h('th', null, ''), cols.map(c => h('th', { style: { textAlign: 'right' } }, c.label)))));
  const body = h('tbody');
  for (const [name, get, unit, cov] of STAT_ROWS) {
    const vals = cols.map(c => c.r ? get(c.r) : null);
    if (vals.every(v => v == null || v === false || v === '—')) continue;
    body.append(h('tr', null, h('td', null, name, h('span', { class: 'faint' }, ' ' + unit)),
      cols.map((c, i) => { const v = vals[i]; const ok = c.r && (cov(c.r) ?? 1) >= 0.8; return h('td', { style: { textAlign: 'right', fontWeight: 650, color: ok ? 'var(--fg)' : 'var(--faint)' }, title: ok ? '' : 'Dati incompleti in questo intervallo' }, v && v !== false ? v : '—'); })));
  }
  const extra = cols.filter(c => c.r && c.r.maneuvers != null);
  if (extra.length) body.append(h('tr', null, h('td', null, 'Manovre segnate'), cols.map(c => h('td', { style: { textAlign: 'right' } }, c.r ? String(c.r.maneuvers) : '—'))));
  tb.append(body);
  return tb;
}

/* =================== Riepilogo di un tratto, in parole semplici =================== */
const TURN_DPS = 3; // °/s: sopra questa velocità di rotazione conto una correzione di timone

/* valore smorzato: media degli ultimi `sec` secondi (media circolare per gli angoli); 0 = valore istantaneo */
function dampedValue(ch, t, sec, circular = ch && ch.circular) {
  if (!ch) return NaN;
  if (!(sec > 0)) return interp(ch, t);
  const i0 = idxAt(ch.t, t - sec * 1000), i1 = idxAt(ch.t, t + 1);
  if (i1 - i0 < 1) return interp(ch, t);
  if (circular) {
    let x = 0, y = 0; for (let i = i0; i < i1; i++) { const r = ch.v[i] * Math.PI / 180; if (isFinite(r)) { x += Math.cos(r); y += Math.sin(r); } }
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  let s = 0, n = 0; for (let i = i0; i < i1; i++) { const v = ch.v[i]; if (isFinite(v)) { s += v; n++; } }
  return n ? s / n : interp(ch, t);
}
const DAMP_CHOICES = [0, 1, 3, 5, 10];

/* secondi da non contare: virate, strambate e grandi cambi di rotta (±6 s attorno alla rotazione forte) */
function maneuverMask(ch, a, b) {
  const step = 100, n = Math.floor((b - a) / step), mask = new Uint8Array(n);
  const src = ch.yaw ? resample(ch.yaw, a, step, n) : null;
  let rate = null;
  if (src) rate = Array.from(src);
  else if (ch.cog) { const c = resample(ch.cog, a, step, n); rate = new Array(n).fill(NaN); for (let k = 10; k < n; k++) if (isFinite(c[k]) && isFinite(c[k - 10])) rate[k] = angDiff(c[k], c[k - 10]); }
  if (!rate) return mask;
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0; for (let j = k - 3; j <= k + 3; j++) if (j >= 0 && j < n && isFinite(rate[j])) { s += rate[j]; c++; }
    if (c && Math.abs(s / c) > 8) for (let j = Math.max(0, k - 60); j <= Math.min(n - 1, k + 60); j++) mask[j] = 1;
  }
  return mask;
}
/* oscillazione attorno all'andamento (media mobile di 20 s), senza i secondi delle manovre.
   Restituisce l'ampiezza tipica (±) e quante oscillazioni al minuto. */
function wobble(ch, a, b, circ = false, mask = null) {
  if (!ch || b - a < 6000) return null;
  const step = 100, n = Math.floor((b - a) / step), r = resample(ch, a, step, n), v = Array.from(r);
  if (circ) { let prev = NaN, off = 0; for (let i = 0; i < n; i++) { if (!isFinite(v[i])) continue; v[i] += off; if (isFinite(prev)) { const d = v[i] - prev; if (d > 180) { v[i] -= 360; off -= 360; } else if (d < -180) { v[i] += 360; off += 360; } } prev = v[i]; } }
  const use = i => isFinite(v[i]) && !(mask && mask[i]);
  const ps = new Float64Array(n + 1), pc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { const ok = use(i); ps[i + 1] = ps[i] + (ok ? v[i] : 0); pc[i + 1] = pc[i] + (ok ? 1 : 0); }
  const mean = (i, half) => { const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1), c = pc[hi] - pc[lo]; return c ? (ps[hi] - ps[lo]) / c : NaN; };
  const thr = circ ? 0.5 : 0.3;
  let ss = 0, ok = 0, side = 0, cross = 0, counted = 0;
  for (let i = 0; i < n; i++) {
    if (!use(i)) { side = 0; continue; }
    const d = mean(i, 3) - mean(i, 100); // valore appena lisciato meno l'andamento di 20 s
    if (!isFinite(d)) continue;
    ss += d * d; ok++; counted++;
    const sg = d > thr ? 1 : d < -thr ? -1 : 0;
    if (sg && sg !== side) { if (side) cross++; side = sg; }
  }
  if (counted < 60) return null; // meno di 6 s utili
  return { sd: Math.sqrt(ss / ok), perMin: cross / 2 / (counted * step / 60000) };
}
/* velocità e timone fuori dalle manovre */
function steadyStats(ch, a, b, mask) {
  const step = 100, n = mask.length, out = {};
  if (ch.sog) {
    const r = resample(ch.sog, a, step, n); let s = 0, s2 = 0, c = 0;
    for (let i = 0; i < n; i++) if (!mask[i] && isFinite(r[i])) { s += r[i]; s2 += r[i] * r[i]; c++; }
    if (c >= 60) { out.sogMean = s / c; out.sogSd = Math.sqrt(Math.max(0, s2 / c - out.sogMean * out.sogMean)); }
  }
  if (ch.yaw) {
    const r = resample(ch.yaw, a, step, n); let side = 0, turns = 0, c = 0, peak = 0;
    for (let k = 0; k < n; k++) {
      if (mask[k]) { side = 0; continue; }
      let s = 0, m = 0; for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < n && isFinite(r[j])) { s += r[j]; m++; }
      if (!m) continue; c++;
      const v = s / m; peak = Math.max(peak, Math.abs(v));
      const sd = v > TURN_DPS ? 1 : v < -TURN_DPS ? -1 : 0;
      if (sd && sd !== side) { turns++; side = sd; }
    }
    if (c >= 60) { out.turns = turns / (c * step / 60000); out.peak = peak; }
  }
  out.free = mask.reduce((x, m) => x + (m ? 0 : 1), 0) * step;
  return out;
}
/* da che parte sbanda: se ci sono virate i due lati si annullano nella media */
function sideSplit(ch, a, b) {
  if (!ch) return null;
  const i0 = idxAt(ch.t, a), i1 = idxAt(ch.t, b);
  let pos = 0, neg = 0, sp = 0, sn = 0, n = 0;
  for (let i = i0; i < i1; i++) { const v = ch.v[i]; n++; if (v > 1) { pos++; sp += v; } else if (v < -1) { neg++; sn += v; } }
  if (!n) return null;
  return { both: pos / n > 0.2 && neg / n > 0.2, pos: pos ? sp / pos : NaN, neg: neg ? sn / neg : NaN };
}
/* conduzione: rotta e timone */
function driveStats(ch, a, b) {
  const x = {};
  if (ch.cog && b - a >= 4000) {
    const i0 = idxAt(ch.cog.t, a), i1 = idxAt(ch.cog.t, b);
    let sx = 0, sy = 0, n = 0;
    for (let i = i0; i < i1; i++) { const r = ch.cog.v[i] * Math.PI / 180; sx += Math.cos(r); sy += Math.sin(r); n++; }
    if (n > 2) {
      const R = Math.min(1, Math.hypot(sx, sy) / n), mean = Math.atan2(sy, sx) * 180 / Math.PI;
      x.cogSd = Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))) * 180 / Math.PI;
      let lo = 0, hi = 0, rate = 0;
      for (let i = i0; i < i1; i++) {
        const d = angDiff(ch.cog.v[i], mean); lo = Math.min(lo, d); hi = Math.max(hi, d);
        if (i > i0) { const dt = (ch.cog.t[i] - ch.cog.t[i - 1]) / 1000; if (dt > 0.3 && dt < 5) rate = Math.max(rate, Math.abs(angDiff(ch.cog.v[i], ch.cog.v[i - 1])) / dt); }
      }
      x.cogRange = hi - lo; x.cogRate = rate;
    }
  }
  if (ch.yaw && b - a >= 4000) {
    // correzioni: ogni volta che la rotazione supera ±TURN_DPS °/s in una direzione nuova
    const n = Math.floor((b - a) / 100), r = resample(ch.yaw, a, 100, n);
    let side = 0, turns = 0, ok = 0;
    for (let k = 0; k < n; k++) {
      let s = 0, c = 0; for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < n && isFinite(r[j])) { s += r[j]; c++; }
      if (!c) continue; ok++;
      const v = s / c, sd = v > TURN_DPS ? 1 : v < -TURN_DPS ? -1 : 0;
      if (sd && sd !== side) { turns++; side = sd; }
    }
    if (ok > n * 0.5) x.turns = turns / ((b - a) / 60000);
  }
  return x;
}
/* tutte le misure del riepilogo, per un intervallo */
function segmentMeasures(S, a, b) {
  const ch = pickChannels(S), r = boatStats(S, a, b, ch);
  const mask = maneuverMask(ch, a, b);
  return { r, ch, mask, d: driveStats(ch, a, b), heelW: wobble(ch.heel, a, b, false, mask), pitchW: wobble(ch.pitch, a, b, false, mask), cogW: wobble(ch.cog, a, b, true, mask), heelSide: sideSplit(ch.heel, a, b), st: steadyStats(ch, a, b, mask) };
}

/* =================== il riepilogo: una riga per misura, numero + frase + piccolo grafico =================== */
/* percentile di un array (già senza NaN) */
function pctl(arr, p) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort(), x = (s.length - 1) * p, i = Math.floor(x);
  return s[i] + (s[Math.min(s.length - 1, i + 1)] - s[i]) * (x - i);
}
/* valori ogni 100 ms fuori dalle manovre (per gli angoli: scostamento dalla media circolare) */
function steadyValues(ch, a, mask, center) {
  const n = mask.length, r = resample(ch, a, 100, n), out = [];
  for (let i = 0; i < n; i++) if (!mask[i] && isFinite(r[i])) out.push(center != null ? angDiff(r[i], center) : r[i]);
  return out;
}
/* intervalli di manovra dalla maschera (per colorarli di grigio nei grafici) */
function maskRuns(mask, a) {
  const runs = []; let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const m = i < mask.length && mask[i];
    if (m && s < 0) s = i; else if (!m && s >= 0) { runs.push([a + s * 100, a + i * 100]); s = -1; }
  }
  return runs;
}
/* ritmo di un'oscillazione: "una ogni ~8 s" */
function everyText(perMin) {
  if (!(perMin > 0)) return 'quasi ferma';
  const s = 60 / perMin;
  return s >= 90 ? 'molto lenta' : `una ogni ~${s < 10 ? fmtNum(s, 0) : Math.round(s / 5) * 5} s`;
}
/* piccolo grafico di un canale nel tratto: linea, fascia "di solito", media, manovre in grigio.
   Passando il dito/mouse si legge il valore; con un clic il Debrief va a quel momento. */
function miniChart({ ch, a, b, center = null, band, mean, dec = 1, unit = '', runs = [], thr = null, V = null, fmt = null }) {
  const N = 320, step = Math.max(50, (b - a) / N), n = Math.max(2, Math.floor((b - a) / step) + 1);
  const raw = resample(ch, a, step, n), v = new Float64Array(n);
  for (let k = 0; k < n; k++) v[k] = isFinite(raw[k]) ? (center != null ? angDiff(raw[k], center) : raw[k]) : NaN;
  let lo = Infinity, hi = -Infinity;
  for (const x of v) if (isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  if (!isFinite(lo)) return null;
  for (const x of [band?.[0], band?.[1], mean, thr, thr != null ? -thr : null]) if (x != null && isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  if (hi - lo < 1e-6) { const e = Math.max(Math.abs(hi) * 0.2, 0.05); lo -= e; hi += e; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const W = 1000, H = 100, X = t => (t - a) / (b - a) * W, Y = y => H - (y - lo) / (hi - lo) * H;
  const ns = 'http://www.w3.org/2000/svg', el = (tag, at) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'sa-svg', 'aria-hidden': 'true' });
  for (const [t0, t1] of runs) svg.append(el('rect', { x: X(t0), y: 0, width: Math.max(1, X(t1) - X(t0)), height: H, class: 'sa-man' }));
  if (band && isFinite(band[0]) && isFinite(band[1])) svg.append(el('rect', { x: 0, y: Y(band[1]), width: W, height: Math.max(1, Y(band[0]) - Y(band[1])), class: 'sa-band' }));
  const hline = (y, cls) => svg.append(el('line', { x1: 0, x2: W, y1: Y(y), y2: Y(y), class: cls, 'vector-effect': 'non-scaling-stroke' }));
  if (lo < 0 && hi > 0 && center == null) hline(0, 'sa-zero');
  if (thr != null) { hline(thr, 'sa-thr'); hline(-thr, 'sa-thr'); }
  if (mean != null && isFinite(mean)) hline(mean, 'sa-mean');
  let d = '', pen = false;
  for (let k = 0; k < n; k++) { if (!isFinite(v[k])) { pen = false; continue; } d += (pen ? 'L' : 'M') + (k * step / (b - a) * W).toFixed(1) + ' ' + Y(v[k]).toFixed(1); pen = true; }
  svg.append(el('path', { d, class: 'sa-line', 'vector-effect': 'non-scaling-stroke' }));
  const show = fmt || (y => `${fmtNum(y, dec)} ${unit}`.trim());
  const cur = h('div', { class: 'sa-cur', hidden: true }), dot = h('div', { class: 'sa-dot', hidden: true }), tip = h('div', { class: 'sa-tip', hidden: true });
  const box = h('div', { class: 'sa-chart' + (V ? ' click' : '') }, svg,
    h('span', { class: 'sa-ax top' }, show(hi)), h('span', { class: 'sa-ax bot' }, show(lo)), cur, dot, tip);
  const at = e => { const r = box.getBoundingClientRect(); const f = clamp((e.clientX - r.left) / r.width, 0, 1); return { f, k: Math.round(f * (b - a) / step), r }; };
  box.addEventListener('pointermove', e => {
    const { f, k, r } = at(e); const y = v[Math.min(n - 1, k)];
    cur.hidden = false; cur.style.left = (f * 100) + '%';
    if (!isFinite(y)) { dot.hidden = tip.hidden = true; return; }
    dot.hidden = tip.hidden = false; dot.style.left = (f * 100) + '%'; dot.style.top = (Y(y) / H * 100) + '%';
    tip.textContent = `${fmtClock(a + k * step)} · ${show(y)}`;
    tip.style.left = clamp(f * r.width, 60, r.width - 60) + 'px';
  });
  box.addEventListener('pointerleave', () => { cur.hidden = dot.hidden = tip.hidden = true; });
  if (V) box.addEventListener('click', e => { const { k } = at(e); V.seek(a + k * step); toast(`Vai a ${fmtClock(a + k * step)}`, 1500); });
  return box;
}

function segmentSummary(S, a, b, V = null) {
  const M = segmentMeasures(S, a, b), r = M.r, ch = M.ch;
  const mask = M.mask, runs = maskRuns(mask, a);
  const prevSeg = [...S.meta.events].filter(e => e.type === 'tratto' && e.t2 != null && e.t2 <= a + 1000 && e.t < a - 1000).pop();
  const P = prevSeg && prevSeg.t2 - prevSeg.t >= 6000 ? segmentMeasures(S, prevSeg.t, prevSeg.t2) : null;
  const prevName = prevSeg ? (prevSeg.note || 'tratto prima') : '';
  const good = c => c == null || c >= 0.8;
  const f = (v, d) => v != null && isFinite(v) ? fmtNum(v, d) : '—';
  // confronto con il tratto prima: ▲/▼, verde se è meglio
  const cmp = (now, then, d, unit, higherIsBetter) => {
    if (!P || then == null || !isFinite(then) || now == null || !isFinite(now)) return null;
    const diff = now - then, same = Math.abs(diff) < Math.pow(10, -d) * 5;
    const better = higherIsBetter == null ? null : (diff > 0) === higherIsBetter;
    return h('div', { class: 'sm-prev' + (same || better == null ? '' : better ? ' up' : ' down') },
      same ? `uguale a ${prevName}` : `${diff > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(diff), d)} ${unit} rispetto a ${prevName} (${fmtNum(then, d)})`);
  };
  // una riga: a sinistra il numero e le frasi, a destra il grafico
  const row = ({ label, big, unit, lines = [], prev, ok = true, chart, warn }) => big == null || big === '—' || /NaN/.test(big) ? null : h('div', { class: 'sa-row' + (ok ? '' : ' weak') },
    h('div', { class: 'sa-txt' },
      h('div', { class: 'sm-label' }, label, ok ? null : h('span', { class: 'sm-badge' }, 'dati incompleti')),
      h('div', { class: 'sm-val' }, h('span', { class: 'sm-big num' }, big), h('span', { class: 'sm-unit' }, unit)),
      ...lines.filter(Boolean).map(t => h('div', { class: 'sm-sub' }, t)),
      warn ? h('div', { class: 'sa-warn' }, '⚠️ ' + warn) : null, prev),
    chart || h('div', { class: 'sa-chart empty' }, 'grafico non disponibile'));
  const sec = (name, rows) => { const t = rows.filter(Boolean); return t.length ? h('div', { class: 'sm-sec' }, h('div', { class: 'sm-gh' }, name), t) : null; };
  const wob = w => !w || !isFinite(w.sd) ? null : w.sd < 0.15 ? 'stabile, quasi senza oscillazioni' : `oscilla di ± ${f(w.sd, 1)}° attorno al suo andamento, ${everyText(w.perMin)}`;

  // ---- Velocità
  let speed = null;
  if (r.sog) {
    const sv = steadyValues(ch.sog, a, mask), p10 = pctl(sv, .1), p90 = pctl(sv, .9);
    speed = row({ label: 'Velocità', big: f(r.sog.mean, 1), unit: 'kn di media',
      lines: [`di solito tra ${f(p10, 1)} e ${f(p90, 1)} kn · massima ${f(r.sog.max, 1)} kn`,
        M.st.sogMean != null && Math.abs(M.st.sogMean - r.sog.mean) >= 0.1 ? `senza le manovre: ${f(M.st.sogMean, 1)} kn di media` : null],
      prev: cmp(r.sog.mean, P?.r.sog?.mean, 1, 'kn', true), ok: good(r.sog.cov),
      warn: r.sog.mean > 30 ? 'velocità molto alta per un Nacra 17: sono dati di una prova a terra?' : null,
      chart: miniChart({ ch: ch.sog, a, b, band: [p10, p90], mean: r.sog.mean, dec: 1, unit: 'kn', runs, V }) });
  }
  // ---- Heel (positivo = sbandata a dritta)
  let heel = null;
  if (r.heel) {
    const sp = M.heelSide, sv = steadyValues(ch.heel, a, mask);
    const both = sp && sp.both, p10 = pctl(sv, .1), p90 = pctl(sv, .9);
    const absMax = Math.max(Math.abs(r.heel.min), Math.abs(r.heel.max));
    const sideOf = m => Math.abs(m) < 0.5 ? 'barca piatta' : m > 0 ? 'sbandata a dritta' : 'sbandata a sinistra';
    const between = (x, y) => { const p = [Math.abs(x), Math.abs(y)].sort((u, w) => u - w); return Math.sign(x) === Math.sign(y) ? `di solito tra ${f(p[0], 1)}° e ${f(p[1], 1)}°` : `di solito tra ${f(Math.abs(x), 1)}° a sinistra e ${f(Math.abs(y), 1)}° a dritta`; };
    heel = row({ label: 'Heel (sbandamento)', big: both ? f((Math.abs(sp.pos) + Math.abs(sp.neg)) / 2, 1) : f(Math.abs(r.heel.mean), 1), unit: both ? '° di media, nei due lati' : '° ' + sideOf(r.heel.mean).replace('barca ', ''),
      lines: [both ? `a dritta ${f(sp.pos, 1)}° · a sinistra ${f(Math.abs(sp.neg), 1)}° (ci sono virate)` : between(p10, p90) + ` · massimo ${f(absMax, 1)}°`, wob(M.heelW)],
      prev: cmp(M.heelW?.sd, P?.heelW?.sd, 1, '° di oscillazione', false), ok: good(r.heel.cov),
      chart: miniChart({ ch: ch.heel, a, b, band: both ? null : [p10, p90], mean: both ? null : r.heel.mean, dec: 1, runs, V,
        fmt: y => Math.abs(y) < 0.05 ? '0°' : `${fmtNum(Math.abs(y), 1)}° ${y > 0 ? 'dritta' : 'sinistra'}` }) });
  }
  // ---- Trim (positivo = prua su)
  let trim = null;
  if (r.pitch) {
    const sv = steadyValues(ch.pitch, a, mask), p10 = pctl(sv, .1), p90 = pctl(sv, .9), m = r.pitch.mean;
    trim = row({ label: 'Trim (prua su / giù)', big: f(Math.abs(m), 1), unit: Math.abs(m) < 0.3 ? '° in piano' : m > 0 ? '° prua su' : '° prua giù',
      lines: [`di solito tra ${f(p10, 1)}° e ${f(p90, 1)}° (positivo = prua su)`, wob(M.pitchW)],
      prev: cmp(M.pitchW?.sd, P?.pitchW?.sd, 1, '° di oscillazione', false), ok: good(r.pitch.cov),
      warn: Math.abs(m) > 15 ? 'valore insolito: il telefono era calibrato? (Logger › Calibra, a barca ferma e piatta)' : null,
      chart: miniChart({ ch: ch.pitch, a, b, band: [p10, p90], mean: m, dec: 1, unit: '°', runs, V }) });
  }
  // ---- Rotta
  let course = null;
  if (ch.cog && r.sog) {
    const cm = stats(ch.cog, a, b).mean, sv = steadyValues(ch.cog, a, mask, cm), p10 = pctl(sv, .1), p90 = pctl(sv, .9);
    const nMan = runs.length;
    const deg = x => `${Math.round((cm + x + 360) % 360)}°`;
    course = row({ label: nMan ? 'Rotta e manovre' : 'Rotta', big: nMan ? String(nMan) : `${Math.round(cm)}`, unit: nMan ? (nMan === 1 ? 'manovra' : 'manovre') : '° di media',
      lines: [nMan ? 'i salti nel grafico sono le manovre (virate, strambate, grandi cambi di rotta)' : `di solito tra ${deg(p10)} e ${deg(p90)}`,
        !M.cogW ? null : M.cogW.sd < 0.15 ? `rotta dritta, senza zig-zag${nMan ? ' tra le manovre' : ''}` : `${nMan ? 'tra una manovra e l\'altra va' : 'va'} a zig-zag di ± ${f(M.cogW.sd, 1)}°, ${everyText(M.cogW.perMin)}`],
      prev: cmp(M.cogW?.sd, P?.cogW?.sd, 1, '° di zig-zag', false), ok: good(r.sog.cov),
      chart: miniChart({ ch: ch.cog, a, b, center: cm, band: nMan ? null : [p10, p90], mean: 0, dec: 0, runs, V, fmt: y => deg(y) }) });
  }
  // ---- Timone (dalla rotazione della barca)
  let steer = null;
  if (ch.yaw && M.st.turns != null) {
    const every = M.st.turns > 0 ? 60 / M.st.turns : NaN;
    steer = row({ label: 'Timone: correzioni', big: f(M.st.turns, 0), unit: 'al minuto',
      lines: [isFinite(every) ? `cioè una correzione ogni ~${fmtNum(every, every < 10 ? 1 : 0)} s` : 'nessuna correzione', `la più forte: la barca ha girato a ${f(M.st.peak, 0)} °/s`, `conta quando la barca gira più veloce di ${TURN_DPS} °/s (linee tratteggiate), manovre escluse`],
      prev: cmp(M.st.turns, P?.st.turns, 0, 'al minuto', false), ok: good(r.steer?.cov),
      chart: miniChart({ ch: ch.yaw, a, b, thr: TURN_DPS, dec: 1, unit: '°/s', runs, V }) });
  }
  // ---- Equipaggio e altro
  const crew = r.hr && ch.hr ? row({ label: 'Battito', big: f(r.hr.mean, 0), unit: 'bpm di media', lines: [`massimo ${f(r.hr.max, 0)} bpm`],
    prev: cmp(r.hr.mean, P?.r.hr?.mean, 0, 'bpm', null), ok: good(r.hr.cov), chart: miniChart({ ch: ch.hr, a, b, mean: r.hr.mean, dec: 0, unit: 'bpm', runs, V }) }) : null;
  const impact = r.impact && ch.peak ? row({ label: 'Colpi sullo scafo', big: f(r.impact.max, 2), unit: 'g il più forte', lines: ['accelerazione più forte (onde, atterraggi)'], ok: good(r.impact.cov),
    chart: miniChart({ ch: ch.peak, a, b, dec: 2, unit: 'g', runs, V }) }) : null;

  // ---- Carichi (celle di carico): media, "di solito tra", massimo
  const loads = ch.loads.map(c => {
    const s = stats(c, a, b); if (!s.n) return null;
    const sv = steadyValues(c, a, mask), p10 = pctl(sv, .1), p90 = pctl(sv, .9), u = c.unit || '';
    return row({ label: c.name, big: f(s.mean, 0), unit: `${u} di media`, lines: [`di solito tra ${f(p10, 0)} e ${f(p90, 0)} ${u} · massimo ${f(s.max, 0)} ${u}`],
      prev: P ? cmp(s.mean, (() => { const q = stats(c, prevSeg.t, prevSeg.t2); return q.n ? q.mean : NaN; })(), 0, u, null) : null,
      chart: miniChart({ ch: c, a, b, band: [p10, p90], mean: s.mean, dec: 0, unit: u, runs, V }) });
  });
  const help = h('details', { class: 'sm-more' }, h('summary', null, 'Come leggere questi numeri'),
    h('ul', null,
      h('li', null, 'Nei grafici: la linea è il valore nel tempo, la fascia azzurra è dove sta "di solito" (8 secondi su 10), la linea tratteggiata è la media. Le zone grigie sono le manovre: non entrano nei numeri.'),
      h('li', null, 'Di solito tra A e B = per l\'80% del tempo il valore è stato tra A e B (manovre escluse). Più la fascia è stretta, più la barca è regolare.'),
      h('li', null, 'Oscilla di ± X°, una ogni ~N s = la barca va su e giù di circa X gradi attorno al suo andamento, e ogni N secondi torna al punto di partenza. I cambi lenti (raffiche lunghe, salti di vento) non contano.'),
      h('li', null, 'Il timone non ha un sensore: si contano le rotazioni della barca più veloci di ' + TURN_DPS + ' °/s, cioè le correzioni vere di rotta.'),
      h('li', null, 'Verde = meglio del tratto prima, rosso = peggio (velocità più alta è meglio; oscillazioni e correzioni più basse sono meglio).'),
      h('li', null, V ? 'Passa sopra un grafico per leggere il valore; con un clic il Debrief va a quel momento (anche il video).' : 'Passa sopra un grafico per leggere il valore in quel momento.'),
      h('li', null, '"Dati incompleti": in quel tratto è arrivato meno dell\'80% dei dati, il numero non è affidabile.')));
  const all = h('details', { class: 'sm-more' }, h('summary', null, 'Tutti i numeri'), statsTable(P ? [{ label: 'Questo tratto', r }, { label: prevName, r: P.r }] : [{ label: 'Tratto', r }]));
  const dist = r.sog ? (r.sog.dist * 1852 >= 1000 ? `${f(r.sog.dist * 1.852, 2)} km` : `${f(r.sog.dist * 1852, 0)} m`) : null;
  return h('div', { class: 'sm' },
    h('div', { class: 'sm-head' }, h('b', { class: 'num' }, `${fmtClock(a)} – ${fmtClock(b)}`), h('span', { class: 'muted' }, [fmtDur(b - a), dist].filter(Boolean).join(' · ')),
      M.st.free < (b - a) * 0.95 ? h('span', { class: 'faint' }, `manovre escluse dai numeri: ${fmtDur(b - a - M.st.free)}`) : null, P ? h('span', { class: 'faint' }, `confronto con ${prevName}`) : null),
    h('div', { class: 'sa-legend' }, h('span', { class: 'k line' }), 'valore', h('span', { class: 'k band' }), 'di solito (8 su 10)', h('span', { class: 'k mean' }), 'media', runs.length ? [h('span', { class: 'k man' }), 'manovre'] : null),
    [speed, heel, trim, course, steer, crew, impact, ...loads].some(Boolean) ? null : h('p', { class: 'muted' }, 'In questo intervallo non ci sono dati da analizzare.'),
    sec('Velocità', [speed]), sec('Assetto', [heel, trim]), sec('Conduzione', [course, steer]), sec('Equipaggio e scafo', [crew, impact]),
    sec('Carichi', loads),
    help, all);
}

/* Riepilogo di un tratto: finestra con le misure, esporta, salva come tratto */
function showRangeAnalysis(V, a, b, title) {
  const S = V.S;
  if (b - a < 2000) return;
  const saved = S.meta.events.some(e => e.type === 'tratto' && Math.abs(e.t - a) < 1500 && e.t2 != null && Math.abs(e.t2 - b) < 1500);
  modal({ title: title || 'Riepilogo del tratto', body: segmentSummary(S, a, b, V), wide: true, actions: [
    { label: 'Esporta i dati (CSV)', run: () => { V.inT = a; V.outT = b; V.exportRange(); return false; } },
    saved ? null : { label: 'Salva come tratto', run: () => { addSegment(V, a, b); } },
    { label: 'Chiudi', kind: 'primary' }].filter(Boolean) });
}
/* Un tratto è un evento con inizio e fine */
function addSegment(V, a, b, note = '') {
  const n = V.S.meta.events.filter(e => e.type === 'tratto').length + 1;
  V.S.addEvent({ t: Math.round(a), t2: Math.round(b), type: 'tratto', note: note || `Tratto ${n}` });
  V.eventsChanged();
  toast(`Salvato il tratto ${fmtClock(a)}–${fmtClock(b)}.`, 3000);
}
function segmentAt(S, t) { return S.meta.events.find(e => e.type === 'tratto' && e.t <= t && (e.t2 == null ? t <= S.t1 : t <= e.t2)) || null; }

/* =================== Pannello MEDIE (10 s / 30 s / tratto) =================== */
class AveragesPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    if (!cfg.windows) cfg.windows = [10, 30];
    this.el = h('div', { class: 'st-wrap', style: { padding: '0 2px' } });
    this.last = 0;
  }
  title() { return this.cfg.title || `Medie ${this.cfg.windows.map(w => w + ' s').join(' / ')}`; }
  update(t) {
    const now = performance.now();
    if (now - this.last < 900 && !this.force) return; // ricalcolo una volta al secondo: valori stabili e leggibili
    this.last = now; this.force = false;
    const S = this.S, chans = pickChannels(S);
    const cols = this.cfg.windows.map(w => ({ label: `ultimi ${w} s`, r: boatStats(S, t - w * 1000, t, chans) }));
    const seg = segmentAt(S, t);
    if (seg) cols.push({ label: `${seg.note || 'Tratto'} · ${fmtDur((seg.t2 ?? t) - seg.t)}`, r: boatStats(S, seg.t, Math.min(t, seg.t2 ?? t), chans) });
    this.el.textContent = '';
    this.el.append(statsTable(cols), h('p', { class: 'faint small', style: { padding: '4px 8px', margin: 0 } }, 'Grigio = meno dell\'80% dei dati nella finestra. Si aggiorna una volta al secondo.'));
  }
  eventsChanged() { this.force = true; }
  settings() {
    const w = h('input', { type: 'text', class: 'full', value: this.cfg.windows.join(', ') });
    return { el: h('label', { class: 'f' }, 'Finestre in secondi, separate da virgola (es. 10, 30, 60)', w), apply: () => { const v = w.value.split(/[,; ]+/).map(Number).filter(x => x > 0 && x <= 3600); if (v.length) this.cfg.windows = v.slice(0, 4); this.force = true; } };
  }
  resize() {}
  destroy() {}
}
PANEL_TYPES.averages = { label: 'Medie 10 s / 30 s', icon: '≈' };
PANEL_CLASSES.averages = AveragesPanel;
