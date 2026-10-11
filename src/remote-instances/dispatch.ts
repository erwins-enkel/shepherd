/**
 * Remote dispatch (issue #2763): a new task this Shepherd sends to a connected machine, where the
 * WHOLE session — worktree, herdr, agent — runs. This module is the only place that sends one;
 * the create handler validates, authorizes and hands over, and implements no remote logic itself.
 *
 * Order, and why:
 * 1. Pre-flight, nothing stored: the machine is known, connected and has the project (its forge
 *    slug) checked out; the project is mapped to the machine's own checkout through its fresh
 *    `GET /api/repos`. A refusal here has sent nothing, so the client can simply submit again.
 * 2. The dispatch is stored (`remote_dispatches`) BEFORE it is sent: the machine it goes to, the
 *    exact body, and a dispatch ID generated here — never the client's key, so keys two clients
 *    happen to share can never collide at the machine.
 * 3. `POST /api/sessions` on the machine with `Idempotency-Key: <dispatch ID>` (#2761): however
 *    often it arrives, the machine starts it at most once and replays the outcome.
 *
 * A retry (same client key) goes out again with the stored body, under the same dispatch ID, to the
 * machine stored with it — never to another one, whatever the machine list says now. A different
 * body under a used key is refused before anything is sent. No answer after sending is `unknown`:
 * the task may be running there, and only the same dispatch may ask again.
 */
import { randomUUID } from "node:crypto";
import type { SessionStore } from "../store";
import {
  type FetchLike,
  type RemotePostResult,
  getRemoteJson,
  isRecord,
  parseProjectPath,
  postRemoteJson,
} from "./client";
import type { RemoteInstanceService } from "./service";
import { type SessionHost, hostNames } from "./sessions";

/** A create waits for the machine's worktree and agent boot; the coordinator waits that long too. */
const REMOTE_CREATE_TIMEOUT_MS = 120_000;

/** `sending` = stored, no answer yet; `unknown` = sent, no answer — it may have started. */
type RemoteDispatchState = "sending" | "started" | "held" | "rejected" | "unknown";

/** A row as it sits in SQLite. */
export interface RemoteDispatchRow {
  /** The dispatch ID: generated here, the machine's `Idempotency-Key`. */
  id: string;
  /** The submitter's `Idempotency-Key` (or `id` when it sent none) — what a retry names. */
  clientKey: string;
  instanceId: string;
  /** sha256 of the submitter's canonical body, `target` included. */
  payloadHash: string;
  /** Exactly what is POSTed to the machine — every retry sends this same text. */
  wireBody: string;
  state: RemoteDispatchState;
  sessionId: string | null;
  heldId: string | null;
  reason: string | null;
  code: string | null;
  httpStatus: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RemoteDispatchOutcome = Pick<
  RemoteDispatchRow,
  "state" | "sessionId" | "heldId" | "reason" | "code" | "httpStatus"
>;

export interface RemoteSubmit {
  /** The submitter's `Idempotency-Key`; undefined = a fresh one is generated (and reported). */
  clientKey: string | undefined;
  instanceId: string;
  /** Forge slug (`owner/repo`) of the project, the identity it is matched on. */
  project: string;
  /** The validated create body without `target`; `repoPath` is replaced by the machine's path. */
  body: Record<string, unknown>;
  /** Hash of the submitter's whole body. */
  payloadHash: string;
}

export type RemoteRefusalCode =
  | "remote_target_unknown"
  | "remote_target_unavailable"
  | "remote_project_missing"
  | "dispatch_payload_mismatch";

export type RemoteOutcome =
  | { kind: "started"; session: Record<string, unknown> & { host: SessionHost } }
  | { kind: "held"; id: string; count: number; host: SessionHost }
  | {
      kind: "rejected";
      host: SessionHost;
      reason: string;
      remoteStatus: number;
      remoteCode: string | null;
    }
  | { kind: "unknown"; host: SessionHost; dispatchKey: string }
  | { kind: "refused"; code: RemoteRefusalCode; reason: string | null };

type Store = Pick<
  SessionStore,
  "getRemoteInstance" | "insertRemoteDispatch" | "getRemoteDispatchByKey" | "settleRemoteDispatch"
>;
type Instances = Pick<RemoteInstanceService, "get" | "list">;

const NO_OUTCOME = { sessionId: null, heldId: null, reason: null, code: null, httpStatus: null };

function refused(code: RemoteRefusalCode, reason: string | null = null): RemoteOutcome {
  return { kind: "refused", code, reason };
}

export class RemoteDispatcher {
  /** Sends running in this process, by dispatch ID — a concurrent duplicate waits for its outcome. */
  private readonly inflight = new Map<string, Promise<RemoteOutcome>>();
  private readonly store: Store;
  private readonly instances: Instances;
  private readonly fetch: FetchLike | undefined;
  private readonly now: () => number;

  constructor(deps: { store: Store; instances: Instances; fetch?: FetchLike; now?: () => number }) {
    this.store = deps.store;
    this.instances = deps.instances;
    this.fetch = deps.fetch;
    this.now = deps.now ?? Date.now;
  }

