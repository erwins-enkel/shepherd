/** Client-side namespace guard for a plugin route path, mirroring the server's validRoutePath
 *  (defense in depth): non-empty, length-capped, safe charset, no leading "/", no ".." segment. */
export function safePath(x: string): boolean {
  if (x.length === 0 || x.length > 256 || x.startsWith("/")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(x)) return false;
  return !x.split("/").some((seg) => seg === "..");
}
