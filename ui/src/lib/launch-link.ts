/** `web+shepherd://` link handling (issue #2547). The installed PWA registers the scheme
 *  via the manifest's protocol_handlers (→ `/?link=%s`); launch_handler `focus-existing`
 *  routes a link into the open window's launchQueue instead of a new page load. */

const SESSION_LINK = /^web\+shepherd:\/\/session\/([^/?#]+)\/?$/i;

/** Session id from `web+shepherd://session/<percent-encoded id>`, else null. */
export function sessionIdFromLink(link: string | null): string | null {
  const m = link ? SESSION_LINK.exec(link) : null;
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

/** Session id from a launch target URL's `link` query param, else null. */
export function sessionIdFromLaunchUrl(targetURL: string): string | null {
  try {
    return sessionIdFromLink(new URL(targetURL).searchParams.get("link"));
  } catch {
    return null;
  }
}

type LaunchQueue = { setConsumer(cb: (params: { targetURL?: string }) => void): void };

/** Calls cb with the session id of each link launched into this window (Chromium only;
 *  no-op elsewhere). setConsumer replaces any earlier consumer, so no disposer. */
export function onLaunchLink(cb: (id: string) => void): void {
  const queue = (window as { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer((params) => {
    const id = params.targetURL ? sessionIdFromLaunchUrl(params.targetURL) : null;
    if (id) cb(id);
  });
}
