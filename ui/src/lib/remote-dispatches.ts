import { m } from "#lib/paraglide/messages.js";
import { capabilityLabel, capabilityReasonLabel, machineStatusLabel } from "#lib/machines.js";
import { placementReason } from "#lib/placement.js";
import type { DispatchReadiness, RemoteDispatch, SessionHost } from "./types";

/**
 * Tasks for a connected machine that are not settled. Sent but not confirmed by the machine
 * (#2774): its start status is unknown (no answer came back), or a cancel is on its way. Waiting
 * here for the machine it is meant for, or held there (#2775). The server lists them
 * (`GET /api/remote-dispatches`) and announces every change (`remote:dispatch`); the herd shows
 * each in its machine's group until it resolves — then the session it started is there instead.
 */

/** Shown in the herd: not confirmed by its machine, waiting for it, or held there. */
export function isShown(d: Pick<RemoteDispatch, "state">): boolean {
  return (
    d.state === "unknown" || d.state === "canceling" || d.state === "waiting" || d.state === "held"
  );
}

/** A waiting task its machine could not take even if it were reachable: a capability, the
 *  checkout or the platform is missing there. */
export function isBlocked(d: Pick<RemoteDispatch, "state" | "readiness">): boolean {
  const state = d.readiness?.state;
  return (
    d.state === "waiting" &&
    (state === "missing_capabilities" || state === "project_missing" || state === "unreleased")
  );
}

/** The list after a `remote:dispatch` frame, and the dispatch it resolved — one that was shown and
 *  is settled now — so the caller can say how it ended. A settled one not shown changes nothing. */
export function reduceRemoteDispatches(
  list: readonly RemoteDispatch[],
  d: RemoteDispatch,
): { list: RemoteDispatch[]; resolved: RemoteDispatch | null } {
  const shown = list.some((x) => x.id === d.id);
  if (isShown(d)) {
    return {
      list: shown ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d],
      resolved: null,
    };
  }
  return shown
    ? { list: list.filter((x) => x.id !== d.id), resolved: d }
    : { list: [...list], resolved: null };
}

/** What a toast says about a shown dispatch that resolved; `alert` for one that did not start.
 *  A waiting task taken to run here says nothing: its session shows up in the herd. */
export function resolvedMessage(d: RemoteDispatch): { text: string; alert: boolean } | null {
  const machine = d.host.name;
  switch (d.state) {
    case "started":
      return { text: m.toast_dispatch_started_on({ machine }), alert: false };
    case "held":
      return { text: m.toast_task_held_on({ machine }), alert: false };
    case "canceled":
      return { text: m.toast_dispatch_canceled_on({ machine }), alert: false };
    case "rejected":
    case "upload_failed":
      return {
        text: m.toast_dispatch_declined_on({ machine, reason: d.reason ?? d.code ?? "" }),
        alert: true,
      };
    default:
      return null;
  }
}

/** The state word a shown dispatch leads with: the four states the issue keeps apart — waiting
 *  (offline), blocked (a capability or the checkout missing), held there (busy), start status
 *  unknown — and a pending cancel. */
export function dispatchLabel(d: Pick<RemoteDispatch, "state" | "readiness">): string {
  if (d.state === "canceling") return m.remote_dispatch_canceling();
  if (d.state === "held") return m.remote_dispatch_held();
  if (d.state === "waiting") {
    return isBlocked(d) ? m.remote_dispatch_blocked() : m.remote_dispatch_waiting();
  }
  return m.remote_dispatch_unknown();
}

/** "Xcode (license not accepted)", for each requirement the machine lacks. */
export function missingList(readiness: DispatchReadiness | undefined): string {
  return (readiness?.missing ?? [])
    .map((x) => `${capabilityLabel(x.capability)} (${capabilityReasonLabel(x.reason)})`)
    .join(", ");
}

/** Why a waiting machine is out of reach, in words: its connection status, or "Unreachable" for
 *  the reason codes an unreachable machine reports (timeout, network, …). */
export function offlineLabel(status: string | undefined): string {
  const known = ["unauthorized", "incompatible", "identity_mismatch", "checking"];
  return machineStatusLabel(status && known.includes(status) ? status : "unreachable");
}

/** The short reason after the state word: what the task needs, what the machine lacks, or that
 *  the machine holds it. Null for an unknown start or a pending cancel. */
export function dispatchDetail(d: RemoteDispatch): string | null {
  if (d.state === "held") return m.remote_dispatch_held_detail();
  if (d.state !== "waiting") return null;
  switch (d.readiness?.state) {
    case "missing_capabilities":
      return m.remote_dispatch_missing_detail({ list: missingList(d.readiness) });
    case "project_missing":
      return m.remote_dispatch_project_detail();
    case "unreleased":
      return m.remote_dispatch_unreleased_detail();
    case "ready":
      return m.remote_dispatch_ready_detail();
    default:
      return d.placement ? placementReason(d.placement) : null;
  }
}

/** "Run here" for this Shepherd — the one that placed the task — else "Run on <machine>". */
export function redirectLabel(d: Pick<RemoteDispatch, "placement">, to: SessionHost): string {
  return d.placement?.by.instanceId === to.instanceId
    ? m.remote_dispatch_run_here()
    : m.remote_dispatch_run_on({ machine: to.name });
}
