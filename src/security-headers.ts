/**
 * Anti-framing + targeted CSP stamped on every HUD response (#2099, audit N04/N05).
 *
 * - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`: a preview slot is served on the
 *   HUD's own host at another port — same-site, so the SameSite=Strict cookie rides along — and
 *   agent HTML there could frame the logged-in HUD and redress clicks. `'self'` carries the port,
 *   so preview ports are excluded. The preview proxy (src/preview.ts) has its own listener and
 *   stays frameable.
 * - `img-src`: agent/forge markdown can't make the operator's browser beacon arbitrary hosts.
 *   GitHub hosts stay allowed for repo favicons (owner avatars).
 * - No script-src/default-src/connect-src: app.html carries inline boot scripts.
 */
export const HUD_CSP = [
  "frame-ancestors 'self'",
  "img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com",
  // Fonts are self-hosted (@fontsource); blocks @font-face fetches from agent-controlled CSS.
  "font-src 'self' data:",
  // The HUD plays no remote media; backstops `<audio|video src>` beacons.
  "media-src 'self' blob:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/** Set the CSP + XFO headers; copies the response when its headers are immutable (redirects). */
export function withSecurityHeaders(res: Response): Response {
  try {
    res.headers.set("Content-Security-Policy", HUD_CSP);
    res.headers.set("X-Frame-Options", "SAMEORIGIN");
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", HUD_CSP);
    headers.set("X-Frame-Options", "SAMEORIGIN");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
