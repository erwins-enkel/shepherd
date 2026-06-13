/**
 * Skip-gate for the egress real-machinery suite (test/egress-runner.test.ts).
 * Pure + injectable so it can be unit-tested without touching the host (see
 * test/egress-runner-gate.test.ts). The wiring in egress-runner.test.ts supplies
 * the live probes.
 */

export interface GateProbes {
  /** Result of the host-capability probe (tools present + rootless user+net ns works). */
  capable: boolean;
  /** Process env (injected for testability). */
  env: Record<string, string | undefined>;
  /** Current uid, or undefined when getuid is unavailable (e.g. Windows). */
  uid: number | undefined;
  /** Returns true iff `path` exists AND is a unix socket. */
  isSocket: (path: string) => boolean;
}

/**
 * True iff a rootless docker daemon's socket is present on this host — the
 * co-tenant `slirp4netns` the egress real-machinery teardown can disrupt.
 * Mirrors ci/self-hosted-runner/runner-liveness.sh's socket convention:
 *   - honor $DOCKER_HOST when it is a unix:// path, plus
 *   - /run/user/<uid>/docker.sock (the canonical rootless socket path).
 */
export function rootlessDockerSocketPresent(
  env: Record<string, string | undefined>,
  uid: number | undefined,
  isSocket: (path: string) => boolean,
): boolean {
  const candidates: string[] = [];
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost && dockerHost.startsWith("unix://")) {
    candidates.push(dockerHost.slice("unix://".length));
  }
  if (uid !== undefined) {
    candidates.push(`/run/user/${uid}/docker.sock`);
  }
  return candidates.some((p) => isSocket(p));
}

/**
 * Decide whether to SKIP the egress real-machinery suite. Fail-closed: skip when
 *   - the host can't run the machinery at all (`!capable`), OR
 *   - we are under CI (`env.CI` truthy) — no real slirp teardown in ANY CI job,
 *     independent of hosted/self-hosted, so there is no fail-open surface, OR
 *   - a rootless docker daemon's socket is present (the host/dev-box trigger).
 *
 * `!!env.CI` treats any non-empty value as CI (standard convention; GitHub sets
 * CI=true). An explicit `CI=false` string is non-empty and so also skips — the
 * safe direction for this optional, gated coverage.
 */
export function egressRunnerShouldSkip(p: GateProbes): boolean {
  return !p.capable || !!p.env.CI || rootlessDockerSocketPresent(p.env, p.uid, p.isSocket);
}
