/* Un'uscita caricata: canali di dati, camere con i loro spezzoni video, eventi */
'use strict';

const EVENT_TYPES = [
  { id: 'virata', label: 'Virata', key: 't', slot: 0 },
  { id: 'strambata', label: 'Strambata', key: 'g', slot: 1 },
  { id: 'partenza', label: 'Partenza', key: 'p', slot: 2 },
  { id: 'boa', label: 'Boa', key: 'b', slot: 3 },
  { id: 'errore', label: 'Errore', key: 'e', slot: 4 },
  { id: 'nota', label: 'Nota', key: 'n', slot: 5 },
  { id: 'regolazione', label: 'Regolazione', key: 'r', slot: -1 },
  { id: 'tratto', label: 'Tratto', key: '', slot: 6 },
  { id: 'scuffia', label: 'Scuffia / nosedive', key: 'c', slot: 7 },
  { id: 'manovra', label: 'Manovra', key: 'm', slot: -1 }
];
const EVT = Object.fromEntries(EVENT_TYPES.map(e => [e.id, e]));
const PALETTE = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
};
const SEQ_BLUE = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
function theme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function seriesColor(i) { const p = PALETTE[theme()]; return p[i % p.length]; }
function eventColor(type) { const e = EVT[type]; return !e || e.slot < 0 ? (theme() === 'light' ? '#7a7a74' : '#a3a29a') : seriesColor(e.slot); }

const SRC_PRIORITY = { Vakaros: 0, iPhone: 0, FIT: 1, GPX: 1, TCX: 1, CSV: 2, GoPro: 3, Cyclops: 4 };

class Session {
  constructor(folder, meta) {
    this.folder = folder; this.meta = meta;
    this.channels = []; this.byId = new Map(); this.urls = new Map(); this.files = new Map();
    this.loadErrors = [];
    this.saveState = 'saved';
    this.onSave = null;
    this._save = debounce(() => this.saveNow(), 700);
  }
  path(rel) { return `${this.folder}/${rel}`; }
  save() { this.saveState = 'pending'; this.onSave && this.onSave(this.saveState); this._save(); }
  async saveNow() {
    try { await Store.saveSession(this.folder, this.meta); this.saveState = 'saved'; }
    catch (e) { this.saveState = 'error'; toast('Salvataggio non riuscito: ' + errMsg(e), 8000, 'bad'); }
    this.onSave && this.onSave(this.saveState);
  }

  async load(progress = () => {}) {
    this.channels = []; this.loadErrors = [];
    const m = this.meta;
    let i = 0;
    for (const src of m.sources) {
      progress(`Leggo ${src.file.split('/').pop()}…`, i++ / (m.sources.length + m.cameras.length + 1));
      try { this.channels.push(...await this.loadSource(src)); }
      catch (e) { this.loadErrors.push(`${src.file}: ${errMsg(e)}`); }
    }
    for (const cam of m.cameras) {
      progress(`Telemetria ${cam.name}…`, i++ / (m.sources.length + m.cameras.length + 1));
      try { this.channels.push(...await this.loadCamTelemetry(cam)); }
      catch (e) { this.loadErrors.push(`${cam.name}: ${errMsg(e)}`); }
    }
    this.derive();
    progress('Pronto', 1);
  }

  async loadSource(src) {
    if (TRACK_KINDS.includes(src.kind)) {
      const f = await Store.file(this.path(src.file));
      const track = readTrack(src.kind, src.kind === 'FIT' ? await f.arrayBuffer() : await f.text());
      if (!src.columns) src.columns = guessTrackConfig(track, src.kind).columns;
      return buildTrackChannels(track, src, src.id, src.name);
    }
    const text = await Store.readText(this.path(src.file));
    const tab = parseTable(text), cols = analyzeCols(tab);
    return buildChannels(tab, cols, Object.assign({ baseDate: this.meta.date }, src), src.id, src.name);
  }

