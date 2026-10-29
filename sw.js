const CACHE_NAME = "zr-shell-v11";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./data/chahuites-roads.geojson"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("zr-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin) {
    const isScriptOrStyle = /\.(js|css)$/i.test(url.pathname);
    const isHtml = !isScriptOrStyle && (request.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/"));
    if (isHtml) {
      event.respondWith(fetch(request).then(response => {
        if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
        return response;
      }).catch(() => caches.match(request, { ignoreSearch: true }).then(cached => cached || caches.match("./index.html"))));
      return;
    }
    // Un .js o .css solo se sirve si la respuesta es correcta y no es HTML; si falla (con o sin internet) devuelve error de red, nunca index.html.
    const usable = response => !!response && response.ok && !(isScriptOrStyle && /text\/html/i.test(response.headers.get("content-type") || ""));
    event.respondWith(caches.match(request).then(cached => usable(cached) ? cached : fetch(request).then(response => {
      if (!usable(response)) return isScriptOrStyle ? Response.error() : response;
      if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".json") || url.pathname.endsWith(".geojson") || url.pathname.endsWith(".svg")) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request, { ignoreSearch: true }).then(fallback => usable(fallback) ? fallback : Response.error()))));
  }
});
