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
 * Waiting (#2775): a task the automatic choice meant for a machine that is out of reach is stored
 * as `waiting` and NOT sent — nothing goes to any machine, no attachment is uploaded. After every
 * probe that finds that machine connected it is judged again (`readinessOf`: platform, project,
 * requirements); a task with requirements asks the machine for a fresh capability check
 * (`POST /api/instance/capabilities`) right before it is sent, then its project path is mapped and
 * it goes out like any other dispatch — attachments first. Until then it can be canceled (it never
 * goes out) or redirected: to another machine (`redirect`, same dispatch ID — it was never sent)
 * or to this one (`claimForHere`, after which the row is gone and the client key names a local
 * dispatch). A machine that is removed here takes its waiting tasks with it (canceled). Every
 * write that ends a wait is conditional on the row still waiting, so a send, a redirect and a
 * cancel never all win.
 *
 * Held there (#2775): a task its machine holds (its usage hold or capacity) is shown too, until
 * the machine says it started or dropped it; a cancel discards it there (`DELETE /api/held/{id}`)
 * and settles once the machine's dispatch record confirms it.
 *
 * One operation per dispatch at a time: a send (`inflight`, shared with a concurrent duplicate) or
 * a check/cancel/redirect (`checks`). Each is registered in the same tick as the guard that
 * admitted it.
 */
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { EventHub } from "../events";
import type { SessionStore } from "../store";
import {
  type Capability,
  type CapabilitySnapshot,
  missingRequirements,
  parseCapabilityReport,
} from "./capabilities";
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
import {
  type MachineView,
  type Placement,
  type Readiness,
  type RemoteUnfitCode,
  PLATFORM_ORDER_SETTING,
  fittingNow,
  parsePlacementRecord,
  readinessOf,
  remoteMachineViews,
  remoteUnfit,
  storedPlatformOrder,
} from "./placement";
import type { RemoteInstanceService } from "./service";
import { type SessionHost, hostNames } from "./sessions";

/** A create waits for the machine's worktree and agent boot; the coordinator waits that long too. */
const REMOTE_CREATE_TIMEOUT_MS = 120_000;

/** Per attachment: as long as the machine's own `/api/uploads` lets one take. */
const REMOTE_UPLOAD_TIMEOUT_MS = 120_000;

/** The machine's capability probe runs each check with its own 5 s timeout, one after another. */
const REMOTE_CAPABILITY_TIMEOUT_MS = 60_000;

/** `sending` = stored, no answer yet; `unknown` = sent, no answer — it may have started;
 *  `upload_failed` = an attachment did not reach the machine, so the task was never sent;
 *  `canceling` = the operator cancelled it before the machine confirmed it, and the machine has not
 *  confirmed the cancel yet; `canceled` = it never starts there (#2774). `waiting` = stored here,
 *  never sent, until its machine can take it (#2775); `redirected` = it left this machine's queue
 *  to run here instead — only ever announced, no row keeps it. */
export type RemoteDispatchState =
  | "sending"
  | "started"
  | "held"
  | "rejected"
  | "unknown"
  | "upload_failed"
  | "canceling"
  | "canceled"
  | "waiting"
  | "redirected";

/** Not confirmed by the machine: what a check re-asks. */
const OPEN_STATES: ReadonlySet<RemoteDispatchState> = new Set(["sending", "unknown", "canceling"]);

/** What a cancel may still stop: not confirmed, or held there (#2775). A waiting one has its own. */
const CANCELABLE_STATES: ReadonlySet<RemoteDispatchState> = new Set([
  "sending",
  "unknown",
  "canceling",
  "held",
]);

/** What dashboards show (a `sending` one is in flight, or adopted as `unknown` first): not
 *  confirmed by the machine (#2774), waiting here for it or held there (#2775). */
const SHOWN_STATES: ReadonlySet<RemoteDispatchState> = new Set([
  "unknown",
  "canceling",
  "waiting",
  "held",
]);

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
  /** Forge slug (`owner/repo`) of the project (#2775); null on rows from before it was stored. */
  project: string | null;
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
  /** A waiting dispatch only (#2775): the choice that meant it for `host`, how far that machine is
   *  from taking it now, and the connected machines — this one included — it could run on now. */
  placement?: Placement;
  readiness?: Readiness;
  alternatives?: SessionHost[];
}

/** What cancelling an unconfirmed dispatch came to: done, pending until its machine answers, or
 *  not possible (sending right now, or the machine already has it — `dispatch` says what it is). */
export type RemoteCancelResult =
  | { kind: "not_found" }
  | { kind: "canceled" | "canceling" | "not_cancelable"; dispatch: RemoteDispatchView };

/** What redirecting a waiting dispatch to another machine came to (#2775): sent there (the outcome
 *  of that send, or `waiting` when it could not go out yet), or not possible — it is not waiting
 *  (any more), `dispatch` says what it is. */
export type RemoteRedirectResult =
  | { kind: "not_found" }
  | { kind: "not_redirectable"; dispatch: RemoteDispatchView }
  | { kind: "redirected"; outcome: RemoteOutcome };

/** Taking a waiting dispatch to run it here (#2775): the row as it was, now deleted. */
export type RemoteClaimResult =
  | { kind: "not_found" }
  | { kind: "not_redirectable"; dispatch: RemoteDispatchView }
  | { kind: "claimed"; row: RemoteDispatchRow };

export interface RemoteSubmit {
  /** The submitter's `Idempotency-Key`; undefined = a fresh one is generated (and reported). */
  clientKey: string | undefined;
  instanceId: string;
  /** Forge slug (`owner/repo`) of the project, the identity it is matched on. */
  project: string;
  /** The validated create body without `target`; `repoPath` is replaced by the machine's path and
   *  `target` set to the machine itself. `images`, if any, are this machine's staged files
   *  (validated real paths). `placement`, if any, is this Shepherd's record of the choice (#2772). */
  body: Record<string, unknown>;
  /** Hash of the submitter's whole body. */
  payloadHash: string;
}

export type RemoteRefusalCode = RemoteUnfitCode | "dispatch_payload_mismatch";

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
  | { kind: "cancel_pending"; host: SessionHost }
  | { kind: "waiting"; dispatch: RemoteDispatchView; count: number }
  | { kind: "refused"; code: RemoteRefusalCode; reason: string | null };

/** Why an attachment did not reach the machine; `httpStatus` when the machine answered. */
interface UploadFailure {
  reason: string;
  httpStatus: number | null;
}

type Store = Pick<
  SessionStore,
  | "getSetting"
  | "getRemoteInstance"
  | "insertRemoteDispatch"
  | "getRemoteDispatchByKey"
  | "getRemoteDispatch"
  | "listOpenRemoteDispatches"
  | "markRemoteDispatchCanceling"
  | "setRemoteDispatchUploads"
  | "settleRemoteDispatch"
  | "startWaitingRemoteDispatch"
  | "retargetWaitingRemoteDispatch"
  | "cancelWaitingRemoteDispatch"
  | "deleteWaitingRemoteDispatch"
  | "settleHeldRemoteDispatch"
>;
type Instances = Pick<RemoteInstanceService, "get" | "list" | "noteCapabilities">;

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

/** The choice a stored body carries (#2772), or null when it carries none. */
export function placementOf(wireBody: string): Placement | null {
  const record = parsePlacementRecord((JSON.parse(wireBody) as Record<string, unknown>).placement);
  return record && !("error" in record) ? record : null;
}

/** Ready, or only unconfirmed for want of a fresh report: then asking the machine is worth it. */
function worthAsking(readiness: Readiness): boolean {
  if (readiness.state === "ready") return true;
  return (
    readiness.state === "missing_capabilities" &&
    (readiness.missing ?? []).every((m) => m.reason === "not_verified")
  );
}

/** The staged files waiting tasks will upload once they are sent (#2775), by file name — what the
 *  staging sweep must keep, however old they are. */
export function waitingAttachments(
  store: Pick<SessionStore, "listOpenRemoteDispatches">,
): Set<string> {
  const names = store
    .listOpenRemoteDispatches()
    .filter((row) => row.state === "waiting")
    .flatMap((row) => {
      const images = (JSON.parse(row.wireBody) as Record<string, unknown>).images;
      return Array.isArray(images) ? images.filter((p) => typeof p === "string") : [];
    })
    .map((path) => basename(path));
  return new Set(names);
}

export class RemoteDispatcher {
  /** Sends running in this process, by dispatch ID — a concurrent duplicate waits for its outcome. */
  private readonly inflight = new Map<string, Promise<RemoteOutcome>>();
  /** Checks, cancels and redirects running in this process, by dispatch ID (#2774). */
  private readonly checks = new Map<string, Promise<void>>();
  /** The last view announced of each waiting dispatch (#2775): its readiness and alternatives follow
   *  the machines, so it is announced again whenever that changes. */
  private readonly lastShown = new Map<string, string>();
  private readonly store: Store;
  private readonly instances: Instances;
  private readonly events: Pick<EventHub, "emit"> | undefined;
  private readonly fetch: FetchLike | undefined;
  private readonly now: () => number;
  private readonly here: (() => MachineView | null) | undefined;

  constructor(deps: {
    store: Store;
    instances: Instances;
    events?: Pick<EventHub, "emit">;
    fetch?: FetchLike;
    now?: () => number;
    /** This Shepherd as the machine choice sees it (#2775), for what a waiting task could run on. */
    here?: () => MachineView | null;
  }) {
    this.store = deps.store;
    this.instances = deps.instances;
    this.events = deps.events;
    this.fetch = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.here = deps.here;
  }

  /** Dispatches no machine has confirmed yet, waiting here for their machine or held there, of
   *  machines still registered here (connected or not) — what the herd shows in each machine's
   *  group. A send in flight here is left out: its answer is coming. */
  list(): RemoteDispatchView[] {
    const machines = new Set(this.instances.list().map((m) => m.instanceId));
    return this.store
      .listOpenRemoteDispatches()
      .filter((row) => machines.has(row.instanceId) && !this.inflight.has(row.id))
      .map((row) => this.view(row));
  }

  /** One dispatch as dashboards see it, whatever its state; null when unknown here or its machine
   *  was removed. */
  get(id: string): RemoteDispatchView | null {
    const row = this.store.getRemoteDispatch(id);
    return row && this.store.getRemoteInstance(row.instanceId) ? this.view(row) : null;
  }

  /** How many tasks wait here for their machine (#2775). */
  countWaiting(): number {
    return this.store.listOpenRemoteDispatches().filter((r) => r.state === "waiting").length;
  }

  /**
   * Follow up what `instanceId` has not settled. Called after every probe of it (reconnect, this
   * Shepherd's start, each round) and when it is removed. Connected, it is asked about each
   * dispatch it has not confirmed (#2774) or holds (#2775), and each task waiting for it is sent
   * once it can take it (#2775). Removed, its waiting tasks are canceled. A dispatch already being
   * sent or checked here is left to that. Waiting tasks whose view changed are announced again.
   */
  async reconcile(instanceId: string): Promise<void> {
    const machine = this.instances.get(instanceId);
    if (!machine) this.dropWaiting(instanceId);
    const creds = this.store.getRemoteInstance(instanceId);
    if (machine?.status === "connected" && creds) {
      const rows = this.store.listOpenRemoteDispatches().filter((r) => r.instanceId === instanceId);
      await Promise.all(
        rows
          .filter((row) => !this.inflight.has(row.id) && !this.checks.has(row.id))
          .map((row) => this.exclusive(row.id, () => this.followUp(row.id, creds))),
      );
    }
    this.refreshShown();
  }

  /** Store a task for a machine that is out of reach (#2775) without sending anything: it waits
   *  here until the machine can take it. Same key rules as `submit` — a retry of a waiting task
   *  answers that it waits. */
  async wait(req: RemoteSubmit): Promise<RemoteOutcome> {
    const clientKey = req.clientKey ?? randomUUID();
    const existing = this.store.getRemoteDispatchByKey(clientKey);
    if (existing) return this.retry(existing, req.payloadHash);
    if (!this.store.getRemoteInstance(req.instanceId)) return refused("remote_target_unknown");
    // As this Shepherd holds it: its own repo path and staged attachments. What the machine
    // receives is only written when it is sent — its checkout's path and `target`.
    const row = this.newRow(req, clientKey, "waiting", req.body);
    if (!this.store.insertRemoteDispatch(row)) return this.lostRace(req, clientKey);
    console.log(`[remote-dispatch] ${this.host(row.instanceId).name}: waiting`);
    this.announce(row);
    return this.waiting(row);
  }

  /**
   * Redirect a waiting task to another machine (#2775) — one the caller has found fit. It was never
   * sent, so it keeps its dispatch ID; `placement` is the record of that choice. It is sent there
   * at once when that machine can take it, and otherwise waits for it.
   */
  async redirect(
    id: string,
    to: { instanceId: string; placement: Placement },
  ): Promise<RemoteRedirectResult> {
    return this.afterChecks(id, (row) => {
      if (row.state !== "waiting" || this.inflight.has(id)) {
        return { kind: "not_redirectable" as const, dispatch: this.view(row) };
      }
      return this.retargetNow(id, row, to);
    });
  }

  private retargetNow(
    id: string,
    row: RemoteDispatchRow,
    to: { instanceId: string; placement: Placement },
  ): Promise<RemoteRedirectResult> {
    return this.exclusive(id, async () => {
      const body = JSON.parse(row.wireBody) as Record<string, unknown>;
      const wire = JSON.stringify({ ...body, placement: to.placement });
      if (!this.store.retargetWaitingRemoteDispatch(id, to.instanceId, wire, this.now())) {
        const now = this.store.getRemoteDispatch(id);
        return now
          ? { kind: "not_redirectable" as const, dispatch: this.view(now) }
          : { kind: "not_found" as const };
      }
      const moved = this.store.getRemoteDispatch(id)!;
      this.announce(moved);
      const creds = this.store.getRemoteInstance(to.instanceId);
      const sent =
        creds && this.instances.get(to.instanceId)?.status === "connected"
          ? await this.resume(id, creds)
          : null;
      return { kind: "redirected" as const, outcome: sent ?? this.waitingNow(id) };
    });
  }

  /**
   * Take a waiting task to run it on this machine instead (#2775): the row is deleted — only while
   * it still waits, so it can no longer be sent — and the caller starts it here under the row's
   * client key. `announceRedirected` tells the dashboards once it has.
   */
  claimForHere(id: string): Promise<RemoteClaimResult> {
    return this.afterChecks(id, (row): RemoteClaimResult => {
      if (row.state !== "waiting" || this.inflight.has(id)) {
        return { kind: "not_redirectable", dispatch: this.view(row) };
      }
      if (!this.store.deleteWaitingRemoteDispatch(id)) {
        const now = this.store.getRemoteDispatch(id);
        return now ? { kind: "not_redirectable", dispatch: this.view(now) } : { kind: "not_found" };
      }
      return { kind: "claimed", row };
    });
  }

  /** A claimed task now runs here (`host`): it leaves its machine's group. */
  announceRedirected(row: RemoteDispatchRow, host: SessionHost): void {
    this.emitView({ ...this.view({ ...row, state: "redirected", updatedAt: this.now() }), host });
  }

  /**
   * Cancel a dispatch its machine has not confirmed: the machine's `DELETE /api/dispatches/{id}`
   * makes sure it never starts there, even if it arrives late. Out of reach, the cancel stays
   * pending (`canceling`) and the next check delivers it; nothing re-sends the task meanwhile.
   */
  cancel(id: string): Promise<RemoteCancelResult> {
    return this.afterChecks(id, (row) => this.cancelSettled(id, row));
  }

  private cancelSettled(
    id: string,
    row: RemoteDispatchRow,
  ): Promise<RemoteCancelResult> | RemoteCancelResult {
    if (row.state === "canceled") return { kind: "canceled", dispatch: this.view(row) };
    // Waiting (#2775): never sent, so nothing needs to reach its machine.
    if (row.state === "waiting" && !this.inflight.has(id)) {
      return this.exclusive(id, async () => this.cancelWaiting(id, null));
    }
    if (this.inflight.has(id) || !CANCELABLE_STATES.has(row.state)) {
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
    // `target` names the machine itself (#2772): it runs the task there and never places it
    // again — so two machines connected to each other cannot hand a task back and forth.
    const wire = { ...req.body, repoPath: path, target: { instanceId: req.instanceId } };
    const row = this.newRow(req, clientKey, "sending", wire);
    return this.store.insertRemoteDispatch(row) ? this.track(row) : this.lostRace(req, clientKey);
  }

  /** A dispatch about to be stored: a fresh dispatch ID, no outcome yet. */
  private newRow(
    req: RemoteSubmit,
    clientKey: string,
    state: "sending" | "waiting",
    wire: Record<string, unknown>,
  ): RemoteDispatchRow {
    const at = this.now();
    return {
      id: randomUUID(),
      clientKey,
      instanceId: req.instanceId,
      payloadHash: req.payloadHash,
      wireBody: JSON.stringify(wire),
      state,
      ...NO_OUTCOME,
      createdAt: at,
      updatedAt: at,
      uploads: null,
      project: req.project,
    };
  }

  /** A concurrent submit with the same key stored its row first: this is a retry of that one. */
  private lostRace(req: RemoteSubmit, clientKey: string): Promise<RemoteOutcome> {
    const winner = this.store.getRemoteDispatchByKey(clientKey);
    return winner
      ? this.retry(winner, req.payloadHash)
      : Promise.resolve(refused("dispatch_payload_mismatch"));
  }

  /** Pre-flight: the machine's own path for the project, or why it cannot take the task. */
  private async targetPath(req: RemoteSubmit): Promise<string | RemoteOutcome> {
    const machine = this.instances.get(req.instanceId);
    const creds = this.store.getRemoteInstance(req.instanceId);
    if (!machine || !creds) return refused("remote_target_unknown");
    // Not connected, a platform not released for tasks (#2770) or no checkout of the project.
    const unfit = remoteUnfit(machine, req.project);
    if (unfit) return refused(unfit.code, unfit.reason);
    const repos = await getRemoteJson(creds, "/api/repos", { fetch: this.fetch });
    if (!repos.ok) return refused("remote_target_unavailable", repos.failure.reason);
    return parseProjectPath(repos.body, req.project) ?? refused("remote_project_missing");
  }

  /** The machine's own path for `project`, read fresh; null when it cannot say right now. */
  private async projectPath(creds: RemoteTarget, project: string): Promise<string | null> {
    const repos = await getRemoteJson(creds, "/api/repos", { fetch: this.fetch });
    return repos.ok ? parseProjectPath(repos.body, project) : null;
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
    // again, so its machine has nothing to replay — the refusal is. A cancel the machine has not
    // confirmed yet promises nothing: the task may have reached it first and be running there.
    const host = this.host(row.instanceId);
    if (current.state === "upload_failed") {
      return { kind: "upload_failed", host, reason: current.reason ?? "" };
    }
    if (current.state === "canceled") return { kind: "canceled", host };
    if (current.state === "canceling") return { kind: "cancel_pending", host };
    // Waiting (#2775): it goes out when its machine can take it, not because a client asked again.
    if (current.state === "waiting") return this.waiting(current);
    return this.inflight.get(row.id) ?? this.track(current);
  }

  private waiting(row: RemoteDispatchRow): RemoteOutcome {
    return { kind: "waiting", dispatch: this.view(row), count: this.countWaiting() };
  }

  /** A redirected dispatch that could not go out yet waits for its new machine. */
  private waitingNow(id: string): RemoteOutcome {
    const row = this.store.getRemoteDispatch(id);
    return row ? this.waiting(row) : refused("remote_target_unknown");
  }

  /** The one follow-up of a dispatch after a probe found its machine connected. */
  private async followUp(id: string, creds: RemoteTarget): Promise<void> {
    const state = this.store.getRemoteDispatch(id)?.state;
    if (state === "waiting") await this.resume(id, creds);
    else if (state === "held") await this.checkHeld(id, creds);
    else await this.check(id, creds);
  }

  /**
   * Send a waiting task if its machine can take it now (#2775), and say what the send came to; null
   * while it keeps waiting. Judged as the choice judges it, then — for a task with requirements —
   * on a capability check the machine runs right now; then its checkout's path. Only after that is
   * the text the machine receives written and the task sent, attachments first.
   */
  private async resume(id: string, creds: RemoteTarget): Promise<RemoteOutcome | null> {
    const row = this.store.getRemoteDispatch(id);
    const machine = row && this.instances.get(row.instanceId);
    if (!row || row.state !== "waiting" || !machine) return null;
    const project = row.project ?? "";
    const requirements = placementOf(row.wireBody)?.requirements ?? [];
    if (!worthAsking(readinessOf(machine, project, requirements))) return null;
    if (requirements.length > 0) {
      const fresh = await this.freshCapabilities(row.instanceId, creds);
      if (!fresh || missingRequirements(fresh, requirements).length > 0) return null;
    }
    const path = await this.projectPath(creds, project);
    if (path === null) return null;
    const body = JSON.parse(row.wireBody) as Record<string, unknown>;
    const wire = JSON.stringify({
      ...body,
      repoPath: path,
      target: { instanceId: row.instanceId },
    });
    // A redirect or a cancel got there first.
    if (!this.store.startWaitingRemoteDispatch(id, wire, this.now())) return null;
    const outcome = await this.track(this.store.getRemoteDispatch(id)!);
    // It was shown as waiting: say how it ended (a shown outcome announced itself already).
    const settled = this.store.getRemoteDispatch(id)!;
    if (!SHOWN_STATES.has(settled.state)) this.announce(settled);
    return outcome;
  }

  /** The machine's capabilities as it checks them right now (`POST /api/instance/capabilities`),
   *  recorded into its summary; null when no usable report came back. */
  private async freshCapabilities(
    instanceId: string,
    creds: RemoteTarget,
  ): Promise<CapabilitySnapshot | null> {
    const res = await requestRemote(
      creds,
      "/api/instance/capabilities",
      { method: "POST" },
      { fetch: this.fetch, timeoutMs: REMOTE_CAPABILITY_TIMEOUT_MS },
    );
    if (!res.ok) return null;
    const body: unknown = await res.response.json().catch(() => null);
    if (!res.response.ok || !isRecord(body)) return null;
    const snapshot = parseCapabilityReport(body.capabilities, this.now());
    if (snapshot) this.instances.noteCapabilities(instanceId, snapshot);
    return snapshot;
  }

  /** What became of a task its machine holds (#2775): started or dropped there settles it here;
   *  still held, or no answer, leaves it for the next check. */
  private async checkHeld(id: string, creds: RemoteTarget): Promise<void> {
    const res = await this.ask(creds, "GET", id);
    const outcome = res?.status === 200 ? confirmedOutcome(res.body) : null;
    if (!outcome || outcome.state === "held") return;
    this.store.settleHeldRemoteDispatch(id, outcome, this.now());
    const row = this.store.getRemoteDispatch(id);
    if (row) this.announce(row);
  }

  /** A waiting task that never goes out: canceled by the operator (`code` null) or with its
   *  machine (`machine_removed`). */
  private cancelWaiting(id: string, code: string | null): RemoteCancelResult {
    const done = this.store.cancelWaitingRemoteDispatch(id, code, this.now());
    const row = this.store.getRemoteDispatch(id);
    if (!row) return { kind: "not_found" };
    if (!done) {
      return row.state === "canceled"
        ? { kind: "canceled", dispatch: this.view(row) }
        : { kind: "not_cancelable", dispatch: this.view(row) };
    }
    this.announce(row);
    return { kind: "canceled", dispatch: this.view(row) };
  }

  /** A machine removed here takes the tasks waiting for it along. */
  private dropWaiting(instanceId: string): void {
    for (const row of this.store.listOpenRemoteDispatches()) {
      if (row.state !== "waiting" || row.instanceId !== instanceId || this.checks.has(row.id)) {
        continue;
      }
      this.cancelWaiting(row.id, "machine_removed");
    }
  }

  /** Announce each waiting task whose view — its machine's readiness, the alternatives — changed. */
  private refreshShown(): void {
    const machines = new Set(this.instances.list().map((m) => m.instanceId));
    for (const row of this.store.listOpenRemoteDispatches()) {
      if (row.state !== "waiting" || !machines.has(row.instanceId)) continue;
      if (this.inflight.has(row.id) || this.checks.has(row.id)) continue;
      const view = this.view(row);
      if (this.lastShown.get(row.id) !== JSON.stringify(view)) this.emitView(view);
    }
  }

  /**
   * Decide on dispatch `id` once no check of it runs here — on what that check learned. `then`
   * runs in the same tick as the last running check ends, so what it registers (`exclusive`) is
   * in place before anything else can start on it. Unknown here, its machine removed, or taken to
   * run here meanwhile (#2775): not found.
   */
  private async afterChecks<T>(
    id: string,
    then: (row: RemoteDispatchRow) => T | Promise<T>,
  ): Promise<T | { kind: "not_found" }> {
    const known = this.store.getRemoteDispatch(id);
    if (!known || !this.store.getRemoteInstance(known.instanceId)) return { kind: "not_found" };
    for (let running = this.checks.get(id); running; running = this.checks.get(id)) await running;
    const row = this.store.getRemoteDispatch(id);
    return row ? then(row) : { kind: "not_found" };
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
    const heldId = this.store.getRemoteDispatch(id)?.heldId;
    if (heldId) return this.deliverHeldCancel(id, heldId, creds);
    const res = await this.ask(creds, "DELETE", id);
    if (!res) return;
    if (res.status === 200) return this.settle(id, { ...NO_OUTCOME, state: "canceled" });
    const body = isRecord(res.body) ? res.body : {};
    if (res.status !== 409 || body.code !== "dispatch_arrived" || !isRecord(body.dispatch)) return;
    this.settle(id, confirmedOutcome(body.dispatch) ?? { ...NO_OUTCOME, state: "unknown" });
  }

  /** A held task's cancel (#2775): the machine discards it from its held queue, and its dispatch
   *  record says what that came to — failed (discarded) is canceled, started is started. Anything
   *  else leaves the cancel pending for the next check. */
  private async deliverHeldCancel(id: string, heldId: string, creds: RemoteTarget): Promise<void> {
    const path = `/api/held/${encodeURIComponent(heldId)}`;
    const del = await requestRemote(creds, path, { method: "DELETE" }, { fetch: this.fetch });
    if (!del.ok) return;
    await del.response.body?.cancel().catch(() => {});
    if (!del.response.ok && del.response.status !== 404) return;
    const res = await this.ask(creds, "GET", id);
    if (res?.status !== 200 || !isRecord(res.body)) return;
    if (res.body.state === "failed") return this.settle(id, { ...NO_OUTCOME, state: "canceled" });
    const outcome = confirmedOutcome(res.body);
    if (outcome?.state === "started") this.settle(id, outcome);
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
    this.emitView(this.view(row));
  }

  private emitView(view: RemoteDispatchView): void {
    if (view.state === "waiting") this.lastShown.set(view.id, JSON.stringify(view));
    else this.lastShown.delete(view.id);
    this.events?.emit("remote:dispatch", view);
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
      ...(row.state === "waiting" && this.waitingView(row)),
    };
  }

  /** What a waiting task's view adds (#2775), computed now: the machine it waits for may have
   *  come back, lost a capability, or another one may fit by now. */
  private waitingView(row: RemoteDispatchRow): Partial<RemoteDispatchView> {
    const placement = placementOf(row.wireBody);
    const requirements: Capability[] = placement?.requirements ?? [];
    const machine = this.instances.get(row.instanceId);
    const project = row.project ?? "";
    const here = this.here?.();
    const machines = [
      ...(here ? [here] : []),
      ...remoteMachineViews(this.instances.list(), project || undefined),
    ];
    const order = storedPlatformOrder(this.store.getSetting(PLATFORM_ORDER_SETTING));
    return {
      ...(placement && { placement }),
      readiness: machine
        ? readinessOf(machine, project, requirements)
        : { state: "offline", status: "removed" },
      alternatives: fittingNow(machines, requirements, order, row.instanceId),
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
