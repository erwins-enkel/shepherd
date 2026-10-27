import type { RemoteInstance, RepoEntry, Session, SessionConnection, SessionHost } from "./types";
import { m } from "#lib/paraglide/messages.js";

/**
 * Sessions mirrored from connected machines (#2762) — references the server marks with `host` +
 * `connection`; the actions it forwards to their machine (#2765) run there, never here. The store
 * keeps them apart from its own `sessions`, so nothing that acts on a local session (attention
 * queue, merge train, side maps) ever sees one. Only the herd's view joins them into its lifecycle
 * groups (#3055), with the PR state their machine reports (`git`).
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

/**
 * The herd's machine filter (#3055): every machine, this Shepherd's own sessions, or one connected
 * machine by instance ID. Instance IDs are UUIDs, so they never read as "all" or "local".
 */
export type MachineFilter = "all" | "local" | (string & {});

/** What the herd lists under `filter` — sessions or unconfirmed tasks alike: a local one has no
 *  `host`, a mirrored one names its machine. */
export function byMachine<T extends { host?: SessionHost }>(
  items: readonly T[],
  filter: MachineFilter,
): T[] {
  if (filter === "all") return [...items];
  if (filter === "local") return items.filter((x) => !x.host);
  return items.filter((x) => x.host?.instanceId === filter);
}

/**
 * The mirrored sessions a repo filter keeps: those whose project (`remoteSlug`, as their machine's
 * repo index names it) is the project of a selected repo. The filter names this Shepherd's
 * checkouts by path, which a session on another machine never shares, so the match is by slug,
 * ignoring case. Every session while no repo is selected.
 */
export function inRepoFilter(
  remote: readonly Session[],
  repoFilter: ReadonlySet<string>,
  repos: readonly Pick<RepoEntry, "path" | "realPath" | "remoteSlug">[],
): Session[] {
  if (repoFilter.size === 0) return [...remote];
  const slugs = new Set(
    repos.flatMap((r) =>
      r.remoteSlug && (repoFilter.has(r.path) || repoFilter.has(r.realPath))
        ? [r.remoteSlug.toLowerCase()]
        : [],
    ),
  );
  return remote.filter((s) => !!s.remoteSlug && slugs.has(s.remoteSlug.toLowerCase()));
}

/**
 * Display names that are unique across machines, so a machine chip reads like the label on its
 * sessions. DRIFT: mirrors `hostNames` in src/remote-instances/sessions.ts, which names the `host`
 * of every mirrored session — a name two machines share gets each one's first four ID characters.
 */
export function machineDisplayNames(
  machines: readonly Pick<RemoteInstance, "instanceId" | "name">[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { name } of machines) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(
    machines.map(({ instanceId, name }) => [
      instanceId,
      counts.get(name)! > 1 ? `${name} (${instanceId.slice(0, 4)})` : name,
    ]),
  );
}

/** Data hues a machine may wear (#3055) — identity, never a status color. */
const MACHINE_HUES = 6;

/**
 * A machine's color: its place among the configured machines in the order they were connected,
 * so it stays the same across reloads and devices and the first six machines never share one.
 * Null for a machine not (yet) in the list — its label then stays neutral.
 */
export function machineColorVar(
  instanceId: string,
  machines: readonly Pick<RemoteInstance, "instanceId" | "createdAt">[],
): string | null {
  const order = [...machines].sort(
    (a, b) => a.createdAt - b.createdAt || a.instanceId.localeCompare(b.instanceId),
  );
  const slot = order.findIndex((x) => x.instanceId === instanceId);
  return slot === -1 ? null : `var(--color-data-${(slot % MACHINE_HUES) + 1})`;
}

/**
 * Mirrored sessions the jump to the next waiting session may land on (#3055): blocked, on a machine
 * whose link is live — an answer or a plan approval is forwarded there (#2765), so the jump leads
 * somewhere the operator can act. The machines mirror no block reason or time, so the longest
 * unchanged comes first by its last update.
 */
export function mirroredNeedsYou(remote: readonly Session[]): string[] {
  return remote
    .filter(
      (s) =>
        isMirrored(s) && s.connection.state === "connected" && s.status === "blocked" && !s.shelved,
    )
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((s) => s.id);
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
    case "session:git":
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
