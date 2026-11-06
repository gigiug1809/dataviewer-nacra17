/* Dati live dal Registratore N17 per iPhone, via MQTT.
   Funziona anche senza cartella della libreria (per esempio su iPad, in Safari):
   i dati restano in memoria e alla fine si salvano come uscita o si scaricano in CSV. */
'use strict';
const LIVE_PUBLIC = 'wss://broker.hivemq.com:8884/mqtt';
// ordine dei valori nei pacchetti del telefono
const LIVE_M = ['heel_deg', 'pitch_deg', 'heading_deg', 'yaw_rate_dps', 'roll_rate_dps', 'acc_surge_g', 'acc_heave_g', 'acc_peak_g'];
const LIVE_G = ['lat', 'lon', 'gps_speed_kn', 'gps_course', 'gps_hacc_m'];

class LiveSession extends Session {
  constructor(code, server) {
    const saved = LS.get('live.' + code, {});
    if (LS.get('liveLayoutVer', 0) < 2) { LS.set('liveLayout', null); LS.set('liveLayoutVer', 2); }
    super(null, newSessionMeta({ title: `Live ${code}`, date: ymdOf(Date.now()), events: saved.events || [], layout: LS.get('liveLayout', null), view: { win: saved.win ?? 120000 } }));
    this.live = true; this.follow = true; this.code = code; this.server = server;
    this.cols = {}; for (const k of [...LIVE_M, ...LIVE_G]) this.cols[k] = { t: [], v: [] };
    this.seen = new Set(); this.sorted = true;
    this.status = null; this.lastRx = 0; this.lastSampleRx = 0; this.lastSampleT = 0; this.packets = 0;
    this.channelMap = new Map();
  }
  save() { LS.set('live.' + this.code, { events: this.meta.events, win: this.meta.view.win }); if (this.meta.layout) LS.set('liveLayout', this.meta.layout); this.onSave && this.onSave('saved'); }
  saveNow() { this.save(); }
  async load() { this.rebuild(); }

  connect() {
    const c = this.client = new MqttClient({ url: this.server.url || LIVE_PUBLIC, username: this.server.username, password: this.server.password });
    c.onstate = (s, d) => { this.conn = s; this.connDetail = d; this.onStatus && this.onStatus(); };
    c.subscribe(`n17dv/${this.code}/live`, (t, p) => this.ingest(p));
    c.subscribe(`n17dv/${this.code}/status`, (t, p) => { try { this.status = JSON.parse(new TextDecoder().decode(p)); this.status.rx = Date.now(); } catch (e) { /* messaggio non valido */ } this.onStatus && this.onStatus(); });
    c.connect();
  }
  ingest(payload) {
    let m;
    try { m = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }
    this.lastRx = Date.now();
    if (m.v !== 1 || this.seen.has(m.s)) return; // pacchetto già ricevuto (dopo una riconnessione)
    this.seen.add(m.s);
    this.packets++;
    const add = (key, t, v) => {
      if (v == null || !isFinite(v)) return;
      const c = this.cols[key];
      if (c.t.length && t < c.t[c.t.length - 1]) this.sorted = false;
      c.t.push(t); c.v.push(v);
    };
    for (const r of m.m || []) { const t = m.b + r[0]; LIVE_M.forEach((k, i) => add(k, t, r[i + 1])); this.lastSampleT = Math.max(this.lastSampleT, t); }
    for (const r of m.g || []) { const t = m.b + r[0]; LIVE_G.forEach((k, i) => add(k, t, r[i + 1])); this.lastSampleT = Math.max(this.lastSampleT, t); }
    this.lastSampleRx = Date.now();
    this.dirty = true;
  }
  /* trasformo i dati ricevuti in canali; aggiorno gli oggetti esistenti, così i pannelli restano collegati */
  rebuild() {
    if (!this.sorted) {
      for (const c of Object.values(this.cols)) {
        const idx = c.t.map((_, i) => i).sort((a, b) => c.t[a] - c.t[b]);
        c.t = idx.map(i => c.t[i]); c.v = idx.map(i => c.v[i]);
      }
      this.sorted = true;
    }
    for (const [key, c] of Object.entries(this.cols)) {
      if (c.t.length < 2) continue;
      const m = PHONE_COLS[key];
      const fresh = makeChannel({ id: `live:${key}`, name: m[0], unit: m[1], role: m[2], src: 'live', srcName: 'iPhone live', srcKind: 'iPhone', t: Float64Array.from(c.t), v: Float64Array.from(c.v) });
      const old = this.channelMap.get(key);
      if (old) Object.assign(old, fresh); else this.channelMap.set(key, fresh);
    }
    this.channels = [...this.channelMap.values()];
    this.derive();
    if (!this.channels.length) { this.t0 = Date.now() - 60000; this.t1 = Date.now(); }
    this.dirty = false;
  }
  hasData() { return this.channelMap.size > 0; }
  dispose() { if (this.client) this.client.close(); }

