/* SQLPlayground service worker: network-first for every same-origin file, each cached on its own,
   with a versioned cache and an offline fallback. The DuckDB engine (.wasm) and its extensions are
   cached after the first successful load so the whole app, engine included, works offline. */
const CACHE = 'sqlplayground-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './core.js', './db.js', './grid.js', './chart.js', './editor.js', './samples.js',
  './vendor/lib.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((a) => c.add(new Request(a, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('sqlplayground-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
// The page asks us to make sure the big engine files are cached (they may have loaded before this worker took control).
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'warm' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(d.urls.filter((u) => new URL(u).origin === location.origin).map(async (u) => {
    if (await c.match(u)) return;
    try { const res = await fetch(u); if (res.ok && res.status === 200) await c.put(u, res); } catch { /* offline */ }
  }))));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || req.headers.has('range')) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res && res.status === 200 && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html').then((i) => i || caches.match('./')) : undefined))
    .then((r) => r || Response.error())));
});
