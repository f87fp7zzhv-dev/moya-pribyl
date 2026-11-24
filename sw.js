const CACHE_NAME = "moya-pribyl-pwa-v13";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./sync.js",
  "./manifest.webmanifest",
  "./maia-icon.svg",
  "./maia-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith("http")) return;
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  event.respondWith(
    fetch(request)
      .then(response => {
        if (sameOrigin && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Only navigations may fall back to the app shell. Returning index.html
        // for a failed API call would hand JSON/HTML to the caller and hide the real error.
        if (request.mode === "navigate" && sameOrigin) return caches.match("./index.html");
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      })
  );
});