  /* Telemetria GoPro (assetto della camera, accelerazioni, GPS), con cache su disco */
  async readTelemetry(clip) {
    const cachePath = this.path(`cache/${clip.file.split('/').pop()}.telemetria.json`);
    const file = await this.videoFile(clip);
    const cached = await Store.readJSON(cachePath);
    if (cached && cached.size === file.size && cached.v === 3) return cached;
    const r = MP4.fileReader(file);
    const info = await MP4.probe(r);
    const tel = await MP4.goproTelemetry(r, info);
    if (!tel) return null;
    const rd = (x, d) => Math.round(x * d) / d;
    const out = {
      v: 3, size: file.size, device: tel.device, start: tel.start,
      yaw: tel.yaw.map(a => [rd(a[0], 1000), rd(a[1], 10)]),
      att: tel.att.map(a => [rd(a[0], 1000), rd(a[1], 100), rd(a[2], 100)]),
      acc: tel.acc.map(a => [rd(a[0], 1000), rd(a[1], 100)]),
      pts: tel.pts.map(p => [rd(p.vt, 1000), rd(p.lat, 1e7), rd(p.lon, 1e7), rd(p.sog, 100)])
    };
    try { await Store.writeJSON(cachePath, out); } catch (e) { /* la cache è facoltativa */ }
    return out;
  }
  async loadCamTelemetry(cam) {
    if (cam.telemetry === false) return [];
    const att = [], acc = [], pts = [], yaw = [];
    for (const clip of cam.clips) {
      if (!/gopro|hero/i.test(clip.device || '') && !clip.gpmd) continue;
      let tel = null;
      try { tel = await this.readTelemetry(clip); } catch (e) { continue; }
      if (!tel) continue;
      const s = this.clipStart(cam, clip);
      for (const a of tel.att) att.push([s + a[0] * 1000, a[1], a[2]]);
      for (const a of tel.acc) acc.push([s + a[0] * 1000, a[1]]);
      for (const a of tel.yaw || []) yaw.push([s + a[0] * 1000, a[1]]);
      for (const p of tel.pts) pts.push([s + p[0] * 1000, p[1], p[2], p[3]]);
    }
    const out = [], id = cam.id, srcName = `Camera ${cam.name}`;
    const med = arr => { const v = arr.slice().sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };
    if (att.length > 10) {
      att.sort((a, b) => a[0] - b[0]);
      const T = Float64Array.from(att, a => a[0]);
      const hz = cam.heelZero != null && cam.heelZero !== '' ? Number(cam.heelZero) : med(att.filter((_, i) => i % 5 === 0).map(a => a[1]));
      const pz = cam.pitchZero != null && cam.pitchZero !== '' ? Number(cam.pitchZero) : med(att.filter((_, i) => i % 5 === 0).map(a => a[2]));
      cam._autoZero = { heel: hz, pitch: pz };
      const sh = cam.heelInv ? -1 : 1, sp = cam.pitchInv ? -1 : 1;
      out.push(makeChannel({ id: `${id}:heel`, name: `Heel (${cam.name})`, unit: '°', role: 'heel', src: id, srcName, t: T, v: Float64Array.from(att, a => sh * (a[1] - hz)), dec: 1 }));
      out.push(makeChannel({ id: `${id}:pitch`, name: `Trim (${cam.name})`, unit: '°', role: 'pitch', src: id, srcName, t: T, v: Float64Array.from(att, a => sp * (a[2] - pz)), dec: 1 }));
    }
    if (acc.length > 10) {
      acc.sort((a, b) => a[0] - b[0]);
      out.push(makeChannel({ id: `${id}:acc`, name: `Accelerazione picco (${cam.name})`, unit: 'g', role: 'other', src: id, srcName, t: Float64Array.from(acc, a => a[0]), v: Float64Array.from(acc, a => a[1]), dec: 2 }));
    }
    if (yaw.length > 10) {
      yaw.sort((a, b) => a[0] - b[0]);
      out.push(makeChannel({ id: `${id}:yaw`, name: `Velocità di rotazione (${cam.name})`, unit: '°/s', role: 'other', src: id, srcName, t: Float64Array.from(yaw, a => a[0]), v: Float64Array.from(yaw, a => a[1]), dec: 0 }));
    }
    if (pts.length > 10) {
      pts.sort((a, b) => a[0] - b[0]);
      const T = Float64Array.from(pts, p => p[0]);
      out.push(makeChannel({ id: `${id}:lat`, name: 'Latitudine', unit: '°', role: 'lat', src: id, srcName, t: T, v: Float64Array.from(pts, p => p[1]) }));
      out.push(makeChannel({ id: `${id}:lon`, name: 'Longitudine', unit: '°', role: 'lon', src: id, srcName, t: T, v: Float64Array.from(pts, p => p[2]) }));
      out.push(makeChannel({ id: `${id}:sog`, name: `Velocità GPS (${cam.name})`, unit: 'kn', role: 'sog', src: id, srcName, t: T, v: Float64Array.from(pts, p => p[3] * KN), dec: 1 }));
    }
    out.forEach(c => { c.srcKind = 'GoPro'; });
    return out;
  }

