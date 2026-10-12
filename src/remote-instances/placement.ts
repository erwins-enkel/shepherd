/**
 * Automatic machine choice (issue #2772): where a new task runs when the submitter names no
 * machine, and whether a machine it does name fits. This module is the pure half — one decision
 * function over a view of every machine (this one included), the rules every caller shares and the
 * record a placed task keeps. `server.ts` builds the views and acts on the decision; the create
 * route and the preview route (`POST /api/placement`) run the very same function, so what the form
 * shows before submit is what the create does with the same readiness.
 *
 * The rules, and why:
 * - A machine fits a task when its platform is released, it has the project checked out and every
 *   requirement is `ok` in its capability report. A connected machine's report must be fresh (not
 *   stale); a machine out of reach is judged on what it last reported, so it can still be the one a
 *   task is meant for.
 * - Fitting machines are ranked by platform (the order below, Linux first: it has the full sandbox
 *   and runs all the time), then by instance ID. Nothing in the ranking depends on which Shepherd
 *   decides, so a task lands on the same machine wherever it is submitted — as long as every
 *   Shepherd uses the same order.
 * - The top machine out of reach is a refusal, never a silent fallback to the next one: the
 *   operator picks another machine by hand (waiting for it is a later slice, #2775).
 * - A machine named by the submitter must fit the same way, or it is refused with the reason.
 */
import {
  type Capability,
  type CapabilityReport,
  type MissingCapability,
  isCapability,
  missingRequirements,
} from "./capabilities";
import type { RemoteInstanceSummary } from "./service";
import type { SessionHost } from "./sessions";

/** Settings key of this instance's platform order (a JSON array). */
export const PLATFORM_ORDER_SETTING = "machinePlatformOrder";

/** The default platform order: Linux before macOS. */
export const DEFAULT_PLATFORM_ORDER: readonly string[] = ["linux", "macos"];

/** A requirement no fresh report confirms (none at all, or a connected machine's stale one). */
const NOT_VERIFIED = "not_verified";

/** Bounds of the strings a placement record carries. */
const ID_MAX = 128;
const NAME_MAX = 128;
const PLATFORM_MAX = 32;
const MAX_REQUIREMENTS = 32;

/** One machine as the decision sees it. Remote machines this Shepherd has never seen (no platform,
 *  no projects, no report) are left out: nothing about them can be judged. */
export interface MachineView {
  host: SessionHost;
  /** This Shepherd itself. */
  local: boolean;
  connected: boolean;
  /** The machine's connection status (`connected` for this Shepherd) and why, when it is not. */
  status: string;
  reason: string | null;
  released: boolean;
  hasProject: boolean;
  report: CapabilityReport | null;
}

/** What decided: the operator's choice, the requirements (only one platform fits), the platform
 *  order (several fit) or that only one machine can run the task at all. */
export type PlacementBasis = "manual" | "requirements" | "preference" | "only_candidate";

/** Where a task was placed and why, as it is stored with the task and shown on its session.
 *  Language-neutral: clients put it into words. */
export interface Placement {
  mode: "auto" | "manual";
  target: SessionHost;
  requirements: Capability[];
  basis: PlacementBasis;
  /** The platform the order preferred among several that fit; null when it did not decide. */
  preferred: string | null;
  /** The Shepherd that decided. */
  by: { instanceId: string; name: string };
  decidedAt: number;
}

export type RemoteUnfitCode =
  | "remote_target_unknown"
  | "remote_target_unavailable"
  | "remote_target_unreleased"
  | "remote_project_missing";

export type PlacementRefusal =
  | {
      code: "no_suitable_machine";
      /** Requirements no connected machine with the project has — all of them when each is on some
       *  machine but none has them together. */
      missing: Capability[];
      together: boolean;
      /** Connected machines that would fit but have no checkout of the project. */
      elsewhere: SessionHost[];
    }
  | {
      code: "preferred_machine_offline";
      host: SessionHost;
      status: string;
      /** Connected machines that fit too — a manual choice away. */
      alternatives: SessionHost[];
    }
  | { code: "missing_capabilities"; host: SessionHost; missing: MissingCapability[] }
  | { code: RemoteUnfitCode; host: SessionHost | null; reason: string | null };

export type PlacementDecision =
  { ok: true; placement: Placement } | { ok: false; refusal: PlacementRefusal };

export interface PlacementRequest {
  requirements: Capability[];
  /** null = automatic; otherwise the instance ID of the machine the submitter named. */
  override: string | null;
  order: readonly string[];
  by: { instanceId: string; name: string };
  now: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A platform order from a settings body: exactly the default's platforms, each once. */
export function parsePlatformOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length !== DEFAULT_PLATFORM_ORDER.length) return null;
  const all = raw.every((p) => typeof p === "string" && DEFAULT_PLATFORM_ORDER.includes(p));
  return all && new Set(raw).size === raw.length ? (raw as string[]) : null;
}

