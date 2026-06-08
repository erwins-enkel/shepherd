// Host-permission lifecycle for the configured Shepherd base URL.
//
// The local core (`http://localhost:7330`) is covered by the static
// `host_permissions` entry, so it needs no prompt. A remote core reached over
// Tailscale (`https://<host>.ts.net`) is NOT statically granted — it needs the
// optional host permission, requested on demand from the options Save gesture.
// This mirrors recorder-control's `chrome.permissions.request` flow and is the
// piece that lets the two shipped capture phases be exercised over Tailscale.
//
// Only localhost + `*.ts.net` are supported; any other host is rejected up front
// (the manifest only declares those optional patterns, so a request for anything
// else would fail anyway).

export type HostKind = "local" | "remote" | "unsupported";

/** Parse the base URL; null when it isn't a valid absolute URL. */
function parse(baseUrl: string): URL | null {
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}

/**
 * Classify a base URL:
 * - `local` — `http://localhost` (covered by the static host permission),
 * - `remote` — an `https://<host>.ts.net` Tailscale core (needs the optional
 *   host permission),
 * - `unsupported` — anything else (blocked; not declared in the manifest).
 */
export function hostKind(baseUrl: string): HostKind {
  const u = parse(baseUrl);
  if (!u) return "unsupported";
  if (u.protocol === "http:" && u.hostname === "localhost") return "local";
  if (u.protocol === "https:" && u.hostname.endsWith(".ts.net")) return "remote";
  return "unsupported";
}

/** The `origin/*` match pattern for a base URL (e.g. `https://h.ts.net/*`). */
export function originPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

/**
 * True when the extension already holds the host permission for this base URL.
 * Local + unsupported hosts resolve true (local is static; unsupported never
 * reaches a fetch because Save rejects it).
 */
export function hasHostPermission(baseUrl: string): Promise<boolean> {
  if (hostKind(baseUrl) !== "remote") return Promise.resolve(true);
  return chrome.permissions.contains({ origins: [originPattern(baseUrl)] });
}

/**
 * Request the optional host permission for a remote base URL. Must be called
 * from a user gesture (the options Save click). Returns true for local hosts
 * (nothing to request) and for an already-granted remote host (no prompt).
 */
export function requestHostPermission(baseUrl: string): Promise<boolean> {
  if (hostKind(baseUrl) !== "remote") return Promise.resolve(true);
  return chrome.permissions.request({ origins: [originPattern(baseUrl)] });
}
