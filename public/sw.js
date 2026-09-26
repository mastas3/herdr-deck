// herdr deck service worker: makes the app installable, keeps static assets instant,
// and shows a clear offline page when the Mac can't be reached. Live data is never cached.
const CACHE = "deck-v5";
const ASSETS = [
  "/offline.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-180.png",
  "/fonts/BarlowSemiCondensed-400.woff2", "/fonts/BarlowSemiCondensed-600.woff2", "/fonts/SourceSerif4-400.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const cacheFirst = (req) => caches.match(req).then((hit) => hit || fetch(req).then((res) => {
  if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
}));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/events" || url.pathname === "/health") return;
  if (e.request.mode === "navigate") {
    // The page embeds live state and a session token, so it always comes from the network.
    e.respondWith(fetch(e.request).catch(() => caches.match("/offline.html")));
    return;
  }
  // app.js is requested by content hash (?v=…), so a cached copy is always the right one.
  if ((url.pathname === "/app.js" && url.searchParams.has("v")) || url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/icon")) e.respondWith(cacheFirst(e.request));
});
