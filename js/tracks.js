/* Registrazioni di orologi e GPS: FIT (Garmin, anche dentro lo .zip di "Esporta originale"), TCX, GPX.
   Ogni file diventa una "traccia": un elenco di orari e, per ogni grandezza, i valori a quegli orari. */
'use strict';

/* ---------- ZIP (solo lettura, per l'export originale di Garmin Connect) ---------- */
async function unzipFirst(buf, re) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Lo ZIP è rovinato o incompleto.');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (!re.test(name)) continue;
    const ds = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = u8.slice(ds, ds + csize);
    if (method === 0) return { name, data: raw.buffer };
    if (method === 8) return { name, data: await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer() };
    throw new Error('Lo ZIP usa una compressione non supportata.');
  }
  return null;
}

/* ---------- FIT ---------- */
const FIT_EPOCH = 631065600000; // 1989-12-31 00:00 UTC
const FIT_BASE = { // base type -> [dimensione, lettore, valore non valido]
  0x00: [1, 'u8', 0xFF], 0x01: [1, 's8', 0x7F], 0x02: [1, 'u8', 0xFF], 0x83: [2, 's16', 0x7FFF], 0x84: [2, 'u16', 0xFFFF],
  0x85: [4, 's32', 0x7FFFFFFF], 0x86: [4, 'u32', 0xFFFFFFFF], 0x07: [1, 'str', null], 0x88: [4, 'f32', null], 0x89: [8, 'f64', null],
  0x0A: [1, 'u8', 0], 0x8B: [2, 'u16', 0], 0x8C: [4, 'u32', 0], 0x0D: [1, 'u8', null], 0x8E: [8, 's64', null], 0x8F: [8, 'u64', null], 0x90: [8, 'u64', 0]
};
// grandezze del messaggio "record" (uno per secondo): numero campo -> [chiave, nome, unità, ruolo, conversione]
const FIT_RECORD = {
  0: ['lat', 'Latitudine', '°', 'lat', v => v * 180 / 2147483648],
  1: ['lon', 'Longitudine', '°', 'lon', v => v * 180 / 2147483648],
  2: ['alt', 'Quota', 'm', 'other', v => v / 5 - 500],
  78: ['alt', 'Quota', 'm', 'other', v => v / 5 - 500],
  3: ['hr', 'Frequenza cardiaca', 'bpm', 'hr', v => v],
  4: ['cad', 'Cadenza', 'rpm', 'other', v => v],
  5: ['dist', 'Distanza', 'km', 'other', v => v / 100000],
  6: ['speed', 'Velocità', 'kn', 'sog', v => v / 1000 * KN],
  73: ['speed', 'Velocità', 'kn', 'sog', v => v / 1000 * KN],
  7: ['power', 'Potenza', 'W', 'other', v => v],
  13: ['temp', 'Temperatura', '°C', 'other', v => v],
  99: ['resp', 'Frequenza respiratoria', 'resp/min', 'other', v => v],
  108: ['resp', 'Frequenza respiratoria', 'resp/min', 'other', v => v / 100]
};
function parseFIT(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const hs = u8[0];
  if (buf.byteLength < 14 || String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== '.FIT') throw new Error('Non è un file FIT valido.');
  const end = Math.min(buf.byteLength, hs + dv.getUint32(4, true));
  const defs = {}, devDesc = {};
  const rows = new Map(); // timestamp -> {chiave: valore}
  const fields = new Map(); // chiave -> {name, unit, role}
  let p = hs, lastTs = 0, sport = '';
  const rd = (o, t, le) => {
    switch (t) {
      case 'u8': return dv.getUint8(o); case 's8': return dv.getInt8(o);
      case 'u16': return dv.getUint16(o, le); case 's16': return dv.getInt16(o, le);
      case 'u32': return dv.getUint32(o, le); case 's32': return dv.getInt32(o, le);
      case 'f32': return dv.getFloat32(o, le); case 'f64': return dv.getFloat64(o, le);
      case 's64': return Number(dv.getBigInt64(o, le)); case 'u64': return Number(dv.getBigUint64(o, le));
    }
    return NaN;
  };
  const val = (o, size, bt, le) => {
    const b = FIT_BASE[bt & 0x9F] || FIT_BASE[bt] || [1, 'u8', null];
    if (b[1] === 'str') { let s = ''; for (let i = 0; i < size && u8[o + i]; i++) s += String.fromCharCode(u8[o + i]); return s; }
    if (size < b[0]) return null;
    const v = rd(o, b[1], le);
    return b[2] != null && v === b[2] ? null : v;
  };
  while (p < end - 1) {
    const hdr = u8[p++];
    let local, ts = null;
    if (hdr & 0x80) { // intestazione con orario compresso
      local = (hdr >> 5) & 0x03;
      const off = hdr & 0x1F;
      ts = (lastTs & ~0x1F) + off; if (off < (lastTs & 0x1F)) ts += 0x20;
      lastTs = ts;
    } else if (hdr & 0x40) { // definizione
      local = hdr & 0x0F;
      const le = u8[p + 1] === 0;
      const num = le ? dv.getUint16(p + 2, true) : dv.getUint16(p + 2, false);
      const nf = u8[p + 4];
      const f = [];
      for (let i = 0; i < nf; i++) f.push([u8[p + 5 + i * 3], u8[p + 6 + i * 3], u8[p + 7 + i * 3]]);
      p += 5 + nf * 3;
      const dev = [];
      if (hdr & 0x20) { const nd = u8[p++]; for (let i = 0; i < nd; i++) dev.push([u8[p + i * 3], u8[p + 1 + i * 3], u8[p + 2 + i * 3]]); p += nd * 3; }
      defs[local] = { num, le, f, dev };
      continue;
    } else local = hdr & 0x0F;
    const d = defs[local];
    if (!d) throw new Error('File FIT illeggibile (messaggio senza definizione).');
    const rec = {};
    for (const [fn, size, bt] of d.f) { rec[fn] = val(p, size, bt, d.le); p += size; }
    const devVals = [];
    for (const [fn, size, idx] of d.dev) { const dd = devDesc[idx + ':' + fn]; devVals.push([dd, dd ? val(p, size, dd.bt, d.le) : null]); p += size; }
    if (rec[253] != null) { lastTs = rec[253]; if (ts == null) ts = rec[253]; }
    if (d.num === 206) { // descrizione dei campi aggiunti dalle app (Connect IQ)
      devDesc[rec[0] + ':' + rec[1]] = { name: rec[3] || `Campo ${rec[1]}`, unit: rec[8] || '', bt: rec[2], key: `dev${rec[0]}_${rec[1]}` };
    } else if (d.num === 12 || d.num === 18) { // sport / sessione
      if (!sport && typeof rec[3] === 'string') sport = rec[3];
    } else if (d.num === 20 && ts != null) { // record
      const t = FIT_EPOCH + ts * 1000;
      let row = rows.get(t); if (!row) { row = {}; rows.set(t, row); }
      for (const [fn, v] of Object.entries(rec)) {
        const m = FIT_RECORD[fn]; if (!m || v == null || typeof v !== 'number') continue;
        // i campi "enhanced" (velocità, quota) prevalgono su quelli normali
        if (row[m[0]] != null && (fn === '6' || fn === '2' || fn === '99')) continue;
        row[m[0]] = m[4](v);
        if (!fields.has(m[0])) fields.set(m[0], { name: m[1], unit: m[2], role: m[3] });
      }
      for (const [dd, v] of devVals) {
        if (!dd || v == null || typeof v !== 'number') continue;
        row[dd.key] = v;
        if (!fields.has(dd.key)) fields.set(dd.key, { name: dd.name, unit: dd.unit, role: guessRole(dd.name, dd.unit) });
      }
    }
  }
  return toTrack(rows, fields, sport);
}
function toTrack(rows, fields, sport = '') {
  const ts = [...rows.keys()].sort((a, b) => a - b);
  if (ts.length < 2) throw new Error('Il file non contiene una registrazione con orari (servono i dati secondo per secondo).');
  const t = Float64Array.from(ts);
  const out = [];
  for (const [key, f] of fields) {
    const v = new Float64Array(t.length);
    let n = 0;
    ts.forEach((x, i) => { const y = rows.get(x)[key]; v[i] = y == null ? NaN : y; if (y != null) n++; });
    if (n >= 2) out.push(Object.assign({ key, v, n }, f));
  }
  return { t, fields: out, sport };
}

