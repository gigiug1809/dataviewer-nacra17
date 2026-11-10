/* Sincronizzazione automatica di video e dati.
   1. Fonti di dati tra loro: si sovrappongono le tracce GPS (per strumenti con l'orologio del telefono, come il Cyclops).
   2. GoPro senza GPS: si confronta la rotazione della barca misurata dal giroscopio della camera
      con le virate e strambate viste dal GPS (rotta che cambia). Lo sfasamento che le fa coincidere
      è l'errore dell'orologio della camera, trovato al decimo di secondo. */
'use strict';
const GPS_TIME_KINDS = new Set(['FIT', 'TCX', 'GPX', 'Vakaros', 'GoPro', 'iPhone']);

// media dei campioni in finestre regolari
function windowMeans(ch, t0, n, step) {
  const out = new Float64Array(n).fill(NaN), T = ch.t, V = ch.v;
  let i = idxAt(T, t0 - step / 2);
  for (let k = 0; k < n; k++) {
    const e = t0 + k * step + step / 2; let s = 0, c = 0;
    while (i < T.length && T[i] < e) { s += V[i]; c++; i++; }
    if (c) out[k] = s / c;
  }
  return out;
}
// velocità di rotazione (°/s) da una rotta o prua
function headingRate(ch, t0, n, step) {
  const H = resample(ch, t0 - step, step, n + 2), out = new Float64Array(n);
  for (let k = 0; k < n; k++) { const a = H[k], b = H[k + 2]; out[k] = isFinite(a) && isFinite(b) ? angDiff(b, a) / (2 * step / 1000) : NaN; }
  return out;
}
function smoothArr(A, w) {
  const out = new Float64Array(A.length).fill(NaN);
  for (let k = 0; k < A.length; k++) { let s = 0, c = 0; for (let j = k - w; j <= k + w; j++) if (j >= 0 && j < A.length && isFinite(A[j])) { s += A[j]; c++; } if (c > w) out[k] = s / c; }
  return out;
}
// correlazione tra A[k] e B[k + shift]
function corrShift(A, B, shift, minN) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const k0 = Math.max(0, -shift), k1 = Math.min(A.length, B.length - shift);
  for (let k = k0; k < k1; k++) {
    const a = A[k], b = B[k + shift];
    if (!(a === a) || !(b === b)) continue;
    n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
  }
  if (n < minN) return { r: 0, n };
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return { r: va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : 0, n };
}

