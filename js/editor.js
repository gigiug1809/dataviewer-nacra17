/* Pagina "Video e dati": scheda dell'uscita, caricamento di video e file di dati, controllo della sincronizzazione */
'use strict';
const VIDEO_RE = /\.(mp4|mov|m4v|lrv)$/i;
const DATA_RE = /\.(csv|txt|tsv|gpx)$/i;

const Editor = {
  folder: null, meta: null, tabs: new Map(), jobs: new Map(), channels: new Map(), targetCam: '',
  async open(folder) {
    this.folder = folder; this.tabs.clear(); this.channels.clear();
    if (folder) {
      this.meta = await Store.readJSON(`${folder}/${SESSION_FILE}`);
      if (!this.meta) { toast('Uscita non trovata.'); Router.go('#/'); return; }
    } else this.meta = newSessionMeta();
    this.render();
    if (folder) this.parseAll();
  },
  save: debounce(function () { if (Editor.folder) Store.saveSession(Editor.folder, Editor.meta).catch(e => toast('Salvataggio non riuscito: ' + errMsg(e), 8000, 'bad')); }, 500),

  render() {
    const root = $('#view-editor');
    root.textContent = '';
    const m = this.meta, isNew = !this.folder;
    const page = h('div', { class: 'page' });
    root.append(page);
    page.append(h('div', { class: 'topbar' },
      h('button', { class: 'btn ghost', onclick: () => Router.go('#/') }, '← Libreria'),
      h('div', { class: 'grow' }, h('h1', null, isNew ? 'Nuova uscita' : (m.title || 'Uscita')), !isNew ? h('div', { class: 'lib-path' }, 'Cartella: ', h('code', null, `${Store.name}/${this.folder}`)) : null),
      !isNew ? h('button', { class: 'btn primary', onclick: () => Router.go(`#/uscita/${encodeURIComponent(this.folder)}/viewer`) }, 'Apri nel viewer →') : null));
    const grid = h('div', { class: 'ed-grid' });
    page.append(grid);
    grid.append(this.secInfo());
    if (isNew) return;
    grid.append(this.secVideo(), this.secData(), this.secCheck());
    page.append(h('div', { class: 'sticky-foot' },
      h('span', { class: 'stat' }, 'Le modifiche si salvano da sole nella cartella dell\'uscita.'),
      h('button', { class: 'btn', onclick: () => Router.go('#/') }, 'Torna alla libreria'),
      h('button', { class: 'btn primary', onclick: () => Router.go(`#/uscita/${encodeURIComponent(this.folder)}/viewer`) }, 'Apri nel viewer →')));
  },

  /* ---------- 1. Scheda dell'uscita ---------- */
  secInfo() {
    const m = this.meta, isNew = !this.folder;
    const f = (label, key, attrs = {}, cls = '') => {
      const { tag = 'input', options = [], ...rest } = attrs;
      const inp = h(tag, Object.assign(tag === 'input' ? { type: 'text', value: m[key] ?? '' } : {}, rest));
      if (tag === 'textarea') inp.value = m[key] || '';
      if (tag === 'select') { for (const o of options) inp.append(h('option', { value: o }, o || '—')); inp.value = m[key] || ''; }
      inp.addEventListener('input', () => { m[key] = inp.value; if (key === 'title') { const t = $('#view-editor h1'); if (t && !isNew) t.textContent = inp.value || 'Uscita'; } this.save(); if (key === 'twd') this.renderCheck(); });
      return h('label', { class: 'f ' + cls }, label, inp);
    };
    const sec = h('section', { class: 'card ed-sec' },
      h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '1'), 'Scheda dell\'uscita')),
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
        h('button', { class: 'btn', onclick: () => Router.go('#/') }, 'Annulla'),
        h('button', { class: 'btn primary', onclick: () => this.create() }, 'Crea l\'uscita e carica i file →')));
    }
    return sec;
  },
  async create() {
    const m = this.meta;
    if (!m.title.trim()) { toast('Scrivi un titolo per l\'uscita.'); $('#view-editor input').focus(); return; }
    if (!m.date) { toast('Indica la data.'); return; }
    LS.set('lastBoat', m.boat); LS.set('lastHelm', m.helm); LS.set('lastCrew', m.crew);
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
    sec.append(h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '2'), 'Video'),
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
      const zh = h('input', { type: 'number', step: 0.5, value: cam.heelZero ?? '', placeholder: 'auto', style: { width: '80px' } });
      const zp = h('input', { type: 'number', step: 0.5, value: cam.pitchZero ?? '', placeholder: 'auto', style: { width: '80px' } });
      zh.addEventListener('change', () => { cam.heelZero = zh.value === '' ? null : Number(zh.value); this.save(); });
      zp.addEventListener('change', () => { cam.pitchZero = zp.value === '' ? null : Number(zp.value); this.save(); });
      card.append(h('div', { class: 'row small' },
        h('label', { class: 'chk' }, tel, 'Usa la telemetria GoPro (sbandamento, beccheggio e urti dal sensore di gravità; posizione e velocità se il GPS era acceso)'),
        cam.telemetry !== false ? h('span', { class: 'row' },
          h('span', { class: 'stat' }, 'Zero sbandamento °'), zh, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!cam.heelInv, onchange: e => { cam.heelInv = e.target.checked; this.save(); } }), 'inverti'),
          h('span', { class: 'stat' }, 'Zero beccheggio °'), zp, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!cam.pitchInv, onchange: e => { cam.pitchInv = e.target.checked; this.save(); } }), 'inverti')) : null),
        cam.telemetry !== false ? h('p', { class: 'stat' }, 'L\'assetto ha senso solo se la camera è fissata alla barca (non sul casco). "auto" prende come zero la posizione media della camera.') : null);
    }
    const tb = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['File', 'Durata', 'Video', 'Inizio', 'Ora presa da', 'Camera', ''].map(x => h('th', null, x)))));
    const body = h('tbody');
    for (const cl of cam.clips) {
      const st = this.clipStartLocal(cam, cl);
      const tIn = h('input', { type: 'datetime-local', step: 1, value: st, style: { width: '200px' } });
      tIn.addEventListener('change', () => {
        const v = new Date(tIn.value).getTime();
        if (!isFinite(v)) return;
        cl.start = v - (Number(cam.offset) || 0); cl.startSrc = 'manual';
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
        h('td', { class: 'stat ' + (cl.startSrc === 'gps' ? 'good' : cl.startSrc === 'mtime' ? 'warn' : '') }, START_SRC_LABEL[cl.startSrc] || cl.startSrc),
        h('td', null, mv),
        h('td', null, h('button', { class: 'icon-btn', title: 'Togli dall\'uscita', 'aria-label': 'Togli dall\'uscita', onclick: () => { cam.clips = cam.clips.filter(c => c !== cl); if (!cam.clips.length) m.cameras = m.cameras.filter(c => c !== cam); this.save(); this.renderVideo(); this.renderCheck(); } }, '✕'))));
    }
    tb.append(body);
    card.append(h('div', { class: 'tbl-wrap' }, tb));
    if (cam.clips.length && !cam.clips.some(c => c.startSrc === 'gps')) card.append(h('p', { class: 'stat' }, 'Senza GPS nella camera l\'ora viene dall\'orologio della GoPro: di solito è giusta entro qualche secondo. La rifinitura si fa nel viewer con lo strumento di sincronizzazione (⏱ sul video).'));
    return card;
  },
  clipStartLocal(cam, cl) { const d = new Date(cl.start + (Number(cam.offset) || 0)); return `${ymdOf(d.getTime())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; },
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
  },

  /* ---------- 3. Dati ---------- */
  secData() { const sec = h('section', { class: 'card ed-sec', id: 'secData' }); this.renderData(sec); return sec; },
  renderData(sec = $('#secData')) {
    if (!sec) return;
    sec.textContent = '';
    const input = h('input', { type: 'file', accept: '.csv,.txt,.tsv,.gpx,text/csv', multiple: true, hidden: true, onchange: e => { this.addData([...e.target.files]); e.target.value = ''; } });
    const drop = h('div', { class: 'drop' },
      h('div', null, h('b', null, 'Trascina qui i file di dati'), ' — CSV della cella di carico Cyclops, export del Vakaros, GPX del telefono o dell\'orologio, qualsiasi CSV con una colonna ora'),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => input.click() }, 'Scegli i file…')), input);
    this.dropZone(drop, files => this.addData(files.filter(f => DATA_RE.test(f.name)), files));
    sec.append(h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '3'), 'Dati'),
      h('span', { class: 'stat' }, 'L\'app riconosce da sola la colonna dell\'ora e le grandezze. Controlla nomi, unità e ruoli.')), drop);
    for (const src of this.meta.sources) sec.append(this.srcCard(src));
  },
  async addData(files, all = []) {
    const vids = all.filter(f => VIDEO_RE.test(f.name));
    if (vids.length) this.addVideos(vids);
    for (const file of files) {
      try {
        let dest = `dati/${file.name}`;
        if (this.meta.sources.some(s => s.file === dest)) { toast(`${file.name} è già nell'uscita.`); continue; }
        const text = await file.text();
        let src;
        if (/\.gpx$/i.test(file.name)) {
          parseGPX(text, 'x', 'x');
          src = { id: uid('s'), file: dest, name: file.name.replace(/\.\w+$/, ''), kind: 'GPX', offset: 0 };
        } else {
          const tab = parseTable(text), cols = analyzeCols(tab);
          const cfg = guessSourceConfig(tab, cols);
          src = Object.assign({ id: uid('s'), file: dest, name: cfg.kind === 'CSV' ? file.name.replace(/\.\w+$/, '') : cfg.kind === 'Vakaros' ? 'Vakaros Atlas 2' : 'Cyclops' }, cfg);
          this.tabs.set(src.id, { tab, cols });
        }
        await Store.writeText(`${this.folder}/${dest}`, text);
        this.meta.sources.push(src);
        this.save();
        this.rebuild(src);
      } catch (e) { toast(`${file.name}: ${errMsg(e)}`, 8000, 'bad'); }
    }
    this.renderData(); this.renderCheck();
  },
  async parseAll() {
    for (const src of this.meta.sources) {
      try {
        const text = await Store.readText(`${this.folder}/${src.file}`);
        if (src.kind !== 'GPX') { const tab = parseTable(text), cols = analyzeCols(tab); this.tabs.set(src.id, { tab, cols }); }
        else this.tabs.set(src.id, { gpx: text });
        this.rebuild(src, false);
      } catch (e) { this.channels.set(src.id, { error: errMsg(e) }); }
    }
    this.renderData(); this.renderCheck();
  },
  rebuild(src, rerender = true) {
    const T = this.tabs.get(src.id);
    try {
      let list;
      if (src.kind === 'GPX') list = T && T.gpx ? parseGPX(T.gpx, src.id, src.name) : [];
      else list = buildChannels(T.tab, T.cols, Object.assign({ baseDate: this.meta.date }, src), src.id, src.name);
      this.channels.set(src.id, { list });
    } catch (e) { this.channels.set(src.id, { error: errMsg(e), list: [] }); }
    if (rerender) { this.renderCheck(); const st = $(`#st-${src.id}`); if (st) st.replaceWith(this.srcStat(src)); }
  },
  srcStat(src) {
    const r = this.channels.get(src.id) || {};
    if (r.error) return h('div', { class: 'stat bad', id: `st-${src.id}` }, r.error);
    const list = r.list || [];
    if (!list.length) return h('div', { class: 'stat warn', id: `st-${src.id}` }, 'Nessun canale letto: scegli la colonna dell\'ora e almeno una grandezza.');
    const a = Math.min(...list.map(c => c.t[0])), b = Math.max(...list.map(c => c.t[c.t.length - 1]));
    const hz = 1000 / list[0].step;
    const T = this.tabs.get(src.id);
    const otherDay = ymdOf(a) !== this.meta.date;
    return h('div', { class: 'stat ' + (otherDay ? 'warn' : ''), id: `st-${src.id}` },
      `${T && T.tab ? T.tab.data.length.toLocaleString('it-IT') + ' righe · ' : ''}${list.length} canali · ${hz >= 1 ? fmtNum(hz, hz < 10 ? 1 : 0) + ' Hz' : 'un campione ogni ' + fmtNum(1 / hz, 0) + ' s'} · dalle ${fmtClock(a)} alle ${fmtClock(b)} (${fmtDur(b - a)})`,
      otherDay ? ` · attenzione: i dati sono del ${new Date(a).toLocaleDateString('it-IT')}, non del giorno dell'uscita` : '');
  },
  srcCard(src) {
    const card = h('div', { class: 'src-card' });
    const name = h('input', { type: 'text', value: src.name, style: { width: '190px', fontWeight: 650 } });
    name.addEventListener('change', () => { src.name = name.value || src.file; this.save(); this.renderCheck(); });
    const others = this.posSources().filter(s => s.id !== src.id);
    const hasPos = this.posSources().some(s => s.id === src.id);
    card.append(h('div', { class: 'src-head' }, h('span', { class: 'badge' }, src.kind), name, h('span', { class: 'stat' }, src.file.split('/').pop()), h('div', { class: 'sp' }),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Togliere il file?', `"${src.name}" esce dall'uscita. Il file resta nella cartella dati.`, 'Togli', true)) { this.meta.sources = this.meta.sources.filter(s => s !== src); this.channels.delete(src.id); this.save(); this.renderData(); this.renderCheck(); } } }, 'Togli')));
    card.append(this.srcStat(src));
    const T = this.tabs.get(src.id);
    const ctl = h('div', { class: 'row' });
    if (T && T.tab) {
      const tsel = h('select', null, T.cols.map(c => h('option', { value: c.j }, c.name + (c.time ? '' : ' (non sembra un orario)'))));
      tsel.value = src.timeCol;
      tsel.addEventListener('change', () => { src.timeCol = Number(tsel.value); this.save(); this.rebuild(src); });
      ctl.append(h('label', { class: 'f' }, 'Colonna dell\'ora', tsel));
    }
    const tz = h('div', { class: 'seg' }, [['local', 'Ora locale'], ['utc', 'UTC']].map(([v, l]) => h('button', { class: (src.tz || 'local') === v ? 'on' : '', onclick: () => { src.tz = v; this.save(); this.rebuild(src); this.renderData(); } }, l)));
    if (src.kind !== 'GPX') ctl.append(h('div', { class: 'f' }, 'Orari del file in', tz));
    const off = h('input', { type: 'number', step: 0.1, value: src.offset || 0, style: { width: '110px' } });
    off.addEventListener('change', () => { src.offset = parseFloat(off.value) || 0; this.save(); this.rebuild(src); });
    ctl.append(h('label', { class: 'f' }, 'Spostamento (s)', off));
    if (hasPos && others.length) {
      const ref = h('select', null, others.map(s => h('option', { value: s.id }, s.name)));
      ctl.append(h('div', { class: 'f' }, 'Allinea l\'orologio con il GPS di', h('div', { class: 'row' }, ref, h('button', { class: 'btn sm', onclick: () => this.align(src, ref.value, off) }, 'Allinea'))));
    }
    card.append(ctl);
    if (src.columns && T && T.tab) {
      const tb = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Usa', 'Colonna', 'Nome', 'Unità', 'Grandezza', '× fattore', '+ costante'].map(x => h('th', null, x)))));
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
          h('td', null, ch('k', h('input', { type: 'number', step: 'any', value: c.k ?? 1, style: { width: '80px' } }), true)),
          h('td', null, ch('add', h('input', { type: 'number', step: 'any', value: c.add ?? 0, style: { width: '80px' } }), true))));
      }
      tb.append(body);
      card.append(h('div', { class: 'tbl-wrap' }, tb));
      card.append(h('p', { class: 'stat' }, 'Per una velocità in m/s usa fattore 1,944 e unità kn. Per tarare la cella di carico usa la costante (es. −12 per togliere la tara).'));
      card.append(h('details', null, h('summary', null, 'Prime righe del file'), h('pre', { class: 'preview' }, T.tab.preview)));
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
    sec.append(h('div', { class: 'ed-sec-head' }, h('h2', null, h('span', { class: 'step' }, '4'), 'Controllo della sincronizzazione'),
      h('span', { class: 'stat' }, 'Video e dati devono sovrapporsi sullo stesso orario. Se una barra è fuori posto, correggi l\'orologio della camera o lo spostamento del file.')));
    const rows = [];
    const m = this.meta;
    m.cameras.forEach((cam, i) => rows.push({ label: cam.name, kind: 'cam', color: seriesColor(i), spans: cam.clips.map(cl => { const s = cl.start + (Number(cam.offset) || 0); return [s, s + cl.duration * 1000]; }) }));
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
    let t0 = Infinity, t1 = -Infinity;
    for (const r of rows) for (const [a, b] of r.spans) { t0 = Math.min(t0, a); t1 = Math.max(t1, b); }
    const pad = (t1 - t0) * .03 || 60000; t0 -= pad; t1 += pad;
    const x = t => ((t - t0) / (t1 - t0) * 100).toFixed(3) + '%';
    const wrap = h('div', { class: 'cover' });
    for (const r of rows) {
      const lane = h('div', { class: 'cover-lane' });
      for (const [a, b] of r.spans) lane.append(h('i', { style: { left: x(a), width: `calc(${x(b)} - ${x(a)} + 2px)`, background: r.color }, title: `${fmtClock(a)} – ${fmtClock(b)}` }));
      wrap.append(h('div', { class: 'cover-row' }, h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.kind === 'cam' ? '🎥 ' : '📈 ', r.label), lane));
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
    if (!notes.length) sec.append(h('p', { class: 'stat good' }, 'Tutto in ordine: video e dati si sovrappongono.'));
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
