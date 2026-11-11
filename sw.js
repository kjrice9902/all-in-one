// Offline support for the hosted (https) copy of All in One.
// Network first so updates show up right away; the cached copy is used when there is no connection.
// Only the app's own files are cached — records and documents stay in the browser's own storage.
const CACHE = 'all-in-one-20261111140152';
const NETWORK_TIMEOUT_MS = 5000;
const CALENDAR_CACHE = 'all-in-one-calendar';
// The text reader for the medication screenshot scan (about 11 MB). It is kept in its own cache,
// so it downloads once, not again with every app update. Change the name only when these files change.
const OCR_CACHE = 'all-in-one-ocr-5.1.1';
const OCR_FILES = [
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/eng.traineddata.gz'
];
const APP_FILES = [
  './',
  './index.html',
  './all-in-one.js',
  './sync.js',
  './manifest.json',
  './icon.png',
  './icon-header.png',
  './vendor/tailwindcss.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/jspdf/jspdf.umd.min.js',
  './vendor/jspdf/jspdf.plugin.autotable.min.js'
];

self.addEventListener('install', (event) => {
  // Save the text reader for offline use (only downloads once; a failure is tried again next time and
  // never stops the update). It is inside waitUntil so the browser does not stop the download partway.
  const saveReader = caches.open(OCR_CACHE).then((cache) => Promise.all(OCR_FILES.map((f) =>
    cache.match(f).then((hit) => hit || cache.add(f))))).catch(() => {});
  event.waitUntil(Promise.all([
    caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)),
    saveReader
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only this app's old caches: other projects on the same github.io address keep theirs
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('all-in-one') && k !== CACHE && k !== CALENDAR_CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // "Add to Calendar" on iPhone: the app stores the event here, and Safari opens it as a calendar card
  if (new URL(req.url).pathname.includes('/calendar/')) {
    event.respondWith(caches.open(CALENDAR_CACHE)
      .then((cache) => cache.match(req, { ignoreSearch: true }))
      .then((hit) => hit || new Response('This calendar event is no longer available. Go back and tap Add to Calendar again.', { status: 404 })));
    return;
  }
  // Text reader files never change for a given version: use the saved copy first
  if (new URL(req.url).pathname.includes('/vendor/tesseract/')) {
    event.respondWith(caches.open(OCR_CACHE).then((cache) => cache.match(req, { ignoreSearch: true }).then((hit) => hit ||
      fetch(req).then((res) => { if (res.status === 200) cache.put(req, res.clone()).catch(() => {}); return res; }))));
    return;
  }
  const fromCache = () => caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
  // Always ask the server whether a file changed (GitHub Pages otherwise lets browsers reuse a copy
  // for 10 minutes), so a new version shows up the next time the app opens
  const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    .then((res) => {
      // Only complete answers can be saved (a partial 206 answer can't)
      if (res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      // A server error page: the saved copy is better, when there is one
      if (!res.ok) return fromCache().then((hit) => hit || res);
      return res;
    });
  const networkOrCache = network.catch(() => fromCache().then((hit) => hit || Response.error()));
  let response = networkOrCache;
  if (req.mode === 'navigate') {
    // On a very weak signal, open the saved copy after a few seconds instead of waiting for the network
    // (with no saved copy, keep waiting for the network)
    const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS)).then(fromCache).then((hit) => hit || networkOrCache);
    response = Promise.race([networkOrCache, slow]);
  }
  event.respondWith(response);
});
