/* Libreria delle uscite */
'use strict';
const ICON_BOAT = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 18 L12 3 L12 18 Z M14 7 L20 18 L14 18 Z" fill="#fff"/><path d="M3 20.5 Q7.5 18.5 12 20.5 T21 20.5" stroke="#fff" stroke-width="1.6" fill="none"/></svg>';

const Home = {
  sessions: [], q: '',
  async render() {
    const root = $('#view-home');
    root.textContent = '';
    const page = h('div', { class: 'page' });
    root.append(page);
    page.append(h('div', { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark', html: ICON_BOAT }), h('div', null, h('h1', null, 'N17 Debrief'), h('div', { class: 'lib-path' }, Store.root ? ['Libreria: ', h('b', null, Store.name)] : 'Analisi delle uscite: video, dati e eventi'))),
      h('div', { class: 'sp' }),
      h('button', { class: 'btn', title: 'Dati della barca in tempo reale dal telefono', onclick: () => Router.go('#/live') }, '📡 Live'),
      installButton(),
      Store.root ? h('button', { class: 'btn ghost', onclick: () => this.changeLib() }, 'Cambia cartella') : null,
      h('button', { class: 'icon-btn', title: 'Tema chiaro / scuro', 'aria-label': 'Tema chiaro o scuro', onclick: toggleTheme }, '◐')));

    if (!Store.root) return this.welcome(page);

    try { this.sessions = await Store.listSessions(); }
    catch (e) { page.append(h('div', { class: 'card' }, h('p', null, 'Non riesco a leggere la cartella: ' + errMsg(e) + '. Se è su un disco esterno, controlla che sia collegato.'), h('button', { class: 'btn', onclick: () => this.changeLib() }, 'Scegli la cartella'))); return; }
    if (Store.kind === 'opfs') page.append(h('p', { class: 'stat warn' }, 'Stai usando la memoria interna del browser, adatta solo a provare l\'app: per i video veri scegli una cartella sul disco esterno con "Cambia cartella".'));
    if (!this.month) { const d = new Date(); this.month = [d.getFullYear(), d.getMonth()]; }
    this.cal = h('div', { class: 'card cal' });
    this.dayList = h('div', { class: 'sess-list' });
    page.append(this.cal, this.dayList);
    this.drawCalendar();
    page.append(h('div', { class: 'row', style: { marginTop: '18px', justifyContent: 'center' } },
      h('button', { class: 'btn ghost sm', onclick: async () => { const f = await createDemoSession(); toast('Creata l\'uscita di esempio (1 novembre 2026).'); Router.go(`#/uscita/${encodeURIComponent(f)}/viewer`); } }, 'Crea l\'uscita di esempio')));
  },
  /* Calendario: i giorni con dati sono illuminati, oggi ha il bordo */
  drawCalendar() {
    const [y, m] = this.month, cal = this.cal;
    cal.textContent = '';
    const byDay = new Map();
    for (const s of this.sessions) { const d = s.meta.date; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(s); }
    const MF = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });
    const move = k => { const d = new Date(y, m + k, 1); this.month = [d.getFullYear(), d.getMonth()]; this.drawCalendar(); };
    const today = ymdOf(Date.now());
    const monthCount = this.sessions.filter(s => (s.meta.date || '').startsWith(`${y}-${p2(m + 1)}`) && (s.meta.sources.length || s.meta.cameras.length)).length;
    cal.append(h('div', { class: 'cal-head' },
      h('button', { class: 'icon-btn', title: 'Mese precedente', 'aria-label': 'Mese precedente', onclick: () => move(-1) }, '‹'),
      h('h2', { style: { textTransform: 'capitalize' } }, MF.format(new Date(y, m, 1))),
      h('button', { class: 'icon-btn', title: 'Mese successivo', 'aria-label': 'Mese successivo', onclick: () => move(1) }, '›'),
      h('div', { class: 'sp' }),
      h('span', { class: 'stat' }, monthCount ? `${monthCount} ${monthCount === 1 ? 'uscita' : 'uscite'} nel mese` : 'nessuna uscita nel mese'),
      h('button', { class: 'btn sm', onclick: () => { const d = new Date(); this.month = [d.getFullYear(), d.getMonth()]; this.drawCalendar(); } }, 'Oggi')));
    const grid = h('div', { class: 'cal-grid' });
    for (const d of ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom']) grid.append(h('div', { class: 'cal-dow' }, d));
    const first = new Date(y, m, 1), skip = (first.getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < skip; i++) grid.append(h('div'));
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${p2(m + 1)}-${p2(d)}`, all = byDay.get(key) || [];
      const list = all.filter(s => s.meta.sources.length || s.meta.cameras.length); // illumino solo i giorni con dati
      const vids = list.reduce((a, s) => a + s.meta.cameras.reduce((b, c) => b + c.clips.length, 0), 0), srcs = list.reduce((a, s) => a + s.meta.sources.length, 0);
      const cls = 'cal-day' + (list.length ? ' has' : '') + (key === today ? ' today' : '') + (key > today ? ' future' : '');
      grid.append(h('button', { class: cls, title: list.length ? list.map(s => s.meta.title).join(' · ') : (key > today ? '' : 'Nessun dato: clic per caricare i file di questo giorno'), onclick: () => this.openDay(key, list.length ? list : all) },
        h('b', null, d),
        list.length ? h('span', { class: 'cal-marks' }, vids ? '🎥' : '', srcs ? '📈' : '', list.length > 1 ? `×${list.length}` : '') : null));
    }
    cal.append(grid);
    // elenco delle uscite del mese, sotto il calendario
    this.dayList.textContent = '';
    const inMonth = this.sessions.filter(s => (s.meta.date || '').startsWith(`${y}-${p2(m + 1)}`) && (s.meta.sources.length || s.meta.cameras.length));
    if (inMonth.length) { this.dayList.append(h('div', { class: 'month' }, 'Uscite del mese')); this.fill(this.dayList, inMonth); }
  },
  /* un giorno = un'uscita: se non c'è la creo e vado a caricare i file */
  async openDay(date, list) {
    if (list.length === 1) {
      const s = list[0], empty = !s.meta.sources.length && !s.meta.cameras.length;
      Router.go(`#/uscita/${encodeURIComponent(s.folder)}/${empty ? 'dati' : 'viewer'}`);
      return;
    }
    if (list.length > 1) { this.fill(this.dayList, list); this.dayList.scrollIntoView({ behavior: 'smooth' }); return; }
    if (date > ymdOf(Date.now())) { toast('È un giorno nel futuro.'); return; }
    const folder = await Store.dayFolder(date);
    Router.go(`#/uscita/${encodeURIComponent(folder)}/dati`);
  },
  fill(list, items) {
    list.textContent = '';
    items = items || this.sessions;
    if (!this.sessions.length && Store.kind === 'fs') {
      const hint = h('div');
      list.append(hint);
      Store.findLibrariesBelow().then(found => {
        if (!found.length) return;
        hint.append(h('div', { class: 'card', style: { display: 'grid', gap: '10px', marginBottom: '10px' } },
          h('h2', null, found.length === 1 ? 'Le uscite sono in una sottocartella' : 'Ho trovato delle uscite in alcune sottocartelle'),
          h('p', { class: 'muted' }, `Hai scelto «${Store.name}», che non contiene uscite direttamente. Le uscite sono più in basso:`),
          ...found.map(f => h('div', { class: 'row' }, h('code', null, `${Store.name}/${f.path}`), h('div', { class: 'sp' }),
            h('button', { class: 'btn primary', onclick: async () => { await Store.useSub(f); toast(`Libreria: ${f.path.split('/').pop()}`); this.render(); } }, 'Usa questa cartella')))));
      });
    }
    if (!this.sessions.length) {
      list.append(h('div', { class: 'card', style: { textAlign: 'center', padding: '36px' } },
        h('h2', null, 'Nessuna uscita in questa libreria'),
        h('p', { class: 'muted' }, 'Crea la prima uscita e carica video e dati. Oppure crea l\'uscita di esempio per vedere come funziona.'),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => Router.go('#/nuova') }, '+ Nuova uscita'))));
      return;
    }
    if (!items.length) { list.append(h('p', { class: 'muted' }, 'Nessuna uscita corrisponde alla ricerca.')); return; }
    let month = '';
    const MF = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });
    for (const s of items) {
      const m = s.meta, [y, mo, d] = (m.date || '').split('-').map(Number);
      const mk = y ? MF.format(new Date(y, mo - 1, 1)) : 'Senza data';
      if (mk !== month) { month = mk; list.append(h('div', { class: 'month' }, mk)); }
      const vids = m.cameras.reduce((a, c) => a + c.clips.length, 0), vdur = m.cameras.reduce((a, c) => a + c.clips.reduce((b, cl) => b + cl.duration, 0), 0);
      const wind = m.windMin || m.windMax ? `${m.windMin || '?'}–${m.windMax || '?'} kn` : '';
      const crew = [m.helm, m.crew].filter(Boolean).join(' / ');
      const wd = y ? new Date(y, mo - 1, d).toLocaleDateString('it-IT', { weekday: 'short' }) : '';
      const open = () => Router.go(`#/uscita/${encodeURIComponent(s.folder)}/viewer`);
      const el = h('div', { class: 'sess', role: 'button', tabindex: 0, onclick: open, onkeydown: e => { if (e.key === 'Enter') open(); } },
        h('div', { class: 'sess-date' }, h('b', null, d || '—'), h('span', null, wd)),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'sess-title' }, m.title || s.folder),
          h('div', { class: 'sess-meta' },
            m.place ? h('span', null, m.place) : null, crew ? h('span', null, crew) : null, wind ? h('span', null, 'Vento ' + wind) : null,
            h('span', null, vids ? `${vids} video · ${fmtDur(vdur * 1000)}` : 'nessun video'),
            h('span', null, m.sources.length ? `${m.sources.length} ${m.sources.length === 1 ? 'file dati' : 'file dati'}` : 'nessun dato'),
            m.events.length ? h('span', null, `${m.events.length} eventi`) : null)),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); Router.go(`#/uscita/${encodeURIComponent(s.folder)}/dati`); } }, 'Video e dati'),
          h('button', { class: 'btn sm primary', onclick: e => { e.stopPropagation(); open(); } }, 'Apri')));
      list.append(el);
    }
  },
  async welcome(page) {
    const rec = await Store.remembered();
    const box = h('div', { class: 'welcome' });
    page.append(box);
    if (!Store.supported) {
      const ua = navigator.userAgent;
      const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox/.test(ua);
      const webApp = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
      const mobile = /iPhone|iPad|Android/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
      const url = location.origin + location.pathname;
      const copy = h('button', { class: 'btn primary', onclick: async () => {
        try { await navigator.clipboard.writeText(url); copy.textContent = 'Link copiato ✓'; }
        catch (e) { prompt('Copia questo link:', url); }
      } }, 'Copia il link');
      const where = mobile ? 'Sei sul telefono o sul tablet.' : safari ? (webApp ? 'L\'hai aperto da un\'app del Dock che funziona con Safari (per esempio l\'icona 98).' : 'Sei in Safari.') : 'Questo browser non permette di lavorare con le cartelle del disco.';
      box.append(h('div', { class: 'card', style: { display: 'grid', gap: '12px' } },
        h('h2', null, 'Il Debrief si usa con Google Chrome sul Mac'),
        h('p', { class: 'muted' }, where + ' Il Debrief deve leggere video e dati dalle cartelle del disco, e questo lo permette solo Chrome (o Edge). Niente viene caricato online.'),
        mobile ? h('p', { class: 'muted' }, 'Aprilo dal Mac: ' , h('code', null, url)) : h('ol', null,
          h('li', null, 'Premi "Copia il link".'),
          h('li', null, 'Apri Google Chrome, incolla il link nella barra dell\'indirizzo e premi Invio.'),
          h('li', null, 'Per averlo nel Dock come app: in Chrome premi l\'icona "Installa" in fondo alla barra dell\'indirizzo (uno schermo con una freccia), oppure il pulsante "Installa come app" in alto nella libreria. Da lì in poi si apre sempre in Chrome.')),
        h('div', { class: 'row' }, mobile ? null : copy, h('button', { class: 'btn ghost', onclick: () => this.tryOPFS() }, 'Prova qui con la memoria del browser'))),
        h('div', { class: 'card', style: { display: 'grid', gap: '10px' } }, h('h2', null, '📡 N17 Live'), h('p', { class: 'muted' }, 'Per guardare in tempo reale i dati del Logger in barca non serve Chrome: funziona anche qui.'), h('div', null, h('button', { class: 'btn primary', onclick: () => Router.go('#/live') }, 'Apri il Live'))));
      return;
    }
    if (rec && rec.kind === 'fs') {
      box.append(h('div', { class: 'card', style: { display: 'grid', gap: '10px' } },
        h('h2', null, `Riapri la libreria «${rec.name}»`),
        h('p', { class: 'muted' }, 'Chrome chiede di confermare l\'accesso alla cartella ogni volta che riapri l\'app. Se la cartella è su un disco esterno, collegalo prima.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => this.reopen(rec) }, 'Riapri la libreria'), h('button', { class: 'btn', onclick: () => this.changeLib() }, 'Scegli un\'altra cartella'))));
    }
    box.append(h('div', { class: 'card', style: { display: 'grid', gap: '12px' } },
      h('h2', null, rec && rec.kind === 'fs' ? 'Oppure crea una nuova libreria' : 'Dove salvare le uscite'),
      h('p', null, 'L\'app non carica niente su internet: lavora su una cartella del tuo disco, che chiamiamo libreria. Con molti video conviene metterla su un disco esterno (SSD).'),
      h('ol', null,
        h('li', null, 'Collega il disco esterno e crea una cartella, per esempio ', h('code', null, 'Nacra 17 – Uscite'), '.'),
        h('li', null, 'Premi "Scegli la cartella" e selezionala. Chrome chiede il permesso di modificarla: rispondi sì.'),
        h('li', null, 'Ogni uscita diventa una sottocartella con ', h('code', null, 'video'), ', ', h('code', null, 'dati'), ' e il file ', h('code', null, 'uscita.json'), ' (sincronizzazione, eventi, layout). Puoi copiarla o archiviarla con il Finder.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => this.changeLib() }, 'Scegli la cartella'),
        h('button', { class: 'btn ghost', onclick: () => this.tryOPFS() }, 'Prova senza cartella (memoria del browser)'))));
  },
  async reopen(rec) {
    try { await Store.reopen(rec); Router.resume(); }
    catch (e) { toast(errMsg(e), 6000, 'bad'); }
  },
  async changeLib() {
    try { await Store.pick(); Router.go('#/'); this.render(); }
    catch (e) { if (e.name !== 'AbortError') toast('Cartella non aperta: ' + errMsg(e), 6000, 'bad'); }
  },
  async tryOPFS() {
    try { await Store.useOPFS(); Router.go('#/'); this.render(); }
    catch (e) { toast('Memoria del browser non disponibile: ' + errMsg(e), 6000, 'bad'); }
  }
};

function toggleTheme() {
  const t = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  LS.set('theme', t);
  window.dispatchEvent(new Event('themechange'));
}

/* Installazione come app di Chrome (icona nel Dock, si apre sempre in Chrome) */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; const b = document.getElementById('installBtn'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; const b = document.getElementById('installBtn'); if (b) b.hidden = true; toast('Installato: trovi N17 Debrief tra le app, puoi tenerlo nel Dock.', 6000); });
function installButton() {
  return h('button', { id: 'installBtn', class: 'btn', hidden: !installPrompt, title: 'Aggiunge N17 Debrief alle app del Mac, con la sua icona', onclick: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    const b = document.getElementById('installBtn'); if (b) b.hidden = true;
  } }, 'Installa come app');
}
