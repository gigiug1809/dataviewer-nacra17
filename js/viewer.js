/* Viewer: griglia di pannelli spostabili, orologio comune, barra del tempo, eventi */
'use strict';
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
const COLS = 24, ROWS = 24;

const Viewer = {
  S: null, open_: false,
  async open(folder) {
    this.close();
    this.open_ = true;
    const root = $('#view-viewer');
    root.textContent = '';
    const load = h('div', { class: 'loading' }, h('div', null, h('b', null, 'Apro l\'uscita…'), h('div', { class: 'progress', style: { width: '100%' } }, h('i')), h('span', { class: 'small' }, '')));
    root.append(load);
    const meta = await Store.readJSON(`${folder}/${SESSION_FILE}`);
    if (!meta) { toast('Uscita non trovata.'); Router.go('#/debrief'); return; }
    meta.view = meta.view || {};
    const S = this.S = new Session(folder, meta);
    await S.load((msg, p) => { load.querySelector('span').textContent = msg; load.querySelector('.progress i').style.width = (p * 100) + '%'; });
    if (!this.open_ || this.S !== S) return;
    load.remove();
    this.start(S, root);
  },
  /* avvio comune: uscita da file oppure sessione live */
  start(S, root) {
    const meta = S.meta;
    this.S = S;
    S.onSave = st => { const d = $('#saveDot'); if (d) { d.className = 'save-dot ' + st; d.textContent = st === 'saved' ? 'Salvato' : st === 'error' ? 'Errore' : 'Salvo…'; } };
    this.playing = false; this.rate = 1; this.scrubbing = false; this.master = null; this.drawSeq = 0;
    this.win = meta.view.win ?? 60000;
    this.preroll = meta.view.preroll ?? 5000;
    this.inT = meta.view.inT ?? null; this.outT = meta.view.outT ?? null;
    this.locked = !!meta.view.locked;
    this.undo = [];
    const firstVid = meta.cameras.flatMap(c => c.clips.map(cl => S.clipStart(c, cl))).sort((a, b) => a - b)[0];
    if (S.live) meta.view.t = S.t1;
    this.t = clamp(meta.view.t ?? firstVid ?? S.t0, S.t0, S.t1);
    this.buildUI(root);
    if (S.loadErrors.length) toast('Alcuni file non sono stati letti: ' + S.loadErrors.join(' · '), 10000, 'bad');
    this.loop = this.loop.bind(this);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    this.onKey = this.key.bind(this);
    document.addEventListener('keydown', this.onKey);
    this.onResize = debounce(() => this.fitGrid(), 120);
    window.addEventListener('resize', this.onResize);
    this.onTheme = () => this.rebuildPanels();
    window.addEventListener('themechange', this.onTheme);
  },
  close() {
    if (!this.open_) return;
    this.open_ = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('themechange', this.onTheme);
    if (this.S) { this.saveView(); this.S.saveNow(); }
    for (const p of (this.panels || new Map()).values()) { try { p.ro && p.ro.disconnect(); p.inst.destroy(); } catch (e) { /* già chiuso */ } }
    this.panels = new Map();
    if (this.grid) { this.grid.destroy(); this.grid = null; }
    if (this.S) this.S.dispose();
    this.S = null; this.frameArea = null;
    $('#view-viewer').textContent = '';
    $('#view-viewer').classList.remove('dash-mode', 'no-tl', 'editing');
  },

  /* ---------- Interfaccia ---------- */
  buildUI(root) {
    const S = this.S, m = S.meta;
    const winSel = h('select', { title: 'Finestra di tempo dei grafici', style: { minHeight: '30px' } }, WINDOWS.map(([v, l]) => h('option', { value: v }, l)));
    winSel.value = String(this.win);
    winSel.onchange = () => { this.win = Number(winSel.value); this.requestDraw(); this.saveViewSoon(); };
    this.winSel = winSel;
    const lockBtn = h('button', { class: 'icon-btn' + (this.locked ? ' on' : ''), title: 'Blocca la disposizione dei pannelli', 'aria-label': 'Blocca la disposizione' }, this.locked ? '🔒' : '🔓');
    this.lockBtn = lockBtn;
    lockBtn.onclick = () => { this.locked = !this.locked; lockBtn.classList.toggle('on', this.locked); lockBtn.textContent = this.locked ? '🔒' : '🔓'; this.grid.setStatic(this.locked); this.gridEl.classList.toggle('locked', this.locked); this.saveViewSoon(); };
    const top = h('div', { class: 'vtop' },
      h('button', { class: 'btn ghost sm', onclick: () => Router.go('#/debrief') }, '← Libreria'),
      h('div', { class: 'title', title: m.title }, m.title || S.folder),
      h('span', { class: 'faint small' }, fmtDateLong(m.date)),
      h('span', { id: 'saveDot', class: 'save-dot' }, 'Salvato'),
      h('div', { class: 'sp' }),
      h('span', { class: 'small muted' }, 'Finestra'), winSel,
      h('div', { class: 'sep' }),
      h('button', { class: 'btn sm', onclick: e => this.addMenu(e.currentTarget) }, '+ Pannello'),
      h('button', { class: 'btn sm', onclick: e => this.layoutMenu(e.currentTarget) }, 'Layout'),
      lockBtn,
      h('div', { class: 'sep' }),
      S.live ? h('span', { id: 'liveBar', class: 'row', style: { gap: '6px' } }) : h('button', { class: 'btn sm', onclick: () => Router.go(`#/uscita/${encodeURIComponent(S.folder)}/dati`) }, 'Video e dati'),
      h('button', { class: 'icon-btn', title: 'Scheda dell\'uscita', 'aria-label': 'Scheda dell\'uscita', onclick: () => this.infoBox() }, 'ⓘ'),
      h('button', { class: 'icon-btn', title: 'Tema chiaro / scuro', 'aria-label': 'Tema', onclick: toggleTheme }, '◐'),
      h('button', { class: 'icon-btn', title: 'Scorciatoie da tastiera', 'aria-label': 'Scorciatoie', onclick: () => this.help() }, '?'));
    this.gridWrap = h('div', { class: 'vgrid-wrap' });
    this.gridEl = h('div', { class: 'grid-stack' + (this.locked ? ' locked' : '') });
    this.gridWrap.append(this.gridEl);
    this.frameArea = null;
    if (S.dash) {
      // dashboard del Live: barra compatta; mentre si compone con i dati simulati, cornice con le proporzioni dell'iPad
      root.classList.add('dash-mode');
      root.classList.toggle('no-tl', !LS.get('dashTimeline', false));
      if (S.sim) this.frameArea = h('div', { class: 'vframe-area' }, this.gridWrap);
      root.append(this.dashTop(), this.frameArea || this.gridWrap, this.buildTimeline());
      this.setEditing(!this.locked, true);
    } else root.append(top, this.gridWrap, this.buildTimeline());
    this.grid = new FreeGrid(this.gridEl, { cols: COLS, cellH: this.cellH(), locked: this.locked, handle: '.pnl-grip' });
    this.panels = new Map();
    const layout = (m.layout && m.layout.length ? m.layout : defaultLayout(S));
    for (const p of layout) this.addPanel(p, false);
    this.grid.on('change', () => this.layoutChanged());
    this.gridWrap.addEventListener('contextmenu', e => this.contextMenu(e), true);
    const firstOpen = !m.layout;
    if (firstOpen) { m.layout = this.layoutData(); S.save(); }
    if (!S.live) this.checkNewData(firstOpen);
    this.requestDraw();
  },
  /* Dati arrivati dopo che il layout è stato fatto: li propongo per la dashboard */
  checkNewData(firstOpen) {
    const S = this.S, m = S.meta;
    const usable = S.channels.filter(c => !c.derived && !c.quiet && c.role !== 'lat' && c.role !== 'lon' && !S.meta.cameras.some(cam => cam.id === c.src)).map(c => c.id);
    const shown = new Set(this.layoutData().flatMap(p => p.cfg.ids || []));
    if (!m.view.seen) { m.view.seen = firstOpen ? usable : [...shown]; S.save(); }
    const fresh = usable.filter(id => !m.view.seen.includes(id) && !shown.has(id));
    if (!fresh.length) return;
    const bySrc = new Map();
    for (const id of fresh) { const c = S.ch(id); if (!bySrc.has(c.srcName)) bySrc.set(c.srcName, []); bySrc.get(c.srcName).push(c); }
    const done = () => { m.view.seen = [...new Set([...m.view.seen, ...fresh])]; S.save(); bar.remove(); };
    const bar = h('div', { class: 'row', style: { padding: '6px 10px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--line)', fontSize: '13px' } },
      h('b', null, 'Dati nuovi in questa uscita:'),
      h('span', null, [...bySrc].map(([src, l]) => `${src} (${l.map(c => c.name).join(', ')})`).join(' · ')),
      h('div', { class: 'sp' }),
      h('button', { class: 'btn sm primary', onclick: () => { this.addToDashboard(bySrc); done(); } }, 'Aggiungi alla dashboard'),
      h('button', { class: 'btn sm ghost', onclick: done }, 'Non ora'));
    this.gridWrap.before(bar);
  },
  addToDashboard(bySrc) {
    let last = null;
    const empty = [...this.panels.values()].filter(r => r.type === 'chart' && !(r.cfg.ids || []).length);
    for (const [src, list] of bySrc) {
      const ids = list.map(c => c.id), slot = empty.shift();
      if (slot) { slot.cfg.ids = ids; slot.cfg.title = src; slot.inst.cfg = slot.cfg; slot.inst.build(); last = slot; }
      else last = this.addPanel({ type: 'chart', w: 12, h: 8, cfg: { title: src, ids } });
    }
    const nums = [...this.panels.values()].find(r => r.type === 'numbers');
    const top = [...bySrc.values()].flat().filter(c => ['hr', 'sog', 'load', 'heel', 'pitch'].includes(c.role)).slice(0, 4);
    if (nums && top.length) { nums.cfg.ids = [...new Set([...(nums.cfg.ids || []), ...top.map(c => c.id)])]; nums.inst.cfg = nums.cfg; nums.inst.build(); }
    this.layoutChanged();
    if (last) setTimeout(() => last.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    toast('Aggiunti: un grafico per ogni file nuovo' + (nums && top.length ? ' e le grandezze principali nel pannello Numeri' : '') + '. Spostali dove vuoi trascinando la maniglia ⠿ in alto a sinistra.', 7000);
  },
  cellH() { this.fitFrame(); const r = this.gridWrap ? this.gridWrap.clientHeight : window.innerHeight - 150; return Math.max(16, Math.floor((r - 8) / ROWS)); },
  fitGrid() {
    if (!this.grid) return;
    const S = this.S;
    // l'iPad è stato girato: passo all'altra disposizione della dashboard
    if (S && S.dash && !S.sim) { const o = innerWidth >= innerHeight ? 'land' : 'port'; if (o !== S.orient) { S.orient = o; this.applyLayout(Dash.layout(S.dash, o), false); } }
    this.grid.cellHeight(this.cellH()); this.drawTimeline();
  },
  /* cornice con le proporzioni dell'iPad (orizzontale o verticale) mentre si compone una dashboard */
  fitFrame() {
    if (!this.frameArea) return;
    const r = this.frameArea.getBoundingClientRect(), ar = DASH_RATIO[this.S.orient] || 1.5;
    if (!r.width || !r.height) return;
    const w = Math.min(r.width - 24, (r.height - 24) * ar);
    this.gridWrap.style.width = Math.round(w) + 'px'; this.gridWrap.style.height = Math.round(w / ar) + 'px';
  },

  /* ---------- Dashboard del Live ---------- */
  dashTop() {
    const S = this.S;
    this.editBtn = h('button', { class: 'btn sm', onclick: () => this.setEditing(this.locked) });
    const seg = S.sim ? h('div', { class: 'seg edit-only', title: 'Quale disposizione stai componendo' }, [['land', 'Orizzontale'], ['port', 'Verticale']].map(([o, l]) => h('button', { class: S.orient === o ? 'on' : '', onclick: () => this.setOrient(o) }, l))) : null;
    this.orientSeg = seg;
    return h('div', { class: 'vtop dash-top' },
      h('button', { class: 'btn ghost sm', title: 'Barca e dashboard', onclick: () => Router.go('#/live') }, '←'),
      h('div', { class: 'title', title: S.dash.name }, S.dash.name),
      h('span', { id: 'liveBar', class: 'row', style: { gap: '6px' } }),
      h('div', { class: 'sp' }),
      seg,
      h('button', { class: 'btn sm edit-only', onclick: e => this.addMenu(e.currentTarget) }, '+ Pannello'),
      this.editBtn,
      h('button', { class: 'icon-btn', title: 'Altro', 'aria-label': 'Altro', onclick: e => this.dashMenu(e.currentTarget) }, '⋯'));
  },
  setEditing(on, init = false) {
    const S = this.S;
    if (!on && S.sim && !init) { Router.go(`#/live/${encodeURIComponent(S.code)}/d/${encodeURIComponent(S.dash.id)}`); return; } // finito: ai dati veri
    this.locked = !on;
    if (!init) { this.grid.setStatic(this.locked); this.gridEl.classList.toggle('locked', this.locked); }
    $('#view-viewer').classList.toggle('editing', on);
    this.editBtn.textContent = on ? '✓ Fatto' : '✎ Modifica';
    this.editBtn.classList.toggle('primary', on);
    this.editBtn.title = on ? 'Finito: blocca i pannelli' : 'Sposta, ridimensiona, aggiungi o togli pannelli';
    if (!init && on) toast(`Stai modificando la disposizione ${S.orient === 'port' ? 'verticale' : 'orizzontale'}: trascina i pannelli dalla maniglia ⠿, ridimensionali dall'angolo in basso a destra.`, 5000);
  },
  setOrient(o) {
    const S = this.S;
    if (S.orient === o) return;
    S.orient = o; LS.set('dashOrient', o);
    this.orientSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 0) === (o === 'land')));
    this.applyLayout(Dash.layout(S.dash, o), false);
    this.fitGrid();
    if (o === 'port' && !S.dash.port) toast('La disposizione verticale è ricavata da quella orizzontale: sistemala come vuoi, si salva da sola.', 6000);
  },
  dashMenu(anchor) {
    const S = this.S, root = $('#view-viewer'), tl = !root.classList.contains('no-tl');
    menu(anchor, [
      { label: tl ? 'Nascondi la barra del tempo' : 'Mostra la barra del tempo (per tornare indietro)', run: () => { root.classList.toggle('no-tl', tl); LS.set('dashTimeline', !tl); this.fitGrid(); } },
      { label: 'Finestra dei grafici…', run: () => { const sel = this.winSel.cloneNode(true); sel.value = String(this.win); modal({ title: 'Finestra dei grafici', body: h('label', { class: 'f' }, 'Quanto tempo mostrano i grafici', sel), actions: [{ label: 'Annulla' }, { label: 'OK', kind: 'primary', run: () => { this.win = Number(sel.value); this.winSel.value = sel.value; this.requestDraw(); this.saveViewSoon(); } }] }); } },
      { label: 'Tema chiaro / scuro', run: toggleTheme },
      { label: 'Quadro numeri grandi', run: () => Router.go(`#/live/${encodeURIComponent(S.code)}/quadro`) },
      S.sim ? null : { label: 'Salva i dati ricevuti', run: () => Live.saveAs(S) },
      { sep: true },
      { head: 'Disposizione ' + (S.orient === 'port' ? 'verticale' : 'orizzontale') },
      { label: 'Ricomincia dai pannelli di partenza', run: async () => { if (await confirmBox('Pannelli di partenza', 'Sostituisco i pannelli di questa disposizione con quelli di partenza?', 'Sostituisci')) { this.applyLayout(S.orient === 'port' ? portraitFrom(liveLayout()) : liveLayout()); } } },
      S.orient === 'port' ? { label: 'Rifai la verticale da quella orizzontale', run: () => { S.dash.port = null; this.applyLayout(Dash.layout(S.dash, 'port')); } } : null
    ].filter(Boolean));
  },

  addPanel(p, save = true) {
    const id = p.id || uid('p');
    const cfg = p.cfg || {};
    const Cls = PANEL_CLASSES[p.type];
    if (!Cls) return;
    // costruisco il pannello completo (con la maniglia) prima di darlo alla griglia, che cerca lì la maniglia
    const el = h('div', { class: 'grid-stack-item' }, h('div', { class: 'grid-stack-item-content' }));
    const content = el.firstChild;
    const inst = new Cls(this, cfg);
    const ttl = h('div', { class: 'ttl' }, inst.title());
    // si sposta solo dalla maniglia in alto a sinistra, si ridimensiona solo dall'angolo in basso a destra:
    // così trascinare dentro un pannello (Maiusc + trascina sui grafici, la mappa) non lo muove mai
    const grip = h('span', { class: 'pnl-grip', title: 'Trascina da qui per spostare il pannello', 'aria-label': 'Sposta il pannello', html: ICONS.grip });
    const head = h('div', { class: 'pnl-head' }, grip, ttl, ...(inst.headButtons ? inst.headButtons() : []),
      ...(PANEL_SIZE_OK(p.type) ? [
        h('button', { class: 'icon-btn sz', title: 'Testo più piccolo', 'aria-label': 'Testo più piccolo', onclick: () => this.stepSize(inst._rec, -1) }, 'A−'),
        h('button', { class: 'icon-btn sz', title: 'Testo più grande', 'aria-label': 'Testo più grande', onclick: () => this.stepSize(inst._rec, 1) }, 'A+')] : []),
      h('button', { class: 'icon-btn', title: 'Impostazioni del pannello', 'aria-label': 'Impostazioni', html: ICONS.gear, onclick: () => this.panelSettings(inst) }),
      h('button', { class: 'icon-btn', title: 'Chiudi il pannello', 'aria-label': 'Chiudi', html: ICONS.close, onclick: () => this.removePanel(id) }));
    head.querySelectorAll('button,select').forEach(b => b.addEventListener('mousedown', e => e.stopPropagation()));
    const body = h('div', { class: 'pnl-body' }, inst.el);
    content.append(head, body);
    this.grid.add(el, { x: p.x, y: p.y, w: p.w || 6, h: p.h || 8, z: p.z, id, autoPosition: p.x == null, maxY: this.S && this.S.dash ? ROWS : Infinity });
    const rec = { id, type: p.type, cfg, inst, el, ttl, body };
    rec.ro = new ResizeObserver(debounce(() => { if (this.panels.get(id) !== rec) return; inst.resize(); this.requestDraw(); }, 60)); // pannello già chiuso: niente
    rec.ro.observe(body);
    inst._rec = rec;
    this.panels.set(id, rec);
    this.applyLook(rec);
    if (save) this.layoutChanged();
    this.requestDraw();
    return rec;
  },
  removePanel(id) {
    const r = this.panels.get(id);
    if (!r) return;
    r.ro.disconnect(); r.inst.destroy();
    this.grid.remove(r.el);
    this.panels.delete(id);
    this.layoutChanged();
  },
  rebuildPanels(filter = () => true) {
    const layout = this.layoutData();
    for (const p of layout) {
      if (!filter(p)) continue;
      const r = this.panels.get(p.id);
      r.ro.disconnect(); r.inst.destroy(); this.grid.remove(r.el); this.panels.delete(p.id);
      this.addPanel(p, false);
    }
    this.requestDraw();
  },
  layoutData() {
    const out = [];
    for (const it of this.grid.items()) {
      const n = it.node, r = this.panels.get(n.id);
      if (r) out.push({ id: n.id, type: r.type, x: n.x, y: n.y, w: n.w, h: n.h, z: n.z, cfg: r.cfg });
    }
    return out;
  },
  layoutChanged() { if (!this.S || !this.grid) return; this.S.meta.layout = this.layoutData(); this.S.layoutDirty = true; this.S.save(); for (const r of this.panels.values()) r.ttl.textContent = r.inst.title(); },
  layoutChangedSoon: debounce(function () { Viewer.layoutChanged(); }, 800),
  panelSettings(inst) {
    const rec = inst._rec, cfg = rec.cfg;
    const st = inst.settings ? inst.settings() : null;
    // aspetto: uguale per tutti i pannelli
    const size = h('select', null, SIZE_STEPS.map(v => h('option', { value: v, selected: Math.abs(v - (cfg.size || 1)) < 1e-6 }, `${Math.round(v * 100)}%`)));
    const head = h('select', null, [['', 'Sottile, con il nome'], ['hide', 'Nascosta (compare passando sopra)']].map(([v, l]) => h('option', { value: v, selected: (cfg.head || '') === v }, l)));
    const clear = h('input', { type: 'checkbox', checked: !!cfg.clear });
    const lay = (how, label) => h('button', { class: 'btn sm', onclick: () => { if (this.grid.restack(rec.el, how)) toast('Livello cambiato.', 1200); else toast('È già lì.', 1200); } }, label);
    const look = h('div', { class: 'look-box' }, h('div', { class: 'look-h' }, 'Aspetto'),
      h('div', { class: 'row', style: { gap: '18px', flexWrap: 'wrap', alignItems: 'flex-end' } },
        PANEL_SIZE_OK(rec.type) ? h('label', { class: 'f' }, rec.type === 'numbers' ? 'Grandezza dei numeri' : rec.type === 'chart' ? 'Grandezza di scritte e assi' : 'Grandezza del testo', size) : null,
        h('label', { class: 'f' }, 'Barra del titolo', head),
        h('label', { class: 'row', style: { gap: '6px', fontSize: '13px' } }, clear, 'Sfondo trasparente')),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } }, h('span', { class: 'muted small' }, 'Livello (se è sopra o sotto altri pannelli):'),
        lay('front', '⤒ In primo piano'), lay('up', '↑ Avanti'), lay('down', '↓ Indietro'), lay('back', '⤓ In fondo')));
    modal({ title: `Impostazioni · ${PANEL_TYPES[rec.type].label}`, body: h('div', { style: { display: 'grid', gap: '14px' } }, st ? st.el : null, look), wide: true, actions: [{ label: 'Annulla' }, { label: 'Applica', kind: 'primary', run: () => {
      if (st) st.apply();
      cfg.size = Number(size.value); cfg.head = head.value || undefined; cfg.clear = clear.checked || undefined; delete cfg.slim;
      this.applyLook(rec);
      this.layoutChanged(); if (rec.type === 'video') this.rebuildPanels(p => p.id === rec.id); this.requestDraw(); } }] });
  },
  /* grandezza del testo e barra sottile di un pannello */
  applyLook(rec) {
    const s = rec.cfg.size || 1;
    rec.el.classList.toggle('nohead', rec.cfg.head === 'hide');
    rec.el.classList.toggle('clear', !!rec.cfg.clear);
    if (rec.inst.setSize) rec.inst.setSize(s);
    else if (PANEL_SIZE_OK(rec.type)) rec.inst.el.style.zoom = s === 1 ? '' : s;
    const b = rec.el.querySelectorAll('.pnl-head .sz');
    if (b.length) b[0].title = `Testo più piccolo (ora ${Math.round(s * 100)}%)`, b[1].title = `Testo più grande (ora ${Math.round(s * 100)}%)`;
  },
  stepSize(rec, dir) {
    if (!rec) return;
    const cur = rec.cfg.size || 1;
    let i = SIZE_STEPS.findIndex(v => v >= cur - 1e-6); if (i < 0) i = SIZE_STEPS.length - 1;
    if (SIZE_STEPS[i] > cur + 1e-6 && dir < 0) i++; // tra due gradini: prima scende a quello sotto
    rec.cfg.size = SIZE_STEPS[clamp(i + dir, 0, SIZE_STEPS.length - 1)];
    this.applyLook(rec);
    this.layoutChanged(); this.requestDraw();
    toast(`${PANEL_TYPES[rec.type].label}: ${Math.round(rec.cfg.size * 100)}%`, 1200);
  },
  panelTypes() { return Object.entries(PANEL_TYPES).filter(([type]) => !(this.S.live && ['video', 'coverage'].includes(type))); },
  addMenu(anchor) {
    menu(anchor, this.panelTypes().map(([type, d]) => ({ label: `${d.icon}  ${d.label}`, run: () => this.addTypedPanel(type) })));
  },
  async contextMenu(e) {
    e.preventDefault(); e.stopPropagation();
    const item = e.target.closest('.grid-stack-item');
    const rec = item ? [...this.panels.values()].find(r => r.el === item) : null;
    const cell = this.grid.cellAt(e.clientX, e.clientY);
    const at = { x: Math.max(0, Math.min(COLS - 6, cell.x)), y: Math.max(0, cell.y) };
    if (this.S.dash && this.locked) return; // dashboard bloccata: niente menu (sull'iPad il tocco lungo non deve aprire nulla)
    const add = this.panelTypes().map(([type, d]) => ({ label: `${d.icon}  ${d.label}`, run: () => this.addTypedPanel(type, rec ? null : at) }));
    const lib = this.S.live ? { templates: [] } : await Store.libSettings().catch(() => ({ templates: [] }));
    const items = [];
    if (rec) {
      items.push({ head: PANEL_TYPES[rec.type].label });
      items.push({ label: '⚙︎  Impostazioni del pannello…', run: () => this.panelSettings(rec.inst) });
      if (PANEL_SIZE_OK(rec.type)) {
        items.push({ label: `A+  Testo più grande (ora ${Math.round((rec.cfg.size || 1) * 100)}%)`, run: () => this.stepSize(rec, 1) });
        items.push({ label: 'A−  Testo più piccolo', run: () => this.stepSize(rec, -1) });
        if ((rec.cfg.size || 1) !== 1) items.push({ label: '↺  Grandezza normale', run: () => { rec.cfg.size = 1; this.applyLook(rec); this.layoutChanged(); this.requestDraw(); } });
      }
      const look = (k, v) => { rec.cfg[k] = v; this.applyLook(rec); this.layoutChanged(); this.requestDraw(); };
      items.push({ label: rec.cfg.head === 'hide' ? '▭  Mostra la barra del titolo' : '▭  Nascondi la barra del titolo', run: () => look('head', rec.cfg.head === 'hide' ? undefined : 'hide') });
      items.push({ label: rec.cfg.clear ? '◼  Sfondo pieno' : '◌  Sfondo trasparente', run: () => look('clear', rec.cfg.clear ? undefined : true) });
      items.push({ sep: true }, { head: 'Livello' });
      for (const [how, l] of [['front', '⤒  Porta in primo piano'], ['up', '↑  Porta avanti'], ['down', '↓  Manda indietro'], ['back', '⤓  Manda in fondo']]) items.push({ label: l, run: () => { if (!this.grid.restack(rec.el, how)) toast('È già lì.', 1200); } });
      items.push({ sep: true });
      items.push({ label: '⧉  Duplica', run: () => { const n = rec.el.node; this.addPanel({ type: rec.type, x: Math.min(COLS - n.w, n.x + 1), y: n.y + 1, w: n.w, h: n.h, cfg: JSON.parse(JSON.stringify(rec.cfg)) }); } });
      items.push({ label: '✕  Chiudi il pannello', run: () => this.removePanel(rec.id) });
      items.push({ sep: true });
    }
    items.push({ head: rec ? 'Aggiungi un pannello' : 'Aggiungi qui un pannello' }, ...add, { sep: true });
    if (!this.S.dash) {
      items.push({ label: this.locked ? '🔓  Sblocca la disposizione' : '🔒  Blocca la disposizione', run: () => this.lockBtn.click() });
      items.push({ label: 'Salva il layout come modello…', run: () => this.saveTemplate(lib) });
      for (const tp of lib.templates) items.push({ label: `Applica il modello "${tp.name}"`, run: () => this.applyTemplate(tp) });
      items.push({ label: 'Ripristina il layout predefinito', run: () => this.applyLayout(defaultLayout(this.S)) });
    } else items.push({ label: '✓  Fatto: blocca i pannelli', run: () => this.setEditing(false) });
    menu({ getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY, top: e.clientY }) }, items);
  },
  addTypedPanel(type, at) {
    const cfg = {};
    if (type === 'video') { const used = [...this.panels.values()].filter(r => r.type === 'video').map(r => r.cfg.cam); const c = this.S.meta.cameras.find(c => !used.includes(c.id)) || this.S.meta.cameras[0]; cfg.cam = c && c.id; }
    const sz = { video: [8, 10], chart: [8, 8], map: [7, 9], numbers: [5, 8], events: [8, 9], stats: [6, 7], coverage: [8, 5], averages: [7, 10], bar: [6, 2] }[type] || [6, 6];
    if (type === 'bar') cfg.head = 'hide'; // la barra: solo la barra con il nome piccolo
    const rec = this.addPanel(Object.assign({ type, w: sz[0], h: sz[1], cfg }, at || {}));
    if (rec) setTimeout(() => rec.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    if (rec && ['chart', 'numbers', 'stats', 'bar'].includes(type)) this.panelSettings(rec.inst);
  },
  async layoutMenu(anchor) {
    const lib = await Store.libSettings();
    const items = [
      { head: 'Modelli salvati' },
      ...(lib.templates.length ? lib.templates.map(tp => ({ label: tp.name, run: () => this.applyTemplate(tp) })) : [{ label: 'Nessun modello salvato', disabled: true }]),
      { sep: true },
      { label: 'Salva questo layout come modello…', run: () => this.saveTemplate(lib) },
      lib.templates.length ? { label: 'Elimina un modello…', run: () => this.deleteTemplate(lib) } : null,
      { sep: true },
      { label: 'Ripristina il layout predefinito', run: () => this.applyLayout(defaultLayout(this.S)) }
    ].filter(Boolean);
    menu(anchor, items);
  },
  applyLayout(layout, save = true) {
    for (const r of this.panels.values()) { r.ro.disconnect(); r.inst.destroy(); }
    this.grid.removeAll();
    this.panels = new Map();
    for (const p of layout) this.addPanel(Object.assign({}, p, { id: uid('p') }), false);
    if (save) this.layoutChanged();
    else if (this.S) this.S.meta.layout = this.layoutData();
    this.requestDraw();
  },
  async saveTemplate(lib) {
    const name = await promptBox('Salva il layout come modello', 'Nome del modello (es. "Bolina", "Analisi carichi")', '');
    if (!name) return;
    const layout = this.layoutData().map(p => ({ type: p.type, x: p.x, y: p.y, w: p.w, h: p.h, z: p.z, cfg: portableCfg(this.S, p.cfg) }));
    lib.templates = lib.templates.filter(t => t.name !== name);
    lib.templates.push({ name, layout });
    await Store.saveLib(lib);
    toast(`Modello "${name}" salvato: lo trovi in Layout in tutte le uscite.`);
  },
  async deleteTemplate(lib) {
    const sel = h('select', { class: 'full' }, lib.templates.map(t => h('option', { value: t.name }, t.name)));
    modal({ title: 'Elimina un modello', body: h('label', { class: 'f' }, 'Modello', sel), actions: [{ label: 'Annulla' }, { label: 'Elimina', kind: 'danger', run: async () => { lib.templates = lib.templates.filter(t => t.name !== sel.value); await Store.saveLib(lib); toast('Modello eliminato.'); } }] });
  },
  applyTemplate(tp) {
    this.applyLayout(tp.layout.map(p => Object.assign({}, p, { cfg: resolveCfg(this.S, p.cfg, p.type) })));
    toast(`Applicato il modello "${tp.name}".`);
  },

  /* ---------- Orologio ---------- */
  requestDraw() { this.dirty = true; this.drawSeq++; },
  seek(t) {
    if (!this.S) return;
    // nel live: tornare indietro sospende il "segui il live"
    if (this.S.live && t < this.S.t1 - 3000 && this.S.follow) { this.S.follow = false; this.S.onFollow && this.S.onFollow(); }
    this.t = clamp(t, this.S.t0, this.S.t1);
    this.anchor = { t: this.t, now: performance.now() };
    this.dirty = true;
    if (!this.playing) this.saveViewSoon();
  },
  play() {
    if (this.t >= this.S.t1 - 100) this.t = this.S.t0;
    this.playing = true; this.anchor = { t: this.t, now: performance.now() }; this.updatePlayBtn();
  },
  pause() { if (!this.playing) return; this.playing = false; this.master = null; this.updatePlayBtn(); this.dirty = true; this.saveViewSoon(); },
  toggle() { this.playing ? this.pause() : this.play(); },
  setRate(r) { this.rate = r; this.anchor = { t: this.t, now: performance.now() }; if (this.speedSel) this.speedSel.value = String(r); },
  loop(now) {
    if (!this.open_) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.playing) {
      // l'orologio segue il video che sta suonando; senza video segue l'ora reale
      this.master = null;
      now = performance.now();
      for (const r of this.panels.values()) if (r.type === 'video') { const mt = r.inst.masterTime(); if (mt != null) { this.master = r.inst; this.t = mt; this.anchor = { t: mt, now }; break; } }
      if (!this.master) { if (!this.anchor || now - this.anchor.now > 2000) this.anchor = { t: this.t, now: now - 16 }; this.t = this.anchor.t + (now - this.anchor.now) * this.rate; this.anchor = { t: this.t, now }; }
      if (this.t >= this.S.t1) { this.t = this.S.t1; this.pause(); }
    }
    if (this.S.live && this.S.follow && !this.scrubbing && this.S.t1 !== this.t) { this.t = this.S.t1; this.dirty = true; }
    if (this.playing || this.dirty) {
      this.dirty = false;
      for (const r of this.panels.values()) { try { r.inst.update(this.t, this.playing); } catch (e) { console.error(e); } }
      this.drawTimeline();
      this.timeEl.textContent = fmtClock(this.t, true);
    }
  },
  saveView() { if (!this.S) return; Object.assign(this.S.meta.view, { t: Math.round(this.t), win: this.win, preroll: this.preroll, inT: this.inT, outT: this.outT, locked: this.locked }); },
  saveViewSoon: debounce(function () { if (Viewer.S) { Viewer.saveView(); Viewer.S.save(); } }, 1500),

  camOffsetChanged: debounce(async function (cam) {
    const V = Viewer, S = V.S;
    if (!S || !S.channels.some(c => c.src === cam.id)) return;
    S.channels = S.channels.filter(c => c.src !== cam.id);
    S.channels.push(...await S.loadCamTelemetry(cam));
    S.derive();
    V.rebuildPanels(p => p.type !== 'video');
  }, 800),

  /* ---------- Barra del tempo ---------- */
  buildTimeline() {
    const btn = (label, title, fn) => h('button', { class: 'icon-btn', title, 'aria-label': title, onclick: fn }, label);
    this.playBtn = h('button', { class: 'btn primary sm', style: { minWidth: '44px' }, title: 'Play / pausa (spazio)', onclick: () => this.toggle() }, '▶');
    this.speedSel = h('select', { title: 'Velocità di riproduzione' }, SPEEDS.map(s => h('option', { value: s }, `${String(s).replace('.', ',')}×`)));
    this.speedSel.value = '1';
    this.speedSel.onchange = () => this.setRate(Number(this.speedSel.value));
    this.timeEl = h('div', { class: 'tl-time' }, '--:--:--');
    this.rangeEl = h('span', { class: 'range-chip' });
    this.tlCanvas = h('canvas');
    this.tlHover = h('div', { class: 'tl-hover', hidden: true });
    const wrap = h('div', { class: 'tl-canvas-wrap' }, this.tlCanvas, this.tlHover);
    const tl = h('div', { class: 'tl' },
      h('div', { class: 'tl-ctrl' },
        btn('⏮', 'Evento precedente ( [ )', () => this.jumpEvent(-1)),
        btn('−10', 'Indietro 10 s (Maiusc + ←)', () => this.seek(this.t - 10000)),
        btn('◀', 'Indietro 1 s (←)', () => this.seek(this.t - 1000)),
        this.playBtn,
        btn('▶', 'Avanti 1 s (→)', () => this.seek(this.t + 1000)),
        btn('+10', 'Avanti 10 s (Maiusc + →)', () => this.seek(this.t + 10000)),
        btn('⏭', 'Evento successivo ( ] )', () => this.jumpEvent(1)),
        this.speedSel, this.timeEl,
        h('div', { class: 'sep' }),
        h('button', { class: 'btn sm', title: 'Inizio selezione (I)', onclick: () => this.setIn() }, 'I'),
        h('button', { class: 'btn sm', title: 'Fine selezione (O)', onclick: () => this.setOut() }, 'O'),
        this.rangeEl,
        h('div', { class: 'sp' }),
        h('button', { class: 'btn sm', title: 'Aggiungi un evento a quest\'ora', onclick: () => this.addEventDialog() }, '+ Evento')),
      wrap);
    let dragging = false;
    const tAt = e => { const r = this.tlCanvas.getBoundingClientRect(); return this.S.t0 + clamp((e.clientX - r.left - 8) / (r.width - 16), 0, 1) * (this.S.t1 - this.S.t0); };
    // eventi del puntatore: funzionano con il mouse e con il dito (iPad)
    wrap.addEventListener('pointerdown', e => { dragging = true; this.scrubbing = true; this.seek(tAt(e)); e.preventDefault(); });
    window.addEventListener('pointermove', e => {
      if (dragging) this.seek(tAt(e));
      if (e.target === this.tlCanvas || dragging) {
        const r = this.tlCanvas.getBoundingClientRect(), t = tAt(e);
        this.tlHover.hidden = false; this.tlHover.style.left = clamp(e.clientX - r.left, 30, r.width - 30) + 'px'; this.tlHover.textContent = fmtClock(t);
      }
    });
    window.addEventListener('pointerup', () => { dragging = false; this.scrubbing = false; });
    wrap.addEventListener('pointerleave', () => { if (!dragging) this.tlHover.hidden = true; });
    this.updateRange();
    return tl;
  },
  updatePlayBtn() { if (this.playBtn) this.playBtn.textContent = this.playing ? '❚❚' : '▶'; },
  drawTimeline() {
    const c = this.tlCanvas;
    if (!c || !this.S) return;
    const S = this.S, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement);
    const col = k => cs.getPropertyValue(k).trim();
    const L = 8, R = W - 8, X = t => L + (t - S.t0) / (S.t1 - S.t0) * (R - L);
    // ore
    ctx.font = '10px ' + col('--font'); ctx.fillStyle = col('--faint'); ctx.textAlign = 'center';
    const span = S.t1 - S.t0, stepM = [1, 2, 5, 10, 15, 30, 60, 120].find(m => span / (m * 60000) <= Math.max(4, W / 90)) || 240;
    ctx.strokeStyle = col('--grid');
    for (let t = Math.ceil(S.t0 / (stepM * 60000)) * stepM * 60000; t < S.t1; t += stepM * 60000) {
      const x = X(t); ctx.fillText(fmtClock(t).slice(0, 5), x, 9);
      ctx.beginPath(); ctx.moveTo(x + .5, 12); ctx.lineTo(x + .5, H); ctx.stroke();
    }
    let y = 14;
    const cams = S.meta.cameras;
    const rowH = cams.length > 2 ? 5 : 7;
    cams.forEach((cam, i) => {
      ctx.fillStyle = col('--surface-3'); ctx.fillRect(L, y, R - L, rowH);
      ctx.fillStyle = seriesColor(i);
      for (const cl of cam.clips) { const a = X(S.clipStart(cam, cl)), b = X(S.clipStart(cam, cl) + cl.duration * 1000); ctx.fillRect(a, y, Math.max(2, b - a - 1), rowH); }
      y += rowH + 2;
    });
    // dove ci sono insieme video e dati
    if (!this._cov || this._covSeq !== S.channels.length + ':' + S.meta.cameras.map(c => c.offset).join()) { this._cov = coverage(S); this._covSeq = S.channels.length + ':' + S.meta.cameras.map(c => c.offset).join(); }
    if (this._cov.both.length) { ctx.fillStyle = col('--good'); for (const [a, b] of this._cov.both) ctx.fillRect(X(a), y, Math.max(2, X(b) - X(a)), 3); y += 5; }
    // copertura dei dati
    ctx.fillStyle = col('--surface-3'); ctx.fillRect(L, y, R - L, 3);
    ctx.fillStyle = col('--muted');
    for (const ch of S.channels) { if (ch.role === 'lat' || ch.role === 'lon' || ch.derived) continue; ctx.fillRect(X(ch.t[0]), y, Math.max(1, X(ch.t[ch.t.length - 1]) - X(ch.t[0])), 3); }
    y += 6;
    // selezione
    if (this.inT != null) {
      const a = X(this.inT), b = this.outT != null ? X(this.outT) : a + 2;
      ctx.fillStyle = col('--accent-soft'); ctx.fillRect(a, 12, b - a, H - 12);
      ctx.fillStyle = col('--accent'); ctx.fillRect(a, 12, 1.5, H - 12); if (this.outT != null) ctx.fillRect(b - 1.5, 12, 1.5, H - 12);
    }
    // tratti
    for (const ev of S.meta.events) {
      if (ev.type !== 'tratto') continue;
      const a = X(ev.t), b = X(ev.t2 ?? this.t);
      ctx.fillStyle = eventColor('tratto') + '40'; ctx.fillRect(a, 12, Math.max(2, b - a), H - 12);
    }
    // eventi
    for (const ev of S.meta.events) {
      if (ev.type === 'tratto') continue;
      const x = X(ev.t); ctx.fillStyle = eventColor(ev.type);
      ctx.beginPath(); ctx.moveTo(x, H - 9); ctx.lineTo(x + 4, H - 1); ctx.lineTo(x - 4, H - 1); ctx.fill();
    }
    // cursore
    const cx = X(this.t);
    ctx.fillStyle = col('--cursor'); ctx.fillRect(cx - 1, 11, 2, H - 11);
    ctx.beginPath(); ctx.moveTo(cx - 5, 11); ctx.lineTo(cx + 5, 11); ctx.lineTo(cx, 17); ctx.fill();
  },
  jumpEvent(dir) {
    const ev = this.S.meta.events;
    const ref = this.t + this.preroll * (dir > 0 ? 1 : 1);
    const e = dir > 0 ? ev.find(e => e.t > ref + 500) : [...ev].reverse().find(e => e.t < ref - 1500);
    if (e) this.seek(e.t - this.preroll);
  },
  setIn() { this.inT = this.t; if (this.outT != null && this.outT <= this.inT) this.outT = null; this.updateRange(); },
  setOut() { if (this.inT == null || this.t <= this.inT) { toast('Prima segna l\'inizio della selezione con I.'); return; } this.outT = this.t; this.updateRange(); },
  clearRange() { this.inT = this.outT = null; this.updateRange(); },
  updateRange() {
    if (!this.rangeEl) return;
    this.rangeEl.textContent = '';
    if (this.inT != null) this.rangeEl.append(`Selezione ${fmtClock(this.inT)}${this.outT != null ? ' – ' + fmtClock(this.outT) + ' (' + fmtDur(this.outT - this.inT) + ')' : ' – …'}`,
      this.outT != null ? h('button', { class: 'btn sm primary', onclick: () => showRangeAnalysis(this, this.inT, this.outT) }, 'Analizza') : null,
      this.outT != null ? h('button', { class: 'btn sm', onclick: () => this.exportRange() }, 'Esporta CSV') : null,
      h('button', { class: 'icon-btn', title: 'Togli la selezione (X)', 'aria-label': 'Togli la selezione', onclick: () => this.clearRange() }, '✕'));
    this.requestDraw(); this.saveViewSoon();
  },
  exportRange() {
    const S = this.S, a = this.inT, b = this.outT;
    const chans = S.channels.filter(c => !c.circular || true);
    const step = Math.max(100, Math.min(...chans.map(c => c.step)));
    const lines = ['ora;' + chans.map(c => `${c.name}${c.unit ? ' (' + c.unit + ')' : ''} [${c.srcName}]`).join(';')];
    for (let t = a; t <= b; t += step) {
      const d = new Date(t);
      lines.push(`${fmtClock(t)}.${String(d.getMilliseconds()).padStart(3, '0')};` + chans.map(c => { const v = interp(c, t); return isFinite(v) ? String(Math.round(v * 1e6) / 1e6).replace('.', ',') : ''; }).join(';'));
    }
    downloadText(`selezione ${S.meta.date} ${fmtClock(a).replace(/:/g, '.')}.csv`, '﻿' + lines.join('\n'));
  },

  /* ---------- Eventi ---------- */
  eventsChanged() {
    for (const r of this.panels.values()) if (r.inst.eventsChanged) r.inst.eventsChanged();
    this.requestDraw();
  },
  quickEvent(type) {
    const e = this.S.addEvent({ t: Math.round(this.t), type });
    this.undo.push(e.id);
    this.eventsChanged();
    toast(`${EVT[type].label} alle ${fmtClock(e.t)} · ⌘Z per annullare`, 2500);
  },
  addEventDialog(type = 'nota') { this.editEvent({ t: Math.round(this.t), type, note: '' }, true); },
  editEvent(ev, isNew = false) {
    const wasPlaying = this.playing; this.pause();
    const tsel = h('select', { class: 'full' }, EVENT_TYPES.map(e => h('option', { value: e.id }, e.label)));
    tsel.value = ev.type;
    const note = h('textarea', { rows: 3, placeholder: 'Cosa è successo? (es. ritardo in uscita, prodiere lento sul trapezio)' }); note.value = ev.note || '';
    let t = ev.t;
    const tl = h('b', { class: 'num' }, fmtClock(t, true));
    const nudge = d => { t += d; tl.textContent = fmtClock(t, true); };
    const body = h('div', { style: { display: 'grid', gap: '12px' } },
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Ora'), tl, h('div', { class: 'sp' }), ...[-5000, -1000, 1000, 5000].map(d => h('button', { class: 'btn sm', onclick: () => nudge(d) }, (d > 0 ? '+' : '−') + Math.abs(d / 1000) + ' s')), h('button', { class: 'btn sm', onclick: () => { t = Math.round(this.t); tl.textContent = fmtClock(t, true); } }, 'Ora del cursore')),
      h('label', { class: 'f' }, 'Tipo', tsel), h('label', { class: 'f' }, 'Nota', note));
    note.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { m.box.querySelector('.modal-foot .primary').click(); } });
    const m = modal({ title: isNew ? 'Nuovo evento' : 'Modifica evento', body, onClose: () => { if (wasPlaying && isNew) this.play(); }, actions: [
      !isNew ? { label: 'Elimina', kind: 'danger', run: () => this.removeEvent(ev) } : null,
      { label: 'Annulla' },
      { label: 'Salva', kind: 'primary', run: () => {
        if (isNew) { const e = this.S.addEvent({ t, type: tsel.value, note: note.value.trim() }); this.undo.push(e.id); }
        else { ev.t = t; ev.type = tsel.value; ev.note = note.value.trim(); delete ev.auto; this.S.meta.events.sort((a, b) => a.t - b.t); this.S.save(); }
        this.eventsChanged();
      } }].filter(Boolean) });
    setTimeout(() => note.focus(), 40);
  },
  removeEvent(ev) { this.S.removeEvent(ev.id); this.eventsChanged(); toast('Evento eliminato.', 2000); },
  detectManeuvers() {
    const S = this.S;
    if (!S.cog) { toast('Per trovare le manovre servono posizioni GPS o una rotta (COG/heading).', 6000); return; }
    const cfg = Object.assign({}, MAN_DEFAULT, S.meta.manCfg || {});
    const ang = h('input', { type: 'number', min: 30, max: 170, step: 5, value: cfg.angle, style: { width: '80px' } });
    const kn = h('input', { type: 'number', min: 0, max: 20, step: 0.5, value: cfg.minKn, style: { width: '80px' } });
    const autoOld = S.meta.events.filter(e => e.auto && ['virata', 'strambata', 'manovra'].includes(e.type) && !e.note);
    const redo = h('input', { type: 'checkbox', checked: autoOld.length > 0 });
    const w = S.wind;
    modal({ title: 'Trova manovre', body: h('div', { style: { display: 'grid', gap: '12px' } },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Conta come manovra un cambio di rotta rapido con la barca che naviga prima e dopo. Le soste con la prua al vento tra una prova e l\'altra non contano, perché lì la barca è lenta.'),
      h('label', { class: 'row', style: { gap: '10px' } }, 'Cambio di rotta di almeno', ang, '°'),
      h('label', { class: 'row', style: { gap: '10px' } }, 'Velocità prima e dopo di almeno', kn, 'nodi'),
      autoOld.length ? h('label', { class: 'row', style: { gap: '10px' } }, redo, `Rifai da capo: togli le ${autoOld.length} manovre trovate prima in automatico (quelle segnate a mano o con una nota restano)`) : null,
      h('p', { class: 'faint small', style: { margin: 0 } }, w ? `Virata o strambata: le distinguo col vento ${w.manual ? 'indicato' : 'stimato'} (da ${Math.round(w.twd)}°).` : 'Senza vento (indicato o stimato) le manovre si chiamano solo "manovra".')),
      actions: [{ label: 'Annulla' }, { label: 'Trova', kind: 'primary', run: () => {
        const opt = { angle: clamp(Number(ang.value) || MAN_DEFAULT.angle, 30, 170), minKn: clamp(Number(kn.value) || 0, 0, 20) };
        S.meta.manCfg = opt; S._manAuto = null;
        if (redo.checked) { const ids = new Set(autoOld.map(e => e.id)); S.meta.events = S.meta.events.filter(e => !ids.has(e.id)); }
        const found = detectManeuvers(S.cog, S.sog, S.wind ? S.twdAt : NaN, opt);
        let n = 0;
        for (const f of found) {
          if (S.meta.events.some(e => ['virata', 'strambata', 'manovra'].includes(e.type) && Math.abs(e.t - f.t) < 15000)) continue;
          S.meta.events.push({ id: uid('e'), t: Math.round(f.t), type: f.type, note: '', auto: true });
          n++;
        }
        S.meta.events.sort((a, b) => a.t - b.t); S.save();
        this.eventsChanged();
        const kinds = ['virata', 'strambata', 'manovra'].map(k => [k, found.filter(f => f.type === k).length]).filter(x => x[1]).map(([k, c]) => `${c} ${k === 'virata' ? (c === 1 ? 'virata' : 'virate') : k === 'strambata' ? (c === 1 ? 'strambata' : 'strambate') : (c === 1 ? 'manovra' : 'manovre')}`);
        toast(n ? `Trovate ${n} manovre${kinds.length ? ' (' + kinds.join(', ') + ')' : ''}${redo.checked ? ', rifatte da capo' : ''}.` : 'Nessuna manovra nuova trovata.', 7000);
      } }] });
  },

  /* ---------- Tastiera ---------- */
  key(e) {
    if (document.querySelector('.modal-back')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') {
      const id = this.undo.pop();
      if (id) { this.S.removeEvent(id); this.eventsChanged(); toast('Evento annullato.', 1800); }
      e.preventDefault(); return;
    }
    if (e.metaKey || e.ctrlKey || (e.altKey && !/^Arrow/.test(k))) return;
    const frame = 1000 / 30;
    switch (k) {
      case ' ': this.toggle(); break;
      case 'ArrowLeft': this.seek(this.t - (e.shiftKey ? 10000 : e.altKey ? frame : 1000)); break;
      case 'ArrowRight': this.seek(this.t + (e.shiftKey ? 10000 : e.altKey ? frame : 1000)); break;
      case ',': this.seek(this.t - frame); break;
      case '.': this.seek(this.t + frame); break;
      case 'ArrowUp': this.setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.rate) + 1)]); break;
      case 'ArrowDown': this.setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(this.rate) - 1)]); break;
      case 'Home': this.seek(this.S.t0); break;
      case 'End': this.seek(this.S.t1); break;
      case '[': this.jumpEvent(-1); break;
      case ']': this.jumpEvent(1); break;
      case 'i': case 'I': this.setIn(); break;
      case 'o': case 'O': this.setOut(); break;
      case 'x': case 'X': this.clearRange(); break;
      case 'n': case 'N': this.addEventDialog('nota'); break;
      default: {
        const et = EVENT_TYPES.find(x => x.key === k.toLowerCase());
        if (!et) return;
        this.quickEvent(et.id);
      }
    }
    e.preventDefault();
  },
  help() {
    const rows = [['Spazio', 'Play / pausa'], ['← →', 'Indietro / avanti 1 s'], ['Maiusc + ← →', '10 s'], ['Alt + ← →  oppure  , .', 'Un fotogramma'], ['↑ ↓', 'Velocità di riproduzione'], ['[ ]', 'Evento precedente / successivo'], ['I  O  X', 'Inizio, fine, togli selezione'],
      ...EVENT_TYPES.filter(e => e.key).map(e => [e.key.toUpperCase(), `Segna: ${e.label}${e.id === 'nota' ? ' (con testo)' : ''}`]), ['⌘ Z', 'Annulla l\'ultimo evento segnato'], ['Maiusc + trascina', 'Su un grafico: seleziona un tratto e lo analizza'], ['Tasto destro', 'Sulla dashboard: aggiungi o modifica i pannelli']];
    modal({ title: 'Scorciatoie da tastiera', body: h('div', null, h('div', { class: 'help-grid' }, rows.flatMap(([a, b]) => [h('span', null, ...a.split('  ').map((x, i) => [i ? ' · ' : '', h('span', { class: 'kbd' }, x)])), h('span', null, b)])),
      h('p', { style: { marginTop: '14px' } }, 'Sui grafici: clic per andare a quell\'ora, trascina per scorrere, rotella per allargare o stringere la finestra. Sulla mappa: clic sulla traccia per andare a quel punto. I pannelli si spostano solo dalla maniglia ⠿ in alto a sinistra e si ridimensionano dall\'angolo in basso a destra.')) });
  },
  infoBox() {
    const m = this.S.meta;
    const rows = [['Data', fmtDateLong(m.date)], ['Luogo', m.place], ['Barca', m.boat], ['Equipaggio', [m.helm, m.crew].filter(Boolean).join(' / ')], ['Vento', (m.windMin || m.windMax) ? `${m.windMin || '?'}–${m.windMax || '?'} kn` + (m.twd ? ` da ${m.twd}°` : '') : ''], ['Mare', m.sea], ['Obiettivi', m.goals], ['Note', m.notes],
      ['Posizione da', this.S.pos ? this.S.pos.name : 'nessuna'], ['Velocità principale', this.S.sog ? `${this.S.sog.name} (${this.S.sog.srcName})` : 'nessuna']].filter(r => r[1]);
    modal({ title: m.title || 'Uscita', body: h('div', { class: 'help-grid' }, rows.flatMap(([a, b]) => [h('span', { class: 'muted' }, a), h('span', { style: { whiteSpace: 'pre-wrap' } }, b)])),
      actions: [{ label: 'Modifica in "Video e dati"', run: () => Router.go(`#/uscita/${encodeURIComponent(this.S.folder)}/dati`) }, { label: 'Chiudi', kind: 'primary' }] });
  }
};

