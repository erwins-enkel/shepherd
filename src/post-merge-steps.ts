/**
 * PostMergeStepsService — durable post-merge materialization of a session's manual operator steps
 * (#1061, epic #1056 P3). On a managed session's PR merging, it freezes the session's manual steps
 * into the archive-decoupled `post_merge_steps` table so they outlive teardown + the prune window,
 * and — only behind a per-repo opt-in — opens a GitHub tracking issue and links it back to the PR.
 *
 * Wired to the `session:git` merged event (mirrors the doc-agent merge fast-path in index.ts).
 *
 * Three correctness properties this service must hold (see the plan's reviewer notes):
 *  1. Detection-not-yet-run: detection (detectAndPersistManualSteps) is fired `void`-async on the
 *     SAME merged event, so a first-observed/fast merge can leave `session.manualSteps` empty.
 *     onMerged re-derives from the PR body when stored steps are empty (it never reads the worktree,
 *     so archive/teardown imposes no ordering on it).
 *  2. Event replay: the merged event fires more than once (notably the boot warm-tick). The
 *     `sessionId PRIMARY KEY` insert-or-ignore makes the record idempotent; the `trackingIssueUrl`
 *     null-guard + in-flight set make the single outbound write idempotent AND self-healing (a
 *     transient createIssue failure retries on the next replay, never duplicates once linked).
 *  3. No throw escapes: every re-derive / materialize / issue step is wrapped so a failure logs and
 *     recovers on the next replay rather than stranding the (independent) archive flow.
 *
 * Materialization scope (deliberate, flagged): it materializes ALL of `session.manualSteps`, never
 * reading `manualStepsAckedAt`. P2's ack is set-level with no per-step done flag, so P3 cannot tell
 * a done step from an undone one; and an un-acked non-POST-MERGE step can still land via a manual
 * out-of-band merge that bypassed P2's gate — exactly the highest loss-risk case. Surfacing all of
 * them (the operator ticks off what's done) is the fail-safe. This slightly widens the issue's
 * literal "deferred + POST-MERGE" to "all declared steps"; the clean fix (a per-step done flag at
 * ack time) is a follow-up.
 */
import type { SessionStore } from "./store";
import type { GitForge } from "./forge/types";
import type { Session } from "./types";
import { parseManualSteps, type ManualStep } from "./manual-steps";

export interface PostMergeStepsServiceDeps {
  store: Pick<
    SessionStore,
    | "get"
    | "getRepoConfig"
    | "setSessionManualSteps"
    | "materializePostMergeSteps"
    | "getPostMergeSteps"
    | "setPostMergeTrackingIssue"
  >;
  resolveForge: (repoPath: string) => GitForge | null;
  /** Notify the UI that the outstanding set changed (emits `post-merge-steps:changed`). */
  emitChange: () => void;
}

/** Render the steps as a GitHub-flavored checklist (POST-MERGE marked), authored in English to
 *  match the repo's other outbound forge content (PR bodies, issue-log comments). */
function issueBody(prNumber: number | null, steps: { text: string; postMerge: boolean }[]): string {
  const lines = steps.map((s) => `- [ ] ${s.postMerge ? "POST-MERGE: " : ""}${s.text}`);
  const ref = prNumber != null ? ` from #${prNumber}` : "";
  return [
    `Manual operator steps${ref} that a human must complete now that the PR has merged.`,
    "",
    ...lines,
    "",
    "_Opened automatically by Shepherd. Tick each step as you complete it._",
  ].join("\n");
}

export class PostMergeStepsService {
  /** Per-session guard against two near-simultaneous merged events both opening an issue. */
  private issuing = new Set<string>();

  constructor(private deps: PostMergeStepsServiceDeps) {}

