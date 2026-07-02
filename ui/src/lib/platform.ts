/** True on macOS/iOS user agents. SSR-safe: returns false when `navigator` is
 *  unavailable (server render), so callers get the non-Mac default until hydration. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}
