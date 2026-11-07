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
  ['Sbandamento medio', r => r.heel && fmtNum(r.heel.mean, 1), '°', r => r.heel && r.heel.cov],
  ['Sbandamento: ampiezza', r => r.heel && fmtNum(r.heel.range, 1), '°', r => r.heel && r.heel.cov],
  ['Sbandamento: oscillazioni', r => r.heel && fmtNum(r.heel.osc, 0), '/min', r => r.heel && r.heel.cov],
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
  return { r, ch, d: driveStats(ch, a, b), heelW: wobble(ch.heel, a, b, false, mask), pitchW: wobble(ch.pitch, a, b, false, mask), cogW: wobble(ch.cog, a, b, true, mask), heelSide: sideSplit(ch.heel, a, b), st: steadyStats(ch, a, b, mask) };
}

/* il riepilogo: riquadri divisi per tipo, un numero grande e una frase */
function segmentSummary(S, a, b) {
  const M = segmentMeasures(S, a, b), r = M.r;
  const prevSeg = [...S.meta.events].filter(e => e.type === 'tratto' && e.t2 != null && e.t2 <= a + 1000 && e.t < a - 1000).pop();
  const P = prevSeg && prevSeg.t2 - prevSeg.t >= 6000 ? segmentMeasures(S, prevSeg.t, prevSeg.t2) : null;
  const prevName = prevSeg ? (prevSeg.note || 'tratto prima') : '';
  const good = c => c == null || c >= 0.8;
  const f = (v, d) => v != null && isFinite(v) ? fmtNum(v, d) : '—';
  const times = v => { const k = Math.round(v); return !isFinite(v) ? '' : k === 1 ? '1 volta al minuto' : `${k} volte al minuto`; };
  // confronto con il tratto prima: ▲/▼ e il valore di allora
  const cmp = (now, then, d, unit, higherIsBetter) => {
    if (!P || then == null || !isFinite(then) || now == null || !isFinite(now)) return null;
    const diff = now - then, same = Math.abs(diff) < Math.pow(10, -d) * 5;
    const better = higherIsBetter == null ? null : (diff > 0) === higherIsBetter;
    return h('div', { class: 'sm-prev' + (same || better == null ? '' : better ? ' up' : ' down') },
      same ? `come ${prevName}` : `${diff > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(diff), d)} ${unit} rispetto a ${prevName} (${fmtNum(then, d)})`);
  };
  const tile = (label, big, unit, subs, prev, ok = true) => h('div', { class: 'sm-tile' + (ok ? '' : ' weak') },
    h('div', { class: 'sm-label' }, label, ok ? null : h('span', { class: 'sm-badge' }, 'dati incompleti')),
    h('div', { class: 'sm-val' }, h('span', { class: 'sm-big num' }, big), h('span', { class: 'sm-unit' }, unit)),
    ...subs.filter(Boolean).map(t => h('div', { class: 'sm-sub' }, t)), prev);
  const sec = (name, tiles) => { const t = tiles.filter(Boolean); return t.length ? h('div', { class: 'sm-sec' }, h('div', { class: 'sm-gh' }, name), h('div', { class: 'sm-tiles' }, t)) : null; };

  // Velocità
  const speed = r.sog ? [
    tile('Velocità media', f(r.sog.mean, 1), 'kn', [`massima ${f(r.sog.max, 1)} kn`, M.st.sogMean != null && Math.abs(M.st.sogMean - r.sog.mean) >= 0.1 ? `senza le manovre: ${f(M.st.sogMean, 1)} kn` : null], cmp(r.sog.mean, P?.r.sog?.mean, 1, 'kn', true), good(r.sog.cov)),
    M.st.sogSd != null ? tile('Costanza della velocità', '± ' + f(M.st.sogSd, 1), 'kn', ['quanto si allontana dalla media, manovre escluse', 'più è basso, più la barca va regolare'], cmp(M.st.sogSd, P?.st.sogSd, 1, 'kn', false), good(r.sog.cov)) : null,
    tile('Distanza', r.sog.dist * 1852 >= 1000 ? f(r.sog.dist * 1.852, 2) : f(r.sog.dist * 1852, 0), r.sog.dist * 1852 >= 1000 ? 'km' : 'm', [`in ${fmtDur(b - a)}`], null, good(r.sog.cov))] : [];
  // Stato barca
  const heelTile = () => {
    if (!r.heel) return null;
    const sp = M.heelSide, w = M.heelW;
    const big = sp && sp.both ? f((Math.abs(sp.pos) + Math.abs(sp.neg)) / 2, 1) : f(Math.abs(r.heel.mean), 1);
    const side = sp && sp.both ? `a dritta ${f(sp.pos, 1)}° · a sinistra ${f(Math.abs(sp.neg), 1)}° (con virate)` : Math.abs(r.heel.mean) < 0.5 ? 'barca piatta' : r.heel.mean > 0 ? 'sbandata a dritta' : 'sbandata a sinistra';
    return tile('Sbandamento medio', big, '°', [side, w && `oscilla di ± ${f(w.sd, 1)}°, ${times(w.perMin)}`], cmp(w?.sd, P?.heelW?.sd, 1, '° di oscillazione', false), good(r.heel.cov));
  };
  const pitchTile = () => {
    if (!r.pitch) return null;
    const w = M.pitchW;
    return tile('Trim medio', f(r.pitch.mean, 1), '°', [Math.abs(r.pitch.mean) < 0.3 ? 'in piano' : r.pitch.mean > 0 ? 'prua su' : 'prua giù', w && `oscilla di ± ${f(w.sd, 1)}°, ${times(w.perMin)}`], cmp(w?.sd, P?.pitchW?.sd, 1, '° di oscillazione', false), good(r.pitch.cov));
  };
  // Conduzione
  const cogTile = M.cogW ? tile('Rotta: quanto oscilla', '± ' + f(M.cogW.sd, 1), '°', ['piccole correzioni attorno alla rotta, manovre escluse', times(M.cogW.perMin)], cmp(M.cogW.sd, P?.cogW?.sd, 1, '°', false), good(r.sog?.cov)) : null;
  const steerTile = M.st.turns != null ? tile('Timone: correzioni', f(M.st.turns, 0), 'al minuto', [`la più forte: ${f(M.st.peak, 0)} °/s`, 'rotazioni della barca oltre ' + TURN_DPS + ' °/s, manovre escluse'], cmp(M.st.turns, P?.st.turns, 0, 'al minuto', false), good(r.steer?.cov)) : null;
  const crew = r.hr ? [tile('Battito medio', f(r.hr.mean, 0), 'bpm', [`massimo ${f(r.hr.max, 0)} bpm`], cmp(r.hr.mean, P?.r.hr?.mean, 0, 'bpm', null), good(r.hr.cov))] : [];

  const help = h('details', { class: 'sm-more' }, h('summary', null, 'Come leggere questi numeri'),
    h('ul', null,
      h('li', null, 'Oscilla di ± = di quanto, in media, il valore va su e giù attorno al suo andamento. Non contano i cambi lenti né i secondi attorno a virate e strambate.'),
      h('li', null, 'Volte al minuto = quante oscillazioni complete ci sono in un minuto.'),
      h('li', null, 'Il timone non ha un sensore: si contano le rotazioni della barca oltre ' + TURN_DPS + ' °/s, cioè le correzioni di rotta vere. "La più forte" è la rotazione più veloce fuori dalle manovre.'),
      h('li', null, 'Manovre = i secondi attorno a virate, strambate e grandi cambi di rotta, riconosciuti dalla rotazione della barca.'),
      h('li', null, 'Verde = meglio del tratto prima, rosso = peggio (velocità più alta è meglio; oscillazioni e correzioni più basse sono meglio).'),
      h('li', null, '"Dati incompleti": in quel tratto è arrivato meno dell\'80% dei dati, il numero non è affidabile.')));
  const all = h('details', { class: 'sm-more' }, h('summary', null, 'Tutti i numeri'), statsTable(P ? [{ label: 'Questo tratto', r }, { label: prevName, r: P.r }] : [{ label: 'Tratto', r }]));
  return h('div', { class: 'sm' },
    h('div', { class: 'sm-head' }, h('b', { class: 'num' }, `${fmtClock(a)} – ${fmtClock(b)}`), h('span', { class: 'muted' }, fmtDur(b - a)), M.st.free < (b - a) * 0.9 ? h('span', { class: 'faint' }, `manovre escluse: ${fmtDur(b - a - M.st.free)}`) : null, P ? h('span', { class: 'faint' }, `confronto con ${prevName}`) : null),
    sec('Velocità', speed.filter(Boolean)), sec('Stato barca', [heelTile(), pitchTile()]), sec('Conduzione', [cogTile, steerTile]), sec('Equipaggio', crew),
    r.loads.length ? h('div', { class: 'stat' }, r.loads.map(l => `${l.name}: media ${fmtNum(l.mean, 0)} ${l.unit}, max ${fmtNum(l.max, 0)} ${l.unit}`).join(' · ')) : null,
    help, all);
}

/* Riepilogo di un tratto: finestra con le misure, esporta, salva come tratto */
function showRangeAnalysis(V, a, b, title) {
  const S = V.S;
  if (b - a < 2000) return;
  const saved = S.meta.events.some(e => e.type === 'tratto' && Math.abs(e.t - a) < 1500 && e.t2 != null && Math.abs(e.t2 - b) < 1500);
  modal({ title: title || 'Riepilogo del tratto', body: segmentSummary(S, a, b), wide: true, actions: [
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
