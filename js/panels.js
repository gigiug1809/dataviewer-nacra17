/* Pannelli del viewer. Ogni pannello: { el (corpo), update(t, playing), resize(), destroy(), settings() } */
'use strict';
/* grandezza del testo dei pannelli (A− / A+) */
const SIZE_STEPS = [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3];
const PANEL_SIZE_OK = type => type !== 'map' && type !== 'video';
const ICONS = {
  grip: '<svg viewBox="0 0 12 16" fill="currentColor"><circle cx="3.5" cy="3" r="1.4"/><circle cx="8.5" cy="3" r="1.4"/><circle cx="3.5" cy="8" r="1.4"/><circle cx="8.5" cy="8" r="1.4"/><circle cx="3.5" cy="13" r="1.4"/><circle cx="8.5" cy="13" r="1.4"/></svg>',
  gear: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></svg>',
  close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 5l10 10M15 5L5 15"/></svg>',
  sync: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="11" r="6.5"/><path d="M10 7.5V11l2.5 1.5M8 2.5h4"/></svg>',
  sound: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M13.5 7a4 4 0 0 1 0 6"/></svg>',
  mute: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M13.5 8l4 4M17.5 8l-4 4"/></svg>',
  full: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4"/></svg>',
  follow: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="3"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3"/></svg>'
};
const WINDOWS = [[10e3, '10 s'], [30e3, '30 s'], [60e3, '1 min'], [120e3, '2 min'], [300e3, '5 min'], [600e3, '10 min'], [1800e3, '30 min'], [0, 'Tutta l\'uscita']];
const PANEL_TYPES = {
  video: { label: 'Video', icon: '🎥' }, chart: { label: 'Grafico', icon: '📈' }, map: { label: 'Mappa', icon: '🗺' },
  numbers: { label: 'Numeri', icon: '🔢' }, events: { label: 'Eventi', icon: '🏷' }, stats: { label: 'Statistiche', icon: 'Σ' }
};

function chName(c) { return c ? c.name : '—'; }
function fmtVal(c, v) { if (!c || !isFinite(v)) return '—'; return fmtNum(v, c.dec ?? 1); }
function dirLabel(v) { return isFinite(v) ? Math.round((v + 360) % 360) + '°' : '—'; }

/* Selettore di canali raggruppati per fonte (ordine = ordine di scelta) */
function channelPicker(S, selected, opts = {}) {
  const sel = selected.slice();
  const box = h('div', { class: 'ch-pick' });
  const groups = new Map();
  for (const c of S.channels) {
    if (!opts.withPos && (c.role === 'lat' || c.role === 'lon')) continue;
    const g = c.srcName || 'Altro';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  for (const [g, list] of groups) {
    box.append(h('div', { class: 'grp' }, g));
    for (const c of list) {
      const cb = h('input', { type: opts.single ? 'radio' : 'checkbox', name: 'chp', checked: sel.includes(c.id) });
      cb.addEventListener('change', () => {
        if (opts.single) { sel.length = 0; sel.push(c.id); opts.onChange && opts.onChange(); return; }
        const i = sel.indexOf(c.id);
        if (cb.checked && i < 0) sel.push(c.id); else if (!cb.checked && i >= 0) sel.splice(i, 1);
        opts.onChange && opts.onChange();
      });
      box.append(h('label', null, cb, c.name, h('span', { class: 'faint small' }, c.unit ? ` ${c.unit}` : '')));
    }
  }
  if (!S.channels.length) box.append(h('p', { class: 'muted' }, 'Nessun canale: carica dei dati nella pagina "Video e dati".'));
  return { el: box, get: () => sel.filter(id => S.byId.has(id)) };
}

/* =================== VIDEO =================== */
class VideoPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    if (!cfg.cam || !this.cam()) cfg.cam = (this.S.meta.cameras[0] || {}).id;
    this.el = h('div', { class: 'vid-box' });
    this.video = h('video', { playsinline: true, muted: true, preload: 'auto' });
    this.video.muted = cfg.muted !== false;
    this.tag = h('div', { class: 'vid-tag' });
    this.msg = h('div', { class: 'vid-msg', hidden: true });
    this.el.append(this.video, this.tag, this.msg);
    this.clip = null; this.loading = null; this.pendingSeek = null; this.unlocked = false; this.syncBar = null; this.lastSeek = 0;
    this.video.addEventListener('seeked', () => { if (this.pendingSeek != null) { const s = this.pendingSeek; this.pendingSeek = null; this.seekTo(s); } else this.V.requestDraw(); });
    this.video.addEventListener('error', () => { if (this.clip) this.showMsg(`Non riesco a riprodurre ${this.clip.file.split('/').pop()}. ${this.clip.codec === 'hvc1' ? 'È un video HEVC: usa Google Chrome aggiornato su un Mac recente.' : ''}`); });
    this.video.addEventListener('timeupdate', () => { if (this.unlocked) this.renderSync(); });
  }
  cam() { return this.S.meta.cameras.find(c => c.id === this.cfg.cam); }
  title() { const c = this.cam(); return c ? `Video · ${c.name}` : 'Video'; }
  headButtons() {
    const mute = h('button', { class: 'icon-btn', title: 'Audio', 'aria-label': 'Audio', html: this.video.muted ? ICONS.mute : ICONS.sound });
    mute.onclick = () => { this.video.muted = !this.video.muted; this.cfg.muted = this.video.muted; mute.innerHTML = this.video.muted ? ICONS.mute : ICONS.sound; this.V.layoutChanged(); };
    return [
      h('button', { class: 'icon-btn', title: 'Sincronizza questo video con i dati', 'aria-label': 'Sincronizza', html: ICONS.sync, onclick: () => this.toggleSync() }),
      mute,
      h('button', { class: 'icon-btn', title: 'Schermo intero', 'aria-label': 'Schermo intero', html: ICONS.full, onclick: () => this.el.requestFullscreen && this.el.requestFullscreen() })
    ];
  }
  showMsg(text, extra) {
    this.msg.hidden = false; this.msg.textContent = '';
    this.msg.append(h('div', null, h('span', null, text), extra || null));
  }
  async load(clip, target) {
    this.clip = clip;
    const token = this.loading = {};
    try {
      const url = await this.S.videoURL(clip);
      if (this.loading !== token) return;
      this.video.src = url;
      await new Promise((res, rej) => { this.video.onloadedmetadata = res; this.video.onerror = rej; });
      if (this.loading !== token) return;
      this.video.currentTime = target;
      this.msg.hidden = true;
    } catch (e) {
      if (this.loading === token) this.showMsg(`Video non disponibile: ${clip.file}. Il disco è collegato?`);
    }
    if (this.loading === token) this.loading = null;
  }
  seekTo(sec) {
    if (this.video.seeking) { this.pendingSeek = sec; return; }
    if (typeof this.video.fastSeek === 'function' && this.V.scrubbing) this.video.fastSeek(sec);
    else this.video.currentTime = sec;
  }
  target(t, clip = this.clip) { return (t - this.S.clipStart(this.cam(), clip)) / 1000; }
  // ora "vera" indicata da questo video, se sta guidando la riproduzione
  masterTime() {
    if (this.unlocked || !this.clip || this.loading || this.video.paused || this.video.seeking || this.video.readyState < 3) return null;
    if (this.V.rate > 4) return null;
    return this.S.clipStart(this.cam(), this.clip) + this.video.currentTime * 1000;
  }
  update(t, playing) {
    const cam = this.cam();
    if (!cam) { this.tag.hidden = true; this.showMsg('Nessuna camera in questa uscita. Aggiungi i video nella pagina "Video e dati".'); return; }
    if (this.unlocked) { this.renderSync(); return; }
    const clip = this.S.clipAt(cam, t);
    if (!clip) {
      if (this.clip) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.clip = null; this.loading = null; }
      const nx = this.S.nextClip(cam, t);
      this.tag.hidden = true;
      const txt = cam.clips.length ? (nx ? `Nessun video a quest'ora. Il prossimo inizia alle ${fmtClock(this.S.clipStart(cam, nx))}.` : 'Nessun video dopo quest\'ora.') : 'Questa camera non ha video.';
      if (this.msg.dataset.k !== txt) { this.msg.dataset.k = txt; this.showMsg(txt, nx ? h('button', { class: 'btn sm', onclick: () => this.V.seek(this.S.clipStart(cam, nx) + 100) }, 'Vai al video') : null); }
      return;
    }
    this.msg.dataset.k = '';
    const tg = this.target(t, clip);
    if (clip !== this.clip) { this.load(clip, tg); this.tag.hidden = false; return; }
    if (this.loading) return;
    this.tag.hidden = false;
    this.tag.textContent = `${clip.file.split('/').pop()}  ${fmtOffsetShort(this.video.currentTime)}`;
    const v = this.video;
    if (playing) {
      if (this.V.rate > 4) {
        if (!v.paused) v.pause();
        const now = performance.now();
        if (now - this.lastSeek > 250) { this.lastSeek = now; this.seekTo(tg); }
        return;
      }
      if (v.playbackRate !== this.V.rate) v.playbackRate = this.V.rate;
      if (v.paused && !v.ended) v.play().catch(() => {});
      if (this.V.master !== this && Math.abs(v.currentTime - tg) > 0.3) this.seekTo(tg);
    } else {
      if (!v.paused) v.pause();
      const frame = 1 / (clip.fps || 30);
      if (Math.abs(v.currentTime - tg) > frame * 0.6) this.seekTo(tg);
    }
  }

  /* ---------- Strumento di sincronizzazione ---------- */
  toggleSync() {
    if (this.syncBar) { this.syncBar.remove(); this.syncBar = null; this.unlocked = false; this.video.controls = false; this.V.requestDraw(); return; }
    const cam = this.cam();
    if (!cam) return;
    this.V.pause();
    this.syncBar = h('div', { class: 'sync-bar' });
    this.el.append(this.syncBar);
    this.renderSync(true);
  }
  nudge(ms) {
    const cam = this.cam();
    cam.offset = Math.round((Number(cam.offset) || 0) + ms);
    cam.sync = { method: 'manual', at: Date.now() };
    this.afterOffset();
  }
  afterOffset() {
    this.S.save();
    this.S.range();
    this.V.camOffsetChanged(this.cam());
    this.renderSync(true);
    this.V.requestDraw();
  }
  renderSync(force) {
    const bar = this.syncBar;
    if (!bar) return;
    const cam = this.cam(), off = Number(cam.offset) || 0;
    const info = bar.querySelector('.sync-info');
    const vt = this.clip ? this.S.clipStart(cam, this.clip) + this.video.currentTime * 1000 : NaN;
    const txt = this.unlocked
      ? [h('span', null, 'Fotogramma: '), h('b', null, fmtClock(vt, true)), h('span', null, ' · Cursore dati: '), h('b', null, fmtClock(this.V.t, true)), h('span', null, ' · differenza '), h('b', null, fmtOffset(this.V.t - vt))]
      : [h('span', null, 'Correzione orologio di ' + cam.name + ': '), h('b', null, fmtOffset(off))];
    if (info && !force) { info.textContent = ''; info.append(...txt); return; }
    bar.textContent = '';
    const nb = (label, ms) => h('button', { class: 'btn sm', onclick: () => this.nudge(ms) }, label);
    const frame = 1000 / ((this.clip && this.clip.fps) || 30);
    bar.append(h('div', { class: 'row sync-info' }, ...txt), h('div', { class: 'sp' }));
    if (!this.unlocked) {
      bar.append(
        h('div', { class: 'row' }, h('span', null, 'Video prima'), nb('−1 h', -3600e3), nb('−1 min', -60e3), nb('−1 s', -1000), nb('−0,1 s', -100), nb('−1 fot.', -frame),
          nb('+1 fot.', frame), nb('+0,1 s', 100), nb('+1 s', 1000), nb('+1 min', 60e3), nb('+1 h', 3600e3), h('span', null, 'Video dopo')),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm primary', onclick: () => { this.unlocked = true; this.video.controls = true; this.renderSync(true); } }, 'Sincronizza con un evento…'),
          h('button', { class: 'btn sm', onclick: () => { cam.offset = 0; this.afterOffset(); } }, 'Azzera'),
          h('div', { class: 'sp' }), h('button', { class: 'btn sm', onclick: () => this.toggleSync() }, 'Chiudi')));
    } else {
      bar.append(
        h('div', { class: 'small', style: { color: '#bbb' } }, '1. Con i controlli del video trova un momento riconoscibile (inizio di una virata, un colpo d\'onda, un battito di mani). 2. Sposta il cursore dei dati (barra in basso o grafici) sullo stesso momento. 3. Premi "Fissa".'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { this.video.currentTime = Math.max(0, this.video.currentTime - frame / 1000); } }, '◀ fotogramma'),
          h('button', { class: 'btn sm', onclick: () => { this.video.currentTime += frame / 1000; } }, 'fotogramma ▶'),
          h('div', { class: 'sp' }),
          h('button', { class: 'btn sm', onclick: () => { this.unlocked = false; this.video.controls = false; this.renderSync(true); this.V.requestDraw(); } }, 'Annulla'),
          h('button', { class: 'btn sm primary', onclick: () => this.fix() }, 'Fissa: questo fotogramma = cursore dati')));
    }
  }
  fix() {
    const cam = this.cam();
    if (!this.clip) { toast('Nessun video caricato.'); return; }
    const vt = this.S.clipStart(cam, this.clip) + this.video.currentTime * 1000;
    cam.offset = Math.round((Number(cam.offset) || 0) + (this.V.t - vt));
    cam.sync = { method: 'manual', at: Date.now() };
    this.unlocked = false; this.video.controls = false;
    this.afterOffset();
    toast(`Sincronizzato: orologio di ${cam.name} corretto di ${fmtOffset(cam.offset)}.`);
  }
  settings() {
    const sel = h('select', { class: 'full' }, this.S.meta.cameras.map(c => h('option', { value: c.id }, c.name)));
    sel.value = this.cfg.cam || '';
    return { el: h('label', { class: 'f' }, 'Camera', sel), apply: () => { this.cfg.cam = sel.value; this.clip = null; } };
  }
  resize() {}
  destroy() { this.loading = null; this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
}
function fmtOffsetShort(sec) { const m = Math.floor(sec / 60), s = sec - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; }

