/* Pannello NACRA 17 IN 3D: la barca si muove come quella vera (heel, trim, prua) secondo i dati.
   Scafi, traverse, trampolino, derive a Z/J e timoni a T su gantry, con misure di classe e dalle foto. Niente albero.
   Viste: da poppa, di lato, 3/4, dall'alto (col vento); trascinando si gira attorno, la rotella avvicina.
   three.js (lib/three.module.min.js) si carica solo quando serve. */
'use strict';

let THREE_LOAD = null;
function loadThree() { return THREE_LOAD || (THREE_LOAD = import(new URL('lib/three.module.min.js', document.baseURI).href)); }

/* misure del Nacra 17 (metri), da classe, guida di setup, documento "La fisica del Nacra 17" e foto di ITA98:
   - lunghezza 5,25; assi degli scafi a 2178 mm (prue) e 2192 mm (specchi); scafo largo 0,40 m (tesi Chalmers);
   - altezza dello scafo (dalla foto di lato scalata sui 5,25 m): circa 0,38 m a prua, 0,55 m al centro, 0,42 m a poppa;
   - linee molto fini a prua con una V e uno spigolo (rail) che sparisce a metà barca; specchio con spigolo vivo;
   - albero e traversa anteriore a metà lunghezza, derive al 58% dalla prua, timoni su gantry dietro lo specchio;
   - derive a Z/J (sagome di classe): fusto 721 mm, gomito r ≈ 0,4 m, tratto inclinato ≈ 750 mm a 50° verso il centro,
     punta ≈ 66 cm dentro l'asse; spessore ≈ 25 mm (imbocco della scassa 25,01 mm);
   - cuscinetti bassi dei timoni a 2264 mm; elevatore ≈ 40 cm di apertura per 20 cm di corda. */
const N17 = { L: 5.25, hx: 1.089, hw: 0.2, deck: 0.19 };
N17.zFront = -0.02;              // traversa anteriore (piede d'albero), a metà barca
N17.zRear = N17.L / 2 - 0.3;     // traversa posteriore, vicino agli specchi
N17.zBoard = -N17.L / 2 + 0.578 * N17.L;   // derive: 58% della lunghezza dalla prua
N17.zRudder = N17.L / 2 + 0.11;  // asse dei timoni, dietro lo specchio
N17.xRudder = 2.264 / 2;         // i timoni stanno un poco fuori dall'asse degli scafi

// viste di lato e da poppa basse, quasi all'altezza del trampolino; [posizione, punto guardato (y)]
// obiettivo "da fotografo" (angolo stretto, da lontano): la barca si vede come nelle foto, senza deformazioni
const VIEWS3D = { poppa: [0, 0.4, 9.8], lato: [10.6, 0.35, 0], tre: [7.3, 3.7, 8.2], alto: [0, 16.5, 0.01] };
const CAM_FOV = 24;
const VIEW_TARGET_Y = { poppa: 0.05, lato: 0.05, tre: -0.3, alto: 0, libera: -0.2 };
// l'acqua è solo un riferimento: non conosciamo l'altezza di volo, quindi sta ben sotto scafi e derive
const WATER_Y = -1.9;

