// Guards Shepherd against the herdr versions it cannot drive.
//
// herdr 0.7.5 (socket protocol 17) reshaped `agent start`: it now launches a canonical agent
// executable (`--kind claude`) with native args in an existing pane, and can no longer run
// Shepherd's legacy spawn command — an `env …` shim (always) wrapped, when a bwrap backend is
// present, in `bwrap … -- env … claude …`. Shepherd now spawns on 0.7.5 through the CLI
// external-registration path (`tab create` → `pane run` → `report-agent`, #1890), so 0.7.5 is fully
// supported — and 0.8.2 (protocol 20) with it, since 19 → 20 added methods/params/results/enums
// without removing or reshaping any (#2096). This module is the single source of truth for the version ceilings; callers warn
// (preflight/diagnostics), fail spawns loudly (the driver), and block the in-app herdr-update for a
// herdr newer than Shepherd can drive.
import { compareSemver } from "./semver";

/** The newest herdr version Shepherd's general ceiling admits. Feeds the preflight banner, the
 *  in-app updater block, and the diagnostics ceiling display. Equal to
 *  {@link HERDR_LAST_SPAWNABLE_VERSION} since #1893; a herdr newer than this is
 *  warned/blocked/refused across the capability layer AND the driver. */
export const HERDR_LAST_SUPPORTED_VERSION = "0.8.2";

/** The newest herdr version the CLI driver can SPAWN on. 0.8.2 (protocol 20) still spawns via the
 *  external-registration path introduced for 0.7.5 (`tab create` → `pane run` → `report-agent`,
 *  #1890): protocol 19 → 20 is purely additive (`pane.input.set`, graphics-layer params/results,
 *  right-click pane splits, and enum values), with no method, param or result shape removed or
 *  reshaped, so the 0.7.5 spawn surface carries over unchanged (#2096). */
export const HERDR_LAST_SPAWNABLE_VERSION = "0.8.2";

/** First herdr version that requires the external-registration spawn path instead of `agent start`
 *  (protocol 17 reshaped `agent start` so the wrapped `env …`/`bwrap …` argv can no longer be
 *  launched through it — #1890). Module-private: consumed only by
 *  {@link herdrUsesExternalRegistrationSpawn}. */
const HERDR_EXTERNAL_REGISTRATION_VERSION = "0.7.5";

/** The highest herdr version on which a SANDBOXED agent's status tracks with full fidelity. Up to
 *  here herdr launched the wrapped agent via `agent start --kind` and detected its state (idle/
 *  working/blocked) itself; from {@link HERDR_EXTERNAL_REGISTRATION_VERSION} on, sandboxed agents
 *  are externally registered and herdr won't accept the client's idle down-edge (herdr issue #1716),
 *  so a resting sandboxed agent reads `working`. This is the target the two-path advisory downgrades
 *  to so operators who rely on sandboxed sessions can opt out of that regression. Trusted agents are
 *  unaffected on any version. */
export const HERDR_LAST_FULL_SANDBOX_STATUS_VERSION = "0.7.4";

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
 *  {@link HERDR_LAST_SPAWNABLE_VERSION} (0.8.2) via the external-registration path (#1890). Now
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

/** First herdr version whose CLI exposes pane-level `terminal session control` — the ONLY
 *  transport an agentless clean-terminal pane can attach through (`agent attach` refuses such
 *  panes with `agent_not_found`; probe-verified live on 0.7.5). Matches the version the
 *  SocketPtyBridge wire fixtures were captured on. */
const HERDR_FIRST_PANE_CONTROL_VERSION = "0.7.3";

/** Whether the detected herdr can host a clean terminal (pane-level socket attach available).
 *  Unlike the spawn gates above this fails CLOSED on an unknown version: a clean terminal
 *  whose pane cannot be attached would be a session with no usable terminal, so the create
 *  preflight refuses until the boot probe has recorded a capable version. */
export function herdrPaneControlSupported(): boolean {
  if (!detected) return false;
  return compareSemver(detected, HERDR_FIRST_PANE_CONTROL_VERSION) >= 0;
}
