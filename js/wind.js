/* Vento stimato, mura e andature, qualità dei dati.
   - Vento: senza anemometro lo ricavo dalle rotte. Di bolina e di poppa la barca tiene rotte a ±30–60°
     dall'asse del vento e quasi mai vicine all'asse; di bolina va più piano che di poppa.
     L'asse migliore e la velocità danno la direzione; le due mure di bolina (o di poppa) la affinano.
     Su finestre di 20 minuti si vede anche se il vento è girato durante l'uscita.
   - Andature: bolina (TWA < 70°), traverso (70–115°), poppa (> 115°), mure a dritta o a sinistra;
     "lento" sotto 4 nodi (fermi, prua al vento tra una prova e l'altra), "manovra" attorno alle manovre.
   - Qualità: buchi e dati dubbi, secondo per secondo (movimento, GPS, precisione, salti di velocità). */
'use strict';

const WIND_MIN_KN = 6;          // sotto questa velocità le rotte non dicono niente sul vento
const SAIL_MIN_KN = 4;          // sotto: "lento" (fermi, prua al vento, a terra)

function circMean(list) { let x = 0, y = 0; for (const a of list) { x += Math.cos(a * Math.PI / 180); y += Math.sin(a * Math.PI / 180); } return list.length ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : NaN; }
function meanOf(list) { let s = 0, n = 0; for (const v of list) if (isFinite(v)) { s += v; n++; } return n ? s / n : NaN; }
/* angolo a metà tra due direzioni */
function bisect(a, b) { return (a + angDiff(b, a) / 2 + 360) % 360; }

/* campioni di navigazione regolare (ogni 2 s): rotta, velocità, ora (e heel, se c'è) */
function steadySamples(cog, sog, a, b, heel = null) {
  a = Math.max(a ?? -Infinity, cog.t[0], sog.t[0]); b = Math.min(b ?? Infinity, cog.t[cog.t.length - 1], sog.t[sog.t.length - 1]);
  const step = 2000, n = Math.floor((b - a) / step);
  if (!(n > 10)) return [];
  const H = resample(cog, a, step, n), V = resample(sog, a, step, n), out = [];
  for (let k = 3; k < n - 3; k++) {
    if (!(V[k] >= WIND_MIN_KN) || !isFinite(H[k]) || !isFinite(H[k - 3]) || !isFinite(H[k + 3])) continue;
    if (Math.abs(angDiff(H[k + 3], H[k - 3])) > 12) continue; // in curva: non conta
    out.push({ t: a + k * step, h: H[k], v: V[k], e: heel ? interp(heel, a + k * step) : NaN });
  }
  return out;
}
/* due mure di un'andatura rispetto a una direzione del vento: rotte medie e quanti campioni */
function tackClusters(P, D, upwind) {
  const s = [], p = [];
  for (const q of P) {
    const twa = angDiff(D, q.h), A = Math.abs(twa);
    if (upwind ? A < 80 : A > 100) (twa > 0 ? s : p).push(q.h);
  }
  return { s: circMean(s), p: circMean(p), ns: s.length, np: p.length };
}
/* direzione del vento da due mure: bisettrice (di poppa girata di 180°) */
function fromClusters(C, upwind) {
  if (C.ns < 10 || C.np < 10) return NaN;
  const m = bisect(C.s, C.p);
  // la bisettrice "giusta" è quella dalla parte del vento (di bolina) o opposta (di poppa)
  return upwind ? m : (m + 180) % 360;
}

