// Offline support: the app shell + data are precached; map tiles are cached as they are viewed.
const SHELL = 'shell-v2';
const TILES = 'tiles-v1';
const MAX_TILES = 6000;
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'data/places.json',
  'app/app.js', 'app/style.css', 'app/icon.svg', 'app/icon-192.png', 'app/icon-512.png',
  'app/vendor/leaflet/leaflet.js', 'app/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Map tiles: cache-first, keep what was seen so the map works offline later.
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) { cache.put(e.request, res.clone()); trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    }));
    return;
  }

  // App files: serve from cache, refresh in the background when online.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
      return hit || (await fresh) || new Response('offline', { status: 503 });
    }));
  }
});