/** The stored order, or the default when none (or a garbled one) is stored. */
export function storedPlatformOrder(value: string | null): string[] {
  if (value === null) return [...DEFAULT_PLATFORM_ORDER];
  try {
    return parsePlatformOrder(JSON.parse(value)) ?? [...DEFAULT_PLATFORM_ORDER];
  } catch {
    return [...DEFAULT_PLATFORM_ORDER];
  }
}

/** Whether tasks are placed at all: some registered machine could run one. Only machines known to
 *  run an unreleased platform (Windows) do not count, so with none — or only those — creates stay
 *  exactly as they were. */
export function placementActive(machines: Pick<RemoteInstanceSummary, "released" | "info">[]) {
  return machines.some((m) => m.released || m.info === null);
}

interface Availability {
  connected: boolean;
  status: string;
  reason: string | null;
  released: boolean;
  platform: string | null;
  hasProject: boolean;
}

function unfitOf(m: Availability): { code: RemoteUnfitCode; reason: string | null } | null {
  if (!m.connected) return { code: "remote_target_unavailable", reason: m.reason ?? m.status };
  // A platform not cleared to run tasks (Windows, #2770) is listed but never sent a task.
  if (!m.released) return { code: "remote_target_unreleased", reason: m.platform };
  if (!m.hasProject) return { code: "remote_project_missing", reason: null };
  return null;
}

/** Why a machine cannot take a task even before its capabilities are looked at — the dispatcher's
 *  pre-flight (#2763) and a manual choice share it. */
export function remoteUnfit(
  machine: Pick<RemoteInstanceSummary, "status" | "reason" | "released" | "info" | "projects">,
  project: string,
): { code: RemoteUnfitCode; reason: string | null } | null {
  return unfitOf({
    connected: machine.status === "connected",
    status: machine.status,
    reason: machine.reason,
    released: machine.released,
    platform: machine.info?.platform ?? null,
    hasProject: machine.projects?.includes(project) ?? false,
  });
}

/** The requirements `machine` does not meet as far as its report shows. A connected machine's
 *  stale report — or no report — verifies nothing. */
export function missingOn(machine: MachineView, requirements: readonly Capability[]) {
  if (requirements.length === 0) return [];
  const { report } = machine;
  if (!report || (machine.connected && report.stale)) {
    return requirements.map((capability) => ({ capability, reason: NOT_VERIFIED }));
  }
  return missingRequirements(report, requirements);
}

function fits(machine: MachineView, requirements: readonly Capability[]): boolean {
  return machine.released && machine.hasProject && missingOn(machine, requirements).length === 0;
}

function rank(order: readonly string[], platform: string): number {
  const i = order.indexOf(platform);
  return i === -1 ? order.length : i;
}

/** Platform order first, then instance ID — a plain code-unit comparison, the same everywhere. */
function byPreference(order: readonly string[]) {
  return (a: MachineView, b: MachineView) =>
    rank(order, a.host.platform) - rank(order, b.host.platform) ||
    (a.host.instanceId < b.host.instanceId ? -1 : a.host.instanceId > b.host.instanceId ? 1 : 0);
}

/** The record a task placed on `machine` keeps. */
export function placementRecord(
  machine: Pick<MachineView, "host">,
  req: Pick<PlacementRequest, "requirements" | "by" | "now">,
  how: { mode: Placement["mode"]; basis: PlacementBasis; preferred: string | null },
): Placement {
  return {
    mode: how.mode,
    target: machine.host,
    requirements: [...req.requirements],
    basis: how.basis,
    preferred: how.preferred,
    by: req.by,
    decidedAt: req.now,
  };
}

function noSuitableMachine(
  machines: readonly MachineView[],
  requirements: readonly Capability[],
): PlacementRefusal {
  const live = machines.filter((m) => m.connected && m.released);
  const withProject = live.filter((m) => m.hasProject);
  const absent = requirements.filter(
    (r) => !withProject.some((m) => missingOn(m, [r]).length === 0),
  );
  const together = absent.length === 0;
  return {
    code: "no_suitable_machine",
    missing: together ? [...requirements] : absent,
    together,
    elsewhere: live
      .filter((m) => !m.hasProject && missingOn(m, requirements).length === 0)
      .map((m) => m.host),
  };
}

/** Why the top machine won: the order (several platforms fit, or several machines and no
 *  requirements), the requirements (one platform fits) or that it was the only one. */
function basisOf(ranked: readonly MachineView[], requirements: readonly Capability[]) {
  const platforms = new Set(ranked.map((m) => m.host.platform));
  const top = ranked[0]!;
  if (platforms.size > 1 || (requirements.length === 0 && ranked.length > 1)) {
    return { basis: "preference" as const, preferred: top.host.platform };
  }
  const basis = requirements.length > 0 ? "requirements" : "only_candidate";
  return { basis: basis as PlacementBasis, preferred: null };
}

