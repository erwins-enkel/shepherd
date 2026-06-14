// Client-only PWA install detection for the Diagnostics tab (issue #662).
// Whether Shepherd runs installed (standalone) vs. in a browser tab is knowable
// ONLY in the browser — never on the server — so this never touches /api/diagnostics.
//
// Why it matters: Shepherd's PWA exists for Web Push. On iOS, Apple exposes Web
// Push *only* to web apps installed to the Home Screen (iOS 16.4+, unchanged
// through iOS 26) — in a plain Safari tab there is zero push. So an iOS user in a
// tab silently gets none of Shepherd's notifications.

export type PwaRowState = "installed" | "ios" | "android" | "optional";

/** True when running as an installed/standalone PWA (incl. iOS Safari's legacy flag). */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari legacy, not covered by display-mode:
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Classify the PWA install situation for the Diagnostics row. SSR-safe (returns
 *  the neutral "optional" so we never nag without a real browser to inspect). */
export function pwaRowState(): PwaRowState {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "optional";
  if (isStandalone()) return "installed";

  const ua = navigator.userAgent || "";
  const isIOS =
    /iphone|ipad|ipod/i.test(navigator.platform || ua) ||
    // iPadOS 13+ reports a Mac UA; disambiguate by touch.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (isIOS) return "ios";
  if (/android/i.test(ua)) return "android";

  // Desktop / other / push-unsupported in a tab: push works without installing,
  // so installing is genuinely optional here — never a warning.
  return "optional";
}
