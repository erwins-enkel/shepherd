// ── dev-port detection primitives ─────────────────────────────────────────────
//
// Task 2: primary-port selection for agent preview detection.
// Preview listener lifecycle, slot allocation, poller sweep, and UI are later tasks.

/**
 * Priority-ordered curated list of well-known frontend/full-stack dev-server ports.
 * List-order is the selection priority — NOT numeric order.
 * Curated ports are trusted HTTP servers; they are NEVER probed via HTTP.
 */
// fallow-ignore-next-line unused-export
export const CURATED_PORTS: readonly number[] = [5173, 5174, 4321, 4173, 3000, 8000, 8080];

const CURATED_SET = new Set<number>(CURATED_PORTS);

/**
 * HTTP liveness probe: returns true when a plain HTTP GET/HEAD to 127.0.0.1:<port>
 * yields any well-formed HTTP response within ~500 ms.
 *
 * This ensures non-HTTP sockets (debugger 9229, DB ports, etc.) are never surfaced.
 * Injectable for tests (pass a custom probe to avoid real network calls).
 */
// fallow-ignore-next-line unused-export
export async function defaultHttpProbe(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      signal: controller.signal,
    });
    // Any well-formed HTTP response counts — even 4xx/5xx confirms an HTTP server.
    return typeof res.status === "number";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the primary dev-server port from a set of listening ports, using this rule:
 *
 * 1. If any port from the curated list is present, return the one that appears FIRST
 *    in CURATED_PORTS (list-order priority, NOT numeric). No HTTP probe for curated ports.
 * 2. Otherwise, among non-curated ports, return the numerically LOWEST that passes
 *    the HTTP liveness probe.
 * 3. If nothing answers → null.
 *
 * @param ports      Listening ports detected in the worktree (any order).
 * @param httpProbe  Injectable probe; defaults to real network call.
 */
export async function pickPrimaryPort(
  ports: number[],
  httpProbe: (port: number) => Promise<boolean> = defaultHttpProbe,
): Promise<number | null> {
  if (ports.length === 0) return null;

  // Step 1: curated-first by list order.
  for (const candidate of CURATED_PORTS) {
    if (ports.includes(candidate)) return candidate;
  }

  // Step 2: non-curated fallback — numerically lowest HTTP-answering port.
  const nonCurated = ports.filter((p) => !CURATED_SET.has(p)).sort((a, b) => a - b);
  for (const port of nonCurated) {
    if (await httpProbe(port)) return port;
  }

  return null;
}
