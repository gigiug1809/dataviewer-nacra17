/* Lettura dei file di dati (CSV di qualsiasi strumento, GPX) e calcoli sui canali.
   La lettura del CSV riprende quella tollerante di Cronoscatto (formato Cyclops / Smart Fittings Manager). */
'use strict';

/* ---------- CSV ---------- */
function splitCSVLine(line, d) {
  if (line.indexOf('"') < 0) return line.split(d).map(s => s.trim());
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === d) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}
const isNumLike = s => /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(s);
const toNum = s => { if (s == null || s === '') return NaN; const v = Number(String(s).replace(',', '.')); return isFinite(v) ? v : NaN; };
const RE_YMD = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(AM|PM)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;
const RE_DMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(AM|PM)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(AM|PM)?$/i;
function mkTime(y, mo, d, hh, mi, s, frac, ampm, zone, utc) {
  hh = Number(hh || 0); mi = Number(mi || 0); s = Number(s || 0);
  const ms = frac ? Math.round(Number('0.' + frac) * 1000) : 0;
  if (ampm) hh = hh % 12 + (/pm/i.test(ampm) ? 12 : 0);
  if (y < 100) y += 2000;
  if (zone) {
    let off = 0;
    if (!/^(Z|UTC|GMT)$/i.test(zone)) { const m = /([+-])(\d{2}):?(\d{2})/.exec(zone); off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])); }
    return Date.UTC(y, mo - 1, d, hh, mi, s, ms) - off * 60000;
  }
  return utc ? Date.UTC(y, mo - 1, d, hh, mi, s, ms) : new Date(y, mo - 1, d, hh, mi, s, ms).getTime();
}
function parseTimeCell(s, o = {}) {
  s = String(s).trim();
  if (!s) return null;
  let m = RE_YMD.exec(s);
  if (m) return { kind: m[4] != null ? 'datetime' : 'date', v: mkTime(+m[1], +m[2], +m[3], m[4], m[5], m[6], m[7], m[8], m[9], o.utc) };
  m = RE_DMY.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    const [d, mo] = o.order === 'mdy' ? [b, a] : [a, b];
    return { kind: m[4] != null ? 'datetime' : 'date', v: mkTime(+m[3], mo, d, m[4], m[5], m[6], m[7], m[8], m[9], o.utc) };
  }
  m = RE_TIME.exec(s);
  if (m) {
    let hh = +m[1]; if (m[5]) hh = hh % 12 + (/pm/i.test(m[5]) ? 12 : 0);
    return { kind: 'time', v: ((hh * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000 + (m[4] ? Math.round(Number('0.' + m[4]) * 1000) : 0) };
  }
  if (/[a-z]{3}/i.test(s) && /\d{1,2}:\d{2}/.test(s)) { const v = Date.parse(s); if (isFinite(v)) return { kind: 'datetime', v }; }
  return null;
}
function detectDelim(lines) {
  const sample = lines.filter(l => l.trim()).slice(0, 60);
  let best = ',', bestScore = -1;
  for (const d of [';', '\t', ',', '|']) {
    const freq = new Map();
    for (const l of sample) { const n = splitCSVLine(l, d).length; freq.set(n, (freq.get(n) || 0) + 1); }
    const [mode, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [0, 0];
    const score = mode >= 2 ? n * 1000 + mode : -1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}
const UNIT_RE = /[\(\[]\s*([^\)\]]{1,8})\s*[\)\]]/;
const UNIT_WORD = /^(kgf|kg|t|tonnes?|lbs?|kN|daN|N|kn|kts?|knots|nodi|m\/s|km\/h|°|deg|gradi|m|%|g|V|°C|rad)$/i;
const TIME_NAME = /time|date|ora|data|stamp|utc|tempo|orario/i;

function parseTable(text) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const delim = detectDelim(lines);
  // Cyclops chiude ogni riga con un separatore: lì l'ultima cella vuota non è una colonna.
  // Lo decido sul file intero, non riga per riga (altrimenti si perdono le righe che finiscono con un valore vuoto)
  // Cyclops chiude ogni riga di dati con un separatore in più rispetto all'intestazione: lì l'ultima cella
  // vuota non è una colonna. Lo tolgo solo se la riga ha proprio una cella in più dell'intestazione
  // (nei file del telefono e del live le righe hanno lo stesso numero di celle, anche se l'ultima è vuota).
  const headLine = lines.find(l => l.trim() && !l.trim().startsWith('#') && splitCSVLine(l, delim).length >= 2);
  const headN = headLine ? splitCSVLine(headLine, delim).length : 0;
  const rows = lines.map(l => {
    if (!l.trim()) return null;
    const r = splitCSVLine(l, delim);
    if (r.length === headN + 1 && r[r.length - 1] === '') r.pop();
    return r;
  });
  const freq = new Map();
  rows.forEach(r => { if (r && r.length >= 2) freq.set(r.length, (freq.get(r.length) || 0) + 1); });
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (!top) throw new Error('Non trovo colonne nel file: serve un CSV con almeno due colonne.');
  const ncol = top[0];
  const first = rows.findIndex(r => r && r.length === ncol);
  let header = rows[first], start = first + 1;
  const textCells = header.filter(c => c && !isNumLike(c) && !parseTimeCell(c)).length;
  if (textCells < Math.ceil(ncol / 2)) { header = header.map((_, i) => `Colonna ${i + 1}`); start = first; }
  header = header.map((x, i) => x || `Colonna ${i + 1}`);
  let units = header.map(() => '');
  const nx = rows[start];
  if (start > first && nx && nx.length >= ncol && nx.slice(0, ncol).every(c => !c || (!isNumLike(c) && !parseTimeCell(c)))) { units = nx.slice(0, ncol); start++; }
  const data = [];
  for (let i = start; i < rows.length; i++) { const r = rows[i]; if (r && r.length >= ncol) data.push(r.length > ncol ? r.slice(0, ncol) : r); }
  if (!data.length) throw new Error('Il file non contiene righe di dati.');
  return { delim, header, units, data, meta: lines.slice(0, first).join('\n'), preview: lines.slice(0, 10).join('\n') };
}