  /* Canali calcolati: velocità e rotta dalla posizione, TWA e VMG */
  derive() {
    this.channels = this.channels.filter(c => !c.derived);
    const kindOf = c => c.srcKind || (this.meta.sources.find(s => s.id === c.src) || {}).kind || 'CSV';
    const bySrc = new Map();
    for (const c of this.channels) { if (!bySrc.has(c.src)) bySrc.set(c.src, []); bySrc.get(c.src).push(c); }
    const posSrcs = [...bySrc.entries()].filter(([, l]) => l.some(c => c.role === 'lat') && l.some(c => c.role === 'lon'))
      .sort((a, b) => (SRC_PRIORITY[kindOf(a[1][0])] ?? 2) - (SRC_PRIORITY[kindOf(b[1][0])] ?? 2));
    const chosen = posSrcs.find(([s]) => s === this.meta.posSource) || posSrcs[0];
    this.pos = null;
    if (chosen) {
      const [sid, list] = chosen;
      const lat = list.find(c => c.role === 'lat'), lon = list.find(c => c.role === 'lon');
      this.pos = { src: sid, lat, lon, name: lat.srcName };
      const d = deriveFromTrack(lat, lon, sid, lat.srcName);
      for (const c of d) if (!list.some(x => x.role === c.role && !x.derived)) this.channels.push(c);
    }
    this.index();
    const sogs = this.channels.filter(c => c.role === 'sog');
    this.sog = this.byId.get(this.meta.mainSog) || (this.pos && sogs.find(c => c.src === this.pos.src)) || sogs[0] || null;
    const cogs = this.channels.filter(c => c.role === 'cog'), hdgs = this.channels.filter(c => c.role === 'hdg');
    this.cog = (this.pos && cogs.find(c => c.src === this.pos.src)) || cogs[0] || hdgs[0] || null;
    const twd = parseFloat(this.meta.twd);
    this.channels.push(...deriveWind(this.cog, this.sog, twd));
    this.index();
    this.range();
  }
  index() { this.byId = new Map(this.channels.map(c => [c.id, c])); }
  ch(id) { return this.byId.get(id) || null; }
  range() {
    let a = Infinity, b = -Infinity;
    for (const c of this.channels) { if (c.role === 'lat' || c.role === 'lon') continue; a = Math.min(a, c.t[0]); b = Math.max(b, c.t[c.t.length - 1]); }
    for (const cam of this.meta.cameras) for (const cl of cam.clips) { const s = this.clipStart(cam, cl); a = Math.min(a, s); b = Math.max(b, s + cl.duration * 1000); }
    if (!isFinite(a)) { a = new Date(this.meta.date + 'T10:00:00').getTime(); b = a + 3600e3; }
    this.t0 = a; this.t1 = b;
  }
  roleChannels(role) { return this.channels.filter(c => c.role === role); }