function estimateWind(cog, sog, a, b, heel = null) {
  if (!cog || !sog) return null;
  const P = steadySamples(cog, sog, a, b, heel);
  if (P.length < 60) return null; // servono almeno 2 minuti di navigazione regolare
  // punteggio di ogni direzione possibile (giro completo, a passi di 1°):
  // - le rotte stanno nelle due fasce tipiche (±28–62° di bolina, ±118–152° di poppa) e non vicino all'asse;
  // - la barca sbanda sottovento: heel a sinistra = vento da dritta (risolve i casi con rotte a 90° tra loro);
  // - di bolina si va più piano che di poppa.
  const g = d => (d >= 28 && d <= 62) || (d >= 118 && d <= 152) ? 1 : d < 20 || d > 160 ? -2 : 0;
  const N = P.length;
  let D = 0, bs = -Infinity;
  for (let c = 0; c < 360; c++) {
    let s = 0, su = 0, nu = 0, sd = 0, nd = 0;
    for (const q of P) {
      const twa = angDiff(c, q.h), A = Math.abs(twa);
      s += g(A);
      if (isFinite(q.e) && Math.abs(q.e) > 3 && (A < 75 || A > 105)) s += 0.8 * (q.e * twa < 0 ? 1 : -1);
      if (A < 80) { su += q.v; nu++; } else if (A > 100) { sd += q.v; nd++; }
    }
    if (nu > 20 && nd > 20) s += 0.25 * N * clamp((sd / nd - su / nu) / 2, -1, 1);
    if (s > bs) { bs = s; D = c; }
  }
  const speeds = D => { const up = [], dn = []; for (const q of P) { const A = Math.abs(angDiff(q.h, D)); if (A < 80) up.push(q.v); else if (A > 100) dn.push(q.v); } return { up: meanOf(up), dn: meanOf(dn), nu: up.length, nd: dn.length }; };
  // 3. affino con le mure
  for (let it = 0; it < 3; it++) {
    const u = fromClusters(tackClusters(P, D, true), true), d = fromClusters(tackClusters(P, D, false), false);
    const cu = tackClusters(P, D, true), cd = tackClusters(P, D, false);
    const wu = Math.min(cu.ns, cu.np), wd = Math.min(cd.ns, cd.np);
    let nd = NaN;
    if (isFinite(u) && isFinite(d)) nd = (u + angDiff(d, u) * wd / (wu + wd) + 360) % 360;
    else nd = isFinite(u) ? u : d;
    if (!isFinite(nd) || Math.abs(angDiff(nd, D)) > 40) break;
    D = nd;
  }
  const S2 = speeds(D), cu = tackClusters(P, D, true), cd = tackClusters(P, D, false);
  const tackAngle = cu.ns >= 10 && cu.np >= 10 ? Math.abs(angDiff(cu.s, cu.p)) : NaN;
  const gybeAngle = cd.ns >= 10 && cd.np >= 10 ? Math.abs(angDiff(cd.s, cd.p)) : NaN;
  const bothUp = cu.ns >= 30 && cu.np >= 30, bothDn = cd.ns >= 30 && cd.np >= 30;
  const diff = S2.dn - S2.up;
  let score = 0;
  if (bothUp) score += 2; else if (bothDn) score += 1;
  if (diff >= 1.5) score += 2; else if (diff >= 0.5) score += 1;
  if (isFinite(tackAngle) && tackAngle > 65 && tackAngle < 125) score += 1;
  // sbandamento coerente (sottovento) col vento trovato
  let hy = 0, hn = 0; for (const q of P) { if (!isFinite(q.e) || Math.abs(q.e) <= 3) continue; hn++; if (q.e * angDiff(D, q.h) < 0) hy++; }
  const heelAgree = hn >= 30 ? hy / hn : NaN;
  if (heelAgree >= 0.75) score += 1; else if (heelAgree < 0.5) score -= 1;
  const conf = score >= 4 ? 'alta' : score >= 2 ? 'media' : 'bassa';
  // 4. salti di vento: finestre di 20 minuti ogni 5
  const series = [], t0 = P[0].t, t1 = P[P.length - 1].t;
  if (t1 - t0 > 25 * 60e3) {
    for (let c = t0 + 10 * 60e3; c <= t1 - 5 * 60e3; c += 5 * 60e3) {
      const W = P.filter(q => Math.abs(q.t - c) <= 10 * 60e3);
      const u = tackClusters(W, D, true), d = tackClusters(W, D, false);
      let x = NaN;
      if (u.ns >= 20 && u.np >= 20) x = bisect(u.s, u.p);
      else if (d.ns >= 20 && d.np >= 20) x = (bisect(d.s, d.p) + 180) % 360;
      if (isFinite(x) && Math.abs(angDiff(x, D)) < 35) series.push([c, x]);
    }
  }
  let shiftMin = 0, shiftMax = 0;
  for (const [, x] of series) { const d = angDiff(x, D); shiftMin = Math.min(shiftMin, d); shiftMax = Math.max(shiftMax, d); }
  return { twd: Math.round(D), conf, upSpeed: S2.up, downSpeed: S2.dn, tackAngle, gybeAngle, series: series.length >= 2 ? series : [],
    shiftMin, shiftMax, upTime: (cu.ns + cu.np) * 2000, downTime: (cd.ns + cd.np) * 2000, heelAgree, estimated: true };
}
/* direzione del vento a un'ora (con i salti di vento, se ci sono) */
function windAt(W, t) {
  if (!W) return NaN;
  const s = W.series;
  if (!s || s.length < 2) return W.twd;
  if (t <= s[0][0]) return s[0][1];
  if (t >= s[s.length - 1][0]) return s[s.length - 1][1];
  let i = 1; while (s[i][0] < t) i++;
  const [ta, a] = s[i - 1], [tb, b] = s[i], f = (t - ta) / (tb - ta);
  return (a + angDiff(b, a) * f + 360) % 360;
}
function windText(W) {
  if (!W) return '';
  const parts = [`bolina ${fmtNum(W.upSpeed, 1)} kn`, `poppa ${fmtNum(W.downSpeed, 1)} kn`];
  if (isFinite(W.tackAngle)) parts.push(`angolo di virata ${Math.round(W.tackAngle)}°`);
  if (isFinite(W.gybeAngle)) parts.push(`di strambata ${Math.round(W.gybeAngle)}°`);
  let shift = '';
  if (W.series && W.series.length >= 2 && W.shiftMax - W.shiftMin >= 6)
    shift = `Durante l'uscita il vento è girato tra ${Math.round((W.twd + W.shiftMin + 360) % 360)}° e ${Math.round((W.twd + W.shiftMax + 360) % 360)}°: ne tengo conto.`;
  return { line: parts.filter(p => !/NaN/.test(p)).join(' · '), shift };
}

