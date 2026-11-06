/* Pannelli del viewer. Ogni pannello: { el (corpo), update(t, playing), resize(), destroy(), settings() } */
'use strict';
const ICONS = {
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
        if (opts.single) { sel.length = 0; sel.push(c.id); return; }
        const i = sel.indexOf(c.id);
        if (cb.checked && i < 0) sel.push(c.id); else if (!cb.checked && i >= 0) sel.splice(i, 1);
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
    cfg.ids = (cfg.ids || []).filter(id => this.S.byId.has(id));
    this.el = h('div', { class: 'chart-body', style: { position: 'absolute', inset: 0 } });
    this.lanes = [];
    this.build();
  }
  title() { return this.cfg.title || 'Grafico'; }
  win() { return this.cfg.win != null ? this.cfg.win : this.V.win; }
  headButtons() {
    const sel = h('select', { title: 'Finestra di tempo', style: { minHeight: '22px', fontSize: '11px', padding: '1px 22px 1px 6px', backgroundPosition: 'right 6px center' } },
      h('option', { value: '' }, 'come la barra'), WINDOWS.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = this.cfg.win == null ? '' : String(this.cfg.win);
    sel.onchange = () => { this.cfg.win = sel.value === '' ? null : Number(sel.value); this.lastKey = ''; this.V.layoutChanged(); this.V.requestDraw(); };
    sel.addEventListener('mousedown', e => e.stopPropagation());
    this.winSel = sel;
    return [sel];
  }
  build() {
    for (const l of this.lanes) l.u.destroy();
    this.lanes = []; this.el.textContent = '';
    const chans = this.cfg.ids.map(id => this.S.ch(id)).filter(Boolean);
    if (!chans.length) {
      this.el.append(h('div', { class: 'pnl-empty' }, h('div', null, 'Scegli cosa mostrare in questo grafico.', h('button', { class: 'btn sm', onclick: () => this.V.panelSettings(this) }, 'Scegli i canali'))));
      return;
    }
    // una fascia per unità di misura: mai due assi Y sullo stesso grafico
    const groups = new Map();
    for (const c of chans) { const k = c.circular ? '°dir' : (c.unit || '-'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    let ci = 0;
    for (const [unit, list] of groups) {
      const lane = { unit, list, colors: list.map(() => seriesColor(ci++)) };
      lane.el = h('div', { class: 'lane' });
      lane.legend = h('div', { class: 'lane-legend' });
      lane.plot = h('div', { class: 'lane-plot' });
      lane.el.append(lane.legend, lane.plot);
      this.el.append(lane.el);
      lane.items = list.map((c, i) => {
        const val = h('b'); const sp = h('span', { title: c.srcName }, h('i', { style: { background: lane.colors[i] } }), h('em', null, c.name), val, c.unit ? h('em', null, c.unit) : null);
        sp.onclick = () => { const s = lane.u.series[i + 1]; lane.u.setSeries(i + 1, { show: !s.show }); sp.classList.toggle('off', !s.show); };
        lane.legend.append(sp);
        return { c, val, last: '' };
      });
      this.lanes.push(lane);
    }
    requestAnimationFrame(() => this.makePlots());
  }
  makePlots() {
    const S = this.S, span = S.t1 - S.t0;
    for (const lane of this.lanes) {
      const minStep = Math.min(...lane.list.map(c => c.step));
      const step = Math.max(minStep, span / 150000, 20);
      const n = Math.max(2, Math.floor(span / step) + 1);
      const xs = new Float64Array(n);
      for (let k = 0; k < n; k++) xs[k] = (S.t0 + k * step) / 1000;
      const ys = lane.list.map(c => { const r = resample(c, S.t0, step, n); const a = new Array(n); for (let k = 0; k < n; k++) a[k] = isFinite(r[k]) ? r[k] : null; return a; });
      let mn = Infinity, mx = -Infinity;
      for (const c of lane.list) { mn = Math.min(mn, c.min); mx = Math.max(mx, c.max); }
      if (lane.unit === '°dir') { mn = 0; mx = 360; }
      else { const pad = (mx - mn) * 0.06 || 1; mn -= pad; mx += pad; if (lane.list.every(c => c.min >= 0) && mn < 0) mn = 0; }
      lane.fixed = [mn, mx];
      const cs = getComputedStyle(document.documentElement);
      const axisC = cs.getPropertyValue('--axis').trim(), gridC = cs.getPropertyValue('--grid').trim();
      const self = this;
      const rect = lane.plot.getBoundingClientRect();
      const opts = {
        width: Math.max(50, rect.width), height: Math.max(40, rect.height),
        legend: { show: false }, padding: [6, 8, 0, 0],
        cursor: { y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
        scales: { x: { time: true }, y: { range: (u, a, b) => this.cfg.yMode === 'window' && lane.unit !== '°dir' ? autoRange(a, b) : lane.fixed } },
        axes: [
          { stroke: axisC, grid: { stroke: gridC, width: 1 }, ticks: { stroke: gridC, size: 4 }, size: 24, space: 90, font: '11px ' + cs.getPropertyValue('--font'), values: (u, sp) => sp.map(s => { const d = new Date(s * 1000); const w = u.scales.x.max - u.scales.x.min; return w > 900 ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }) },
          { stroke: axisC, grid: { stroke: gridC, width: 1 }, ticks: { show: false }, size: 42, space: 28, font: '11px ' + cs.getPropertyValue('--font'), values: (u, sp) => sp.map(v => fmtNum(v, Math.abs(sp[1] - sp[0]) < 1 ? 1 : 0)) }
        ],
        series: [{}, ...lane.list.map((c, i) => ({ label: c.name, stroke: lane.colors[i], width: 1.6, points: { show: false }, spanGaps: false }))],
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
    over.addEventListener('mousedown', e => { down = { x: e.clientX, t: this.V.t, moved: false }; this.V.scrubbing = true; e.preventDefault(); });
    window.addEventListener('mousemove', this._mm = e => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 3) down.moved = true;
      if (down.moved) { const u = lane.u, w = (u.scales.x.max - u.scales.x.min) * 1000; this.V.seek(down.t - dx / u.over.clientWidth * w); }
    });
    window.addEventListener('mouseup', this._mu = e => {
      if (!down) return;
      if (!down.moved) { const r = over.getBoundingClientRect(); this.V.seek(lane.u.posToVal(e.clientX - r.left, 'x') * 1000); }
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
    // eventi
    const x0 = u.scales.x.min * 1000, x1 = u.scales.x.max * 1000;
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
  settings() {
    const pick = channelPicker(this.S, this.cfg.ids);
    const title = h('input', { type: 'text', class: 'full', value: this.cfg.title || '', placeholder: 'Grafico' });
    const ym = h('div', { class: 'seg' }, [['session', 'Scala fissa (tutta l\'uscita)'], ['window', 'Adatta alla finestra']].map(([v, l]) => h('button', { class: (this.cfg.yMode || 'session') === v ? 'on' : '', onclick: e => { ym.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); ym.dataset.v = v; } }, l)));
    ym.dataset.v = this.cfg.yMode || 'session';
    return {
      el: h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'f' }, 'Titolo', title), h('div', { class: 'f' }, 'Asse verticale', ym), h('div', { class: 'f' }, 'Canali (grandezze con unità diverse vanno in fasce separate)', pick.el)),
      apply: () => { this.cfg.ids = pick.get(); this.cfg.title = title.value.trim(); this.cfg.yMode = ym.dataset.v; this.build(); }
    };
  }
  destroy() { for (const l of this.lanes) l.u && l.u.destroy(); window.removeEventListener('mousemove', this._mm); window.removeEventListener('mouseup', this._mu); }
}
function autoRange(a, b) { if (a == null || b == null) return [0, 1]; const p = (b - a) * 0.08 || 1; return [a - p, b + p]; }

/* =================== MAPPA =================== */
class MapPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    if (cfg.follow == null) cfg.follow = false;
    if (cfg.trail == null) cfg.trail = 60;
    this.el = h('div', { class: 'map-box' });
    const pos = this.S.pos;
    if (!pos) { this.el.append(h('div', { class: 'pnl-empty' }, 'Nessuna posizione GPS: carica un file con latitudine e longitudine (Vakaros, GPX, Cyclops) o accendi il GPS della GoPro.')); return; }
    requestAnimationFrame(() => this.init());
  }
  title() { return 'Mappa'; }
  headButtons() {
    const b = h('button', { class: 'icon-btn' + (this.cfg.follow ? ' on' : ''), title: 'Segui la barca', 'aria-label': 'Segui la barca', html: ICONS.follow });
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
    this.map.on('click', e => {
      const P = this.map.latLngToContainerPoint(e.latlng);
      let best = null, bd = 30 * 30;
      for (const p of this.pts) { const q = this.map.latLngToContainerPoint([p[1], p[2]]); const d = (q.x - P.x) ** 2 + (q.y - P.y) ** 2; if (d < bd) { bd = d; best = p; } }
      if (best) this.V.seek(best[0]);
    });
    this.map.on('dragstart', () => { if (this.cfg.follow) { this.cfg.follow = false; this.V.layoutChanged(); } });
    this.V.requestDraw();
  }
  colorCh() { return this.S.ch(this.cfg.colorBy) || this.S.sog; }
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
    if (this.bounds) this.map.fitBounds(this.bounds, { padding: [16, 16] }); else this.map.setView([39.2, 9.1], 12);
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
  destroy() { if (this.map) this.map.remove(); }
}

