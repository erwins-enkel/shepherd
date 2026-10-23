import type { HoldReason, Session } from "./types";
import type { GitState } from "./forge/types";
import type { ReviewVerdict, PlanGate, Recap } from "./types";
import type { BlockReason } from "./blocked";
import type { EventHub } from "./events";
import { explainHold } from "./attention-core";
import { isOperatorAssistant } from "./operator-assistant-core";
import type { RepoConfig } from "./store";
import type { EpicRun } from "./epic-core";
import { sessionEpicParent } from "./epic-branch";
import { drainEnabled, readyToRetire, type AutoSessionView } from "./drain-core";

// ── types ─────────────────────────────────────────────────────────────────────

/** Minimal session-store surface the service needs. */
export interface SessionStore {
  get(id: string): Session | null;
  list(opts?: { activeOnly?: boolean }): Session[];
}

/** The store reads behind the epic-run-stopped hold (#2735): sync in-process SQLite, no fs/git. */
export interface EpicRetireReader {
  getRepoConfig(
    repoPath: string,
  ): Pick<RepoConfig, "autoDrainEnabled" | "criticEnabled" | "draftMode" | "signoffAuthority">;
  getEpicRun(repoPath: string): Pick<EpicRun, "status" | "parentIssueNumber"> | null;
  getEpicIntegrationBranch(repoPath: string, parentIssueNumber: number): string | null;
}

export interface HoldServiceDeps {
  store: SessionStore;
  events: EventHub;
  gitSnapshot: () => Record<string, GitState>;
  reviewSnapshot: () => Record<string, ReviewVerdict>;
  gateSnapshot: () => Record<string, PlanGate>;
  recapSnapshot: () => Record<string, Recap>;
  /** Called when a hold changes (or clears). Wired to events.emit("session:hold", …) in Task 4. */
  onChange: (id: string, hold: HoldReason | null) => void;
  /** Epic run + repo config reads for the epic-run-stopped hold; absent → that hold never fires. */
  epicRetire?: EpicRetireReader;
  /** Inject for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

/** The epic whose drain retire would integrate this session — an auto child the drain may hand off
 *  (not a landing repair, not misrouted) — else null. */
function drainRetiredEpic(s: Session): number | null {
  if (!s.auto || s.landingRepair || s.misroutedTarget) return null;
  return sessionEpicParent(s);
}

/** The drain's AutoSessionView of a session, from the hold service's caches (drain.ts → buildState). */
function retireView(
  s: Session,
  git: GitState,
  review: ReviewVerdict | undefined,
  epic: number,
): AutoSessionView {
  return {
    id: s.id,
    desig: s.desig,
    issueNumber: s.issueNumber,
    status: s.status,
    git,
    reviewDecision: review?.decision ?? null,
    reviewHeadSha: review?.headSha ?? null,
    findings: review?.findings ?? [],
    humanApproved: git.latestReview?.state === "approved",
    isDraft: git.isDraft ?? false,
    fullAuto: false,
    epicParent: epic,
    landingRepair: false,
  };
}

/** Repo-scoped events that can start or stop the drain integrating a repo's epic children. */
const REPO_EVENTS = new Set(["epic:update", "drain:status"]);

// ── service ───────────────────────────────────────────────────────────────────

/**
 * Live in-memory hold-reason service.
 *
 * Subscribes to the EventHub, maintains per-session hold state, and calls
 * `onChange` whenever a session's hold changes. All caches are in-memory; zero
 * I/O (no fs/git/transcript reads — single-loop rule).
 *
 * Seeding choice: the constructor seeds holds for all current active sessions
 * via `recompute`, which DOES emit via `onChange`. This means a reconnecting
 * client gets up-to-date holds immediately on the next broadcast cycle. Task 4
 * can alternatively use `snapshot()` for the bootstrap GET without relying on
 * seed emissions.
 */
export class HoldReasonService {
  private holds = new Map<string, HoldReason>();
  private lastSig = new Map<string, string>();
  private blockCache = new Map<string, BlockReason | null>();
  private loginCache = new Map<string, { url: string }>();
  private mergeErrorSessions = new Set<string>();
  private resetAt: number | undefined;
  private nowFn: () => number;
  private unsubscribe: () => void;

  constructor(private deps: HoldServiceDeps) {
    this.nowFn = deps.now ?? (() => Date.now());

    // Single subscriber handles all events.
    this.unsubscribe = deps.events.subscribe((event, data) => {
      if (REPO_EVENTS.has(event)) this.handleRepoEvent(data);
      else this.handleEvent(event, data);
    });

    // Seed: compute holds for all currently active sessions.
    for (const session of deps.store.list({ activeOnly: true })) {
      this.recompute(session.id);
    }
  }

  // ── public ──────────────────────────────────────────────────────────────────

  /** Current hold map — for the bootstrap GET (Task 4). */
  snapshot(): Record<string, HoldReason> {
    return Object.fromEntries(this.holds);
  }

