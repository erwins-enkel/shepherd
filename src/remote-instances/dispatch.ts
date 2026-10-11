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
 *
 * Start status unknown (#2774): an `unknown` dispatch — or one still `sending` that no send in this
 * process runs, i.e. this Shepherd restarted mid-hand-off — is reconciled with its machine after
 * every probe that finds it connected (`reconcile`, wired to the probe in index.ts): its
 * `GET /api/dispatches/{id}` says started, held or failed, and 404 ("never arrived") sends the same
 * task again under the same ID to the same machine. Still starting there, or no answer: it stays
 * unknown until the next check. The operator may cancel an unconfirmed dispatch (`cancel`): its
 * machine's `DELETE /api/dispatches/{id}` makes sure it never starts there, even if it arrives late;
 * a machine out of reach gets that cancel on the next check (`canceling`), and nothing re-sends the
 * task in between. A dispatch dashboards show — unknown, or a cancel on its way — announces each
 * change as `remote:dispatch`, the one that resolves it included. One that never was unconfirmed
 * is never announced: nothing about a session started straight away enters this event hub.
 *
 * One operation per dispatch at a time: a send (`inflight`, shared with a concurrent duplicate) or
 * a check/cancel (`checks`). Each is registered in the same tick as the guard that admitted it.
 */
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { EventHub } from "../events";
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
  requestRemote,
} from "./client";
import type { RemoteInstanceService } from "./service";
import { type SessionHost, hostNames } from "./sessions";

/** A create waits for the machine's worktree and agent boot; the coordinator waits that long too. */
const REMOTE_CREATE_TIMEOUT_MS = 120_000;

/** Per attachment: as long as the machine's own `/api/uploads` lets one take. */
const REMOTE_UPLOAD_TIMEOUT_MS = 120_000;

/** `sending` = stored, no answer yet; `unknown` = sent, no answer — it may have started;
 *  `upload_failed` = an attachment did not reach the machine, so the task was never sent;
 *  `canceling` = the operator cancelled it before the machine confirmed it, and the machine has not
 *  confirmed the cancel yet; `canceled` = it never starts there (#2774). */
export type RemoteDispatchState =
  | "sending"
  | "started"
  | "held"
  | "rejected"
  | "unknown"
  | "upload_failed"
  | "canceling"
  | "canceled";

/** Not confirmed by the machine: what a check re-asks and the herd shows. */
const OPEN_STATES: ReadonlySet<RemoteDispatchState> = new Set(["sending", "unknown", "canceling"]);

/** What dashboards show of an unconfirmed dispatch (a `sending` one is in flight, or adopted as
 *  `unknown` first). */
const SHOWN_STATES: ReadonlySet<RemoteDispatchState> = new Set(["unknown", "canceling"]);

/** A dispatch's `summary` is a one-line label, not the task. */
const SUMMARY_MAX = 120;

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

/** A dispatch as `GET /api/remote-dispatches` lists it and `remote:dispatch` announces it (#2774).
 *  Never the body sent: `summary` is the issue title, else the prompt's first line. A `sending` row
 *  no send in this process runs reads `unknown`. */
export interface RemoteDispatchView {
  id: string;
  state: RemoteDispatchState;
  host: SessionHost;
  summary: string;
  sessionId?: string;
  heldId?: string;
  reason?: string;
  code?: string;
  createdAt: number;
  updatedAt: number;
}

/** What cancelling an unconfirmed dispatch came to: done, pending until its machine answers, or
 *  not possible (sending right now, or the machine already has it — `dispatch` says what it is). */
export type RemoteCancelResult =
  | { kind: "not_found" }
  | { kind: "canceled" | "canceling" | "not_cancelable"; dispatch: RemoteDispatchView };

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
  | { kind: "canceled"; host: SessionHost }
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
  | "getRemoteDispatch"
  | "listOpenRemoteDispatches"
  | "markRemoteDispatchCanceling"
  | "setRemoteDispatchUploads"
  | "settleRemoteDispatch"
>;
type Instances = Pick<RemoteInstanceService, "get" | "list">;

const NO_OUTCOME = { sessionId: null, heldId: null, reason: null, code: null, httpStatus: null };

function refused(code: RemoteRefusalCode, reason: string | null = null): RemoteOutcome {
  return { kind: "refused", code, reason };
}

/** The machine's record of a dispatch (its `GET /api/dispatches/{id}`, #2761) as the outcome here;
 *  null while it is still starting there (`pending`) or when it is not such a record. */
function confirmedOutcome(record: unknown): RemoteDispatchOutcome | null {
  if (!isRecord(record)) return null;
  const text = (key: string) =>
    typeof record[key] === "string" && record[key] ? (record[key] as string) : null;
  const sessionId = text("sessionId");
  if (record.state === "started" && sessionId)
    return { ...NO_OUTCOME, state: "started", sessionId };
  const heldId = text("heldId");
  if (record.state === "held" && heldId) return { ...NO_OUTCOME, state: "held", heldId };
  if (record.state !== "failed") return null;
  return { ...NO_OUTCOME, state: "rejected", reason: text("reason"), code: text("code") };
}

