const CACHE = 'medicipate-production-v3';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/assets/medicipate-logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only handle requests belonging to MEDICIPATE.
  if (url.origin !== self.location.origin) return;

  // Never cache Netlify backend/API requests.
  if (url.pathname.startsWith('/.netlify/functions/')) return;

  /*
   * APPLICATION HTML
   *
   * Always prefer the newest version from the network.
   * This prevents an old index.html containing old
   * Library/Premium/payment code from remaining stuck
   * in the browser cache.
   */
  if (
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  ) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => response)
        .catch(() => caches.match('/index.html'))
    );

    return;
  }

  /*
   * SERVICE WORKER
   *
   * Always fetch the newest sw.js from the server.
   */
  if (url.pathname === '/sw.js') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
    );

    return;
  }

  /*
   * STATIC ASSETS
   *
   * Network first, cached copy only if offline.
   */
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE)
            .then(cache => cache.put(event.request, copy))
            .catch(() => {});
        }

        return response;
      })
      .catch(() =>
        caches.match(event.request)
          .then(cached =>
            cached || caches.match('/index.html')
          )
      )
  );
});