/* GoPro: giroscopio della camera contro le virate del GPS (yaw = rotazione della camera, da camMotion) */
function syncCameraByGyro(S, cam, yaw, maxLagMs = 3 * 3600e3) {
  if (!yaw || yaw.t.length < 10) return { ok: false, why: 'Il video non ha il giroscopio (serve una GoPro).' };
  const refs = S.channels.filter(c => (c.role === 'cog' || c.role === 'hdg') && c.src !== cam.id);
  if (!refs.length) return { ok: false, why: 'Manca una rotta GPS da confrontare: carica i dati dell\'orologio, del Vakaros o di un altro GPS.' };
  // preferisco la rotta della fonte con l'orologio del satellite
  refs.sort((a, b) => (GPS_TIME_KINDS.has(b.srcKind || (S.meta.sources.find(s => s.id === b.src) || {}).kind) ? 1 : 0) - (GPS_TIME_KINDS.has(a.srcKind || (S.meta.sources.find(s => s.id === a.src) || {}).kind) ? 1 : 0) || (b.derived ? 1 : 0) - (a.derived ? 1 : 0));
  const ref = refs[0];
  const sog = S.sog && S.sog.src === ref.src ? S.sog : null;
  const step = 1000, y0 = yaw.t[0], y1 = yaw.t[yaw.t.length - 1];
  const nA = Math.floor((y1 - y0) / step);
  if (nA < 120) return { ok: false, why: 'Il video è troppo corto per sincronizzarlo così (servono almeno 2 minuti).' };
  const lim = Math.round(maxLagMs / step);
  const A = smoothArr(windowMeans(yaw, y0, nA, step), 1);
  const Braw = headingRate(ref, y0 - lim * step, nA + 2 * lim, step);
  // dove la barca è quasi ferma la rotta GPS è rumore: la tolgo
  if (sog) { const Sv = resample(sog, y0 - lim * step, step, nA + 2 * lim); for (let k = 0; k < Braw.length; k++) if (!(Sv[k] > 2)) Braw[k] = NaN; }
  const B = smoothArr(Braw, 1);
  const minN = 120;
  // ricerca grossolana ogni 2 s, poi fine
  const res = [];
  for (let L = -lim; L <= lim; L += 2) { const c = corrShift(A, B, L + lim, minN); res.push([L, c.r, c.n]); }
  const best = res.reduce((m, x) => Math.abs(x[1]) > Math.abs(m[1]) ? x : m, [0, 0, 0]);
  if (!best[2]) return { ok: false, why: 'Il video e la rotta GPS non si sovrappongono nel tempo (oltre 3 ore di differenza?).' };
  let fine = best;
  for (let L = best[0] - 3; L <= best[0] + 3; L++) { const c = corrShift(A, B, L + lim, minN); if (Math.abs(c.r) > Math.abs(fine[1])) fine = [L, c.r, c.n]; }
  // al decimo di secondo: sposto la griglia della camera
  let bestMs = fine[0] * step, bestR = fine[1];
  for (let d = -900; d <= 900; d += 100) {
    const Ad = smoothArr(windowMeans(yaw, y0 - d, nA, step), 1);
    const c = corrShift(Ad, B, fine[0] + lim, minN);
    if (Math.abs(c.r) > Math.abs(bestR)) { bestR = c.r; bestMs = fine[0] * step + d; }
  }
  // affidabilità: il picco deve staccarsi dagli altri
  const second = res.filter(x => Math.abs(x[0] - fine[0]) > 20).reduce((m, x) => Math.max(m, Math.abs(x[1])), 0);
  const r = Math.abs(bestR), conf = r >= 0.55 && r - second >= 0.15 ? 'alta' : r >= 0.4 && r - second >= 0.08 ? 'media' : 'bassa';
  if (conf === 'bassa') return { ok: false, why: `Il confronto non è affidabile (somiglianza ${fmtNum(r * 100, 0)}%). Succede se la camera non è fissata alla barca o se in quel tratto non ci sono virate.`, r, second };
  return { ok: true, offset: bestMs, r, second, conf, ref: `${ref.name} (${ref.srcName})`, n: fine[2] };
}

/* Affinamento clip per clip: la rotazione della GoPro contro quella del telefono fissato alla barca
   (25 campioni al secondo). Ogni spezzone GoPro ha l'ora d'inizio al secondo intero, quindi ognuno
   può sbagliare di un secondo a modo suo: cerco lo sfasamento di ognuno entro ±8 s, al ventesimo di secondo.
   Si usa solo il "quando" della rotazione, non quanto gira: va bene anche se il supporto flette. */