  /**
   * Materialize `session`'s manual steps on its PR merge. Never throws.
   * @param prNumber the merged PR number (from the git event), used for re-derive + PR linkback.
   * @param prTitle  the merged PR title (from the git event), denormalized onto the record.
   */
  async onMerged(session: Session, prNumber: number | null, prTitle = ""): Promise<void> {
    const forge = this.deps.resolveForge(session.repoPath);
    const steps = await this.resolveSteps(session, prNumber, forge);
    if (steps.length === 0) return;

    // Materialize (idempotent). A re-fire finds the row present → inserted=false, tick-state kept.
    let inserted: boolean;
    try {
      inserted = this.deps.store.materializePostMergeSteps({
        sessionId: session.id,
        desig: session.desig,
        repoPath: session.repoPath,
        prNumber,
        prTitle,
        steps: steps.map((s) => ({ id: s.id, text: s.text, postMerge: s.postMerge, doneAt: null })),
      });
    } catch (err) {
      // DB failure (e.g. transient lock) — nothing written, so the replay retries from scratch.
      console.warn(`[post-merge-steps] materialize for ${session.id} failed:`, err);
      return;
    }
    if (inserted) {
      // Observability (#1257): a fresh owed record is the real-world signal that an agent actually
      // declared manual steps in its PR body. Logging it lets the operator audit which PRs populate
      // the Owed lens and watch the false-positive (fabricated-step) rate — the prompt notice that
      // drives this is unverifiable in-PR, so this log is the verification path.
      const pr = prNumber != null ? `pr#${prNumber}` : "no-pr";
      console.info(
        `[post-merge-steps] materialized ${steps.length} step(s) for ${session.desig} (${session.id}, ${pr})`,
      );
      this.deps.emitChange();
    }

    await this.maybeOpenTrackingIssue(session, prNumber, steps, forge);
  }

  /** Resolve the steps to materialize, re-deriving from the PR body when detection hasn't persisted
   *  them yet (a first-observed/fast merge). Returns [] on no-steps OR a re-derive error — both mean
   *  "materialize nothing"; a transient prReviewMeta failure thus recovers on the merged-event replay. */
  private async resolveSteps(
    session: Session,
    prNumber: number | null,
    forge: GitForge | null,
  ): Promise<ManualStep[]> {
    if (session.manualSteps.length > 0) return session.manualSteps;
    if (prNumber == null || !forge?.prReviewMeta) return [];
    try {
      const meta = await forge.prReviewMeta(prNumber);
      const derived = meta ? parseManualSteps(meta.body) : [];
      // Persist re-derived steps back onto the session so the chip/recap stay consistent.
      if (derived.length > 0) this.deps.store.setSessionManualSteps(session.id, derived);
      return derived;
    } catch (err) {
      console.warn(`[post-merge-steps] re-derive for ${session.id} pr#${prNumber} failed:`, err);
      return [];
    }
  }

  /** Opt-in only: open a GitHub tracking issue + link it back to the PR. Replay-safe + self-healing
   *  — guards on `trackingIssueUrl == null` (NOT newly-inserted) so a transient createIssue failure
   *  retries on the next merged event, and an in-flight set blocks concurrent double-creation. Never
   *  throws; with the opt-in off there is no outbound write at all (house rule). */
  private async maybeOpenTrackingIssue(
    session: Session,
    prNumber: number | null,
    steps: ManualStep[],
    forge: GitForge | null,
  ): Promise<void> {
    const cfg = this.deps.store.getRepoConfig(session.repoPath);
    if (!cfg.manualStepsIssueEnabled || !forge?.createIssue) return;
    if (this.issuing.has(session.id)) return;
    const rec = this.deps.store.getPostMergeSteps(session.id);
    if (!rec || rec.trackingIssueUrl != null) return;

    this.issuing.add(session.id);
    try {
      const title = `Manual operator steps — ${session.desig}`;
      const issue = await forge.createIssue({ title, body: issueBody(prNumber, steps) });
      this.deps.store.setPostMergeTrackingIssue(session.id, issue.url, issue.number);
      this.deps.emitChange();
      await this.linkIssueToPr(session.id, prNumber, issue.url, forge);
    } catch (err) {
      // createIssue failed — record stays with a null URL, so the next merged-event replay retries.
      console.warn(`[post-merge-steps] createIssue for ${session.id} failed:`, err);
    } finally {
      this.issuing.delete(session.id);
    }
  }

  /** Best-effort PR linkback comment (issue scope #4). A failure must not undo the issue creation. */
  private async linkIssueToPr(
    sessionId: string,
    prNumber: number | null,
    issueUrl: string,
    forge: GitForge,
  ): Promise<void> {
    if (prNumber == null || !forge.comment) return;
    try {
      await forge.comment(prNumber, `Manual operator steps tracked in ${issueUrl}`);
    } catch (err) {
      console.warn(`[post-merge-steps] PR linkback comment for ${sessionId} failed:`, err);
    }
  }
}