/* =================== NUMERI =================== */
class NumbersPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    cfg.ids = (cfg.ids || []).filter(id => this.S.byId.has(id));
    if (cfg.avg == null) cfg.avg = 10;
    this.el = h('div', { class: 'num-grid' });
    this.build();
  }
  title() { return this.cfg.title || 'Numeri'; }
  build() {
    this.el.textContent = '';
    this.tiles = [];
    const chans = this.cfg.ids.map(id => this.S.ch(id)).filter(Boolean);
    if (!chans.length) { this.el.append(h('div', { class: 'pnl-empty', style: { background: 'var(--surface)' } }, h('div', null, 'Scegli le grandezze da mostrare.', h('button', { class: 'btn sm', onclick: () => this.V.panelSettings(this) }, 'Scegli i canali')))); return; }
    for (const c of chans) {
      const val = h('span'), unit = h('small', null, c.circular ? '' : c.unit), avg = h('span'), rng = h('span'), bar = h('i');
      const tile = h('div', { class: 'tile', title: `${c.name} · ${c.srcName}` }, h('div', { class: 'tile-lbl' }, c.name), h('div', { class: 'tile-val' }, val, unit), h('div', { class: 'tile-sub' }, avg, rng), c.circular ? null : h('div', { class: 'tile-bar' }, bar));
      this.el.append(tile);
      this.tiles.push({ c, val, avg, rng, bar, last: '' });
    }
    this.resize();
  }
  resize() {
    const n = this.tiles ? this.tiles.length : 0;
    if (!n) return;
    const r = this.el.getBoundingClientRect();
    const ar = (r.width || 300) / (r.height || 300);
    let best = 1, bs = -1;
    for (let cols = 1; cols <= n; cols++) { const rows = Math.ceil(n / cols); const tw = r.width / cols, th = r.height / rows; const s = Math.min(tw / 1.7, th) - (rows * cols - n) * 2; if (s > bs) { bs = s; best = cols; } }
    this.el.style.setProperty('--cols', best);
    void ar;
  }
  update(t) {
    if (this.el.clientWidth !== this._w || this.el.clientHeight !== this._h) { this._w = this.el.clientWidth; this._h = this.el.clientHeight; this.resize(); }
    const w = this.cfg.avg * 1000;
    for (const it of this.tiles || []) {
      const c = it.c, v = interp(c, t);
      const s = c.circular ? dirLabel(v) : fmtVal(c, v);
      if (s === it.last) continue;
      it.last = s;
      it.val.textContent = s;
      const st = stats(c, t - w, t);
      it.avg.textContent = `media ${this.cfg.avg} s ${c.circular ? dirLabel(st.mean) : fmtVal(c, st.mean)}`;
      it.rng.textContent = c.circular ? '' : `max ${fmtVal(c, st.max)}`;
      if (!c.circular) { const lo = Math.min(0, c.min), p = isFinite(v) ? clamp((v - lo) / ((c.max - lo) || 1), 0, 1) : 0; it.bar.style.width = (p * 100).toFixed(1) + '%'; }
    }
  }
  settings() {
    const pick = channelPicker(this.S, this.cfg.ids);
    const avg = h('input', { type: 'number', min: 1, max: 600, value: this.cfg.avg });
    const title = h('input', { type: 'text', class: 'full', value: this.cfg.title || '', placeholder: 'Numeri' });
    return { el: h('div', { style: { display: 'grid', gap: '12px' } }, h('label', { class: 'f' }, 'Titolo', title), h('label', { class: 'f' }, 'Media sugli ultimi (secondi)', avg), h('div', { class: 'f' }, 'Grandezze', pick.el)),
      apply: () => { this.cfg.ids = pick.get(); this.cfg.avg = Math.max(1, Number(avg.value) || 10); this.cfg.title = title.value.trim(); this.build(); } };
  }
  destroy() {}
}