const FINE_STEP = 50, FINE_MAX = 8000;
function needsFineSync(cam) {
  return cam.clips.some(c => c.gpmd) && !cam.clips.every(c => c.startSrc === 'gps')
    && !!cam.sync && cam.sync.method === 'gyro' && !cam.fineSync;
}
function fineRef(S) {
  // la velocità di rotazione di uno strumento fissato alla barca (il telefono del Logger o live)
  const list = S.channels.filter(c => !c.derived && /yaw_rate_dps$|^live:.*yaw/i.test(c.id) && c.t.length > 100);
  list.sort((a, b) => chanRank(S, a) - chanRank(S, b) || b.t.length - a.t.length);
  return list[0] || null;
}
function fineLag(part, ref) {
  const step = FINE_STEP, L = Math.round(FINE_MAX / step);
  const t0 = part.t[0], n = Math.floor((part.t[part.t.length - 1] - t0) / step);
  const minN = Math.round(3 * 60e3 / step); // almeno 3 minuti in comune
  if (n < minN) return { ok: false, why: 'spezzone troppo corto' };
  const A = smoothArr(resample(part, t0, step, n), 1);
  const B = smoothArr(resample(ref, t0 - L * step, step, n + 2 * L), 2);
  const rs = new Float64Array(2 * L + 1);
  let bi = -1;
  for (let k = 0; k <= 2 * L; k++) {
    const c = corrShift(A, B, k, minN);
    rs[k] = Math.abs(c.r);
    if (c.n >= minN && (bi < 0 || rs[k] > rs[bi])) bi = k;
  }
  if (bi < 0 || !(rs[bi] > 0)) return { ok: false, why: 'il telefono non registrava durante questo spezzone' };
  // picco tra due campioni (parabola)
  let sub = 0;
  if (bi > 0 && bi < 2 * L) { const a = rs[bi - 1], b = rs[bi], c = rs[bi + 1], d = a - 2 * b + c; if (d < 0) sub = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)); }
  let second = 0;
  for (let k = 0; k <= 2 * L; k++) if (Math.abs(k - bi) * step > 3000) second = Math.max(second, rs[k]);
  const r = rs[bi], conf = r >= 0.6 && r - second >= 0.1 ? 'alta' : r >= 0.45 && r - second >= 0.05 ? 'media' : 'bassa';
  // B[k + bi] è il telefono all'ora t0 + (k + bi - L)·step: l'evento che la GoPro segna a t0 + k·step è avvenuto (bi - L)·step dopo
  return { ok: conf !== 'bassa', shift: Math.round((bi - L + sub) * step), r, second, conf };
}
async function fineSyncCamera(S, cam) {
  const ref = fineRef(S);
  if (!ref) return { ok: false, changed: false, why: 'manca la rotazione del telefono del Logger' };
  const parts = await S.camMotion(cam);
  if (!parts.length) return { ok: false, changed: false, why: 'la GoPro non ha il giroscopio' };
  const clips = [];
  let changed = false;
  for (const p of parts) {
    const r = fineLag(p, ref);
    const name = p.clip.file.split('/').pop();
    if (!r.ok) { clips.push({ file: name, ok: false, why: r.why || `somiglianza bassa (${fmtNum(r.r * 100, 0)}%)` }); continue; }
    p.clip.fine = Math.round((Number(p.clip.fine) || 0) + r.shift);
    clips.push({ file: name, ok: true, shift: r.shift, r: Math.round(r.r * 100) / 100, conf: r.conf });
    changed = true;
  }
  cam.fineSync = { at: Date.now(), ref: `${ref.name} (${ref.srcName})`, clips };
  return { ok: clips.some(c => c.ok), changed: true, cam: cam.name, clips, ref: cam.fineSync.ref, moved: changed };
}
function fineText(r) {
  const ok = r.clips.filter(c => c.ok), bad = r.clips.filter(c => !c.ok);
  return (ok.length ? `affinata spezzone per spezzone sulla rotazione di ${r.ref}: ` + ok.map(c => `${c.file} ${fmtOffset(c.shift)}`).join(', ') : 'affinamento non riuscito')
    + (bad.length ? ` · non affinati: ${bad.map(c => `${c.file} (${c.why})`).join(', ')}` : '');
}

/* Fonti di dati con posizione e orologio non GPS (Cyclops, CSV): allineo la traccia a quella di un GPS */
function syncSourceByTrack(S, src) {
  const mine = S.channels.filter(c => c.src === src.id);
  const lat = mine.find(c => c.role === 'lat'), lon = mine.find(c => c.role === 'lon');
  if (!lat || !lon) return { ok: false, why: 'senza posizione' };
  const others = S.meta.sources.filter(s => s.id !== src.id && GPS_TIME_KINDS.has(s.kind)).map(s => s.id);
  for (const cam of S.meta.cameras) if (S.ch(`${cam.id}:lat`)) others.push(cam.id);
  for (const id of others) {
    const la = S.ch(`${id}:lat`) || S.channels.find(c => c.src === id && c.role === 'lat'), lo = S.channels.find(c => c.src === id && c.role === 'lon');
    if (!la || !lo) continue;
    const r = alignTracks(la, lo, lat, lon);
    if (r.ok) return { ok: true, offset: r.off, dist: r.dist, ref: la.srcName };
  }
  return { ok: false, why: 'nessuna traccia GPS di riferimento' };
}

