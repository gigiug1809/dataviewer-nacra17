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
    if (LS.get('liveLayoutVer', 0) < 3) { LS.set('liveLayout', null); LS.set('liveLayoutVer', 3); }
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
    if (m.v !== 1) return;
    if (m.r && m.r !== this.recId) { if (this.recId) this.newRecording(m.r); this.recId = m.r; }
    if (this.seen.has(m.s)) return; // pacchetto già ricevuto (dopo una riconnessione)
    this.seen.add(m.s);
    this.packets++;
    const add = (key, t, v) => {
      if (v == null || !isFinite(v)) return;
      const c = this.cols[key];
      if (c.t.length && t < c.t[c.t.length - 1]) this.sorted = false;
      c.t.push(t); c.v.push(v);
    };
    for (const r of m.m || []) { const t = m.b + r[0]; LIVE_M.forEach((k, i) => add(k, t, r[i + 1])); this.lastSampleT = Math.max(this.lastSampleT, t); this.lastMT = t; this.lastMRx = Date.now(); }
    for (const k of m.e || []) { // [tipo, dt]: "s" inizio tratto, "f" fine tratto
      const t = m.b + k[1];
      if (k[0] === 's') Live.segmentStart(this, t, 'telefono'); else if (k[0] === 'f') Live.segmentStop(this, t, 'telefono');
    }
    for (const r of m.g || []) { const t = m.b + r[0]; LIVE_G.forEach((k, i) => add(k, t, r[i + 1])); this.lastSampleT = Math.max(this.lastSampleT, t); this.lastGT = t; this.lastGRx = Date.now(); }
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
  // il telefono ha iniziato una registrazione nuova: i numeri dei pacchetti ripartono da zero
  newRecording() { this.seen.clear(); }
  dispose() { if (this.client) this.client.close(); }

  /* CSV nello stesso formato del file del telefono: il Dataviewer lo rilegge come un'uscita normale */
  toCSV() {
    const cols = ['lat', 'lon', 'gps_speed_kn', 'gps_course', 'gps_hacc_m', 'heel_deg', 'pitch_deg', 'heading_deg', 'roll_rate_dps', 'yaw_rate_dps', 'acc_surge_g', 'acc_heave_g', 'acc_peak_g'];
    const rows = new Map();
    for (const k of cols) { const c = this.cols[k]; c.t.forEach((t, i) => { let r = rows.get(t); if (!r) { r = {}; rows.set(t, r); } r[k] = c.v[i]; }); }
    const lines = [`# Registratore N17 · ricevuto live dal Dataviewer · codice ${this.code}`, `# registrazione ${this.recId || 'SCONOSCIUTA'}`, ['time_utc', ...cols].join(','), ['ISO8601', 'deg', 'deg', 'kn', 'deg', 'm', 'deg', 'deg', 'deg', 'deg/s', 'deg/s', 'g', 'g', 'g'].join(',')];
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
    const go = (view = LS.get('liveView', 'quadro')) => {
      const c = code.value.trim().toUpperCase();
      if (c.length < 4) { toast('Scrivi il codice barca che vedi sul telefono.'); code.focus(); return; }
      LS.set('liveCode', c); LS.set('liveServer', { url: url.value.trim(), username: user.value.trim(), password: pass.value });
      LS.set('liveView', view);
      Router.go('#/live/' + encodeURIComponent(c) + (view === 'quadro' ? '/quadro' : ''));
    };
    code.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    root.append(h('div', { class: 'page' },
      h('div', { class: 'topbar' }, h('button', { class: 'btn ghost', onclick: () => Router.go('#/') }, '← Libreria'), h('div', { class: 'brand' }, h('div', { class: 'brand-mark', html: ICON_BOAT }), h('h1', null, 'N17 Live'))),
      h('div', { class: 'welcome', style: { marginTop: '4vh' } },
        h('div', { class: 'card', style: { display: 'grid', gap: '14px' } },
          h('h2', null, 'Guarda i dati della barca in tempo reale'),
          h('p', { class: 'muted' }, 'Sul telefono in barca, nell\'app N17 Logger, accendi "Trasmetti live" e avvia la registrazione. Poi scrivi qui il codice barca che compare sul telefono.'),
          h('label', { class: 'f' }, 'Codice barca', code),
          h('details', null, h('summary', null, 'Server (solo se ne usi uno tuo)'),
            h('div', { style: { display: 'grid', gap: '10px', marginTop: '10px' } }, h('label', { class: 'f' }, 'Indirizzo', url), h('label', { class: 'f' }, 'Utente', user), h('label', { class: 'f' }, 'Password', pass),
              h('p', { class: 'stat' }, 'Gli stessi dati che hai messo nel telefono in "Server e codice".'))),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
            h('button', { class: 'btn primary', style: { minHeight: '56px', fontSize: '16px', flexDirection: 'column', gap: '2px' }, onclick: () => go('quadro') }, 'Live', h('span', { style: { fontWeight: 500, fontSize: '12px', opacity: .85 } }, 'numeri grandi per tipo')),
            h('button', { class: 'btn', style: { minHeight: '56px', fontSize: '16px', flexDirection: 'column', gap: '2px' }, onclick: () => go('dashboard') }, 'Grafici live', h('span', { class: 'muted', style: { fontWeight: 500, fontSize: '12px' } }, 'mappa, grafici, pannelli'))),
          h('p', { class: 'stat' }, 'Funziona su computer, tablet e telefono, anche in Safari: per guardare il Live non serve la cartella della libreria.')))));
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
    S.onStatus = () => { const el = $('#liveWait'); if (el) el.textContent = this.statusInfo(S).wait; };
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
  /* stato del collegamento, uguale per dashboard e quadro */
  statusInfo(S) {
    const st = S.status || {};
    const lag = S.lastSampleRx ? Math.max(0, (Date.now() - S.lastSampleT) / 1000) : NaN;
    const fresh = !!(S.lastSampleRx && Date.now() - S.lastSampleRx < 5000);
    const ok = S.conn === 'connected' && st.online !== false && fresh;
    const txt = S.conn !== 'connected' ? 'server: ' + ({ connecting: 'mi collego…', reconnecting: 'riconnessione…', error: 'errore' }[S.conn] || S.conn || 'mi collego…')
      : st.online === false ? 'telefono offline' : !S.lastSampleRx ? 'in attesa dei dati' : !fresh ? `nessun dato da ${fmtDur(Date.now() - S.lastSampleRx)}` : `ritardo ${fmtNum(lag, 1)} s`;
    const wait = S.conn === 'error' ? 'Errore di collegamento al server: ' + (S.connDetail || '') : S.conn !== 'connected' ? 'Mi collego al server…'
      : st.online === false ? 'Il telefono è offline. Aspetto che si ricolleghi…' : st.rec ? 'Telefono in registrazione: arrivano i dati…'
      : S.status ? 'Telefono collegato ma non registra: avvia la registrazione.' : 'Collegato. Aspetto i dati del telefono: avvia la registrazione con "Trasmetti live" acceso.';
    // assetto e GPS con ore molto diverse: l'app del telefono ha l'orologio dei sensori sfasato
    let skew = null;
    if (S.lastMRx && S.lastGRx && Date.now() - S.lastMRx < 10000 && Date.now() - S.lastGRx < 30000) {
      const d = (S.lastGT - S.lastMT) - (S.lastGRx - S.lastMRx);
      if (Math.abs(d) > 30000) skew = `Sbandamento e trim arrivano con l'ora sbagliata (${fmtDur(Math.abs(d))} ${d > 0 ? 'indietro' : 'avanti'} rispetto al GPS): aggiorna l'app del telefono e riavvia la registrazione.`;
    }
    return { ok: ok && !skew, fresh, txt, wait, skew, bat: st.bat != null ? Math.round(st.bat * 100) : null };
  },
  renderBar(S) {
    const el = $('#liveBar');
    if (!el) return;
    const info = this.statusInfo(S);
    el.textContent = '';
    el.append(...[
      h('span', { class: 'chip', style: { background: info.ok ? 'rgba(25,158,112,.18)' : 'rgba(201,133,0,.18)' } }, h('span', { class: 'dot', style: { background: info.ok ? 'var(--good)' : 'var(--warn)' } }), `LIVE ${S.code} · ${info.txt}`),
      info.bat != null ? h('span', { class: 'small muted' }, `batteria ${info.bat}%`) : null,
      info.skew ? h('span', { class: 'small', style: { color: 'var(--warn)', fontWeight: 700 }, title: info.skew }, '⚠ ora dei sensori sfasata') : null,
      h('button', { class: 'btn sm', title: 'Torna ai numeri grandi del Live', onclick: () => { LS.set('liveView', 'quadro'); Router.go('#/live/' + encodeURIComponent(S.code) + '/quadro'); } }, 'Live'),
      S.follow ? null : h('button', { class: 'btn sm primary', onclick: () => { S.follow = true; Viewer.requestDraw(); this.renderBar(S); } }, 'Torna all\'ultimo dato'),
      (() => {
        const open = S.meta.events.find(e => e.type === 'tratto' && e.t2 == null);
        return open
          ? h('button', { class: 'btn sm danger', style: { fontWeight: 700 }, title: 'Chiude il tratto e mostra il riepilogo', onclick: () => this.segmentStop(S) }, `■ Fine tratto · ${fmtDur(S.t1 - open.t)}`)
          : h('button', { class: 'btn sm primary', title: 'Da adesso parte il tratto da analizzare', onclick: () => this.segmentStart(S) }, '▶ Inizia tratto');
      })(),
      h('button', { class: 'btn sm', title: 'Salva i dati ricevuti come uscita (o scarica il CSV)', onclick: () => this.saveAs(S) }, 'Salva')].filter(Boolean));
  },
  /* tratti: l'allenatore (o il telefono) segna inizio e fine di un pezzo di allenamento */
  segmentStart(S, t = S.t1, from = 'allenatore') {
    if (S.meta.events.some(e => e.type === 'tratto' && e.t2 == null)) return;
    const n = S.meta.events.filter(e => e.type === 'tratto').length + 1;
    S.addEvent({ t: Math.round(t), t2: null, type: 'tratto', note: `Tratto ${n}`, by: from });
    this.changed(S);
    toast(`Tratto ${n} iniziato${from === 'telefono' ? ' dal telefono' : ''}.`, 2500);
  },
  segmentStop(S, t = S.t1, from = 'allenatore') {
    const open = S.meta.events.find(e => e.type === 'tratto' && e.t2 == null);
    if (!open) return;
    open.t2 = Math.max(open.t + 1000, Math.round(t));
    S.save(); this.changed(S);
    if (Viewer.S === S) showRangeAnalysis(Viewer, open.t, open.t2, `${open.note} · riepilogo${from === 'telefono' ? ' (chiuso dal telefono)' : ''}`);
    else if (Quadro.S === S) Quadro.summary(open);
  },
  changed(S) {
    if (Viewer.S === S) { Viewer.eventsChanged(); this.renderBar(S); }
    if (Quadro.S === S) Quadro.renderTop();
  },
  /* salvo nell'uscita del giorno (un giorno = un'uscita), senza doppioni con il file del telefono */
  async saveAs(S) {
    if (!S.hasData()) { toast('Non sono ancora arrivati dati.'); return; }
    const csv = S.toCSV();
    const name = `N17_live_${S.recId || S.code}.csv`;
    if (!Store.root) { const rec = await Store.remembered(); if (rec) { try { await Store.reopen(rec); } catch (e) { /* resta il download */ } } }
    if (!Store.root) { downloadText(name, csv); toast('Ho scaricato il CSV: trascinalo nel giorno giusto del calendario per analizzarlo.', 7000); return; }
    try {
      const folder = await Store.dayFolder(ymdOf(S.t0));
      const meta = await Store.readJSON(`${folder}/${SESSION_FILE}`);
      const ids = new Set(meta.events.map(e => e.id));
      for (const e of S.meta.events) if (!ids.has(e.id)) meta.events.push(e);
      meta.events.sort((a, b) => a.t - b.t);
      const full = meta.sources.find(x => x.kind === 'iPhone' && !x.live && S.recId && x.recId === S.recId);
      if (full) { await Store.saveSession(folder, meta); toast('Quel giorno ha già il file completo del telefono: ho aggiunto solo eventi e tratti.', 7000); return; }
      await Store.writeText(`${folder}/dati/${name}`, csv);
      const tab = parseTable(csv), cols = analyzeCols(tab), cfg = guessSourceConfig(tab, cols);
      meta.sources = meta.sources.filter(x => !(x.live && x.file === `dati/${name}`)); // un salvataggio successivo sostituisce il precedente
      meta.sources.push(Object.assign({ id: uid('s'), file: `dati/${name}`, name: 'iPhone (live)' }, cfg, { live: true, recId: S.recId || null }));
      await Store.saveSession(folder, meta);
      toast(`Salvato nel giorno ${fmtDateLong(meta.date)}. Quando importi il file completo del telefono, prenderà il posto di questi dati. Il live continua.`, 8000);
    } catch (e) { downloadText(name, csv); toast('Non riesco a scrivere nella libreria: ho scaricato il CSV. ' + errMsg(e), 8000, 'bad'); }
  }
};

/* layout del live: numeri grandi, medie 10 s / 30 s (e del tratto), mappa, velocità, assetto, eventi */
function liveLayout(S) {
  const has = k => ['live:' + k]; // canali attesi: i pannelli si riempiono appena arrivano
  return [
    { type: 'numbers', x: 0, y: 0, w: 5, h: 13, cfg: { ids: [...has('gps_speed_kn'), ...has('heel_deg'), ...has('pitch_deg'), ...has('gps_course'), ...has('yaw_rate_dps')], avg: 10, damp: 3 } },
    { type: 'averages', x: 5, y: 0, w: 8, h: 13, cfg: { windows: [10, 30] } },
    { type: 'map', x: 13, y: 0, w: 11, h: 13, cfg: { follow: true, trail: 120 } },
    { type: 'chart', x: 0, y: 13, w: 8, h: 11, cfg: { title: 'Velocità', ids: has('gps_speed_kn') } },
    { type: 'chart', x: 8, y: 13, w: 8, h: 11, cfg: { title: 'Sbandamento e trim', ids: [...has('heel_deg'), ...has('pitch_deg')] } },
    { type: 'events', x: 16, y: 13, w: 8, h: 11, cfg: {} }
  ];
}