/* forma dello scafo alla stazione u (0 = prua, 1 = poppa) */
function hullStation(u) {
  const W = N17.hw;
  // pianta: linee fini a prua, piena larghezza da metà barca, specchio appena più stretto
  const w = u < 0.55 ? W * Math.pow(1 - Math.pow(1 - u / 0.55, 2.4), 0.55) : u < 0.9 ? W : W * (1 - 0.06 * (u - 0.9) / 0.1);
  // coperta quasi dritta, che in punta si arrotonda verso il basso
  const deck = N17.deck + 0.015 * (1 - u) - (u < 0.035 ? 0.05 * Math.pow(1 - u / 0.035, 2) : 0);
  // chiglia: quasi piena altezza fino a prua (dalla foto di lato), con il naso arrotondato solo nell'ultimo 6%;
  // più profonda a ~45%, poi risale verso lo specchio (0,42 m di altezza a poppa)
  const keel = (u < 0.45 ? -0.36 + 0.06 * Math.pow(1 - u / 0.45, 1.5) : -0.36 + 0.13 * Math.pow((u - 0.45) / 0.55, 1.8))
    + (u < 0.06 ? 0.13 * Math.pow(1 - u / 0.06, 2) : 0);
  // fondo: a V a prua (esponente basso), a U al centro, più piatto a poppa
  const n = u < 0.12 ? 1.45 + 4.6 * u : u < 0.5 ? 2.0 + 0.3 * ((u - 0.12) / 0.38) : 2.3 + 0.9 * ((u - 0.5) / 0.5);
  // fianco verticale: corto a prua (fino allo spigolo), lungo dal centro a poppa
  const side = u < 0.5 ? 0.1 + 0.16 * (u / 0.5) : 0.26;
  // spigolo (rail) a prua: sotto, lo scafo rientra; sparisce a metà barca
  const rail = u < 0.5 ? 0.06 * (1 - u / 0.5) : 0;
  return { w, deck, keel, n, rail, side };
}
/* scafo: anelli di sezioni (coperta bombata, spalla arrotondata, fianco con spigolo a prua, fondo a V/U) */
function hullGeometry(T) {
  const NS = 90, NB = 16, L = N17.L, pos = [], idx = [];
  const half = u => {
    const { w, deck, keel, n, rail, side } = hullStation(u), out = [];
    const yc = Math.max(keel + 0.05, deck - side);   // fine del fianco verticale (a prua: lo spigolo)
    const wc = w * (1 - rail);                    // sotto lo spigolo lo scafo rientra
    // coperta piatta con spigolo stretto, fianco verticale
    out.push([0, deck + 0.012], [0.6 * w, deck + 0.01], [0.9 * w, deck + 0.004], [0.985 * w, deck - 0.006], [w, deck - 0.022]);
    out.push([w, deck - 0.022 - (deck - 0.022 - yc) * 0.5], [w - (w - wc) * 0.6, yc + 0.012], [wc, yc]);
    for (let j = 1; j <= NB; j++) {                                          // dallo spigolo alla chiglia (superellisse)
      const th = j / NB * Math.PI / 2;
      out.push([wc * Math.pow(Math.cos(th), 2 / n), yc - (yc - keel) * Math.pow(Math.sin(th), 2 / n)]);
    }
    return out;
  };
  const ring = u => { const hf = half(u), full = hf.slice(); for (let j = hf.length - 2; j >= 1; j--) full.push([-hf[j][0], hf[j][1]]); return full; };
  const R = ring(0.5).length;
  for (let i = 0; i <= NS; i++) {
    // più sezioni verso prua, dove la forma cambia di più
    const u = Math.pow(i / NS, 1.35), z = -L / 2 + u * L;
    for (const [x, y] of ring(u)) pos.push(x, y, z);
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < R; j++) {
    const a = i * R + j, b = i * R + (j + 1) % R, c = a + R, e = b + R;
    idx.push(a, c, b, b, c, e);
  }
  // specchio di poppa piatto (spigolo vivo con lo scafo): vertici suoi, così la luce lo stacca dai fianchi
  const st = ring(1), base = pos.length / 3;
  for (const [x, y] of st) pos.push(x, y, L / 2);
  const ctr = pos.length / 3, h1 = hullStation(1); pos.push(0, (h1.deck + h1.keel) / 2, L / 2);
  for (let j = 0; j < R; j++) idx.push(ctr, base + (j + 1) % R, base + j);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/* spessore del profilo NACA 00xx (simmetrico) alla frazione x della corda */
function nacaThick(x, t) { return 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4); }
/* lama con profilo NACA lungo una curva: corda lungo z (bordo d'attacco verso prua), spessore perpendicolare alla curva.
   chord(u): corda lungo la lama (u da 0 a 1); le estremità si arrotondano. */