/* Esegue tutto ciò che si può fare in automatico. Non tocca quello che hai sistemato a mano. */
async function autoSync(folder, meta, { force = false, onStep } = {}) {
  const report = [];
  let S = new Session(folder, meta);
  await S.load();
  let changed = false;
  for (const src of meta.sources) {
    if (GPS_TIME_KINDS.has(src.kind)) continue;
    if (!force && src.sync && src.sync.method) continue;
    const r = syncSourceByTrack(S, src);
    if (!r.ok) { if (r.why !== 'senza posizione') report.push({ what: src.name, ok: false, text: 'non allineato: ' + r.why }); continue; }
    const add = r.offset / 1000;
    src.offset = Math.round(((Number(src.offset) || 0) + add) * 10) / 10;
    src.sync = { method: 'gps', ref: r.ref, at: Date.now(), dist: Math.round(r.dist) };
    report.push({ what: src.name, ok: true, text: `allineato alla traccia GPS di ${r.ref}: spostato di ${fmtNum(add, 1)} s (tracce a ${Math.max(1, Math.round(r.dist))} m)` });
    changed = true;
  }
  if (changed) { S = new Session(folder, meta); await S.load(); }
  for (const cam of meta.cameras) {
    if (cam.clips.every(c => c.startSrc === 'gps')) { report.push({ what: cam.name, ok: true, text: 'ora presa dal GPS della GoPro: già esatta' }); continue; }
    if (cam.clips.every(c => c.startSrc === 'logger')) { report.push({ what: cam.name, ok: true, text: 'video del Logger: già allineato ai dati' }); continue; }
    if (!force && cam.sync && cam.sync.method === 'manual') { report.push({ what: cam.name, ok: true, text: 'sincronizzata a mano: non la tocco' }); continue; }
    if (!force && cam.sync && cam.sync.method === 'gyro') {
      if (needsFineSync(cam)) {
        onStep && onStep(`Affino ${cam.name} sul telefono…`);
        const f = await fineSyncCamera(S, cam);
        if (f.changed) { changed = true; report.push({ what: cam.name, ok: f.ok, text: fineText(f) }); continue; }
      }
      report.push({ what: cam.name, ok: true, text: `sincronizzata con il giroscopio (affidabilità ${cam.sync.conf})` + (cam.fineSync && cam.fineSync.clips.some(c => c.ok) ? ', affinata spezzone per spezzone sul telefono' : '') });
      continue;
    }
    onStep && onStep(`Confronto il giroscopio di ${cam.name} con le virate…`);
    // si riparte da zero: via gli affinamenti dei singoli spezzoni (li rimetto se il confronto non riesce)
    const keep = { fine: cam.clips.map(cl => cl.fine), fineSync: cam.fineSync };
    for (const cl of cam.clips) delete cl.fine;
    delete cam.fineSync;
    const parts = await S.camMotion(cam);
    const pairs = parts.flatMap(p => Array.from(p.t, (t, i) => [t, p.v[i]])).sort((a, b) => a[0] - b[0]);
    const yaw = pairs.length ? { t: Float64Array.from(pairs, a => a[0]), v: Float64Array.from(pairs, a => a[1]), step: 100, gap: 1000 } : null;
    const r = syncCameraByGyro(S, cam, yaw);
    if (!r.ok) {
      cam.clips.forEach((cl, i) => { if (keep.fine[i] != null) cl.fine = keep.fine[i]; });
      if (keep.fineSync) cam.fineSync = keep.fineSync;
      const phone = cam.clips.some(c => c.samsung || c.appleStart || c.startSrc === 'filename' || c.startSrc === 'mvhd-end');
      report.push({ what: cam.name, ok: phone, text: phone ? 'video del telefono: ora presa da nome e metadati (precisione di circa 1 s)' : r.why });
      continue;
    }
    cam.offset = Math.round((Number(cam.offset) || 0) + r.offset);
    cam.sync = { method: 'gyro', conf: r.conf, r: Math.round(r.r * 100) / 100, ref: r.ref, at: Date.now() };
    report.push({ what: cam.name, ok: true, text: `sincronizzata con il giroscopio sulle virate di ${r.ref}: correzione ${fmtOffset(r.offset)} (affidabilità ${r.conf})` });
    changed = true;
    onStep && onStep(`Affino ${cam.name} sul telefono…`);
    const f = await fineSyncCamera(S, cam);
    if (f.changed) report.push({ what: cam.name, ok: f.ok, text: fineText(f) });
  }
  return { report, changed };
}
