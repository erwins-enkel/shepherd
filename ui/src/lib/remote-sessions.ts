import type { Session, SessionConnection, SessionHost } from "./types";
import { m } from "#lib/paraglide/messages.js";

/**
 * Sessions mirrored from connected machines (#2762) — references the server marks with `host` +
 * `connection`; the actions it forwards to their machine (#2765) run there, never here. The store
 * keeps them apart from its own `sessions`, so nothing that acts on a local session (attention
 * queue, merge train, keyboard nav, side maps) ever sees one.
 */

/** A remote session with its annotation guaranteed. */
export type MirroredSession = Session & { host: SessionHost; connection: SessionConnection };

export function isMirrored(s: Pick<Session, "host" | "connection">): s is MirroredSession {
  return !!s.host && !!s.connection;
}

/** "MacBook · TASK-07" for a mirrored session, the bare designation for a local one. Machine
 *  names are unique among connected machines and local labels stay bare, so a label names exactly
 *  one session in the shared view. */
export function qualifiedDesig(s: Pick<Session, "desig" | "host">): string {
  return s.host ? `${s.host.name} · ${s.desig}` : s.desig;
}

/**
 * What to tell the operator when an action on a mirrored session did not reach its machine, or is
 * not one this server forwards (#2765) — keyed on the server's stable `code`. Null for any other
 * failure: the machine itself answered, so the caller's own copy for that action applies.
 */
export function remoteActionMessage(err: unknown, machine: string): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "machine_unreachable") return m.remote_action_unreachable({ machine });
  if (code === "machine_timeout") return m.remote_action_timeout({ machine });
  if (code === "machine_unauthorized") return m.remote_action_unauthorized({ machine });
  if (code === "remote_unsupported") return m.remote_action_unsupported({ machine });
  return null;
}

/** Proper names of the platforms the server reports; anything else passes through. */
export function platformName(platform: string): string {
  return { linux: "Linux", macos: "macOS", windows: "Windows" }[platform] ?? platform;
}

/** The time the shown data was last current: a clock time today, date and time before. */
export function lastKnownLabel(since: number, nowMs: number): string {
  const at = new Date(since);
  return at.toDateString() === new Date(nowMs).toDateString()
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export interface MachineGroup {
  host: SessionHost;
  connection: SessionConnection;
  sessions: MirroredSession[];
}

/** One group per machine, in the order the machines' sessions first appear. */
export function machineGroups(remote: readonly Session[]): MachineGroup[] {
  const groups = new Map<string, MachineGroup>();
  for (const s of remote) {
    if (!isMirrored(s)) continue;
    const group = groups.get(s.host.instanceId);
    if (group) group.sessions.push(s);
    else groups.set(s.host.instanceId, { host: s.host, connection: s.connection, sessions: [s] });
  }
  return [...groups.values()];
}

function isMirroredFrame(data: unknown): data is Session & { host: SessionHost } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { id?: unknown }).id === "string" &&
    !!(data as { host?: unknown }).host
  );
}

/** The patch a frame about a mirrored session applies; only what a view-only card shows. */
function applyMirroredFrame(list: Session[], event: string, data: Session): Session[] {
  const known = list.some((s) => s.id === data.id);
  switch (event) {
    case "session:new":
      return known ? list.map((s) => (s.id === data.id ? data : s)) : [...list, data];
    case "session:archived":
      return list.filter((s) => s.id !== data.id);
    case "session:status":
    case "session:renamed":
      // Object spread defines properties, so an own `__proto__` key in the payload stays a plain key.
      return known ? list.map((s) => (s.id === data.id ? { ...s, ...data } : s)) : list;
    default:
      return list;
  }
}

/**
 * The id of the mirrored session whose machine just reported a preview change (#2767), or null.
 * Only the change is taken from the frame, never its `previewPort`: that is the machine's slot, not
 * one of this server's, so the caller re-reads where the preview opens instead.
 */
export function mirroredPreviewChange(ev: { event: string; data: unknown }): string | null {
  if (ev.event !== "session:preview" && ev.event !== "session:preview-serve") return null;
  return isMirroredFrame(ev.data) ? ev.data.id : null;
}

/**
 * The remote list after `ev`, or `null` when `ev` is not about mirrored sessions (the caller then
 * applies it as a local frame). `remote:sessions` replaces one machine's set; a `session:*` frame
 * whose data carries `host` is consumed here even when it changes nothing, so it can never fall
 * through into the local sessions or a side map.
 */
export function reduceRemoteSessions(
  list: Session[],
  ev: { event: string; data: unknown },
): Session[] | null {
  if (ev.event === "remote:sessions") {
    const { instanceId, sessions } = ev.data as { instanceId: string; sessions: Session[] };
    return [...list.filter((s) => s.host?.instanceId !== instanceId), ...sessions];
  }
  if (!ev.event.startsWith("session:") || !isMirroredFrame(ev.data)) return null;
  return applyMirroredFrame(list, ev.event, ev.data);
}