function placeAutomatically(
  machines: readonly MachineView[],
  req: PlacementRequest,
): PlacementDecision {
  const ranked = machines.filter((m) => fits(m, req.requirements)).sort(byPreference(req.order));
  const top = ranked[0];
  if (!top) return { ok: false, refusal: noSuitableMachine(machines, req.requirements) };
  if (!top.connected) {
    return {
      ok: false,
      refusal: {
        code: "preferred_machine_offline",
        host: top.host,
        status: top.reason ?? top.status,
        alternatives: ranked.filter((m) => m.connected).map((m) => m.host),
      },
    };
  }
  const how = { mode: "auto" as const, ...basisOf(ranked, req.requirements) };
  return { ok: true, placement: placementRecord(top, req, how) };
}

function placeManually(machines: readonly MachineView[], req: PlacementRequest): PlacementDecision {
  const machine = machines.find((m) => m.host.instanceId === req.override);
  if (!machine) {
    return { ok: false, refusal: { code: "remote_target_unknown", host: null, reason: null } };
  }
  const unfit = machine.local ? null : unfitOf({ ...machine, platform: machine.host.platform });
  if (unfit) return { ok: false, refusal: { ...unfit, host: machine.host } };
  const missing = missingOn(machine, req.requirements);
  if (missing.length > 0) {
    return { ok: false, refusal: { code: "missing_capabilities", host: machine.host, missing } };
  }
  const how = { mode: "manual" as const, basis: "manual" as const, preferred: null };
  return { ok: true, placement: placementRecord(machine, req, how) };
}

/** Where a task runs: the machine the submitter named, if it fits, or the best fitting one. */
export function decidePlacement(
  machines: readonly MachineView[],
  req: PlacementRequest,
): PlacementDecision {
  return req.override === null ? placeAutomatically(machines, req) : placeManually(machines, req);
}

const listOf = (items: readonly string[]) => items.join(", ");

/** The English `error` of a refusal this module owns (the remote codes keep the dispatcher's). */
export function describeRefusal(
  refusal: Exclude<PlacementRefusal, { code: RemoteUnfitCode }>,
): string {
  switch (refusal.code) {
    case "no_suitable_machine": {
      const what = refusal.missing.length > 0 ? listOf(refusal.missing) : "this project";
      const elsewhere =
        refusal.elsewhere.length > 0
          ? `; ${listOf(refusal.elsewhere.map((h) => h.name))} would, but has no checkout of this project`
          : "";
      return `no connected machine has ${what}${refusal.together && refusal.missing.length > 1 ? " together" : ""}${elsewhere}; nothing was started`;
    }
    case "preferred_machine_offline":
      return `${refusal.host.name} would run this task but is not reachable right now (${refusal.status}); nothing was started. Name another machine in target to run it there`;
    case "missing_capabilities":
      return `${refusal.host.name} is missing capabilities: ${listOf(refusal.missing.map((m) => `${m.capability} (${m.reason})`))}`;
  }
}

function parseHost(raw: unknown): SessionHost | null {
  if (!isRecord(raw)) return null;
  const { instanceId, name, platform } = raw;
  if (!isText(instanceId, ID_MAX) || !isText(name, NAME_MAX) || !isText(platform, PLATFORM_MAX)) {
    return null;
  }
  return { instanceId, name, platform };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

const BASES: readonly string[] = ["manual", "requirements", "preference", "only_candidate"];

/** A create body's `placement`: the record a coordinator Shepherd sends along with a task it placed
 *  here. Absent ⇒ undefined; malformed ⇒ an error for a 400. Rebuilt field by field, so nothing
 *  else rides along into the session. */
export function parsePlacementRecord(raw: unknown): Placement | undefined | { error: string } {
  if (raw === undefined) return undefined;
  const bad = { error: "placement must be a placement record" };
  if (!isRecord(raw) || (raw.mode !== "auto" && raw.mode !== "manual")) return bad;
  const target = parseHost(raw.target);
  const by = isRecord(raw.by) ? parseHost({ ...raw.by, platform: "-" }) : null;
  const requirements = raw.requirements;
  if (!target || !by || typeof raw.basis !== "string" || !BASES.includes(raw.basis)) return bad;
  if (!Array.isArray(requirements) || requirements.length > MAX_REQUIREMENTS) return bad;
  if (!requirements.every(isCapability)) return bad;
  if (raw.preferred !== null && !isText(raw.preferred, PLATFORM_MAX)) return bad;
  if (typeof raw.decidedAt !== "number" || !Number.isFinite(raw.decidedAt)) return bad;
  return {
    mode: raw.mode,
    target,
    requirements: [...new Set(requirements)].sort(),
    basis: raw.basis as PlacementBasis,
    preferred: raw.preferred,
    by: { instanceId: by.instanceId, name: by.name },
    decidedAt: raw.decidedAt,
  };
}
