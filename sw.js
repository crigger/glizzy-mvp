// Glizzy service worker
// Strategy:
//   - On install: pre-cache the app shell + assets (HTML, CSS-in-HTML, fonts, icons).
//   - On activate: clean out caches from old versions.
//   - On fetch (same-origin):
//       * navigations / HTML  → network-first, cache fallback (so deploys land fast).
//       * everything else      → cache-first, network fallback + write-through.

const VERSION    = 'v3';
const CACHE_NAME = `glizzy-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/site.webmanifest',
  // icons
  '/icon.svg',
  '/icon-2c.svg',
  '/icon-2c--padded.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-1024.png',
  // fonts (woff2)
  '/fonts/SequoiaSans-Thin.woff2',
  '/fonts/SequoiaSans-Light.woff2',
  '/fonts/SequoiaSans-Regular.woff2',
  '/fonts/SequoiaSans-Wide.woff2',
  '/fonts/BNMagnolia.woff2',
  '/fonts/BricolageGrotesque-VF.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll fails atomically if any URL 404s. Use individual puts so a single
      // missing asset doesn't break the whole install.
      Promise.allSettled(PRECACHE.map((url) =>
        fetch(url, { cache: 'reload' }).then((res) => res.ok && cache.put(url, res))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // skip cross-origin (CDN scripts etc)

  const isNavigation = req.mode === 'navigate'
    || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));

  if (isNavigation) {
    // Network-first for HTML so new deploys propagate immediately when online.
    event.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      });
    })
  );
});
