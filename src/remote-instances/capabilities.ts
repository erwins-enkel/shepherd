/**
 * Verified capabilities (issue #2770): what a Shepherd can actually run, as checked under its own
 * service user — not what its platform suggests. A Mac is not proof of Xcode; a reachable Linux box
 * is not proof that `codex` is logged in.
 *
 * This module is the pure half: the fixed, versioned vocabulary (also the output vocabulary of the
 * later task classification, #2773), the snapshot shapes, and the rules every consumer shares —
 * freshness, the missing-requirement verdict, the coordinator's view of a machine's report and the
 * platform release gate. The host-touching probes live in `capability-probe.ts`.
 */
/** Bump when an entry is renamed or its meaning changes; adding an entry needs no bump. */
export const CAPABILITY_VOCABULARY_VERSION = 1;

export const CAPABILITIES = [
  "platform:linux",
  "platform:macos",
  "platform:windows",
  "xcode",
  "sdk:macos",
  "sdk:ios",
  "ios-simulator",
  "android-sdk",
  "agent:claude",
  "agent:codex",
  "sandbox:trusted",
  "sandbox:standard",
  "sandbox:autonomous",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Why a capability is not available. `other_platform` = it belongs to another platform (Xcode on
 * Linux); `not_probed` = it exists on this platform but this build does not check it yet.
 */
export type CapabilityReason =
  | "not_installed"
  | "not_logged_in"
  | "timeout"
  | "probe_failed"
  | "other_platform"
  | "not_probed"
  | "sdk_not_found"
  | "sdk_incomplete"
  | "no_backend"
  | "no_egress";

/** One vocabulary entry's verdict. `reason` is a CapabilityReason, or whatever code a newer
 *  machine reported; null when `ok`. */
export interface CapabilityCheck {
  id: Capability;
  ok: boolean;
  reason: string | null;
}

/** A probe result: one check per vocabulary entry, stamped when the probe finished. */
export interface CapabilitySnapshot {
  vocabulary: number;
  /** Epoch ms on the clock of whoever holds the snapshot (re-based for a remote machine). */
  probedAt: number;
  checks: CapabilityCheck[];
}

/** The snapshot as it goes on the wire: plus its age at response time and the stale verdict. */
export interface CapabilityReport extends CapabilitySnapshot {
  ageMs: number;
  stale: boolean;
}

export interface MissingCapability {
  capability: Capability;
  reason: string;
}

/** Older than this, a snapshot is shown as stale. Instances re-probe every 5 minutes. */
const CAPABILITY_STALE_MS = 15 * 60_000;

/** Bounds a `requirements` array before it is deduplicated. */
const MAX_REQUIREMENTS = 32;

const VOCABULARY = new Set<string>(CAPABILITIES);

/** Platforms cleared to run tasks. Windows is modelled but not released until its platform
 *  compatibility is proven; an unknown platform is never released. */
const RELEASED_PLATFORMS = new Set(["linux", "macos"]);

/** Local twin of client.ts's guard: client.ts imports this module, so importing back would cycle. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && VOCABULARY.has(value);
}

export function platformReleased(platform: string): boolean {
  return RELEASED_PLATFORMS.has(platform);
}

export function capabilityReport(snapshot: CapabilitySnapshot, now: number): CapabilityReport {
  const ageMs = Math.max(0, now - snapshot.probedAt);
  return { ...snapshot, ageMs, stale: ageMs > CAPABILITY_STALE_MS };
}

/**
 * A create body's `requirements`: absent ⇒ `undefined`; an array of vocabulary entries ⇒ sorted
 * and deduplicated (an empty array reads as absent); anything else ⇒ an error for a 400.
 */
export function parseRequirements(raw: unknown): Capability[] | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_REQUIREMENTS) {
    return { error: `requirements must be an array of at most ${MAX_REQUIREMENTS} capabilities` };
  }
  const unknown = raw.find((entry) => !isCapability(entry));
  if (unknown !== undefined) return { error: `unknown capability: ${String(unknown)}` };
  const unique = [...new Set(raw as Capability[])].sort();
  return unique.length > 0 ? unique : undefined;
}

/** The requirements `snapshot` does not satisfy, each with its reason. An entry the snapshot does
 *  not mention (an older machine's vocabulary) counts as `not_probed`. */
export function missingRequirements(
  snapshot: CapabilitySnapshot,
  requirements: readonly Capability[],
): MissingCapability[] {
  return requirements.flatMap((capability) => {
    const check = snapshot.checks.find((c) => c.id === capability);
    if (!check) return [{ capability, reason: "not_probed" }];
    return check.ok ? [] : [{ capability, reason: check.reason ?? "probe_failed" }];
  });
}

/** The 422 `error` text: names every missing capability and why. */
export function describeMissing(missing: readonly MissingCapability[]): string {
  return `missing capabilities: ${missing.map((m) => `${m.capability} (${m.reason})`).join(", ")}`;
}

function parseCheck(raw: unknown): CapabilityCheck | "unknown" | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.ok !== "boolean") return null;
  if (raw.reason !== null && typeof raw.reason !== "string") return null;
  if (!isCapability(raw.id)) return "unknown";
  return { id: raw.id, ok: raw.ok, reason: raw.ok ? null : (raw.reason ?? "probe_failed") };
}

/**
 * A machine's report as the coordinator reads it from `GET /api/instance`. Missing ⇒ null (an
 * older machine). Malformed ⇒ null (a report that cannot be trusted is not partially trusted).
 * Entries outside this build's vocabulary are dropped. `probedAt` is re-based onto the local clock
 * from the report's `ageMs`, so clock skew between machines cannot make a snapshot look fresh.
 */
export function parseCapabilityReport(raw: unknown, fetchedAt: number): CapabilitySnapshot | null {
  if (!isRecord(raw) || !Number.isInteger(raw.vocabulary) || !Array.isArray(raw.checks)) {
    return null;
  }
  if (typeof raw.ageMs !== "number" || !Number.isFinite(raw.ageMs) || raw.ageMs < 0) return null;
  const checks: CapabilityCheck[] = [];
  for (const entry of raw.checks) {
    const check = parseCheck(entry);
    if (check === null) return null;
    if (check !== "unknown") checks.push(check);
  }
  return { vocabulary: raw.vocabulary as number, probedAt: fetchedAt - raw.ageMs, checks };
}
