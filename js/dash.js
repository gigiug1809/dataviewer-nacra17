/* Dashboard del Live.
   - Si creano e si modificano dal computer o dall'iPad.
   - Ogni dashboard ha due disposizioni: orizzontale (land) e verticale (port), scelte da sole secondo come tieni l'iPad.
   - Si salvano nel dispositivo e sul server del Live, con la barca (messaggio trattenuto su n17dv/<codice>/dash):
     così quella fatta sul Mac compare anche sull'iPad che apre la stessa barca.
   Quando due dispositivi modificano la stessa dashboard vince la modifica più recente. */
'use strict';
const DASH_LS = 'liveDashes';
const DASH_RATIO = { land: 1180 / 740, port: 820 / 1100 }; // schermo dell'iPad senza le barre del browser
const DASH_STD = 'std';

const Dash = {
  listeners: new Set(),
  all() { return LS.get(DASH_LS, []); },
  list() { this.ensureStd(); return this.all().filter(d => !d.deleted).sort((a, b) => (a.created || 0) - (b.created || 0)); },
  get(id) { if (id === DASH_STD) this.ensureStd(); return this.all().find(d => d.id === id && !d.deleted) || null; },
  write(items) {
    const old = Date.now() - 60 * 86400e3; // le dashboard eliminate si ricordano 60 giorni, poi spariscono
    LS.set(DASH_LS, items.filter(d => !d.deleted || d.updated > old));
    for (const f of this.listeners) { try { f(); } catch (e) { console.error(e); } }
  },
  /* la dashboard standard ha sempre lo stesso identificativo su tutti i dispositivi: niente doppioni */
  ensureStd() {
    const items = LS.get(DASH_LS, []);
    if (items.some(d => d.id === DASH_STD)) return;
    const old = LS.get('liveLayout', null); // layout del live modificato con la versione precedente
    if (old) for (const p of old) if (p.cfg && p.cfg.title === 'Sbandamento e trim') p.cfg.title = 'Heel e trim';
    items.push({ id: DASH_STD, name: 'Grafici live', created: 0, updated: 0, land: old && old.length ? old : liveLayout(), port: null });
    LS.set(DASH_LS, items);
  },
  save(d) {
    d.updated = Date.now();
    const items = this.all().filter(x => x.id !== d.id);
    items.push(JSON.parse(JSON.stringify(d)));
    this.write(items);
    this.publishSoon();
    return d;
  },
  create(name, land, port = null) { return this.save({ id: uid('d'), name, created: Date.now(), land, port }); },
  remove(id) {
    const items = this.all(), d = items.find(x => x.id === id);
    if (!d) return;
    Object.assign(d, { deleted: true, updated: Date.now(), land: null, port: null });
    this.write(items); this.publishSoon();
  },
  /* disposizione per un orientamento: se quella verticale non c'è ancora, la ricavo da quella orizzontale */
  layout(d, orient) {
    const l = orient === 'port' ? (d.port && d.port.length ? d.port : portraitFrom(d.land || [])) : (d.land || []);
    return JSON.parse(JSON.stringify(l));
  },

  /* ---------- sincronizzazione con il server ---------- */
  links: new Set(), dirty: false,
  topic(code) { return `n17dv/${code}/dash`; },
  attach(client, code) {
    const link = { client, code };
    this.links.add(link);
    client.subscribe(this.topic(code), (t, p) => this.merge(p, link));
    const prev = client.onstate;
    client.onstate = (s, d) => { prev && prev(s, d); if (s === 'connected' && this.dirty) this.publishSoon(); };
    return () => this.links.delete(link);
  },
  merge(payload, link) {
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
    if (!msg || msg.v !== 1 || !Array.isArray(msg.items)) return;
    link.seen = true;
    const items = this.all(), byId = new Map(items.map(d => [d.id, d]));
    let changed = false, newer = false;
    for (const r of msg.items) {
      const l = byId.get(r.id);
      if (!l || (r.updated || 0) > (l.updated || 0)) { byId.set(r.id, r); changed = true; }
    }
    const remote = new Map(msg.items.map(r => [r.id, r]));
    for (const l of byId.values()) { if (!this.shareable(l)) continue; const r = remote.get(l.id); if (!r || (l.updated || 0) > (r.updated || 0)) newer = true; }
    if (changed) this.write([...byId.values()]);
    if (newer) this.publishSoon(); // qui c'è qualcosa che il server non ha ancora
  },
  shareable(d) { return !(d.id === DASH_STD && !d.updated); }, // la standard mai toccata non serve mandarla
  publishSoon: debounce(function () { Dash.publish(); }, 1200),
  publish() {
    this.ensureStd();
    const items = this.all().filter(d => this.shareable(d));
    const body = JSON.stringify({ v: 1, items });
    let sent = false;
    for (const l of this.links) if (l.client.publish(this.topic(l.code), body, true)) sent = true;
    this.dirty = !sent;
  },

  /* copia di sicurezza in un file, da riaprire su un altro dispositivo */
  exportFile() { downloadText(`dashboard N17 Live ${ymdOf(Date.now())}.json`, JSON.stringify({ v: 1, items: this.list() }, null, 1), 'application/json'); },
  importFile(file) {
    return file.text().then(txt => {
      const msg = JSON.parse(txt);
      if (!msg || !Array.isArray(msg.items)) throw new Error('Non è un file di dashboard.');
      const items = this.all(), byId = new Map(items.map(d => [d.id, d]));
      let n = 0;
      for (const r of msg.items) { if (r.deleted) continue; r.updated = Date.now(); byId.set(r.id, r); n++; }
      this.write([...byId.values()]); this.publishSoon();
      return n;
    });
  }
};

