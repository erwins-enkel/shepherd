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
      const { body, sessionId, tag } = payload;
      // buildPayload always sets a title; fall back to the app name so a payload
      // that somehow lacks one still surfaces a real banner rather than letting the
      // event settle (which on mobile yields the browser's generic banner).
      const title = payload.title || "Shepherd";

      // The in-app UI already surfaces every status change live, so an OS banner is
      // pure noise while the user is actively in the app. Suppress whenever any window
      // is focused AND visible. `focused` is the reliable "working here right now"
      // signal — browsers don't report occlusion, so visibility alone would wrongly
      // suppress a window buried behind another app. Requiring both keeps banners
      // flowing when the app is minimized, in the background, or on an unfocused
      // second monitor — exactly when push is useful.
      //
      // Desktop only: on mobile, a worker that receives a push without showing a
      // notification gets the browser's generic banner instead — strictly worse
      // than our real one — so mobile always shows. (#121 follow-up.)
      //
      // UA sniffing is the only signal available here — WorkerNavigator exposes no
      // maxTouchPoints, so iPadOS in desktop mode (Macintosh UA) isn't detected and
      // would still suppress when in-use. Negligible: iOS/iPadOS only delivers Web
      // Push to an installed PWA, and the failure mode is a missed banner, not a bad one.
      const ua = self.navigator && self.navigator.userAgent ? self.navigator.userAgent : "";
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
      if (!isMobile) {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const inUse = clients.some((c) => c.focused && c.visibilityState === "visible");
        if (inUse) return;
      }

      const opts = {
        body: body ?? "",
        tag: tag ?? sessionId,
        renotify: true,
        data: { sessionId },
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
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