/* =================== EVENTI =================== */
class EventsPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    this.q = ''; this.type = '';
    this.el = h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' } });
    const search = h('input', { type: 'search', placeholder: 'Cerca nelle note…' });
    search.addEventListener('input', () => { this.q = search.value.toLowerCase(); this.render(); });
    const tsel = h('select', null, h('option', { value: '' }, 'Tutti i tipi'), EVENT_TYPES.map(e => h('option', { value: e.id }, e.label)));
    tsel.addEventListener('change', () => { this.type = tsel.value; this.render(); });
    this.el.append(h('div', { class: 'ev-tools' }, search, tsel,
      h('button', { class: 'btn sm', title: 'Trova virate e strambate dalla rotta GPS', onclick: () => this.V.detectManeuvers() }, 'Trova manovre'),
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
      const tr = h('tr', { onclick: () => { this.V.seek(ev.t - this.V.preroll); }, ondblclick: () => this.V.editEvent(ev) },
        h('td', null, fmtClock(ev.t)),
        h('td', null, h('span', { class: 'chip' }, h('span', { class: 'dot', style: { background: eventColor(ev.type) } }), et.label)),
        h('td', { class: 'note' }, ev.note || (ev.auto ? h('span', { class: 'faint' }, 'trovata in automatico') : '')),
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
    const chans = this.cfg.ids.map(id => this.S.ch(id)).filter(Boolean);
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
    const rows = [...cv.cams.map(c => ({ label: '🎥 ' + c.name, spans: c.spans, color: c.color })), ...cv.data.map(d => ({ label: '📈 ' + d.name, spans: d.spans, color: 'var(--muted)' })),
      { label: 'Video + dati', spans: cv.both, color: 'var(--good)', strong: true }];
    this.lanes = h('div', { style: { position: 'relative', padding: '6px 8px 2px', display: 'grid', gap: '3px', cursor: 'pointer' } });
    const X = t => ((t - S.t0) / ((S.t1 - S.t0) || 1) * 100).toFixed(3) + '%';
    for (const r of rows) {
      const lane = h('div', { class: 'cover-lane', style: { height: r.strong ? '12px' : '8px' } });
      for (const [a, b] of r.spans) lane.append(h('i', { style: { left: X(a), width: `max(2px, calc(${X(b)} - ${X(a)}))`, background: r.color } }));
      this.lanes.append(h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px', alignItems: 'center', fontSize: '11px' } },
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
    this.el.append(list);
  }
  update(t) { const S = this.S; this.cursor.style.left = `calc(126px + (100% - 134px) * ${clamp((t - S.t0) / ((S.t1 - S.t0) || 1), 0, 1)})`; }
  dataChanged() { this.build(); }
  resize() {}
  destroy() {}
}
PANEL_TYPES.coverage = { label: 'Copertura video e dati', icon: '▤' };
PANEL_CLASSES.coverage = CoveragePanel;
