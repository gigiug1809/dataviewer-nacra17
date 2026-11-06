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

/* Riepilogo di un tratto: finestra con le misure, esporta, salva come tratto */
function showRangeAnalysis(V, a, b, title) {
  const S = V.S;
  if (b - a < 2000) return;
  const r = boatStats(S, a, b);
  const body = h('div', { style: { display: 'grid', gap: '12px' } },
    h('div', { class: 'row' }, h('b', { class: 'num' }, `${fmtClock(a)} – ${fmtClock(b)}`), h('span', { class: 'muted' }, fmtDur(b - a))),
    statsTable([{ label: 'Tratto', r }]),
    r.loads.length ? h('div', { class: 'stat' }, r.loads.map(l => `${l.name}: media ${fmtNum(l.mean, 0)} ${l.unit}, max ${fmtNum(l.max, 0)} ${l.unit}`).join(' · ')) : null,
    h('p', { class: 'stat' }, STAT_HELP));
  modal({ title: title || 'Analisi del tratto', body, wide: true, actions: [
    { label: 'Esporta i dati (CSV)', run: () => { V.inT = a; V.outT = b; V.exportRange(); return false; } },
    { label: 'Salva come tratto', run: () => { addSegment(V, a, b); } },
    { label: 'Chiudi', kind: 'primary' }] });
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