/* ---------- TCX e GPX ---------- */
const byLocal = (el, name) => { for (const c of el.getElementsByTagName('*')) if (c.localName === name) return c; return null; };
const numOf = (el, name) => { const c = byLocal(el, name); const v = c ? parseFloat(c.textContent) : NaN; return isFinite(v) ? v : null; };
function parseXMLTrack(text, kind) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Il file non è un ' + kind + ' valido.');
  const rows = new Map(), fields = new Map();
  const set = (row, key, v, name, unit, role) => { if (v == null) return; row[key] = v; if (!fields.has(key)) fields.set(key, { name, unit, role }); };
  const pts = kind === 'TCX' ? [...doc.getElementsByTagName('*')].filter(e => e.localName === 'Trackpoint') : [...doc.getElementsByTagName('*')].filter(e => e.localName === 'trkpt' || e.localName === 'rtept');
  for (const p of pts) {
    const tEl = byLocal(p, kind === 'TCX' ? 'Time' : 'time');
    const t = tEl ? Date.parse(tEl.textContent) : NaN;
    if (!isFinite(t)) continue;
    const row = rows.get(t) || {}; rows.set(t, row);
    if (kind === 'TCX') {
      set(row, 'lat', numOf(p, 'LatitudeDegrees'), 'Latitudine', '°', 'lat');
      set(row, 'lon', numOf(p, 'LongitudeDegrees'), 'Longitudine', '°', 'lon');
      set(row, 'alt', numOf(p, 'AltitudeMeters'), 'Quota', 'm', 'other');
      const d = numOf(p, 'DistanceMeters'); set(row, 'dist', d == null ? null : d / 1000, 'Distanza', 'km', 'other');
      const hb = byLocal(p, 'HeartRateBpm'); set(row, 'hr', hb ? numOf(hb, 'Value') : null, 'Frequenza cardiaca', 'bpm', 'hr');
      const sp = numOf(p, 'Speed'); set(row, 'speed', sp == null ? null : sp * KN, 'Velocità', 'kn', 'sog');
      set(row, 'cad', numOf(p, 'Cadence') ?? numOf(p, 'RunCadence'), 'Cadenza', 'rpm', 'other');
      set(row, 'power', numOf(p, 'Watts'), 'Potenza', 'W', 'other');
    } else {
      const la = parseFloat(p.getAttribute('lat')), lo = parseFloat(p.getAttribute('lon'));
      set(row, 'lat', isFinite(la) ? la : null, 'Latitudine', '°', 'lat');
      set(row, 'lon', isFinite(lo) ? lo : null, 'Longitudine', '°', 'lon');
      set(row, 'alt', numOf(p, 'ele'), 'Quota', 'm', 'other');
      set(row, 'hr', numOf(p, 'hr'), 'Frequenza cardiaca', 'bpm', 'hr');
      set(row, 'cad', numOf(p, 'cad'), 'Cadenza', 'rpm', 'other');
      set(row, 'temp', numOf(p, 'atemp') ?? numOf(p, 'wtemp'), 'Temperatura', '°C', 'other');
      const sp = numOf(p, 'speed'); set(row, 'speed', sp == null ? null : sp * KN, 'Velocità', 'kn', 'sog');
      set(row, 'course', numOf(p, 'course'), 'Rotta', '°', 'cog');
      set(row, 'power', numOf(p, 'power'), 'Potenza', 'W', 'other');
    }
  }
  return toTrack(rows, fields);
}