/* ---------- Menu a tendina ---------- */
function menu(anchor, items) {
  const old = $('.menu'); if (old) old.remove();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) m.append(h('hr'));
    else if (it.head) m.append(h('div', { class: 'mh' }, it.head));
    else m.append(h('button', { disabled: it.disabled, style: it.disabled ? { color: 'var(--faint)' } : null, onclick: () => { m.remove(); it.run && it.run(); } }, it.label));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.maxHeight = (window.innerHeight - 16) + 'px'; m.style.overflowY = 'auto';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8)) + 'px';
  m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
}

/* ---------- Layout predefinito, costruito sui dati disponibili ---------- */
function defaultLayout(S) {
  const ids = role => S.roleChannels(role).map(c => c.id);
  const pick = (...lists) => [...new Set(lists.flat())].filter(Boolean);
  const sog = S.sog ? [S.sog.id] : [];
  const loads = ids('load');
  const hr = ids('hr').slice(0, 1);
  const heel = ids('heel').slice(0, 1), pitch = ids('pitch').slice(0, 1);
  const twa = S.ch('calc:twa') ? ['calc:twa'] : [], vmg = S.ch('calc:vmg') ? ['calc:vmg'] : [];
  const cogId = S.cog ? [S.cog.id] : [];
  const nums = pick(sog, hr, vmg, cogId, twa, heel, pitch, loads).slice(0, 8);
  const cams = S.meta.cameras;
  const L = [];
  L.push({ type: 'numbers', x: 0, y: 0, w: 5, h: 13, cfg: { ids: nums } });
  if (cams.length === 0) L.push({ type: 'chart', x: 5, y: 0, w: 19, h: 13, cfg: { title: 'Velocità e carichi', ids: pick(sog, vmg, loads, hr) } });
  else {
    if (cams.length === 1) L.push({ type: 'video', x: 5, y: 0, w: 11, h: 13, cfg: { cam: cams[0].id } });
    else if (cams.length === 2) { L.push({ type: 'video', x: 5, y: 0, w: 6, h: 13, cfg: { cam: cams[0].id } }); L.push({ type: 'video', x: 11, y: 0, w: 5, h: 13, cfg: { cam: cams[1].id } }); }
    else cams.slice(0, 4).forEach((c, i) => L.push({ type: 'video', x: 5 + (i % 2) * 6 - (i % 2 ? 1 : 0), y: Math.floor(i / 2) * 7, w: i % 2 ? 6 : 5, h: i < 2 ? 7 : 6, cfg: { cam: c.id } }));
    L.push({ type: 'chart', x: 16, y: 0, w: 8, h: 13, cfg: { title: 'Velocità e carichi', ids: pick(sog, vmg, loads, hr) } });
  }
  L.push({ type: 'events', x: 0, y: 13, w: 8, h: 6, cfg: {} });
  L.push({ type: 'coverage', x: 0, y: 19, w: 8, h: 5, cfg: {} });
  L.push({ type: 'map', x: 8, y: 13, w: 8, h: 11, cfg: {} });
  const att = pick(heel, pitch, ids('heel'), ids('pitch'), ids('other').filter(id => /:acc$/.test(id)).slice(0, 1));
  L.push(att.length ? { type: 'chart', x: 16, y: 13, w: 8, h: 11, cfg: { title: 'Assetto', ids: att } }
    : { type: 'stats', x: 16, y: 13, w: 8, h: 11, cfg: { ids: pick(sog, hr, loads, ids('other').filter(id => !/:(dist|alt)$/.test(id)).slice(0, 3)) } });
  return L;
}

