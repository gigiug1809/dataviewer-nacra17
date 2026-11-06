/* Utilità comuni */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const p2 = n => String(n).padStart(2, '0');
const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KN = 1.9438445; // m/s -> nodi

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/* ---------- Formati di numeri e orari ---------- */
const NF = {};
function fmtNum(v, dec = 1) {
  if (v == null || !isFinite(v)) return '—';
  const k = dec;
  NF[k] = NF[k] || new Intl.NumberFormat('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return NF[k].format(v);
}
function fmtClock(ms, withTenths) {
  if (ms == null || !isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  let s = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  if (withTenths) s += '.' + Math.floor(d.getMilliseconds() / 100);
  return s;
}
function fmtDur(ms) {
  if (!isFinite(ms)) return '—';
  const neg = ms < 0; ms = Math.abs(ms);
  const s = Math.round(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
  const out = hh ? `${hh} h ${p2(mm)} min` : mm ? `${mm} min ${p2(ss)} s` : `${ss} s`;
  return (neg ? '−' : '') + out;
}
function fmtOffset(ms) {
  const neg = ms < 0; let a = Math.abs(ms) / 1000;
  const hh = Math.floor(a / 3600); a -= hh * 3600;
  const mm = Math.floor(a / 60); a -= mm * 60;
  const s = a.toFixed(2).padStart(5, '0').replace('.', ',');
  return (neg ? '−' : '+') + (hh ? `${hh} h ${p2(mm)} min ${s} s` : mm ? `${mm} min ${s} s` : `${a.toFixed(2).replace('.', ',')} s`);
}
const DATE_FMT = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
function fmtDateLong(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return DATE_FMT.format(new Date(y, m - 1, d));
}
function ymdOf(ms) { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function fmtBytes(b) {
  if (b >= 1e9) return fmtNum(b / 1e9, 1) + ' GB';
  if (b >= 1e6) return fmtNum(b / 1e6, 0) + ' MB';
  return fmtNum(b / 1e3, 0) + ' kB';
}
function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'uscita';
}
function errMsg(e) { return (e && (e.message || e.name)) || String(e); }

/* ---------- Avvisi e finestre ---------- */
let toastTimer = 0;
function toast(msg, ms = 4200, kind = '') {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, ms);
}
function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', title: 'Chiudi', 'aria-label': 'Chiudi', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map(a => h('button', { class: 'btn ' + (a.kind || ''), onclick: async () => { const r = await a.run?.(); if (r !== false) close(); } }, a.label))) : null);
  back.append(box);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  const f = box.querySelector('input,textarea,select'); if (f) setTimeout(() => f.focus(), 30);
  return { close, box };
}
function confirmBox(title, text, okLabel = 'Conferma', danger = false) {
  return new Promise(res => {
    let ok = false;
    modal({ title, body: h('p', null, text), onClose: () => res(ok), actions: [{ label: 'Annulla' }, { label: okLabel, kind: danger ? 'danger' : 'primary', run: () => { ok = true; } }] });
  });
}
function promptBox(title, label, value = '') {
  return new Promise(res => {
    let out = null;
    const inp = h('input', { type: 'text', value, class: 'full' });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { out = inp.value; m.close(); } });
    const m = modal({ title, body: h('label', { class: 'f' }, label, inp), onClose: () => res(out), actions: [{ label: 'Annulla' }, { label: 'OK', kind: 'primary', run: () => { out = inp.value; } }] });
  });
}

/* ---------- IndexedDB minimale (per ricordare la cartella della libreria) ---------- */
const KV = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('nacra-dataviewer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  async del(k) { const db = await this.open(); return new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = () => res(); }); }
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem('n17dv.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('n17dv.' + k, JSON.stringify(v)); } catch (e) { /* storage non disponibile */ } }
};

function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function downloadText(name, text, type = 'text/csv') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
