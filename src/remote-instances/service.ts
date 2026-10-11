/**
 * Connected machines (issue #2759): other Shepherd instances this one has been explicitly
 * connected to with a URL and a `full`, unrestricted access token minted on the target.
 *
 * Rows live in SQLite (`remote_instances`, keyed by the REMOTE's instance ID); each machine's
 * connection state lives in memory and is refreshed by a periodic probe (`client.ts`). With no
 * row there is no probe and therefore no outbound connection at all.
 *
 * The stored token is a credential for the other machine. It leaves this module only towards
 * that machine: summaries are built field by field and carry at most a 4-character hint, nothing
 * here emits an event, and logs name the machine and a status code — never the token or a header.
 */
import type { SessionStore } from "../store";
import {
  type InstanceIdentity,
  instanceIdentity,
  isSingleKeyBody,
  parseOptionalName,
} from "./identity";
import {
  type CapabilityReport,
  type CapabilitySnapshot,
  capabilityReport,
  platformReleased,
} from "./capabilities";
import { type FetchLike, type ProbeOutcome, isRecord, probeRemote } from "./client";

const REMOTE_PROBE_INTERVAL_MS = 60_000;

const TOKEN_RE = /^\S{1,1024}$/;

/** Below this length a 4-character hint gives away too much of an operator-chosen env token. */
const TOKEN_HINT_MIN_LENGTH = 20;

/** A row as it sits in SQLite. `label` null = show the name the machine reports. */
export interface RemoteInstanceRow {
  instanceId: string;
  url: string;
  token: string;
  label: string | null;
  reportedName: string;
  createdAt: number;
}

export type RemoteInstanceStatus =
  "checking" | "connected" | "unreachable" | "unauthorized" | "incompatible" | "identity_mismatch";

type MachineInfo = Omit<InstanceIdentity, "instanceId" | "name">;

/** What the API and the UI see. Never the token. */
export interface RemoteInstanceSummary {
  instanceId: string;
  name: string;
  label: string | null;
  reportedName: string;
  url: string;
  tokenHint: string | null;
  createdAt: number;
  status: RemoteInstanceStatus;
  reason: string | null;
  checkedAt: number | null;
  /** Last successful probe in this process; `info` and `projects` are from that probe. */
  lastSeenAt: number | null;
  info: MachineInfo | null;
  projects: string[] | null;
  /** The machine's verified capabilities (#2770) from the last successful probe, aged on this
   *  clock; null when it has not reported any. */
  capabilities: CapabilityReport | null;
  /** Whether the machine's platform is cleared to run tasks. Windows is listed but not released;
   *  pickers must offer only released machines. False while the platform is unknown. */
  released: boolean;
}

interface ProbeState {
  status: Exclude<RemoteInstanceStatus, "checking">;
  reason: string | null;
  checkedAt: number;
  lastSeenAt: number | null;
  info: MachineInfo | null;
  projects: string[] | null;
  capabilities: CapabilitySnapshot | null;
}

export interface ConnectRequest {
  url: string;
  token: string;
  label: string | null;
}

export type ConnectError =
  | "remote_unreachable"
  | "remote_unauthorized"
  | "remote_incompatible"
  | "self_connection"
  | "already_connected";

export type ConnectResult =
  | { ok: true; instance: RemoteInstanceSummary }
  | { ok: false; error: ConnectError; reason?: string };

type Store = Pick<
  SessionStore,
  | "getSetting"
  | "setSetting"
  | "deleteSetting"
  | "listRemoteInstances"
  | "getRemoteInstance"
  | "insertRemoteInstance"
  | "updateRemoteInstanceLabel"
  | "updateRemoteInstanceReportedName"
  | "deleteRemoteInstance"
>;

/**
 * A machine's base URL: http(s), no credentials, query or fragment (the URL is shown and logged,
 * and the token is the only credential). Stored as origin + path without a trailing slash.
 * Loopback is allowed — two instances on one host is a legitimate setup.
 */
export function normalizeRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Validate a `POST /api/remote-instances` body; the error is a machine code the UI maps. */
export function parseConnectRequest(body: unknown): ConnectRequest | { error: string } {
  if (!isRecord(body) || Object.keys(body).some((k) => !["url", "token", "label"].includes(k))) {
    return { error: "invalid_body" };
  }
  const url = normalizeRemoteUrl(body.url);
  if (!url) return { error: "invalid_url" };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!TOKEN_RE.test(token)) return { error: "invalid_token" };
  const label = body.label === undefined ? null : parseOptionalName(body.label);
  if (label === undefined) return { error: "invalid_label" };
  return { url, token, label };
}

/** Validate a `PATCH /api/remote-instances/{id}` body. */
export function parseLabelPatch(body: unknown): { label: string | null } | { error: string } {
  if (!isSingleKeyBody(body, "label")) return { error: "invalid_body" };
  const label = parseOptionalName(body.label);
  return label === undefined ? { error: "invalid_label" } : { label };
}

function machineInfo({ version, federationApi, platform, arch }: InstanceIdentity): MachineInfo {
  return { version, federationApi, platform, arch };
}

export class RemoteInstanceService {
  private readonly states = new Map<string, ProbeState>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(instanceId: string) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: Store;
  private readonly fetch: FetchLike | undefined;
  private readonly now: () => number;

  constructor(deps: { store: Store; fetch?: FetchLike; now?: () => number }) {
    this.store = deps.store;
    this.fetch = deps.fetch;
    this.now = deps.now ?? Date.now;
  }

  list(): RemoteInstanceSummary[] {
    return this.store.listRemoteInstances().map((row) => this.summary(row));
  }

  get(instanceId: string): RemoteInstanceSummary | null {
    const row = this.store.getRemoteInstance(instanceId);
    return row ? this.summary(row) : null;
  }