  async submit(req: RemoteSubmit): Promise<RemoteOutcome> {
    const clientKey = req.clientKey ?? randomUUID();
    const existing = this.store.getRemoteDispatchByKey(clientKey);
    if (existing) return this.retry(existing, req.payloadHash);

    const path = await this.targetPath(req);
    if (typeof path !== "string") return path;
    const at = this.now();
    const row: RemoteDispatchRow = {
      id: randomUUID(),
      clientKey,
      instanceId: req.instanceId,
      payloadHash: req.payloadHash,
      wireBody: JSON.stringify({ ...req.body, repoPath: path }),
      state: "sending",
      ...NO_OUTCOME,
      createdAt: at,
      updatedAt: at,
    };
    if (!this.store.insertRemoteDispatch(row)) {
      // A concurrent submit with the same key stored its row first: this is a retry of that one.
      const winner = this.store.getRemoteDispatchByKey(clientKey);
      return winner ? this.retry(winner, req.payloadHash) : refused("dispatch_payload_mismatch");
    }
    return this.track(row);
  }

  /** Pre-flight: the machine's own path for the project, or why it cannot take the task. */
  private async targetPath(req: RemoteSubmit): Promise<string | RemoteOutcome> {
    const machine = this.instances.get(req.instanceId);
    const creds = this.store.getRemoteInstance(req.instanceId);
    if (!machine || !creds) return refused("remote_target_unknown");
    if (machine.status !== "connected") {
      return refused("remote_target_unavailable", machine.reason ?? machine.status);
    }
    if (!machine.projects?.includes(req.project)) return refused("remote_project_missing");
    const repos = await getRemoteJson(creds, "/api/repos", { fetch: this.fetch });
    if (!repos.ok) return refused("remote_target_unavailable", repos.failure.reason);
    return parseProjectPath(repos.body, req.project) ?? refused("remote_project_missing");
  }

  private retry(row: RemoteDispatchRow, payloadHash: string): Promise<RemoteOutcome> {
    if (row.payloadHash !== payloadHash) {
      return Promise.resolve(refused("dispatch_payload_mismatch"));
    }
    return this.inflight.get(row.id) ?? this.track(row);
  }

  /** Send `row`, registered as in flight in the same tick, so a duplicate always finds it. */
  private track(row: RemoteDispatchRow): Promise<RemoteOutcome> {
    const run = this.send(row).finally(() => this.inflight.delete(row.id));
    this.inflight.set(row.id, run);
    return run;
  }

  private async send(row: RemoteDispatchRow): Promise<RemoteOutcome> {
    const creds = this.store.getRemoteInstance(row.instanceId);
    if (!creds) return refused("remote_target_unavailable", "removed");
    const res = await postRemoteJson(creds, "/api/sessions", row.wireBody, {
      fetch: this.fetch,
      timeoutMs: REMOTE_CREATE_TIMEOUT_MS,
      headers: { "idempotency-key": row.id },
    });
    const host = this.host(row.instanceId);
    const { outcome, record } = this.read(res, row, host);
    this.store.settleRemoteDispatch(row.id, record, this.now());
    const line = `[remote-dispatch] ${host.name}: ${record.state}${record.httpStatus ? ` (${record.httpStatus})` : ""}`;
    if (record.state === "started" || record.state === "held") console.log(line);
    else console.warn(line);
    return outcome;
  }

  /** What the machine's answer means. Only an HTTP answer from the machine settles a dispatch; a
   *  missing or unreadable one (a proxy page) leaves it `unknown`. */
  private read(
    res: RemotePostResult,
    row: RemoteDispatchRow,
    host: SessionHost,
  ): { outcome: RemoteOutcome; record: RemoteDispatchOutcome } {
    const noAnswer = {
      outcome: { kind: "unknown", host, dispatchKey: row.clientKey } as const,
      record: { ...NO_OUTCOME, state: "unknown" as const },
    };
    if (res.kind === "no_answer" || !isRecord(res.body)) return noAnswer;
    const { status, body } = res;
    const id = typeof body.id === "string" ? body.id : null;
    if (status === 201 && id) {
      const connection = { state: "connected", since: this.now() };
      return {
        outcome: { kind: "started", session: { ...body, host, connection } },
        record: { ...NO_OUTCOME, state: "started", sessionId: id },
      };
    }
    if (status === 200 && body.held === true && id) {
      const count = typeof body.count === "number" ? body.count : 0;
      return {
        outcome: { kind: "held", id, count, host },
        record: { ...NO_OUTCOME, state: "held", heldId: id },
      };
    }
    if (typeof body.error !== "string") return noAnswer;
    const code = typeof body.code === "string" ? body.code : null;
    return {
      outcome: {
        kind: "rejected",
        host,
        reason: body.error,
        remoteStatus: status,
        remoteCode: code,
      },
      record: { ...NO_OUTCOME, state: "rejected", reason: body.error, code, httpStatus: status },
    };
  }

  /** The machine as a session's `host` names it: unique display name and platform. */
  private host(instanceId: string): SessionHost {
    const machines = this.instances.list();
    const machine = machines.find((m) => m.instanceId === instanceId);
    return {
      instanceId,
      name: hostNames(machines).get(instanceId) ?? instanceId.slice(0, 8),
      platform: machine?.info?.platform ?? "unknown",
    };
  }
}
