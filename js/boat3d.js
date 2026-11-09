/* Pannello NACRA 17 IN 3D: la barca si muove come quella vera (heel, trim, prua) secondo i dati.
   Scafi, traverse, trampolino, bompresso, derive curve (stilizzate) e timoni a T. Niente albero.
   Viste: da poppa, di lato, 3/4, dall'alto (col vento); trascinando si gira attorno, la rotella avvicina.
   three.js (lib/three.module.min.js) si carica solo quando serve. */
'use strict';

let THREE_LOAD = null;
function loadThree() { return THREE_LOAD || (THREE_LOAD = import(new URL('lib/three.module.min.js', document.baseURI).href)); }

/* misure del Nacra 17 (metri): lunghezza 5,25, larghezza 2,59 */
const N17 = { L: 5.25, B: 2.59, hw: 0.215, deck: 0.14, keel: 0.36 };
N17.hx = N17.B / 2 - N17.hw;            // asse di ogni scafo dal centro
N17.zFront = -N17.L / 2 + 2.05;         // traversa anteriore (2,05 m dalla prua)
N17.zRear = N17.L / 2 - 0.32;           // traversa posteriore

const VIEWS3D = { poppa: [0, 1.5, 7.8], lato: [8.2, 1.1, 0], tre: [5.2, 2.8, 5.8], alto: [0, 12, 0.01] };

