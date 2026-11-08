/* Griglia libera dei pannelli: posizione e grandezza in quadretti (24 colonne, righe alte cellH),
   i pannelli possono stare uno sopra l'altro e hanno un livello (z): avanti / dietro.
   Si sposta dalla maniglia (.pnl-grip), si ridimensiona dall'angolo in basso a destra.
   Funziona con mouse, dito e penna (pointer events). */
'use strict';
class FreeGrid {
  constructor(el, { cols = 24, cellH = 30, locked = false, handle = '.pnl-grip' } = {}) {
    this.el = el; this.cols = cols; this.ch = cellH; this.locked = locked; this.handle = handle;
    this.list = []; this.fns = { change: [] };
    el.classList.add('fgrid');
    el.classList.toggle('locked', locked);
  }
  on(ev, fn) { (this.fns[ev] = this.fns[ev] || []).push(fn); }
  emit(ev) { for (const fn of this.fns[ev] || []) fn(); }
  items() { return [...this.list].sort((a, b) => a.node.z - b.node.z); }
  maxZ() { return this.list.reduce((m, it) => Math.max(m, it.node.z), 0); }
  overlap(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  /* primo posto libero (dall'alto, da sinistra) per un pannello w×h; null se non c'è entro maxY */
  freeSpot(w, h, maxY = Infinity) {
    const bottom = this.list.reduce((m, it) => Math.max(m, it.node.y + it.node.h), 0);
    for (let y = 0; y <= Math.min(bottom, maxY - h); y++)
      for (let x = 0; x + w <= this.cols; x++) {
        const r = { x, y, w, h };
        if (!this.list.some(it => this.overlap(r, it.node))) return { x, y };
      }
    return bottom + h <= maxY ? { x: 0, y: bottom } : null;
  }
  add(el, { id, x, y, w = 6, h = 6, z, autoPosition = false, maxY = Infinity } = {}) {
    w = clamp(Math.round(w), 1, this.cols); h = Math.max(1, Math.round(h));
    if (autoPosition || x == null || y == null) { const p = this.freeSpot(w, h, maxY) || { x: 0, y: 0 }; x = p.x; y = p.y; }
    x = clamp(Math.round(x), 0, this.cols - w); y = Math.max(0, Math.round(y));
    el.node = { id, x, y, w, h, z: z != null ? z : this.maxZ() + 1 };
    el.classList.add('grid-stack-item');
    if (!el.querySelector(':scope > .fg-rs')) {
      const rs = h_('div', 'fg-rs'); rs.title = 'Trascina per cambiare la grandezza';
      rs.addEventListener('pointerdown', e => this.startDrag(e, el, 'size'));
      el.append(rs);
    }
    const grip = el.querySelector(this.handle);
    if (grip && !grip._fg) { grip._fg = true; grip.addEventListener('pointerdown', e => this.startDrag(e, el, 'move')); }
    if (!this.list.includes(el)) this.list.push(el);
    if (el.parentNode !== this.el) this.el.append(el);
    this.place(el); this.fitHeight();
    return el;
    function h_(tag, cls) { const d = document.createElement(tag); d.className = cls; return d; }
  }
  place(el) {
    const n = el.node, s = el.style;
    s.left = (n.x / this.cols * 100) + '%'; s.width = (n.w / this.cols * 100) + '%';
    s.top = (n.y * this.ch) + 'px'; s.height = (n.h * this.ch) + 'px';
    s.zIndex = el.classList.contains('fg-drag') ? 10000 : n.z;
  }
  fitHeight() { const b = this.list.reduce((m, it) => Math.max(m, it.node.y + it.node.h), 0); this.el.style.height = (b * this.ch) + 'px'; }
  remove(el) { this.list = this.list.filter(x => x !== el); el.remove(); this.fitHeight(); }
  removeAll() { for (const el of this.list) el.remove(); this.list = []; this.fitHeight(); }
  setStatic(on) { this.locked = on; this.el.classList.toggle('locked', on); }
  cellHeight(px) { if (px == null) return this.ch; this.ch = px; for (const el of this.list) this.place(el); this.fitHeight(); }
  cellAt(cx, cy) { const r = this.el.getBoundingClientRect(); return { x: Math.floor((cx - r.left) / (r.width / this.cols)), y: Math.floor((cy - r.top) / this.ch) }; }
  destroy() { this.removeAll(); this.fns = { change: [] }; }
  /* livelli: 'front' in primo piano, 'back' in fondo, 'up' / 'down' di un passo (tra i pannelli che si toccano) */
  restack(el, how) {
    const order = this.items();
    const i = order.indexOf(el); if (i < 0) return false;
    order.splice(i, 1);
    let j = i;
    if (how === 'front') j = order.length;
    else if (how === 'back') j = 0;
    else if (how === 'up') { const k = order.findIndex((o, q) => q >= i && this.overlap(o.node, el.node)); j = k < 0 ? i : k + 1; } // sopra il primo che lo copre
    else if (how === 'down') { let k = i - 1; while (k >= 0 && !this.overlap(order[k].node, el.node)) k--; j = k < 0 ? i : k; } // sotto il primo che copre
    order.splice(j, 0, el);
    const changed = order.some((o, k) => o.node.z !== k + 1);
    order.forEach((o, k) => { o.node.z = k + 1; this.place(o); });
    if (changed) this.emit('change');
    return changed;
  }
  startDrag(e, el, mode) {
    if (this.locked || e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    const n = el.node, start = { x: n.x, y: n.y, w: n.w, h: n.h }, cx = e.clientX, cy = e.clientY;
    const colW = this.el.getBoundingClientRect().width / this.cols;
    const tgt = e.currentTarget; try { tgt.setPointerCapture(e.pointerId); } catch (err) { /* ignora */ }
    el.classList.add('fg-drag'); this.place(el);
    const move = ev => {
      const dx = Math.round((ev.clientX - cx) / colW), dy = Math.round((ev.clientY - cy) / this.ch);
      if (mode === 'move') { n.x = clamp(start.x + dx, 0, this.cols - n.w); n.y = Math.max(0, start.y + dy); }
      else { n.w = clamp(start.w + dx, 1, this.cols - n.x); n.h = Math.max(1, start.h + dy); }
      this.place(el); this.fitHeight();
    };
    const up = () => {
      tgt.removeEventListener('pointermove', move); tgt.removeEventListener('pointerup', up); tgt.removeEventListener('pointercancel', up);
      el.classList.remove('fg-drag'); this.place(el);
      if (n.x !== start.x || n.y !== start.y || n.w !== start.w || n.h !== start.h) this.emit('change');
    };
    tgt.addEventListener('pointermove', move); tgt.addEventListener('pointerup', up); tgt.addEventListener('pointercancel', up);
  }
}