/* Modelli di layout validi per tutte le uscite: i canali si salvano per nome e ruolo, non per identificativo */
function portableCfg(S, cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  const ref = id => { const c = S.ch(id); return c ? { name: c.name, role: c.role, srcName: c.srcName, unit: c.unit } : null; };
  if (cfg.ids) out.ids = cfg.ids.map(ref).filter(Boolean);
  if (cfg.colorBy) out.colorBy = ref(cfg.colorBy);
  if (cfg.cam) out.cam = S.meta.cameras.findIndex(c => c.id === cfg.cam);
  return out;
}
function resolveCfg(S, cfg, type) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const used = new Set();
  const find = r => {
    if (!r || typeof r === 'string') return S.ch(r) ? r : null;
    const nm = modernName(r.name);
    const c = S.channels.find(c => !used.has(c.id) && c.name === nm && c.srcName === r.srcName) || S.channels.find(c => !used.has(c.id) && c.name === nm)
      || S.channels.find(c => !used.has(c.id) && c.role === r.role && r.role !== 'other' && c.unit === r.unit) || (r.role === 'sog' && S.sog && !used.has(S.sog.id) ? S.sog : null);
    if (c) used.add(c.id);
    return c ? c.id : null;
  };
  if (cfg && cfg.ids) out.ids = cfg.ids.map(find).filter(Boolean);
  if (cfg && cfg.colorBy) out.colorBy = find(cfg.colorBy);
  if (type === 'video') { const c = S.meta.cameras[Math.max(0, cfg.cam || 0)] || S.meta.cameras[0]; out.cam = c && c.id; }
  return out;
}
