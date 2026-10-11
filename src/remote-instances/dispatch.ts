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
 * 3. Attachments (#2766), right before it is sent: each staged file goes to the machine's
 *    `POST /api/uploads` and `images` then names the machine's copies, never a path of this one.
 *    Those paths are stored with the dispatch, so every later send of it reuses them — nothing is
 *    uploaded twice and the body the machine sees never changes. An attachment that does not get
 *    there ends the dispatch before it is sent (`upload_failed`): under that key nothing starts.
 * 4. `POST /api/sessions` on the machine with `Idempotency-Key: <dispatch ID>` (#2761): however
 *    often it arrives, the machine starts it at most once and replays the outcome.
 *
 * A retry (same client key) goes out again with the stored body, under the same dispatch ID, to the
 * machine stored with it — never to another one, whatever the machine list says now. A different
 * body under a used key is refused before anything is sent. No answer after sending is `unknown`:
 * the task may be running there, and only the same dispatch may ask again.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { SessionStore } from "../store";
import {
  type FetchLike,
  type RemotePostResult,
  type RemoteTarget,
  getRemoteJson,
  isRecord,
  parseProjectPath,
  postRemoteFile,
  postRemoteJson,
} from "./client";
import type { RemoteInstanceService } from "./service";
import { type SessionHost, hostNames } from "./sessions";

/** A create waits for the machine's worktree and agent boot; the coordinator waits that long too. */
const REMOTE_CREATE_TIMEOUT_MS = 120_000;

/** Per attachment: as long as the machine's own `/api/uploads` lets one take. */
const REMOTE_UPLOAD_TIMEOUT_MS = 120_000;

/** `sending` = stored, no answer yet; `unknown` = sent, no answer — it may have started;
 *  `upload_failed` = an attachment did not reach the machine, so the task was never sent. */
type RemoteDispatchState =
  "sending" | "started" | "held" | "rejected" | "unknown" | "upload_failed";

/** A row as it sits in SQLite. */
export interface RemoteDispatchRow {
  /** The dispatch ID: generated here, the machine's `Idempotency-Key`. */
  id: string;
  /** The submitter's `Idempotency-Key` (or `id` when it sent none) — what a retry names. */
  clientKey: string;
  instanceId: string;
  /** sha256 of the submitter's canonical body, `target` included. */
  payloadHash: string;
  /** Exactly what is POSTed to the machine — every retry sends this same text — except `images`:
   *  here this machine's staged files, swapped for `uploads` when it is sent (#2766). */
  wireBody: string;
  state: RemoteDispatchState;
  sessionId: string | null;
  heldId: string | null;
  reason: string | null;
  code: string | null;
  httpStatus: number | null;
  createdAt: number;
  updatedAt: number;
  /** JSON array: the machine's path of each of `images`, index-aligned. Set once, by the first
   *  send, before it POSTs the task; null until then and for a task without attachments. */
  uploads: string | null;
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
  /** The validated create body without `target`; `repoPath` is replaced by the machine's path.
   *  `images`, if any, are this machine's staged files (validated real paths). */
  body: Record<string, unknown>;
  /** Hash of the submitter's whole body. */
  payloadHash: string;
}

export type RemoteRefusalCode =
  | "remote_target_unknown"
  | "remote_target_unavailable"
  | "remote_target_unreleased"
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
  | { kind: "upload_failed"; host: SessionHost; reason: string }
  | { kind: "refused"; code: RemoteRefusalCode; reason: string | null };

/** Why an attachment did not reach the machine; `httpStatus` when the machine answered. */
interface UploadFailure {
  reason: string;
  httpStatus: number | null;
}

type Store = Pick<
  SessionStore,
  | "getRemoteInstance"
  | "insertRemoteDispatch"
  | "getRemoteDispatchByKey"
  | "setRemoteDispatchUploads"
  | "settleRemoteDispatch"
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
      uploads: null,
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
    // A platform not cleared to run tasks (Windows, #2770) is listed but never sent a task.
    if (!machine.released) return refused("remote_target_unreleased", machine.info?.platform);
    if (!machine.projects?.includes(req.project)) return refused("remote_project_missing");
    const repos = await getRemoteJson(creds, "/api/repos", { fetch: this.fetch });
    if (!repos.ok) return refused("remote_target_unavailable", repos.failure.reason);
    return parseProjectPath(repos.body, req.project) ?? refused("remote_project_missing");
  }

  private retry(row: RemoteDispatchRow, payloadHash: string): Promise<RemoteOutcome> {
    if (row.payloadHash !== payloadHash) {
      return Promise.resolve(refused("dispatch_payload_mismatch"));
    }
    // Ended before it was sent (#2766): it never goes out under this key, so its machine has
    // nothing to replay — the refusal is.
    if (row.state === "upload_failed") {
      const host = this.host(row.instanceId);
      return Promise.resolve({ kind: "upload_failed", host, reason: row.reason ?? "" });
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
    const wire = await this.wireText(row, creds);
    if (typeof wire !== "string") return this.uploadFailed(row, wire);
    const res = await postRemoteJson(creds, "/api/sessions", wire, {
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

  /** The text to POST (#2766): `wireBody`, its attachments swapped for the machine's copies —
   *  uploaded now, right before the task is sent, or the ones an earlier send of this dispatch
   *  uploaded. A task without attachments goes out exactly as stored. */
  private async wireText(
    row: RemoteDispatchRow,
    creds: RemoteTarget,
  ): Promise<string | UploadFailure> {
    const body = JSON.parse(row.wireBody) as Record<string, unknown>;
    const images = Array.isArray(body.images) ? (body.images as string[]) : [];
    if (images.length === 0) return row.wireBody;
    let uploads = row.uploads;
    if (uploads === null) {
      const uploaded = await this.upload(images, creds);
      if (!Array.isArray(uploaded)) return uploaded;
      uploads = JSON.stringify(uploaded);
      this.store.setRemoteDispatchUploads(row.id, uploads, this.now());
    }
    return JSON.stringify({ ...body, images: JSON.parse(uploads) as string[] });
  }

  /** Each staged file to the machine's staging, in order; the first that does not get there stops
   *  it. Only the stored name (a UUID and a safe extension) travels with the bytes — the name the
   *  operator gave it is `attachmentNames`, which the task carries anyway. */
  private async upload(images: string[], creds: RemoteTarget): Promise<string[] | UploadFailure> {
    const paths: string[] = [];
    for (const [i, local] of images.entries()) {
      const which = `attachment ${i + 1} of ${images.length}`;
      const file = Bun.file(local);
      if (!(await file.exists())) {
        return { reason: `${which} is no longer staged here`, httpStatus: null };
      }
      const res = await postRemoteFile(creds, "/api/uploads", file, basename(local), {
        fetch: this.fetch,
        timeoutMs: REMOTE_UPLOAD_TIMEOUT_MS,
      });
      if (res.kind === "no_answer") {
        return { reason: `${which}: no answer from the machine (${res.reason})`, httpStatus: null };
      }
      const body = isRecord(res.body) ? res.body : {};
      if (res.status !== 200 || typeof body.path !== "string" || !body.path) {
        const why = typeof body.error === "string" ? ` (${body.error})` : "";
        return {
          reason: `${which}: the machine answered ${res.status}${why}`,
          httpStatus: res.status,
        };
      }
      paths.push(body.path);
    }
    return paths;
  }

  /** An attachment did not get there: the task was not sent, and is never sent under this key. */
  private uploadFailed(row: RemoteDispatchRow, failure: UploadFailure): RemoteOutcome {
    const host = this.host(row.instanceId);
    this.store.settleRemoteDispatch(
      row.id,
      {
        ...NO_OUTCOME,
        state: "upload_failed",
        reason: failure.reason,
        code: "remote_upload_failed",
        httpStatus: failure.httpStatus,
      },
      this.now(),
    );
    console.warn(`[remote-dispatch] ${host.name}: upload_failed (${failure.reason})`);
    return { kind: "upload_failed", host, reason: failure.reason };
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