/* ---------- Lettura di un file di traccia e trasformazione in canali ---------- */
const TRACK_KINDS = ['FIT', 'TCX', 'GPX'];
function trackKindOf(name) { const m = /\.(fit|tcx|gpx)$/i.exec(name); return m ? m[1].toUpperCase() : null; }
function readTrack(kind, data) {
  if (kind === 'FIT') return parseFIT(data);
  return parseXMLTrack(typeof data === 'string' ? data : new TextDecoder().decode(data), kind);
}
// Dall'orologio (Garmin) serve solo la frequenza cardiaca: posizione e velocità arrivano già
// dal telefono e dagli altri strumenti, più precisi. Le altre grandezze restano disponibili, senza spunta.
function guessTrackConfig(track, kind) {
  const hrOnly = (kind === 'FIT' || kind === 'TCX' || kind === 'GPX') && track.fields.some(f => f.key === 'hr');
  return { tz: 'utc', offset: 0, columns: track.fields.map(f => ({ col: f.key, name: f.name, unit: f.unit, role: f.role, use: hrOnly ? f.key === 'hr' : true, k: 1, add: 0 })) };
}
function buildTrackChannels(track, cfg, srcId, srcName) {
  const off = (Number(cfg.offset) || 0) * 1000;
  const out = [];
  for (const c of cfg.columns || []) {
    if (!c.use) continue;
    const f = track.fields.find(x => x.key === c.col);
    if (!f) continue;
    const k = Number(c.k) || 1, a = Number(c.add) || 0;
    const T = [], V = [];
    for (let i = 0; i < track.t.length; i++) if (isFinite(f.v[i])) { T.push(track.t[i] + off); V.push(f.v[i] * k + a); }
    if (T.length >= 2) out.push(makeChannel({ id: `${srcId}:${c.col}`, name: c.name, unit: c.unit, role: c.role, src: srcId, srcName, t: Float64Array.from(T), v: Float64Array.from(V) }));
  }
  return out;
}

/* ---------- File che non sono registrazioni ---------- */
// L'elenco attività di Garmin Connect (una riga per attività, solo medie e massimi)
function garminActivityList(tab) {
  const hd = tab.header.map(x => x.toLowerCase());
  const has = re => hd.some(x => re.test(x));
  if (!(has(/^tipo di attivit|^activity type/) && has(/^data$|^date$/) && has(/^distanz|^distance/))) return null;
  const iT = hd.findIndex(x => /^tipo di attivit|^activity type/.test(x)), iD = hd.findIndex(x => /^data$|^date$/.test(x)), iN = hd.findIndex(x => /^titolo$|^title$/.test(x)), iDur = hd.findIndex(x => /^tempo$|^time$/.test(x));
  return tab.data.map(r => ({ type: r[iT], date: r[iD], title: iN >= 0 ? r[iN] : '', dur: iDur >= 0 ? r[iDur] : '' }));
}