  /* CSV nello stesso formato del file del telefono: il Dataviewer lo rilegge come un'uscita normale */
  toCSV() {
    const cols = ['lat', 'lon', 'gps_speed_kn', 'gps_course', 'gps_hacc_m', 'heel_deg', 'pitch_deg', 'heading_deg', 'roll_rate_dps', 'yaw_rate_dps', 'acc_surge_g', 'acc_heave_g', 'acc_peak_g'];
    const rows = new Map();
    for (const k of cols) { const c = this.cols[k]; c.t.forEach((t, i) => { let r = rows.get(t); if (!r) { r = {}; rows.set(t, r); } r[k] = c.v[i]; }); }
    const lines = [`# Registratore N17 · ricevuto live dal Dataviewer · codice ${this.code}`, ['time_utc', ...cols].join(','), ['ISO8601', 'deg', 'deg', 'kn', 'deg', 'm', 'deg', 'deg', 'deg', 'deg/s', 'deg/s', 'g', 'g', 'g'].join(',')];
    for (const t of [...rows.keys()].sort((a, b) => a - b)) { const r = rows.get(t); lines.push([new Date(t).toISOString(), ...cols.map(k => r[k] ?? '')].join(',')); }
    return lines.join('\n');
  }
}

const Live = {
  /* pagina di collegamento */
  page() {
    const root = $('#view-home');
    root.textContent = '';
    const srv = LS.get('liveServer', { url: '', username: '', password: '' });
    const code = h('input', { type: 'text', value: LS.get('liveCode', ''), placeholder: 'es. K7Q2XM', maxlength: 8, style: { fontSize: '28px', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '.15em', width: '100%', textAlign: 'center', minHeight: '56px' }, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
    const url = h('input', { type: 'text', class: 'full', value: srv.url, placeholder: LIVE_PUBLIC });
    const user = h('input', { type: 'text', class: 'full', value: srv.username, placeholder: 'vuoto per il server pubblico', autocomplete: 'off' });
    const pass = h('input', { type: 'password', class: 'full', value: srv.password, autocomplete: 'off' });
    const go = () => {
      const c = code.value.trim().toUpperCase();
      if (c.length < 4) { toast('Scrivi il codice barca che vedi sul telefono.'); code.focus(); return; }
      LS.set('liveCode', c); LS.set('liveServer', { url: url.value.trim(), username: user.value.trim(), password: pass.value });
      Router.go('#/live/' + encodeURIComponent(c));
    };
    code.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    root.append(h('div', { class: 'page' },
      h('div', { class: 'topbar' }, h('button', { class: 'btn ghost', onclick: () => Router.go('#/') }, '← Libreria'), h('div', { class: 'brand' }, h('div', { class: 'brand-mark', html: ICON_BOAT }), h('h1', null, 'Live'))),
      h('div', { class: 'welcome', style: { marginTop: '4vh' } },
        h('div', { class: 'card', style: { display: 'grid', gap: '14px' } },
          h('h2', null, 'Guarda i dati della barca in tempo reale'),
          h('p', { class: 'muted' }, 'Sul telefono in barca, nell\'app Registratore N17, accendi "Trasmetti live" e avvia la registrazione. Poi scrivi qui il codice barca che compare sul telefono.'),
          h('label', { class: 'f' }, 'Codice barca', code),
          h('details', null, h('summary', null, 'Server (solo se ne usi uno tuo)'),
            h('div', { style: { display: 'grid', gap: '10px', marginTop: '10px' } }, h('label', { class: 'f' }, 'Indirizzo', url), h('label', { class: 'f' }, 'Utente', user), h('label', { class: 'f' }, 'Password', pass),
              h('p', { class: 'stat' }, 'Gli stessi dati che hai messo nel telefono in "Server e codice".'))),
          h('button', { class: 'btn primary', style: { minHeight: '48px', fontSize: '16px' }, onclick: go }, 'Collegati'),
          h('p', { class: 'stat' }, 'Funziona su computer, tablet e telefono, anche in Safari: per guardare il live non serve la cartella della libreria.')))));
    setTimeout(() => code.focus(), 50);
  },

  /* apertura del viewer in modalità live */
  async open(code) {
    Viewer.close();
    Viewer.open_ = true;
    const root = $('#view-viewer');
    root.textContent = '';
    const S = new LiveSession(code, LS.get('liveServer', {}));
    S.connect();
    const wait = h('div', { class: 'loading' }, h('div', null, h('b', null, `Live · ${code}`), h('span', { id: 'liveWait' }, 'Mi collego…'),
      h('button', { class: 'btn', onclick: () => { S.dispose(); Router.go('#/live'); } }, 'Annulla')));
    root.append(wait);
    S.onStatus = () => { const el = $('#liveWait'); if (el) el.textContent = S.conn === 'connected' ? (S.status ? (S.status.online === false ? 'Il telefono è offline. Aspetto che si ricolleghi…' : S.status.rec ? 'Telefono in registrazione: arrivano i dati…' : 'Telefono collegato ma non registra: avvia la registrazione.') : 'Collegato. Aspetto i dati del telefono (avvia la registrazione con "Trasmetti live" acceso)…') : S.conn === 'error' ? 'Errore: ' + (S.connDetail || '') : 'Mi collego al server…'; };
    // aspetto qualche secondo di dati, così il layout nasce con i canali giusti
    await new Promise(res => { const iv = setInterval(() => { if (!Viewer.open_ || Viewer._liveAbort) { clearInterval(iv); res(); return; } if (S.packets > 0) { const have = Object.values(S.cols).some(c => c.t.length > 1); if (have && (S.cols.heel_deg.t.length > 10 || Date.now() - S.firstPkt > 4000)) { clearInterval(iv); res(); } } if (S.packets && !S.firstPkt) S.firstPkt = Date.now(); }, 300); });
    if (!Viewer.open_ || location.hash !== '#/live/' + encodeURIComponent(code)) { S.dispose(); return; }
    S.rebuild();
    wait.remove();
    if (!S.meta.layout || !S.meta.layout.length) S.meta.layout = liveLayout(S);
    Viewer.start(S, root);
    this.bar(S);
    // ogni secondo: nuovi dati nei canali e nei grafici
    this.timer = setInterval(() => {
      if (!Viewer.open_ || Viewer.S !== S) { clearInterval(this.timer); return; }
      if (S.dirty) {
        S.rebuild();
        for (const r of Viewer.panels.values()) if (r.inst.refreshData) { try { r.inst.refreshData(); } catch (e) { console.error(e); } }
        Viewer.requestDraw();
      }
      this.renderBar(S);
    }, 1000);
  },
  bar(S) {
    const el = $('#liveBar');
    if (!el) return;
    S.onFollow = () => this.renderBar(S);
    S.onStatus = () => this.renderBar(S);
    this.renderBar(S);
  },
  renderBar(S) {
    const el = $('#liveBar');
    if (!el) return;
    const st = S.status || {};
    const lag = S.lastSampleRx ? (Date.now() - S.lastSampleT) / 1000 : NaN;
    const phoneOk = S.conn === 'connected' && st.online !== false && S.lastSampleRx && Date.now() - S.lastSampleRx < 5000;
    const txt = S.conn !== 'connected' ? 'server: ' + ({ connecting: 'mi collego…', reconnecting: 'riconnessione…', error: 'errore' }[S.conn] || S.conn)
      : st.online === false ? 'telefono offline' : !S.lastSampleRx ? 'in attesa dei dati' : Date.now() - S.lastSampleRx > 5000 ? `nessun dato da ${fmtDur(Date.now() - S.lastSampleRx)}` : `ritardo ${fmtNum(lag, 1)} s`;
    el.textContent = '';
    el.append(...[
      h('span', { class: 'chip', style: { background: phoneOk ? 'rgba(25,158,112,.18)' : 'rgba(201,133,0,.18)' } }, h('span', { class: 'dot', style: { background: phoneOk ? 'var(--good)' : 'var(--warn)' } }), `LIVE ${S.code} · ${txt}`),
      st.bat != null ? h('span', { class: 'small muted' }, `batteria ${Math.round(st.bat * 100)}%`) : null,
      S.follow ? null : h('button', { class: 'btn sm primary', onclick: () => { S.follow = true; Viewer.requestDraw(); this.renderBar(S); } }, 'Torna al live'),
      h('button', { class: 'btn sm', title: 'Salva i dati ricevuti come uscita (o scarica il CSV)', onclick: () => this.saveAs(S) }, 'Salva')].filter(Boolean));
  },
  async saveAs(S) {
    if (!S.hasData()) { toast('Non sono ancora arrivati dati.'); return; }
    const csv = S.toCSV();
    const name = `N17_live_${S.code}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    if (!Store.root || Store.kind !== 'fs') { downloadText(name, csv); toast('Ho scaricato il CSV: trascinalo in un\'uscita della libreria per analizzarlo.', 7000); return; }
    try {
      const meta = newSessionMeta({ title: `Live ${S.code}`, date: ymdOf(S.t0), events: S.meta.events.slice(), notes: 'Dati ricevuti in diretta dal Registratore N17.' });
      const folder = await Store.createSession(meta);
      await Store.writeText(`${folder}/dati/${name}`, csv);
      const tab = parseTable(csv), cols = analyzeCols(tab), cfg = guessSourceConfig(tab, cols);
      meta.sources.push(Object.assign({ id: uid('s'), file: `dati/${name}`, name: 'iPhone (live)' }, cfg));
      await Store.saveSession(folder, meta);
      toast(`Salvata l'uscita "${meta.title}" nella libreria. Il live continua.`, 7000);
    } catch (e) { downloadText(name, csv); toast('Non riesco a scrivere nella libreria: ho scaricato il CSV. ' + errMsg(e), 8000, 'bad'); }
  }
};

/* layout del live: numeri grandi, velocità, assetto, mappa, eventi */
function liveLayout(S) {
  const has = k => ['live:' + k]; // canali attesi: i pannelli si riempiono appena arrivano
  const nums = [...has('gps_speed_kn'), ...has('heel_deg'), ...has('pitch_deg'), ...has('heading_deg'), ...has('gps_course'), ...has('yaw_rate_dps')];
  return [
    { type: 'numbers', x: 0, y: 0, w: 6, h: 14, cfg: { ids: nums, avg: 10 } },
    { type: 'chart', x: 6, y: 0, w: 10, h: 7, cfg: { title: 'Velocità', ids: has('gps_speed_kn') } },
    { type: 'chart', x: 6, y: 7, w: 10, h: 7, cfg: { title: 'Assetto', ids: [...has('heel_deg'), ...has('pitch_deg')] } },
    { type: 'map', x: 16, y: 0, w: 8, h: 14, cfg: { follow: true, trail: 120 } },
    { type: 'chart', x: 0, y: 14, w: 12, h: 10, cfg: { title: 'Rotazione e accelerazioni', ids: [...has('yaw_rate_dps'), ...has('acc_peak_g')] } },
    { type: 'events', x: 12, y: 14, w: 12, h: 10, cfg: {} }
  ];
}
