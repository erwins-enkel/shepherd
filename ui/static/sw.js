// Shepherd service worker — Web Push only (no offline caching, by design).
// Keep payload shape in sync with PushPayload in src/push.ts.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  // Under userVisibleOnly the browser substitutes its own generic "site updated
  // in background" banner whenever a push is received but the worker shows no
  // notification — so every received push must reach showNotification. Parse
  // inside waitUntil and guard both the read and the decode so a malformed
  // payload can't let the event settle silently (which on mobile = that banner).
  event.waitUntil(
    (async () => {
      let payload = null;
      try {
        payload = event.data ? JSON.parse(event.data.text()) : null;
      } catch {
        payload = null;
      }
      if (!payload) return;
      const { body, sessionId, tag, kind } = payload;
      // buildPayload always sets a title; fall back to the app name so a payload
      // that somehow lacks one still surfaces a real banner rather than letting the
      // event settle (which on mobile yields the browser's generic banner).
      const title = payload.title || "Shepherd";

      // Always show — on every platform. Suppression-while-active is decided
      // server-side (the server doesn't send a push while any window reports it's
      // in use, via /events presence), so every push that reaches here is meant to
      // be shown. A worker can't reliably drop a push under userVisibleOnly anyway:
      // the browser substitutes its own generic banner, so suppressing here would
      // be worse than useless on mobile. (Supersedes the SW-side gate of #121/#126.)
      const opts = {
        body: body ?? "",
        tag: tag ?? sessionId,
        renotify: true,
        data: { sessionId, kind },
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
      };
      try {
        await self.registration.showNotification(title, opts);
      } catch {
        // A notification MUST be shown under userVisibleOnly; retry with the
        // minimal option set if the rich options were rejected.
        await self.registration.showNotification(title, { body: opts.body, tag: opts.tag });
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const kind = event.notification.data?.kind;
  // Learnings-retire pushes (issue #852) aren't session-scoped: open the Learnings drawer
  // instead of selecting a session. An open (possibly backgrounded) window is reopened in
  // place via postMessage; only when no window exists do we openWindow the URL-param route.
  const learnings = kind === "learnings_retired";
  const target = learnings
    ? "/?learnings=1"
    : sessionId
      ? "/?session=" + encodeURIComponent(sessionId)
      : "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        if ("focus" in c) {
          await c.focus();
          if (learnings) c.postMessage({ type: "open-learnings" });
          else if (sessionId) c.postMessage({ type: "select-session", id: sessionId });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