/* disposizione verticale ricavata da quella orizzontale: i pannelli piccoli due per riga, quelli grandi a tutta larghezza */
function portraitFrom(land) {
  const ps = (land || []).slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const place = scale => {
    const out = []; let y = 0, col = 0, rowH = 0;
    for (const p of ps) {
      const wide = p.w >= 12 || ['map', 'chart', 'averages', 'events'].includes(p.type);
      const hh = Math.max(3, Math.round(clamp(Math.round(p.h * 0.8), 4, 12) * scale));
      const cp = { type: p.type, cfg: JSON.parse(JSON.stringify(p.cfg || {})) };
      if (wide) { if (col) { out[out.length - 1].w = 24; y += rowH; col = 0; rowH = 0; } out.push(Object.assign(cp, { x: 0, y, w: 24, h: hh })); y += hh; } // un pannello piccolo rimasto solo: tutta la riga
      else { out.push(Object.assign(cp, { x: col * 12, y, w: 12, h: hh })); rowH = Math.max(rowH, hh); if (++col === 2) { y += rowH; col = 0; rowH = 0; } }
    }
    if (col) out[out.length - 1].w = 24;
    return { out, rows: y + (col ? rowH : 0) };
  };
  let r = place(1);
  if (r.rows > ROWS) r = place(ROWS / r.rows); // provo a farla stare in uno schermo
  return r.out;
}

/* disegnino della disposizione, per scegliere la dashboard */
function dashPreview(layout, orient) {
  const W = 24, H = ROWS; // la forma (orizzontale o verticale) la dà il CSS
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'dash-prev ' + orient);
  const fill = { numbers: 'var(--accent)', bar: 'var(--accent)', chart: 'var(--muted)', map: 'var(--good)', averages: 'var(--faint)', events: 'var(--faint)', stats: 'var(--faint)' };
  for (const p of layout || []) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', p.x + 0.25); r.setAttribute('y', p.y + 0.25);
    r.setAttribute('width', Math.max(0.5, p.w - 0.5)); r.setAttribute('height', Math.max(0.5, Math.min(p.h, H - p.y) - 0.5));
    r.setAttribute('rx', 0.6); r.setAttribute('fill', fill[p.type] || 'var(--line-2)'); r.setAttribute('opacity', p.type === 'numbers' || p.type === 'bar' ? 0.75 : 0.45);
    svg.append(r);
  }
  return svg;
}

