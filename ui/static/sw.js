// Shepherd service worker — Web Push only (no offline caching, by design).
// Keep payload shape in sync with PushPayload in src/push.ts.

// clientId -> the session id that client is currently viewing
const activeSessions = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "active-session" && event.source) {
    activeSessions.set(event.source.id, data.id ?? null);
  }
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const { title, body, sessionId, kind, tag } = payload;
  if (!title) return;

  event.waitUntil(
    (async () => {
      // Suppress a "done" banner if a focused, visible tab is already on that session.
      if (kind === "done") {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const onIt = clients.some(
          (c) =>
            c.focused && c.visibilityState === "visible" && activeSessions.get(c.id) === sessionId,
        );
        if (onIt) return;
      }
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
