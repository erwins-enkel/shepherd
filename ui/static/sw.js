// Shepherd service worker — Web Push only (no offline caching, by design).
// Keep payload shape in sync with PushPayload in src/push.ts.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const { title, body, sessionId, tag } = payload;
  if (!title) return;

  event.waitUntil(
    (async () => {
      // The in-app UI already surfaces every status change live, so an OS banner is
      // pure noise while the user is actively in the app. Suppress whenever any window
      // is focused AND visible. `focused` is the reliable "working here right now"
      // signal — browsers don't report occlusion, so visibility alone would wrongly
      // suppress a window buried behind another app. Requiring both keeps banners
      // flowing when the app is minimized, in the background, or on an unfocused
      // second monitor — exactly when push is useful.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const inUse = clients.some((c) => c.focused && c.visibilityState === "visible");
      if (inUse) return;

      await self.registration.showNotification(title, {
        body: body ?? "",
        tag: tag ?? sessionId,
        renotify: true,
        data: { sessionId },
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const target = sessionId ? "/?session=" + encodeURIComponent(sessionId) : "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        if ("focus" in c) {
          await c.focus();
          if (sessionId) c.postMessage({ type: "select-session", id: sessionId });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
