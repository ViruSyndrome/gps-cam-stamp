const CACHE = 'gpscamstamp-v3';
const PRECACHE = [
  '/',
  '/index.html?v=3',
  '/style.css?v=3',
  '/script.js?v=3',
  '/manifest.json',
  '/assets/favicon.svg',
  '/assets/og-image.webp'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET requests for same-origin or OSM/open-meteo assets
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Network-first for API calls (geocoding, weather, map tiles) — never stale
  const isApi = url.hostname.includes('nominatim') ||
                url.hostname.includes('open-meteo') ||
                url.hostname.includes('openstreetmap.org');
  if (isApi) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Cache-first for app shell and static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
