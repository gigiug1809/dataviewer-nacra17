/* Pannello MURE E ANDATURE: vento stimato, e per ogni andatura (bolina, traverso, poppa) e mura
   (a dritta, a sinistra) tempo, velocità, VMG, angolo al vento, heel e trim. Più qualche frase. */
'use strict';

class TacksPanel {
  constructor(V, cfg) {
    this.V = V; this.cfg = cfg; this.S = V.S;
    if (!cfg.scope) cfg.scope = 'all';
    this.el = h('div', { class: 'tk-wrap' });
    this.key = ''; this.last = 0;
  }
  title() { return 'Mura e andature'; }
  headButtons() {
    const sel = h('select', { title: 'Su quale parte dell\'uscita', style: { minHeight: '22px', fontSize: '11px', padding: '1px 22px 1px 6px', backgroundPosition: 'right 6px center' } },
      [['all', 'tutta l\'uscita'], ['seg', 'tratto corrente'], ['sel', 'selezione I–O']].map(([v, l]) => h('option', { value: v }, l)));
    sel.value = this.cfg.scope;
    sel.onchange = () => { this.cfg.scope = sel.value; this.key = ''; this.V.layoutChanged(); this.V.requestDraw(); };
    sel.addEventListener('mousedown', e => e.stopPropagation());
    return [sel];
  }
  range(t) {
    const S = this.S, V = this.V;
    if (this.cfg.scope === 'seg') { const s = segmentAt(S, t); if (s) return [s.t, s.t2 ?? Math.min(t, S.t1), s.note || 'tratto']; return null; }
    if (this.cfg.scope === 'sel') { if (V.inT != null && V.outT != null) return [V.inT, V.outT, 'selezione']; return null; }
    return [S.t0, S.t1, 'tutta l\'uscita'];
  }
  update(t) {
    const now = performance.now();
    if (now - this.last < 700 && this.key) return;
    this.last = now;
    const r = this.range(t);
    const key = r ? `${Math.round(r[0] / 1000)}|${Math.round(r[1] / 2000)}|${this.S.meta.twd}|${this.S.meta.events.length}` : 'none:' + this.cfg.scope;
    if (key === this.key) return;
    this.key = key;
    this.build(r);
  }
  eventsChanged() { this.key = ''; }
  setWind(v) {
    const S = this.S;
    S.meta.twd = v == null ? '' : String(Math.round((v + 360) % 360));
    S.derive(); S.save();
    this.V.rebuildPanels(p => p.type !== 'video');
  }
  windBox() {
    const S = this.S, E = S.windEst, W = S.wind;
    const arrow = d => h('span', { class: 'tk-arrow', style: { transform: `rotate(${(d + 180) % 360}deg)` }, title: `vento da ${Math.round(d)}°` }, '↑');
    const box = h('div', { class: 'tk-wind' });
    const ask = () => promptBox('Direzione del vento', 'Da dove soffia, in gradi (0 = da nord, 90 = da est). Vuoto = stima automatica.', S.meta.twd || (E ? String(E.twd) : '')).then(v => {
      if (v == null) return;
      const n = parseFloat(String(v).replace(',', '.'));
      this.setWind(v.trim() === '' || !isFinite(n) ? null : n);
    });
    if (W && W.manual) {
      box.append(h('div', { class: 'row', style: { gap: '8px' } }, arrow(W.twd), h('b', null, `Vento da ${Math.round(W.twd)}°`), h('span', { class: 'muted' }, 'indicato a mano'), h('div', { class: 'sp' }),
        h('button', { class: 'btn sm', onclick: ask }, 'Cambia'), E ? h('button', { class: 'btn sm', onclick: () => this.setWind(null), title: `stima: da ${E.twd}°, affidabilità ${E.conf}` }, 'Usa la stima') : null));
      if (E && E.conf !== 'bassa' && Math.abs(angDiff(E.twd, W.twd)) > 15) box.append(h('div', { class: 'stat warn' }, `La stima dalle rotte dice ${E.twd}° (affidabilità ${E.conf}): ${Math.round(Math.abs(angDiff(E.twd, W.twd)))}° di differenza. Controlla il valore indicato.`));
    } else if (E) {
      const tx = windText(E);
      box.append(h('div', { class: 'row', style: { gap: '8px' } }, arrow(E.twd), h('b', null, `Vento stimato da ${E.twd}°`), h('span', { class: 'tk-conf ' + E.conf }, `affidabilità ${E.conf}`), h('div', { class: 'sp' }),
        h('button', { class: 'btn sm', onclick: () => this.setWind(E.twd), title: 'Scrive questo valore nella scheda dell\'uscita' }, 'Fissa'), h('button', { class: 'btn sm', onclick: ask }, 'Cambia')),
        ...[h('div', { class: 'faint small' }, tx.line), tx.shift ? h('div', { class: 'faint small' }, tx.shift) : null,
          E.conf === 'bassa' ? h('div', { class: 'stat warn' }, 'Stima incerta (pochi bordi o velocità simili di bolina e di poppa): non la uso. Se conosci la direzione, indicala con "Cambia".') : null].filter(Boolean));
    } else {
      box.append(h('div', { class: 'row', style: { gap: '8px' } }, h('b', null, 'Vento sconosciuto'), h('div', { class: 'sp' }), h('button', { class: 'btn sm', onclick: ask }, 'Indica')),
        h('div', { class: 'faint small' }, 'Per stimarlo servono almeno un paio di minuti di bolina o di poppa sopra i 6 nodi.'));
    }
    return box;
  }
  build(r) {
    const S = this.S;
    this.el.textContent = '';
    this.el.append(this.windBox());
    if (!S.wind) return;
    if (!r) { this.el.append(h('p', { class: 'muted' }, this.cfg.scope === 'seg' ? 'Il cursore non è dentro un tratto.' : 'Nessuna selezione: segna inizio e fine con I e O (o Maiusc + trascina su un grafico).')); return; }
    const [a, b, name] = r, T = tackTable(S, a, b);
    if (!T.rows.length) { this.el.append(h('p', { class: 'muted' }, `In ${name} non ci sono bordi da analizzare (sopra ${SAIL_MIN_KN} nodi).`)); return; }
    const f = (v, d) => isFinite(v) ? fmtNum(v, d) : '—';
    const tb = h('table', { class: 'ev-table tk-table' }, h('thead', null, h('tr', null,
      ['', 'tempo', 'velocità', 'VMG', 'TWA', 'heel', 'trim'].map((x, i) => h('th', { style: i ? { textAlign: 'right' } : null }, x)))));
    const body = h('tbody');
    let lastMode = '';
    for (const row of T.rows) {
      const first = row.mode !== lastMode; lastMode = row.mode;
      body.append(h('tr', { class: first ? 'tk-first' : '' },
        h('td', null, h('b', null, first ? SAIL_LABEL[row.mode] : ''), h('span', { class: 'muted' }, ` mure a ${row.tack}`)),
        h('td', { class: 'num' }, fmtDur(row.time)),
        h('td', { class: 'num' }, h('b', null, f(row.v, 1)), h('span', { class: 'faint' }, ` max ${f(row.vMax, 1)}`)),
        h('td', { class: 'num' }, f(Math.abs(row.vmg), 1)),
        h('td', { class: 'num' }, f(row.A, 0) + '°'),
        h('td', { class: 'num', title: 'positivo = sbanda sottovento (dalla parte giusta)' }, `${f(row.heel, 1)}° `, h('span', { class: 'faint' }, `±${f(row.heelSd, 1)}`)),
        h('td', { class: 'num', title: 'positivo = prua su' }, `${f(row.pitch, 1)}° `, h('span', { class: 'faint' }, `±${f(row.pitchSd, 1)}`))));
    }
    tb.append(body);
    const sailed = T.rows.reduce((x, r) => x + r.time, 0);
    this.el.append(h('div', { class: 'tbl-wrap' }, tb),
      h('div', { class: 'faint small', style: { margin: '4px 0 6px' } }, `In ${name}: ${fmtDur(sailed)} di bordi${T.man ? ` · ${fmtDur(T.man)} di manovre` : ''}${T.slow ? ` · ${fmtDur(T.slow)} lenti o fermi (sotto ${SAIL_MIN_KN} kn, esclusi)` : ''}. Heel positivo = sbanda sottovento; ± = quanto oscilla.`));
    const ins = tackInsights(T);
    if (ins.length) this.el.append(h('ul', { class: 'tk-ins' }, ins.map(x => h('li', { class: x.kind }, x.text))));
  }
  resize() {}
  destroy() {}
}
PANEL_TYPES.tacks = { label: 'Mura e andature', icon: '🧭' };
PANEL_CLASSES.tacks = TacksPanel;
