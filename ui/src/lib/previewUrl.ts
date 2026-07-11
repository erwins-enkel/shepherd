/**
 * Build the iframe URL for a live-preview slot.
 *
 * Three branches, evaluated in order:
 *
 * 1. **Loopback** — `loc.hostname` is localhost / 127.0.0.1 / ::1 / [::1]:
 *    Use `loc.protocol//loc.hostname:port/`. Preserves http on local dev;
 *    previewHost (if any) is intentionally ignored so the developer stays on
 *    the machine they're actually running.
 *
 * 2. **previewHost set** (non-loopback):
 *    Return `https://previewHost:port/`. HTTPS is hardcoded here because
 *    `tailscale serve --https` is HTTPS-only — there is no HTTP listener on
 *    the slot port. This is the split-front fix: when the HUD is fronted by a
 *    different Tailscale identity (e.g. a Service `svc:shepherd`) than the
 *    agent node (`agentnode`), the iframe must target the agent node's OWN
 *    tailnet hostname, not the operator's connection host. Using loc.hostname
 *    in that case would hit a port that serves nothing → ERR_SSL_PROTOCOL_ERROR.
 *
 * 3. **Fallback** (non-loopback, no previewHost):
 *    Use `loc.protocol//loc.hostname:port/`. Equivalent to today's single-host
 *    case where the HUD host == the agent node.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function buildPreviewUrl(
  previewHost: string | null,
  loc: { protocol: string; hostname: string },
  port: number,
): string {
  if (LOOPBACK_HOSTS.has(loc.hostname)) {
    // Branch 1: loopback — dev stays on local host regardless of previewHost.
    return `${loc.protocol}//${loc.hostname}:${port}/`;
  }

  if (previewHost) {
    // Branch 2: agent node's own tailnet hostname available.
    // HTTPS is hardcoded because tailscale serve --https is HTTPS-only.
    return `https://${previewHost}:${port}/`;
  }

  // Branch 3: fallback — single-host deployment where HUD host == agent node.
  return `${loc.protocol}//${loc.hostname}:${port}/`;
}
