// Guards Shepherd against the herdr versions it cannot drive.
//
// herdr 0.7.5 (socket protocol 17) reshaped `agent start`: it now launches a canonical agent
// executable (`--kind claude`) with native args in an existing pane, and can no longer run
// Shepherd's legacy spawn command — an `env …` shim (always) wrapped, when a bwrap backend is
// present, in `bwrap … -- env … claude …`. Shepherd now spawns on 0.7.5 through the CLI
// external-registration path (`tab create` → `pane run` → `report-agent`, #1890), so 0.7.5 is fully
// supported. This module is the single source of truth for the version ceilings; callers warn
// (preflight/diagnostics), fail spawns loudly (the driver), and block the in-app herdr-update for a
// herdr newer than Shepherd can drive.
import { compareSemver } from "./semver";

/** The newest herdr version Shepherd's general ceiling admits. Feeds the preflight banner, the
 *  in-app updater block, and the diagnostics ceiling display. Re-converged with
 *  {@link HERDR_LAST_SPAWNABLE_VERSION} now that Shepherd drives 0.7.5 (#1893) — both are `0.7.5`;
 *  a herdr newer than this is warned/blocked/refused across the capability layer AND the driver. */
export const HERDR_LAST_SUPPORTED_VERSION = "0.7.5";

/** The newest herdr version the CLI driver can SPAWN on. 0.7.5 (protocol 17) is spawnable via the
 *  external-registration path (`tab create` → `pane run` → `report-agent`, #1890). Now equal to
 *  {@link HERDR_LAST_SUPPORTED_VERSION} — the two were briefly decoupled while the CLI driver could
 *  spawn on 0.7.5 but the capability layer still gated at 0.7.4; #1893 re-converged them. */
export const HERDR_LAST_SPAWNABLE_VERSION = "0.7.5";

/** First herdr version that requires the external-registration spawn path instead of `agent start`
 *  (protocol 17 reshaped `agent start` so the wrapped `env …`/`bwrap …` argv can no longer be
 *  launched through it — #1890). Module-private: consumed only by
 *  {@link herdrUsesExternalRegistrationSpawn}. */
const HERDR_EXTERNAL_REGISTRATION_VERSION = "0.7.5";

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

/** Extract a bare `x.y.z` from a raw `herdr --version` line; null when unparseable. */
export function parseHerdrVersion(raw: string): string | null {
  const m = SEMVER_RE.exec(raw);
  return m ? m[1]! : null;
}

/** True when Shepherd can drive `version`. null/unparseable → true (never false-alarm on an
 *  unreadable version); `> HERDR_LAST_SUPPORTED_VERSION` → false (a herdr newer than Shepherd
 *  supports). */
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

/** Whether the installed herdr is one Shepherd can spawn agents on: the CLI driver spawns up to
 *  {@link HERDR_LAST_SPAWNABLE_VERSION} (0.7.5) via the external-registration path (#1890). Now
 *  equal to the general support ceiling {@link isHerdrVersionSupported} (#1893).
 *  null/unparseable → true (never false-alarm on an unreadable version). */
export function herdrSpawnSupported(): boolean {
  if (!detected) return true;
  return compareSemver(detected, HERDR_LAST_SPAWNABLE_VERSION) <= 0;
}

/** Whether the detected herdr requires the 0.7.5+ external-registration spawn path (CLI driver) —
 *  `tab create` → `pane run` → `report-agent` — instead of the legacy `agent start`. null/
 *  unparseable → false, so an un-probed process takes the legacy path (the shipping build's
 *  behavior). */
export function herdrUsesExternalRegistrationSpawn(): boolean {
  if (!detected) return false;
  return compareSemver(detected, HERDR_EXTERNAL_REGISTRATION_VERSION) >= 0;
}
