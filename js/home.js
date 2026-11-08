/* Libreria delle uscite */
'use strict';
const ICON_BOAT = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 18 L12 3 L12 18 Z M14 7 L20 18 L14 18 Z" fill="#fff"/><path d="M3 20.5 Q7.5 18.5 12 20.5 T21 20.5" stroke="#fff" stroke-width="1.6" fill="none"/></svg>';

const Home = {
  sessions: [], q: '',
  /* pagina d'inizio: due strade ben separate */
  start() {
    const root = $('#view-home');
    root.textContent = '';
    const fs = Store.supported;
    root.append(h('div', { class: 'page start' },
      h('div', { class: 'topbar' }, h('div', { class: 'brand' }, h('div', { class: 'brand-mark', html: ICON_BOAT }), h('h1', null, 'N17')), h('div', { class: 'sp' }), installButton(),
        h('button', { class: 'icon-btn', title: 'Tema chiaro / scuro', 'aria-label': 'Tema chiaro o scuro', onclick: toggleTheme }, '◐')),
      h('div', { class: 'start-grid' },
        h('button', { class: 'start-card', onclick: () => Router.go('#/live') },
          h('div', { class: 'start-ico' }, '📡'), h('h2', null, 'N17 Live'), h('div', { class: 'start-when' }, 'In acqua, mentre la barca naviga'),
          h('ul', null, h('li', null, 'Dati in tempo reale dal telefono in barca'), h('li', null, 'Dashboard per iPad, in orizzontale o in verticale'), h('li', null, 'Inizio e fine dei tratti di allenamento')),
          h('span', { class: 'btn primary' }, 'Apri il Live →')),
        h('button', { class: 'start-card', onclick: () => Router.go('#/debrief') },
          h('div', { class: 'start-ico' }, '📈'), h('h2', null, 'N17 Debrief'), h('div', { class: 'start-when' }, 'A terra, dopo l\'uscita'),
          h('ul', null, h('li', null, 'Il calendario delle giornate di allenamento'), h('li', null, 'File completo del telefono, video, Garmin, Cyclops'), h('li', null, 'Grafici, mappa, tratti e riepiloghi')),
          fs ? h('span', { class: 'btn' }, 'Apri il Debrief →') : h('span', { class: 'stat' }, 'Si usa con Google Chrome sul Mac'))),
      h('p', { class: 'stat start-note' }, 'Il Live mostra una copia in diretta. Il file completo resta sul telefono: a terra lo importi nel Debrief, che lo mette nel giorno giusto e sostituisce i dati ricevuti in diretta.')));
  },
  async render() {
    const root = $('#view-home');
    root.textContent = '';
    const page = h('div', { class: 'page' });
    root.append(page);
    const phoneIn = h('input', { type: 'file', accept: '.csv,text/csv', multiple: true, hidden: true, onchange: e => { const f = [...e.target.files]; e.target.value = ''; this.importPhone(f); } });
    page.append(h('div', { class: 'topbar' },
      h('button', { class: 'btn ghost', title: 'Live o Debrief', onclick: () => Router.go('#/') }, '← Inizio'),
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark', html: ICON_BOAT }), h('div', null, h('h1', null, 'N17 Debrief'), h('div', { class: 'lib-path' }, Store.root ? ['Libreria: ', h('b', null, Store.name)] : 'Analisi delle giornate: video, dati e eventi'))),
      h('div', { class: 'sp' }),
      Store.root ? h('button', { class: 'btn primary', title: 'I file del Logger vanno da soli nel giorno giusto', onclick: () => phoneIn.click() }, '📥 Importa dal telefono') : null, phoneIn,
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
    // i file del telefono si possono trascinare ovunque sulla pagina
    page.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); page.classList.add('drop-on'); } });
    page.addEventListener('dragleave', e => { if (e.target === page) page.classList.remove('drop-on'); });
    page.addEventListener('drop', e => { e.preventDefault(); page.classList.remove('drop-on'); this.importPhone([...e.dataTransfer.files]); });
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
    const withData = s => s.meta.sources.length || s.meta.cameras.length;
    const monthCount = new Set(this.sessions.filter(s => (s.meta.date || '').startsWith(`${y}-${p2(m + 1)}`) && withData(s)).map(s => s.meta.date)).size;
    const MS = new Intl.DateTimeFormat('it-IT', { month: 'short' });
    const year = h('div', { class: 'cal-year' }, h('b', null, y), Array.from({ length: 12 }, (_, i) => {
      const n = new Set(this.sessions.filter(s => (s.meta.date || '').startsWith(`${y}-${p2(i + 1)}`) && withData(s)).map(s => s.meta.date)).size;
      return h('button', { class: 'cal-ym' + (i === m ? ' on' : '') + (n ? ' has' : ''), title: n ? `${n} ${n === 1 ? 'giornata' : 'giornate'}` : 'nessuna giornata', onclick: () => { this.month = [y, i]; this.drawCalendar(); } }, MS.format(new Date(y, i, 1)).replace('.', ''), n ? h('i', null, n) : null);
    }));
    cal.append(h('div', { class: 'cal-head' },
      h('button', { class: 'icon-btn', title: 'Mese precedente', 'aria-label': 'Mese precedente', onclick: () => move(-1) }, '‹'),
      h('h2', { style: { textTransform: 'capitalize' } }, MF.format(new Date(y, m, 1))),
      h('button', { class: 'icon-btn', title: 'Mese successivo', 'aria-label': 'Mese successivo', onclick: () => move(1) }, '›'),
      h('div', { class: 'sp' }),
      h('span', { class: 'stat' }, monthCount ? `${monthCount} ${monthCount === 1 ? 'giornata' : 'giornate'} nel mese` : 'nessuna giornata nel mese'),
      h('button', { class: 'btn sm', onclick: () => { const d = new Date(); this.month = [d.getFullYear(), d.getMonth()]; this.drawCalendar(); } }, 'Oggi')));
    cal.append(year);
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
    if (inMonth.length) this.fill(this.dayList, inMonth);
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
            (() => { const nt = m.events.filter(e => e.type === 'tratto').length, ne = m.events.length - nt; const p = [nt ? `${nt} ${nt === 1 ? 'tratto' : 'tratti'}` : '', ne ? `${ne} ${ne === 1 ? 'evento' : 'eventi'}` : ''].filter(Boolean); return p.length ? h('span', null, p.join(' · ')) : null; })()),
          h('div', { class: 'sess-badges' }, dayBadges(m))),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); Router.go(`#/uscita/${encodeURIComponent(s.folder)}/dati`); } }, 'Video e dati'),
          h('button', { class: 'btn sm primary', onclick: e => { e.stopPropagation(); open(); } }, 'Apri')));
      list.append(el);
    }
  },
  /* file del Logger: ognuno nella giornata del suo giorno */
  async importPhone(files) {
    files = files.filter(f => !/\.json$/i.test(f.name)); // il file .json accanto alla registrazione non serve
    if (!files.length) return;
    const out = [];
    for (const f of files) {
      if (!/\.csv$/i.test(f.name)) { out.push({ ok: false, msg: `${f.name}: qui si importano i file del Logger (.csv). Video, Garmin e Cyclops si caricano aprendo la giornata.` }); continue; }
      try { out.push(await importPhoneFile(f)); } catch (e) { out.push({ ok: false, msg: `${f.name}: ${errMsg(e)}` }); }
    }
    const days = [...new Set(out.filter(r => r.folder).map(r => r.folder))];
    const last = out.filter(r => r.day).pop();
    if (last) { const [yy, mm] = last.day.split('-').map(Number); this.month = [yy, mm - 1]; }
    await this.render();
    modal({ title: 'Importazione dal telefono', wide: true, body: h('div', { style: { display: 'grid', gap: '8px' } }, out.map(r => h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'dot', style: { background: r.ok ? 'var(--good)' : 'var(--warn)' } }), h('span', null, r.msg))),
      h('p', { class: 'stat' }, 'Ogni registrazione va nella giornata del suo giorno. Se quel giorno avevi salvato i dati del Live, il file del telefono prende il loro posto: niente doppioni, eventi e tratti restano.')),
      actions: [{ label: 'Chiudi' }, ...(days.length === 1 ? [{ label: 'Apri la giornata', kind: 'primary', run: () => Router.go(`#/uscita/${encodeURIComponent(days[0])}/viewer`) }] : [])] });
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
    try { await Store.pick(); Router.go('#/debrief'); this.render(); }
    catch (e) { if (e.name !== 'AbortError') toast('Cartella non aperta: ' + errMsg(e), 6000, 'bad'); }
  },
  async tryOPFS() {
    try { await Store.useOPFS(); Router.go('#/debrief'); this.render(); }
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

/* da dove vengono i dati di una giornata, e cosa manca */
function dayBadges(m) {
  const out = [], src = m.sources || [];
  const full = src.filter(s => s.kind === 'iPhone' && !s.live).length, live = src.filter(s => s.kind === 'iPhone' && s.live).length;
  if (full) out.push(h('span', { class: 'dbadge ok', title: 'Registrazione completa dal telefono' }, '📱 Logger'));
  if (live) out.push(h('span', { class: 'dbadge warn', title: 'Dati ricevuti in diretta: possono avere dei buchi. Importa il file del telefono, prenderà il loro posto.' }, full ? '📡 Live (in più)' : '📡 solo Live: importa il file del telefono'));
  const vids = (m.cameras || []).reduce((a, c) => a + c.clips.length, 0);
  if (vids) out.push(h('span', { class: 'dbadge' }, `🎥 ${vids} video`));
  const kinds = { FIT: '⌚ Garmin', TCX: '⌚ Garmin', GPX: '🛰 GPX', Vakaros: '🧭 Vakaros', Cyclops: '⚖️ Cyclops', CSV: '📄 CSV' };
  for (const k of [...new Set(src.filter(s => kinds[s.kind]).map(s => kinds[s.kind]))]) out.push(h('span', { class: 'dbadge' }, k));
  if (!src.length && !vids) out.push(h('span', { class: 'dbadge' }, 'vuota'));
  return out;
}
