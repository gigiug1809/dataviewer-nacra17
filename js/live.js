/* N17 Live: dati in tempo reale dal Logger dell'iPhone, via MQTT.
   Funziona anche senza cartella della libreria (per esempio su iPad, in Safari).
   I dati del Live sono una copia provvisoria: il file completo resta sul telefono e a terra va nel Debrief.
   I tratti segnati qui arrivano anche al telefono, che li scrive nel suo file. */
'use strict';
const LIVE_PUBLIC = 'wss://broker.hivemq.com:8884/mqtt';
// ordine dei valori nei pacchetti del telefono
const LIVE_M = ['heel_deg', 'pitch_deg', 'heading_deg', 'yaw_rate_dps', 'roll_rate_dps', 'acc_surge_g', 'acc_heave_g', 'acc_peak_g'];
const LIVE_G = ['lat', 'lon', 'gps_speed_kn', 'gps_course', 'gps_hacc_m'];

class LiveSession extends Session {
  constructor(code, server) {
    const saved = LS.get('live.' + code, {});
    super(null, newSessionMeta({ title: `Live ${code}`, date: ymdOf(Date.now()), events: saved.events || [], layout: null, view: { win: saved.win ?? 120000 } }));
    this.live = true; this.follow = true; this.code = code; this.server = server;
    this.cols = {}; for (const k of [...LIVE_M, ...LIVE_G]) this.cols[k] = { t: new Float64Array(2048), v: new Float64Array(2048), n: 0 };
    this.seen = new Set(); this.sorted = true;
    this.status = null; this.lastRx = 0; this.lastSampleRx = 0; this.lastSampleT = 0; this.packets = 0;
    this.channelMap = new Map();
  }
  save() {
    if (!this.sim) LS.set('live.' + this.code, { events: this.meta.events, win: this.meta.view.win });
    // la disposizione dei pannelli va nella dashboard (per l'orientamento in uso), solo se l'ha cambiata chi guarda:
    // così un iPad con una copia vecchia non cancella le modifiche fatte sul Mac
    if (this.dash && this.layoutDirty && this.meta.layout) {
      this.layoutDirty = false;
      const d = Dash.get(this.dash.id) || this.dash;
      d[this.orient] = JSON.parse(JSON.stringify(this.meta.layout));
      this.dash = d; this.dashSeen = Dash.save(d).updated;
    }
    this.onSave && this.onSave('saved');
  }
  saveNow() { this.save(); }
  async load() { this.rebuild(); }

