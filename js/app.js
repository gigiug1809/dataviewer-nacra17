/* Avvio e navigazione tra le schermate */
'use strict';
const Router = {
  pending: null,
  go(hash) { if (location.hash !== hash) location.hash = hash; else this.route(); },
  resume() { this.route(); },
  async route() {
    const hs = location.hash || '#/';
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
    } else { this.show('home'); Home.render(); }
  },
  show(v) { for (const k of ['home', 'editor', 'viewer']) $('#view-' + k).hidden = k !== v; window.scrollTo(0, 0); }
};
window.addEventListener('hashchange', () => Router.route());
window.addEventListener('DOMContentLoaded', () => Router.route());
// Sul sito pubblicato l'app resta disponibile anche senza rete
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
