/**
 * Spawns the drain sent to other machines (src/drain-placement.ts): how they are keyed, and which
 * of them are still on their way or running there. The pure half — index.ts reads the dispatch rows
 * and the session mirror and asks `remoteWorkOf`.
 *
 * A drain spawn goes out as an ordinary remote dispatch (`RemoteDispatcher.submit`, #2763) whose
 * client key is `drain/<issue>/<uuid>`, so it can be told apart from a task an operator sent and
 * matched to its issue without a table of its own. Its session there is a mirrored reference
 * (#2762): never in this store, so no poller, reaper or local retire here touches it — its agent's
 * follow-up work (CI fixes, rebases) stays with that machine. Landing it does not (#3957): that
 * machine keeps epic children off its merge train and does not lead the epic, so the drain that
 * leads it merges the child's PR into the integration branch (`remoteRetireView` feeds its gate).
 * Nor does that machine settle the session once it merged: it was created there as an ordinary, not
 * an auto, session, which its drain never reaps. The leader asks it to (#3016,
 * `integratedDispatchesOf`, `remoteSettleGate`; src/integrated-child-settle.ts there).
 *
 * One counts while its start is unconfirmed (`sending`, `unknown`) or held there, and once started
 * while its mirrored session is not archived. A start younger than `START_GRACE_MS` counts even
 * before the mirror shows the session, so a fresh dispatch cannot free its slot for a moment.
 */
import { randomUUID } from "node:crypto";
import { readyToRetire, type RetireView } from "./drain-core";
import type { RemoteSettleReason } from "./epic-core";
import type { PrStatus } from "./forge/types";
import type { RemoteDispatchRow } from "./remote-instances/dispatch";
import type { MirroredSession, SessionHost } from "./remote-instances/sessions";
import type { RepoConfig } from "./store";
import type { PrReview } from "./types";

const DRAIN_KEY_RE = /^drain\/(\d+)\//;

/** How long a started dispatch counts without its session in the mirror. */
export const START_GRACE_MS = 5 * 60_000;

/** How far back dispatch rows are read: anything older has long settled. */
export const REMOTE_WORK_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** The client key of a drain spawn for `issue`. */
export function drainDispatchKey(issue: number, id: string = randomUUID()): string {
  return `drain/${issue}/${id}`;
}

/** The issue a drain dispatch key names; null for any other key. */
export function issueOfDrainKey(key: string): number | null {
  const m = DRAIN_KEY_RE.exec(key);
  return m ? Number(m[1]) : null;
}

/** A drain spawn on another machine: where, its session there (null until the start is
 *  confirmed), that session's designation and its PR once it opened one. */
export interface RemoteWork {
  host: SessionHost;
  sessionId: string | null;
  desig: string | null;
  prNumber: number | null;
}