  /* data = false: solo la sincronizzazione delle dashboard (mentre si compone con i dati simulati) */
  connect({ data = true } = {}) {
    const c = this.client = new MqttClient({ url: this.server.url || LIVE_PUBLIC, username: this.server.username, password: this.server.password });
    c.onstate = (s, d) => { this.conn = s; this.connDetail = d; this.onStatus && this.onStatus(); };
    if (data) {
      c.subscribe(`n17dv/${this.code}/live`, (t, p) => this.ingest(p));
      c.subscribe(`n17dv/${this.code}/status`, (t, p) => { try { this.status = JSON.parse(new TextDecoder().decode(p)); this.status.rx = Date.now(); } catch (e) { /* messaggio non valido */ } this.onStatus && this.onStatus(); });
    }
    const unlink = Dash.attach(c, this.code);
    // dashboard cambiata da un altro dispositivo mentre la guardo (e non la sto modificando): la ricarico
    const onDash = () => {
      if (!this.dash || !Viewer.locked || Viewer.S !== this) return;
      const d = Dash.get(this.dash.id);
      if (!d || (d.updated || 0) <= (this.dashSeen || this.dash.updated || 0)) return;
      this.dash = d; this.dashSeen = d.updated;
      Viewer.applyLayout(Dash.layout(d, this.orient), false);
      toast(`"${d.name}" è stata modificata su un altro dispositivo: aggiornata.`, 4000);
    };
    Dash.listeners.add(onDash);
    this.unDash = () => { unlink(); Dash.listeners.delete(onDash); };
    c.connect();
  }
  /* comando al telefono: inizio (s) o fine (f) di un tratto, che il telefono scrive nel suo file */
  sendCmd(c, t) { if (this.client && !this.sim) this.client.publish(`n17dv/${this.code}/cmd`, JSON.stringify({ c, t: Math.round(t) })); }
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
      if (c.n && t < c.t[c.n - 1]) this.sorted = false;
      if (c.n === c.t.length) { const T = new Float64Array(c.n * 2), V = new Float64Array(c.n * 2); T.set(c.t); V.set(c.v); c.t = T; c.v = V; } // raddoppio lo spazio
      c.t[c.n] = t; c.v[c.n] = v; c.n++;
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
        const idx = Array.from({ length: c.n }, (_, i) => i).sort((a, b) => c.t[a] - c.t[b]);
        const T = new Float64Array(c.t.length), V = new Float64Array(c.v.length);
        idx.forEach((j, i) => { T[i] = c.t[j]; V[i] = c.v[j]; });
        c.t = T; c.v = V;
      }
      this.sorted = true;
    }
    for (const [key, c] of Object.entries(this.cols)) {
      if (c.n < 2) continue;
      const m = PHONE_COLS[key];
      const fresh = makeChannel({ id: `live:${key}`, name: m[0], unit: m[1], role: m[2], src: 'live', srcName: 'iPhone live', srcKind: 'iPhone', t: c.t.subarray(0, c.n), v: c.v.subarray(0, c.n) });
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
  dispose() { if (this.sim) this.sim.stop(); if (this.unDash) this.unDash(); if (this.client) this.client.close(); }

  /* CSV nello stesso formato del file del telefono: il Dataviewer lo rilegge come un'uscita normale */
  toCSV() {
    const cols = ['lat', 'lon', 'gps_speed_kn', 'gps_course', 'gps_hacc_m', 'heel_deg', 'pitch_deg', 'heading_deg', 'roll_rate_dps', 'yaw_rate_dps', 'acc_surge_g', 'acc_heave_g', 'acc_peak_g'];
    const rows = new Map();
    for (const k of cols) { const c = this.cols[k]; for (let i = 0; i < c.n; i++) { const t = c.t[i]; let r = rows.get(t); if (!r) { r = {}; rows.set(t, r); } r[k] = c.v[i]; } }
    const lines = [`# Registratore N17 · ricevuto live dal Dataviewer · codice ${this.code}`, `# registrazione ${this.recId || 'SCONOSCIUTA'}`, ['time_utc', ...cols].join(','), ['ISO8601', 'deg', 'deg', 'kn', 'deg', 'm', 'deg', 'deg', 'deg', 'deg/s', 'deg/s', 'g', 'g', 'g'].join(',')];
    for (const t of [...rows.keys()].sort((a, b) => a - b)) { const r = rows.get(t); lines.push([new Date(t).toISOString(), ...cols.map(k => r[k] ?? '')].join(',')); }
    return lines.join('\n');
  }
}

