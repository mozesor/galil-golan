/* service worker: push notifications + app badge only. No caching, the page handles offline itself. */
const BADGE_CACHE = "gd-badge";

async function getBadge() {
  try { const c = await caches.open(BADGE_CACHE); const r = await c.match("/badge"); return r ? (+(await r.text()) || 0) : 0; } catch { return 0; }
}
async function setBadge(n) {
  try { const c = await caches.open(BADGE_CACHE); await c.put("/badge", new Response(String(n))); } catch {}
  try { if (n > 0 && self.registration.setAppBadge) await self.registration.setAppBadge(n); else if (self.registration.clearAppBadge) await self.registration.clearAppBadge(); } catch {}
  try { if (n > 0 && navigator.setAppBadge) await navigator.setAppBadge(n); else if (navigator.clearAppBadge) await navigator.clearAppBadge(); } catch {}
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "לוח המשחקים", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    const n = (await getBadge()) + 1;
    await setBadge(n);
    await self.registration.showNotification(d.title || "לוח המשחקים", {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "icons/crest-192.png?v=5",
      badge: "icons/crest-192.png?v=5",
      lang: "he",
      dir: "rtl",
      data: { url: d.url || "./" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    await setBadge(0);
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const inScope = all.find((c) => c.url.startsWith(self.registration.scope));
    if (inScope) { try { await inScope.focus(); await inScope.navigate(url); } catch {} return; }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener("message", (e) => { if (e.data === "clear-badge") e.waitUntil(setBadge(0)); });
