// HTTP policy for the prebuilt UI bundle served by `serveStatic` (src/server.ts). Pure so the
// cache/encoding rules are unit-testable without a build on disk.
//
// Why it matters: a phone on a slow, lossy link (in-flight Wi-Fi) could not finish booting the
// PWA — every open re-downloaded ~4.8 MB raw with nothing cacheable, so a single dropped chunk
// restarted the whole transfer. Hashed chunks are immutable (cache forever); everything else
// revalidates by ETag; text assets ship the `.br`/`.gz` siblings `ui/scripts/precompress.ts`
// writes at build time (never compressed on the request path — one event loop serves the HUD).

export type Encoding = "br" | "gzip";

/** Suffix of the precompressed sibling file for each encoding. */
export const ENCODING_SUFFIX: Record<Encoding, string> = { br: ".br", gzip: ".gz" };

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/** `relPath` is relative to the build dir, no leading slash. */
export function cacheControlFor(relPath: string): string {
  return relPath.startsWith("_app/immutable/") ? IMMUTABLE : REVALIDATE;
}

/** Asset paths never fall back to `index.html`: a missing chunk must 404, not 200 `text/html`. */
export function isAssetPath(relPath: string): boolean {
  return relPath.startsWith("_app/");
}

/** Encodings worth precompressing (and therefore worth looking for a sibling of). */
export function isCompressible(relPath: string): boolean {
  return /\.(js|css|html|svg|json|webmanifest|txt)$/.test(relPath);
}

/** Best encoding the client accepts, preferring brotli. `q=0` means "not acceptable". */
export function pickEncodings(acceptEncoding: string | null): Encoding[] {
  if (!acceptEncoding) return [];
  const accepted = new Set<string>();
  for (const part of acceptEncoding.toLowerCase().split(",")) {
    const [token, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    if (token) accepted.add(token.trim());
  }
  return (["br", "gzip"] as const).filter((e) => accepted.has(e) || accepted.has("*"));
}

/** Weak validator from the served file's size + mtime, distinct per encoding variant. */
export function etagFor(size: number, mtimeMs: number, encoding: Encoding | null): string {
  return `W/"${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}${encoding ? `-${encoding}` : ""}"`;
}

/** True when an `If-None-Match` header already holds `etag` (weak comparison). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => bare(t) === bare(etag));
}