/* =================== GRAFICO =================== */
class ChartPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    cfg.ids = (cfg.ids || []).filter(id => this.S.live || this.S.byId.has(id));
    this.el = h('div', { class: 'chart-body', style: { position: 'absolute', inset: 0 } });
    this.lanes = [];
    this.build();
  }
  title() { return this.cfg.title || 'Grafico'; }
  /* grandezza di scritte e assi: rifaccio i grafici con i caratteri più grandi */
  setSize(s) { if (this.sz === s) return; const first = this.sz == null; this.sz = s; if (!first || s !== 1) this.build(); }
  win() { return this.cfg.win != null ? this.cfg.win : this.V.win; }
  headButtons() {
    const sel = h('select', { title: 'Finestra di tempo', style: { minHeight: '22px', fontSize: '11px', padding: '1px 22px 1px 6px', backgroundPosition: 'right 6px center' } },
      h('option', { value: '' }, 'come la barra'), WINDOWS.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = this.cfg.win == null ? '' : String(this.cfg.win);
    sel.onchange = () => { this.cfg.win = sel.value === '' ? null : Number(sel.value); this.lastKey = ''; this.V.layoutChanged(); this.V.requestDraw(); };
    sel.addEventListener('mousedown', e => e.stopPropagation());
    this.winSel = sel;
    const add = h('button', { class: 'icon-btn sz', title: 'Aggiungi un grafico sotto (stessa finestra di tempo)', 'aria-label': 'Aggiungi un grafico', style: { width: 'auto', padding: '0 5px' } }, '+ grafico');
    add.onclick = e => { e.stopPropagation(); this.chanMenu(add, c => { const n = this.nextLaneNo(); this.moveTo(c, n); }); };
    return [add, sel];
  }
  /* ---------- più grafici nello stesso pannello: aggiungere, togliere, scala Y ---------- */
  nextLaneNo() { let n = 0; for (const o of Object.values(this.cfg.st || {})) if (o && o.lane) n = Math.max(n, o.lane); return n + 1; }
  /* un grafico "per unità" diventa un grafico numerato, così ci si possono aggiungere linee di altre unità */
  makeManual(lane) {
    if (lane.key.startsWith('L')) return Number(lane.key.slice(1));
    const n = this.nextLaneNo(), st = this.cfg.st = this.cfg.st || {}, lanes = this.cfg.lanes = this.cfg.lanes || {};
    for (const c of lane.list) (st[c.id] = st[c.id] || {}).lane = n;
    lanes['L' + n] = Object.assign({}, this.laneY(lane.key)); delete lanes[lane.key];
    return n;
  }
  moveTo(c, n) {
    const st = this.cfg.st = this.cfg.st || {};
    if (!this.S.chs(this.cfg.ids).includes(c)) this.cfg.ids.push(c.id);
    const id = this.cfg.ids.find(x => this.S.ch(x) === c) || c.id;
    (st[id] = st[id] || {}).lane = n;
    this.changed();
  }
  removeLine(c) {
    this.cfg.ids = this.cfg.ids.filter(id => this.S.ch(id) !== c);
    if (this.cfg.st) for (const k of Object.keys(this.cfg.st)) if (this.S.ch(k) === c) delete this.cfg.st[k];
    this.changed();
  }
  changed() { this.lastKey = ''; this.build(); this.V.layoutChanged(); }
  /* elenco delle grandezze da scegliere (raggruppate per strumento) */
  chanMenu(anchor, pick) {
    const items = [], groups = new Map();
    for (const c of this.S.channels) { if (c.role === 'lat' || c.role === 'lon') continue; const g = c.srcName || 'Altro'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    for (const [g, list] of groups) { items.push({ head: g }); for (const c of list) items.push({ label: `${c.name}${c.unit ? ' · ' + c.unit : ''}`, run: () => pick(c) }); }
    if (!items.length) items.push({ label: 'Nessun dato caricato', disabled: true });
    menu(anchor, items);
  }
  /* scala verticale di un grafico (o di tutti quelli del pannello) */
  yMenu(lane, anchor) {
    const old = $('.menu'); if (old) old.remove();
    const L = Object.assign({}, this.laneY(lane.key));
    const m = h('div', { class: 'menu ypop', role: 'dialog' });
    const modes = [['window', 'Adatta alla finestra di tempo'], ['session', 'Tutta l\'uscita (fissa)'], ['sym', 'Simmetrica attorno a 0'], ['manual', 'A mano']];
    const mn = h('input', { type: 'number', step: 'any', value: L.min ?? '', placeholder: lane.fixed ? fmtNum(lane.fixed[0], 1) : 'min', style: { width: '80px' } });
    const mx = h('input', { type: 'number', step: 'any', value: L.max ?? '', placeholder: lane.fixed ? fmtNum(lane.fixed[1], 1) : 'max', style: { width: '80px' } });
    const man = h('div', { class: 'row', style: { gap: '6px', padding: '2px 10px 6px 30px' }, hidden: L.mode !== 'manual' }, 'da', mn, 'a', mx);
    const radios = modes.map(([v, l]) => { const r = h('input', { type: 'radio', name: 'ymode', value: v, checked: (L.mode || 'session') === v, onchange: () => { man.hidden = v !== 'manual'; } }); return h('label', { class: 'row', style: { gap: '8px', padding: '5px 10px', fontSize: '13px' } }, r, l); });
    const all = h('input', { type: 'checkbox' });
    const apply = () => {
      const mode = m.querySelector('input[name=ymode]:checked').value;
      const v = { mode, min: mn.value === '' ? null : Number(mn.value), max: mx.value === '' ? null : Number(mx.value) };
      const lanes = this.cfg.lanes = this.cfg.lanes || {};
      for (const l of all.checked ? this.lanes : [lane]) lanes[l.key] = Object.assign({}, v);
      m.remove(); this.changed();
    };
    m.append(h('div', { class: 'mh' }, 'Scala verticale'), ...radios, man,
      h('label', { class: 'row', style: { gap: '8px', padding: '6px 10px', fontSize: '13px', borderTop: '1px solid var(--line)' } }, all, 'Uguale per tutti i grafici del pannello'),
      h('div', { class: 'row', style: { padding: '4px 6px', justifyContent: 'flex-end', gap: '6px' } }, h('button', { class: 'btn sm', onclick: () => m.remove() }, 'Annulla'), h('button', { class: 'btn sm primary', onclick: apply }, 'Applica')));
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8)) + 'px';
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
  }
  build() {
    for (const l of this.lanes) l.u && l.u.destroy();
    this.lanes = []; this.el.textContent = '';
    const chans = this.S.chs(this.cfg.ids);
    if (!chans.length) {
      if (this.S.live && this.cfg.ids.length) { this.el.append(h('div', { class: 'pnl-empty' }, 'In attesa di questi dati dal telefono…')); return; }
      this.el.append(h('div', { class: 'pnl-empty' }, h('div', null, 'Scegli cosa mostrare in questo grafico.', h('button', { class: 'btn sm', onclick: () => this.V.panelSettings(this) }, 'Scegli i canali'))));
      return;
    }
    // più grafici nello stesso pannello: di solito uno per unità di misura (un solo asse Y per grafico),
    // ma ogni linea si può mettere nel grafico che si vuole
    const groups = this.groupLanes(chans);
    for (const [key, list] of groups) {
      const lane = { key, unit: key, circ: list.every(c => c.circular), list, colors: list.map(c => this.styleOf(c).color || seriesColor(chans.indexOf(c))), dashes: list.map(c => this.styleOf(c).dash || 'solid') };
      lane.el = h('div', { class: 'lane' });
      lane.legend = h('div', { class: 'lane-legend', style: { fontSize: `${Math.round(11 * (this.sz || 1))}px` } });
      lane.plot = h('div', { class: 'lane-plot' });
      lane.el.append(lane.legend, lane.plot);
      this.el.append(lane.el);
      lane.items = list.map((c, i) => {
        const col = lane.colors[i], d = lane.dashes[i];
        const sw = d === 'solid' ? col : `repeating-linear-gradient(90deg, ${col} 0 ${d === 'dot' ? 2 : 5}px, transparent ${d === 'dot' ? 2 : 5}px ${d === 'dot' ? 4 : 8}px)`;
        const val = h('b'); const sp = h('span', { title: c.srcName + ' · clic: nascondi/mostra' }, h('i', { style: { background: sw } }), h('em', null, c.name), val, c.unit ? h('em', null, c.unit) : null,
          this.S.live ? null : h('u', { class: 'rm', title: 'Togli questa linea', onclick: e => { e.stopPropagation(); this.removeLine(c); } }, '×'));
        sp.onclick = () => { const s = lane.u.series[i + 1]; lane.u.setSeries(i + 1, { show: !s.show }); sp.classList.toggle('off', !s.show); };
        lane.legend.append(sp);
        return { c, val, last: '' };
      });
      if (!this.S.live) lane.legend.append(h('div', { class: 'lane-tools' },
        h('button', { title: 'Aggiungi una linea a questo grafico', onclick: e => { e.stopPropagation(); this.chanMenu(e.currentTarget, c => this.moveTo(c, this.makeManual(lane))); } }, '+'),
        h('button', { title: 'Scala verticale di questo grafico', onclick: e => { e.stopPropagation(); this.yMenu(lane, e.currentTarget); } }, 'Y'),
        groups.size > 1 ? h('button', { title: 'Togli questo grafico', onclick: e => { e.stopPropagation(); this.cfg.ids = this.cfg.ids.filter(id => !lane.list.includes(this.S.ch(id))); this.changed(); } }, '×') : null));
      this.lanes.push(lane);
    }
    requestAnimationFrame(() => this.makePlots());
  }
  laneData(lane) {
    const S = this.S;
    // nel live: solo l'ultima mezz'ora (o tre finestre del grafico), così dopo ore di dati l'iPad resta veloce
    const a = S.live ? Math.max(S.t0, S.t1 - Math.max(1800e3, 3 * (this.win() || 0))) : S.t0;
    const span = Math.max(1000, S.t1 - a);
    const minStep = Math.min(...lane.list.map(c => c.step));
    const step = Math.max(minStep, span / 150000, 20);
    const n = Math.max(2, Math.floor(span / step) + 1);
    const xs = new Float64Array(n);
    for (let k = 0; k < n; k++) xs[k] = (a + k * step) / 1000;
    const ys = lane.list.map(c => { const r = resample(c, a, step, n), y = new Array(n); for (let k = 0; k < n; k++) y[k] = isFinite(r[k]) ? r[k] : null; return y; });
    let mn = Infinity, mx = -Infinity;
    for (const c of lane.list) { mn = Math.min(mn, c.min); mx = Math.max(mx, c.max); }
    if (lane.circ) { mn = 0; mx = 360; }
    else { const pad = (mx - mn) * 0.06 || 1; mn -= pad; mx += pad; if (lane.list.every(c => c.min >= 0) && mn < 0) mn = 0; }
    return { data: [xs, ...ys], fixed: [mn, mx] };
  }
  /* live: i dati sono cresciuti, aggiorno i grafici senza ricostruirli */
  refreshData() {
    const want = this.cfg.ids.filter(id => this.S.byId.has(id));
    const have = this.lanes.flatMap(l => l.list.map(c => c.id));
    if (want.join() !== have.join()) { this.build(); return; }
    for (const lane of this.lanes) { if (!lane.u) continue; const d = this.laneData(lane); lane.fixed = d.fixed; lane.u.setData(d.data, false); }
    this.lastKey = '';
  }
  makePlots() {
    const S = this.S;
    for (const lane of this.lanes) {
      if (lane.u) continue; // già fatto (build chiamato due volte di fila)
      const { data, fixed } = this.laneData(lane);
      const xs = data[0], ys = data.slice(1);
      lane.fixed = fixed;
      const cs = getComputedStyle(document.documentElement);
      const axisC = cs.getPropertyValue('--axis').trim(), gridC = cs.getPropertyValue('--grid').trim();
      const self = this;
      const rect = lane.plot.getBoundingClientRect();
      const sz = this.sz || 1, fpx = Math.round(11 * sz);
      const opts = {
        width: Math.max(50, rect.width), height: Math.max(40, rect.height),
        legend: { show: false }, padding: [6, 8, 0, 0],
        cursor: { y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
        scales: { x: { time: true }, y: { range: (u, a, b) => {
          const L = this.laneY(lane.key);
          if (L.mode === 'manual' && isFinite(L.min) && isFinite(L.max) && L.max > L.min) return [L.min, L.max];
          if (L.mode === 'sym' && !lane.circ) { const m = Math.max(Math.abs(a ?? 0), Math.abs(b ?? 0)) * 1.08 || 1; return [-m, m]; }
          return L.mode === 'window' && !lane.circ ? autoRange(a, b) : lane.fixed; } } },
        axes: [
          { stroke: axisC, grid: { stroke: gridC, width: 1 }, ticks: { stroke: gridC, size: 4 }, size: Math.round(24 * sz), space: Math.round(90 * sz), font: fpx + 'px ' + cs.getPropertyValue('--font'), values: (u, sp) => sp.map(s => { const d = new Date(s * 1000); const w = u.scales.x.max - u.scales.x.min; return w > 900 ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }) },
          { stroke: axisC, grid: { stroke: gridC, width: 1 }, ticks: { show: false }, size: Math.round(42 * sz), space: Math.round(28 * sz), font: fpx + 'px ' + cs.getPropertyValue('--font'), values: (u, sp) => sp.map(v => fmtNum(v, Math.abs(sp[1] - sp[0]) < 1 ? 1 : 0)) }
        ],
        series: [{}, ...lane.list.map((c, i) => ({ label: c.name, stroke: lane.colors[i], width: (this.styleOf(c).lw || this.cfg.lw || 1.6) * sz ** 0.5, dash: CHART_DASH[lane.dashes[i]], points: { show: false }, spanGaps: false }))],
        hooks: { draw: [u => self.drawOverlay(u)], setCursor: [u => self.hover(u, lane)] }
      };
      lane.u = new uPlot(opts, [xs, ...ys], lane.plot);
      lane.tip = h('div', { class: 'chart-tip', hidden: true });
      lane.plot.append(lane.tip);
      this.bindMouse(lane);
    }
    this.lastKey = '';
    this.V.requestDraw();
  }
  bindMouse(lane) {
    const over = lane.u.over;
    let down = null;
    const tAt = e => { const r = over.getBoundingClientRect(); return lane.u.posToVal(e.clientX - r.left, 'x') * 1000; };
    over.style.touchAction = 'none'; // col dito: trascinare scorre il tempo, non la pagina
    over.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      // Maiusc + trascina = seleziono un tratto da analizzare
      if (e.shiftKey) { down = { sel: true, a: tAt(e) }; this.V.inT = down.a; this.V.outT = null; this.V.requestDraw(); e.preventDefault(); return; }
      down = { x: e.clientX, t: this.V.t, moved: false }; this.V.scrubbing = true; e.preventDefault();
    });
    window.addEventListener('pointermove', this._mm = e => {
      if (!down) return;
      if (down.sel) { const b = tAt(e); this.V.inT = Math.min(down.a, b); this.V.outT = Math.max(down.a, b); this.V.requestDraw(); return; }
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 3) down.moved = true;
      if (down.moved) { const u = lane.u, w = (u.scales.x.max - u.scales.x.min) * 1000; this.V.seek(down.t - dx / u.over.clientWidth * w); }
    });
    window.addEventListener('pointerup', this._mu = e => {
      if (!down) return;
      if (down.sel) {
        const a = this.V.inT, b = this.V.outT; down = null;
        if (a != null && b != null && b - a > 2000) { this.V.updateRange(); showRangeAnalysis(this.V, a, b); }
        else { this.V.inT = this.V.outT = null; this.V.updateRange(); }
        return;
      }
      if (!down.moved) this.V.seek(tAt(e));
      down = null; this.V.scrubbing = false;
    });
    over.addEventListener('wheel', e => {
      e.preventDefault();
      const cur = this.win() || (this.S.t1 - this.S.t0);
      let w = cur * (e.deltaY > 0 ? 1.25 : 0.8);
      w = clamp(w, 5000, (this.S.t1 - this.S.t0) * 1.05);
      this.cfg.win = Math.round(w);
      if (this.winSel) this.winSel.value = '';
      this.lastKey = ''; this.V.requestDraw(); this.V.layoutChangedSoon();
    }, { passive: false });
    over.addEventListener('mouseleave', () => { lane.tip.hidden = true; });
  }
  hover(u, lane) {
    const idx = u.cursor.idx;
    if (idx == null || u.cursor.left < 0) { lane.tip.hidden = true; return; }
    const t = u.data[0][idx] * 1000;
    lane.tip.hidden = false;
    lane.tip.textContent = '';
    lane.tip.append(h('div', { class: 'muted' }, fmtClock(t, true)));
    lane.list.forEach((c, i) => lane.tip.append(h('div', null, h('span', { class: 'dot', style: { background: lane.colors[i], width: '7px', height: '7px', marginRight: '5px' } }), `${c.name}: ${fmtVal(c, u.data[i + 1][idx])} ${c.unit || ''}`)));
    const left = u.cursor.left, w = u.over.clientWidth;
    lane.tip.style.left = (left > w - 170 ? left - 170 : left + 12) + 'px';
    lane.tip.style.top = '4px';
  }
  drawOverlay(u) {
    const ctx = u.ctx, V = this.V, dpr = devicePixelRatio || 1;
    const { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    // selezione I–O
    if (V.inT != null && V.outT != null) {
      const a = u.valToPos(V.inT / 1000, 'x', true), b = u.valToPos(V.outT / 1000, 'x', true);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-soft');
      ctx.fillRect(a, top, b - a, height);
    }
    // tratti (eventi con inizio e fine)
    const x0 = u.scales.x.min * 1000, x1 = u.scales.x.max * 1000;
    for (const ev of this.S.meta.events) {
      if (ev.type !== 'tratto') continue;
      const e2 = ev.t2 ?? V.t;
      if (e2 < x0 || ev.t > x1) continue;
      const a = u.valToPos(Math.max(ev.t, x0) / 1000, 'x', true), b = u.valToPos(Math.min(e2, x1) / 1000, 'x', true);
      ctx.fillStyle = eventColor('tratto') + '22'; ctx.fillRect(a, top, b - a, height);
    }
    ctx.lineWidth = 1 * dpr;
    for (const ev of this.S.meta.events) {
      if (ev.t < x0 || ev.t > x1) continue;
      const x = Math.round(u.valToPos(ev.t / 1000, 'x', true)) + .5;
      ctx.strokeStyle = eventColor(ev.type); ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = eventColor(ev.type);
      ctx.beginPath(); ctx.moveTo(x - 4 * dpr, top); ctx.lineTo(x + 4 * dpr, top); ctx.lineTo(x, top + 6 * dpr); ctx.fill();
    }
    // cursore del tempo
    const cx = Math.round(u.valToPos(V.t / 1000, 'x', true)) + .5;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--cursor');
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + height); ctx.stroke();
    ctx.restore();
  }
  update(t) {
    if (!this.lanes.length || !this.lanes[0].u) return;
    const w = this.win(), S = this.S;
    let min, max;
    if (!w) { min = S.t0; max = S.t1; } else { min = t - w / 2; max = t + w / 2; }
    const key = `${min}|${max}|${this.V.drawSeq}`;
    for (const lane of this.lanes) {
      if (!lane.u) continue;
      if (key !== this.lastKey) {
        if (lane.u.scales.x.min !== min / 1000 || lane.u.scales.x.max !== max / 1000) lane.u.setScale('x', { min: min / 1000, max: max / 1000 });
        else lane.u.redraw(false);
      }
      for (const it of lane.items) { const s = fmtVal(it.c, interp(it.c, t)); if (s !== it.last) { it.val.textContent = s; it.last = s; } }
    }
    this.lastKey = key;
  }
  resize() {
    for (const lane of this.lanes) if (lane.u) { const r = lane.plot.getBoundingClientRect(); lane.u.setSize({ width: Math.max(50, r.width), height: Math.max(40, r.height) }); }
    this.lastKey = '';
  }
  styleOf(c) { return (this.cfg.st || {})[c.id] || {}; }
  /* in quale grafico va ogni linea: quello scelto, altrimenti uno per unità di misura */
  groupLanes(chans, st = this.cfg.st || {}) {
    const groups = new Map();
    for (const c of chans) {
      const L = st[c.id] && st[c.id].lane;
      const k = L ? 'L' + L : c.circular ? '°dir' : (c.unit || '-');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    return groups;
  }
  /* scala verticale di un grafico (compatibile con le impostazioni di prima, per unità di misura) */
  laneY(key, lanes = this.cfg.lanes || {}) {
    const L = lanes[key];
    if (L) return L;
    const f = (this.cfg.yFix || {})[key];
    return { mode: this.cfg.yMode || 'session', min: f ? f[0] : null, max: f ? f[1] : null };
  }
  settings() {
    const S = this.S, cfg = this.cfg;
    const st = JSON.parse(JSON.stringify(cfg.st || {})), lanesCfg = {};
    const title = h('input', { type: 'text', class: 'full', value: cfg.title || '', placeholder: 'Grafico' });
    const lw = h('select', null, [[1, 'sottili'], [1.6, 'normali'], [2.5, 'spesse'], [3.5, 'molto spesse']].map(([v, l]) => h('option', { value: v, selected: (cfg.lw || 1.6) === v }, l)));
    const serBox = h('div'), yBox = h('div', { style: { display: 'grid', gap: '8px' } });
    let pick;
    const laneName = (k, list) => k.startsWith('L') ? `Grafico ${k.slice(1)}` : k === '°dir' ? 'Direzioni (0–360°)' : `Grafico in ${k === '-' ? 'numeri senza unità' : k}`;
    const drawY = () => {
      const chans = S.chs(pick.get());
      yBox.textContent = '';
      for (const [key, list] of this.groupLanes(chans, st)) {
        const L = lanesCfg[key] || (lanesCfg[key] = Object.assign({}, this.laneY(key)));
        const lane = this.lanes.find(l => l.key === key), ph = lane && lane.fixed ? lane.fixed : [];
        const mn = h('input', { type: 'number', step: 'any', value: L.min ?? '', placeholder: ph[0] != null ? fmtNum(ph[0], 1) : 'min', style: { width: '80px' }, oninput: e => { L.min = e.target.value === '' ? null : Number(e.target.value); } });
        const mx = h('input', { type: 'number', step: 'any', value: L.max ?? '', placeholder: ph[1] != null ? fmtNum(ph[1], 1) : 'max', style: { width: '80px' }, oninput: e => { L.max = e.target.value === '' ? null : Number(e.target.value); } });
        const man = h('span', { class: 'row', style: { gap: '6px' }, hidden: L.mode !== 'manual' }, 'da', mn, 'a', mx);
        const mode = h('select', { onchange: e => { L.mode = e.target.value; man.hidden = L.mode !== 'manual'; } }, [['session', 'tutta l\'uscita'], ['window', 'adatta alla finestra'], ['sym', 'simmetrica attorno a 0'], ['manual', 'a mano']].map(([v, l]) => h('option', { value: v, selected: L.mode === v }, l)));
        yBox.append(h('div', { class: 'row', style: { gap: '8px', fontSize: '13px' } }, h('b', { style: { minWidth: '150px' } }, laneName(key, list)), h('span', { class: 'faint small', style: { minWidth: '120px' } }, list.map(c => c.name).join(', ')), mode, man));
      }
      if (!yBox.children.length) yBox.append(h('span', { class: 'muted small' }, 'Scegli prima le linee qui sotto.'));
    };
    const draw = () => {
      const chans = S.chs(pick.get());
      serBox.textContent = '';
      if (!chans.length) { serBox.append(h('span', { class: 'muted small' }, 'Scegli le grandezze nell\'elenco qui sotto.')); drawY(); return; }
      const tb = h('table', { class: 'ev-table ser-table' }, h('thead', null, h('tr', null, ['Linea', 'In quale grafico', 'Colore', 'Tratto', 'Spessore'].map(x => h('th', null, x)))));
      const body = h('tbody');
      const all = S.chs(cfg.ids);
      chans.forEach(c => {
        const o = st[c.id] || (st[c.id] = {});
        const idx = all.includes(c) ? all.indexOf(c) : chans.indexOf(c);
        const lane = h('select', { onchange: e => { o.lane = e.target.value ? Number(e.target.value) : null; drawY(); } }, [['', 'automatico (per unità)'], ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, 'Grafico ' + n])].map(([v, l]) => h('option', { value: v, selected: String(o.lane || '') === String(v) }, l)));
        const color = h('input', { type: 'color', value: o.color || seriesColor(idx), oninput: e => { o.color = e.target.value; } });
        const dash = h('select', { onchange: e => { o.dash = e.target.value; } }, [['solid', 'continua'], ['dash', 'tratteggiata'], ['dot', 'a puntini']].map(([v, l]) => h('option', { value: v, selected: (o.dash || 'solid') === v }, l)));
        const w = h('select', { onchange: e => { o.lw = e.target.value ? Number(e.target.value) : null; } }, [['', 'come le altre'], [1, 'sottile'], [1.6, 'normale'], [2.5, 'spessa'], [3.5, 'molto spessa']].map(([v, l]) => h('option', { value: v, selected: String(o.lw || '') === String(v) }, l)));
        body.append(h('tr', null, h('td', null, c.name, h('span', { class: 'faint' }, c.unit ? ` ${c.unit}` : '')), h('td', null, lane), h('td', null, color, o.color ? h('button', { class: 'icon-btn x', title: 'Colore automatico', onclick: e => { delete o.color; color.value = seriesColor(idx); e.preventDefault(); } }, '↺') : null), h('td', null, dash), h('td', null, w)));
      });
      tb.append(body); serBox.append(tb);
      drawY();
    };
    pick = channelPicker(S, cfg.ids, { onChange: draw });
    draw();
    return {
      el: h('div', { style: { display: 'grid', gap: '14px' } },
        h('div', { class: 'row', style: { gap: '18px' } }, h('label', { class: 'f', style: { flex: 1 } }, 'Titolo', title), h('label', { class: 'f' }, 'Linee', lw)),
        h('div', { class: 'f' }, 'Linee: grafico, colore e tratto', serBox),
        h('div', { class: 'f' }, 'Scala verticale di ogni grafico', yBox),
        h('div', { class: 'f' }, 'Grandezze da mostrare (di solito un grafico per unità di misura; nella tabella sopra puoi metterle dove vuoi)', pick.el)),
      apply: () => {
        cfg.ids = pick.get(); cfg.title = title.value.trim(); cfg.lw = Number(lw.value);
        const keep = {}; for (const id of cfg.ids) if (st[id] && Object.values(st[id]).some(v => v != null)) keep[id] = st[id];
        cfg.st = keep;
        const used = new Set([...this.groupLanes(S.chs(cfg.ids), keep).keys()]);
        cfg.lanes = Object.fromEntries(Object.entries(lanesCfg).filter(([k]) => used.has(k)));
        delete cfg.yMode; delete cfg.yFix;
        this.build();
      }
    };
  }
  destroy() { for (const l of this.lanes) l.u && l.u.destroy(); window.removeEventListener('pointermove', this._mm); window.removeEventListener('pointerup', this._mu); }
}
const CHART_DASH = { solid: undefined, dash: [8, 5], dot: [2, 4] };
function autoRange(a, b) { if (a == null || b == null) return [0, 1]; const p = (b - a) * 0.08 || 1; return [a - p, b + p]; }

