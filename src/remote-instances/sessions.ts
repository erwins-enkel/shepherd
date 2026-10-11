/**
 * Session mirror (issue #2762): the sessions running on each connected machine, held here as
 * read-only REFERENCES keyed by (machine instance ID, session ID). They never enter the
 * SessionStore, so `store.list()` — and with it every poller, reaper, autopilot, drain, critic and
 * plan-gate loop — never sees them; and their frames go out through this class's own listener set,
 * never through the server's EventHub, so no server-side subscriber reacts to them either. Only the
 * `/events` socket handler and `GET /api/sessions` read from here.
 *
 * Per machine: open `/events?host=local` with the stored token, then take a snapshot of
 * `GET /api/sessions?host=local` and replay the frames that arrived while it was in flight.
 * `host=local` asks the machine for its OWN sessions only — never the references it mirrors from
 * elsewhere — so two machines connected to each other neither loop nor duplicate; anything that
 * still carries a `host` is dropped here as well.
 *
 * The lifecycle follows the machine's probe (`RemoteInstanceService.onChange`): a connected probe
 * opens the socket or re-snapshots a live one (so drift heals every round), any other result closes
 * it. A lost connection keeps the references, marked `disconnected` with the time of the loss — a
 * connection error is not an end. Reconnecting always goes through a probe first, so a URL that
 * now answers as a different instance can never be mirrored under this one's ID.
 *
 * The token goes into the `Authorization` header of the socket upgrade and the snapshot request,
 * and nowhere else: not into a URL, a frame or a log line.
 */
import type { SessionStore } from "../store";
import { type FetchLike, getRemoteJson, isRecord } from "./client";
import type { RemoteInstanceService, RemoteInstanceSummary } from "./service";

/** Backoff for re-probing a machine whose socket dropped; the regular 60 s round takes over after. */
const RECHECK_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/** A session exactly as its machine reported it (that machine's own Session JSON). */
type RemoteRow = Record<string, unknown> & { id: string };

export interface SessionHost {
  instanceId: string;
  name: string;
  platform: string;
}

export interface SessionConnection {
  state: "connected" | "disconnected";
  /** When this state began; for `disconnected` it is when the shown data was last current. */
  since: number;
}

export type MirroredSession = RemoteRow & { host: SessionHost; connection: SessionConnection };

type Listener = (event: string, data: unknown) => void;

interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  close(): void;
}

/** Opens the live channel to a machine. The default is Bun's WebSocket client. */
export type OpenSocket = (
  url: string,
  headers: Record<string, string>,
  on: SocketHandlers,
) => { close(): void };

type Store = Pick<SessionStore, "getRemoteInstance">;
type Instances = Pick<RemoteInstanceService, "list" | "check">;

interface Link {
  instanceId: string;
  host: SessionHost;
  sessions: Map<string, RemoteRow>;
  /** null until the socket first opened — a machine never synced has no references to show. */
  connection: SessionConnection | null;
  /** Identifies the current socket; callbacks from an older one are ignored. */
  socketToken: object | null;
  socket: { close(): void } | null;
  open: boolean;
  /** Frames received while a snapshot request is in flight, replayed on top of it. */
  buffer: [string, RemoteRow][] | null;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
}

/** Bun's client takes `headers` (absent from the DOM typings) and sends no `Origin`, which the
 *  target's origin check admits as a non-browser client — its auth gate applies unchanged. */
const openWebSocket: OpenSocket = (url, headers, on) => {
  const ws = new WebSocket(url, { headers } as never);
  ws.onopen = () => on.open();
  ws.onmessage = (ev) => on.message(ev.data);
  ws.onclose = () => on.close();
  ws.onerror = () => on.close();
  return ws;
};

/** A machine's own session: a record with an ID and no `host` (a `host` means it is itself a
 *  mirrored reference, which is never passed on). */
function asRow(value: unknown): RemoteRow | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || "host" in value) return null;
  return value as RemoteRow;
}