/* Riconosce il ruolo di una colonna dal nome */
function guessRole(name, unit) {
  const n = name.toLowerCase();
  const w = re => new RegExp('(?<![a-z])(' + re + ')(?![a-z])').test(n);
  if (/^lat/.test(n)) return 'lat';
  if (/^(lon|lng)/.test(n)) return 'lon';
  if (w('sog|speed|veloc\\w*|bsp|boat ?speed|vel')) return 'sog';
  if (w('cog|course|rotta')) return 'cog';
  if (w('heading|hdg|yaw|prua|bussola|compass') || /^hdg/.test(n)) return 'hdg';
  if (w('heel|roll|sbandamento|sband')) return 'heel';
  if (w('pitch|trim|beccheggio')) return 'pitch';
  if (w('heart ?rate|hr|bpm|battiti|fc|frequenza cardiaca|cardio')) return 'hr';
  if (w('twd')) return 'twd';
  if (w('twa|angolo( al)? vento|wind ?angle')) return 'twa';
  if (w('tws|wind ?speed|vento')) return 'tws';
  if (/load|carico|tension|force|forza|kg/.test(n) || /^(sensore )?\d{3,}$/.test(n) || /^(kg|kgf|daN|N|kN|lbs?)$/i.test(unit)) return 'load';
  return 'other';
}
const ROLE_LABEL = { time: 'Ora', hr: 'Frequenza cardiaca', lat: 'Latitudine', lon: 'Longitudine', sog: 'Velocità (SOG)', cog: 'Rotta (COG)', hdg: 'Prua (heading)', heel: 'Sbandamento', pitch: 'Beccheggio', load: 'Carico', twd: 'Direzione vento', tws: 'Intensità vento', twa: 'Angolo al vento', other: 'Altro' };
// colonne del Registratore N17 per iPhone: [nome, unità, ruolo, usata di default]
const PHONE_COLS = {
  lat: ['Latitudine', '°', 'lat', true], lon: ['Longitudine', '°', 'lon', true],
  gps_speed_kn: ['Velocità GPS', 'kn', 'sog', true], gps_course: ['Rotta GPS', '°', 'cog', true], gps_hacc_m: ['Precisione GPS', 'm', 'other', false], gps_alt_m: ['Quota GPS', 'm', 'other', false],
  heel_deg: ['Sbandamento', '°', 'heel', true], pitch_deg: ['Beccheggio', '°', 'pitch', true], heading_deg: ['Prua (bussola)', '°', 'hdg', true],
  roll_rate_dps: ['Velocità di rollio', '°/s', 'other', true], pitch_rate_dps: ['Velocità di beccheggio', '°/s', 'other', false], yaw_rate_dps: ['Velocità di rotazione', '°/s', 'other', true],
  acc_surge_g: ['Accelerazione avanti', 'g', 'other', true], acc_sway_g: ['Accelerazione laterale', 'g', 'other', false], acc_heave_g: ['Accelerazione verticale', 'g', 'other', true],
  acc_peak_g: ['Picco di accelerazione', 'g', 'other', true], pressure_kpa: ['Pressione atmosferica', 'kPa', 'other', false]
};
const NICE_NAME = { hr: 'Frequenza cardiaca', lat: 'Latitudine', lon: 'Longitudine', sog: 'Velocità', cog: 'Rotta', hdg: 'Prua', heel: 'Sbandamento', pitch: 'Beccheggio', twd: 'Direzione vento', tws: 'Vento', twa: 'Angolo al vento' };
const CIRCULAR = new Set(['cog', 'hdg', 'twd']);
const EXCLUDE_RE = /^(id|#|n\.?|no\.?|index|indice|sample|campione|seq)$/i;

function analyzeCols(tab) {
  return tab.header.map((name, j) => {
    const vals = [];
    const stepI = Math.max(1, Math.floor(tab.data.length / 400));
    for (let i = 0; i < tab.data.length && vals.length < 400; i += stepI) { const v = tab.data[i][j]; if (v !== '') vals.push(v); }
    // colonne scritte solo su alcune righe (es. GPS a 1 Hz in mezzo ai sensori a 25 Hz): le cerco in tutto il file
    if (vals.length < 40) { vals.length = 0; for (let i = 0; i < tab.data.length && vals.length < 400; i++) { const v = tab.data[i][j]; if (v !== '') vals.push(v); } }
    const nNum = vals.filter(isNumLike).length;
    const numeric = vals.length > 0 && nNum / vals.length >= 0.8;
    let time = null;
    if (numeric) {
      const nums = vals.map(toNum).filter(isFinite).sort((a, b) => a - b), med = nums[Math.floor(nums.length / 2)];
      if (med > 9e8 && med < 4.2e9 && !/lat|lon/i.test(name)) time = 'epoch_s';
      else if (med > 9e11 && med < 4.2e12) time = 'epoch_ms';
      else if (TIME_NAME.test(name) || /elapsed|second|secs?$|^t$/i.test(name)) {
        let mono = true; for (let i = 1; i < vals.length; i++) if (toNum(vals[i]) < toNum(vals[i - 1])) { mono = false; break; }
        if (mono) time = 'elapsed';
      }
    } else if (vals.length) {
      const kinds = vals.map(v => parseTimeCell(v)?.kind).filter(Boolean);
      if (kinds.length / vals.length >= 0.8) {
        const c = k => kinds.filter(x => x === k).length;
        time = c('datetime') >= c('time') && c('datetime') >= c('date') ? 'datetime' : c('time') >= c('date') ? 'time' : 'date';
      }
    }
    const distinct = numeric || time ? 0 : new Set(vals).size;
    const um = UNIT_RE.exec(name), rowUnit = (tab.units && tab.units[j]) || '';
    let label = name.replace(UNIT_RE, '').trim() || name;
    if (/^\d+$/.test(label)) label = `Sensore ${label}`;
    const unit = um ? um[1] : (rowUnit && rowUnit.length <= 8 && !/[yMdHms]{2}/.test(rowUnit) ? rowUnit : '');
    return { j, name, label, numeric, time, distinct, unit };
  });
}

/* Configurazione proposta per un CSV appena caricato */
function guessSourceConfig(tab, cols) {
  const timeCols = cols.filter(c => c.time && c.time !== 'date');
  const tc = timeCols.find(c => c.time === 'datetime' || c.time.startsWith('epoch')) || timeCols.find(c => TIME_NAME.test(c.name)) || timeCols[0];
  const textCols = cols.filter(c => !c.numeric && !c.time && c.distinct >= 1 && c.distinct <= 30);
  const sensorCol = textCols.find(c => /sensor|sensore|name|nome|fitting|device|serial|channel|canale/i.test(c.name));
  const isCyclops = /^timestamp$/i.test(tab.header[0]) && cols.some(c => /^\d{3,}$/.test(c.name));
  const isVakaros = cols.some(c => /sog_kts|hdg_true|roll|pitch/i.test(c.name)) && cols.some(c => /latitude/i.test(c.name));
  const columns = cols.filter(c => c.numeric && !c.time && !EXCLUDE_RE.test(c.name)).map(c => {
    const role = guessRole(c.label, c.unit);
    let unit = c.unit;
    if (!unit && role === 'sog') unit = /kts|knot|kn/i.test(c.name) ? 'kn' : /m\/?s/i.test(c.name) ? 'm/s' : 'kn';
    if (!unit && (role === 'cog' || role === 'hdg' || role === 'heel' || role === 'pitch' || role === 'twd' || role === 'twa')) unit = '°';
    if (!unit && role === 'load') unit = 'kg';
    if (unit === 'deg') unit = '°';
    return { j: c.j, col: c.name, name: c.label, unit, role, use: role !== 'other' || cols.length < 14, k: 1, add: 0 };
  });
  // nomi leggibili per le grandezze riconosciute (sog_kts -> Velocità)
  const seen = {};
  for (const c of columns) {
    const nice = NICE_NAME[c.role];
    if (!nice) continue;
    seen[c.role] = (seen[c.role] || 0) + 1;
    c.name = seen[c.role] > 1 ? `${nice} (${c.col})` : nice;
  }
  const isPhone = tab.header.includes('time_utc') && tab.header.includes('heel_deg');
  if (isPhone) {
    // file del Registratore N17 per iPhone: nomi e ruoli già noti
    for (const c of columns) { const m = PHONE_COLS[c.col]; if (m) Object.assign(c, { name: m[0], unit: m[1], role: m[2], use: m[3] }); else c.use = false; }
    const rid = /registrazione\s+([A-Z0-9]{6,})/.exec(tab.meta || '');
    const live = /ricevuto live/.test(tab.meta || '');
    return { timeCol: tc ? tc.j : -1, sensorCol: -1, tz: 'utc', offset: 0, kind: 'iPhone', columns, recId: rid ? rid[1] : null, live };
  }
  const kind = isCyclops ? 'Cyclops' : isVakaros ? 'Vakaros' : 'CSV';
  return { timeCol: tc ? tc.j : -1, sensorCol: sensorCol ? sensorCol.j : -1, tz: 'local', offset: 0, kind, columns };
}

/* Trasforma tabella + configurazione in canali {t, v} */
function buildChannels(tab, cols, cfg, srcId, srcName) {
  const tc = cols[cfg.timeCol];
  if (!tc) throw new Error('Scegli la colonna con l\'ora.');
  const utc = cfg.tz === 'utc';
  let order = 'dmy';
  if (tc.time === 'datetime' || tc.time === 'date') {
    for (const r of tab.data) { const m = RE_DMY.exec(r[tc.j]); if (m) { if (+m[2] > 12) { order = 'mdy'; break; } if (+m[1] > 12) break; } }
  }
  const dateCol = tc.time === 'time' ? cols.find(c => c.time === 'date') : null;
  const base = cfg.baseDate ? new Date(cfg.baseDate + 'T00:00:00').getTime() : new Date(new Date().toDateString()).getTime();
  const off = (Number(cfg.offset) || 0) * 1000;
  let firstEl = null;
  const T = new Float64Array(tab.data.length);
  tab.data.forEach((r, i) => {
    const s = r[tc.j]; let v;
    switch (tc.time) {
      case 'epoch_s': v = toNum(s) * 1000; break;
      case 'epoch_ms': v = toNum(s); break;
      case 'elapsed': { const x = toNum(s); if (firstEl == null && isFinite(x)) firstEl = x; v = base + 10 * 3600e3 + (x - (firstEl || 0)) * 1000; break; }
      case 'time': {
        const p = parseTimeCell(s); if (!p) { v = NaN; break; }
        if (dateCol) { const d = parseTimeCell(r[dateCol.j], { utc, order }); v = d ? d.v + p.v : NaN; }
        else v = (utc ? Date.UTC(new Date(base).getFullYear(), new Date(base).getMonth(), new Date(base).getDate()) : base) + p.v;
        break;
      }
      default: { const p = parseTimeCell(s, { utc, order }); v = p ? p.v : NaN; }
    }
    T[i] = v + off;
  });
  const out = [];
  const used = cfg.columns.filter(c => c.use);
  const mk = (c, keyName, pts) => {
    pts.sort((a, b) => a[0] - b[0]);
    return makeChannel({
      id: `${srcId}:${keyName}`, name: keyName === c.col ? c.name : keyName, unit: c.unit, role: c.role, src: srcId, srcName,
      t: Float64Array.from(pts, p => p[0]), v: Float64Array.from(pts, p => p[1])
    });
  };
  for (const c of used) {
    const k = Number(c.k) || 1, a = Number(c.add) || 0;
    if (cfg.sensorCol >= 0) {
      const groups = new Map();
      tab.data.forEach((r, i) => { const x = toNum(r[c.j]); if (!isFinite(T[i]) || !isFinite(x)) return; const g = r[cfg.sensorCol] || c.name; if (!groups.has(g)) groups.set(g, []); groups.get(g).push([T[i], x * k + a]); });
      for (const [g, pts] of groups) out.push(mk(c, g, pts));
    } else {
      const pts = [];
      tab.data.forEach((r, i) => { const x = toNum(r[c.j]); if (isFinite(T[i]) && isFinite(x)) pts.push([T[i], x * k + a]); });
      if (pts.length) out.push(mk(c, c.col, pts));
    }
  }
  return out.filter(ch => ch.t.length);
}

function makeChannel(o) {
  const t = o.t, v = o.v, n = t.length;
  const dts = [];
  for (let i = 1; i < n && dts.length < 3000; i += Math.max(1, Math.floor(n / 3000))) if (t[i] > t[i - 1]) dts.push(t[i] - t[i - 1]);
  dts.sort((a, b) => a - b);
  const step = dts.length ? dts[dts.length >> 1] : 1000;
  let mn = Infinity, mx = -Infinity, ints = true;
  for (let i = 0; i < n; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; if (ints && Math.abs(x - Math.round(x)) > 1e-9) ints = false; }
  const big = Math.max(Math.abs(mn), Math.abs(mx));
  const dec = o.dec != null ? o.dec : CIRCULAR.has(o.role) ? 0 : ints ? 0 : big >= 100 ? 0 : big >= 10 ? 1 : 2;
  return Object.assign({ circular: CIRCULAR.has(o.role), step, gap: Math.max(2500, step * 3), min: mn, max: mx, dec }, o);
}

/* ---------- GPX ---------- */
function parseGPX(text, srcId, srcName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const pts = [...doc.getElementsByTagName('trkpt'), ...doc.getElementsByTagName('rtept')];
  const rows = [];
  for (const p of pts) {
    const tEl = p.getElementsByTagName('time')[0];
    const t = tEl ? Date.parse(tEl.textContent) : NaN;
    if (!isFinite(t)) continue;
    const sp = p.getElementsByTagName('speed')[0] || [...p.getElementsByTagName('*')].find(e => /speed$/i.test(e.localName));
    const hr = [...p.getElementsByTagName('*')].find(e => /^hr$/i.test(e.localName));
    rows.push([t, +p.getAttribute('lat'), +p.getAttribute('lon'), sp ? +sp.textContent : NaN, hr ? +hr.textContent : NaN]);
  }
  if (rows.length < 2) throw new Error('Il file GPX non contiene una traccia con orari.');
  rows.sort((a, b) => a[0] - b[0]);
  const ch = (key, name, unit, role, idx, k = 1) => {
    const keep = rows.filter(r => isFinite(r[idx]));
    if (keep.length < 2) return null;
    return makeChannel({ id: `${srcId}:${key}`, name, unit, role, src: srcId, srcName, t: Float64Array.from(keep, r => r[0]), v: Float64Array.from(keep, r => r[idx] * k) });
  };
  return [ch('lat', 'Latitudine', '°', 'lat', 1), ch('lon', 'Longitudine', '°', 'lon', 2), ch('speed', 'Velocità GPX', 'kn', 'sog', 3, KN), ch('hr', 'Frequenza cardiaca', 'bpm', 'other', 4)].filter(Boolean);
}

/* ---------- Lettura dei valori ---------- */
function idxAt(T, t) { // primo indice con T[i] >= t
  let lo = 0, hi = T.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
function angDiff(a, b) { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; }
function interp(ch, t) {
  const T = ch.t, V = ch.v, n = T.length;
  if (!n || t < T[0] - ch.gap || t > T[n - 1] + ch.gap) return NaN;
  const i = idxAt(T, t);
  if (i === 0) return t >= T[0] - ch.step ? V[0] : NaN;
  if (i >= n) return t <= T[n - 1] + ch.step ? V[n - 1] : NaN;
  const t0 = T[i - 1], t1 = T[i];
  if (t1 - t0 > ch.gap) return t - t0 < ch.step ? V[i - 1] : t1 - t < ch.step ? V[i] : NaN;
  const a = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
  if (ch.circular) return (V[i - 1] + angDiff(V[i], V[i - 1]) * a + 360) % 360;
  return V[i - 1] + (V[i] - V[i - 1]) * a;
}
function stats(ch, t0, t1) {
  const T = ch.t, V = ch.v;
  const i0 = idxAt(T, t0), i1 = idxAt(T, t1);
  const n = i1 - i0;
  if (n <= 0) { const v = interp(ch, (t0 + t1) / 2); return { n: 0, mean: v, min: v, max: v, sd: NaN }; }
  let s = 0, s2 = 0, mn = Infinity, mx = -Infinity, sx = 0, sy = 0;
  for (let i = i0; i < i1; i++) {
    const x = V[i];
    if (ch.circular) { sx += Math.cos(x * Math.PI / 180); sy += Math.sin(x * Math.PI / 180); }
    s += x; s2 += x * x; if (x < mn) mn = x; if (x > mx) mx = x;
  }
  const mean = ch.circular ? (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360 : s / n;
  return { n, mean, min: mn, max: mx, sd: ch.circular ? NaN : Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

/* Ricampiona un canale su una griglia regolare (per grafici e calcoli) */
function resample(ch, t0, step, n) {
  const out = new Float64Array(n);
  const T = ch.t, V = ch.v, N = T.length;
  let i = idxAt(T, t0);
  for (let k = 0; k < n; k++) {
    const t = t0 + k * step;
    while (i < N && T[i] < t) i++;
    let v = NaN;
    if (i > 0 && i < N) {
      const ta = T[i - 1], tb = T[i];
      if (tb - ta <= ch.gap) { const a = tb === ta ? 1 : (t - ta) / (tb - ta); v = ch.circular ? (V[i - 1] + angDiff(V[i], V[i - 1]) * a + 360) % 360 : V[i - 1] + (V[i] - V[i - 1]) * a; }
      else if (t - ta < ch.step) v = V[i - 1];
      else if (tb - t < ch.step) v = V[i];
    } else if (i === 0 && N && T[0] - t <= ch.step) v = V[0];
    else if (i === N && N && t - T[N - 1] <= ch.step) v = V[N - 1];
    out[k] = v;
  }
  return out;
}

/* ---------- Canali calcolati ---------- */
// Velocità e rotta dalla posizione: media su ~2 s per togliere il rumore del GPS
function deriveFromTrack(lat, lon, srcId, srcName) {
  const t0 = Math.max(lat.t[0], lon.t[0]), t1 = Math.min(lat.t[lat.t.length - 1], lon.t[lon.t.length - 1]);
  if (!(t1 > t0)) return [];
  const step = Math.max(200, Math.min(1000, lat.step));
  const n = Math.floor((t1 - t0) / step) + 1;
  if (n < 5) return [];
  const LA = resample(lat, t0, step, n), LO = resample(lon, t0, step, n);
  const R = 6371008.8, rad = Math.PI / 180;
  const w = Math.max(1, Math.round(1000 / step)); // semi-finestra ~1 s
  const T = [], S = [], C = [];
  for (let k = w; k < n - w; k++) {
    const a = k - w, b = k + w;
    if (!isFinite(LA[a]) || !isFinite(LA[b]) || !isFinite(LO[a]) || !isFinite(LO[b])) continue;
    const dy = (LA[b] - LA[a]) * rad * R, dx = (LO[b] - LO[a]) * rad * R * Math.cos(LA[k] * rad);
    const dt = (b - a) * step / 1000;
    const sp = Math.sqrt(dx * dx + dy * dy) / dt * KN;
    if (sp > 45) continue;
    T.push(t0 + k * step); S.push(sp); C.push((Math.atan2(dx, dy) / rad + 360) % 360);
  }
  if (T.length < 3) return [];
  const t = Float64Array.from(T);
  // rotta: dove la barca è quasi ferma la direzione è solo rumore
  const Cm = Float64Array.from(C.map((c, i) => S[i] < 1.2 ? NaN : c));
  const keep = [...Cm.keys()].filter(i => isFinite(Cm[i]));
  const out = [makeChannel({ id: `${srcId}:sogcalc`, name: 'Velocità GPS', unit: 'kn', role: 'sog', src: srcId, srcName, t, v: Float64Array.from(S), dec: 1, derived: true })];
  if (keep.length >= 2) out.push(makeChannel({ id: `${srcId}:cogcalc`, name: 'Rotta GPS', unit: '°', role: 'cog', src: srcId, srcName, t: Float64Array.from(keep, i => t[i]), v: Float64Array.from(keep, i => Cm[i]), derived: true }));
  return out;
}

/* Angolo al vento e VMG quando è nota la direzione del vento */
function deriveWind(hdgCh, sogCh, twd) {
  if (!hdgCh || !isFinite(twd)) return [];
  const t = hdgCh.t, twa = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) twa[i] = angDiff(hdgCh.v[i], twd);
  const out = [makeChannel({ id: 'calc:twa', name: 'Angolo al vento (TWA)', unit: '°', role: 'twa', src: 'calc', srcName: 'Calcolati', t, v: twa, dec: 0, derived: true })];
  if (sogCh) {
    const vmg = new Float64Array(t.length);
    for (let i = 0; i < t.length; i++) vmg[i] = interp(sogCh, t[i]) * Math.cos(twa[i] * Math.PI / 180);
    const keep = [...vmg.keys()].filter(i => isFinite(vmg[i]));
    out.push(makeChannel({ id: 'calc:vmg', name: 'VMG', unit: 'kn', role: 'other', src: 'calc', srcName: 'Calcolati', t: Float64Array.from(keep, i => t[i]), v: Float64Array.from(keep, i => vmg[i]), dec: 1, derived: true }));
  }
  return out;
}

/* ---------- Riconoscimento delle manovre ---------- */
// Cerca i cambi di rotta rapidi (più di 55° in 12 s) con la barca in movimento.
function detectManeuvers(cog, sog, twd) {
  if (!cog || cog.t.length < 30) return [];
  const t0 = cog.t[0], t1 = cog.t[cog.t.length - 1], step = 1000;
  const n = Math.floor((t1 - t0) / step);
  const H = resample(cog, t0, step, n), S = sog ? resample(sog, t0, step, n) : null;
  const W = 6, turn = new Float64Array(n).fill(NaN);
  for (let k = W; k < n - W; k++) {
    if (isFinite(H[k - W]) && isFinite(H[k + W])) turn[k] = angDiff(H[k + W], H[k - W]);
  }
  const found = [];
  let k = W;
  while (k < n - W) {
    if (Math.abs(turn[k]) > 55) {
      let best = k, j = k;
      while (j < n - W && Math.abs(turn[j]) > 40) { if (Math.abs(turn[j]) > Math.abs(turn[best])) best = j; j++; }
      const before = avgAng(H, best - 20, best - 8), after = avgAng(H, best + 8, best + 20);
      const sIn = S ? avgArr(S, best - 15, best - 5) : NaN;
      if (isFinite(before) && isFinite(after) && Math.abs(angDiff(after, before)) > 50 && (!S || sIn > 3)) {
        let type = 'manovra';
        if (isFinite(twd)) {
          const a = Math.abs(angDiff(before, twd)), b = Math.abs(angDiff(after, twd));
          type = a < 90 && b < 90 ? 'virata' : a > 90 && b > 90 ? 'strambata' : 'manovra';
        }
        found.push({ t: t0 + best * step, type, from: before, to: after });
      }
      k = Math.max(j, best + 20);
    } else k++;
  }
  return found;
}
function avgArr(A, a, b) { let s = 0, n = 0; for (let i = Math.max(0, a); i <= Math.min(A.length - 1, b); i++) if (isFinite(A[i])) { s += A[i]; n++; } return n ? s / n : NaN; }
function avgAng(A, a, b) { let x = 0, y = 0, n = 0; for (let i = Math.max(0, a); i <= Math.min(A.length - 1, b); i++) if (isFinite(A[i])) { x += Math.cos(A[i] * Math.PI / 180); y += Math.sin(A[i] * Math.PI / 180); n++; } return n ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : NaN; }

/* Misure di una manovra: velocità d'ingresso, minima, d'uscita e metri persi */
function maneuverMetrics(sog, t) {
  if (!sog) return null;
  const sIn = stats(sog, t - 15000, t - 5000).mean;
  const sMin = stats(sog, t - 5000, t + 10000).min;
  const sOut = stats(sog, t + 10000, t + 20000).mean;
  if (!isFinite(sIn)) return null;
  let lost = 0, rec = NaN;
  for (let x = t - 5000; x <= t + 20000; x += 500) {
    const v = interp(sog, x);
    if (isFinite(v)) lost += Math.max(0, sIn - v) / KN * 0.5;
    if (!isFinite(rec) && x > t && v >= sIn * 0.9) rec = (x - t) / 1000;
  }
  return { sIn, sMin, sOut, lost, rec };
}

/* Trova lo spostamento (ms) da aggiungere alla traccia B perché si sovrapponga alla traccia A.
   Serve ad allineare orologi diversi (es. telefono del Cyclops e Vakaros) confrontando le posizioni. */
function alignTracks(aLat, aLon, bLat, bLon) {
  const R = 6371008.8, rad = Math.PI / 180;
  const n = bLat.t.length;
  const step = Math.max(1, Math.floor(n / 400));
  const P = [];
  for (let i = 0; i < n; i += step) { const lo = interp(bLon, bLat.t[i]); if (isFinite(lo)) P.push([bLat.t[i], bLat.v[i], lo]); }
  if (P.length < 10) return { ok: false, why: 'La traccia da allineare ha troppo pochi punti.' };
  const kx = Math.cos(P[0][1] * rad) * rad * R, ky = rad * R;
  const need = Math.max(8, Math.floor(P.length * 0.25));
  const score = off => {
    const d = [];
    for (const p of P) {
      const la = interp(aLat, p[0] + off), lo = interp(aLon, p[0] + off);
      if (!isFinite(la) || !isFinite(lo)) continue;
      const dy = (la - p[1]) * ky, dx = (lo - p[2]) * kx; d.push(dx * dx + dy * dy);
    }
    if (d.length < need) return Infinity;
    d.sort((x, y) => x - y);
    return Math.sqrt(d[d.length >> 1]);
  };
  const LIM = 26 * 3600e3;
  const lo = Math.max(-LIM, aLat.t[0] - bLat.t[n - 1]), hi = Math.min(LIM, aLat.t[aLat.t.length - 1] - bLat.t[0]);
  if (lo > hi) return { ok: false, why: 'Le due tracce sono di giorni diversi.' };
  let best = 0, bs = Infinity;
  const scan = (a, b, st) => { for (let o = a; o <= b; o += st) { const s = score(o); if (s < bs) { bs = s; best = o; } } };
  const st = Math.max(1000, Math.ceil((hi - lo) / 3000));
  scan(lo, hi, st);
  if (!isFinite(bs)) return { ok: false, why: 'Le due tracce non si sovrappongono abbastanza.' };
  const c1 = best; scan(c1 - 2 * st, c1 + 2 * st, 1000);
  const c2 = best; scan(c2 - 1500, c2 + 1500, 100);
  if (bs > 30) return { ok: false, why: `Le due tracce non coincidono (distanza mediana ${Math.round(bs)} m).` };
  return { ok: true, off: Math.round(best / 100) * 100, dist: bs };
}