function summaryOf(wireBody: string): string {
  const body = JSON.parse(wireBody) as Record<string, unknown>;
  const issue = isRecord(body.issueRef) ? body.issueRef.title : undefined;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const line =
    (typeof issue === "string" && issue.trim()) ||
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ||
    "";
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

const dispatchPath = (id: string) => `/api/dispatches/${encodeURIComponent(id)}`;

export class RemoteDispatcher {
  /** Sends running in this process, by dispatch ID — a concurrent duplicate waits for its outcome. */
  private readonly inflight = new Map<string, Promise<RemoteOutcome>>();
  /** Checks and cancels running in this process, by dispatch ID (#2774). */
  private readonly checks = new Map<string, Promise<void>>();
  private readonly store: Store;
  private readonly instances: Instances;
  private readonly events: Pick<EventHub, "emit"> | undefined;
  private readonly fetch: FetchLike | undefined;
  private readonly now: () => number;

  constructor(deps: {
    store: Store;
    instances: Instances;
    events?: Pick<EventHub, "emit">;
    fetch?: FetchLike;
    now?: () => number;
  }) {
    this.store = deps.store;
    this.instances = deps.instances;
    this.events = deps.events;
    this.fetch = deps.fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Dispatches no machine has confirmed yet, of machines still connected here — what the herd
   *  shows as "start status unknown". A send in flight here is left out: its answer is coming. */
  list(): RemoteDispatchView[] {
    const machines = new Set(this.instances.list().map((m) => m.instanceId));
    return this.store
      .listOpenRemoteDispatches()
      .filter((row) => machines.has(row.instanceId) && !this.inflight.has(row.id))
      .map((row) => this.view(row));
  }

  /**
   * Ask `instanceId` what became of each dispatch it has not confirmed. Called after every probe of
   * it (reconnect, this Shepherd's start, each round); does nothing unless it is connected. A
   * dispatch already being sent or checked here is left to that.
   */
  async reconcile(instanceId: string): Promise<void> {
    const machine = this.instances.get(instanceId);
    const creds = this.store.getRemoteInstance(instanceId);
    if (machine?.status !== "connected" || !creds) return;
    const rows = this.store.listOpenRemoteDispatches().filter((r) => r.instanceId === instanceId);
    await Promise.all(
      rows
        .filter((row) => !this.inflight.has(row.id) && !this.checks.has(row.id))
        .map((row) => this.exclusive(row.id, () => this.check(row.id, creds))),
    );
  }

  /**
   * Cancel a dispatch its machine has not confirmed: the machine's `DELETE /api/dispatches/{id}`
   * makes sure it never starts there, even if it arrives late. Out of reach, the cancel stays
   * pending (`canceling`) and the next check delivers it; nothing re-sends the task meanwhile.
   */
  async cancel(id: string): Promise<RemoteCancelResult> {
    const known = this.store.getRemoteDispatch(id);
    if (!known || !this.store.getRemoteInstance(known.instanceId)) return { kind: "not_found" };
    // A check of it is running: decide on what it learned.
    for (let running = this.checks.get(id); running; running = this.checks.get(id)) await running;
    const row = this.store.getRemoteDispatch(id)!;
    if (row.state === "canceled") return { kind: "canceled", dispatch: this.view(row) };
    if (this.inflight.has(id) || !OPEN_STATES.has(row.state)) {
      return { kind: "not_cancelable", dispatch: this.view(row) };
    }
    return this.exclusive(id, async () => {
      this.store.markRemoteDispatchCanceling(id, this.now());
      this.announce(this.store.getRemoteDispatch(id)!);
      const creds = this.store.getRemoteInstance(row.instanceId);
      if (creds && this.instances.get(row.instanceId)?.status === "connected") {
        await this.deliverCancel(id, creds);
      }
      const now = this.store.getRemoteDispatch(id)!;
      const dispatch = this.view(now);
      if (now.state === "canceled" || now.state === "canceling")
        return { kind: now.state, dispatch };
      return { kind: "not_cancelable", dispatch };
    });
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

  private async retry(row: RemoteDispatchRow, payloadHash: string): Promise<RemoteOutcome> {
    if (row.payloadHash !== payloadHash) return refused("dispatch_payload_mismatch");
    const sending = this.inflight.get(row.id);
    if (sending) return sending;
    // A check or cancel of it is running (#2774): what it settles decides what a retry may do.
    for (let running = this.checks.get(row.id); running; running = this.checks.get(row.id)) {
      await running;
    }
    const current = this.adopt(this.store.getRemoteDispatch(row.id) ?? row);
    // Ended before it was sent (#2766), or cancelled (#2774): it never goes out under this key
    // again, so its machine has nothing to replay — the refusal is.
    if (current.state === "upload_failed") {
      const host = this.host(row.instanceId);
      return { kind: "upload_failed", host, reason: current.reason ?? "" };
    }
    if (current.state === "canceling" || current.state === "canceled") {
      return { kind: "canceled", host: this.host(row.instanceId) };
    }
    return this.inflight.get(row.id) ?? this.track(current);
  }

  /** Run `op` as the one check or cancel of dispatch `id`, registered in the same tick. */
  private async exclusive<T>(id: string, op: () => Promise<T>): Promise<T> {
    let done!: () => void;
    this.checks.set(id, new Promise<void>((resolve) => (done = resolve)));
    try {
      return await op();
    } finally {
      this.checks.delete(id);
      done();
    }
  }

  /** What the machine knows of one unconfirmed dispatch. Started, held or failed there settles it
   *  here; never arrived (404) sends it again — same ID, same machine; still starting there, or no
   *  answer, leaves it unknown for the next check. A pending cancel is delivered instead. */
  private async check(id: string, creds: RemoteTarget): Promise<void> {
    const stored = this.store.getRemoteDispatch(id);
    if (!stored || !OPEN_STATES.has(stored.state)) return;
    const row = this.adopt(stored);
    if (row.state === "canceling") return this.deliverCancel(id, creds);
    const res = await this.ask(creds, "GET", id);
    if (!res) return;
    if (res.status === 404) {
      await this.track(row);
      return;
    }
    const outcome = res.status === 200 ? confirmedOutcome(res.body) : null;
    if (outcome) this.settle(id, outcome);
  }

  /** The machine's `DELETE /api/dispatches/{id}`. 200: it never starts there. 409: it arrived
   *  first, and what it became there is the outcome here — still starting reads `unknown` again,
   *  for the next check to follow. Anything else leaves the cancel pending. */
  private async deliverCancel(id: string, creds: RemoteTarget): Promise<void> {
    const res = await this.ask(creds, "DELETE", id);
    if (!res) return;
    if (res.status === 200) return this.settle(id, { ...NO_OUTCOME, state: "canceled" });
    const body = isRecord(res.body) ? res.body : {};
    if (res.status !== 409 || body.code !== "dispatch_arrived" || !isRecord(body.dispatch)) return;
    this.settle(id, confirmedOutcome(body.dispatch) ?? { ...NO_OUTCOME, state: "unknown" });
  }

  /** The machine's record of dispatch `id` (#2761): its status and JSON body, or null when no
   *  usable answer came back (unreachable, timed out, its token refused). */
  private async ask(
    creds: RemoteTarget,
    method: "GET" | "DELETE",
    id: string,
  ): Promise<{ status: number; body: unknown } | null> {
    const res = await requestRemote(creds, dispatchPath(id), { method }, { fetch: this.fetch });
    if (!res.ok) return null;
    return { status: res.response.status, body: await res.response.json().catch(() => null) };
  }

  /** A `sending` row no send here runs was left by a restart. It is listed as unknown, so from
   *  now on it is: what it settles to is then announced like any other unknown dispatch. */
  private adopt(row: RemoteDispatchRow): RemoteDispatchRow {
    if (row.state !== "sending" || this.inflight.has(row.id)) return row;
    this.store.settleRemoteDispatch(row.id, { ...NO_OUTCOME, state: "unknown" }, this.now());
    return this.store.getRemoteDispatch(row.id)!;
  }

  /** Write an outcome. Announced when dashboards show the dispatch before or after — the store
   *  writes only over an unconfirmed row, so the event carries what the row really is now. */
  private settle(id: string, outcome: RemoteDispatchOutcome): void {
    const before = this.store.getRemoteDispatch(id)?.state;
    this.store.settleRemoteDispatch(id, outcome, this.now());
    const row = this.store.getRemoteDispatch(id);
    if (row && (SHOWN_STATES.has(row.state) || (before && SHOWN_STATES.has(before)))) {
      this.announce(row);
    }
  }

  private announce(row: RemoteDispatchRow): void {
    this.events?.emit("remote:dispatch", this.view(row));
  }

  private view(row: RemoteDispatchRow): RemoteDispatchView {
    const orphaned = row.state === "sending" && !this.inflight.has(row.id);
    const optional = {
      sessionId: row.sessionId,
      heldId: row.heldId,
      reason: row.reason,
      code: row.code,
    };
    return {
      id: row.id,
      state: orphaned ? "unknown" : row.state,
      host: this.host(row.instanceId),
      summary: summaryOf(row.wireBody),
      ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== null)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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
    this.settle(row.id, record);
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
   *  it. Only its extension travels with the bytes (the machine stores it under a fresh name) —
   *  not this machine's staged name; the operator's name for it is in `attachmentNames`. */
  private async upload(images: string[], creds: RemoteTarget): Promise<string[] | UploadFailure> {
    const paths: string[] = [];
    for (const [i, local] of images.entries()) {
      const which = `attachment ${i + 1} of ${images.length}`;
      const file = Bun.file(local);
      if (!(await file.exists())) {
        return { reason: `${which} is no longer staged here`, httpStatus: null };
      }
      const res = await postRemoteFile(creds, "/api/uploads", file, `attachment${extname(local)}`, {
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
    this.settle(row.id, {
      ...NO_OUTCOME,
      state: "upload_failed",
      reason: failure.reason,
      code: "remote_upload_failed",
      httpStatus: failure.httpStatus,
    });
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
