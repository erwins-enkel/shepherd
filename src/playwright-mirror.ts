/**
 * Playwright browser-download relay for egress-confined sessions. Playwright's Chromium (Chrome
 * for Testing) only lives at `storage.googleapis.com/chrome-for-testing-public/…` (via a 307 from
 * `cdn.playwright.dev`), and the host/IP-level egress firewall cannot allow one GCS path without
 * allowing every bucket. So a confined spawn gets `PLAYWRIGHT_DOWNLOAD_HOST` pointing at the agent
 * ingress, and Shepherd fetches only Playwright-shaped build paths, following redirects only to an
 * allowlisted host + path prefix, streaming the bytes back (nothing kept on disk).
 */

/** HMAC subject for a session's relay token — distinct from the ingress key (`sign(id)`), so the
 *  token in the agent's env grants only public Playwright builds. */
export function playwrightMirrorTokenSubject(sessionId: string): string {
  return `playwright-mirror:${sessionId}`;
}

const CDN = "https://cdn.playwright.dev";
const CFT_RE = /^builds\/cft\/\d+(\.\d+){3}\/[a-z0-9-]+\/[a-z0-9-]+\.zip$/;
const LEGACY_RE = /^builds\/[a-z0-9-]+\/\d+\/[a-z0-9_-][a-z0-9._-]*\.zip$/;

/** The first upstream URL for a Playwright download path (`builds/…`), or null when the path is
 *  not a known Playwright build shape. Mirrors Playwright's own first mirror. */
export function playwrightUpstreamUrl(path: string): string | null {
  if (path.split("/").includes("..")) return null;
  if (CFT_RE.test(path)) return `${CDN}/${path}`;
  if (LEGACY_RE.test(path)) return `${CDN}/dbazure/download/playwright/${path}`;
  return null;
}

const HOPS: Record<string, string> = {
  "cdn.playwright.dev": "/",
  "playwright.download.prss.microsoft.com": "/dbazure/download/playwright/",
  "storage.googleapis.com": "/chrome-for-testing-public/",
};

/** Whether the relay may fetch `raw`: https, default port, no credentials, an allowlisted host
 *  and its path prefix (checked on the normalized path, so `..` cannot climb out). */
export function isAllowedMirrorHop(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  const prefix = HOPS[u.hostname];
  return prefix !== undefined && u.pathname.startsWith(prefix);
}

const MAX_REDIRECTS = 3;
const HEADER_TIMEOUT_MS = 30_000;
const PASS_HEADERS = ["content-type", "content-length"] as const;

const empty = (status: number) => new Response(null, { status });

/** The absolute redirect target of `res`, or null when it isn't a redirect. */
function redirectTarget(res: Response, from: string): string | null {
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) return null;
  return new URL(location, from).toString();
}

/** A 200 upstream response re-wrapped with only the headers Playwright's downloader reads. */
function streamed(res: Response): Response {
  const headers = new Headers();
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new Response(res.body, { status: 200, headers });
}

/** Follow allowlisted redirects from `url`; resolves to the final response or an error status. */
async function fetchFollowing(
  url: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url, { redirect: "manual", signal });
    const next = redirectTarget(res, url);
    if (next === null) {
      if (res.status === 200) return streamed(res);
      await res.body?.cancel();
      return empty(res.status);
    }
    await res.body?.cancel();
    if (!isAllowedMirrorHop(next)) {
      console.warn(`[playwright-mirror] refused redirect to ${next}`);
      return empty(502);
    }
    url = next;
  }
  return empty(502);
}

/** Fetch a Playwright build for `path` and return it as a streamed response: 404 off-shape, 502
 *  on a disallowed redirect / too many redirects / fetch error, 504 when headers don't arrive in
 *  time, the upstream status (no body) when it isn't 200. */
export async function relayPlaywrightBuild(
  path: string,
  fetchFn: typeof fetch = fetch,
  opts: { headerTimeoutMs?: number } = {},
): Promise<Response> {
  const url = playwrightUpstreamUrl(path);
  if (url === null) return empty(404);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS);
  try {
    return await fetchFollowing(url, fetchFn, ctrl.signal);
  } catch {
    return empty(ctrl.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}
