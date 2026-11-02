// Service worker: keeps the app shell on the device so it opens with no internet.
// API calls (/api/...) are never cached; data lives in IndexedDB.
const VERSION = 'qe-0.3.0';
const SHELL = [
  './',
  './core/connector-core.js',
  './core/defaults.js',
  './core/relay-api.js',
  './core/relay-core.js',
  './core/tally-sim.js',
  './core/tally-xml.js',
  './core/types.js',
  './core/users-core.js',
  './core/vat.js',
  './core/xml.js',
  './css/app.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './index.html',
  './js/api.js',
  './js/db.js',
  './js/demo-backend.js',
  './js/docs.js',
  './js/main.js',
  './js/owner.js',
  './js/sync.js',
  './manifest.webmanifest',
  './owner.html',
  './vendor/jspdf.umd.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // Cache first, then refresh in the background so the next open gets updates.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (await c.match('./index.html')) || new Response('Offline', { status: 503 });
  }));
});
