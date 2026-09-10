// Service worker: shows push notifications even when the app is closed.
self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || "JFK Receiving", {
      body:  data.body || "",
      icon:  "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag:   data.tag || undefined,
      data:  { url: data.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes("receiving") && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