  /* ---------- Video ---------- */
  clipStart(cam, clip) { return clip.start + (Number(cam.offset) || 0); }
  clipAt(cam, t) {
    for (const cl of cam.clips) { const s = this.clipStart(cam, cl); if (t >= s && t < s + cl.duration * 1000) return cl; }
    return null;
  }
  nextClip(cam, t) {
    let best = null, bs = Infinity;
    for (const cl of cam.clips) { const s = this.clipStart(cam, cl); if (s > t && s < bs) { bs = s; best = cl; } }
    return best;
  }
  async videoFile(clip) {
    if (this.files.has(clip.file)) return this.files.get(clip.file);
    const f = await Store.file(this.path(clip.file));
    this.files.set(clip.file, f);
    return f;
  }
  async videoURL(clip) {
    if (this.urls.has(clip.file)) return this.urls.get(clip.file);
    const url = URL.createObjectURL(await this.videoFile(clip));
    this.urls.set(clip.file, url);
    return url;
  }
  dispose() { for (const u of this.urls.values()) URL.revokeObjectURL(u); this.urls.clear(); this.files.clear(); }

  /* ---------- Eventi ---------- */
  addEvent(ev) {
    const e = Object.assign({ id: uid('e'), note: '' }, ev);
    this.meta.events.push(e);
    this.meta.events.sort((a, b) => a.t - b.t);
    this.save();
    return e;
  }
  removeEvent(id) { this.meta.events = this.meta.events.filter(e => e.id !== id); this.save(); }
}

/* Prepara un clip a partire da un file video: durata, risoluzione, ora d'inizio */
async function probeClip(file) {
  const r = MP4.fileReader(file);
  const info = await MP4.probe(r);
  let device = '', gpsStart = null;
  if (info.gpmd) {
    try {
      // basta leggere i primi blocchi per sapere che camera è e se il GPS ha un fix
      const first = MP4.parsePayload(await r.read(info.gpmd.offsets[0], info.gpmd.sizes[0]));
      device = first.device;
    } catch (e) { /* telemetria illeggibile */ }
    try {
      const tel = await MP4.goproTelemetry(r, { gpmd: Object.assign({}, info.gpmd, { n: Math.min(info.gpmd.n, 120) }) });
      if (tel && tel.start) gpsStart = tel.start;
      if (tel && tel.device) device = tel.device;
    } catch (e) { /* nessun GPS */ }
  }
  const m = /^G([HXLP])(\d\d)(\d{4})\./i.exec(file.name);
  const clip = {
    file: file.name, size: file.size, duration: info.duration, w: info.width, h: info.height, fps: Math.round(info.fps * 100) / 100,
    codec: info.codec, created: info.created, device: device || info.model || '', gpmd: !!info.gpmd, samsung: !!info.samsung,
    appleStart: info.appleStart || null, gpsStart, mtime: file.lastModified,
    gopro: m ? { chapter: +m[2], number: m[3] } : null
  };
  Object.assign(clip, clipStartFromMeta(clip));
  return clip;
}

/* Ora d'inizio di un video dai suoi metadati.
   - GoPro con GPS: ora del satellite (esatta)
   - iPhone: com.apple.quicktime.creationdate (inizio, con fuso orario)
   - telefoni Android (Samsung, Xiaomi…): nel file c'è l'ora della FINE; il nome del file dice l'ora d'inizio
   - GoPro senza GPS e altre camere: ora registrata nel file (inizio) */