/* scafo: sezioni a U lungo la lunghezza (z: prua -L/2, poppa +L/2) */
function hullGeometry(T) {
  const NS = 48, NP = 18, pos = [], idx = [], L = N17.L;
  const halfW = u => u < 0.7 ? N17.hw * Math.pow(Math.sin(u / 0.7 * Math.PI / 2), 0.75) : N17.hw * (1 - 0.18 * (u - 0.7) / 0.3);
  const depth = u => N17.keel * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.pow(u, 0.85) * 1.05)));
  const sheer = u => N17.deck + 0.05 * (1 - u) * (1 - u);
  for (let i = 0; i <= NS; i++) {
    const u = i / NS, z = -L / 2 + u * L, w = Math.max(0.002, halfW(u)), d = depth(u), dk = sheer(u);
    for (let j = 0; j <= NP; j++) {
      const th = j / NP * Math.PI;           // 0: bordo a dritta, π/2: chiglia, π: bordo a sinistra
      pos.push(w * Math.cos(th), dk - (dk + d) * Math.pow(Math.sin(th), 0.85), z);
    }
  }
  const R = NP + 1;
  for (let i = 0; i < NS; i++) for (let j = 0; j < NP; j++) {
    const a = i * R + j, b = a + 1, c = a + R, e = c + 1;
    idx.push(a, c, b, b, c, e);
  }
  // specchio di poppa
  const base = pos.length / 3; pos.push(0, sheer(1) - 0.05, L / 2);
  for (let j = 0; j < NP; j++) idx.push(base, NS * R + j, NS * R + j + 1);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  // coperta: leggermente bombata
  const dp = [], di = [];
  for (let i = 0; i <= NS; i++) {
    const u = i / NS, z = -L / 2 + u * L, w = Math.max(0.002, halfW(u)) * 0.98, dk = sheer(u);
    dp.push(w, dk, z, 0, dk + 0.035 * Math.min(1, w / N17.hw), z, -w, dk, z);
  }
  for (let i = 0; i < NS; i++) { const a = i * 3; di.push(a, a + 1, a + 3, a + 1, a + 4, a + 3, a + 1, a + 2, a + 4, a + 2, a + 5, a + 4); }
  const gd = new T.BufferGeometry();
  gd.setAttribute('position', new T.Float32BufferAttribute(dp, 3)); gd.setIndex(di); gd.computeVertexNormals();
  return { hull: g, deck: gd };
}
/* lama piatta lungo una curva (deriva o timone): corda lungo l'asse z, spessore sottile */
function bladeGeometry(T, pts, chord, thick, chordTaper = 0.6) {
  const curve = new T.CatmullRomCurve3(pts.map(p => new T.Vector3(...p))), N = 40, pos = [], idx = [];
  const Z = new T.Vector3(0, 0, 1);
  for (let i = 0; i <= N; i++) {
    const u = i / N, p = curve.getPointAt(u), tg = curve.getTangentAt(u);
    let n = new T.Vector3().crossVectors(tg, Z); if (n.lengthSq() < 1e-6) n.set(1, 0, 0); n.normalize();
    const c = chord * (1 - (1 - chordTaper) * u) / 2, t = thick / 2;
    for (const [sz, sn] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pos.push(p.x + n.x * t * sn, p.y + n.y * t * sn, p.z + c * sz);
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < 4; k++) {
    const a = i * 4 + k, b = i * 4 + (k + 1) % 4, c = a + 4, d = b + 4;
    idx.push(a, c, b, b, c, d);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function buildNacra(T) {
  const boat = new T.Group();
  const white = new T.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.42, metalness: 0.05, side: T.DoubleSide });
  const deckM = new T.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.7 });
  const carbon = new T.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.35, metalness: 0.3, side: T.DoubleSide });
  const stripe = new T.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.5 });
  const { hull, deck } = hullGeometry(T);
  for (const s of [1, -1]) {
    const hg = new T.Group(); hg.position.x = s * N17.hx;
    hg.add(new T.Mesh(hull, white), new T.Mesh(deck, deckM));
    // riga colorata sul fianco esterno (aiuta a vedere il beccheggio)
    const st = new T.Mesh(new T.BoxGeometry(0.01, 0.035, N17.L * 0.82), stripe);
    st.position.set(s * (N17.hw - 0.012), N17.deck - 0.06, 0.15); hg.add(st);
    boat.add(hg);
    // deriva curva: scende dentro lo scafo, poi piega verso il centro barca (a Z/J, stilizzata)
    const zb = N17.zFront + 0.28, x0 = s * N17.hx - s * 0.06;
    boat.add(new T.Mesh(bladeGeometry(T, [[x0, N17.deck, zb], [x0, -0.6, zb], [x0 - s * 0.05, -1.05, zb], [x0 - s * 0.3, -1.25, zb], [x0 - s * 0.62, -1.18, zb]], 0.2, 0.03, 0.75), carbon));
    // timone con piano orizzontale a T
    const zr = N17.L / 2 + 0.06, xr = s * N17.hx;
    boat.add(new T.Mesh(bladeGeometry(T, [[xr, N17.deck + 0.05, zr], [xr, -0.4, zr + 0.02], [xr, -0.95, zr + 0.04]], 0.17, 0.025, 0.8), carbon));
    const tf = new T.Mesh(new T.BoxGeometry(0.76, 0.02, 0.12), carbon); tf.position.set(xr, -0.95, zr + 0.06); boat.add(tf);
  }
  // traverse
  const beam = (z, r) => { const m = new T.Mesh(new T.CylinderGeometry(r, r, N17.hx * 2 + 0.1, 16), carbon); m.rotation.z = Math.PI / 2; m.position.set(0, N17.deck + 0.06, z); return m; };
  boat.add(beam(N17.zFront, 0.065), beam(N17.zRear, 0.05));
  // trampolino
  const tw = N17.hx * 2 - N17.hw * 1.6, tl = N17.zRear - N17.zFront;
  const tramp = new T.Mesh(new T.PlaneGeometry(tw, tl), new T.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.9, transparent: true, opacity: 0.88, side: T.DoubleSide }));
  tramp.rotation.x = -Math.PI / 2; tramp.position.set(0, N17.deck + 0.04, (N17.zFront + N17.zRear) / 2); boat.add(tramp);
  // bompresso
  const sp = new T.Vector3(0, N17.deck + 0.12, N17.zFront), ep = new T.Vector3(0, N17.deck + 0.05, -N17.L / 2 - 0.85);
  const bs = new T.Mesh(new T.CylinderGeometry(0.025, 0.035, sp.distanceTo(ep), 10), carbon);
  bs.position.copy(sp).add(ep).multiplyScalar(0.5); bs.lookAt(ep); bs.rotateX(Math.PI / 2); boat.add(bs);
  // piede d'albero (solo un riferimento, senza albero)
  const mf = new T.Mesh(new T.CylinderGeometry(0.06, 0.08, 0.18, 12), carbon); mf.position.set(0, N17.deck + 0.15, N17.zFront); boat.add(mf);
  return boat;
}
/* freccia del vento (vista dall'alto) */
function windArrow(T) {
  const g = new T.Group(), m = new T.MeshBasicMaterial({ color: 0x3987e5 });
  const shaft = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 2.4, 8), m); shaft.rotation.x = Math.PI / 2; shaft.position.z = -1.2; g.add(shaft);
  const head = new T.Mesh(new T.ConeGeometry(0.22, 0.6, 12), m); head.rotation.x = Math.PI / 2; head.position.z = 0.3; g.add(head);
  return g;
}

