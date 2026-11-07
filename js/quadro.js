/* Quadro live per il tablet (gommone o terra): pochi riquadri, numeri grandi, divisi per tipo.
   - Stato barca: sbandamento e trim
   - Conduzione: velocità, rotta (COG) e timone (dalla rotazione della barca)
   Ogni riquadro: valore di adesso, andamento dell'ultimo minuto, medie su 10 s e 30 s (e del tratto in corso).
   Si ricalcola una volta al secondo: valori stabili e leggibili. */
'use strict';


const Quadro = {
  S: null,
  timer: null,

  open(code) {
    this.close();
    Viewer.close();
    const root = $('#view-viewer');
    root.textContent = '';
    const S = this.S = new LiveSession(code, LS.get('liveServer', {}));
    LS.set('liveView', 'quadro');
    S.connect();
    S.onStatus = () => this.renderTop();
    this.damp = LS.get('quadroDamp', 3);
    this.scale = LS.get('quadroScale', 1);
    this.build(root);
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.onResize = () => { this.sized = false; this.tick(); };
    window.addEventListener('resize', this.onResize);
    window.addEventListener('themechange', this.onResize);
  },
  close() {
    if (!this.S) return;
    clearInterval(this.timer); this.timer = null;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('themechange', this.onResize);
    this.S.save(); this.S.dispose();
    this.S = null;
    $('#view-viewer').textContent = '';
  },

  /* ---------- struttura ---------- */
  build(root) {
    const tile = (key, name, hint) => {
      const t = { key, el: null, big: h('div', { class: 'qd-big num' }, '—'), unit: h('span', { class: 'qd-unit' }), side: h('div', { class: 'qd-side' }), cv: h('canvas', { class: 'qd-spark' }), tbl: h('table', { class: 'qd-tbl num' }) };
      t.el = h('section', { class: 'qd-tile' },
        h('div', { class: 'qd-th' }, h('h3', null, name), h('span', { class: 'qd-hint' }, hint)),
        h('div', { class: 'qd-now' }, t.big, t.unit, t.side),
        t.cv, t.tbl);
      return t;
    };
    this.tiles = {
      heel: tile('heel', 'Sbandamento', '+ = sbandata a dritta'),
      pitch: tile('pitch', 'Trim', '+ = prua in alto'),
      sog: tile('sog', 'Velocità', 'GPS del telefono'),
      cog: tile('cog', 'Rotta (COG)', 'quanto varia la rotta'),
      steer: tile('steer', 'Timone', 'quanto e quanto forte si corregge')
    };
    this.top = h('div', { class: 'qd-top' });
    this.banner = h('div', { class: 'qd-banner', hidden: true });
    this.wrap = h('div', { class: 'qd-groups' },
      h('div', { class: 'qd-group' }, h('div', { class: 'qd-gh' }, 'Stato barca'), h('div', { class: 'qd-row two' }, this.tiles.heel.el, this.tiles.pitch.el)),
      h('div', { class: 'qd-group' }, h('div', { class: 'qd-gh' }, 'Conduzione'), h('div', { class: 'qd-row three' }, this.tiles.sog.el, this.tiles.cog.el, this.tiles.steer.el)));
    root.append(h('div', { class: 'qd' }, this.top, this.banner, this.wrap,
      h('div', { class: 'qd-foot' }, 'Valori in grigio: in quella finestra è arrivato meno dell\'80% dei dati, non sono affidabili. Il timone non ha un sensore: si misura dalla rotazione della barca (giroscopio del telefono). Correzioni = rotazioni oltre ' + TURN_DPS + ' °/s.')));
    this.renderTop();
    this.applyScale();
  },

  /* barra in alto: stato del collegamento, tratto, cambio vista */
  renderTop() {
    const S = this.S;
    if (!S || !this.top) return;
    if (this.top.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // menu aperto: non lo chiudo
    const st = Live.statusInfo(S);
    const open = S.meta.events.find(e => e.type === 'tratto' && e.t2 == null);
    const last = [...S.meta.events].reverse().find(e => e.type === 'tratto' && e.t2 != null);
    this.top.textContent = '';
    this.top.append(...[
      h('button', { class: 'btn ghost', title: 'Torna alla pagina del codice barca', onclick: () => Router.go('#/live') }, '←'),
      h('span', { class: 'qd-chip', style: { background: st.ok ? 'rgba(25,158,112,.18)' : 'rgba(201,133,0,.2)' } }, h('span', { class: 'dot', style: { background: st.ok ? 'var(--good)' : 'var(--warn)' } }), h('b', null, `LIVE ${S.code}`), ' · ' + st.txt),
      st.bat != null ? h('span', { class: 'muted' }, `🔋 ${st.bat}%`) : null,
      h('span', { class: 'sp' }),
      last && !open ? h('button', { class: 'btn', onclick: () => this.summary(last) }, `Riepilogo ${last.note || 'tratto'}`) : null,
      open
        ? h('button', { class: 'btn qd-seg stop', onclick: () => Live.segmentStop(S) }, `■ Fine tratto · ${fmtDur(S.t1 - open.t)}`)
        : h('button', { class: 'btn qd-seg', onclick: () => Live.segmentStart(S) }, '▶ Inizia tratto'),
      h('span', { class: 'qd-size' },
        h('button', { class: 'btn', title: 'Numeri più piccoli', onclick: () => this.setScale(-1) }, 'A−'),
        h('button', { class: 'btn', title: 'Numeri più grandi', onclick: () => this.setScale(1) }, 'A+')),
      h('label', { class: 'qd-damp', title: 'I numeri grandi sono la media degli ultimi secondi: più alto = più calmi e leggibili' }, 'Numeri',
        h('select', { onchange: e => { this.damp = Number(e.target.value); LS.set('quadroDamp', this.damp); this.tick(); } },
          DAMP_CHOICES.map(d => h('option', { value: d, selected: d === this.damp }, d ? `media ${d} s` : 'istantanei')))),
      h('button', { class: 'btn', title: 'Salva i dati ricevuti (o scarica il CSV)', onclick: () => Live.saveAs(S) }, 'Salva'),
      h('button', { class: 'btn', title: 'Chiaro / scuro', onclick: () => { toggleTheme(); this.renderTop(); } }, theme() === 'dark' ? 'Chiaro' : 'Scuro'),
      h('button', { class: 'btn', title: 'Grafici live: mappa, grafici e pannelli', onclick: () => { LS.set('liveView', 'dashboard'); Router.go('#/live/' + encodeURIComponent(S.code)); } }, 'Grafici live')].filter(Boolean));
  },

  /* grandezza dei numeri del quadro */
  setScale(dir) {
    const steps = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75];
    let i = steps.findIndex(v => v >= this.scale - 1e-6); if (i < 0) i = steps.length - 1;
    this.scale = steps[clamp(i + dir, 0, steps.length - 1)];
    LS.set('quadroScale', this.scale);
    this.applyScale();
    toast(`Numeri al ${Math.round(this.scale * 100)}%`, 1200);
  },
  applyScale() { const q = $('#view-viewer .qd'); if (q) q.style.setProperty('--qs', this.scale); this.sized = false; },

  /* ---------- aggiornamento (una volta al secondo) ---------- */
  tick() {
    const S = this.S;
    if (!S) return;
    if (S.dirty) S.rebuild();
    this.renderTop();
    const st = Live.statusInfo(S);
    const stale = !S.hasData() || !st.fresh;
    this.banner.hidden = !stale && !st.skew;
    this.banner.textContent = st.skew || (!S.hasData() ? st.wait : `Dati fermi: ${st.txt}. I valori qui sotto sono gli ultimi arrivati.`);
    this.wrap.classList.toggle('stale', stale && S.hasData());
    if (!S.hasData()) return;
    const t = S.t1, ch = pickChannels(S);
    const open = S.meta.events.find(e => e.type === 'tratto' && e.t2 == null);
    const wins = [['10 s', t - 10000], ['30 s', t - 30000]];
    if (open && t - open.t > 2000) wins.push(['Tratto', open.t]);
    const W = wins.map(([label, a]) => ({ label, a, r: boatStats(S, a, t, ch), x: this.extra(ch, a, t) }));
    const D = this.damp ?? 3, now = c => dampedValue(c, t, D, false);
    const cov = (c, a) => coverageOf(c, a, t) >= 0.8;

    // Stato barca
    for (const k of ['heel', 'pitch']) {
      const c = ch[k];
      this.fill(this.tiles[k], { value: now(c), dec: 1, unit: '°', ch: c, t, zero: true, ok: c && cov(c, t - Math.max(3, D) * 1000),
        side: k === 'heel' && isFinite(now(c)) ? (Math.abs(now(c)) < 0.5 ? 'piatta' : now(c) > 0 ? 'a dritta' : 'a sinistra') : k === 'pitch' && isFinite(now(c)) ? (Math.abs(now(c)) < 0.3 ? 'in piano' : now(c) > 0 ? 'prua su' : 'prua giù') : '',
        W, rows: [['Media', r => r[k] && r[k].mean, 1, '°'], ['Ampiezza', r => r[k] && r[k].range, 1, '°'], ['Oscillazioni', r => r[k] && r[k].osc, 0, '/min']], covOf: (w) => w.r[k] && w.r[k].cov });
    }
    // Conduzione
    const sogNow = dampedValue(ch.sog, t, D, false);
    this.fill(this.tiles.sog, { value: sogNow, dec: 1, unit: 'kn', ch: ch.sog, t, ok: ch.sog && t - ch.sog.t[ch.sog.t.length - 1] < 3000,
      side: ch.sog && isFinite(W[1].r.sog?.mean) ? trendTxt(sogNow - W[1].r.sog.mean, 0.3, 'kn') : '',
      W, rows: [['Media', r => r.sog && r.sog.mean, 1, 'kn'], ['Massima', r => r.sog && r.sog.max, 1, 'kn'], ['Costanza', r => r.sog && r.sog.sd, 2, 'kn ±']], covOf: w => w.r.sog && w.r.sog.cov });
    const cogNow = dampedValue(ch.cog, t, D, true);
    this.fill(this.tiles.cog, { value: isFinite(cogNow) ? (cogNow + 360) % 360 : NaN, dec: 0, unit: '°', ch: ch.cog, t, circ: true, ok: ch.cog && sogNow > 1.5,
      side: isFinite(sogNow) && sogNow <= 1.5 ? 'barca ferma: rotta incerta' : '',
      W, rows: [['Oscillazione', w => w.x.cogSd, 1, '° ±'], ['Ampiezza', w => w.x.cogRange, 0, '°'], ['Cambio più veloce', w => w.x.cogRate, 1, '°/s']], useW: true, covOf: w => w.r.sog && w.r.sog.cov });
    this.fill(this.tiles.steer, { value: W[0].r.steer ? W[0].r.steer.activity : NaN, dec: 1, unit: '°/s', ch: ch.yaw, t, zero: true, ok: ch.yaw && cov(ch.yaw, t - 10000), bigLabel: 'attività 10 s',
      side: '',
      W, rows: [['Attività', r => r.steer && r.steer.activity, 1, '°/s'], ['Correzione più forte', r => r.steer && r.steer.violence, 0, '°/s'], ['Correzioni', w => w.x.turns, 0, '/min']], mixed: [false, false, true], covOf: w => w.r.steer && w.r.steer.cov });
  },

  extra(ch, a, b) { return driveStats(ch, a, b); },

  /* un riquadro: numero grande, andamento dell'ultimo minuto, tabella 10 s / 30 s / tratto */
  fill(T, o) {
    T.big.textContent = isFinite(o.value) ? fmtNum(o.value, o.dec) : '—';
    T.big.classList.toggle('dim', !o.ok);
    T.unit.textContent = o.unit + (o.bigLabel ? ' · ' + o.bigLabel : '');
    T.side.textContent = o.side || '';
    const head = h('tr', null, h('th', null, ''), o.W.map(w => h('th', null, w.label)));
    const rows = o.rows.map(([name, get, dec, unit], ri) => h('tr', null, h('td', null, name, h('span', { class: 'qd-u' }, ' ' + unit)),
      o.W.map(w => {
        const useW = o.useW || (o.mixed && o.mixed[ri]);
        const v = useW ? get(w) : get(w.r);
        const good = (o.covOf(w) ?? 0) >= 0.8;
        return h('td', { class: good ? '' : 'dim', title: good ? '' : 'Dati incompleti in questa finestra' }, v != null && isFinite(v) ? fmtNum(v, dec) : '—');
      })));
    T.tbl.textContent = '';
    T.tbl.append(h('thead', null, head), h('tbody', null, rows));
    this.spark(T, o);
  },

  /* andamento degli ultimi 60 s */
  spark(T, o) {
    const cv = T.cv, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, hh = cv.clientHeight;
    if (!w || !hh) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const c = o.ch;
    if (!c) return;
    const span = 60000, step = 200, n = span / step, a = o.t - span;
    const r = resample(c, a, step, n);
    let vals = Array.from(r);
    if (o.circ) { // la rotta: la mostro attorno alla sua media, senza salti a 0/360
      let sx = 0, sy = 0; for (const v of vals) if (isFinite(v)) { sx += Math.cos(v * Math.PI / 180); sy += Math.sin(v * Math.PI / 180); }
      const m = Math.atan2(sy, sx) * 180 / Math.PI;
      vals = vals.map(v => isFinite(v) ? angDiff(v, m) : NaN);
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!isFinite(lo)) return;
    if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = Math.max((hi - lo) * 0.12, o.circ ? 2 : o.unit === 'kn' ? 0.3 : 0.5);
    lo -= pad; hi += pad;
    const css = getComputedStyle(document.documentElement);
    const y = v => hh - 3 - (v - lo) / (hi - lo) * (hh - 6);
    if (o.zero || o.circ) { // linea dello zero (o della rotta media)
      g.strokeStyle = css.getPropertyValue('--line-2'); g.lineWidth = 1; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke(); g.setLineDash([]);
    }
    g.strokeStyle = css.getPropertyValue('--accent'); g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    vals.forEach((v, i) => { if (!isFinite(v)) { pen = false; return; } const x = i / (n - 1) * w; if (pen) g.lineTo(x, y(v)); else { g.moveTo(x, y(v)); pen = true; } });
    g.stroke();
    // ultimi 10 s evidenziati
    g.fillStyle = css.getPropertyValue('--accent-soft');
    g.fillRect(w * (50 / 60), 0, w / 6, hh);
    g.fillStyle = css.getPropertyValue('--faint'); g.font = '11px ' + css.getPropertyValue('--font');
    g.fillText('ultimo minuto', 4, 12);
  },

  /* riepilogo di un tratto chiuso */
  summary(seg) {
    const S = this.S;
    if (!S || seg.t2 == null || seg.t2 - seg.t < 2000) return;
    modal({ title: `${seg.note || 'Tratto'} · riepilogo`, wide: true, body: segmentSummary(S, seg.t, seg.t2), actions: [{ label: 'Chiudi', kind: 'primary' }] });
  }
};

function trendTxt(d, thr, unit) {
  if (!isFinite(d)) return '';
  if (Math.abs(d) < thr) return 'stabile';
  return (d > 0 ? '▲ ' : '▼ ') + fmtNum(Math.abs(d), 1) + ' ' + unit + ' sulla media 30 s';
}
