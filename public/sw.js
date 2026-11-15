// Service worker for the installed app.
//
// It caches the app shell so Pol opens instantly and still loads without a
// network. It never touches the signaling endpoint or the ICE config: those
// decide whether a transfer can happen at all, and a stale copy would lie.

const VERSION = 'pol-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

/** Things that must always come from the network. */
const NEVER_CACHE = [/^\/signal/, /^\/healthz/, /^\/ice/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // addAll fails the whole install if one file 404s; add them one by one.
      await Promise.all(
        SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === 'navigate') {
    // Fresh page when possible; the cached shell keeps the app usable offline.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(VERSION);
          cache.put('/index.html', response.clone()).catch(() => undefined);
          return response;
        } catch {
          return (await caches.match('/index.html')) ?? (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed assets never change: serve from cache and refresh in the background.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) {
        // Fire-and-forget refresh: waitUntil() is only valid during dispatch,
        // and the cached copy is already being handed to the page.
        void fetch(request)
          .then(async (response) => {
            if (response.ok) (await caches.open(VERSION)).put(request, response.clone());
          })
          .catch(() => undefined);
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(VERSION);
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      } catch {
        return Response.error();
      }
    })(),
  );
});
