/* Pagina "Video e dati": scheda dell'uscita, caricamento di video e file di dati, controllo della sincronizzazione */
'use strict';
const VIDEO_RE = /\.(mp4|mov|m4v|lrv)$/i;
const DATA_RE = /\.(csv|txt|tsv|gpx|fit|tcx|zip)$/i;

const Editor = {
  folder: null, meta: null, tabs: new Map(), jobs: new Map(), channels: new Map(), targetCam: '',
  async open(folder) {
    this.folder = folder; this.tabs.clear(); this.channels.clear();
    if (folder) {
      this.meta = await Store.readJSON(`${folder}/${SESSION_FILE}`);
      if (!this.meta) { toast('Uscita non trovata.'); Router.go('#/debrief'); return; }
    } else this.meta = newSessionMeta();
    if (folder) this.migrateClips();
    for (const s of this.meta.sources) for (const c of s.columns || []) c.name = modernName(c.name);
    this.render();
    if (folder) this.parseAll().then(() => this.runAutoSync());
  },
  // video caricati con la versione precedente: ricalcolo l'ora d'inizio (telefoni Samsung, iPhone, nome del file)
  migrateClips() {
    let n = 0;
    for (const cam of this.meta.cameras) for (const cl of cam.clips) {
      if (!['mvhd', 'mtime', 'mvhd-end'].includes(cl.startSrc) || cl.gopro) continue;
      const r = clipStartFromMeta(cl);
      if (Math.abs(r.start - cl.start) > 500) { Object.assign(cl, r); n++; }
    }
    if (n) { this.save(); toast(`Corretta l'ora d'inizio di ${n} video (il telefono scrive nel file l'ora della fine).`, 7000); }
  },
  /* Sincronizzazione automatica: parte da sola dopo ogni caricamento */
  async runAutoSync(force = false) {
    if (!this.folder) return;
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true; this.syncMsg = 'Sincronizzo video e dati…'; this.renderCheck();
    try {
      const r = await autoSync(this.folder, this.meta, { force, onStep: m => { this.syncMsg = m; this.renderCheck(); } });
      this.syncReport = r.report;
      if (r.changed) { this.save(); for (const src of this.meta.sources) this.rebuild(src, false); this.renderVideo(); this.renderData(); }
    } catch (e) { this.syncReport = [{ what: 'Sincronizzazione', ok: false, text: errMsg(e) }]; }
    this.syncing = false; this.syncMsg = ''; this.renderCheck();
    if (this.syncAgain) { this.syncAgain = false; this.runAutoSync(); }
  },
  save: debounce(function () { if (Editor.folder) Store.saveSession(Editor.folder, Editor.meta).catch(e => toast('Salvataggio non riuscito: ' + errMsg(e), 8000, 'bad')); }, 500),

  render() {
    const root = $('#view-editor');
    root.textContent = '';
    const m = this.meta, isNew = !this.folder;
    const page = h('div', { class: 'page' });
    root.append(page);
    const day = m.date ? fmtDateLong(m.date) : 'Uscita';
    const title = !m.title || m.title === 'Uscita' ? day : m.title;
    page.append(h('div', { class: 'topbar' },
      h('button', { class: 'btn ghost', onclick: () => Router.go('#/debrief') }, '← Calendario'),
      h('div', { class: 'grow' }, h('h1', { style: { textTransform: 'capitalize' } }, isNew ? 'Nuova uscita' : title), !isNew && title !== day ? h('div', { class: 'lib-path', style: { textTransform: 'capitalize' } }, day) : null),
      !isNew ? h('button', { class: 'btn primary', onclick: () => Router.go(`#/uscita/${encodeURIComponent(this.folder)}/viewer`) }, 'Apri la dashboard →') : null));
    const grid = h('div', { class: 'ed-grid' });
    page.append(grid);
    if (isNew) { grid.append(this.secInfo()); return; }
    grid.append(this.secVideo(), this.secData(), this.secCheck());
    // scheda facoltativa: equipaggio, vento, note
    const det = h('details', { class: 'card', style: { padding: '12px 16px' } }, h('summary', { style: { fontSize: '14px' } }, 'Dettagli dell\'uscita (facoltativi): titolo, vento, note…'));
    det.addEventListener('toggle', () => { if (det.open && det.children.length === 1) det.append(this.secInfo(true)); });
    grid.append(det);
    page.append(h('div', { class: 'sticky-foot' },
      h('span', { class: 'stat' }, 'Le modifiche si salvano da sole.'),
      h('button', { class: 'btn primary', onclick: () => Router.go(`#/uscita/${encodeURIComponent(this.folder)}/viewer`) }, 'Apri la dashboard →')));
  },

  /* ---------- 1. Scheda dell'uscita ---------- */
  secInfo(inline = false) {
    const m = this.meta, isNew = !this.folder;
    const f = (label, key, attrs = {}, cls = '') => {
      const { tag = 'input', options = [], ...rest } = attrs;
      const inp = h(tag, Object.assign(tag === 'input' ? { type: 'text', value: m[key] ?? '' } : {}, rest));
      if (tag === 'textarea') inp.value = m[key] || '';
      if (tag === 'select') { for (const o of options) inp.append(h('option', { value: o }, o || '—')); inp.value = m[key] || ''; }
      inp.addEventListener('input', () => { m[key] = inp.value; if (key === 'title') { const t = $('#view-editor h1'); if (t && !isNew) t.textContent = inp.value || 'Uscita'; } this.save(); if (key === 'twd') this.renderCheck(); });
      return h('label', { class: 'f ' + cls }, label, inp);
    };
    const sec = h('section', { class: inline ? 'ed-sec' : 'card ed-sec', style: inline ? { marginTop: '12px' } : null },
      inline ? null : h('div', { class: 'ed-sec-head' }, h('h2', null, 'Scheda dell\'uscita')),
      h('div', { class: 'fields' },
        f('Titolo', 'title', { placeholder: 'es. Allenamento bolina', required: true }, 'span2'),
        f('Data', 'date', { type: 'date' }),
        f('Luogo', 'place', { placeholder: 'es. Cagliari, Poetto' }),
        f('Barca', 'boat'),
        f('Timoniere', 'helm'), f('Prodiere', 'crew'),
        f('Vento min (kn)', 'windMin', { type: 'number', min: 0, step: 1 }),
        f('Vento max (kn)', 'windMax', { type: 'number', min: 0, step: 1 }),
        f('Direzione vento (°, da dove soffia)', 'twd', { type: 'number', min: 0, max: 359, step: 1, placeholder: 'es. 300' }),
        f('Mare', 'sea', { tag: 'select', options: ['', 'Piatto', 'Onda corta', 'Onda formata', 'Onda lunga', 'Mare incrociato'] }),
        f('Obiettivi e temi della giornata', 'goals', { tag: 'textarea', rows: 2 }, 'span-all'),
        f('Note', 'notes', { tag: 'textarea', rows: 2 }, 'span-all')),
      h('p', { class: 'stat' }, 'La direzione del vento serve a distinguere virate e strambate e a calcolare angolo al vento (TWA) e VMG. Puoi lasciarla vuota.'));
    if (isNew) {
      sec.append(h('div', { class: 'row' }, h('div', { class: 'sp' }),
        h('button', { class: 'btn', onclick: () => Router.go('#/debrief') }, 'Annulla'),
        h('button', { class: 'btn primary', onclick: () => this.create() }, 'Crea l\'uscita e carica i file →')));
    }
    return sec;
  },
  async create() {
    const m = this.meta;
    if (!m.title.trim()) { toast('Scrivi un titolo per l\'uscita.'); $('#view-editor input').focus(); return; }
    if (!m.date) { toast('Indica la data.'); return; }
    LS.set('lastBoat', m.boat); LS.set('lastHelm', m.helm); LS.set('lastCrew', m.crew);
    // un giorno = una giornata: se esiste già, di solito si aggiungono lì i file
    const same = (await Store.listSessions()).filter(x => x.meta.date === m.date);
    if (same.length) {
      const choice = await new Promise(res => modal({ title: 'Questo giorno ha già una giornata', onClose: () => res(null),
        body: h('p', null, `Il ${fmtDateLong(m.date)} c'è già "${same[0].meta.title || 'Uscita'}". Di solito conviene aggiungere lì video e dati, così l'allenamento resta tutto in un posto. Crea una seconda giornata solo se sono due uscite diverse (per esempio mattina e pomeriggio).`),
        actions: [{ label: 'Annulla', run: () => res(null) }, { label: 'Crea una seconda giornata', run: () => res('new') }, { label: `Apri "${same[0].meta.title || 'Uscita'}"`, kind: 'primary', run: () => res('open') }] }));
      if (choice === 'open') { Router.go(`#/uscita/${encodeURIComponent(same[0].folder)}/dati`); return; }
      if (choice !== 'new') return;
    }
    try {
      const folder = await Store.createSession(m);
      Router.go(`#/uscita/${encodeURIComponent(folder)}/dati`);
    } catch (e) { toast('Non riesco a creare la cartella: ' + errMsg(e), 8000, 'bad'); }
  },

  /* ---------- 2. Video ---------- */
  secVideo() {
    const sec = h('section', { class: 'card ed-sec', id: 'secVideo' });
    this.renderVideo(sec);
    return sec;
  },
  renderVideo(sec = $('#secVideo')) {
    if (!sec) return;
    const m = this.meta;
    sec.textContent = '';
    const input = h('input', { type: 'file', accept: '.mp4,.mov,.m4v,.lrv,video/*', multiple: true, hidden: true, onchange: e => { this.addVideos([...e.target.files]); e.target.value = ''; } });
    const camSel = h('select', { onchange: e => { this.targetCam = e.target.value; } },
      m.cameras.map(c => h('option', { value: c.id }, c.name)), h('option', { value: '__new' }, '+ nuova camera'));
    if (!m.cameras.some(c => c.id === this.targetCam)) this.targetCam = m.cameras[0] ? m.cameras[0].id : '__new';
    camSel.value = this.targetCam;
    const drop = h('div', { class: 'drop' },
      h('div', null, h('b', null, 'Trascina qui i video'), ' (MP4, MOV, anche i capitoli GoPro da 12 GB)'),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: () => input.click() }, 'Scegli i video…'),
        h('button', { class: 'btn', onclick: () => this.scanFolder() }, 'Cerca nella cartella video'),
        h('span', { class: 'stat' }, 'Aggiungi a:'), camSel),
      h('div', { class: 'stat' }, 'I file vengono copiati nella cartella ', h('code', null, 'video'), ' dell\'uscita. Per file molto grandi è più veloce copiarli con il Finder in quella cartella e poi premere "Cerca nella cartella video".'), input);
    this.dropZone(drop, files => this.addVideos(files.filter(f => VIDEO_RE.test(f.name)), files));
    sec.append(h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '1'), 'Video'),
      h('span', { class: 'stat' }, 'Una camera per ogni punto di ripresa (es. Prua, Poppa, Gommone). Gli spezzoni della stessa camera si mettono in fila da soli.')), drop);

    for (const [name, job] of this.jobs) {
      sec.append(h('div', { class: 'src-card' }, h('div', { class: 'src-head' }, h('b', null, name), h('span', { class: 'stat' }, job.label), h('div', { class: 'progress grow' }, h('i', { style: { width: (job.p * 100).toFixed(1) + '%' } })),
        job.abort ? h('button', { class: 'btn sm', onclick: () => job.abort.abort() }, 'Annulla') : null)));
    }
    for (const cam of m.cameras) sec.append(this.camCard(cam));
  },
  camCard(cam) {
    const m = this.meta;
    const card = h('div', { class: 'src-card' });
    const name = h('input', { type: 'text', value: cam.name, style: { width: '160px', fontWeight: 650 } });
    name.addEventListener('input', () => { cam.name = name.value || 'Camera'; this.save(); });
    name.addEventListener('change', () => this.renderVideo());
    const tel = h('input', { type: 'checkbox', checked: cam.telemetry !== false, onchange: e => { cam.telemetry = e.target.checked; this.save(); this.renderVideo(); } });
    const off = h('input', { type: 'number', step: 0.1, value: ((Number(cam.offset) || 0) / 1000).toFixed(2), style: { width: '100px' } });
    off.addEventListener('change', () => { cam.offset = Math.round(parseFloat(off.value || 0) * 1000); this.save(); this.renderCheck(); });
    const dur = cam.clips.reduce((a, c) => a + c.duration, 0);
    const hasGoPro = cam.clips.some(c => c.gpmd);
    card.append(h('div', { class: 'src-head' }, h('span', { class: 'badge' }, 'Camera'), name,
      h('span', { class: 'stat' }, `${cam.clips.length} ${cam.clips.length === 1 ? 'spezzone' : 'spezzoni'} · ${fmtDur(dur * 1000)}`),
      h('div', { class: 'sp' }),
      h('label', { class: 'f', style: { gridAutoFlow: 'column', alignItems: 'center' } }, 'Correzione orologio (s)', off),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Togliere la camera?', `La camera "${cam.name}" esce dall'uscita. I file video restano nella cartella.`, 'Togli', true)) { m.cameras = m.cameras.filter(c => c !== cam); this.save(); this.renderVideo(); this.renderCheck(); } } }, 'Togli')));
    if (hasGoPro) {
      const fs = cam.fineSync, okN = fs ? fs.clips.filter(c => c.ok).length : 0;
      card.append(h('div', { class: 'row small' },
        h('label', { class: 'chk' }, tel, 'Usa il GPS della GoPro (posizione e velocità, se era acceso)')),
        h('p', { class: 'stat' }, 'Heel, trim, rotazione e urti della GoPro non si usano: la camera non è fissata in modo rigido alla barca. Il suo giroscopio serve solo a trovare l\'ora esatta del video'
          + (fs ? (okN ? `: ${okN} ${okN === 1 ? 'spezzone affinato' : 'spezzoni affinati'} sul telefono del Logger.` : '.') : '.')));
    }
    const tb = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['File', 'Durata', 'Video', 'Inizio', 'Ora presa da', 'Camera', ''].map(x => h('th', null, x)))));
    const body = h('tbody');
    for (const cl of cam.clips) {
      const st = this.clipStartLocal(cam, cl);
      const tIn = h('input', { type: 'datetime-local', step: 1, value: st, style: { width: '200px' } });
      tIn.addEventListener('change', () => {
        const v = new Date(tIn.value).getTime();
        if (!isFinite(v)) return;
        cl.start = v - (Number(cam.offset) || 0); cl.startSrc = 'manual'; delete cl.fine;
        this.save(); this.renderVideo(); this.renderCheck();
      });
      const mv = h('select', { style: { width: '120px' } }, m.cameras.map(c => h('option', { value: c.id }, c.name)), h('option', { value: '__new' }, '+ nuova'));
      mv.value = cam.id;
      mv.addEventListener('change', () => {
        let dest = m.cameras.find(c => c.id === mv.value);
        if (!dest) { dest = this.newCam(); }
        cam.clips = cam.clips.filter(c => c !== cl); dest.clips.push(cl); dest.clips.sort((a, b) => a.start - b.start);
        if (!cam.clips.length) m.cameras = m.cameras.filter(c => c !== cam);
        this.save(); this.renderVideo(); this.renderCheck();
      });
      body.append(h('tr', null,
        h('td', null, h('b', null, cl.file.split('/').pop()), h('div', { class: 'stat' }, fmtBytes(cl.size), cl.device ? ' · ' + cl.device : '')),
        h('td', { class: 'num' }, fmtDur(cl.duration * 1000)),
        h('td', { class: 'stat' }, `${cl.w}×${cl.h} · ${fmtNum(cl.fps, cl.fps % 1 ? 2 : 0)} fps · ${cl.codec === 'hvc1' || cl.codec === 'hev1' ? 'HEVC' : cl.codec === 'avc1' ? 'H.264' : cl.codec}`),
        h('td', null, tIn),
        h('td', { class: 'stat ' + (cl.startSrc === 'gps' || cl.startSrc === 'logger' ? 'good' : cl.startSrc === 'mtime' ? 'warn' : '') }, START_SRC_LABEL[cl.startSrc] || cl.startSrc),
        h('td', null, mv),
        h('td', null, h('button', { class: 'icon-btn', title: 'Togli dall\'uscita', 'aria-label': 'Togli dall\'uscita', onclick: () => { cam.clips = cam.clips.filter(c => c !== cl); if (!cam.clips.length) m.cameras = m.cameras.filter(c => c !== cam); this.save(); this.renderVideo(); this.renderCheck(); } }, '✕'))));
    }
    tb.append(body);
    card.append(h('div', { class: 'tbl-wrap' }, tb));
    if (cam.clips.length && !cam.clips.some(c => c.startSrc === 'gps' || c.startSrc === 'logger')) card.append(h('p', { class: 'stat' }, 'Senza GPS nella camera l\'ora viene dall\'orologio della GoPro: di solito è giusta entro qualche secondo. La rifinitura si fa nel viewer con lo strumento di sincronizzazione (⏱ sul video).'));
    return card;
  },
  clipStartLocal(cam, cl) { const d = new Date(clipStartOf(cam, cl)); return `${ymdOf(d.getTime())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; },
  newCam() {
    const cam = { id: uid('c'), name: `Camera ${this.meta.cameras.length + 1}`, offset: 0, telemetry: true, clips: [] };
    this.meta.cameras.push(cam);
    return cam;
  },
  camFor() {
    let cam = this.meta.cameras.find(c => c.id === this.targetCam);
    if (!cam) { cam = this.newCam(); this.targetCam = cam.id; }
    return cam;
  },
  known(file) { return this.meta.cameras.some(c => c.clips.some(cl => cl.file === file)); },
  async addVideos(files, all = []) {
    const other = all.filter(f => DATA_RE.test(f.name));
    if (other.length) this.addData(other);
    if (!files.length) return;
    const cam = this.camFor();
    for (const file of files) {
      let dest = `video/${file.name}`;
      if (this.known(dest)) { toast(`${file.name} è già nell'uscita.`); continue; }
      const job = { p: 0, label: 'Leggo i metadati…', abort: null };
      this.jobs.set(file.name, job); this.renderVideo();
      try {
        const clip = await probeClip(file);
        if (await Store.exists(`${this.folder}/${dest}`)) {
          const ex = await Store.file(`${this.folder}/${dest}`);
          if (ex.size !== file.size) { dest = `video/${file.name.replace(/(\.\w+)$/, '_' + Date.now().toString(36) + '$1')}`; }
        }
        if (!(await Store.exists(`${this.folder}/${dest}`))) {
          job.abort = new AbortController(); job.label = 'Copio nella libreria…';
          const t0 = performance.now();
          await Store.copyIn(file, `${this.folder}/${dest}`, (p, done) => {
            job.p = p;
            const sec = (performance.now() - t0) / 1000, rate = done / Math.max(.1, sec);
            job.label = `Copio ${fmtBytes(done)} di ${fmtBytes(file.size)} · ${fmtBytes(rate)}/s · mancano ${fmtDur((file.size - done) / Math.max(1, rate) * 1000)}`;
            const bar = [...document.querySelectorAll('#secVideo .src-card')].find(el => el.textContent.startsWith(file.name));
            if (bar) { bar.querySelector('.progress i').style.width = (p * 100).toFixed(1) + '%'; bar.querySelector('.stat').textContent = job.label; }
          }, job.abort.signal);
        }
        clip.file = dest;
        cam.clips.push(clip);
        chainChapters(cam.clips);
        this.save();
      } catch (e) {
        toast(e.name === 'AbortError' ? `Copia di ${file.name} annullata.` : `${file.name}: ${errMsg(e)}`, 7000, 'bad');
        if (!cam.clips.length && !this.jobs.size) this.meta.cameras = this.meta.cameras.filter(c => c !== cam);
      }
      this.jobs.delete(file.name);
      this.renderVideo(); this.renderCheck();
    }
    if (!cam.clips.length) { this.meta.cameras = this.meta.cameras.filter(c => c !== cam); this.renderVideo(); }
    delete cam.sync;
    this.runAutoSync();
  },
  async scanFolder() {
    let entries = [];
    try { entries = await Store.list(`${this.folder}/video`); } catch (e) { await Store.dir(`${this.folder}/video`, true); }
    const fresh = entries.filter(e => e.kind === 'file' && VIDEO_RE.test(e.name) && !this.known(`video/${e.name}`) && !e.name.endsWith('.crswap'));
    if (!fresh.length) { toast('Nessun video nuovo nella cartella video di questa uscita.'); return; }
    const cam = this.camFor();
    let n = 0;
    for (const e of fresh) {
      const job = { p: .5, label: 'Leggo i metadati…' };
      this.jobs.set(e.name, job); this.renderVideo();
      try { const file = await e.handle.getFile(); const clip = await probeClip(file); clip.file = `video/${e.name}`; cam.clips.push(clip); n++; }
      catch (err) { toast(`${e.name}: ${errMsg(err)}`, 7000, 'bad'); }
      this.jobs.delete(e.name);
    }
    chainChapters(cam.clips);
    if (!cam.clips.length) this.meta.cameras = this.meta.cameras.filter(c => c !== cam);
    this.save(); this.renderVideo(); this.renderCheck();
    toast(`Aggiunti ${n} video a "${cam.name}".`);
    delete cam.sync;
    this.runAutoSync();
  },

  /* ---------- 3. Dati ---------- */
  secData() { const sec = h('section', { class: 'card ed-sec', id: 'secData' }); this.renderData(sec); return sec; },
  renderData(sec = $('#secData')) {
    if (!sec) return;
    sec.textContent = '';
    const input = h('input', { type: 'file', accept: '.csv,.txt,.tsv,.gpx,.fit,.tcx,.zip,text/csv', multiple: true, hidden: true, onchange: e => { this.addData([...e.target.files]); e.target.value = ''; } });
    const drop = h('div', { class: 'drop' },
      h('div', null, h('b', null, 'Trascina qui i file di dati')),
      h('div', { class: 'small' }, 'Orologio Garmin per la frequenza cardiaca (lo .zip di "Esporta file", oppure .fit, .tcx, .gpx) · cella di carico Cyclops (.csv) · Vakaros (.csv) · N17 Logger dell\'iPhone (.csv) · qualsiasi CSV con una colonna ora'),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => input.click() }, 'Scegli i file…'), h('button', { class: 'btn ghost', onclick: () => this.garminHelp() }, 'Come scarico i dati dal Garmin?')), input);
    this.dropZone(drop, files => this.addData(files.filter(f => DATA_RE.test(f.name)), files));
    sec.append(h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '2'), 'Dati'),
      h('span', { class: 'stat' }, 'Per ogni file l\'app mostra cosa ha trovato, con un\'anteprima di ogni grandezza. Togli la spunta a quello che non ti serve.')), drop);
    for (const src of this.meta.sources) sec.append(this.srcCard(src));
  },
  garminHelp(list) {
    const sail = (list || []).filter(a => /vela|sail/i.test(a.type + ' ' + a.title));
    const near = sail.filter(a => a.date && a.date.slice(0, 10) === this.meta.date);
    modal({ title: list ? 'Questo è l\'elenco delle attività, non i dati' : 'Scaricare i dati dal Garmin', wide: true, body: h('div', { style: { display: 'grid', gap: '12px' } },
      list ? h('p', null, `Il file contiene ${list.length} attività, una per riga, con solo medie e massimi (FC media, velocità max…). Per vedere i dati nel tempo, con battiti, velocità e posizione secondo per secondo, serve il file della singola attività.`) : null,
      h('ol', { style: { margin: 0, paddingLeft: '20px', lineHeight: 1.7 } },
        h('li', null, 'Sul computer apri ', h('b', null, 'connect.garmin.com'), ' e vai su Attività.'),
        h('li', null, 'Apri l\'uscita in barca (tipo "Navigazione a vela").'),
        h('li', null, 'In alto a destra premi l\'icona dell\'ingranaggio ⚙ e scegli ', h('b', null, '"Esporta file"'), ' (in alcune versioni si chiama "Esporta originale").'),
        h('li', null, 'Scarichi un file .zip: trascinalo qui così com\'è, senza aprirlo.')),
      h('p', { class: 'muted' }, 'Dentro c\'è il file .fit con quello che l\'orologio ha registrato. Il Debrief ne usa la frequenza cardiaca; posizione e velocità le prende dal telefono e dagli altri strumenti. Le altre grandezze dell\'orologio restano disponibili, basta mettere la spunta. Vanno bene anche "Esporta in TCX" o "Esporta in GPX".'),
      sail.length ? h('div', null, h('b', null, 'Uscite in barca nel file che hai caricato:'),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '20px' } }, sail.map(a => h('li', { style: near.includes(a) ? { fontWeight: 700 } : null }, `${a.date} · ${a.title || a.type}${a.dur ? ' · ' + a.dur : ''}${near.includes(a) ? '  ← stesso giorno di questa uscita' : ''}`)))) : null),
      actions: [{ label: 'Ho capito', kind: 'primary' }] });
  },
  async addData(files, all = []) {
    const vids = all.filter(f => VIDEO_RE.test(f.name));
    if (vids.length) this.addVideos(vids);
    for (const file of files) {
      try {
        let name = file.name, kind = trackKindOf(name), data;
        if (/\.zip$/i.test(name)) {
          const z = await unzipFirst(await file.arrayBuffer(), /\.(fit|tcx|gpx)$/i);
          if (!z) throw new Error('Nello ZIP non c\'è un file .fit, .tcx o .gpx.');
          name = z.name.split('/').pop(); kind = trackKindOf(name); data = kind === 'FIT' ? z.data : new TextDecoder().decode(z.data);
        } else data = kind === 'FIT' ? await file.arrayBuffer() : await file.text();
        const dest = `dati/${name}`;
        if (this.meta.sources.some(s => s.file === dest)) { toast(`${name} è già nell'uscita.`); continue; }
        let src;
        if (kind) {
          const track = readTrack(kind, data);
          src = Object.assign({ id: uid('s'), file: dest, kind, name: kind === 'FIT' ? 'Garmin' : name.replace(/\.\w+$/, '') }, guessTrackConfig(track, kind));
          this.tabs.set(src.id, { track });
        } else {
          const tab = parseTable(data), cols = analyzeCols(tab);
          const list = garminActivityList(tab);
          if (list) { this.garminHelp(list); continue; }
          const cfg = guessSourceConfig(tab, cols);
          src = Object.assign({ id: uid('s'), file: dest, name: cfg.kind === 'CSV' ? name.replace(/\.\w+$/, '') : cfg.kind === 'Vakaros' ? 'Vakaros Atlas 2' : cfg.kind === 'iPhone' ? 'iPhone' : 'Cyclops' }, cfg);
          this.tabs.set(src.id, { tab, cols });
        }
        // stessa registrazione del telefono già presente?
        if (src.kind === 'iPhone' && !src.live && src.recId && this.meta.sources.some(x => x.kind === 'iPhone' && !x.live && x.recId === src.recId)) { toast('Questa registrazione del telefono è già nella giornata.'); continue; }
        // file del telefono di un altro giorno: lo metto nella sua giornata, non qui
        if (src.kind === 'iPhone' && !src.live) {
          const day = phoneFileDay(this.tabs.get(src.id).tab);
          if (day && day !== this.meta.date) {
            const ok = await confirmBox('Questo file è di un altro giorno', `La registrazione del telefono "${name}" è del ${fmtDateLong(day)}, questa giornata è del ${fmtDateLong(this.meta.date)}. La metto nella giornata del ${fmtDateLong(day)}?`, 'Sì, nel giorno giusto');
            if (ok) { const r = await importPhoneFile(file); toast(r.msg, 8000); continue; }
          }
        }
        await Store.writeText(`${this.folder}/${dest}`, data);
        this.meta.sources.push(src);
        this.save();
        this.rebuild(src, false);
        let extra = '';
        if (src.kind === 'iPhone' && !src.live) {
          const rl = this.replaceLive(src), sg = this.importSegments(data), bo = importBuoysInto(this.meta, data);
          if (bo) { this.save(); extra += ` ${bo} ${bo === 1 ? 'boa segnata' : 'boe segnate'} sul telefono (si vedono sulla mappa).`; }
          if (rl) extra += ` Ha preso il posto dei dati ricevuti in live (stessa registrazione): niente doppioni, eventi e tratti restano.`;
          if (sg) extra += ` Aggiunti ${sg} tratti segnati sul telefono.`;
        }
        const n = ((this.channels.get(src.id) || {}).list || []).length;
        toast(n ? `${src.name}: trovate ${n} grandezze.${extra}` : `${src.name}: nessun dato letto, controlla le impostazioni qui sotto.`, extra ? 10000 : 6000);
      } catch (e) { toast(`${file.name}: ${errMsg(e)}`, 8000, 'bad'); }
    }
    this.renderData(); this.renderCheck();
    for (const cam of this.meta.cameras) if (cam.sync && cam.sync.method === 'gyro') delete cam.sync;
    this.runAutoSync();
  },
  /* il file completo del telefono prende il posto dei dati ricevuti in live della stessa registrazione
     (stesso codice di registrazione, oppure stessi orari per i file più vecchi). Eventi e tratti restano. */
  replaceLive(full) {
    const span = id => { const l = (this.channels.get(id) || {}).list || []; return l.length ? [Math.min(...l.map(c => c.t[0])), Math.max(...l.map(c => c.t[c.t.length - 1]))] : null; };
    const fs = span(full.id);
    const lives = this.meta.sources.filter(x => x.kind === 'iPhone' && x.live && x !== full && ((full.recId && x.recId === full.recId) || (() => { const ls = span(x.id); return fs && ls && ls[0] < fs[1] && fs[0] < ls[1]; })()));
    if (!lives.length) return 0;
    this.meta.sources = this.meta.sources.filter(x => !lives.includes(x));
    for (const x of lives) this.channels.delete(x.id);
    this.save();
    return lives.length;
  },
  /* tratti segnati sul telefono (tasto "Inizia / Fine tratto") scritti nel file: diventano tratti dell'uscita */
  importSegments(text) { return importSegmentsInto(this.meta, text, () => this.save()); },
  async parseAll() {
    for (const src of this.meta.sources) {
      try {
        if (TRACK_KINDS.includes(src.kind)) {
          const f = await Store.file(`${this.folder}/${src.file}`);
          const track = readTrack(src.kind, src.kind === 'FIT' ? await f.arrayBuffer() : await f.text());
          if (!src.columns) src.columns = guessTrackConfig(track, src.kind).columns;
          this.tabs.set(src.id, { track });
        } else {
          const text = await Store.readText(`${this.folder}/${src.file}`);
          const tab = parseTable(text), cols = analyzeCols(tab); this.tabs.set(src.id, { tab, cols });
        }
        this.rebuild(src, false);
      } catch (e) { this.channels.set(src.id, { error: errMsg(e) }); }
    }
    this.renderData(); this.renderCheck();
  },
  rebuild(src, rerender = true) {
    const T = this.tabs.get(src.id);
    try {
      let list;
      if (T && T.track) list = buildTrackChannels(T.track, src, src.id, src.name);
      else list = buildChannels(T.tab, T.cols, Object.assign({ baseDate: this.meta.date }, src), src.id, src.name);
      this.channels.set(src.id, { list });
    } catch (e) { this.channels.set(src.id, { error: errMsg(e), list: [] }); }
    if (rerender) {
      this.renderCheck();
      const st = $(`#st-${src.id}`); if (st) st.replaceWith(this.srcStat(src));
      for (const c of src.columns || []) { const el = document.getElementById(`pv-${src.id}-${c.col}`); if (el) el.replaceWith(this.preview(src, c)); }
    }
  },
  srcStat(src) {
    const r = this.channels.get(src.id) || {};
    if (r.error) return h('div', { class: 'stat bad', id: `st-${src.id}` }, r.error);
    const list = r.list || [];
    if (!list.length) return h('div', { class: 'stat warn', id: `st-${src.id}` }, 'Nessun dato letto. Controlla la colonna dell\'ora e metti la spunta su almeno una grandezza.');
    const a = Math.min(...list.map(c => c.t[0])), b = Math.max(...list.map(c => c.t[c.t.length - 1]));
    const hz = 1000 / list[0].step;
    const T = this.tabs.get(src.id);
    const otherDay = ymdOf(a) !== this.meta.date, manyDays = b - a > 2 * 86400e3;
    return h('div', { class: 'stat ' + (otherDay || manyDays ? 'warn' : 'good'), id: `st-${src.id}` },
      `✓ ${list.filter(c => c.role !== 'lat' && c.role !== 'lon').length} grandezze${list.some(c => c.role === 'lat') ? ' + posizione GPS' : ''} · ${T && T.tab ? T.tab.data.length.toLocaleString('it-IT') + ' righe · ' : ''}${hz >= 1 ? fmtNum(hz, hz < 10 ? 1 : 0) + ' campioni al secondo' : 'un campione ogni ' + fmtNum(1 / hz, 0) + ' s'} · dalle ${fmtClock(a)} alle ${fmtClock(b)} (${fmtDur(b - a)})`,
      manyDays ? ' · attenzione: le righe coprono più giorni, sembra un riepilogo e non una registrazione' : otherDay ? ` · attenzione: i dati sono del ${new Date(a).toLocaleDateString('it-IT')}, non del giorno dell'uscita` : '');
  },
  // piccolo grafico di una grandezza, per vedere subito se i dati ci sono
  preview(src, c) {
    const id = `pv-${src.id}-${c.col}`;
    const list = (this.channels.get(src.id) || {}).list || [];
    const ch = list.find(x => x.id === `${src.id}:${c.col}`);
    if (!c.use) return h('span', { id, class: 'faint small' }, 'non usata');
    if (!ch) return h('span', { id, class: 'stat warn' }, 'nessun valore');
    const W = 120, H = 24, cv = h('canvas', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px', verticalAlign: 'middle' } });
    const ctx = cv.getContext('2d'), n = ch.t.length, st = Math.max(1, Math.floor(n / W));
    const lo = ch.min, hi = ch.max === ch.min ? ch.min + 1 : ch.max;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent'); ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0, k = 0; i < n; i += st, k++) { const x = (ch.t[i] - ch.t[0]) / ((ch.t[n - 1] - ch.t[0]) || 1) * W * 2, y = H * 2 - 2 - (ch.v[i] - lo) / (hi - lo) * (H * 2 - 4); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    return h('span', { id, class: 'row', style: { gap: '8px', flexWrap: 'nowrap' } }, cv, h('span', { class: 'stat num' }, ch.circular ? '' : `${fmtVal(ch, ch.min)} – ${fmtVal(ch, ch.max)}`));
  },
  srcCard(src) {
    const card = h('div', { class: 'src-card' });
    const name = h('input', { type: 'text', value: src.name, style: { width: '190px', fontWeight: 650 } });
    name.addEventListener('change', () => { src.name = name.value || src.file; this.save(); this.renderCheck(); });
    const others = this.posSources().filter(s => s.id !== src.id);
    const hasPos = this.posSources().some(s => s.id === src.id);
    const T = this.tabs.get(src.id);
    const isTrack = TRACK_KINDS.includes(src.kind);
    card.append(h('div', { class: 'src-head' }, h('span', { class: 'badge' }, src.kind), name, h('span', { class: 'stat' }, src.file.split('/').pop()), h('div', { class: 'sp' }),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Togliere il file?', `"${src.name}" esce dall'uscita. Il file resta nella cartella dati.`, 'Togli', true)) { this.meta.sources = this.meta.sources.filter(s => s !== src); this.channels.delete(src.id); this.save(); this.renderData(); this.renderCheck(); } } }, 'Togli')));
    card.append(this.srcStat(src));
    const ctl = h('div', { class: 'row', style: { alignItems: 'flex-start' } });
    const help = (el, text) => h('div', { style: { display: 'grid', gap: '4px', maxWidth: '260px' } }, el, h('span', { class: 'faint small' }, text));
    if (T && T.tab) {
      const tsel = h('select', null, T.cols.map(c => h('option', { value: c.j }, c.name + (c.time ? '' : ' (non sembra un orario)'))));
      tsel.value = src.timeCol;
      tsel.addEventListener('change', () => { src.timeCol = Number(tsel.value); this.save(); this.rebuild(src); });
      ctl.append(help(h('label', { class: 'f' }, 'Colonna dell\'ora', tsel), 'La colonna che dice a che ora è stata presa ogni riga. Di solito la trovo da solo.'));
      const tz = h('div', { class: 'seg' }, [['local', 'Ora locale'], ['utc', 'UTC']].map(([v, l]) => h('button', { class: (src.tz || 'local') === v ? 'on' : '', onclick: () => { src.tz = v; this.save(); this.rebuild(src); this.renderData(); } }, l)));
      ctl.append(help(h('div', { class: 'f' }, 'Gli orari del file sono in', tz), 'Quasi tutti gli strumenti usano l\'ora locale. Se video e dati risultano spostati di 1 o 2 ore, prova UTC.'));
    } else if (isTrack) ctl.append(help(h('div', { class: 'f' }, 'Orari', h('b', { style: { color: 'var(--fg)', fontWeight: 600 } }, 'presi dal GPS (esatti)')), 'I file FIT, TCX e GPX hanno l\'ora del satellite: di solito non serve correggere niente.'));
    const off = h('input', { type: 'number', step: 0.1, value: src.offset || 0, style: { width: '110px' } });
    off.addEventListener('change', () => { src.offset = parseFloat(off.value) || 0; this.save(); this.rebuild(src); });
    ctl.append(help(h('label', { class: 'f' }, 'Spostamento (secondi)', off), 'Se l\'orologio dello strumento era avanti metti un numero negativo, se era indietro positivo.'));
    if (hasPos && others.length) {
      const ref = h('select', null, others.map(s => h('option', { value: s.id }, s.name)));
      ctl.append(help(h('div', { class: 'f' }, 'Allinea l\'orologio con il GPS di', h('div', { class: 'row' }, ref, h('button', { class: 'btn sm', onclick: () => this.align(src, ref.value, off) }, 'Allinea'))), 'Confronta le due tracce e trova da solo lo spostamento giusto.'));
    }
    card.append(ctl);
    if (src.columns && T && (T.tab || T.track)) {
      const tb = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Usa', isTrack ? 'Nel file' : 'Colonna', 'Nome', 'Unità', 'Grandezza', 'Anteprima e valori', '× fattore', '+ costante'].map(x => h('th', null, x)))));
      const body = h('tbody');
      for (const c of src.columns) {
        const ch = (k, el, num) => { el.addEventListener('change', () => { c[k] = el.type === 'checkbox' ? el.checked : num ? (parseFloat(el.value) || (k === 'k' ? 1 : 0)) : el.value; this.save(); this.rebuild(src); }); return el; };
        const role = h('select', null, Object.entries(ROLE_LABEL).filter(([k]) => k !== 'time').map(([k, l]) => h('option', { value: k }, l)));
        role.value = c.role;
        body.append(h('tr', null,
          h('td', null, ch('use', h('input', { type: 'checkbox', checked: c.use }))),
          h('td', { class: 'stat' }, c.col),
          h('td', null, ch('name', h('input', { type: 'text', value: c.name, style: { width: '160px' } }))),
          h('td', null, ch('unit', h('input', { type: 'text', value: c.unit, style: { width: '64px' } }))),
          h('td', null, ch('role', role)),
          h('td', null, this.preview(src, c)),
          h('td', null, ch('k', h('input', { type: 'number', step: 'any', value: c.k ?? 1, style: { width: '70px' } }), true)),
          h('td', null, ch('add', h('input', { type: 'number', step: 'any', value: c.add ?? 0, style: { width: '70px' } }), true))));
      }
      tb.append(body);
      card.append(h('div', { class: 'tbl-wrap' }, tb));
      card.append(h('p', { class: 'stat' }, '"Grandezza" dice all\'app cos\'è ogni colonna (velocità, posizione, carico…): serve per mappa, manovre e calcoli. Fattore e costante correggono i valori: per una velocità in m/s usa fattore 1,944 e unità kn; per la tara della cella di carico usa la costante (es. −12).'));
      if (T.tab) card.append(h('details', null, h('summary', null, 'Prime righe del file'), h('pre', { class: 'preview' }, T.tab.preview)));
    }
    return card;
  },
  posSources() {
    const out = [];
    for (const src of this.meta.sources) {
      const l = (this.channels.get(src.id) || {}).list || [];
      const lat = l.find(c => c.role === 'lat'), lon = l.find(c => c.role === 'lon');
      if (lat && lon) out.push({ id: src.id, name: src.name, lat, lon });
    }
    return out;
  },
  align(src, refId, offInput) {
    const ps = this.posSources(), me = ps.find(s => s.id === src.id), ref = ps.find(s => s.id === refId);
    if (!me || !ref) return;
    const r = alignTracks(ref.lat, ref.lon, me.lat, me.lon);
    if (!r.ok) { toast('Allineamento non riuscito: ' + r.why, 7000, 'bad'); return; }
    src.offset = Math.round(((parseFloat(src.offset) || 0) + r.off / 1000) * 10) / 10;
    offInput.value = src.offset;
    this.save(); this.rebuild(src);
    toast(`Allineato: "${src.name}" spostato di ${fmtNum(r.off / 1000, 1)} s. Distanza mediana fra le tracce: ${Math.max(1, Math.round(r.dist))} m.`, 7000);
  },

  /* ---------- 4. Controllo ---------- */
  secCheck() { const sec = h('section', { class: 'card ed-sec', id: 'secCheck' }); this.renderCheck(sec); return sec; },
  renderCheck(sec = $('#secCheck')) {
    if (!sec) return;
    sec.textContent = '';
    sec.append(h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '3'), 'Sincronizzazione'),
      h('span', { class: 'stat' }, 'Video e dati devono sovrapporsi sullo stesso orario. Se una barra è fuori posto, correggi l\'orologio della camera o lo spostamento del file.')));
    const rows = [];
    const m = this.meta;
    m.cameras.forEach((cam, i) => rows.push({ label: cam.name, kind: 'cam', color: seriesColor(i), spans: cam.clips.map(cl => { const s = clipStartOf(cam, cl); return [s, s + cl.duration * 1000]; }) }));
    m.sources.forEach((src, i) => {
      const l = (this.channels.get(src.id) || {}).list || [];
      if (!l.length) return;
      // tratti continui (salta i buchi oltre 30 s)
      const c = l.find(x => x.role !== 'lat' && x.role !== 'lon') || l[0];
      const spans = []; let a = c.t[0], prev = c.t[0];
      for (let k = 1; k < c.t.length; k++) { if (c.t[k] - prev > 30000) { spans.push([a, prev]); a = c.t[k]; } prev = c.t[k]; }
      spans.push([a, prev]);
      rows.push({ label: src.name, kind: 'src', color: 'var(--muted)', spans });
    });
    if (!rows.length) { sec.append(h('p', { class: 'muted' }, 'Carica almeno un video o un file di dati.')); return; }
    const both = intersectSpans(mergeSpans(rows.filter(r => r.kind === 'cam').flatMap(r => r.spans)), mergeSpans(rows.filter(r => r.kind === 'src').flatMap(r => r.spans))).filter(x => x[1] - x[0] >= 5000);
    if (rows.some(r => r.kind === 'cam') && rows.some(r => r.kind === 'src')) rows.push({ label: 'Video + dati', kind: 'both', color: 'var(--good)', spans: both });
    let t0 = Infinity, t1 = -Infinity;
    for (const r of rows) for (const [a, b] of r.spans) { t0 = Math.min(t0, a); t1 = Math.max(t1, b); }
    const pad = (t1 - t0) * .03 || 60000; t0 -= pad; t1 += pad;
    const x = t => ((t - t0) / (t1 - t0) * 100).toFixed(3) + '%';
    const wrap = h('div', { class: 'cover' });
    for (const r of rows) {
      const lane = h('div', { class: 'cover-lane' });
      for (const [a, b] of r.spans) lane.append(h('i', { style: { left: x(a), width: `calc(${x(b)} - ${x(a)} + 2px)`, background: r.color }, title: `${fmtClock(a)} – ${fmtClock(b)}` }));
      wrap.append(h('div', { class: 'cover-row' }, h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: r.kind === 'both' ? 700 : 400 } }, r.kind === 'cam' ? '🎥 ' : r.kind === 'src' ? '📈 ' : '✓ ', r.label), lane));
    }
    const axis = h('div', { class: 'cover-axis' });
    const span = t1 - t0, stepM = [1, 2, 5, 10, 15, 30, 60, 120].find(mm => span / (mm * 60000) <= 9) || 240;
    const first = Math.ceil(t0 / (stepM * 60000)) * stepM * 60000;
    for (let t = first; t < t1; t += stepM * 60000) axis.append(h('span', { style: { left: x(t) } }, fmtClock(t).slice(0, 5)));
    wrap.append(axis);
    sec.append(wrap);
    // avvisi
    const notes = [];
    const camRows = rows.filter(r => r.kind === 'cam'), srcRows = rows.filter(r => r.kind === 'src');
    const overlap = (A, B) => A.spans.some(([a, b]) => B.spans.some(([c, d]) => a < d && c < b));
    for (const c of camRows) if (srcRows.length && !srcRows.some(s => overlap(c, s))) notes.push(`Il video "${c.label}" non si sovrappone a nessun file di dati: controlla data, ora della camera o fuso orario dei dati.`);
    for (const s of srcRows) if (camRows.length && !camRows.some(c => overlap(c, s))) notes.push(`I dati "${s.label}" non si sovrappongono a nessun video.`);
    if (!m.twd) notes.push('Manca la direzione del vento: le manovre verranno segnate come "manovra" invece di virata o strambata.');
    for (const n of notes) sec.append(h('p', { class: 'stat warn' }, n));
    if (both.length) sec.append(h('p', { class: 'stat good' }, `✓ Video e dati insieme per ${fmtDur(both.reduce((a, x) => a + x[1] - x[0], 0))} (riga verde): lì puoi analizzare le manovre con le immagini.`));
    else if (!notes.length) sec.append(h('p', { class: 'stat good' }, 'Tutto in ordine.'));
    const box = h('div', { class: 'src-card', style: { marginTop: '6px' } },
      h('div', { class: 'src-head' }, h('b', null, 'Sincronizzazione automatica'), h('div', { class: 'sp' }),
        h('button', { class: 'btn sm', disabled: !!this.syncing, onclick: () => this.runAutoSync(true) }, this.syncing ? 'Sto sincronizzando…' : 'Rifai da capo')));
    if (this.syncMsg) box.append(h('div', { class: 'stat' }, this.syncMsg));
    for (const r of this.syncReport || []) box.append(h('div', { class: 'stat ' + (r.ok ? 'good' : 'warn') }, `${r.ok ? '✓' : '!'} ${r.what}: ${r.text}`));
    box.append(h('p', { class: 'faint small', style: { margin: 0 } }, 'Parte da sola ogni volta che carichi video o dati. GoPro: confronta il giroscopio della camera con le virate viste dal GPS (precisione di un decimo di secondo; la camera deve essere fissata alla barca). Telefono: usa nome del file e metadati. Strumenti con l\'orologio del telefono (Cyclops): sovrappone le tracce GPS. Quello che sistemi a mano con ⏱ nel viewer non viene toccato, a meno che premi "Rifai da capo".'));
    sec.append(box);
  },

  dropZone(el, onFiles) {
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
  }
};
// trascinare file fuori dalle zone non deve aprirli nel browser
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ---------- File del telefono: ognuno nella giornata del suo giorno ---------- */
/* giorno di una registrazione del telefono: dall'intestazione ("inizio …"), altrimenti dalla prima riga */
function phoneFileDay(tab) {
  const m = /inizio\s+(\S+)/.exec(tab.meta || '');
  let t = m ? Date.parse(m[1]) : NaN;
  if (!isFinite(t)) { const j = tab.header.indexOf('time_utc'); if (j >= 0 && tab.data.length) t = Date.parse(tab.data[0][j]); }
  return isFinite(t) ? ymdOf(t) : null;
}
/* tratti scritti nel file del telefono (dal suo tasto o mandati dal gommone con N17 Live) */
function importSegmentsInto(meta, text, save) {
  const marks = [...text.matchAll(/^# tratto (inizio|fine) (\S+)/gm)].map(m => [m[1], Date.parse(m[2])]).filter(m => isFinite(m[1]));
  let open = null, n = 0;
  for (const [k, t] of marks) {
    if (k === 'inizio') open = t;
    else if (open != null) {
      const dup = meta.events.some(e => e.type === 'tratto' && Math.abs(e.t - open) < 3000);
      if (!dup) { meta.events.push({ id: uid('e'), t: open, t2: t, type: 'tratto', note: `Tratto ${meta.events.filter(e => e.type === 'tratto').length + 1}`, by: 'telefono' }); n++; }
      else { const e = meta.events.find(e => e.type === 'tratto' && Math.abs(e.t - open) < 3000); if (e.t2 == null) e.t2 = t; }
      open = null;
    }
  }
  if (n) { meta.events.sort((a, b) => a.t - b.t); save && save(); }
  return n;
}
/* boe segnate col tasto "Boa" del Logger ("# boa <ora> <lat> <lon> ±<m> m"): vanno in meta.buoys.
   Ogni tocco resta com'è (ora e posizione); la mappa poi unisce i tocchi della stessa boa. Restituisce quante sono nuove. */
function importBuoysInto(meta, text) {
  const found = [...text.matchAll(/^# boa (\S+)(?: (-?\d+\.\d+) (-?\d+\.\d+)(?: ±(\d+(?:\.\d+)?) m)?)?/gm)]
    .map(m => ({ t: Date.parse(m[1]), lat: m[2] != null ? Number(m[2]) : null, lon: m[3] != null ? Number(m[3]) : null, acc: m[4] != null ? Number(m[4]) : null }))
    .filter(b => isFinite(b.t));
  if (!found.length) return 0;
  meta.buoys = meta.buoys || [];
  let n = 0;
  for (const b of found) {
    if (meta.buoys.some(x => Math.abs(x.t - b.t) < 1000)) continue;
    meta.buoys.push(Object.assign({ id: uid('b'), by: 'telefono' }, b)); n++;
  }
  if (n) meta.buoys.sort((a, b) => a.t - b.t);
  return n;
}
/* importa un file del Logger nella giornata del suo giorno (la crea se non c'è).
   Sostituisce i dati ricevuti in live della stessa registrazione; eventi e tratti restano. */
/* video del Logger (o dell'iPhone): va nella giornata del suo giorno, nella camera "iPhone" */
async function importPhoneVideo(file, onStep, handle = null, days = null) {
  const clip = await probeClip(file);
  // GoPro senza GPS: l'ora del suo orologio basta per trovare il giorno; quella esatta la trova poi la sincronizzazione
  const gopro = !!(clip.gpmd || clip.gopro);
  if (!['logger', 'apple', 'gps'].includes(clip.startSrc) && !gopro) return { ok: false, msg: `${file.name}: non trovo l'ora esatta del video. Caricalo aprendo la giornata (Video e dati).` };
  const day = ymdOf(clip.start);
  if (gopro && clip.startSrc !== 'gps' && !(days && days.has(day)) && !(await Store.listSessions()).some(x => x.meta.date === day))
    return { ok: false, msg: `${file.name}: secondo l'orologio della GoPro è del ${fmtDateLong(day)}, ma quel giorno non ci sono dati. Controlla data e ora della GoPro, oppure caricalo aprendo la giornata giusta (Video e dati).` };
  const folder = await Store.dayFolder(day);
  const meta = await Store.readJSON(`${folder}/${SESSION_FILE}`);
  // AirDrop rinomina i doppioni ("N17_… 2.mov"): tengo il nome originale e riconosco il video dall'ora
  const dest = `video/${file.name.replace(/ \d+(\.\w+)$/, '$1')}`;
  if (meta.cameras.some(c => c.clips.some(cl => cl.file === dest || (Math.abs(cl.start - clip.start) < 50 && Math.abs(cl.duration - clip.duration) < 0.1)))) return { ok: true, day, folder, dup: true, msg: `${file.name}: c'era già nella giornata del ${fmtDateLong(day)}.` };
  const name = gopro ? 'GoPro' : clip.startSrc === 'logger' ? 'iPhone (Logger)' : 'iPhone';
  const findCam = m => m.cameras.find(c => c.name === name) || (gopro ? m.cameras.find(c => c.clips.some(cl => cl.gpmd)) : null);
  let cam = findCam(meta);
  if (!cam) { cam = { id: uid('c'), name, offset: 0, telemetry: gopro, clips: [] }; meta.cameras.push(cam); }
  let moved = false, moveErr = '';
  if (!(await Store.exists(`${folder}/${dest}`)) || (await Store.file(`${folder}/${dest}`)).size !== file.size) {
    // dalla cartella "Da importare" (stesso disco) provo a spostarlo: niente copia di molti GB
    if (handle && typeof handle.move === 'function') {
      // prima con lo stesso nome (come per "Importati", che funziona sul disco esterno), poi col nome nuovo
      const vdir = await Store.dir(`${folder}/video`, true), target = dest.split('/').pop();
      for (const tryMove of target === file.name ? [() => handle.move(vdir), () => handle.move(vdir, target)] : [() => handle.move(vdir, target)]) {
        try { await tryMove(); moved = true; break; } catch (e) { moveErr = errMsg(e); }
      }
    }
    if (!moved) {
      onStep && onStep(`copio ${file.name} (${fmtBytes(file.size)})${moveErr ? ': spostarlo non è riuscito' : ''}…`);
      let shown = 0;
      await Store.copyIn(file, `${folder}/${dest}`, (p) => { if (onStep && p - shown >= 0.1) { shown = p; onStep(`copio ${file.name}: ${Math.round(p * 100)}%`); } });
    }
  }
  clip.file = dest;
  // rileggo l'uscita adesso: durante una copia lunga qualcun altro può averla salvata
  const fresh = (await Store.readJSON(`${folder}/${SESSION_FILE}`)) || meta;
  let fc = fresh.cameras.find(c => c.id === cam.id) || findCam(fresh);
  if (!fc) { fc = cam; fc.clips = []; fresh.cameras.push(fc); }
  if (!fc.clips.some(cl => cl.file === dest)) fc.clips.push(clip);
  if (gopro) {
    // capitoli GX02, GX03… in fila al primo; la camera va risincronizzata con i video nuovi
    chainChapters(fc.clips);
    if (clip.startSrc !== 'gps') { delete fc.sync; delete fc.fineSync; for (const cl of fc.clips) delete cl.fine; }
  }
  fc.clips.sort((a, b) => a.start - b.start);
  await Store.saveSession(folder, fresh);
  const t = new Date(clip.start);
  return { ok: true, day, folder, moved, gopro: gopro && clip.startSrc !== 'gps', msg: `${file.name} → giornata del ${fmtDateLong(day)}, video delle ${p2(t.getHours())}:${p2(t.getMinutes())} (${fmtDur(clip.duration * 1000)}${clip.startSrc === 'logger' || clip.startSrc === 'gps' ? ', già allineato ai dati' : gopro ? ', da sincronizzare' : ''})${moveErr && handle ? `. Non sono riuscito a spostarlo (${moveErr}): l'ho copiato, l'originale resta in «Importati» e puoi cancellarlo` : ''}.` };
}

/* video nella cartella "video" della giornata ma non nell'elenco (copiati a mano, o un salvataggio li ha persi):
   li leggo e li aggiungo. Ritorna quanti. */
async function adoptOrphanVideos(folder, meta) {
  let entries = [];
  try { entries = await Store.list(`${folder}/video`); } catch (e) { return 0; }
  const known = new Set(meta.cameras.flatMap(c => c.clips.map(cl => cl.file)));
  let n = 0;
  for (const e of entries) {
    if (e.kind !== 'file' || !VIDEO_RE.test(e.name) || e.name.startsWith('.') || e.name.endsWith('.crswap') || known.has(`video/${e.name}`)) continue;
    let clip;
    try { clip = await probeClip(await e.handle.getFile()); } catch (err) { continue; }
    if (!(clip.duration > 0)) continue;
    clip.file = `video/${e.name}`;
    const name = clip.startSrc === 'logger' ? 'iPhone (Logger)' : clip.gpmd || clip.gopro ? 'GoPro' : 'Camera';
    let cam = meta.cameras.find(c => c.name === name) || (name === 'Camera' ? meta.cameras[0] : null);
    if (!cam) { cam = { id: uid('c'), name, offset: 0, telemetry: name === 'GoPro', clips: [] }; meta.cameras.push(cam); }
    cam.clips.push(clip); cam.clips.sort((a, b) => a.start - b.start);
    n++;
  }
  return n;
}

async function importPhoneFile(file) {
  const text = await file.text();
  const tab = parseTable(text), cols = analyzeCols(tab), cfg = guessSourceConfig(tab, cols);
  if (cfg.kind !== 'iPhone') return { ok: false, msg: `${file.name}: non è un file del Logger. Gli altri file (video, Garmin, Cyclops…) si caricano aprendo la giornata.` };
  const day = phoneFileDay(tab);
  if (!day) return { ok: false, msg: `${file.name}: non trovo la data della registrazione.` };
  const folder = await Store.dayFolder(day);
  const meta = await Store.readJSON(`${folder}/${SESSION_FILE}`);
  const dest = `dati/${file.name}`;
  if ((cfg.recId && meta.sources.some(x => x.kind === 'iPhone' && !x.live && x.recId === cfg.recId)) || meta.sources.some(x => x.file === dest))
    return { ok: true, day, folder, dup: true, msg: `${file.name}: c'era già nella giornata del ${fmtDateLong(day)}.` };
  await Store.writeText(`${folder}/${dest}`, text);
  const lives = meta.sources.filter(x => x.kind === 'iPhone' && x.live && cfg.recId && x.recId === cfg.recId);
  meta.sources = meta.sources.filter(x => !lives.includes(x));
  meta.sources.push(Object.assign({ id: uid('s'), file: dest, name: 'iPhone' }, cfg));
  const seg = importSegmentsInto(meta, text), boe = importBuoysInto(meta, text);
  await Store.saveSession(folder, meta);
  const extra = [lives.length ? 'ha preso il posto dei dati ricevuti in live' : '', seg ? `${seg} ${seg === 1 ? 'tratto' : 'tratti'}` : '', boe ? `${boe} ${boe === 1 ? 'boa segnata' : 'boe segnate'}` : ''].filter(Boolean).join(', ');
  return { ok: true, day, folder, msg: `${file.name} → giornata del ${fmtDateLong(day)}${extra ? ' (' + extra + ')' : ''}.` };
}