class Boat3DPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    if (!cfg.view) cfg.view = 'tre';
    if (!cfg.gain) cfg.gain = 1;
    this.el = h('div', { class: 'b3-box' });
    this.hud = h('div', { class: 'b3-hud' });
    this.msg = h('div', { class: 'pnl-empty', hidden: true });
    this.el.append(this.hud, this.msg);
    this.dist = 0; this.lastT = null; this.att = null;
    const ch = pickChannels(this.S);
    this.ch = { heel: ch.heel, pitch: ch.pitch, hdg: this.S.channels.find(c => c.role === 'hdg' && !c.derived) || this.S.cog, sog: this.S.sog };
    if (!this.ch.heel && !this.ch.pitch) { this.msg.hidden = false; this.msg.textContent = 'Servono heel e trim (dal telefono del Logger o dalla GoPro).'; return; }
    loadThree().then(T => this.init(T)).catch(() => { this.msg.hidden = false; this.msg.textContent = 'Non riesco a caricare la grafica 3D in questo browser.'; });
  }
  title() { return 'Nacra 17 in 3D'; }
  headButtons() {
    const st = { minHeight: '22px', fontSize: '11px', padding: '1px 22px 1px 6px', backgroundPosition: 'right 6px center' };
    const v = h('select', { title: 'Vista', style: st }, [['poppa', 'da poppa'], ['lato', 'di lato'], ['tre', '3/4'], ['alto', 'dall\'alto'], ['libera', 'libera']].map(([k, l]) => h('option', { value: k }, l)));
    v.value = this.cfg.view;
    v.onchange = () => { this.cfg.view = v.value; if (v.value !== 'libera') this.orbit = null; this.placeCamera(); this.render(); this.V.layoutChanged(); };
    const g = h('select', { title: 'Amplifica i movimenti (i gradi piccoli si vedono meglio)', style: st }, [[1, 'movimenti reali'], [2, '×2'], [3, '×3']].map(([k, l]) => h('option', { value: k }, l)));
    g.value = String(this.cfg.gain);
    g.onchange = () => { this.cfg.gain = Number(g.value); this.render(); this.V.layoutChanged(); };
    for (const s of [v, g]) s.addEventListener('mousedown', e => e.stopPropagation());
    this.viewSel = v;
    return [v, g];
  }
  init(T) {
    this.T = T;
    let r;
    try { r = this.renderer = new T.WebGLRenderer({ antialias: true }); } catch (e) { this.msg.hidden = false; this.msg.textContent = 'Questo browser non ha la grafica 3D (WebGL).'; return; }
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.el.prepend(r.domElement);
    const dark = document.documentElement.dataset.theme !== 'light';
    const bg = dark ? 0x0d1822 : 0xcfe0ee;
    const sc = this.scene = new T.Scene();
    sc.background = new T.Color(bg); sc.fog = new T.Fog(bg, 22, 80);
    sc.add(new T.HemisphereLight(0xffffff, dark ? 0x203040 : 0x6f8aa0, dark ? 1.6 : 2.0));
    const sun = new T.DirectionalLight(0xffffff, 1.6); sun.position.set(-6, 12, 5); sc.add(sun);
    // acqua: piano semitrasparente (si vedono le derive sotto) e griglia che scorre alla velocità della barca
    const water = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshStandardMaterial({ color: dark ? 0x1d4e6e : 0x3b7fae, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.62, depthWrite: false }));
    water.rotation.x = -Math.PI / 2; sc.add(water);
    this.grid = new T.GridHelper(120, 60, dark ? 0x5d8bab : 0xe6f1fa, dark ? 0x3a6a8a : 0xbcd6ea); this.grid.position.y = 0.002;
    this.grid.material.transparent = true; this.grid.material.opacity = 0.55; sc.add(this.grid);
    this.boat = buildNacra(T); this.boat.rotation.order = 'YXZ'; sc.add(this.boat);
    this.wind = windArrow(T); this.wind.position.y = 0.05; this.wind.visible = false; sc.add(this.wind);
    this.cam = new T.PerspectiveCamera(38, 1, 0.1, 300);
    this.bindOrbit();
    this.resize(); this.placeCamera(); this.update(this.V.t, false);
  }
  bindOrbit() {
    const c = this.renderer.domElement;
    c.style.touchAction = 'none';
    let d = null;
    c.addEventListener('pointerdown', e => { d = { x: e.clientX, y: e.clientY, o: this.orbitNow() }; c.setPointerCapture(e.pointerId); e.preventDefault(); });
    c.addEventListener('pointermove', e => {
      if (!d) return;
      const az = d.o.az - (e.clientX - d.x) * 0.008, el = clamp(d.o.el + (e.clientY - d.y) * 0.006, 0.02, 1.52);
      this.orbit = { az, el, r: d.o.r }; this.cfg.view = 'libera'; if (this.viewSel) this.viewSel.value = 'libera';
      this.placeCamera(); this.render();
    });
    const up = () => { if (d) { d = null; this.V.layoutChangedSoon(); } };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => { e.preventDefault(); const o = this.orbitNow(); this.orbit = Object.assign(o, { r: clamp(o.r * (e.deltaY > 0 ? 1.1 : 0.9), 4, 40) }); this.cfg.view = 'libera'; if (this.viewSel) this.viewSel.value = 'libera'; this.placeCamera(); this.render(); }, { passive: false });
  }
  orbitNow() {
    if (this.orbit) return Object.assign({}, this.orbit);
    if (this.cfg.orbit) return Object.assign({}, this.cfg.orbit);
    const p = VIEWS3D[this.cfg.view] || VIEWS3D.tre, r = Math.hypot(...p);
    return { az: Math.atan2(p[0], p[2]), el: Math.asin(p[1] / r), r };
  }
  placeCamera() {
    if (!this.cam) return;
    let p;
    if (this.cfg.view === 'libera') { const o = this.orbit || this.cfg.orbit || this.orbitNow(); this.cfg.orbit = o; p = [o.r * Math.cos(o.el) * Math.sin(o.az), o.r * Math.sin(o.el), o.r * Math.cos(o.el) * Math.cos(o.az)]; }
    else p = VIEWS3D[this.cfg.view] || VIEWS3D.tre;
    this.cam.position.set(...p); this.cam.lookAt(0, -0.15, 0);
  }
  /* assetto all'ora t (heel e trim interpolati dai dati a 25 Hz, prua per la vista dall'alto) */
  attitude(t) {
    const g = this.cfg.gain || 1, val = c => c ? interp(c, t) : NaN;
    return { heel: val(this.ch.heel), pitch: val(this.ch.pitch), hdg: val(this.ch.hdg), sog: val(this.ch.sog), g };
  }
  update(t, playing) {
    if (!this.renderer) return;
    const a = this.attitude(t);
    // acqua che scorre: distanza percorsa dall'ultimo aggiornamento (solo se il tempo va avanti con continuità)
    if (this.lastT != null && isFinite(a.sog)) { const dt = (t - this.lastT) / 1000; if (dt > 0 && dt < 2) this.dist += a.sog / KN * dt; }
    this.lastT = t;
    this.att = a;
    this.render();
    const f = (v, d) => isFinite(v) ? fmtNum(Math.abs(v), d) : '—';
    this.hud.textContent = '';
    this.hud.append(...[
      h('span', null, 'Heel ', h('b', null, `${f(a.heel, 1)}°`), isFinite(a.heel) && Math.abs(a.heel) >= 0.5 ? (a.heel > 0 ? ' a dritta' : ' a sinistra') : ''),
      h('span', null, 'Trim ', h('b', null, `${f(a.pitch, 1)}°`), isFinite(a.pitch) && Math.abs(a.pitch) >= 0.2 ? (a.pitch > 0 ? ' prua su' : ' prua giù') : ''),
      isFinite(a.sog) ? h('span', null, h('b', null, fmtNum(a.sog, 1)), ' kn') : null,
      a.g > 1 ? h('span', { class: 'b3-gain' }, `movimenti ×${a.g}`) : null].filter(Boolean));
  }
  render() {
    if (!this.renderer || !this.att) return;
    const a = this.att, top = this.cfg.view === 'alto', rad = Math.PI / 180;
    // heel positivo = sbanda a dritta (il lato x+ scende); trim positivo = prua (z-) su
    this.boat.rotation.z = -(isFinite(a.heel) ? a.heel : 0) * a.g * rad;
    this.boat.rotation.x = (isFinite(a.pitch) ? a.pitch : 0) * a.g * rad;
    this.boat.rotation.y = top && isFinite(a.hdg) ? -a.hdg * rad : 0;
    // griglia: si sposta all'indietro rispetto alla barca (dall'alto: nella direzione opposta alla prua)
    const cell = 2, m = x => ((x % cell) + cell) % cell;
    if (top && isFinite(a.hdg)) { this.grid.position.x = -m(Math.sin(a.hdg * rad) * this.dist); this.grid.position.z = m(Math.cos(a.hdg * rad) * this.dist); }
    else { this.grid.position.x = 0; this.grid.position.z = m(this.dist); }
    // vento (solo dall'alto, nord in alto): la freccia va nella direzione in cui soffia
    const w = top && this.S.wind ? this.S.twdAt(this.V.t) : NaN;
    this.wind.visible = isFinite(w);
    if (isFinite(w)) { this.wind.rotation.y = -w * rad; this.wind.position.set(Math.sin(w * rad) * 3.6, 0.05, -Math.cos(w * rad) * 3.6); }
    this.renderer.render(this.scene, this.cam);
  }
  resize() {
    if (!this.renderer) return;
    const r = this.el.getBoundingClientRect(), w = Math.max(80, r.width), hh = Math.max(60, r.height);
    this.renderer.setSize(w, hh, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.cam.aspect = w / hh; this.cam.updateProjectionMatrix();
    this.render();
  }
  destroy() { if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss && this.renderer.forceContextLoss(); } }
}
PANEL_TYPES.boat3d = { label: 'Nacra 17 in 3D', icon: '⛵' };
PANEL_CLASSES.boat3d = Boat3DPanel;