function bladeGeometry(T, pts, { chord, t = 0.1, stack = 0.3, roundStart = 0, roundEnd = 0.06, N = 70 } = {}) {
  const curve = new T.CatmullRomCurve3(pts.map(p => new T.Vector3(...p)), false, 'centripetal'), K = 14, pos = [], idx = [];
  const Z = new T.Vector3(0, 0, 1), xs = [];
  for (let k = 0; k <= K; k++) xs.push((1 - Math.cos(k / K * Math.PI)) / 2);       // più punti vicino ai bordi
  const ringN = 2 * K;
  for (let i = 0; i <= N; i++) {
    const u = i / N, p = curve.getPointAt(u), tg = curve.getTangentAt(u);
    let n = new T.Vector3().crossVectors(tg, Z); if (n.lengthSq() < 1e-6) n.set(1, 0, 0); n.normalize();
    let c = chord(u);
    if (roundEnd && u > 1 - roundEnd) c *= Math.sqrt(Math.max(0.02, 1 - ((u - 1 + roundEnd) / roundEnd) ** 2));
    if (roundStart && u < roundStart) c *= Math.sqrt(Math.max(0.02, 1 - ((roundStart - u) / roundStart) ** 2));
    const z0 = p.z - stack * c;                                                    // bordo d'attacco
    for (let k = 0; k < ringN; k++) {
      const upper = k <= K, x = upper ? xs[k] : xs[2 * K - k], side = upper ? 1 : -1;
      const th = nacaThick(x, t) * c * side;
      pos.push(p.x + n.x * th, p.y + n.y * th, z0 + x * c);
    }
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < ringN; k++) {
    const a = i * ringN + k, b = i * ringN + (k + 1) % ringN, c = a + ringN, d = b + ringN;
    idx.push(a, c, b, b, c, d);
  }
  const cap = (ri, flip) => { let cx = 0, cy = 0, cz = 0; for (let k = 0; k < ringN; k++) { cx += pos[(ri + k) * 3]; cy += pos[(ri + k) * 3 + 1]; cz += pos[(ri + k) * 3 + 2]; } const ci = pos.length / 3; pos.push(cx / ringN, cy / ringN, cz / ringN); for (let k = 0; k < ringN; k++) { const a = ri + k, b = ri + (k + 1) % ringN; if (flip) idx.push(ci, b, a); else idx.push(ci, a, b); } };
  cap(0, true); cap(N * ringN, false);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/* deriva a Z/J nel piano trasversale: fusto verticale, gomito, tratto inclinato a 50° verso il centro, punta */
function boardPath(s) {
  const x0 = s * N17.hx, top = N17.deck + 0.09, ye = top - 0.721, r = 0.4, pts = [];
  for (let y = top; y > ye + 1e-6; y -= 0.1) pts.push([x0, y, N17.zBoard]);
  pts.push([x0, ye, N17.zBoard]);
  for (let a = 6; a <= 40; a += 6.8) { const t = a * Math.PI / 180; pts.push([x0 - s * r * (1 - Math.cos(t)), ye - r * Math.sin(t), N17.zBoard]); }
  const [ex, ey] = pts[pts.length - 1], dir = 50 * Math.PI / 180;
  for (let l = 0.125; l <= 0.75 + 1e-6; l += 0.125) pts.push([ex - s * l * Math.cos(dir), ey - l * Math.sin(dir), N17.zBoard]);
  const [ix, iy] = pts[pts.length - 1];
  pts.push([ix - s * 0.06, iy - 0.05, N17.zBoard], [ix - s * 0.12, iy - 0.075, N17.zBoard]);   // punta che si appiattisce
  return pts;
}
/* ambiente per i riflessi (cielo chiaro, mare scuro, due pannelli di luce): gelcoat e carbonio lucidi */
function studioEnv(T, renderer) {
  const sc = new T.Scene(), geo = new T.SphereGeometry(50, 32, 16), col = [];
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i) / 50, c = y > 0 ? new T.Color(0xdfeaf4).lerp(new T.Color(0x8fb6d8), y) : new T.Color(0x3a4a58).lerp(new T.Color(0x0d1620), -y); col.push(c.r, c.g, c.b); }
  geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  sc.add(new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
  for (const [x, y, z, w, hh] of [[-20, 25, 10, 30, 12], [25, 15, -15, 18, 10]]) { const m = new T.Mesh(new T.PlaneGeometry(w, hh), new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); sc.add(m); }
  const pm = new T.PMREMGenerator(renderer), env = pm.fromScene(sc, 0.04).texture;
  pm.dispose();
  return env;
}
function buildNacra(T) {
  const boat = new T.Group();
  const gel = new T.MeshPhysicalMaterial({ color: 0xf7f8fa, roughness: 0.3, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.12, side: T.DoubleSide });
  const pad = new T.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.75, metalness: 0.1 });
  const carbon = new T.MeshPhysicalMaterial({ color: 0x14161a, roughness: 0.28, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.06, side: T.DoubleSide });
  const black = new T.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.55, metalness: 0.2 });
  const net = new T.MeshStandardMaterial({ color: 0x1f2328, roughness: 0.9, transparent: true, opacity: 0.92, side: T.DoubleSide });
  const hull = hullGeometry(T);
  for (const s of [1, -1]) {
    const hg = new T.Group(); hg.position.x = s * N17.hx;
    hg.add(new T.Mesh(hull, gel));
    // antiscivolo scuro sulla coperta di poppa (come sulla barca)
    for (const [z0, z1] of [[0.62, 0.975]]) {
      const za = -N17.L / 2 + z0 * N17.L, zb = -N17.L / 2 + z1 * N17.L;
      const m = new T.Mesh(new T.BoxGeometry(N17.hw * 1.5, 0.006, zb - za), pad); m.position.set(0, N17.deck + 0.025, (za + zb) / 2); hg.add(m);
    }
    boat.add(hg);
    // deriva a Z/J: corda 25 cm sul fusto, 17 cm in punta, profilo NACA 0010 (≈ 25 mm di spessore)
    boat.add(new T.Mesh(bladeGeometry(T, boardPath(s), { chord: u => 0.25 - 0.08 * Math.pow(u, 1.3), t: 0.1, stack: 0.35, roundEnd: 0.05 }), carbon));
    // timone a T su gantry dietro lo specchio
    const xr = s * N17.xRudder, zr = N17.zRudder, yTop = N17.deck + 0.1, yBot = -1.02;
    boat.add(new T.Mesh(bladeGeometry(T, [[xr, yTop, zr], [xr, (yTop + yBot) / 2, zr + 0.005], [xr, yBot, zr + 0.01]], { chord: u => 0.19 - 0.025 * u, t: 0.11, stack: 0.3, roundEnd: 0 }), carbon));
    boat.add(new T.Mesh(bladeGeometry(T, [[xr - 0.2, yBot + 0.004, zr - 0.02], [xr, yBot, zr - 0.02], [xr + 0.2, yBot + 0.004, zr - 0.02]], { chord: u => 0.2 * (1 - 0.35 * Math.pow(Math.abs(2 * u - 1), 2)), t: 0.1, stack: 0.3, roundStart: 0.08, roundEnd: 0.08 }), carbon));
    // gantry: due scatole dei cuscinetti (≈ 30 cm tra loro) attaccate allo specchio, con la piastra
    const gz = N17.L / 2 + 0.06;
    for (const y of [N17.deck + 0.03, N17.deck - 0.27]) { const b = new T.Mesh(new T.BoxGeometry(0.07, 0.07, 0.16), black); b.position.set(xr, y, gz + 0.02); boat.add(b); }
    const plate = new T.Mesh(new T.BoxGeometry(0.05, 0.36, 0.05), black); plate.position.set(s * (N17.hx + 0.02), N17.deck - 0.12, N17.L / 2 + 0.02); boat.add(plate);
    // testa del timone e barra verso prua
    const head = new T.Mesh(new T.BoxGeometry(0.05, 0.09, 0.14), black); head.position.set(xr, yTop + 0.03, zr); boat.add(head);
    const arm = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 0.55, 10), carbon); arm.rotation.x = Math.PI / 2; arm.position.set(xr, yTop + 0.06, zr - 0.3); boat.add(arm);
  }
  // barra che unisce i timoni
  const tb = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, N17.xRudder * 2, 10), carbon); tb.rotation.z = Math.PI / 2; tb.position.set(0, N17.deck + 0.16, N17.zRudder - 0.58); boat.add(tb);
  // traverse in carbonio: anteriore a profilo (porta l'albero), posteriore tonda
  const front = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, N17.hx * 2, 24), carbon); front.scale.set(1, 1, 0.75); front.rotation.z = Math.PI / 2; front.position.set(0, N17.deck + 0.08, N17.zFront); boat.add(front);
  const rear = new T.Mesh(new T.CylinderGeometry(0.045, 0.045, N17.hx * 2, 20), carbon); rear.rotation.z = Math.PI / 2; rear.position.set(0, N17.deck + 0.05, N17.zRear); boat.add(rear);
  // trampolino tra i fianchi interni
  const tw = (N17.hx - N17.hw * 0.92) * 2, tl = N17.zRear - N17.zFront - 0.05;
  const tramp = new T.Mesh(new T.PlaneGeometry(tw, tl), net);
  tramp.rotation.x = -Math.PI / 2; tramp.position.set(0, N17.deck + 0.06, (N17.zFront + N17.zRear) / 2); boat.add(tramp);
  // piede d'albero (senza albero)
  const mf = new T.Mesh(new T.CylinderGeometry(0.045, 0.07, 0.14, 16), carbon); mf.position.set(0, N17.deck + 0.18, N17.zFront); boat.add(mf);
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
    sc.background = new T.Color(bg); sc.fog = new T.Fog(bg, 35, 140);
    r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    try { sc.environment = studioEnv(T, r); } catch (e) { /* senza riflessi */ }
    // luce dall'alto e poca luce da sotto: il fondo degli scafi resta in ombra, come nelle foto
    sc.add(new T.HemisphereLight(0xffffff, dark ? 0x1a2430 : 0x3c4c5a, dark ? 0.55 : 0.7));
    const sun = new T.DirectionalLight(0xffffff, 2.2); sun.position.set(-5, 12, -4); sc.add(sun);
    const fill = new T.DirectionalLight(0xdfe8f2, 0.6); fill.position.set(6, 4, 8); sc.add(fill);
    // acqua: piano semitrasparente (si vedono le derive sotto) e griglia che scorre alla velocità della barca
    const water = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshStandardMaterial({ color: dark ? 0x1d4e6e : 0x3b7fae, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false }));
    water.rotation.x = -Math.PI / 2; water.position.y = WATER_Y; sc.add(water);
    this.grid = new T.GridHelper(120, 60, dark ? 0x5d8bab : 0xe6f1fa, dark ? 0x3a6a8a : 0xbcd6ea); this.grid.position.y = WATER_Y + 0.002;
    this.grid.material.transparent = true; this.grid.material.opacity = 0.28; this.grid.material.depthWrite = false; sc.add(this.grid);
    this.boat = buildNacra(T); this.boat.rotation.order = 'YXZ'; sc.add(this.boat);
    this.wind = windArrow(T); this.wind.position.y = WATER_Y + 0.05; this.wind.visible = false; sc.add(this.wind);
    this.cam = new T.PerspectiveCamera(CAM_FOV, 1, 0.1, 400);
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
    c.addEventListener('wheel', e => { e.preventDefault(); const o = this.orbitNow(); this.orbit = Object.assign(o, { r: clamp(o.r * (e.deltaY > 0 ? 1.1 : 0.9), 6, 60) }); this.cfg.view = 'libera'; if (this.viewSel) this.viewSel.value = 'libera'; this.placeCamera(); this.render(); }, { passive: false });
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