function nameTime(name) {
  const m = /(?:^|[^\d])(20\d\d)(\d\d)(\d\d)[_\-T ]?(\d\d)(\d\d)(\d\d)(\d{0,3})/.exec(name);
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  // i telefoni Pixel scrivono il nome in UTC, tutti gli altri in ora locale
  return /^PXL_/i.test(name) ? Date.UTC(y, mo - 1, d, hh, mi, ss, ms) : new Date(y, mo - 1, d, hh, mi, ss, ms).getTime();
}
function clipStartFromMeta(c) {
  const dur = (c.duration || 0) * 1000, nt = c.gopro ? null : nameTime(c.file.split('/').pop());
  if (c.gpsStart) return { start: c.gpsStart, startSrc: 'gps' };
  if (c.appleStart) return { start: c.appleStart, startSrc: 'apple' };
  if (c.created) {
    const end = c.created - dur;
    if (nt != null) {
      // il nome dice il secondo in cui è partita la registrazione (troncato: aggiungo mezzo secondo);
      // l'ora di fine scritta nel file arriva 1-3 s dopo lo stop, quindi il nome è più preciso
      if (Math.abs(end - nt) <= 4000) return { start: nt + 500, startSrc: 'filename' };
      if (Math.abs(c.created - nt) <= 3000) return { start: c.created, startSrc: 'mvhd' };
      return { start: nt, startSrc: 'filename' };
    }
    if (c.samsung) return { start: end, startSrc: 'mvhd-end' };
    return { start: c.created, startSrc: 'mvhd' };
  }
  if (nt != null) return { start: nt, startSrc: 'filename' };
  return { start: (c.mtime || Date.now()) - dur, startSrc: 'mtime' };
}
/* I capitoli GoPro (GX02…, GX03…) riportano l'ora del primo: li metto in fila */
function chainChapters(clips) {
  const groups = new Map();
  for (const c of clips) if (c.gopro) { const k = c.gopro.number; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  for (const list of groups.values()) {
    list.sort((a, b) => a.gopro.chapter - b.gopro.chapter);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], c = list[i];
      if (c.startSrc === 'gps' || c.startSrc === 'manual') continue;
      if (c.gopro.chapter === prev.gopro.chapter + 1) { c.start = prev.start + prev.duration * 1000; c.startSrc = 'chain'; }
    }
  }
  clips.sort((a, b) => a.start - b.start);
}
const START_SRC_LABEL = { gps: 'GPS della GoPro (esatta)', apple: 'metadati iPhone', 'mvhd-end': 'fine registrazione meno la durata', filename: 'nome del file', mvhd: 'ora registrata nel file', mtime: 'data di modifica del file', chain: 'segue il capitolo precedente', manual: 'impostata a mano' };

/* ---------- Copertura: dove ci sono video, dove ci sono dati, dove ci sono entrambi ---------- */
function mergeSpans(list, gap = 0) {
  const s = list.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]), out = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1] + gap) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
}
function intersectSpans(A, B) {
  const out = []; let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const a = Math.max(A[i][0], B[j][0]), b = Math.min(A[i][1], B[j][1]);
    if (b > a) out.push([a, b]);
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  return out;
}
function channelSpans(c, gap = 30000) {
  const out = []; let a = c.t[0], prev = c.t[0];
  for (let k = 1; k < c.t.length; k++) { if (c.t[k] - prev > gap) { out.push([a, prev]); a = c.t[k]; } prev = c.t[k]; }
  out.push([a, prev]);
  return out;
}
function coverage(S) {
  const cams = S.meta.cameras.map((cam, i) => ({ id: cam.id, name: cam.name, color: seriesColor(i), spans: mergeSpans(cam.clips.map(cl => { const s = S.clipStart(cam, cl); return [s, s + cl.duration * 1000]; }), 2000) }));
  const bySrc = new Map();
  for (const c of S.channels) {
    if (c.derived || c.src === 'calc') continue;
    if (S.meta.cameras.some(cam => cam.id === c.src)) continue; // la telemetria della camera c'è solo dove c'è il video
    if (!bySrc.has(c.src)) bySrc.set(c.src, { id: c.src, name: c.srcName, spans: [] });
    bySrc.get(c.src).spans.push(...channelSpans(c));
  }
  const data = [...bySrc.values()].map(d => Object.assign(d, { spans: mergeSpans(d.spans, 5000) }));
  const allVid = mergeSpans(cams.flatMap(c => c.spans)), allData = mergeSpans(data.flatMap(d => d.spans));
  const both = intersectSpans(allVid, allData).filter(x => x[1] - x[0] >= 5000);
  return { cams, data, both, allVid, allData };
}
