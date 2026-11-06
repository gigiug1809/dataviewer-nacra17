/* Libreria delle uscite su disco (File System Access API di Chrome).
   Struttura della cartella scelta:
     <Libreria>/
       libreria.json                 modelli di layout e preferenze comuni
       2026-11-06 Cagliari/          una cartella per uscita
         uscita.json                 dati dell'uscita: fonti, video, sincronizzazione, eventi, layout
         video/                      file video (copiati dall'app o con il Finder)
         dati/                       CSV e GPX originali
         cache/                      telemetria GoPro già letta */
'use strict';
const SESSION_FILE = 'uscita.json';
const LIB_FILE = 'libreria.json';

const Store = {
  root: null, kind: '', name: '',
  supported: typeof window.showDirectoryPicker === 'function',

  async remembered() {
    try {
      const r = await KV.get('library');
      if (!r) return null;
      return r;
    } catch (e) { return null; }
  },
  async reopen(rec) {
    if (rec.kind === 'opfs') return this.useOPFS();
    const hnd = rec.handle;
    let p = await hnd.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') p = await hnd.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') throw new Error('Permesso negato: Chrome non può aprire la cartella.');
    this.root = hnd; this.kind = 'fs'; this.name = hnd.name;
    return true;
  },
  async pick() {
    const hnd = await window.showDirectoryPicker({ id: 'n17-libreria', mode: 'readwrite', startIn: 'documents' });
    this.root = hnd; this.kind = 'fs'; this.name = hnd.name;
    await KV.set('library', { kind: 'fs', handle: hnd, name: hnd.name });
    return true;
  },
  async useOPFS() {
    this.root = await navigator.storage.getDirectory();
    this.kind = 'opfs'; this.name = 'Memoria del browser (prova)';
    await KV.set('library', { kind: 'opfs', name: this.name });
    return true;
  },
  async forget() { await KV.del('library'); this.root = null; },
  // usa come libreria una sottocartella di quella scelta (il permesso è già dato)
  async useSub(found) {
    this.root = found.handle; this.kind = 'fs'; this.name = found.handle.name;
    await KV.set('library', { kind: 'fs', handle: found.handle, name: found.handle.name });
  },
  /* Cerca, sotto la cartella scelta, sottocartelle che contengono uscite (fino a 3 livelli) */
  async findLibrariesBelow(maxDepth = 3) {
    const out = [], SKIP = /^(\.|node_modules$|lib$|js$|css$|video$|dati$|cache$|icons$)/;
    let visits = 0;
    const walk = async (dir, rel, depth) => {
      if (depth > maxDepth || visits > 400 || out.length >= 5) return;
      const subs = [];
      for await (const [name, hnd] of dir.entries()) if (hnd.kind === 'directory' && !SKIP.test(name)) subs.push([name, hnd]);
      for (const [name, hnd] of subs) {
        visits++;
        try { await hnd.getFileHandle(SESSION_FILE); if (rel) { out.push({ handle: dir, path: rel }); return; } } catch (e) { /* non è un'uscita */ }
      }
      for (const [name, hnd] of subs) await walk(hnd, rel ? `${rel}/${name}` : name, depth + 1);
    };
    try { await walk(this.root, '', 0); } catch (e) { /* cartella non leggibile */ }
    return out;
  },

  async dir(path, create = false) {
    let d = this.root;
    for (const part of String(path).split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
    return d;
  },
  async fileHandle(path, create = false) {
    const parts = String(path).split('/').filter(Boolean), name = parts.pop();
    const d = await this.dir(parts.join('/'), create);
    return d.getFileHandle(name, { create });
  },
  async file(path) { return (await this.fileHandle(path)).getFile(); },
  async exists(path) { try { await this.fileHandle(path); return true; } catch (e) { return false; } },
  async readText(path) { return (await this.file(path)).text(); },
  async readJSON(path, dflt = null) { try { return JSON.parse(await this.readText(path)); } catch (e) { return dflt; } },
  async writeText(path, text) {
    const fh = await this.fileHandle(path, true);
    const w = await fh.createWritable();
    await w.write(text); await w.close();
  },
  writeJSON(path, obj) { return this.writeText(path, JSON.stringify(obj, null, 1)); },

  async list(path) {
    const d = await this.dir(path);
    const out = [];
    for await (const [name, hnd] of d.entries()) out.push({ name, kind: hnd.kind, handle: hnd });
    return out;
  },

  /* Copia un file (anche di molti GB) a blocchi, con avanzamento e annullamento */
  async copyIn(file, path, onProgress, signal) {
    const fh = await this.fileHandle(path, true);
    const w = await fh.createWritable();
    let done = 0, last = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        done += chunk.byteLength; ctl.enqueue(chunk);
        const now = performance.now();
        if (onProgress && now - last > 200) { last = now; onProgress(done / file.size, done); }
      }
    });
    try {
      await file.stream().pipeThrough(counter).pipeTo(w, { signal });
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* già chiuso */ }
      try { const parts = path.split('/'); const nm = parts.pop(); await (await this.dir(parts.join('/'))).removeEntry(nm); } catch (e3) { /* niente da togliere */ }
      throw e;
    }
    onProgress && onProgress(1, file.size);
  },

  /* ---------- Uscite ---------- */
  async listSessions() {
    const out = [];
    for (const e of await this.list('')) {
      if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
      const meta = await this.readJSON(`${e.name}/${SESSION_FILE}`);
      if (meta && meta.app === 'nacra17-dataviewer') out.push({ folder: e.name, meta });
    }
    out.sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || '') || (b.meta.created || 0) - (a.meta.created || 0));
    return out;
  },
  async createSession(meta) {
    let base = `${meta.date} ${meta.title}`.replace(/[\/\\:*?"<>|]+/g, '-').trim().slice(0, 70) || 'Uscita';
    let folder = base, i = 2;
    while (true) { try { await this.dir(folder); folder = `${base} (${i++})`; } catch (e) { break; } }
    await this.dir(`${folder}/video`, true); await this.dir(`${folder}/dati`, true);
    await this.writeJSON(`${folder}/${SESSION_FILE}`, meta);
    return folder;
  },
  /* l'uscita di un giorno: la cerco, e se non c'è la creo (un giorno = un'uscita) */
  async dayFolder(date) {
    const all = await this.listSessions();
    const found = all.find(s => s.meta.date === date);
    if (found) return found.folder;
    return this.createSession(newSessionMeta({ title: 'Uscita', date }));
  },
  saveSession(folder, meta) { meta.modified = Date.now(); return this.writeJSON(`${folder}/${SESSION_FILE}`, meta); },
  async libSettings() { return (await this.readJSON(LIB_FILE)) || { templates: [] }; },
  saveLib(obj) { return this.writeJSON(LIB_FILE, obj); }
};

function newSessionMeta(o = {}) {
  return Object.assign({
    app: 'nacra17-dataviewer', version: 1, created: Date.now(), modified: Date.now(),
    title: '', date: ymdOf(Date.now()), place: '', boat: LS.get('lastBoat', 'Nacra 17'),
    helm: LS.get('lastHelm', ''), crew: LS.get('lastCrew', ''),
    windMin: '', windMax: '', twd: '', sea: '', goals: '', notes: '',
    sources: [], cameras: [], events: [], layout: null, view: {}
  }, o);
}
