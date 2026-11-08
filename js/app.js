/* Avvio e navigazione tra le schermate */
'use strict';
const Router = {
  pending: null,
  go(hash) { if (location.hash !== hash) location.hash = hash; else this.route(); },
  resume() { this.route(); },
  async route() {
    const hs = location.hash || '#/';
    document.title = hs.startsWith('#/live') ? 'N17 Live' : hs === '#/' ? 'N17' : 'N17 Debrief';
    if (hs !== '#/live') Live.leavePage();
    // pagina d'inizio: Live (in acqua) o Debrief (a terra)
    if (hs === '#/' || hs === '#') { Quadro.close(); Viewer.close(); this.show('home'); Home.start(); return; }
    // il live non ha bisogno della cartella della libreria (funziona anche su iPad)
    let lm;
    const code = s => decodeURIComponent(s).toUpperCase();
    if ((lm = /^#\/live\/([^/]+)\/quadro$/.exec(hs))) { this.show('viewer'); Quadro.open(code(lm[1])); return; }
    Quadro.close();
    if (hs === '#/live') { Viewer.close(); this.show('home'); Live.page(); return; }
    if ((lm = /^#\/live\/([^/]+)\/d\/([^/]+)(\/modifica)?$/.exec(hs))) { this.show('viewer'); Live.open(code(lm[1]), decodeURIComponent(lm[2]), !!lm[3]); return; }
    if ((lm = /^#\/live\/([^/]+)$/.exec(hs))) { this.show('viewer'); Live.open(code(lm[1]), DASH_STD); return; } // indirizzo di prima
    if (!Store.root) {
      // la libreria va riaperta con un clic (permesso di Chrome): poi si torna qui
      const rec = await Store.remembered();
      if (rec && rec.kind === 'opfs') { try { await Store.useOPFS(); } catch (e) { /* ignora */ } }
      if (!Store.root) { this.show('home'); Home.render(); return; }
    }
    let m;
    Viewer.close();
    if (hs === '#/nuova') { this.show('editor'); Editor.open(null); }
    else if ((m = /^#\/uscita\/([^/]+)\/(dati|viewer)$/.exec(hs))) {
      const folder = decodeURIComponent(m[1]);
      if (m[2] === 'dati') { this.show('editor'); Editor.open(folder); }
      else { this.show('viewer'); Viewer.open(folder); }
    } else { this.show('home'); if (hs !== '#/debrief') history.replaceState(null, '', '#/debrief'); Home.render(); }
  },
  show(v) { for (const k of ['home', 'editor', 'viewer']) $('#view-' + k).hidden = k !== v; window.scrollTo(0, 0); }
};
window.addEventListener('hashchange', () => Router.route());
window.addEventListener('DOMContentLoaded', () => Router.route());
// Sul sito pubblicato l'app resta disponibile anche senza rete
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
