const CACHE = 'sentinel-taiwan-shell-v200cf';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/assets/icon.svg', '/assets/taiwan-silhouette.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((u)=>new Request(u,{cache:'reload'})))).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('sentinel-taiwan-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', (event) => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  const isCore = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'].includes(url.pathname);
  if (isCore) {
    event.respondWith(fetch(new Request(event.request,{cache:'reload'})).then((res)=>{ const copy=res.clone(); caches.open(CACHE).then((c)=>c.put(event.request,copy)); return res; }).catch(()=>caches.match(event.request).then((r)=>r||caches.match('/index.html'))));
    return;
  }
  event.respondWith(fetch(event.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)); return res; }).catch(() => caches.match(event.request).then((r) => r || caches.match('/index.html'))));
});
