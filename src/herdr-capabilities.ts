// Guards Shepherd against the herdr versions it cannot drive.
//
// herdr 0.7.5 (socket protocol 17) reshaped `agent start`: it now launches a canonical agent
// executable (`--kind claude`) with native args in an existing pane, and can no longer run
// Shepherd's spawn command — an `env …` shim (always) wrapped, when a bwrap backend is present,
// in `bwrap … -- env … claude …`. Verified against a live 0.7.5 server: EVERY spawn breaks (the
// shim tokens become positional args; the env pinning is lost), so Shepherd cannot launch a single
// agent on 0.7.5. Until issue #1889 lands a compatible spawn path, Shepherd supports herdr <= 0.7.4
// only. This module is the single source of truth for that ceiling; callers warn (preflight/
// diagnostics), fail spawns loudly (the driver), and block the in-app herdr-update to 0.7.5+.
import { compareSemver } from "./semver";

/** The newest herdr version Shepherd can drive. 0.7.5+ broke agent spawning — see #1889. */
export const HERDR_LAST_SUPPORTED_VERSION = "0.7.4";

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

/** Extract a bare `x.y.z` from a raw `herdr --version` line; null when unparseable. */
export function parseHerdrVersion(raw: string): string | null {
  const m = SEMVER_RE.exec(raw);
  return m ? m[1]! : null;
}

/** True when Shepherd can drive `version`. null/unparseable → true (never false-alarm on an
 *  unreadable version); `> HERDR_LAST_SUPPORTED_VERSION` → false (spawning is broken, #1889). */
export function isHerdrVersionSupported(version: string | null): boolean {
  if (!version) return true;
  return compareSemver(version, HERDR_LAST_SUPPORTED_VERSION) <= 0;
}

// --- process-wide detected version: set at boot, refreshed after a herdr update / by diagnostics ---
let detected: string | null = null;

/** Record the installed herdr version (boot preflight, post-update re-read, diagnostics refresh). */
export function setDetectedHerdrVersion(version: string | null): void {
  detected = version;
}

/** The installed herdr version last detected, or null before detection runs. */
export function detectedHerdrVersion(): string | null {
  return detected;
}

/** Whether the installed herdr is one Shepherd can spawn agents on. Defaults to true before
 *  detection so an un-probed process behaves as the shipping build did. */
export function herdrSpawnSupported(): boolean {
  return isHerdrVersionSupported(detected);
}
