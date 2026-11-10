// N17 Debrief e Live: tiene in cache l'app per aprirla anche senza rete.
// I file dell'app si scaricano prima dalla rete (così gli aggiornamenti arrivano subito)
// e, se la rete manca o è lenta, dalla cache. Le mappe di sfondo non vanno in cache.
// I video e i dati non passano mai di qui: restano sul disco del Mac.
const CACHE = 'n17-dataviewer-v36';
const FILES = ['./', './index.html', './css/app.css',
  './js/util.js', './js/freegrid.js', './js/mp4.js', './js/parse.js', './js/tracks.js', './js/store.js', './js/session.js', './js/sync.js', './js/mqtt.js', './js/live.js', './js/dash.js', './js/demo.js', './js/home.js', './js/editor.js', './js/panels.js', './js/analysis.js', './js/wind.js', './js/sailing.js', './js/boat3d.js', './js/compare.js', './js/perf.js', './js/quadro.js', './js/viewer.js', './js/app.js',
  './lib/uPlot.iife.min.js', './lib/three.module.min.js', './lib/uPlot.min.css', './lib/leaflet.js', './lib/leaflet.css', './lib/images/layers.png', './lib/images/layers-2x.png', './manifest.json', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // mappe e altro: direttamente dalla rete
  e.respondWith(caches.open(CACHE).then(cache => {
    const net = fetch(req, { cache: 'no-cache' }).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; });
    const timeout = new Promise(r => setTimeout(r, 3500));
    return Promise.race([net.catch(() => null), timeout]).then(async res => res || (await cache.match(req, { ignoreSearch: true })) || net);
  }));
});