/* =================== MAPPA =================== */
class MapPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    if (cfg.follow == null) cfg.follow = false;
    if (cfg.trail == null) cfg.trail = 60;
    this.el = h('div', { class: 'map-box' });
    const pos = this.S.pos;
    if (!pos) { this.el.append(h('div', { class: 'pnl-empty' }, this.S.live ? 'In attesa della posizione GPS dal telefono…' : 'Nessuna posizione GPS: carica un file con latitudine e longitudine (Vakaros, GPX, Cyclops) o accendi il GPS della GoPro.')); return; }
    requestAnimationFrame(() => this.init());
  }
  title() { return 'Mappa'; }
  headButtons() {
    const b = h('button', { class: 'icon-btn' + (this.cfg.follow ? ' on' : ''), title: 'Segui la barca', 'aria-label': 'Segui la barca', html: ICONS.follow });
    this.followBtn = b;
    b.onclick = () => { this.cfg.follow = !this.cfg.follow; b.classList.toggle('on', this.cfg.follow); this.V.layoutChanged(); this.V.requestDraw(); };
    return [b];
  }
  init() {
    const S = this.S, pos = S.pos;
    // traccia a 1 punto al secondo
    const pts = [];
    const t0 = Math.max(pos.lat.t[0], pos.lon.t[0]), t1 = Math.min(pos.lat.t[pos.lat.t.length - 1], pos.lon.t[pos.lon.t.length - 1]);
    const step = clamp((t1 - t0) / 20000, 1000, 5000);
    for (let t = t0; t <= t1; t += step) { const a = interp(pos.lat, t), b = interp(pos.lon, t); if (isFinite(a) && isFinite(b)) pts.push([t, a, b]); }
    this.pts = pts;
    this.map = L.map(this.el, { zoomControl: true, attributionControl: true, preferCanvas: true, zoomSnap: 0.25 });
    const dark = theme() === 'dark';
    this.bounds = pts.length ? L.latLngBounds(pts.map(p => [p[1], p[2]])) : null;
    this.fit();
    const carto = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base'}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 20, maxNativeZoom: 16, attribution: 'Mappa © Esri' });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Immagini © Esri' });
    const sea = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenSeaMap' });
    (this.cfg.base === 'sat' ? sat : this.cfg.base === 'osm' ? osm : carto).addTo(this.map);
    this.map.on('baselayerchange', e => { this.cfg.base = e.layer === sat ? 'sat' : e.layer === osm ? 'osm' : 'map'; this.V.layoutChanged(); });
    L.control.layers({ 'Mappa semplice': carto, 'OpenStreetMap': osm, 'Satellite': sat }, { 'Segnalamenti (OpenSeaMap)': sea }, { position: 'topright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(this.map);
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.evLayer = L.layerGroup().addTo(this.map);
    this.trail = L.polyline([], { color: dark ? '#ffffff' : '#0b0b0b', weight: 3.5, opacity: .9 }).addTo(this.map);
    const ico = L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<svg class="boat-ico" viewBox="0 0 26 26"><g><path d="M13 2 L19 22 L13 18 L7 22 Z" fill="${dark ? '#ffffff' : '#0b0b0b'}" stroke="${dark ? '#0e1012' : '#ffffff'}" stroke-width="1.5"/></g></svg>` });
    this.boat = L.marker([pts[0] ? pts[0][1] : 0, pts[0] ? pts[0][2] : 0], { icon: ico, interactive: false, zIndexOffset: 1000 }).addTo(this.map);
    this.legend = h('div', { class: 'map-legend' });
    this.el.append(this.legend);
    this.drawTrack();
    this.drawEvents();
    // clic sulla traccia = vai a quell'istante. Solo se il clic è proprio sulla traccia (14 px),
    // non dopo aver trascinato la mappa e non nel doppio clic che serve a ingrandire.
    let clickTimer = 0, moved = false;
    this.map.on('mousedown', () => { moved = false; });
    this.map.on('movestart', () => { moved = true; });
    this.map.on('dblclick', () => { clearTimeout(clickTimer); });
    this.map.on('click', e => {
      if (moved) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        const P = this.map.latLngToContainerPoint(e.latlng);
        let best = null, bd = 14 * 14;
        for (const p of this.pts) { const q = this.map.latLngToContainerPoint([p[1], p[2]]); const d = (q.x - P.x) ** 2 + (q.y - P.y) ** 2; if (d < bd) { bd = d; best = p; } }
        if (best) this.V.seek(best[0]);
      }, 260);
    });
    this.map.on('dragstart', () => { if (this.cfg.follow) { this.cfg.follow = false; if (this.followBtn) this.followBtn.classList.remove('on'); this.V.layoutChanged(); } });
    this.V.requestDraw();
  }
  colorCh() { return this.S.ch(this.cfg.colorBy) || this.S.sog; }
  /* live: la traccia cresce */
  refreshData() {
    const S = this.S, pos = S.pos;
    if (!pos) return;
    if (!this.map) { this.el.textContent = ''; this.init(); return; }
    const now = performance.now();
    if (this._lastTrack && now - this._lastTrack < 4000) return;
    this._lastTrack = now;
    const t0 = Math.max(pos.lat.t[0], pos.lon.t[0]), t1 = Math.min(pos.lat.t[pos.lat.t.length - 1], pos.lon.t[pos.lon.t.length - 1]);
    const step = clamp((t1 - t0) / 20000, 1000, 5000), pts = [];
    for (let t = t0; t <= t1; t += step) { const a = interp(pos.lat, t), b = interp(pos.lon, t); if (isFinite(a) && isFinite(b)) pts.push([t, a, b]); }
    this.pts = pts;
    if (!this.fitted && pts.length > 1) { this.bounds = L.latLngBounds(pts.map(p => [p[1], p[2]])); this.fit(); }
    this.drawTrack();
  }
  drawTrack() {
    this.trackLayer.clearLayers();
    const c = this.colorCh(), pts = this.pts;
    if (!pts.length) return;
    if (!c) { L.polyline(pts.map(p => [p[1], p[2]]), { color: seriesColor(0), weight: 2.5 }).addTo(this.trackLayer); this.legend.hidden = true; return; }
    // scala sequenziale (un solo colore, dal chiaro allo scuro) tra il 5° e il 95° percentile
    const vals = pts.map(p => interp(c, p[0])).filter(isFinite).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * .05)] ?? 0, hi = vals[Math.floor(vals.length * .95)] ?? 1;
    const ramp = theme() === 'dark' ? SEQ_BLUE : SEQ_BLUE.slice().reverse();
    const bin = v => isFinite(v) ? clamp(Math.floor((v - lo) / ((hi - lo) || 1) * ramp.length), 0, ramp.length - 1) : -1;
    let run = [], rb = null;
    const flush = () => { if (run.length > 1 && rb >= 0) L.polyline(run, { color: ramp[rb], weight: 3, opacity: .95, interactive: false }).addTo(this.trackLayer); };
    for (const p of pts) {
      const b = bin(interp(c, p[0]));
      if (b !== rb) { if (run.length) { const last = run[run.length - 1]; flush(); run = [last]; } else run = []; rb = b; }
      run.push([p[1], p[2]]);
    }
    flush();
    this.legend.hidden = false;
    this.legend.textContent = '';
    this.legend.append(h('div', null, `${c.name} (${c.unit})`), h('div', { class: 'ramp', style: { background: `linear-gradient(90deg, ${ramp.join(',')})` } }), h('div', { class: 'ends' }, h('span', null, fmtVal(c, lo)), h('span', null, fmtVal(c, hi))));
  }
  drawEvents() {
    if (!this.evLayer) return;
    this.evLayer.clearLayers();
    const pos = this.S.pos;
    for (const ev of this.S.meta.events) {
      const a = interp(pos.lat, ev.t), b = interp(pos.lon, ev.t);
      if (!isFinite(a) || !isFinite(b)) continue;
      const m = L.circleMarker([a, b], { radius: 5, color: theme() === 'dark' ? '#0e1012' : '#fff', weight: 2, fillColor: eventColor(ev.type), fillOpacity: 1 }).addTo(this.evLayer);
      m.bindTooltip(`${fmtClock(ev.t)} · ${(EVT[ev.type] || {}).label || ev.type}${ev.note ? ' · ' + ev.note : ''}`);
      m.on('click', e => { L.DomEvent.stopPropagation(e); this.V.seek(ev.t - (this.V.preroll || 0)); });
    }
  }
  eventsChanged() { this.drawEvents(); }
  update(t) {
    if (!this.map) return;
    const pos = this.S.pos, a = interp(pos.lat, t), b = interp(pos.lon, t);
    if (!isFinite(a) || !isFinite(b)) { this.boat.setOpacity(0.25); return; }
    this.boat.setOpacity(1);
    this.boat.setLatLng([a, b]);
    const hd = this.S.cog ? interp(this.S.cog, t) : NaN;
    const g = this.boat.getElement() && this.boat.getElement().querySelector('g');
    if (g && isFinite(hd)) g.setAttribute('transform', `rotate(${hd.toFixed(1)} 13 13)`);
    const tr = [];
    const tw = (this.cfg.trail || 0) * 1000;
    if (tw) for (let x = t - tw; x <= t; x += Math.max(500, tw / 120)) { const la = interp(pos.lat, x), lo = interp(pos.lon, x); if (isFinite(la) && isFinite(lo)) tr.push([la, lo]); }
    tr.push([a, b]);
    this.trail.setLatLngs(tr);
    if (this.cfg.follow) this.map.panTo([a, b], { animate: false });
  }
  // inquadra la traccia; se il pannello non ha ancora dimensioni, riprova al primo ridimensionamento
  fit() {
    const sz = this.map.getSize();
    if (this.bounds) this.map.fitBounds(this.bounds, { padding: [16, 16], maxZoom: 15 }); else this.map.setView([39.2, 9.1], 12);
    this.fitted = sz.x > 60 && sz.y > 60;
  }
  resize() { if (!this.map) return; this.map.invalidateSize(); if (!this.fitted) this.fit(); }
  settings() {
    const sel = h('select', { class: 'full' }, h('option', { value: '' }, 'Velocità principale'), this.S.channels.filter(c => c.role !== 'lat' && c.role !== 'lon' && !c.circular).map(c => h('option', { value: c.id }, `${c.name} (${c.srcName})`)));
    sel.value = this.cfg.colorBy || '';
    const tr = h('input', { type: 'number', min: 0, max: 600, step: 10, value: this.cfg.trail });
    return { el: h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'f' }, 'Colora la traccia secondo', sel), h('label', { class: 'f' }, 'Scia dietro la barca (secondi)', tr)),
      apply: () => { this.cfg.colorBy = sel.value || null; this.cfg.trail = Number(tr.value) || 0; if (this.map) this.drawTrack(); } };
  }
  destroy() { if (this.map) { this.map.remove(); this.map = null; } }
}

/* =================== NUMERI =================== */
class NumbersPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    cfg.ids = (cfg.ids || []).filter(id => this.S.live || this.S.byId.has(id));
    if (cfg.avg == null) cfg.avg = 10;
    if (cfg.damp == null) cfg.damp = 2; // secondi di smorzamento del numero grande (0 = istantaneo)
    this.el = h('div', { class: 'num-grid' });
    this.build();
  }
  title() { return this.cfg.title || 'Numeri'; }
  /* grandezza dei numeri (A− / A+); le etichette crescono meno, così restano proporzionate */
  setSize(s) { this.el.style.setProperty('--ns', s); this.el.style.setProperty('--ls', Math.sqrt(s)); }
  fmt(c, v) { return c.circular ? dirLabel(v) : (this.cfg.dec != null && this.cfg.dec !== '' ? fmtNum(v, Number(this.cfg.dec)) : fmtVal(c, v)); }
  build() {
    this.el.textContent = '';
    this.el.classList.toggle('no-sub', !!this.cfg.noSub);
    this.el.classList.toggle('no-bar', !!this.cfg.noBar);
    this.el.classList.toggle('no-unit', !!this.cfg.noUnit);
    this.el.classList.toggle('align-c', this.cfg.align === 'center');
    this.tiles = [];
    const chans = this.S.chs(this.cfg.ids);
    if (!chans.length && this.S.live && this.cfg.ids.length) { this.el.append(h('div', { class: 'pnl-empty', style: { background: 'var(--surface)' } }, 'In attesa dei dati dal telefono…')); return; }
    if (!chans.length) { this.el.append(h('div', { class: 'pnl-empty', style: { background: 'var(--surface)' } }, h('div', null, 'Scegli le grandezze da mostrare.', h('button', { class: 'btn sm', onclick: () => this.V.panelSettings(this) }, 'Scegli i canali')))); return; }
    for (const c of chans) {
      const val = h('span'), unit = h('small', null, c.circular ? '' : c.unit), avg = h('span'), rng = h('span'), bar = h('i');
      const tile = h('div', { class: 'tile', title: `${c.name} · ${c.srcName}` }, h('div', { class: 'tile-lbl' }, c.name), h('div', { class: 'tile-val' }, val, unit), h('div', { class: 'tile-sub' }, avg, rng), c.circular ? null : h('div', { class: 'tile-bar' }, bar));
      this.el.append(tile);
      this.tiles.push({ c, val, avg, rng, bar, last: '' });
    }
    this.resize();
  }
  refreshData() {
    const have = (this.tiles || []).map(t => t.c.id).join(), want = this.cfg.ids.filter(id => this.S.byId.has(id)).join();
    if (have !== want) this.build();
  }
  resize() {
    const n = this.tiles ? this.tiles.length : 0;
    if (!n) return;
    if (this.cfg.cols) { this.el.style.setProperty('--cols', Math.min(n, this.cfg.cols)); return; }
    const r = this.el.getBoundingClientRect();
    const ar = (r.width || 300) / (r.height || 300);
    let best = 1, bs = -1;
    for (let cols = 1; cols <= n; cols++) { const rows = Math.ceil(n / cols); const tw = r.width / cols, th = r.height / rows; const s = Math.min(tw / 1.7, th) - (rows * cols - n) * 2; if (s > bs) { bs = s; best = cols; } }
    this.el.style.setProperty('--cols', best);
    void ar;
  }
  update(t) {
    if (this.el.clientWidth !== this._w || this.el.clientHeight !== this._h) { this._w = this.el.clientWidth; this._h = this.el.clientHeight; this.resize(); }
    // numeri leggibili: al massimo 4 aggiornamenti al secondo, salvo i salti di tempo (clic sul grafico, video)
    const now = performance.now();
    if (this._lt != null && Math.abs(t - this._lt) < 2000 && now - (this._lw || 0) < 250) return;
    this._lt = t; this._lw = now;
    const w = this.cfg.avg * 1000;
    for (const it of this.tiles || []) {
      const c = it.c, v = dampedValue(c, t, this.cfg.damp);
      const s = this.fmt(c, v);
      if (s === it.last) continue;
      it.last = s;
      it.val.textContent = s;
      const st = stats(c, t - w, t);
      it.avg.textContent = `media ${this.cfg.avg} s ${this.fmt(c, st.mean)}`;
      it.rng.textContent = c.circular ? '' : `max ${this.fmt(c, st.max)}`;
      if (!c.circular) { const lo = Math.min(0, c.min), p = isFinite(v) ? clamp((v - lo) / ((c.max - lo) || 1), 0, 1) : 0; it.bar.style.width = (p * 100).toFixed(1) + '%'; }
    }
  }
  settings() {
    const pick = channelPicker(this.S, this.cfg.ids);
    const avg = h('input', { type: 'number', min: 1, max: 600, value: this.cfg.avg });
    const damp = h('select', null, DAMP_CHOICES.map(d => h('option', { value: d, selected: d === this.cfg.damp }, d ? `media degli ultimi ${d} s` : 'valore istantaneo')));
    const cols = h('select', null, [['', 'automatiche'], ...[1, 2, 3, 4, 5, 6].map(n => [n, String(n)])].map(([v, l]) => h('option', { value: v, selected: String(this.cfg.cols || '') === String(v) }, l)));
    const dec = h('select', null, [['', 'come il dato'], [0, 'nessuno'], [1, '1'], [2, '2']].map(([v, l]) => h('option', { value: v, selected: String(this.cfg.dec ?? '') === String(v) }, l)));
    const chk = (k, label, inv) => { const i = h('input', { type: 'checkbox', checked: inv ? !this.cfg[k] : !!this.cfg[k] }); i._k = k; i._inv = inv; return h('label', { class: 'row', style: { gap: '6px', fontSize: '13px' } }, i, label); };
    const checks = [chk('noSub', 'Media e massimo sotto il numero', true), chk('noBar', 'Barretta', true), chk('noUnit', 'Unità di misura', true), chk('alignC', 'Numeri al centro', false)]; checks[3].querySelector('input').checked = this.cfg.align === 'center';
    const title = h('input', { type: 'text', class: 'full', value: this.cfg.title || '', placeholder: 'Numeri' });
    return { el: h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'f' }, 'Titolo', title), h('label', { class: 'f' }, 'Numero grande (più alto = più calmo)', damp), h('label', { class: 'f' }, 'Media e massimo sotto, sugli ultimi (secondi)', avg),
      h('div', { class: 'row', style: { gap: '18px' } }, h('label', { class: 'f' }, 'Colonne', cols), h('label', { class: 'f' }, 'Decimali', dec)),
      h('div', { class: 'f' }, 'Cosa mostrare', h('div', { class: 'row', style: { gap: '14px' } }, checks)), h('div', { class: 'f' }, 'Grandezze', pick.el)),
      apply: () => { this.cfg.ids = pick.get(); this.cfg.avg = Math.max(1, Number(avg.value) || 10); this.cfg.damp = Number(damp.value);
        this.cfg.cols = cols.value ? Number(cols.value) : null; this.cfg.dec = dec.value === '' ? null : Number(dec.value);
        for (const l of checks) { const i = l.querySelector('input'); const v = i._inv ? !i.checked : i.checked; if (i._k === 'alignC') this.cfg.align = v ? 'center' : null; else this.cfg[i._k] = v; } this.cfg.title = title.value.trim(); this.build(); } };
  }
  destroy() {}
}

/* =================== EVENTI =================== */
class EventsPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    this.q = ''; this.type = ''; this.sel = new Set();
    this.el = h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' } });
    const search = h('input', { type: 'search', placeholder: 'Cerca nelle note…' });
    search.addEventListener('input', () => { this.q = search.value.toLowerCase(); this.render(); });
    const tsel = h('select', null, h('option', { value: '' }, 'Tutti i tipi'), EVENT_TYPES.map(e => h('option', { value: e.id }, e.label)));
    tsel.addEventListener('change', () => { this.type = tsel.value; this.render(); });
    this.el.append(h('div', { class: 'ev-tools' }, search, tsel,
      h('button', { class: 'btn sm', title: 'Trova virate e strambate dalla rotta GPS', onclick: () => this.V.detectManeuvers() }, 'Trova manovre'),
      this.cmpBtn = h('button', { class: 'btn sm', title: 'Confronta i tratti spuntati (o scegli quali)', onclick: () => {
        const chosen = this.S.meta.events.filter(e => this.sel.has(e.id) && e.type === 'tratto' && e.t2 != null);
        if (chosen.length >= 2) showCompare(this.V, chosen); else pickSegmentsToCompare(this.V, [...this.sel]);
      } }, 'Confronta tratti'),
      h('button', { class: 'btn sm', title: 'Velocità nei tratti dritti e manovre sovrapposte (tutta l\'uscita o i tratti spuntati)', onclick: () => {
        const chosen = this.S.meta.events.filter(e => this.sel.has(e.id) && e.type === 'tratto' && e.t2 != null);
        showPerformance(this.V, { segs: chosen });
      } }, 'Prestazioni'),
      h('button', { class: 'btn sm', title: 'Scarica gli eventi in CSV', onclick: () => this.exportCSV() }, 'CSV')));
    this.listBox = h('div', { style: { flex: 1, position: 'relative', minHeight: 0 } });
    this.list = h('div', { class: 'ev-list' });
    this.listBox.append(this.list, h('button', { class: 'ev-add', title: 'Aggiungi un evento a quest\'ora', 'aria-label': 'Aggiungi evento', onclick: () => this.V.addEventDialog() }, '+'));
    this.el.append(this.listBox);
    this.render();
  }
  title() { return 'Eventi'; }
  rows() {
    return this.S.meta.events.filter(e => (!this.type || e.type === this.type) && (!this.q || (e.note || '').toLowerCase().includes(this.q) || ((EVT[e.type] || {}).label || '').toLowerCase().includes(this.q)));
  }
  render() {
    const S = this.S, sog = S.sog;
    this.list.textContent = '';
    const rows = this.rows();
    if (!rows.length) {
      this.list.append(h('div', { class: 'pnl-empty' }, h('div', null, S.meta.events.length ? 'Nessun evento corrisponde ai filtri.' : 'Nessun evento. Premi + oppure usa i tasti: T virata, G strambata, P partenza, B boa, E errore, N nota.')));
      this.rowEls = []; return;
    }
    const man = sog ? ['Vel. in', 'Min', 'Vel. out', 'Metri persi'] : [];
    const tb = h('table', { class: 'ev-table' }, h('thead', null, h('tr', null, h('th', null, 'Ora'), h('th', null, 'Tipo'), h('th', null, 'Nota'), man.map(x => h('th', null, x)), h('th', null, ''))));
    const body = h('tbody');
    this.rowEls = [];
    for (const ev of rows) {
      const et = EVT[ev.type] || { label: ev.type };
      const isMan = ev.type === 'virata' || ev.type === 'strambata' || ev.type === 'manovra';
      const mm = isMan && sog ? maneuverMetrics(sog, ev.t) : null;
      const pick = ev.type === 'tratto' && ev.t2 != null ? h('input', { type: 'checkbox', class: 'ev-pick', title: 'Spunta per confrontare', checked: this.sel.has(ev.id),
        onclick: e => e.stopPropagation(), onchange: e => { if (e.target.checked) this.sel.add(ev.id); else this.sel.delete(ev.id); this.cmpLabel(); } }) : null;
      const tr = h('tr', { onclick: () => { this.V.seek(ev.t - this.V.preroll); }, ondblclick: () => this.V.editEvent(ev) },
        h('td', null, pick, fmtClock(ev.t)),
        h('td', null, h('span', { class: 'chip' }, h('span', { class: 'dot', style: { background: eventColor(ev.type) } }), et.label)),
        h('td', { class: 'note' }, ev.note || (ev.auto ? h('span', { class: 'faint' }, 'trovata in automatico') : ''), ev.type === 'tratto' ? [h('span', { class: 'faint' }, ` · ${ev.t2 ? fmtDur(ev.t2 - ev.t) : 'in corso'} `), ev.t2 ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); showRangeAnalysis(this.V, ev.t, ev.t2, ev.note || 'Tratto'); } }, 'Analizza') : null] : null),
        man.length ? [h('td', null, mm ? fmtNum(mm.sIn, 1) : ''), h('td', null, mm ? fmtNum(mm.sMin, 1) : ''), h('td', null, mm ? fmtNum(mm.sOut, 1) : ''), h('td', null, mm ? fmtNum(mm.lost, 0) : '')] : null,
        h('td', null, h('button', { class: 'icon-btn x', title: 'Modifica', 'aria-label': 'Modifica', onclick: e => { e.stopPropagation(); this.V.editEvent(ev); } }, '✎'),
          h('button', { class: 'icon-btn x', title: 'Elimina', 'aria-label': 'Elimina', onclick: e => { e.stopPropagation(); this.V.removeEvent(ev); } }, '✕')));
      tr.dataset.t = ev.t;
      this.rowEls.push(tr);
      body.append(tr);
    }
    tb.append(body);
    this.list.append(tb);
    if (sog && rows.some(e => e.type === 'virata' || e.type === 'strambata' || e.type === 'manovra')) {
      const by = {};
      for (const e of rows) { if (!['virata', 'strambata', 'manovra'].includes(e.type)) continue; const m = maneuverMetrics(sog, e.t); if (!m) continue; (by[e.type] = by[e.type] || []).push(m); }
      const sum = h('div', { class: 'stat', style: { padding: '6px 8px' } });
      for (const [k, l] of Object.entries(by)) sum.append(h('div', null, `${EVT[k].label}: ${l.length} · media velocità minima ${fmtNum(l.reduce((a, m) => a + m.sMin, 0) / l.length, 1)} kn · media metri persi ${fmtNum(l.reduce((a, m) => a + m.lost, 0) / l.length, 0)}`));
      this.list.append(sum);
    }
    this.curRow = null;
    this.cmpLabel();
  }
  cmpLabel() {
    if (!this.cmpBtn) return;
    const ids = new Set(this.S.meta.events.filter(e => e.type === 'tratto' && e.t2 != null).map(e => e.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.cmpBtn.hidden = ids.size < 2;
    this.cmpBtn.textContent = this.sel.size >= 2 ? `Confronta (${this.sel.size})` : 'Confronta tratti';
    this.cmpBtn.classList.toggle('primary', this.sel.size >= 2);
  }
  eventsChanged() { this.render(); }
  update(t) {
    if (!this.rowEls || !this.rowEls.length) return;
    let cur = null;
    for (const r of this.rowEls) { if (Number(r.dataset.t) <= t + 300) cur = r; else break; }
    if (cur !== this.curRow) {
      if (this.curRow) this.curRow.classList.remove('cur');
      if (cur) { cur.classList.add('cur'); if (this.V.playing) cur.scrollIntoView({ block: 'nearest' }); }
      this.curRow = cur;
    }
  }
  exportCSV() {
    const sog = this.S.sog;
    const lines = ['ora;tipo;nota;vel_in_kn;vel_min_kn;vel_out_kn;metri_persi'];
    for (const e of this.S.meta.events) {
      const m = sog && ['virata', 'strambata', 'manovra'].includes(e.type) ? maneuverMetrics(sog, e.t) : null;
      const f = v => m && isFinite(v) ? String(Math.round(v * 10) / 10).replace('.', ',') : '';
      lines.push([new Date(e.t).toLocaleString('it-IT'), (EVT[e.type] || {}).label || e.type, '"' + (e.note || '').replace(/"/g, '""') + '"', f(m && m.sIn), f(m && m.sMin), f(m && m.sOut), f(m && m.lost)].join(';'));
    }
    downloadText(`eventi ${this.S.meta.date} ${slug(this.S.meta.title)}.csv`, '﻿' + lines.join('\n'));
  }
  settings() {
    const pr = h('input', { type: 'number', min: 0, max: 60, value: this.V.preroll / 1000 });
    return { el: h('label', { class: 'f' }, 'Quando clicchi un evento, parti da (secondi prima)', pr), apply: () => { this.V.preroll = (Number(pr.value) || 0) * 1000; this.S.meta.view.preroll = this.V.preroll; } };
  }
  resize() {}
  destroy() {}
}

/* =================== STATISTICHE =================== */
class StatsPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    cfg.ids = (cfg.ids || []).filter(id => this.S.byId.has(id));
    if (!cfg.mode) cfg.mode = 'auto';
    this.el = h('div', { class: 'st-wrap' });
    this.lastKey = '';
  }
  title() { return 'Statistiche'; }
  range(t) {
    const V = this.V, S = this.S;
    const m = this.cfg.mode;
    if ((m === 'auto' || m === 'sel') && V.inT != null && V.outT != null) return [V.inT, V.outT, `Selezione ${fmtClock(V.inT)}–${fmtClock(V.outT)}`];
    const seg = m === 'auto' ? segmentAt(S, t) : null;
    if (seg) return [seg.t, seg.t2 ?? t, `${seg.note || 'Tratto'} ${fmtClock(seg.t)}–${fmtClock(seg.t2 ?? t)}`];
    if (m === 'leg' || m === 'auto') {
      const ev = S.meta.events; let a = S.t0, b = S.t1;
      for (const e of ev) { if (e.t <= t) a = e.t; else { b = e.t; break; } }
      if (m === 'leg' || ev.length) return [a, b, `Tra due eventi: ${fmtClock(a)}–${fmtClock(b)}`];
    }
    if (m === 'win') { const w = V.win || (S.t1 - S.t0); return [t - w / 2, t + w / 2, 'Finestra dei grafici']; }
    return [S.t0, S.t1, 'Tutta l\'uscita'];
  }
  update(t) {
    const [a, b, label] = this.range(t);
    const key = `${a}|${b}|${this.cfg.ids.join()}|${this.S.meta.events.length}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.el.textContent = '';
    const chans = this.S.chs(this.cfg.ids);
    if (!chans.length) { this.el.append(h('div', { class: 'pnl-empty' }, h('div', null, 'Scegli le grandezze.', h('button', { class: 'btn sm', onclick: () => this.V.panelSettings(this) }, 'Scegli i canali')))); return; }
    const tb = h('table', { class: 'ev-table' }, h('thead', null, h('tr', null, ['Grandezza', 'Media', 'Min', 'Max', 'Dev. std'].map(x => h('th', null, x)))));
    const body = h('tbody');
    for (const c of chans) {
      const s = stats(c, a, b);
      const f = v => c.circular ? dirLabel(v) : fmtVal(c, v);
      body.append(h('tr', null, h('td', null, c.name, h('span', { class: 'faint' }, c.unit && !c.circular ? ` ${c.unit}` : '')), h('td', null, f(s.mean)), h('td', null, c.circular ? '' : f(s.min)), h('td', null, c.circular ? '' : f(s.max)), h('td', null, c.circular ? '' : fmtVal(c, s.sd))));
    }
    tb.append(body);
    this.el.append(h('div', { class: 'stat', style: { padding: '6px 8px' } }, `${label} · ${fmtDur(b - a)}`), tb);
  }
  eventsChanged() { this.lastKey = ''; }
  settings() {
    const pick = channelPicker(this.S, this.cfg.ids);
    const mode = h('select', { class: 'full' }, [['auto', 'Automatico: selezione I–O, altrimenti tra due eventi'], ['sel', 'Selezione I–O'], ['leg', 'Tra l\'evento precedente e il successivo'], ['win', 'Finestra dei grafici'], ['all', 'Tutta l\'uscita']].map(([v, l]) => h('option', { value: v }, l)));
    mode.value = this.cfg.mode;
    return { el: h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'f' }, 'Intervallo', mode), h('div', { class: 'f' }, 'Grandezze', pick.el)),
      apply: () => { this.cfg.ids = pick.get(); this.cfg.mode = mode.value; this.lastKey = ''; } };
  }
  resize() {}
  destroy() {}
}

