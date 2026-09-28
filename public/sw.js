// herdr deck service worker: makes the app installable, keeps static assets instant,
// shows a clear offline page when the Mac can't be reached, and shows push notifications from the hub.
// Live data is never cached.
const CACHE = "deck-v9"; // v9 drops v8's per-weight copies of the variable fonts
// Served under a content hash (?v=…, src/assets.ts): everything public/assets.json names, and running plugins' files.
const HASHED = /^\/(?:js\/[\w.-]+\.js|css\/[\w.-]+\.css|plugins\/[a-z0-9][a-z0-9-]{1,39}\/(?:[\w.-]+\/){0,3}[\w.-]+\.(?:js|css))$/;
const ASSETS = [
  "/offline.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-180.png",
  "/fonts/BarlowSemiCondensed-400.woff2", "/fonts/BarlowSemiCondensed-600.woff2", "/fonts/SourceSerif4.woff2",
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
/** A hashed asset: the cached copy is always the right one; a new version replaces the older ones of the same file. */
const cacheHashed = (req) => caches.match(req).then((hit) => hit || fetch(req).then((res) => {
  if (res.ok) {
    const copy = res.clone(), path = new URL(req.url).pathname;
    caches.open(CACHE).then(async (c) => {
      await c.put(req, copy);
      for (const k of await c.keys()) { const u = new URL(k.url); if (u.pathname === path && k.url !== req.url) await c.delete(k); }
    });
  }
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
  if (HASHED.test(url.pathname) && url.searchParams.has("v")) { e.respondWith(cacheHashed(e.request)); return; }
  if (url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/icon")) e.respondWith(cacheFirst(e.request));
});

// ── push ──────────────────────────────────────────────────────────────────
// The hub encrypts each message for this device (RFC 8291); the browser decrypts it before this runs.
// Every push shows a notification: iOS stops delivering to apps that receive pushes silently.
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : "" }; }
  const title = m.title || "herdr deck";
  const opts = {
    body: m.body || "",
    tag: m.tag || undefined, // one notification per session: a newer one replaces it
    renotify: !!m.tag && m.kind !== "digest",
    data: { url: m.url || "/", kind: m.kind, at: m.at || Date.now() },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    timestamp: m.at || Date.now(),
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    if (typeof m.badge === "number" && self.navigator.setAppBadge) {
      try { m.badge ? await self.navigator.setAppBadge(m.badge) : await self.navigator.clearAppBadge(); } catch {}
    }
    // Open pages hear about it too (they confirm a test arrived).
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) c.postMessage({ type: "push", data: { title, ...m } });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      // An open deck switches to the session in place, without reloading.
      try { await win.focus(); } catch {}
      win.postMessage({ type: "open", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The browser rotated the subscription: the page re-registers it with the hub the next time it opens.
self.addEventListener("pushsubscriptionchange", (e) => {
  const key = e.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  e.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => {}));
});
