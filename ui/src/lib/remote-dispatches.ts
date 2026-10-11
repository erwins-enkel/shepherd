import { m } from "#lib/paraglide/messages.js";
import type { RemoteDispatch } from "./types";

/**
 * Tasks sent to a connected machine that no machine has confirmed (#2774): its start status is
 * unknown (no answer came back), or a cancel is on its way. The server lists them
 * (`GET /api/remote-dispatches`) and announces every change (`remote:dispatch`); the herd shows
 * each in its machine's group until it resolves — then the session it started is there instead.
 */

/** Shown in the herd: not confirmed by its machine. */
export function isUnconfirmed(d: Pick<RemoteDispatch, "state">): boolean {
  return d.state === "unknown" || d.state === "canceling";
}

/** The list after a `remote:dispatch` frame, and the dispatch it resolved — one that was shown and
 *  is settled now — so the caller can say how it ended. A settled one not shown changes nothing. */
export function reduceRemoteDispatches(
  list: readonly RemoteDispatch[],
  d: RemoteDispatch,
): { list: RemoteDispatch[]; resolved: RemoteDispatch | null } {
  const shown = list.some((x) => x.id === d.id);
  if (isUnconfirmed(d)) {
    return {
      list: shown ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d],
      resolved: null,
    };
  }
  return shown
    ? { list: list.filter((x) => x.id !== d.id), resolved: d }
    : { list: [...list], resolved: null };
}

/** What a toast says about a shown dispatch that resolved; `alert` for one that did not start. */
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