/* ---------- andature, secondo per secondo ---------- */
const SAIL_LABEL = { bolina: 'Bolina', traverso: 'Traverso', poppa: 'Poppa' };
/* finestre delle manovre: quelle segnate e quelle trovate dalla rotta (anche se non salvate) */
function maneuverWindows(S) {
  if (!S._manAuto) S._manAuto = S.cog ? detectManeuvers(S.cog, S.sog, S.wind ? S.twdAt : NaN, S.meta.manCfg || {}) : [];
  return [...S.meta.events.filter(e => ['virata', 'strambata', 'manovra'].includes(e.type)).map(e => e.t), ...S._manAuto.map(m => m.t)]
    .sort((x, y) => x - y).map(t => [t - 8000, t + 12000]);
}
function sailStates(S, a, b, step = 1000) {
  const n = Math.max(0, Math.floor((b - a) / step)), out = new Array(n);
  if (!S.sog || !S.cog || !S.twdAt) return out.fill(null);
  const man = maneuverWindows(S);
  let mi = 0;
  for (let k = 0; k < n; k++) {
    const t = a + k * step, v = interp(S.sog, t), c = interp(S.cog, t), w = S.twdAt(t);
    if (!isFinite(v)) { out[k] = null; continue; }
    while (mi < man.length && man[mi][1] < t) mi++;
    if (v < SAIL_MIN_KN) { out[k] = { mode: 'lento', v }; continue; }
    if (mi < man.length && man[mi][0] <= t) { out[k] = { mode: 'manovra', v }; continue; }
    if (!isFinite(c) || !isFinite(w)) { out[k] = null; continue; }
    const twa = angDiff(w, c), A = Math.abs(twa);   // twa > 0: vento da dritta (mure a dritta)
    out[k] = { mode: A < 70 ? 'bolina' : A > 115 ? 'poppa' : 'traverso', tack: twa > 0 ? 'dritta' : 'sinistra', A, v, vmg: v * Math.cos(A * Math.PI / 180), t };
  }
  return out;
}
/* numeri per mura e andatura in un intervallo */
function tackTable(S, a, b) {
  const st = sailStates(S, a, b), ch = pickChannels(S), groups = new Map();
  let slow = 0, man = 0, none = 0;
  for (const s of st) {
    if (!s) { none++; continue; }
    if (s.mode === 'lento') { slow++; continue; }
    if (s.mode === 'manovra') { man++; continue; }
    const k = s.mode + '|' + s.tack;
    if (!groups.has(k)) groups.set(k, { mode: s.mode, tack: s.tack, n: 0, v: [], vmg: [], A: [], heel: [], pitch: [] });
    const g = groups.get(k); g.n++; g.v.push(s.v); g.vmg.push(s.vmg); g.A.push(s.A);
    // heel "sottovento": positivo quando la barca sbanda dalla parte giusta (via dal vento)
    if (ch.heel) { const hv = interp(ch.heel, s.t); if (isFinite(hv)) g.heel.push(s.tack === 'dritta' ? -hv : hv); }
    if (ch.pitch) { const pv = interp(ch.pitch, s.t); if (isFinite(pv)) g.pitch.push(pv); }
  }
  const sd = arr => { const m = meanOf(arr); return arr.length > 1 ? Math.sqrt(arr.reduce((x, v) => x + (v - m) * (v - m), 0) / arr.length) : NaN; };
  const order = ['bolina|dritta', 'bolina|sinistra', 'traverso|dritta', 'traverso|sinistra', 'poppa|dritta', 'poppa|sinistra'];
  const rows = order.filter(k => groups.has(k) && groups.get(k).n >= 5).map(k => {
    const g = groups.get(k);
    return { key: k, mode: g.mode, tack: g.tack, time: g.n * 1000, v: meanOf(g.v), vMax: Math.max(...g.v), vmg: meanOf(g.vmg), A: meanOf(g.A),
      heel: meanOf(g.heel), heelSd: sd(g.heel), pitch: meanOf(g.pitch), pitchSd: sd(g.pitch) };
  });
  return { rows, slow: slow * 1000, man: man * 1000, none: none * 1000, total: st.length * 1000 };
}
/* frasi: confronto tra le mure della stessa andatura */
function tackInsights(T) {
  const out = [], by = k => T.rows.find(r => r.key === k);
  for (const mode of ['bolina', 'poppa', 'traverso']) {
    const d = by(mode + '|dritta'), s = by(mode + '|sinistra');
    if (!d || !s || d.time < 30000 || s.time < 30000) continue;
    const dv = d.v - s.v, faster = dv > 0 ? 'dritta' : 'sinistra', fast = dv > 0 ? d : s, slow = dv > 0 ? s : d;
    const name = SAIL_LABEL[mode].toLowerCase();
    if (Math.abs(dv) >= 0.4) {
      let why = '';
      if (isFinite(fast.heel) && isFinite(slow.heel) && Math.abs(fast.heel - slow.heel) >= 1.5) why = ` Con mure a ${faster} la barca sbanda ${fmtNum(Math.abs(fast.heel - slow.heel), 1)}° ${fast.heel > slow.heel ? 'di più' : 'di meno'}`;
      if (isFinite(fast.pitch) && isFinite(slow.pitch) && Math.abs(fast.pitch - slow.pitch) >= 0.7) why += `${why ? ' e' : ' Con mure a ' + faster} la prua sta ${fmtNum(Math.abs(fast.pitch - slow.pitch), 1)}° più ${fast.pitch > slow.pitch ? 'alta' : 'bassa'}`;
      if (mode === 'bolina' && isFinite(fast.A) && isFinite(slow.A) && Math.abs(fast.A - slow.A) >= 3) why += `${why ? ';' : ' Con mure a ' + faster} si stringe ${fmtNum(Math.abs(fast.A - slow.A), 0)}° ${fast.A < slow.A ? 'di più' : 'di meno'}`;
      out.push({ kind: 'info', text: `Di ${name} siete più veloci con mure a ${faster}: ${fmtNum(fast.v, 1)} contro ${fmtNum(slow.v, 1)} kn (+${fmtNum(Math.abs(dv), 1)}).${why ? why + '.' : ''} Vale la pena guardare cosa cambia sull'altro bordo (posizioni, regolazioni).` });
    } else out.push({ kind: 'good', text: `Di ${name} le due mure sono equilibrate (${fmtNum(d.v, 1)} e ${fmtNum(s.v, 1)} kn).` });
    if (mode === 'bolina' && isFinite(d.vmg) && isFinite(s.vmg) && Math.abs(d.vmg - s.vmg) >= 0.4) out.push({ kind: 'info', text: `VMG di bolina: ${fmtNum(d.vmg, 1)} kn con mure a dritta, ${fmtNum(s.vmg, 1)} con mure a sinistra.` });
    const steady = [d, s].filter(r => isFinite(r.heelSd)).sort((x, y) => y.heelSd - x.heelSd);
    if (steady.length === 2 && steady[0].heelSd - steady[1].heelSd >= 1) out.push({ kind: 'info', text: `Di ${name} con mure a ${steady[0].tack} l'heel oscilla di più (±${fmtNum(steady[0].heelSd, 1)}° contro ±${fmtNum(steady[1].heelSd, 1)}°): barca meno stabile su quel bordo.` });
  }
  return out;
}