const PANEL_CLASSES = { video: VideoPanel, chart: ChartPanel, map: MapPanel, numbers: NumbersPanel, events: EventsPanel, stats: StatsPanel };

/* =================== COPERTURA =================== */
class CoveragePanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    this.el = h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } });
    this.build();
  }
  title() { return 'Copertura: video e dati'; }
  build() {
    const S = this.S, cv = this.cov = coverage(S);
    this.el.textContent = '';
    const Q = this.Q = dataQuality(S);
    const qSpans = Q ? Q.issues.filter(r => r.why !== 'nodata') : [];
    const rows = [...cv.cams.map(c => ({ label: '🎥 ' + c.name, spans: c.spans, color: c.color })), ...cv.data.map(d => ({ label: '📈 ' + d.name, spans: d.spans, color: 'var(--muted)' })),
      { label: 'Video + dati', spans: cv.both, color: 'var(--good)', strong: true },
      Q ? { label: '⚠︎ Dati dubbi', spans: qSpans.map(r => [r.a, r.b, r.bad ? 'var(--bad, #e5534b)' : 'var(--warn, #e0a33a)', r.text]), color: 'var(--warn, #e0a33a)', title: 'Rosso = dati mancanti, arancione = dati poco affidabili' } : null].filter(Boolean);
    this.lanes = h('div', { style: { position: 'relative', padding: '6px 8px 2px', display: 'grid', gap: '3px', cursor: 'pointer' } });
    const X = t => ((t - S.t0) / ((S.t1 - S.t0) || 1) * 100).toFixed(3) + '%';
    for (const r of rows) {
      const lane = h('div', { class: 'cover-lane', style: { height: r.strong ? '12px' : '8px' } });
      for (const [a, b, col, tip] of r.spans) lane.append(h('i', { style: { left: X(a), width: `max(2px, calc(${X(b)} - ${X(a)}))`, background: col || r.color }, title: tip ? `${fmtClock(a)}–${fmtClock(b)} · ${tip}` : null }));
      this.lanes.append(h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px', alignItems: 'center', fontSize: '11px' }, title: r.title || null },
        h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: r.strong ? 700 : 500 } }, r.label), lane));
    }
    this.cursor = h('div', { style: { position: 'absolute', top: '2px', bottom: '0', width: '2px', background: 'var(--cursor)', pointerEvents: 'none' } });
    this.lanes.append(this.cursor);
    this.lanes.addEventListener('mousedown', e => {
      const lane = this.lanes.querySelector('.cover-lane'); if (!lane) return;
      const r = lane.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width;
      if (f >= 0 && f <= 1) this.V.seek(S.t0 + f * (S.t1 - S.t0));
    });
    this.el.append(this.lanes);
    const tot = cv.both.reduce((a, x) => a + x[1] - x[0], 0);
    const list = h('div', { style: { padding: '4px 8px 8px', display: 'grid', gap: '4px' } });
    if (!cv.allVid.length || !cv.allData.length) list.append(h('div', { class: 'stat' }, !cv.allVid.length ? 'In questa uscita non ci sono video.' : 'In questa uscita non ci sono file di dati (Garmin, Cyclops, Vakaros…): aggiungili in "Video e dati".'));
    else if (!cv.both.length) list.append(h('div', { class: 'stat warn' }, 'Video e dati non si sovrappongono mai. Controlla l\'ora della camera o lo spostamento dei dati in "Video e dati".'));
    else {
      list.append(h('div', { class: 'stat' }, `${cv.both.length} ${cv.both.length === 1 ? 'tratto' : 'tratti'} con video e dati insieme · ${fmtDur(tot)} in tutto`));
      cv.both.forEach(([a, b], i) => list.append(h('div', { class: 'row', style: { fontSize: '12px', gap: '6px' } },
        h('span', { class: 'dot', style: { background: 'var(--good)' } }), h('span', { class: 'num' }, `${fmtClock(a)} – ${fmtClock(b)}`), h('span', { class: 'faint' }, fmtDur(b - a)), h('div', { class: 'sp' }),
        h('button', { class: 'btn sm', onclick: () => this.V.seek(a + 1000) }, 'Vai'))));
    }
    // qualità dei dati: percentuale affidabile e i problemi più lunghi (clic = vai)
    if (Q) {
      list.append(h('div', { class: 'stat ' + (Q.good >= 0.98 ? 'good' : Q.good >= 0.9 ? '' : 'warn'), style: { marginTop: '4px' } }, 'Qualità: ' + qualityText(Q)));
      const top = Q.issues.filter(r => r.why !== 'nodata').sort((x, y) => (y.bad - x.bad) || (y.b - y.a) - (x.b - x.a)).slice(0, 8).sort((x, y) => x.a - y.a);
      for (const r of top) list.append(h('div', { class: 'row', style: { fontSize: '12px', gap: '6px' } },
        h('span', { class: 'dot', style: { background: r.bad ? 'var(--bad, #e5534b)' : 'var(--warn, #e0a33a)' } }), h('span', { class: 'num' }, `${fmtClock(r.a)} – ${fmtClock(r.b)}`), h('span', null, r.text), h('div', { class: 'sp' }),
        h('button', { class: 'btn sm', onclick: () => this.V.seek(r.a) }, 'Vai')));
      const gaps = Q.gaps.filter(g => g.a > S.t0 + 1000 && g.b < S.t1 - 1000);
      if (gaps.length) list.append(h('div', { class: 'faint small' }, `Tra le registrazioni: ${gaps.map(g => `${fmtClock(g.a)}–${fmtClock(g.b)}`).join(', ')} senza dati (registrazione ferma).`));
    }
    this.el.append(list);
  }
  update(t) { const S = this.S; this.cursor.style.left = `calc(126px + (100% - 134px) * ${clamp((t - S.t0) / ((S.t1 - S.t0) || 1), 0, 1)})`; }
  dataChanged() { this.build(); }
  resize() {}
  destroy() {}
}
PANEL_TYPES.coverage = { label: 'Copertura video e dati', icon: '▤' };
PANEL_CLASSES.coverage = CoveragePanel;

