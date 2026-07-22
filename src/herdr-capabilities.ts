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

/** The newest herdr version Shepherd's general ceiling admits. Feeds the preflight banner, the
 *  in-app updater block, and the diagnostics ceiling display — retiring THOSE is a separate child of
 *  #1889, so this stays `0.7.4` here even though the CLI driver can now spawn on 0.7.5 (see
 *  {@link HERDR_LAST_SPAWNABLE_VERSION}). */
export const HERDR_LAST_SUPPORTED_VERSION = "0.7.4";

/** The newest herdr version the CLI driver can SPAWN on. 0.7.5 (protocol 17) is spawnable via the
 *  external-registration path (`tab create` → `pane run` → `report-agent`, #1890); this is
 *  decoupled from {@link HERDR_LAST_SUPPORTED_VERSION} so lifting the CLI spawn refusal for 0.7.5
 *  does not also un-gate the updater/preflight ceiling. */
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

/** Whether the installed herdr is one Shepherd can spawn agents on. Decoupled from
 *  {@link isHerdrVersionSupported} (the general 0.7.4 ceiling): the CLI driver can now spawn up to
 *  {@link HERDR_LAST_SPAWNABLE_VERSION} (0.7.5) via the external-registration path (#1890).
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
