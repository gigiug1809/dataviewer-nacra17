/* Pannello NACRA 17 IN 3D: la barca si muove come quella vera (heel, trim, prua) secondo i dati.
   Scafi, traverse, trampolino, bompresso con sacca del gennaker, derive a Z/J e timoni a T con le misure di classe. Niente albero.
   Viste: da poppa, di lato, 3/4, dall'alto (col vento); trascinando si gira attorno, la rotella avvicina.
   three.js (lib/three.module.min.js) si carica solo quando serve. */
'use strict';

let THREE_LOAD = null;
function loadThree() { return THREE_LOAD || (THREE_LOAD = import(new URL('lib/three.module.min.js', document.baseURI).href)); }

/* misure del Nacra 17 (metri), dalla classe e dalla guida di setup (documento "La fisica del Nacra 17") e dalle foto:
   lunghezza 5,25, larghezza 2,59, assi degli scafi a 2178 mm; traversa anteriore col piede d'albero circa a metà barca;
   derive a Z/J: fusto verticale 721 mm, gomito di raggio ≈ 0,4 m, tratto inclinato ≈ 750 mm che scende a 50°
   verso il centro barca, punta ≈ 66 cm dentro l'asse dello scafo; timoni ≈ 2,4 m dietro le derive, elevatore ≈ 42 cm. */
const N17 = { L: 5.25, B: 2.59, hx: 1.089, hw: 0.18, deck: 0.17 };
N17.zFront = -0.08;              // traversa anteriore (piede d'albero)
N17.zRear = N17.L / 2 - 0.28;    // traversa posteriore
N17.zBoard = 0.3;                // derive, appena dietro la traversa anteriore
N17.zRudder = N17.L / 2 + 0.08;  // timoni, appesi allo specchio di poppa

// viste di lato e da poppa basse, quasi all'altezza del trampolino; [posizione, punto guardato (y)]
const VIEWS3D = { poppa: [0, 0.32, 6.8], lato: [7.4, 0.3, 0], tre: [5.2, 2.8, 5.8], alto: [0, 12, 0.01] };
const VIEW_TARGET_Y = { poppa: 0.05, lato: 0.05, tre: -0.3, alto: 0, libera: -0.2 };
// l'acqua è solo un riferimento: non conosciamo l'altezza di volo, quindi sta ben sotto scafi e derive
const WATER_Y = -1.9;