/* =================== BARRA =================== */
/* Una barra per grandezza (heel, trim, velocità…): orizzontale o verticale, dal centro o dal minimo,
   con una zona obiettivo; dentro la zona la barra diventa verde. Colori, spessore e scala si scelgono. */
class BarPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    cfg.ids = (cfg.ids || []).filter(id => this.S.live || this.S.byId.has(id));
    if (cfg.orient == null) cfg.orient = 'h';
    if (cfg.damp == null) cfg.damp = 1;
    if (cfg.thick == null) cfg.thick = 0.5;
    if (cfg.showVal == null) cfg.showVal = true;
    if (cfg.showScale == null) cfg.showScale = true;
    if (cfg.zoneTint == null) cfg.zoneTint = true;
    this.sz = 1;
    this.el = h('div', { class: 'bar-box' });
    this.build();
  }
  title() { return this.cfg.title || (this.units && this.units.length === 1 ? this.units[0].c.name : 'Barre'); }
  setSize(s) { this.sz = s; this.lastKey = ''; }
  build() {
    this.el.textContent = '';
    this.el.classList.toggle('v', this.cfg.orient === 'v');
    const chans = this.S.chs(this.cfg.ids);
    this.units = chans.map(c => { const cv = h('canvas'); this.el.append(cv); return { c, cv }; });
    if (!chans.length) this.el.append(h('div', { class: 'pnl-empty' }, this.S.live && this.cfg.ids.length ? 'In attesa di questi dati dal telefono…' : h('div', null, 'Scegli la grandezza da mostrare.', h('button', { class: 'btn sm', onclick: () => this.V.panelSettings(this) }, 'Scegli'))));
    this.lastKey = '';
  }
  refreshData() { const have = (this.units || []).map(u => u.c.id).join(), want = this.cfg.ids.filter(id => this.S.byId.has(id)).join(); if (have !== want) { this.build(); if (this._rec) this._rec.ttl.textContent = this.title(); } }
  /* scala: quella scelta, altrimenti simmetrica per gli angoli di assetto e da zero per il resto */
  range(c) {
    const lo = parseFloat(this.cfg.min), hi = parseFloat(this.cfg.max);
    if (isFinite(lo) && isFinite(hi) && hi > lo) return [lo, hi];
    const nice = x => { const m = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, x)))); return [1, 2, 2.5, 5, 10].map(k => k * m).find(k => k >= x) || 10 * m; };
    if (c.role === 'heel' || c.role === 'pitch' || this.center(c)) { const a = nice(Math.max(c.role === 'pitch' ? 5 : 10, Math.abs(c.min), Math.abs(c.max))); return [-a, a]; }
    return [Math.min(0, c.min), nice(Math.max(1, c.max))];
  }
  center(c) { return this.cfg.center != null ? this.cfg.center : (c.role === 'heel' || c.role === 'pitch'); }
  update(t) {
    const now = performance.now();
    if (now - (this._lw || 0) < 100 && this._lt != null && Math.abs(t - this._lt) < 2000) return; // 10 volte al secondo
    this._lw = now; this._lt = t;
    for (const u of this.units || []) this.draw(u, dampedValue(u.c, t, this.cfg.damp, false));
  }
  draw(u, v) {
    const cv = u.cv, dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim(), font = col('--font');
    const c = u.c, cfg = this.cfg, [lo, hi] = this.range(c), horiz = cfg.orient !== 'v';
    const base = this.center(c) ? clamp(0, lo, hi) : lo;
    const zone = isFinite(parseFloat(cfg.zLo)) && isFinite(parseFloat(cfg.zHi)) ? [Math.min(+cfg.zLo, +cfg.zHi), Math.max(+cfg.zLo, +cfg.zHi)] : null;
    const inZone = zone && isFinite(v) && v >= zone[0] && v <= zone[1];
    const barCol = inZone && cfg.zoneTint ? col('--good') : (cfg.color || col('--accent'));
    const fs = clamp(Math.min(W, H) * (horiz ? 0.13 : 0.09), 10, 22) * this.sz;
    const valTxt = isFinite(v) ? fmtNum(v, c.circular ? 0 : (c.dec ?? 1)) + (c.circular ? '°' : c.unit ? ' ' + c.unit : '') : '—';
    const label = this.units.length > 1 || cfg.title || cfg.head === 'hide'; // senza barra del titolo il nome lo scrive la barra
    const name = this.units.length === 1 && cfg.title ? cfg.title : c.name;
    g.textBaseline = 'alphabetic';
    let area, sf, scaleS = 0;
    if (horiz) {
      // in orizzontale: nome piccolo a sinistra e numero a destra sulla stessa riga, sotto la barra.
      // Anche in un pannello basso la barra resta visibile: prima si toglie la scala, poi si rimpicciolisce il testo.
      const lf = clamp(H * 0.2, 9, 13) * this.sz, vf = cfg.showVal ? clamp(H * 0.34, 11, 40) * this.sz : 0;
      const top = Math.max(label ? lf * 1.3 : 0, vf * 1.02);
      if (label) { g.fillStyle = col('--muted'); g.font = `600 ${Math.round(lf)}px ${font}`; g.textAlign = 'left'; g.fillText(name, 2, Math.max(lf, top * 0.82)); }
      if (vf) { g.fillStyle = col('--fg'); g.font = `800 ${Math.round(vf)}px ${font}`; g.textAlign = 'right'; g.fillText(valTxt, W - 2, top * 0.86); }
      sf = Math.max(9, lf * 0.9);
      const rest = H - top - 4;
      if (cfg.showScale && rest > sf * 1.4 + 14) scaleS = sf * 1.4;
      area = { x: 6, y: top + 3, w: W - 12, h: rest - scaleS };
    } else {
      // in verticale: nome e numero uno sotto l'altro, la barra sotto
      let headH = fs * 0.6;
      g.fillStyle = col('--muted'); g.font = `600 ${Math.max(10, Math.round(fs * 0.8))}px ${font}`; g.textAlign = 'left';
      if (label) { g.fillText(name, 2, Math.max(10, fs * 0.8) * 1.1); headH = Math.max(10, fs * 0.8) * 1.6; }
      if (cfg.showVal) {
        const vs = Math.min(fs * 1.7, W / Math.max(4, valTxt.length) * 1.7);
        g.fillStyle = col('--fg'); g.font = `800 ${Math.round(vs)}px ${font}`;
        g.fillText(valTxt, 2, headH + vs * 0.85);
        headH += vs * 1.1;
      }
      sf = fs * 0.7; scaleS = cfg.showScale ? fs * 1.3 : 0;
      area = { x: scaleS + 4, y: headH + 2, w: W - scaleS - 8, h: H - headH - 8 };
    }
    if (area.w < 8 || area.h < 8) return;
    const th = clamp(cfg.thick, 0.1, 1);
    const track = horiz ? { x: area.x, y: area.y + area.h * (1 - th) / 2, w: area.w, h: area.h * th } : { x: area.x + area.w * (1 - th) / 2, y: area.y, w: area.w * th, h: area.h };
    const f = x => { let p = (clamp(x, lo, hi) - lo) / (hi - lo); if (cfg.reverse) p = 1 - p; return p; };
    const P = x => horiz ? track.x + f(x) * track.w : track.y + track.h - f(x) * track.h;
    const rr = (x, y, w, hh, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, hh, Math.min(r, w / 2, hh / 2)); else g.rect(x, y, w, hh); };
    // binario
    g.fillStyle = col('--surface-3'); rr(track.x, track.y, track.w, track.h, 6); g.fill();
    // zona obiettivo
    if (zone) {
      g.fillStyle = cfg.zoneColor || col('--good'); g.globalAlpha = 0.28;
      const a = P(zone[0]), b = P(zone[1]);
      if (horiz) g.fillRect(Math.min(a, b), track.y, Math.abs(b - a), track.h); else g.fillRect(track.x, Math.min(a, b), track.w, Math.abs(b - a));
      g.globalAlpha = 1;
    }
    // barra dal centro (o dal minimo) al valore
    if (isFinite(v)) {
      const a = P(base), b = P(v);
      g.fillStyle = barCol;
      if (horiz) rr(Math.min(a, b), track.y + track.h * 0.12, Math.max(2, Math.abs(b - a)), track.h * 0.76, 4);
      else rr(track.x + track.w * 0.12, Math.min(a, b), track.w * 0.76, Math.max(2, Math.abs(b - a)), 4);
      g.fill();
      // tacca del valore
      g.fillStyle = col('--fg');
      if (horiz) g.fillRect(b - 1.5, track.y - 3, 3, track.h + 6); else g.fillRect(track.x - 3, b - 1.5, track.w + 6, 3);
    }
    // bordi della zona obiettivo, sopra la barra: si vedono sempre
    if (zone) {
      g.fillStyle = cfg.zoneColor || col('--good');
      for (const z of zone) { const p = P(z); if (horiz) g.fillRect(p - 1.5, track.y - 5, 3, track.h + 10); else g.fillRect(track.x - 5, p - 1.5, track.w + 10, 3); }
    }
    // zero
    if (lo < 0 && hi > 0) { g.fillStyle = col('--line-2'); const z = P(0); if (horiz) g.fillRect(z - 1, track.y, 2, track.h); else g.fillRect(track.x, z - 1, track.w, 2); }
    // scala
    if (scaleS) {
      const span = hi - lo, raw = span / Math.max(2, Math.floor((horiz ? track.w : track.h) / (sf * 4.5)));
      const m = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(k => k * m).find(k => k >= raw) || raw;
      g.fillStyle = col('--faint'); g.font = `500 ${Math.round(sf)}px ${font}`; g.textAlign = horiz ? 'center' : 'right'; g.textBaseline = horiz ? 'top' : 'middle';
      for (let x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) {
        const p = P(x), lab = fmtNum(x, step < 1 ? 1 : 0);
        if (horiz) { g.fillRect(p - 0.5, track.y + track.h, 1, 4); g.fillText(lab, p, track.y + track.h + 5); }
        else { g.fillRect(track.x - 4, p - 0.5, 4, 1); g.fillText(lab, track.x - 6, p); }
      }
    }
  }
  resize() { this._lw = 0; }
  settings() {
    const pick = channelPicker(this.S, this.cfg.ids);
    const cfg = this.cfg, num = (v, ph) => h('input', { type: 'number', step: 'any', value: v ?? '', placeholder: ph, style: { width: '90px' } });
    const orient = h('div', { class: 'seg' }, [['h', 'Orizzontale'], ['v', 'Verticale']].map(([v, l]) => h('button', { class: cfg.orient === v ? 'on' : '', onclick: e => { orient.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); orient.dataset.v = v; } }, l)));
    orient.dataset.v = cfg.orient;
    const center = h('select', null, [['', 'automatico (dal centro per heel e trim)'], ['1', 'dal centro (zero in mezzo)'], ['0', 'dal minimo']].map(([v, l]) => h('option', { value: v, selected: String(cfg.center == null ? '' : cfg.center ? 1 : 0) === v }, l)));
    const mn = num(cfg.min, 'auto'), mx = num(cfg.max, 'auto'), zl = num(cfg.zLo, 'da'), zh = num(cfg.zHi, 'a');
    const color = h('input', { type: 'color', value: cfg.color || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() });
    const zcolor = h('input', { type: 'color', value: cfg.zoneColor || getComputedStyle(document.documentElement).getPropertyValue('--good').trim() });
    const thick = h('select', null, [[0.25, 'sottile'], [0.5, 'media'], [0.8, 'spessa'], [1, 'piena']].map(([v, l]) => h('option', { value: v, selected: cfg.thick === v }, l)));
    const damp = h('select', null, DAMP_CHOICES.map(d => h('option', { value: d, selected: d === cfg.damp }, d ? `media degli ultimi ${d} s` : 'valore istantaneo')));
    const chk = (k, label) => { const i = h('input', { type: 'checkbox', checked: !!cfg[k] }); i._k = k; return h('label', { class: 'row', style: { gap: '6px', fontSize: '13px' } }, i, label); };
    const checks = [chk('showVal', 'Numero'), chk('showScale', 'Scala'), chk('zoneTint', 'Barra verde dentro la zona'), chk('reverse', 'Inverti la direzione')];
    const title = h('input', { type: 'text', class: 'full', value: cfg.title || '', placeholder: 'nome della grandezza' });
    let colorTouched = false, zcolorTouched = false;
    color.addEventListener('input', () => { colorTouched = true; }); zcolor.addEventListener('input', () => { zcolorTouched = true; });
    return {
      el: h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { class: 'row', style: { gap: '18px' } }, h('div', { class: 'f' }, 'Direzione', orient), h('label', { class: 'f' }, 'La barra parte', center)),
        h('div', { class: 'row', style: { gap: '18px' } }, h('div', { class: 'f' }, 'Scala (vuoto = automatica)', h('div', { class: 'row', style: { gap: '6px' } }, 'da', mn, 'a', mx)), h('div', { class: 'f' }, 'Zona obiettivo (es. heel da −2 a 2)', h('div', { class: 'row', style: { gap: '6px' } }, zl, zh))),
        h('div', { class: 'row', style: { gap: '18px' } }, h('label', { class: 'f' }, 'Colore della barra', color), h('label', { class: 'f' }, 'Colore della zona', zcolor), h('label', { class: 'f' }, 'Spessore', thick), h('label', { class: 'f' }, 'Numero', damp)),
        h('div', { class: 'f' }, 'Cosa mostrare', h('div', { class: 'row', style: { gap: '14px' } }, checks)),
        h('label', { class: 'f' }, 'Titolo', title),
        h('div', { class: 'f' }, 'Grandezze (una barra per ognuna)', pick.el)),
      apply: () => {
        cfg.ids = pick.get(); cfg.orient = orient.dataset.v; cfg.center = center.value === '' ? null : center.value === '1';
        const n = x => x.value === '' ? null : Number(x.value);
        cfg.min = n(mn); cfg.max = n(mx); cfg.zLo = n(zl); cfg.zHi = n(zh);
        if (colorTouched) cfg.color = color.value; if (zcolorTouched) cfg.zoneColor = zcolor.value;
        cfg.thick = Number(thick.value); cfg.damp = Number(damp.value); cfg.title = title.value.trim();
        for (const l of checks) { const i = l.querySelector('input'); cfg[i._k] = i.checked; }
        this.build();
      }
    };
  }
  destroy() {}
}
PANEL_TYPES.bar = { label: 'Barra (heel, trim…)', icon: '▬' };
PANEL_CLASSES.bar = BarPanel;