  /** Called with the machine's ID after every probe result, rename and removal — the session
   *  mirror (#2762) follows a machine's state through this. Returns the unsubscribe. */
  onChange(listener: (instanceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Probe the target first and store it only once it answers as a compatible, distinct machine. */
  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const outcome = await probeRemote(req, { fetch: this.fetch, now: this.now });
    if (outcome.status !== "connected") {
      return { ok: false, error: `remote_${outcome.status}`, reason: outcome.reason };
    }
    const { instanceId, name } = outcome.info;
    if (instanceId === instanceIdentity(this.store).instanceId) {
      return { ok: false, error: "self_connection" };
    }
    if (this.store.getRemoteInstance(instanceId)) return { ok: false, error: "already_connected" };
    const row: RemoteInstanceRow = {
      instanceId,
      url: req.url,
      token: req.token,
      label: req.label,
      reportedName: name,
      createdAt: this.now(),
    };
    this.store.insertRemoteInstance(row);
    this.apply(row, outcome);
    return { ok: true, instance: this.summary(row) };
  }

  rename(instanceId: string, label: string | null): RemoteInstanceSummary | null {
    if (!this.store.updateRemoteInstanceLabel(instanceId, label)) return null;
    this.notify(instanceId);
    return this.get(instanceId);
  }

  remove(instanceId: string): boolean {
    const removed = this.store.deleteRemoteInstance(instanceId);
    this.states.delete(instanceId);
    if (removed) this.notify(instanceId);
    return removed;
  }

  /** Probe one machine now (joining a probe already in flight) and return its fresh summary. */
  async check(instanceId: string): Promise<RemoteInstanceSummary | null> {
    const row = this.store.getRemoteInstance(instanceId);
    if (!row) return null;
    await this.probe(row);
    const current = this.store.getRemoteInstance(instanceId);
    return current ? this.summary(current) : null;
  }

  /** One round over every machine. No rows ⇒ no request. */
  async probeAll(): Promise<void> {
    await Promise.all(this.store.listRemoteInstances().map((row) => this.probe(row)));
  }

  start(): void {
    if (this.timer) return;
    this.round();
    this.timer = setInterval(() => this.round(), REMOTE_PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A timer tick: probes never throw, but a store error must log, not float as a rejection. */
  private round(): void {
    this.probeAll().catch((err: unknown) =>
      console.warn(
        "[remote-instances] check round failed:",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  private probe(row: RemoteInstanceRow): Promise<void> {
    const running = this.inflight.get(row.instanceId);
    if (running) return running;
    const run = this.runProbe(row).finally(() => this.inflight.delete(row.instanceId));
    this.inflight.set(row.instanceId, run);
    return run;
  }

  private async runProbe(row: RemoteInstanceRow): Promise<void> {
    const outcome = await probeRemote(row, { fetch: this.fetch, now: this.now });
    // Removed (or re-added) while the probe was out: its result belongs to nobody.
    const current = this.store.getRemoteInstance(row.instanceId);
    if (!current || current.createdAt !== row.createdAt) return;
    if (outcome.status === "connected" && outcome.info.instanceId !== current.instanceId) {
      this.apply(current, { status: "identity_mismatch" });
      return;
    }
    if (outcome.status === "connected" && outcome.info.name !== current.reportedName) {
      this.store.updateRemoteInstanceReportedName(current.instanceId, outcome.info.name);
      current.reportedName = outcome.info.name;
    }
    this.apply(current, outcome);
  }

  /** Record a probe result. A failure keeps the last successful info/projects/capabilities
   *  ("last seen"); the capabilities keep ageing, so a machine out of reach turns stale. */
  private apply(row: RemoteInstanceRow, outcome: ProbeOutcome | { status: "identity_mismatch" }) {
    const prev = this.states.get(row.instanceId);
    const at = this.now();
    const next: ProbeState =
      outcome.status === "connected"
        ? {
            status: "connected",
            reason: null,
            checkedAt: at,
            lastSeenAt: at,
            info: machineInfo(outcome.info),
            projects: outcome.projects,
            capabilities: outcome.capabilities,
          }
        : {
            status: outcome.status,
            reason: "reason" in outcome ? outcome.reason : null,
            checkedAt: at,
            lastSeenAt: prev?.lastSeenAt ?? null,
            info: prev?.info ?? null,
            projects: prev?.projects ?? null,
            capabilities: prev?.capabilities ?? null,
          };
    this.states.set(row.instanceId, next);
    this.notify(row.instanceId);
    if (prev?.status === next.status && prev.reason === next.reason) return;
    const line = `[remote-instances] ${row.label ?? row.reportedName}: ${next.status}${next.reason ? ` (${next.reason})` : ""}`;
    if (next.status === "connected") console.log(line);
    else console.warn(line);
  }

  private notify(instanceId: string): void {
    for (const listener of this.listeners) listener(instanceId);
  }

  private summary(row: RemoteInstanceRow): RemoteInstanceSummary {
    const state = this.states.get(row.instanceId);
    return {
      instanceId: row.instanceId,
      name: row.label ?? row.reportedName,
      label: row.label,
      reportedName: row.reportedName,
      url: row.url,
      tokenHint: row.token.length >= TOKEN_HINT_MIN_LENGTH ? row.token.slice(-4) : null,
      createdAt: row.createdAt,
      status: state?.status ?? "checking",
      reason: state?.reason ?? null,
      checkedAt: state?.checkedAt ?? null,
      lastSeenAt: state?.lastSeenAt ?? null,
      info: state?.info ?? null,
      projects: state?.projects ?? null,
      capabilities: state?.capabilities ? capabilityReport(state.capabilities, this.now()) : null,
      released: state?.info ? platformReleased(state.info.platform) : false,
    };
  }
}