/* ---------- qualità dei dati ---------- */
const QUALITY_TEXT = { nodata: 'nessun dato', mov0: 'mancano i dati di movimento', movLow: 'dati di movimento a singhiozzo', gps0: 'GPS assente', gpsBad: 'GPS impreciso (più di 10 m)', jump: 'salto di velocità GPS (dato sospetto)' };
const QUALITY_BAD = new Set(['nodata', 'mov0', 'gps0']);
function dataQuality(S, a = S.t0, b = S.t1) {
  const ch = pickChannels(S);
  const heel = ch.heel, lat = S.pos && S.pos.lat, sog = S.sog;
  const hacc = S.channels.find(c => /:gps_hacc_m$/.test(c.id));
  if (!heel && !lat) return null;
  const data = coverage(S).allData;
  const inData = t => data.some(([x, y]) => t >= x && t <= y);
  const n = Math.max(0, Math.floor((b - a) / 1000)), flags = new Array(n).fill(null);
  const expect = heel ? 1000 / heel.step : 0;
  for (let k = 0; k < n; k++) {
    const t = a + k * 1000;
    if (!inData(t)) { flags[k] = 'nodata'; continue; }
    let f = null;
    if (heel) { const c = idxAt(heel.t, t + 1000) - idxAt(heel.t, t); if (c === 0) f = 'mov0'; else if (c < expect * 0.6) f = 'movLow'; }
    if (!f && lat) { const j = idxAt(lat.t, t + 1000) - 1; if (j < 0 || t + 1000 - lat.t[j] > 3500) f = 'gps0'; }
    if (!f && hacc) { const v = interp(hacc, t); if (v > 10) f = 'gpsBad'; }
    if (!f && sog && k > 0) { const v0 = interp(sog, t - 1000), v1 = interp(sog, t); if (Math.abs(v1 - v0) > 6) f = 'jump'; }
    flags[k] = f;
  }
  // intervalli: stessa causa, buchi di 2 s uniti, i dubbi più corti di 3 s ignorati
  const runs = [];
  for (let k = 0; k < n; k++) {
    const f = flags[k]; if (!f) continue;
    const last = runs[runs.length - 1];
    if (last && last.why === f && a + k * 1000 - last.b <= 2000) last.b = a + (k + 1) * 1000;
    else runs.push({ why: f, a: a + k * 1000, b: a + (k + 1) * 1000 });
  }
  const issues = runs.filter(r => QUALITY_BAD.has(r.why) ? r.b - r.a >= 2000 : r.b - r.a >= 3000)
    .map(r => Object.assign(r, { bad: QUALITY_BAD.has(r.why), text: QUALITY_TEXT[r.why] }));
  const covered = flags.filter(f => f !== 'nodata').length;
  const badS = issues.filter(r => r.bad && r.why !== 'nodata').reduce((x, r) => x + r.b - r.a, 0) / 1000;
  const doubtS = issues.filter(r => !r.bad).reduce((x, r) => x + r.b - r.a, 0) / 1000;
  return { issues, covered: covered * 1000, good: covered ? Math.max(0, 1 - (badS + doubtS) / covered) : 0, badS, doubtS,
    gaps: issues.filter(r => r.why === 'nodata') };
}
function qualityText(Q) {
  if (!Q) return '';
  if (Q.good >= 0.995) return 'Dati completi e affidabili.';
  const p = Math.round(Q.good * 1000) / 10;
  const by = new Map(); for (const r of Q.issues) if (r.why !== 'nodata') by.set(r.why, (by.get(r.why) || 0) + (r.b - r.a));
  const parts = [...by.entries()].sort((x, y) => y[1] - x[1]).map(([w, ms]) => `${QUALITY_TEXT[w]} ${fmtDur(ms)}`);
  return `${fmtNum(p, 1)}% dei dati affidabile${parts.length ? ' · ' + parts.join(' · ') : ''}.`;
}