function parseSnapshot(body: unknown): RemoteRow[] | null {
  if (!Array.isArray(body)) return null;
  return body.flatMap((entry: unknown) => {
    const row = asRow(entry);
    return row ? [row] : [];
  });
}

function parseFrame(raw: unknown): { event: string; data: RemoteRow } | null {
  if (typeof raw !== "string") return null;
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(frame) || typeof frame.event !== "string" || !frame.event.startsWith("session:")) {
    return null;
  }
  const data = asRow(frame.data);
  return data ? { event: frame.event, data } : null;
}

/** Display names that are unique across machines: a name two machines share gets the first four
 *  characters of each one's instance ID, so "MacBook · TASK-07" can never mean two sessions. */
export function hostNames(
  machines: Pick<RemoteInstanceSummary, "instanceId" | "name">[],
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

export class RemoteSessionMirror {
  private readonly links = new Map<string, Link>();
  private readonly listeners = new Set<Listener>();
  private readonly store: Store;
  private readonly instances: Instances;
  private readonly fetch: FetchLike | undefined;
  private readonly openSocket: OpenSocket;
  private readonly now: () => number;
  private readonly recheckDelays: number[];

  constructor(deps: {
    store: Store;
    instances: Instances;
    fetch?: FetchLike;
    openSocket?: OpenSocket;
    now?: () => number;
    recheckDelaysMs?: number[];
  }) {
    this.store = deps.store;
    this.instances = deps.instances;
    this.fetch = deps.fetch;
    this.openSocket = deps.openSocket ?? openWebSocket;
    this.now = deps.now ?? Date.now;
    this.recheckDelays = deps.recheckDelaysMs ?? RECHECK_DELAYS_MS;
  }

  /** Every mirrored session, annotated with its machine and the connection state. */
  list(): MirroredSession[] {
    return [...this.links.values()].flatMap((link) => this.refs(link));
  }

  /** Receives relayed `session:*` frames (annotated) and `remote:sessions` replacements. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Follow a machine's current state — called after each of its probes, renames and removal. */
  sync(instanceId: string): void {
    const machines = this.instances.list();
    const machine = machines.find((m) => m.instanceId === instanceId);
    if (!machine) return this.drop(instanceId);
    const link = this.link(machine, hostNames(machines).get(instanceId)!);
    if (machine.status === "connected") this.ensureLive(link);
    else if (machine.status !== "checking") this.disconnect(link);
  }

  stop(): void {
    for (const instanceId of [...this.links.keys()]) this.drop(instanceId, false);
  }

  private link(machine: RemoteInstanceSummary, name: string): Link {
    let link = this.links.get(machine.instanceId);
    if (!link) {
      link = {
        instanceId: machine.instanceId,
        host: { instanceId: machine.instanceId, name, platform: "unknown" },
        sessions: new Map(),
        connection: null,
        socketToken: null,
        socket: null,
        open: false,
        buffer: null,
        attempt: 0,
        retry: null,
      };
      this.links.set(machine.instanceId, link);
    }
    link.host = {
      instanceId: machine.instanceId,
      name,
      platform: machine.info?.platform ?? link.host.platform,
    };
    return link;
  }

  private ensureLive(link: Link): void {
    if (!link.socket) this.connect(link);
    else if (link.open) void this.refresh(link);
  }

  private connect(link: Link): void {
    const row = this.store.getRemoteInstance(link.instanceId);
    if (!row) return;
    const token = {};
    link.socketToken = token;
    const current = () => link.socketToken === token;
    link.socket = this.openSocket(
      `${row.url.replace(/^http/, "ws")}/events?host=local`,
      { authorization: `Bearer ${row.token}` },
      {
        open: () => {
          if (!current()) return;
          link.open = true;
          link.attempt = 0;
          if (link.connection?.state !== "connected") {
            link.connection = { state: "connected", since: this.now() };
          }
          void this.refresh(link);
        },
        message: (raw) => {
          if (current() && link.open) this.receive(link, raw);
        },
        close: () => {
          if (current()) this.disconnect(link);
        },
      },
    );
  }

  /** Replace the machine's sessions with a fresh snapshot, then replay what arrived meanwhile. */
  private async refresh(link: Link): Promise<void> {
    const row = this.store.getRemoteInstance(link.instanceId);
    if (link.buffer || !row) return;
    const token = link.socketToken;
    link.buffer = [];
    const res = await getRemoteJson(row, "/api/sessions?host=local", { fetch: this.fetch });
    const buffered = link.buffer;
    link.buffer = null;
    if (this.links.get(link.instanceId) !== link) return;
    if (link.socketToken !== token) {
      // The socket was replaced while this request was out: the new one's snapshot was skipped
      // as a duplicate, so take it now.
      if (link.open) void this.refresh(link);
      return;
    }
    const sessions = res.ok ? parseSnapshot(res.body) : null;
    if (!sessions) {
      console.warn(
        `[remote-sessions] ${link.host.name}: snapshot failed (${res.ok ? "bad_response" : res.failure.reason})`,
      );
      return this.disconnect(link);
    }
    link.sessions = new Map(sessions.map((s) => [s.id, s]));
    for (const [event, data] of buffered) this.patch(link, event, data);
    this.publish(link);
  }

  private receive(link: Link, raw: unknown): void {
    const frame = parseFrame(raw);
    if (!frame) return;
    if (link.buffer) link.buffer.push([frame.event, frame.data]);
    else this.patch(link, frame.event, frame.data);
    this.emit(frame.event, this.annotate(link, frame.data));
  }

  /** Keep the held copy current for what `GET /api/sessions` serves. Other frames only relay; the
   *  next snapshot (every probe round) carries their effect. */
  private patch(link: Link, event: string, data: RemoteRow): void {
    if (event === "session:new") link.sessions.set(data.id, data);
    else if (event === "session:archived") link.sessions.delete(data.id);
    else if (event === "session:status" || event === "session:renamed") {
      const current = link.sessions.get(data.id);
      if (current) link.sessions.set(data.id, { ...current, ...data });
    }
  }

  /** Socket gone — dropped by the machine, failed, or closed because the probe failed. The
   *  references stay, marked disconnected; a probe is re-tried on a short backoff. */
  private disconnect(link: Link): void {
    const socket = link.socket;
    link.socketToken = null;
    link.socket = null;
    link.open = false;
    socket?.close();
    if (link.connection?.state === "connected") {
      link.connection = { state: "disconnected", since: this.now() };
      this.publish(link);
    }
    this.scheduleRecheck(link);
  }

  private scheduleRecheck(link: Link): void {
    if (link.retry || link.attempt >= this.recheckDelays.length) return;
    const delay = this.recheckDelays[link.attempt++]!;
    link.retry = setTimeout(() => {
      link.retry = null;
      // A failed recheck leaves the next one (or the regular probe round) to try again.
      this.instances.check(link.instanceId).catch(() => {});
    }, delay);
    link.retry.unref?.();
  }

  private drop(instanceId: string, announce = true): void {
    const link = this.links.get(instanceId);
    if (!link) return;
    this.links.delete(instanceId);
    if (link.retry) clearTimeout(link.retry);
    const socket = link.socket;
    link.socketToken = null;
    link.socket = null;
    socket?.close();
    if (announce) this.emit("remote:sessions", { instanceId, sessions: [] });
  }

  private publish(link: Link): void {
    this.emit("remote:sessions", { instanceId: link.instanceId, sessions: this.refs(link) });
  }

  private refs(link: Link): MirroredSession[] {
    if (!link.connection) return [];
    return [...link.sessions.values()].map((row) => this.annotate(link, row));
  }

  private annotate(link: Link, row: RemoteRow): MirroredSession {
    return { ...row, host: link.host, connection: link.connection! };
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.listeners) listener(event, data);
  }
}