/* Barche: codice fisso (di solito il numero velico), uguale a quello scritto nel telefono */
const Boats = {
  list() {
    let b = LS.get('liveBoats', null);
    if (!b) {
      // prima volta: il telefono ora trasmette con il codice fisso ITA98 (il vecchio codice casuale non serve più)
      b = [{ code: 'ITA98' }];
      LS.set('liveBoats', b); LS.set('liveCode', 'ITA98');
    }
    return b;
  },
  add(code) { const b = this.list(); if (!b.some(x => x.code === code)) b.push({ code }); LS.set('liveBoats', b); },
  remove(code) { LS.set('liveBoats', this.list().filter(x => x.code !== code)); if (LS.get('liveCode') === code) LS.set('liveCode', (this.list()[0] || {}).code || ''); },
  current() { const b = this.list(), c = LS.get('liveCode', ''); return b.some(x => x.code === c) ? c : (b[0] || {}).code || ''; },
  clean(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
};

/* Dati simulati: per comporre una dashboard quando la barca non è in acqua.
   Bolina con una virata ogni 50 secondi, onda, raffiche. */
class LiveSim {
  constructor(S) { this.S = S; this.t0 = Date.now(); this.seq = 0; this.lat = 39.19; this.lon = 9.17; this.last = Date.now(); this.lastG = 0; }
  start() { this.iv = setInterval(() => this.step(), 200); this.step(); }
  stop() { clearInterval(this.iv); }
  state(t) {
    const s = Math.max(0, (t - this.t0) / 1000), P = 50, k = Math.floor(s / P), ph = s - k * P, side = k % 2 ? 1 : -1, TWD = 300;
    const want = TWD + side * 45, prev = TWD - side * 45;
    const a = clamp(ph / 6, 0, 1), sm = a * a * (3 - 2 * a);
    const turning = k > 0 && ph < 6;
    const hdg = ((turning ? prev + angDiff(want, prev) * sm : want) + Math.sin(s / 3.1) * 2 + 360) % 360;
    const drop = k > 0 ? 6 * Math.exp(-Math.pow((ph - 5) / 4, 2)) : 0;
    const gust = Math.sin(s / 23) * 1.2 + Math.sin(s / 7.3) * 0.4;
    const sog = 12.6 + gust - drop;
    const heel = (turning ? -side + 2 * side * sm : side) * (8 + gust * 1.5) + Math.sin(s / 2.2) * 1.4;
    const pitch = 1.3 + Math.sin(s / 1.7) * 0.9 + drop * 0.25;
    return { hdg, sog, heel, pitch };
  }
  step() {
    const now = Date.now(), m = [], g = [];
    for (let t = this.last + 80; t <= now; t += 80) {
      const st = this.state(t), yaw = angDiff(st.hdg, this.state(t - 100).hdg) / 0.1; // velocità di rotazione, °/s
      m.push([t - this.last, +st.heel.toFixed(1), +st.pitch.toFixed(1), Math.round(st.hdg), +yaw.toFixed(1), 0, 0.02, 0.01, 0.15]);
      if (t - this.lastG >= 1000) {
        const dt = this.lastG ? (t - this.lastG) / 1000 : 1, ms = st.sog / KN, R = 6371008.8, rad = Math.PI / 180;
        this.lat += ms * dt * Math.cos(st.hdg * rad) / R / rad;
        this.lon += ms * dt * Math.sin(st.hdg * rad) / (R * Math.cos(this.lat * rad)) / rad;
        g.push([t - this.last, +this.lat.toFixed(7), +this.lon.toFixed(7), +st.sog.toFixed(2), Math.round(st.hdg), 4]);
        this.lastG = t;
      }
    }
    const base = this.last;
    this.last = m.length ? base + m[m.length - 1][0] : base;
    if (!m.length && !g.length) return;
    this.S.ingest(new TextEncoder().encode(JSON.stringify({ v: 1, r: 'SIMULATA', s: this.seq++, b: base, m, g })));
    this.S.status = { online: true, rec: true, bat: 0.86, rx: Date.now() };
  }
}
