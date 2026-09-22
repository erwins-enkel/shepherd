/** True on macOS/iOS user agents. SSR-safe: returns false when `navigator` is
 *  unavailable (server render), so callers get the non-Mac default until hydration. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

/** macOS only, for native app downloads. iPadOS can report MacIntel in desktop mode. */
export function isMacOSPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /mac/i.test(navigator.platform || navigator.userAgent) &&
    !/iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !(navigator.maxTouchPoints > 1)
  );
}
