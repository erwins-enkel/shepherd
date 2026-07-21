import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * User-private base directory for Shepherd's ephemeral runtime files (the deploy
 * log, the per-session egress config + dns.log). Prefers `$XDG_RUNTIME_DIR`
 * (`/run/user/<uid>`, `0700`, user-owned, a tmpfs cleared at boot) — which satisfies
 * CodeQL `js/insecure-temporary-file` (no fixed name in world-writable `/tmp`) AND
 * preserves the boot reset the update service's `applyState()` marker branch silently
 * relies on. Shepherd runs as a `systemd --user` service, so the variable is present.
 *
 * Falls back to `~/.shepherd/run/` (also user-owned, never world-writable) when
 * `XDG_RUNTIME_DIR` is unset — a headless CI / container with no login session. A real
 * deploy cannot reach this branch: `systemd-run --user` itself requires `XDG_RUNTIME_DIR`.
 *
 * Read at call time (no module-load snapshot) so tests can flip the env vars. Callers
 * must `mkdirSync(..., { recursive: true })` before writing — the dir may not exist yet.
 *
 * The fallback base uses `$HOME` when it is an absolute path, else `os.homedir()` (the
 * OS passwd entry) — so it is always absolute, never a cwd-relative `.shepherd/run`.
 */
export function shepherdRuntimeDir(...sub: string[]): string {
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  const home = process.env.HOME;
  const base = xdg
    ? join(xdg, "shepherd")
    : join(home && isAbsolute(home) ? home : homedir(), ".shepherd", "run");
  return join(base, ...sub);
}