function prNumberOf(session: MirroredSession): number | null {
  const n = session.git?.number;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** A live mirrored session as drain work there. */
function sessionWork(session: MirroredSession): RemoteWork {
  return {
    host: session.host,
    sessionId: session.id,
    desig: typeof session.desig === "string" ? session.desig : null,
    prNumber: prNumberOf(session),
  };
}

/** One dispatch's work on `host`, or null when it no longer counts. */
function rowWork(
  row: RemoteDispatchRow,
  host: SessionHost,
  session: MirroredSession | undefined,
  now: number,
): RemoteWork | null {
  if (row.state !== "started") return { host, sessionId: null, desig: null, prNumber: null };
  if (session) return session.status === "archived" ? null : sessionWork(session);
  const fresh = now - row.updatedAt < START_GRACE_MS;
  return fresh ? { host, sessionId: row.sessionId, desig: null, prNumber: null } : null;
}

/** The drain spawns still on their way or running elsewhere, by issue: the newest dispatch per
 *  issue decides. `rows` come newest first (`listDrainRemoteDispatches`); `hostOf` names a
 *  registered machine (null once it was removed — its rows no longer count). */
export function remoteWorkOf(
  rows: readonly RemoteDispatchRow[],
  mirrored: readonly MirroredSession[],
  hostOf: (instanceId: string) => SessionHost | null,
  now: number,
): Map<number, RemoteWork> {
  const sessions = new Map(mirrored.map((s) => [s.id, s]));
  const work = new Map<number, RemoteWork>();
  for (const [issue, row] of newestPerIssue(rows)) {
    const host = hostOf(row.instanceId);
    const found = host && rowWork(row, host, sessions.get(row.sessionId ?? ""), now);
    if (found) work.set(issue, found);
  }
  return work;
}

/** The newest drain dispatch of each issue; `rows` come newest first. */
function newestPerIssue(rows: readonly RemoteDispatchRow[]): Map<number, RemoteDispatchRow> {
  const newest = new Map<number, RemoteDispatchRow>();
  for (const row of rows) {
    const issue = issueOfDrainKey(row.clientKey);
    if (issue !== null && !newest.has(issue)) newest.set(issue, row);
  }
  return newest;
}

/** #3957: the issues whose newest drain dispatch started on another, still registered machine, and
 *  that machine — whether or not the mirror still shows the session there (it may have lost it).
 *  Unlike {@link remoteWorkOf} this never expires: it says only who started the child, not whether
 *  it still holds a slot. */
export function dispatchedElsewhereOf(
  rows: readonly RemoteDispatchRow[],
  hostOf: (instanceId: string) => SessionHost | null,
): Map<number, SessionHost> {
  const sent = new Map<number, SessionHost>();
  for (const [issue, row] of newestPerIssue(rows)) {
    const host = hostOf(row.instanceId);
    if (host && row.state === "started") sent.set(issue, host);
  }
  return sent;
}

/** #3957: a remote epic child's PR as the drain's retire gate (`readyToRetire`) reads a session:
 *  the forge's PR facts, and this host's critic verdict for it (the standalone critic's
 *  `pr_reviews` row — the session critic there follows that machine's settings, not the epic's). A
 *  row without a verdict yet reads as none. The row keeps no findings list; a `changes_requested`
 *  decision already blocks on its own. */
export function remoteRetireView(pr: PrStatus, review: PrReview | null): RetireView {
  const decision = review?.decision || null;
  return {
    git: { ...pr, kind: "github" },
    reviewDecision: decision,
    reviewHeadSha: decision ? review!.headSha : null,
    findings: [],
    humanApproved: pr.latestReview?.state === "approved",
  };
}

/** #3957: a remote epic child's PR the drain may land at all — open, into the pinned epic branch,
 *  with a known head, and not a draft (whoever drives it there marks it ready first). */
export function landableRemotePr(pr: PrStatus | undefined, pinned: string): pr is PrStatus {
  return !!pr && pr.state === "open" && pr.baseRefName === pinned && !!pr.headSha && !pr.isDraft;
}

/** What the retire gate says about a remote child's landable PR: merge it, the critic blocks it
 *  (a trouble hold), it waits for this host's verdict on its head, or it waits on anything else
 *  (CI, mergeability, a sign-off). */
export type RemoteChildGate =
  | { kind: "ready" }
  | { kind: "trouble"; code: "changes_requested" | "error" }
  | { kind: "verdict_pending" }
  | { kind: "wait" };

/** #3957: {@link readyToRetire} for a remote child, plus why it does not pass. A verdict for an
 *  older head is neither trouble nor a pass, as for a local session. */
export function remoteChildGate(
  pr: PrStatus,
  review: PrReview | null,
  cfg: Pick<RepoConfig, "criticEnabled" | "draftMode" | "signoffAuthority">,
): RemoteChildGate {
  const view = remoteRetireView(pr, review);
  const current = view.reviewHeadSha === pr.headSha;
  const decision = current ? view.reviewDecision : null;
  if (decision === "changes_requested" || decision === "error")
    return { kind: "trouble", code: decision };
  if (cfg.criticEnabled && !current) return { kind: "verdict_pending" };
  return readyToRetire(view, cfg.criticEnabled, cfg.draftMode, cfg.signoffAuthority)
    ? { kind: "ready" }
    : { kind: "wait" };
}

/** #3016: why the settle of an integrated child elsewhere is still open (`EpicChild.remoteSettle`). */
export type { RemoteSettleReason };

/** #3016: a drain spawn on another machine whose child is integrated: the newest drain dispatch of
 *  its issue, started there with a session, and the PR its integration record names. */
export interface IntegratedDispatch {
  issue: number;
  host: SessionHost;
  sessionId: string;
  prNumber: number | null;
}

/** #3016: the integrated drain spawns still to settle on their machines. The dispatch rows and this
 *  host's integration records decide — never the mirror, which may not show the session yet, show it
 *  stale, or have lost it: that machine answers for itself. `rows` newest first; `hostOf` as for
 *  {@link remoteWorkOf}; `integrationOf` the child's integration record, null while it has none. */
export function integratedDispatchesOf(
  rows: readonly RemoteDispatchRow[],
  hostOf: (instanceId: string) => SessionHost | null,
  integrationOf: (issue: number) => { prNumber: number | null } | null,
): IntegratedDispatch[] {
  const out: IntegratedDispatch[] = [];
  for (const [issue, row] of newestPerIssue(rows)) {
    const host = hostOf(row.instanceId);
    if (!host || row.state !== "started" || !row.sessionId) continue;
    const integration = integrationOf(issue);
    if (integration)
      out.push({ issue, host, sessionId: row.sessionId, prNumber: integration.prNumber });
  }
  return out;
}

/** #3016: ask the machine to settle an integrated child now, or wait and say why. Only an open link
 *  is asked. The mirror only spares a pointless request — a session it shows working, waiting or
 *  shelved; one it does not show, or shows behind, is asked about: the machine checks itself. */
export function remoteSettleGate(input: {
  online: boolean;
  mirrored: MirroredSession | undefined;
}): { kind: "request" } | { kind: "pending"; reason: RemoteSettleReason } {
  if (!input.online) return { kind: "pending", reason: "offline" };
  const m = input.mirrored;
  if (m?.shelved === true || m?.usagePause != null) return { kind: "pending", reason: "held" };
  if (m && m.status !== "idle" && m.status !== "done" && m.status !== "archived")
    return { kind: "pending", reason: "busy" };
  return { kind: "request" };
}

/** #3016: what a machine answered to `POST /api/sessions/:id/settle-integrated`. `gone`: archived
 *  before, or no such session there — nothing left to settle. `unsupported`: its Shepherd has no
 *  such route. `failed`: no usable answer (transport, auth, server error). */
export type RemoteSettleOutcome =
  | { kind: "settled" }
  | { kind: "gone" }
  | { kind: "refused"; code: string }
  | { kind: "unsupported" }
  | { kind: "failed" };

/** #3016: a settle answer's HTTP status and JSON body as a {@link RemoteSettleOutcome}. */
export function settleOutcomeOf(status: number, body: unknown): RemoteSettleOutcome {
  const b = (body && typeof body === "object" ? body : {}) as { already?: unknown; code?: unknown };
  if (status === 200) return b.already === true ? { kind: "gone" } : { kind: "settled" };
  if (status === 404)
    return b.code === "session_not_found" ? { kind: "gone" } : { kind: "unsupported" };
  if (status === 409 && typeof b.code === "string") return { kind: "refused", code: b.code };
  return { kind: "failed" };
}

/** #3016: the open reason a refusal leaves on the child: an archive running there is `requested`. */
export function settleRefusalReason(code: string): RemoteSettleReason {
  switch (code) {
    case "busy":
      return "busy";
    case "settling":
    case "session_closing":
      return "requested";
    case "held":
      return "held";
    case "not_merged":
      return "not_merged_there";
    case "not_epic_child":
      return "rejected";
    default:
      return "failed";
  }
}