const Live = {
  /* ---------- pagina del Live: barca e dashboard ---------- */
  page() {
    this.leavePage();
    const root = $('#view-home');
    root.textContent = '';
    const code = Boats.current();
    if (code) LS.set('liveCode', code);
    const srv = LS.get('liveServer', { url: '', username: '', password: '' });
    const orient = innerWidth >= innerHeight ? 'land' : 'port';
    const statusEl = h('div', { class: 'live-st' }, 'Mi collego…');
    const url = h('input', { type: 'text', class: 'full', value: srv.url, placeholder: LIVE_PUBLIC });
    const user = h('input', { type: 'text', class: 'full', value: srv.username, placeholder: 'vuoto per il server pubblico', autocomplete: 'off' });
    const pass = h('input', { type: 'password', class: 'full', value: srv.password, autocomplete: 'off' });
    const saveSrv = () => { LS.set('liveServer', { url: url.value.trim(), username: user.value.trim(), password: pass.value }); this.page(); };

    // barche
    const boats = h('div', { class: 'boat-row' },
      Boats.list().map(b => h('div', { class: 'boat' + (b.code === code ? ' on' : '') },
        h('button', { class: 'boat-btn', onclick: () => { LS.set('liveCode', b.code); this.page(); } }, b.code),
        Boats.list().length > 1 ? h('button', { class: 'boat-x', title: 'Togli questa barca dall\'elenco', 'aria-label': 'Togli ' + b.code, onclick: async () => { if (await confirmBox('Togli la barca', `Tolgo ${b.code} dall'elenco di questo dispositivo? I dati sul telefono non cambiano.`, 'Togli')) { Boats.remove(b.code); this.page(); } } }, '✕') : null)),
      h('button', { class: 'btn', onclick: async () => {
        const v = Boats.clean(await promptBox('Aggiungi una barca', 'Codice barca, uguale a quello scritto nel telefono (es. ITA98)', ''));
        if (v.length < 3) { if (v) toast('Il codice deve avere almeno 3 lettere o cifre.'); return; }
        Boats.add(v); LS.set('liveCode', v); this.page();
      } }, '+ Barca'));

    // dashboard
    const grid = h('div', { class: 'dash-grid' });
    const open = (id, edit) => Router.go(`#/live/${encodeURIComponent(code)}/${id === 'quadro' ? 'quadro' : 'd/' + encodeURIComponent(id) + (edit ? '/modifica' : '')}`);
    const draw = () => {
      grid.textContent = '';
      grid.append(h('div', { class: 'dash-card' },
        h('button', { class: 'dash-open', onclick: () => open('quadro') }, h('div', { class: 'dash-prev quadro ' + orient }, h('span', null, '12,4'), h('span', null, '8°'), h('span', null, '1,3°')),
          h('div', { class: 'dash-name' }, 'Quadro numeri grandi'), h('div', { class: 'dash-sub' }, 'fisso: heel, trim, velocità, rotta, timone')),
        h('div', { class: 'dash-act' }, h('button', { class: 'btn sm primary', onclick: () => open('quadro') }, 'Apri'))));
      for (const d of Dash.list()) {
        grid.append(h('div', { class: 'dash-card' },
          h('button', { class: 'dash-open', onclick: () => open(d.id) }, dashPreview(Dash.layout(d, orient), orient),
            h('div', { class: 'dash-name' }, d.name), h('div', { class: 'dash-sub' }, d.updated ? `modificata ${fmtAgo(d.updated)}` : 'standard')),
          h('div', { class: 'dash-act' },
            h('button', { class: 'btn sm primary', onclick: () => open(d.id) }, 'Apri'),
            h('button', { class: 'btn sm', title: 'Modifica con dati simulati', onclick: () => open(d.id, true) }, '✎ Modifica'),
            h('button', { class: 'icon-btn', title: 'Altro', 'aria-label': 'Altro', onclick: e => menu(e.currentTarget, [
              { label: 'Rinomina…', run: async () => { const n = await promptBox('Rinomina la dashboard', 'Nome', d.name); if (n && n.trim()) { d.name = n.trim(); Dash.save(d); } } },
              { label: 'Duplica', run: () => { Dash.create(d.name + ' (copia)', JSON.parse(JSON.stringify(d.land || [])), d.port ? JSON.parse(JSON.stringify(d.port)) : null); } },
              { label: 'Rifai la disposizione verticale da quella orizzontale', run: () => { d.port = null; Dash.save(d); toast('La disposizione verticale ora segue quella orizzontale.'); } },
              { sep: true },
              { label: 'Elimina…', run: async () => { if (await confirmBox('Elimina la dashboard', `Elimino "${d.name}"? Sparisce anche dagli altri dispositivi collegati a ${code}.`, 'Elimina', true)) Dash.remove(d.id); } }]) }, '⋯'))));
      }
      grid.append(h('button', { class: 'dash-card dash-new', onclick: () => this.newDash(code) }, h('b', null, '+'), h('span', null, 'Nuova dashboard')));
    };
    draw();
    this.pageListener = draw;
    Dash.listeners.add(draw);

    const imp = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { toast(`Importate ${await Dash.importFile(f)} dashboard.`); } catch (err) { toast(errMsg(err), 6000, 'bad'); } } });
    root.append(h('div', { class: 'page live-page' },
      h('div', { class: 'topbar' }, h('button', { class: 'btn ghost', onclick: () => Router.go('#/') }, '← Inizio'), h('div', { class: 'brand' }, h('div', { class: 'brand-mark', html: ICON_BOAT }), h('h1', null, 'N17 Live')), h('div', { class: 'sp' }),
        h('button', { class: 'icon-btn', title: 'Tema chiaro / scuro', 'aria-label': 'Tema chiaro o scuro', onclick: toggleTheme }, '◐')),
      h('section', { class: 'card live-sec' }, h('h2', null, '1 · Barca'), boats, statusEl,
        h('details', null, h('summary', null, 'Server (solo se ne usi uno tuo)'),
          h('div', { style: { display: 'grid', gap: '10px', marginTop: '10px' } }, h('label', { class: 'f' }, 'Indirizzo', url), h('label', { class: 'f' }, 'Utente', user), h('label', { class: 'f' }, 'Password', pass),
            h('div', { class: 'row' }, h('span', { class: 'stat' }, 'Gli stessi dati che hai messo nel telefono in "Server e codice".'), h('div', { class: 'sp' }), h('button', { class: 'btn sm primary', onclick: saveSrv }, 'Usa questo server'))))),
      h('section', { class: 'card live-sec' }, h('h2', null, '2 · Dashboard'), grid,
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'stat' }, `Le dashboard si salvano con la barca: le ritrovi su ogni computer o iPad che apre ${code || 'la stessa barca'}. In verticale e in orizzontale hanno due disposizioni, scelte da sole.`), h('div', { class: 'sp' }),
          h('button', { class: 'btn sm ghost', onclick: () => Dash.exportFile() }, 'Esporta'), h('button', { class: 'btn sm ghost', onclick: () => imp.click() }, 'Importa'), imp)),
      h('p', { class: 'stat live-note' }, 'I numeri del Live sono una copia in diretta: il file completo resta sul telefono. A terra importalo nel Debrief, che lo mette da solo nel giorno giusto. I tratti segnati qui vengono scritti anche nel file del telefono.')));

    // stato del telefono e sincronizzazione delle dashboard
    if (!code) { statusEl.textContent = 'Aggiungi la tua barca con il codice scritto nel telefono.'; return; }
    const c = this.pageClient = new MqttClient({ url: srv.url || LIVE_PUBLIC, username: srv.username, password: srv.password });
    let st = null, conn = 'connecting';
    const show = () => {
      const age = st && st.t ? Date.now() - st.t : Infinity;
      statusEl.className = 'live-st ' + (st && st.online !== false && st.rec ? 'ok' : 'wait');
      statusEl.textContent = conn !== 'connected' ? (conn === 'error' ? 'Non riesco a collegarmi al server.' : 'Mi collego al server…')
        : !st ? `Nessuna notizia del telefono di ${code}: in barca, nel Logger, accendi "Trasmetti live" e controlla che il codice sia ${code}.`
        : st.online === false ? `Telefono di ${code} non collegato${st.t ? ' (ultimo contatto ' + fmtAgo(st.t) + ')' : ''}.`
        : st.rec ? `Telefono di ${code} in registrazione${st.bat != null ? ' · batteria ' + Math.round(st.bat * 100) + '%' : ''}: apri una dashboard.`
        : `Telefono di ${code} collegato, ma non registra${age > 60000 ? ' (ultimo contatto ' + fmtAgo(st.t) + ')' : ''}: avvia la registrazione.`;
    };
    c.onstate = s => { conn = s; show(); };
    c.subscribe(`n17dv/${code}/status`, (t, p) => { try { st = JSON.parse(new TextDecoder().decode(p)); } catch (e) { /* non valido */ } show(); });
    this.pageUnDash = Dash.attach(c, code);
    c.connect();
    this.pageTimer = setInterval(show, 10000);
  },
  leavePage() {
    if (this.pageClient) { this.pageClient.close(); this.pageClient = null; }
    if (this.pageUnDash) { this.pageUnDash(); this.pageUnDash = null; }
    if (this.pageListener) { Dash.listeners.delete(this.pageListener); this.pageListener = null; }
    clearInterval(this.pageTimer);
  },
  newDash(code) {
    const name = h('input', { type: 'text', class: 'full', value: 'Dashboard ' + (Dash.list().length + 1) });
    const from = h('select', { class: 'full' }, h('option', { value: '' }, 'Vuota: aggiungo io i pannelli'), h('option', { value: '__std' }, 'Pannelli di partenza (numeri, medie, mappa, grafici)'), Dash.list().map(d => h('option', { value: d.id }, `Copia di "${d.name}"`)));
    from.value = '__std';
    modal({ title: 'Nuova dashboard', body: h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'f' }, 'Nome', name), h('label', { class: 'f' }, 'Parti da', from),
      h('p', { class: 'stat' }, 'Si apre con dati simulati, così puoi comporla anche a terra. Sopra scegli se stai preparando la disposizione orizzontale o verticale.')),
      actions: [{ label: 'Annulla' }, { label: 'Crea e modifica', kind: 'primary', run: () => {
        const src = from.value === '__std' ? { land: liveLayout() } : from.value ? Dash.get(from.value) : { land: [] };
        const d = Dash.create(name.value.trim() || 'Dashboard', JSON.parse(JSON.stringify(src.land || [])), src.port ? JSON.parse(JSON.stringify(src.port)) : null);
        Router.go(`#/live/${encodeURIComponent(code)}/d/${encodeURIComponent(d.id)}/modifica`);
      } }] });
  },

  /* ---------- una dashboard: con i dati della barca, oppure da modificare con i dati simulati ---------- */
  open(code, dashId, edit = false) {
    Viewer.close();
    const dash = Dash.get(dashId);
    if (!dash) { toast('Dashboard non trovata: forse è stata eliminata.'); Router.go('#/live'); return; }
    LS.set('liveCode', code); LS.set('liveView', dashId);
    const S = new LiveSession(code, LS.get('liveServer', {}));
    S.dash = dash; S.editing = edit;
    S.orient = edit ? LS.get('dashOrient', innerWidth >= innerHeight ? 'land' : 'port') : (innerWidth >= innerHeight ? 'land' : 'port');
    S.meta.title = dash.name;
    S.meta.layout = Dash.layout(dash, S.orient);
    S.meta.view.locked = !edit;
    if (edit) { S.sim = new LiveSim(S); S.connect({ data: false }); S.sim.start(); S.sim.step(); }
    else S.connect();
    S.rebuild();
    Viewer.open_ = true;
    const root = $('#view-viewer');
    root.textContent = '';
    Viewer.start(S, root);
    this.bar(S);
    // ogni secondo: nuovi dati nei canali e nei grafici
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!Viewer.open_ || Viewer.S !== S) { clearInterval(this.timer); return; }
      if (S.dirty) {
        const had = S.channelMap.size;
        S.rebuild();
        for (const r of Viewer.panels.values()) if (r.inst.refreshData) { try { r.inst.refreshData(); } catch (e) { console.error(e); } }
        if (!had && S.channelMap.size) Viewer.rebuildPanels(p => !['map', 'events'].includes(p.type)); // primi dati: i pannelli nascono con i canali giusti
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
      if (Math.abs(d) > 30000) skew = `Heel e trim arrivano con l'ora sbagliata (${fmtDur(Math.abs(d))} ${d > 0 ? 'indietro' : 'avanti'} rispetto al GPS): aggiorna l'app del telefono e riavvia la registrazione.`;
    }
    return { ok: ok && !skew, fresh, txt, wait, skew, bat: st.bat != null ? Math.round(st.bat * 100) : null };
  },
  renderBar(S) {
    const el = $('#liveBar');
    if (!el) return;
    const info = this.statusInfo(S);
    el.textContent = '';
    el.append(...[
      S.sim ? h('span', { class: 'chip sim', title: 'La barca non serve: i dati sono inventati per comporre la dashboard' }, h('span', { class: 'dot', style: { background: 'var(--accent)' } }), 'DATI SIMULATI')
        : h('span', { class: 'chip', title: info.wait, style: { background: info.ok ? 'rgba(25,158,112,.18)' : 'rgba(201,133,0,.18)' } }, h('span', { class: 'dot', style: { background: info.ok ? 'var(--good)' : 'var(--warn)' } }), `${S.code} · ${info.txt}`),
      info.bat != null && !S.sim ? h('span', { class: 'small muted' }, `🔋 ${info.bat}%`) : null,
      info.skew ? h('span', { class: 'small', style: { color: 'var(--warn)', fontWeight: 700 }, title: info.skew }, '⚠ ora dei sensori sfasata') : null,
      S.follow ? null : h('button', { class: 'btn sm primary', onclick: () => { S.follow = true; Viewer.requestDraw(); this.renderBar(S); } }, 'Torna all\'ultimo dato'),
      (() => {
        const open = S.meta.events.find(e => e.type === 'tratto' && e.t2 == null);
        return open
          ? h('button', { class: 'btn sm danger', style: { fontWeight: 700 }, title: 'Chiude il tratto e mostra il riepilogo', onclick: () => this.segmentStop(S) }, `■ Fine tratto · ${fmtDur(S.t1 - open.t)}`)
          : h('button', { class: 'btn sm primary', title: 'Da adesso parte il tratto da analizzare', onclick: () => this.segmentStart(S) }, '▶ Inizia tratto');
      })(),
      S.sim ? null : h('button', { class: 'btn sm', title: 'Salva i dati ricevuti come uscita (o scarica il CSV)', onclick: () => this.saveAs(S) }, 'Salva')].filter(Boolean));
  },
  /* tratti: l'allenatore (o il telefono) segna inizio e fine di un pezzo di allenamento */
  segmentStart(S, t = S.t1, from = 'allenatore') {
    if (S.meta.events.some(e => e.type === 'tratto' && e.t2 == null)) return;
    const n = S.meta.events.filter(e => e.type === 'tratto').length + 1;
    S.addEvent({ t: Math.round(t), t2: null, type: 'tratto', note: `Tratto ${n}`, by: from });
    if (from !== 'telefono') S.sendCmd('s', t);
    this.changed(S);
    toast(`Tratto ${n} iniziato${from === 'telefono' ? ' dal telefono' : ''}.`, 2500);
  },
  segmentStop(S, t = S.t1, from = 'allenatore') {
    const open = S.meta.events.find(e => e.type === 'tratto' && e.t2 == null);
    if (!open) return;
    open.t2 = Math.max(open.t + 1000, Math.round(t));
    if (from !== 'telefono') S.sendCmd('f', open.t2);
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
    { type: 'chart', x: 8, y: 13, w: 8, h: 11, cfg: { title: 'Heel e trim', ids: [...has('heel_deg'), ...has('pitch_deg')] } },
    { type: 'events', x: 16, y: 13, w: 8, h: 11, cfg: {} }
  ];
}
