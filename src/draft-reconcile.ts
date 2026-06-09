import type { SessionStore } from "./store";
import type { GitForge, GitState } from "./forge/types";
import { signedOff, type SignoffView } from "./signoff";

export interface DraftReconcileStatus {
  repoPath: string;
  sessionId: string;
  /**
   * "promote_error" | "enforce_error" while a forge op failed (fail-closed
   * surface); null = cleared/ok.
   */
  state: "promote_error" | "enforce_error" | null;
  detail: string | null; // session desig, for the operator
}

export interface DraftReconcileDeps {
  store: Pick<SessionStore, "get" | "list" | "getRepoConfig" | "getReview">;
  resolveForge: (repoPath: string) => GitForge | null;
  prCache: { snapshot(): Record<string, GitState> };
  /** Re-poll one session's PR state after a forge op so the snapshot reflects the new isDraft. */
  pollSession: (id: string) => void;
  emitStatus: (s: DraftReconcileStatus) => void;
}

export class DraftReconcileService {
  /** Per-session re-entrancy guard: prevents overlapping reconcile calls for the same session. */
  private reconciling = new Set<string>();

  constructor(private deps: DraftReconcileDeps) {}

  async onGit(id: string): Promise<void> {
    await this.reconcileSession(id);
  }
  async onReview(id: string): Promise<void> {
    await this.reconcileSession(id);
  }
  async onStatus(id: string): Promise<void> {
    await this.reconcileSession(id);
  }

  /** Periodic sweep: reconcile every non-archived session with an open PR (~30s cadence).
   *  `store.list()` already spans all repos, so one pass suffices — the per-session
   *  resolveForge/getRepoConfig in doReconcile scope each decision to its own repo. */
  async tick(): Promise<void> {
    const snapshot = this.deps.prCache.snapshot();
    for (const s of this.deps.store.list()) {
      if (s.status === "archived") continue;
      // Fast-path: skip if no open PR in snapshot.
      const git = snapshot[s.id];
      if (!git || git.state !== "open" || !git.number) continue;
      await this.reconcileSession(s.id);
    }
  }

  /**
   * Promote a signed-off draft PR to ready-for-review.
   *
   * PROMOTE is flag-independent — runs even when draftMode is OFF, so toggling
   * the flag off never strands a session in draft limbo. The forge is the source
   * of truth for isDraft; pollSession re-reads it rather than caching a "done"
   * flag here.
   */
  private async tryPromote(
    id: string,
    repoPath: string,
    desig: string,
    prNumber: number,
    forge: GitForge,
  ): Promise<void> {
    if (!forge.markReady) return; // host can't promote — graceful no-op
    try {
      await forge.markReady(prNumber);
      this.deps.emitStatus({ repoPath, sessionId: id, state: null, detail: desig });
      this.deps.pollSession(id);
    } catch (err) {
      console.warn(`[draft-reconcile] markReady pr#${prNumber} failed for ${id}:`, err);
      this.deps.emitStatus({ repoPath, sessionId: id, state: "promote_error", detail: desig });
      // Do NOT rethrow — retry on next tick.
    }
  }

  /**
   * Convert an unsigned ready PR back to draft (draftMode repos only).
   *
   * ENFORCE-DRAFT is flag-gated: when draftMode is off the operator has opted
   * out of auto-draft enforcement, so we never push back a ready PR unless the
   * repo explicitly requires it. PROMOTE above is flag-independent so toggling
   * draftMode off never leaves a signed-off draft stuck.
   */
  private async tryEnforceDraft(
    id: string,
    repoPath: string,
    desig: string,
    prNumber: number,
    forge: GitForge,
  ): Promise<void> {
    if (!forge.convertToDraft) return; // host can't convert — graceful no-op
    try {
      await forge.convertToDraft(prNumber);
      this.deps.emitStatus({ repoPath, sessionId: id, state: null, detail: desig }); // clear any prior error
      this.deps.pollSession(id);
    } catch (err) {
      console.warn(`[draft-reconcile] convertToDraft pr#${prNumber} failed for ${id}:`, err);
      this.deps.emitStatus({ repoPath, sessionId: id, state: "enforce_error", detail: desig });
      // Do NOT rethrow — retry on next tick.
    }
  }

  private async reconcileSession(id: string): Promise<void> {
    if (this.reconciling.has(id)) return;
    this.reconciling.add(id);
    try {
      await this.doReconcile(id);
    } finally {
      this.reconciling.delete(id);
    }
  }

  private async doReconcile(id: string): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived") return;

    const git = this.deps.prCache.snapshot()[id];
    if (!git || git.state !== "open" || !git.number) return;

    const forge = this.deps.resolveForge(s.repoPath);
    if (!forge) return;

    const cfg = this.deps.store.getRepoConfig(s.repoPath);
    const review = this.deps.store.getReview(id);

    const view: SignoffView = {
      humanApproved: git.latestReview?.state === "approved",
      reviewDecision: review?.decision ?? null,
      findings: review?.findings ?? [],
      reviewHeadSha: review?.headSha ?? null,
      headSha: git.headSha ?? null,
    };
    const signed = signedOff(cfg.signoffAuthority, view);

    if (git.isDraft && signed) {
      await this.tryPromote(id, s.repoPath, s.desig, git.number, forge);
    } else if (!git.isDraft && !signed && cfg.draftMode) {
      await this.tryEnforceDraft(id, s.repoPath, s.desig, git.number, forge);
    }
    // else: PR is already in the right state — nothing to do.
  }
}