  /** Unsubscribe from the EventHub; call on teardown if needed. */
  dispose(): void {
    this.unsubscribe();
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private handleEvent(event: string, data: unknown): void {
    const d = data as Record<string, unknown>;

    switch (event) {
      // ── id-bearing session events — recompute the named session ──────────
      case "session:git":
      case "session:review":
      case "session:plangate":
      case "session:status":
      case "session:halt":
      case "session:autopilot":
      case "session:merging":
      case "session:ready":
      case "session:manual-steps": {
        const id = d.id as string;
        this.recompute(id);
        break;
      }

      case "session:block": {
        const id = d.id as string;
        // Update blockCache BEFORE recomputing so the new value feeds explainHold.
        this.blockCache.set(id, (d.block as BlockReason | null) ?? null);
        this.recompute(id);
        break;
      }

      case "session:login-request": {
        const id = d.id as string;
        const request = d.request as { url: string } | null;
        if (request) this.loginCache.set(id, { url: request.url });
        else this.loginCache.delete(id);
        this.recompute(id);
        break;
      }

      case "automerge:status": {
        this.handleAutoMergeStatus(d);
        break;
      }

      case "usage:limits": {
        const limits = d as { session5h?: { pct: number; resetAt: number } | null };
        this.resetAt = limits.session5h?.resetAt;
        // Recompute ALL active sessions — bounded; dedup guard suppresses no-ops.
        for (const session of this.deps.store.list({ activeOnly: true })) {
          this.recompute(session.id);
        }
        break;
      }

      case "session:archived": {
        const id = d.id as string;
        const hadHold = this.holds.has(id);
        this.holds.delete(id);
        this.lastSig.delete(id);
        this.blockCache.delete(id);
        this.loginCache.delete(id);
        this.mergeErrorSessions.delete(id);
        if (hadHold) {
          this.deps.onChange(id, null);
        }
        break;
      }
    }
  }

  /** Track merge-train error/cap state per session, then recompute. Extracted from handleEvent so
   *  that switch stays under the complexity gate. A non-error state (incl. the manual_steps hold)
   *  clears the error flag — manual-steps holds come from the session's own fields, not train state. */
  private handleAutoMergeStatus(d: Record<string, unknown>): void {
    const sessionId = d.sessionId as string | null;
    if (!sessionId) return;
    const state = d.state as string | null;
    if (state === "merge_error" || state === "rebase_cap") {
      this.mergeErrorSessions.add(sessionId);
    } else {
      this.mergeErrorSessions.delete(sessionId);
    }
    this.recompute(sessionId);
  }

  /** A repo's drain started/stopped, or an epic run changed: re-check its auto epic children — the
   *  only sessions these events can move (drain:status fires every pump). */
  private handleRepoEvent(data: unknown): void {
    const repoPath = (data as { repoPath?: unknown } | null)?.repoPath;
    if (typeof repoPath !== "string") return;
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.repoPath === repoPath && s.auto && sessionEpicParent(s) != null) this.recompute(s.id);
    }
  }

  /** #2735: an auto epic child whose PR passes the drain's retire gate while the repo drain is not
   *  acting — nothing will integrate it until the run starts. Mirrors the drain's own gates
   *  (`buildState` → enabled, `retireDecision`, `doRetire`'s pinned-branch check). */
  private epicHeld(
    s: Session,
    git: GitState | undefined,
    review: ReviewVerdict | undefined,
  ): { epic: number; leadEpic: number | null } | null {
    const reader = this.deps.epicRetire;
    const epic = drainRetiredEpic(s);
    if (!reader || epic == null || git?.state !== "open") return null;
    const cfg = reader.getRepoConfig(s.repoPath);
    const run = reader.getEpicRun(s.repoPath);
    if (drainEnabled(run, cfg.autoDrainEnabled)) return null;
    if (reader.getEpicIntegrationBranch(s.repoPath, epic) == null) return null;
    const view = retireView(s, git, review, epic);
    if (!readyToRetire(view, cfg.criticEnabled, cfg.draftMode, cfg.signoffAuthority)) return null;
    return { epic, leadEpic: run?.status === "paused" ? run.parentIssueNumber : null };
  }

  private recompute(id: string): void {
    const session = this.deps.store.get(id);
    if (!session || isOperatorAssistant(session)) {
      // Session absent → treat as cleared. So is the Operator Assistant: it is not herd work, so
      // it never holds and never asks for attention (#1446).
      const prev = this.lastSig.get(id);
      if (prev !== undefined && prev !== "null") {
        this.holds.delete(id);
        this.lastSig.set(id, "null");
        this.deps.onChange(id, null);
      }
      return;
    }

    const git = this.deps.gitSnapshot()[id];
    const review = this.deps.reviewSnapshot()[id];
    const caches = {
      git,
      review,
      gate: this.deps.gateSnapshot()[id],
      recap: this.deps.recapSnapshot()[id],
      train: this.mergeErrorSessions.has(id) ? { error: true as const } : undefined,
      block: this.blockCache.get(id) ?? null,
      loginRequest: this.loginCache.get(id) ?? null,
      resetAt: this.resetAt,
      epicHeld: this.epicHeld(session, git, review),
    };

    const hold = explainHold(session, caches, this.nowFn());
    const sig = JSON.stringify(hold); // null → "null"

    if (sig === this.lastSig.get(id)) return; // no change — suppress

    // Apply change.
    this.lastSig.set(id, sig);
    if (hold === null) {
      this.holds.delete(id);
    } else {
      this.holds.set(id, hold);
    }
    this.deps.onChange(id, hold);
  }
}
