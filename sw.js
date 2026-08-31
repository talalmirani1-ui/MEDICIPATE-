const CACHE = 'medicipate-shell-v2'; // Incremented version to clear old cache bugs
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/Assets/medicipate-logo.png',
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // 1. Only intercept GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 2. CRUCIAL: Do NOT intercept or cache external Supabase database requests
  if (url.origin.includes('supabase.co')) return;

  // 3. Do NOT intercept local authentication redirects, tokens, or Netlify API handlers
  if (
    url.pathname.includes('/auth/') || 
    url.pathname.includes('token') ||
    url.pathname.startsWith('/.netlify/functions/')
  ) {
    return;
  }

  // 4. Do NOT cache requests containing authentication hash metrics or query codes from email links
  if (url.search.includes('code=') || url.hash.includes('access_token=')) {
    return;
  }

  // 5. Only handle requests bound for your main website origin
  if (url.origin !== self.location.origin) return;

  // 6. Network-First, Asset Fallback strategy for clean app performance
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Safe check: Only cache successful standard web page responses
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE)
            .then(cache => cache.put(event.request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => {
        // Offline Fallback handling
        return caches.match(event.request)
          .then(cached => cached || caches.match('/index.html'));
      })
  );
});