/* forma dello scafo a una stazione u (0 = prua, 1 = poppa): mezza larghezza, coperta, chiglia */
function hullStation(u) {
  const W = N17.hw;
  const w = u < 0.45 ? W * Math.pow(1 - Math.pow(1 - u / 0.45, 2.2), 0.6) : u < 0.86 ? W : W * (1 - 0.1 * (u - 0.86) / 0.14);
  // coperta quasi dritta; in punta si abbassa un poco (spigolo di prua arrotondato, come sulla barca vera)
  const deck = N17.deck + 0.025 * (1 - u) * (1 - u) - (u < 0.04 ? 0.06 * Math.pow(1 - u / 0.04, 2) : 0);
  const keel = u <= 0.7 ? -0.3 - 0.06 * Math.sin(Math.PI * u / 1.4) : -0.36 + 0.14 * Math.pow((u - 0.7) / 0.3, 1.6);
  return { w, deck, keel };
}
/* scafo chiuso: ogni sezione è un anello (coperta bombata, spalla arrotondata, fianchi che stringono a V fino alla chiglia) */
function hullGeometry(T) {
  const NS = 64, NSIDE = 14, L = N17.L, pos = [], idx = [];
  const ring = u => {
    const { w, deck, keel } = hullStation(u), sh = deck - 0.025, half = [];
    // coperta quasi piatta, spigolo appena arrotondato, fianchi quasi verticali in alto, fondo a V arrotondata
    half.push([0, deck + 0.018], [0.5 * w, deck + 0.016], [0.88 * w, deck + 0.008], [0.98 * w, deck - 0.006], [w, sh]);
    for (let j = 1; j <= NSIDE; j++) { const s = j / NSIDE; half.push([w * Math.pow(Math.max(0, 1 - Math.pow(s, 2.6)), 0.6), sh - (sh - keel) * s]); }
    const full = half.slice();                                   // da coperta (centro) a chiglia, lato dritta
    for (let j = half.length - 2; j >= 1; j--) full.push([-half[j][0], half[j][1]]);   // e risalendo dal lato sinistra
    return full;
  };
  const R = ring(0.5).length;
  for (let i = 0; i <= NS; i++) { const u = i / NS, z = -L / 2 + u * L; for (const [x, y] of ring(u)) pos.push(x, y, z); }
  for (let i = 0; i < NS; i++) for (let j = 0; j < R; j++) {
    const a = i * R + j, b = i * R + (j + 1) % R, c = a + R, e = b + R;
    idx.push(a, c, b, b, c, e);
  }
  // specchio di poppa (piatto)
  const ctr = pos.length / 3, st = hullStation(1); pos.push(0, (st.deck + st.keel) / 2, L / 2);
  for (let j = 0; j < R; j++) idx.push(ctr, NS * R + (j + 1) % R, NS * R + j);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/* lama con sezione a profilo (ellisse affusolata) lungo una curva: corda lungo z, spessore perpendicolare alla curva */
function bladeGeometry(T, pts, chord, thick, tipChord = 0.7, opt = {}) {
  const curve = new T.CatmullRomCurve3(pts.map(p => new T.Vector3(...p)), false, 'centripetal'), N = 60, M = 12, pos = [], idx = [];
  const Z = new T.Vector3(0, 0, 1);
  for (let i = 0; i <= N; i++) {
    const u = i / N, p = curve.getPointAt(u), tg = curve.getTangentAt(u);
    let n = new T.Vector3().crossVectors(tg, Z); if (n.lengthSq() < 1e-6) n.set(1, 0, 0); n.normalize();
    const c = chord * (1 - (1 - tipChord) * u), t = thick * (1 - 0.35 * u);
    for (let k = 0; k < M; k++) {
      const f = k / M * Math.PI * 2, x = Math.cos(f);              // x: da -1 (bordo d'uscita) a 1 (bordo d'attacco)
      const th = t / 2 * Math.sin(f) * (x > 0 ? 1 : 0.55 + 0.45 * (1 + x)); // più spessa davanti, sottile dietro
      const zc = -c * (x > 0 ? 0.35 * x : 0.65 * x);                // bordo d'attacco verso prua (z negativo)
      pos.push(p.x + n.x * th, p.y + n.y * th, p.z + zc + (opt.rake || 0) * (p.y - pts[0][1]));
    }
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < M; k++) {
    const a = i * M + k, b = i * M + (k + 1) % M, c = a + M, d = b + M;
    idx.push(a, c, b, b, c, d);
  }
  // estremità chiuse
  const tip = pos.length / 3, last = curve.getPointAt(1); pos.push(last.x, last.y, last.z);
  for (let k = 0; k < M; k++) idx.push(tip, N * M + k, N * M + (k + 1) % M);
  const root = pos.length / 3, first = curve.getPointAt(0); pos.push(first.x, first.y, first.z);
  for (let k = 0; k < M; k++) idx.push(root, (k + 1) % M, k);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/* percorso della deriva nel piano trasversale: fusto, gomito, tratto inclinato a 50° verso il centro, punta */
function boardPath(s) {
  const x0 = s * N17.hx, top = N17.deck + 0.12, ye = top - 0.721, r = 0.4, pts = [];
  for (let y = top; y > ye; y -= 0.12) pts.push([x0, y, N17.zBoard]);
  for (let a = 0; a <= 40; a += 8) { const t = a * Math.PI / 180; pts.push([x0 - s * r * (1 - Math.cos(t)), ye - r * Math.sin(t), N17.zBoard]); }
  const [ex, ey] = pts[pts.length - 1], dir = 50 * Math.PI / 180;
  for (let l = 0.15; l <= 0.75; l += 0.15) pts.push([ex - s * l * Math.cos(dir), ey - l * Math.sin(dir), N17.zBoard]);
  const [ix, iy] = pts[pts.length - 1];
  pts.push([ix - s * 0.07, iy - 0.045, N17.zBoard], [ix - s * 0.13, iy - 0.06, N17.zBoard]);
  return pts;
}
function buildNacra(T) {
  const boat = new T.Group();
  const white = new T.MeshStandardMaterial({ color: 0xf5f7f9, roughness: 0.38, metalness: 0.04, side: T.DoubleSide });
  const nonslip = new T.MeshStandardMaterial({ color: 0xb9bfc6, roughness: 0.85 });
  const carbon = new T.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.32, metalness: 0.35, side: T.DoubleSide });
  const blue = new T.MeshStandardMaterial({ color: 0x1f4fa8, roughness: 0.5 });
  const net = new T.MeshStandardMaterial({ color: 0x23272d, roughness: 0.9, transparent: true, opacity: 0.9, side: T.DoubleSide });
  const hull = hullGeometry(T);
  for (const s of [1, -1]) {
    const hg = new T.Group(); hg.position.x = s * N17.hx;
    hg.add(new T.Mesh(hull, white));
    // coperta antiscivolo grigia (sulla parte centrale e di poppa)
    const pad = new T.Mesh(new T.BoxGeometry(N17.hw * 1.15, 0.006, N17.L * 0.6), nonslip);
    pad.position.set(0, N17.deck + 0.031, 0.75); hg.add(pad);
    // grafica blu sul fianco esterno (aiuta a vedere il beccheggio)
    const st = new T.Mesh(new T.BoxGeometry(0.008, 0.05, N17.L * 0.36), blue);
    st.position.set(s * (N17.hw + 0.001), N17.deck - 0.07, 0.1); hg.add(st);
    boat.add(hg);
    // deriva a Z/J
    boat.add(new T.Mesh(bladeGeometry(T, boardPath(s), 0.2, 0.034, 0.72), carbon));
    // timone a T: pala, testa con barra, elevatore
    const xr = s * N17.hx, zr = N17.zRudder, yTop = N17.deck + 0.14, yBot = -0.98;
    boat.add(new T.Mesh(bladeGeometry(T, [[xr, yTop, zr], [xr, (yTop + yBot) / 2, zr - 0.01], [xr, yBot, zr - 0.02]], 0.17, 0.03, 0.82), carbon));
    boat.add(new T.Mesh(bladeGeometry(T, [[xr - 0.21, yBot, zr - 0.02], [xr, yBot - 0.005, zr - 0.02], [xr + 0.21, yBot, zr - 0.02]], 0.16, 0.022, 1), carbon));
    const head = new T.Mesh(new T.BoxGeometry(0.06, 0.12, 0.2), carbon); head.position.set(xr, yTop + 0.02, zr - 0.02); boat.add(head);
    const arm = new T.Mesh(new T.CylinderGeometry(0.014, 0.014, 0.5, 8), carbon); arm.rotation.x = Math.PI / 2; arm.position.set(xr, yTop + 0.05, zr - 0.3); boat.add(arm);
  }
  // barra che unisce i timoni
  const tb = new T.Mesh(new T.CylinderGeometry(0.013, 0.013, N17.hx * 2, 8), carbon); tb.rotation.z = Math.PI / 2; tb.position.set(0, N17.deck + 0.19, N17.zRudder - 0.55); boat.add(tb);
  // traverse: anteriore più grossa (porta l'albero), posteriore sottile
  const beam = (z, r, y) => { const m = new T.Mesh(new T.CylinderGeometry(r, r, N17.hx * 2, 20), carbon); m.rotation.z = Math.PI / 2; m.position.set(0, y, z); return m; };
  boat.add(beam(N17.zFront, 0.07, N17.deck + 0.07), beam(N17.zRear, 0.045, N17.deck + 0.05));
  // trampolino tra i fianchi interni
  const tw = (N17.hx - N17.hw * 0.95) * 2, tl = N17.zRear - N17.zFront;
  const tramp = new T.Mesh(new T.PlaneGeometry(tw, tl), net);
  tramp.rotation.x = -Math.PI / 2; tramp.position.set(0, N17.deck + 0.06, (N17.zFront + N17.zRear) / 2); boat.add(tramp);
  // piede d'albero
  const mf = new T.Mesh(new T.CylinderGeometry(0.05, 0.08, 0.16, 14), carbon); mf.position.set(0, N17.deck + 0.17, N17.zFront); boat.add(mf);
  // bompresso: dalla traversa anteriore fino a ~0,75 m oltre le prue, un po' in discesa
  const sp = new T.Vector3(0, N17.deck + 0.1, N17.zFront), ep = new T.Vector3(0, N17.deck + 0.02, -N17.L / 2 - 0.75);
  const bs = new T.Mesh(new T.CylinderGeometry(0.022, 0.034, sp.distanceTo(ep), 10), carbon);
  bs.position.copy(sp).add(ep).multiplyScalar(0.5); bs.lookAt(ep); bs.rotateX(Math.PI / 2); boat.add(bs);
  // sacca del gennaker sotto il bompresso
  const c0 = new T.Vector3(0, N17.deck + 0.02, N17.zFront - 0.25), c1 = new T.Vector3(0, N17.deck - 0.02, -N17.L / 2 + 0.55);
  const chute = new T.Mesh(new T.CylinderGeometry(0.06, 0.13, c0.distanceTo(c1), 14, 1, true), net);
  chute.position.copy(c0).add(c1).multiplyScalar(0.5); chute.lookAt(c1); chute.rotateX(Math.PI / 2); boat.add(chute);
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
    const water = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshStandardMaterial({ color: dark ? 0x1d4e6e : 0x3b7fae, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false }));
    water.rotation.x = -Math.PI / 2; water.position.y = WATER_Y; sc.add(water);
    this.grid = new T.GridHelper(120, 60, dark ? 0x5d8bab : 0xe6f1fa, dark ? 0x3a6a8a : 0xbcd6ea); this.grid.position.y = WATER_Y + 0.002;
    this.grid.material.transparent = true; this.grid.material.opacity = 0.28; this.grid.material.depthWrite = false; sc.add(this.grid);
    this.boat = buildNacra(T); this.boat.rotation.order = 'YXZ'; sc.add(this.boat);
    this.wind = windArrow(T); this.wind.position.y = WATER_Y + 0.05; this.wind.visible = false; sc.add(this.wind);
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
    this.cam.position.set(...p); this.cam.lookAt(0, VIEW_TARGET_Y[this.cfg.view] ?? -0.2, 0);
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
    if (isFinite(w)) { this.wind.rotation.y = -w * rad; this.wind.position.set(Math.sin(w * rad) * 3.6, WATER_Y + 0.05, -Math.cos(w * rad) * 3.6); }
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
