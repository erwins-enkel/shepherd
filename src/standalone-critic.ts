/**
 * Standalone repo-level PR critic (issue #596). Reviews ANY open, CI-green, human/agent-authored
 * PR in a repo whose `criticAllPrs` flag is ON — DECOUPLED from the session lifecycle. Where
 * `ReviewService` (src/review.ts) reacts to a managed session's `session:git` event and reviews
 * that one session's PR, this service ENUMERATES every open PR in the repo on a timer and reviews
 * the ones a session critic would never touch (human PRs, PRs from other agents, fork PRs).
 *
 * It REUSES the pure helpers extracted into ./critic-core (patch-id fingerprint, scope backstop,
 * verdict assembly, usage capture, reap) and mirrors ReviewService's begin/tick/finalize structure
 * — but WITHOUT the session-only machinery: no streak/spawn ceiling, no author-decline notes, no
 * auto-address steer, no critic signal. A session-less PR has no agent pane to steer and no task to
 * satisfy, so the loop is just: enumerate → review → post a COMMENT → dedup. Findings are recorded
 * (and re-reviewed on a new push) but never request-changes (a blocking review on a third-party PR
 * under branch protection is too intrusive — see finalize).
 *
 * Dedup is keyed on (repoPath, prNumber) in the `pr_reviews` table (NOT the session-keyed
 * `reviews` table) via the store's getPrReview/putPrReview/bumpPrReviewHead accessors. The
 * patch-id churn/revert set mirrors ReviewService's clean-resets-[] / findings-appends logic so an
 * identical-diff rebase is skipped and a revert-to-an-earlier-buggy-diff is re-reviewed.
 */
import { homedir } from "node:os";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { WorktreeMgr } from "./worktree";
import type { GitForge, PrReviewMeta, PullRequest } from "./forge/types";
import { CRITIC_REVIEW_MARKER } from "./forge/types";
import { readonlyReviewerArgv } from "./reviewer-argv";
import { isEpicIntegrationBranch } from "./epic-branch";
import {
  isApiKeyMode,
  isApiKeyConfigured,
  apiKeyMembraneFields,
  apiKeyPassthroughEnv,
} from "./spawn-auth";
import { readSessionUsage, type SessionUsage } from "./usage";
import {
  prReviewPrompt,
  defaultReadVerdict,
  defaultComputePatchId,
  buildVerdictCore,
  shouldSkipForPatchId,
  captureUsage,
  reapRun,
  CRITIC_THINKING_TOKENS,
  type RawVerdict,
} from "./critic-core";
import {
  detectBackend as realDetectBackend,
  wrapArgv,
  safeRealpath,
  collectPassthroughEnv,
  type SandboxBackend,
  type MembraneInputs,
} from "./sandbox";
import { config } from "./config";

/** One PR critic run between its spawn (begin) and its verdict (finalize). Carries everything
 *  finalize needs without re-querying — mirrors ReviewService's InFlight, minus the streak/note
 *  fields (a session-less critic has neither). */
interface InFlight {
  repoPath: string;
  prNumber: number;
  branch: string; // head branch name (carried for logging; live state is re-fetched number-keyed)
  headSha: string;
  patchId: string; // fingerprint of this run's reviewed diff; persisted for rebase-skip
  baseSha: string | null; // concrete base the critic diffs against (== the fingerprint's base); null = total git failure
  files: string[]; // repo-relative paths in `git diff baseSha...HEAD`; drives the buildVerdict scope backstop
  worktreePath: string;
  terminalId: string;
  criticSessionId: string; // the critic's claude session id → locates its transcript for usage capture
  startedAt: number;
  priorReviewedPatchIds: string[]; // churn/revert dedup set carried in from the prior pr_reviews row
  finalizing?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONCURRENCY = 2;

export interface StandalonePrCriticDeps {
  store: Pick<
    SessionStore,
    | "getRepoConfig"
    | "getPrReview"
    | "putPrReview"
    | "bumpPrReviewHead"
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "listEpicCompleted"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove" | "gitCommonDir">;
  resolveForge: (repoPath: string) => GitForge | null;
  /** Candidate repos to consider each sweep. The sweep itself filters to those with
   *  `criticAllPrs` ON (read live, so a toggle takes effect on the next sweep). */
  repos: () => string[];
  /**
   * Head branch names currently owned by a LIVE session, per repo. Called at the TOP of every
   * sweep (rebuilt fresh from live sessions) and injected as a thunk — NEVER cached on the
   * instance — so a session that starts/ends between sweeps is reflected immediately. Used to
   * skip a PR the session critic already owns (only when that repo's `criticEnabled` is on; with
   * it off, the standalone critic is the ONLY reviewer and must cover those PRs too).
   */
  managedBranches: (repoPath: string) => Set<string>;
  model?: string | null; // optional --model for the critic
  now?: () => number;
  timeoutMs?: number; // give up waiting on the verdict file (default 10m)
  /** Global in-flight cap across ALL repos (inFlight + starting). Default 2. */
  concurrency?: number;
  /** Deferral/skip logging. Default console.log/console.warn. */
  log?: (msg: string) => void;
  /** Injectable verdict reader (default: read VERDICT_FILE from the worktree). */
  readVerdict?: (worktreePath: string) => RawVerdict | null;
  /** Injectable diff fingerprint (default: real `git patch-id`). See ReviewService for the
   *  patchId/baseSha/files contract — identical here. */
  computePatchId?: (
    worktreePath: string,
    base: string,
  ) => Promise<{ patchId: string | null; baseSha: string | null; files: string[] }>;
  /** Injectable reader of a finished reviewer's token totals (default: readSessionUsage). */
  readUsage?: (worktreePath: string, criticSessionId: string) => Promise<SessionUsage | null>;
  /** Injectable sandbox backend probe seam (tests inject `() => null` so no real bwrap is
   *  spawned). Presence-checked (not `??`) because the seam legitimately returns null. */
  detectBackend?: () => SandboxBackend;
  /** Injectable membrane env seam (tests inject a stub so no host paths are touched). */
  membraneEnv?: () => {
    claudeDir: string;
    home: string;
    nodeBinReal: string;
    extraEnv?: Record<string, string>;
  };
}

export class StandalonePrCriticService {
  // Runs recorded once the agent spawns. Keyed by `${repoPath}\0${prNumber}`.
  private inFlight = new Map<string, InFlight>();
  // Claimed SYNCHRONOUSLY at the top of begin(), BEFORE its awaits (prReviewMeta fetch / pull-ref
  // fetch / createDetached), cleared in a finally. This is the ONLY thing stopping the next 60s
  // sweep from re-selecting an in-flight PR: its pr_reviews row isn't written until finalize,
  // minutes later. Same role as ReviewService.starting. Keyed identically to inFlight.
  private starting = new Set<string>();
  // Rotating offset for round-robin repo fairness: advanced each sweep so one busy repo (whose
  // candidates keep filling the concurrency cap) can't perpetually starve the others.
  private rrOffset = 0;
  private now: () => number;
  private timeoutMs: number;
  private concurrency: number;
  private log: (msg: string) => void;
  private readVerdict: (worktreePath: string) => RawVerdict | null;
  private computePatchId: StandalonePrCriticDeps["computePatchId"] & {};
  private readUsage: (
    worktreePath: string,
    criticSessionId: string,
  ) => Promise<SessionUsage | null>;

  /** Sandbox backend probe: injected seam (tests) or the real cached self-test. Presence-
   *  checked (not `??`) because the seam legitimately returns null (no backend). */
  private detectBackend(): SandboxBackend {
    if (this.deps.detectBackend) return this.deps.detectBackend();
    return realDetectBackend({
      home: homedir(),
      claudeDir: config.claudeDir,
      nodeBinReal: safeRealpath(config.nodeBin),
    });
  }

  /** Membrane env: injected seam (tests) or real host values. */
  private membraneEnv(): {
    claudeDir: string;
    home: string;
    nodeBinReal: string;
    extraEnv?: Record<string, string>;
  } {
    if (this.deps.membraneEnv) return this.deps.membraneEnv();
    return {
      claudeDir: config.claudeDir,
      home: homedir(),
      nodeBinReal: safeRealpath(config.nodeBin),
      extraEnv: collectPassthroughEnv(),
    };
  }

  constructor(private deps: StandalonePrCriticDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.log = deps.log ?? ((msg) => console.log(msg));
    this.readVerdict = deps.readVerdict ?? defaultReadVerdict;
    this.computePatchId = deps.computePatchId ?? defaultComputePatchId;
    this.readUsage = deps.readUsage ?? readSessionUsage;
  }

  private key(repoPath: string, prNumber: number): string {
    // NUL separator — can't appear in a path or a number, so the key is unambiguous.
    return `${repoPath}\0${prNumber}`;
  }

  /** True while the global in-flight cap has room for one more spawn. Counts BOTH the recorded
   *  runs (inFlight) and the mid-spawn claims (starting) so a sweep can't over-commit across its
   *  own `await begin()` calls. */
  private underCap(): boolean {
    return this.inFlight.size + this.starting.size < this.concurrency;
  }

  /**
   * The 60s enumeration. For each swept repo (round-robin), list its open PRs, filter to the
   * session-less ones worth reviewing, and spawn a critic for as many as the global concurrency
   * cap allows — deferring (and logging) the rest to the next sweep.
   *
   * The swept set is the UNION of (a) repos with `criticAllPrs` ON and (b) repos with a pending
   * epic LANDING PR (Stage B, #635). An epic completion opens an aggregate PR off the epic
   * integration branch; the operator wants the critic to review THAT PR even when the repo never
   * opted into all-PR review — so (b) is added unconditionally. We must union at the SWEEP level,
   * not just in eligible(): if no repo has criticAllPrs, an eligible()-only widening would never
   * run because sweep() early-returns here before ever calling sweepRepo. eligible() then carves
   * the (b)-only repos down to JUST the landing PR (head == the integration branch).
   */
  async sweep(): Promise<void> {
    const flagged = this.deps.repos().filter((r) => this.deps.store.getRepoConfig(r).criticAllPrs);
    // A reviewable landing PR is a non-dismissed epic_completed row that is still open
    // (landingState === "open") — a merged landing PR is no longer reviewable, so it drops out of
    // the union. listEpicCompleted() already filters out dismissed rows. No-arg = every repo. The
    // set is small (one row per in-flight epic) so scanning it each sweep is cheap.
    const epicRepos = this.deps.store
      .listEpicCompleted()
      .filter((r) => r.landingState === "open")
      .map((r) => r.repoPath);
    const enabled = [...new Set([...flagged, ...epicRepos])];
    if (enabled.length === 0) return;
    // Round-robin: rotate the start index each sweep so a repo that keeps saturating the cap can't
    // perpetually starve later repos. Advance regardless of how far we got this sweep.
    const order = this.rotate(enabled);
    this.rrOffset = (this.rrOffset + 1) % Math.max(1, enabled.length);
    for (const repoPath of order) {
      if (!this.underCap()) {
        // Cap already full from an earlier repo this sweep — everything here is deferred.
        this.log(
          `[pr-critic] concurrency cap full; deferring all PRs in ${repoPath} to next sweep`,
        );
        continue;
      }
      await this.sweepRepo(repoPath);
    }
  }

  /** Rotate `repos` by the current round-robin offset (a no-mutation copy). */
  private rotate(repos: string[]): string[] {
    const n = repos.length;
    const off = ((this.rrOffset % n) + n) % n;
    return [...repos.slice(off), ...repos.slice(0, off)];
  }

  /** Enumerate + filter + spawn for ONE repo. Split out of sweep() so the per-repo filter
   *  reasoning isn't tangled with the cross-repo round-robin. */
  private async sweepRepo(repoPath: string): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return; // no forge → can't enumerate
    // Fresh, top-of-sweep snapshot of session-owned branches (NEVER cached — a session may have
    // started/ended since the last sweep). criticEnabled gates whether we defer to the session
    // critic at all: with it OFF, the standalone critic is the sole reviewer and must cover
    // session-managed PRs too (the coverage-hole the criticAllPrs flag closes).
    const managed = this.deps.managedBranches(repoPath);
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const criticEnabled = cfg.criticEnabled;
    // criticAllPrs threaded into eligible() (alongside criticEnabled) so it can tell the two ways a
    // repo lands in the swept set apart: flag ON → review every eligible PR (old behavior); flag OFF
    // → this repo is here ONLY for its epic landing PR, so eligible() restricts to that one PR.
    const criticAllPrs = cfg.criticAllPrs;

    let prs: PullRequest[];
    try {
      prs = await forge.listPullRequests();
    } catch (err) {
      this.log(`[pr-critic] listPullRequests failed for ${repoPath}: ${String(err)}`);
      return;
    }

    const candidates = prs.filter((pr) =>
      this.eligible(repoPath, pr, managed, criticEnabled, criticAllPrs),
    );
    let deferred = 0;
    for (const pr of candidates) {
      if (!this.underCap()) {
        deferred++;
        continue;
      }
      await this.begin(repoPath, pr, forge);
    }
    if (deferred > 0) {
      // No silent cap: surface how many eligible PRs are waiting on a free slot next sweep.
      this.log(`[pr-critic] concurrency cap reached for ${repoPath}; deferred ${deferred} PR(s)`);
    }
  }

  /** Whether an enumerated PR is a session-less, CI-green, never-yet-reviewed-at-this-head PR the
   *  standalone critic should review. Drops (silently — these are the expected exclusions) drafts,
   *  non-green PRs, bots, session-owned PRs (when the session critic is on), in-flight/mid-spawn
   *  runs, and already-reviewed heads. A host that didn't supply headSha/headRefName is skipped +
   *  logged (we can't dedup or detach without them). */
  private eligible(
    repoPath: string,
    pr: PullRequest,
    managed: Set<string>,
    criticEnabled: boolean,
    criticAllPrs: boolean,
  ): boolean {
    if (pr.isDraft) return false;
    // Best-effort TOCTOU gate: the rollup can change between enumeration and spawn, but a green
    // read here is the right cheap filter (a finalize-time live-state recheck backstops the rest).
    if (pr.checks !== "success") return false;
    if (pr.kind !== "regular") return false; // Dependabot / release-please bots — not for the critic
    if (!pr.headSha || !pr.headRefName) {
      this.log(`[pr-critic] ${repoPath}#${pr.number} missing headSha/headRefName — skipping`);
      return false;
    }
    // Stage B (#635): a repo without criticAllPrs is swept ONLY because it has an epic landing PR.
    // Review ONLY that PR (head == the epic integration branch) — a child PR's head is its own task
    // branch (base=integration), so isEpicIntegrationBranch(head) is false and it stays excluded.
    // With criticAllPrs ON this carve-out is inert (every regular PR is in scope as before).
    if (!criticAllPrs && !isEpicIntegrationBranch(pr.headRefName)) return false;
    // The session critic already owns this branch — only defer to it when it's actually running
    // (criticEnabled). With the session critic off, we are the sole reviewer and must cover it.
    if (criticEnabled && managed.has(pr.headRefName)) return false;
    const key = this.key(repoPath, pr.number);
    if (this.inFlight.has(key) || this.starting.has(key)) return false; // already running / mid-spawn
    // Already reviewed at this exact head — the per-head dedup (a new push moves headSha and
    // re-arms review; the patch-id skip in begin() then handles pure rebases of that new head).
    if (this.deps.store.getPrReview(repoPath, pr.number)?.headSha === pr.headSha) return false;
    return true;
  }

  /**
   * Spawn a critic for one eligible PR. Mirrors ReviewService.begin: claim `starting`
   * synchronously, allocate the disposable worktree at the PR head, fingerprint the diff,
   * patch-id-skip if unchanged, build the session-less prompt, spawn, and record the run +
   * its spawn row. The `starting` claim is released in a finally so a failed spawn (fork
   * fetch failure, etc.) frees the slot for the next sweep.
   */
  private async begin(repoPath: string, pr: PullRequest, forge: GitForge): Promise<void> {
    const key = this.key(repoPath, pr.number);
    this.starting.add(key); // claimed SYNCHRONOUSLY, before any await — the next sweep's guard
    try {
      // Number-keyed metadata (body/base/fork/state) — number-keyed so a recurring or fork head
      // branch name can't resolve a different PR (unlike branch-keyed prStatus).
      const meta = forge.prReviewMeta ? await forge.prReviewMeta(pr.number) : null;
      if (!meta) {
        // Host without a PR-view API, or the PR is gone/unreadable → can't review without
        // body/base. Skip (the pr_reviews row stays absent, so a later sweep retries).
        this.log(`[pr-critic] ${repoPath}#${pr.number}: no PR metadata available — skipping`);
        return;
      }
      if (meta.state !== "open") {
        // Raced to merged/closed since enumeration → don't review (nothing left to gate).
        this.log(`[pr-critic] ${repoPath}#${pr.number} no longer open (${meta.state}) — skipping`);
        return;
      }
      // Fork PR: its head sha lives off-branch on the contributor's fork, not the base origin.
      // GitHub exposes it on the base repo under refs/pull/<n>/head, which createDetached fetches.
      const pullRef = meta.isCrossRepository ? `refs/pull/${pr.number}/head` : undefined;

      let wt;
      try {
        // createDetached is (repoPath, branch, sha, slug?, pullRef?) — slug is undefined here (the
        // PR head sha is already unique per PR, so the default `…-review-<sha>` path is collision-
        // free and reused-on-restart to reclaim an interrupted run). pullRef lands the fork head.
        wt = await this.deps.worktree.createDetached(
          repoPath,
          pr.headRefName!,
          pr.headSha!,
          undefined,
          pullRef,
        );
      } catch (err) {
        // A fork whose pull-ref fetch failed (or any worktree failure) → skip; the next sweep
        // retries. The `finally` releases `starting`.
        this.log(`[pr-critic] worktree failed for ${repoPath}#${pr.number}: ${String(err)}`);
        return;
      }

      const {
        patchId: rawPatchId,
        baseSha,
        files,
      } = await this.computePatchId(wt.worktreePath, meta.baseRefName);
      const patchId = rawPatchId ?? "";

      const prior = this.deps.store.getPrReview(repoPath, pr.number);
      // Identical diff already reviewed this streak (pure rebase / churn back to a reviewed state)
      // → re-point the dedup row at the new head and skip. shouldSkipForPatchId wants
      // {decision, patchId, reviewedPatchIds}; the pr_reviews row carries exactly those (decision
      // is "" until the first real verdict, which never equals a ReviewDecision → never skips).
      if (
        shouldSkipForPatchId(
          prior
            ? {
                decision: prior.decision === "" ? undefined : prior.decision,
                patchId: prior.patchId,
                reviewedPatchIds: prior.reviewedPatchIds,
              }
            : null,
          patchId,
        )
      ) {
        this.deps.store.bumpPrReviewHead(repoPath, pr.number, pr.headSha!, this.now());
        this.deps.worktree.remove(wt.worktreePath);
        this.log(`[pr-critic] ${repoPath}#${pr.number} unchanged diff (patch-id) — skip re-review`);
        return;
      }

      // Resolve the base for the prompt: the concrete fingerprinted SHA when we have it (so the
      // review diffs the identical base the skip decision used), else the base branch name.
      const diffBase = baseSha ?? meta.baseRefName;
      // Fail-closed guard + membrane-wrapped spawn + spawn-row record live in spawnAndRecord (keeps
      // begin under the cognitive budget). Returns false when nothing spawned (fail-closed / spawn
      // error) — the worktree is reaped inside, so begin just bails.
      await this.spawnAndRecord(repoPath, pr, wt.worktreePath, diffBase, meta.body, key, {
        patchId,
        baseSha,
        files,
        priorReviewedPatchIds: prior?.reviewedPatchIds ?? [],
      });
    } finally {
      this.starting.delete(key);
    }
  }

  /**
   * Build the membrane-wrapped critic argv and spawn it, recording the in-flight run + spawn row on
   * success. Extracted from begin() so begin stays under the complexity budget. Fail-closed: in
   * api-key mode with no configured key it logs, reaps the worktree, and returns without spawning
   * (never bills the subscription) — mirrors ReviewService.begin. On a spawn error it likewise reaps
   * and returns. The FS membrane matches ReviewService (#601): an isolated worktree gets per-task
   * binds (worktree + git common dir), not the whole repo; wrapArgv degrades to passthrough when no
   * bwrap backend (no behavior change on backend-less hosts), and api-key mode masks the OAuth
   * credential + binds the helper (passthrough carries a credential-less CLAUDE_CONFIG_DIR instead).
   */
  private async spawnAndRecord(
    repoPath: string,
    pr: PullRequest,
    worktreePath: string,
    diffBase: string,
    prBody: string,
    key: string,
    fp: {
      patchId: string;
      baseSha: string | null;
      files: string[];
      priorReviewedPatchIds: string[];
    },
  ): Promise<void> {
    if (isApiKeyMode() && !isApiKeyConfigured()) {
      this.log(
        `[pr-critic] ${repoPath}#${pr.number} api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)`,
      );
      this.deps.worktree.remove(worktreePath);
      return;
    }
    const { argv, sessionId: criticSessionId } = readonlyReviewerArgv(
      this.deps.model ?? null,
      prReviewPrompt(diffBase, pr.title, prBody),
      // Same extended thinking budget as the session critic (#604): the standalone PR critic runs
      // the identical #597 VERIFY prompt and needs the same cross-file reasoning headroom.
      CRITIC_THINKING_TOKENS,
    );
    const backend = this.detectBackend();
    const env = this.membraneEnv();
    const membrane: MembraneInputs = {
      worktreePath,
      gitCommonDir: this.deps.worktree.gitCommonDir(worktreePath),
      isolated: true,
      repoPath,
      claudeDir: env.claudeDir,
      home: env.home,
      nodeBinReal: env.nodeBinReal,
      extraEnv: env.extraEnv,
      // api-key mode: a bwrap-wrapped reviewer masks the OAuth credential + binds the helper.
      ...apiKeyMembraneFields(),
    };
    const wrapped = wrapArgv(argv, { profile: "standard", backend, membrane });

    let terminalId: string;
    try {
      terminalId = this.deps.herdr.start(
        `pr-critic ${repoPath}#${pr.number}`,
        worktreePath,
        wrapped,
        // No backend → passthrough (no membrane) → set CLAUDE_CONFIG_DIR to a credential-less
        // mirror; with a backend the membrane masks creds in place.
        apiKeyPassthroughEnv(backend !== null),
      ).terminalId;
    } catch (err) {
      this.log(`[pr-critic] spawn failed for ${repoPath}#${pr.number}: ${String(err)}`);
      this.deps.worktree.remove(worktreePath);
      return;
    }

    this.inFlight.set(key, {
      repoPath,
      prNumber: pr.number,
      branch: pr.headRefName!,
      headSha: pr.headSha!,
      patchId: fp.patchId,
      baseSha: fp.baseSha,
      files: fp.files,
      worktreePath,
      terminalId,
      criticSessionId,
      startedAt: this.now(),
      priorReviewedPatchIds: fp.priorReviewedPatchIds,
    });
    // Persist the spawn row now (totals NULL until finalize) so review burn is attributable even if
    // the run crashes/times out before a verdict (issue #502). The taskSessionId column is opaque
    // TEXT with no FK to `sessions`, so a synthetic `pr:<repo>#<n>` is safe — it just labels the cost
    // as belonging to this PR, not a managed session.
    this.deps.store.recordReviewerSpawn({
      reviewerSessionId: criticSessionId,
      taskSessionId: `pr:${repoPath}#${pr.number}`,
      kind: "review",
      worktreePath,
      model: this.deps.model ?? null,
      spawnedAt: this.now(),
    });
  }

  /** The 15s finalize poll. Mirror ReviewService.tick: for each in-flight run not already
   *  finalizing, read its verdict file; if absent and not timed out, leave it running; else claim
   *  the finalizing guard and finalize in a try/finally that always drops the entry (so a throw
   *  can't wedge the run forever / leak its worktree+terminal). */
  async tick(): Promise<void> {
    for (const f of [...this.inFlight.values()]) {
      if (f.finalizing) continue; // an overlapping tick already owns it
      const raw = this.readVerdict(f.worktreePath);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue; // still running, no verdict yet
      f.finalizing = true;
      const key = this.key(f.repoPath, f.prNumber);
      try {
        await this.finalize(f, raw);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Turn a finished run's raw verdict into its outward effects + dedup row. Branches on the PR's
   * LIVE, number-keyed state (re-fetched here — the critic can finish minutes after enumeration,
   * by which point the PR may have merged/closed):
   *   - open   → post the review as a COMMENT (NEVER REQUEST_CHANGES — a blocking review on a
   *              third-party PR under branch protection is too intrusive, and postReview's
   *              self-authored-422 fallback doesn't apply). Posted even with no findings, as a
   *              visible "reviewed" signal (matching the session critic's open path).
   *   - merged + findings → a best-effort post-merge issue comment (for a human follow-up).
   *   - else (closed / clean-merged / unconfirmable) → silent.
   * Then persist the (repoPath, prNumber) dedup row and reap the worktree + terminal.
   */
  private async finalize(f: InFlight, raw: RawVerdict | null): Promise<void> {
    try {
      const verdict = buildVerdictCore(
        raw,
        f.baseSha,
        f.files,
        f.patchId,
        `pr:${f.repoPath}#${f.prNumber}`,
      );
      const forge = this.deps.resolveForge(f.repoPath);

      // Re-fetch live state, number-keyed (mirrors ReviewService's at-finalize recheck). A throw
      // or missing prReviewMeta leaves `state` undefined → fail-closed (post nothing).
      let state: PrReviewMeta["state"] | undefined;
      try {
        state = forge?.prReviewMeta ? (await forge.prReviewMeta(f.prNumber))?.state : undefined;
      } catch (err) {
        this.log(
          `[pr-critic] state recheck failed for ${f.repoPath}#${f.prNumber}: ${String(err)}`,
        );
      }

      if (forge && state === "open" && verdict.decision !== "error") {
        // COMMENT only — never REQUEST_CHANGES on a session-less third-party PR. Post even when
        // findings are empty (a clean "comment" verdict): a visible "the critic looked at this"
        // signal. EXCEPT an error verdict (timeout / unparseable run) — it has no real content
        // (body:""), so posting would leave a contentless comment on a third-party PR. Mirror
        // ReviewService, which emits nothing on error verdicts; the dedup row + usage capture
        // below still run, and shouldSkipForPatchId re-reviews the same diff next push.
        try {
          await forge.postReview(f.prNumber, {
            event: "COMMENT",
            body: `${verdict.body}\n\n${CRITIC_REVIEW_MARKER}`,
          });
        } catch (err) {
          this.log(`[pr-critic] postReview failed for ${f.repoPath}#${f.prNumber}: ${String(err)}`);
        }
      } else if (forge && state === "merged" && verdict.findings.length > 0 && forge.comment) {
        // Critic finished after the PR merged: record findings as a post-merge comment so they
        // aren't silently dropped (a human can follow up). Same rider as the session critic's
        // merged path (Task 4). A clean verdict on a merged PR stays silent.
        try {
          await forge.comment(
            f.prNumber,
            `_Critic review completed after this PR merged — recording the findings here for a follow-up._\n\n${verdict.body}\n\n${CRITIC_REVIEW_MARKER}`,
          );
        } catch (err) {
          this.log(
            `[pr-critic] post-merge comment failed for ${f.repoPath}#${f.prNumber}: ${String(err)}`,
          );
        }
      }
      // else: error verdict / closed-unmerged / clean-merged / unconfirmable → silent.

      // Persist the (repoPath, prNumber) dedup row. reviewedPatchIds mirrors ReviewService:
      // a CLEAN verdict (no findings) RESETS the set to [] (so a later revert to an earlier
      // buggy diff is re-reviewed), a findings verdict APPENDS this run's patch-id (deduped) to
      // the prior set (so an identical-diff rebase is skipped). An error verdict stores
      // patchId:'' (from buildVerdictCore) — shouldSkipForPatchId short-circuits on
      // decision==="error" before checking set membership, so the same diff re-reviews next push.
      const reviewedPatchIds =
        verdict.findings.length === 0 ? [] : [...new Set([...f.priorReviewedPatchIds, f.patchId])];
      this.deps.store.putPrReview({
        repoPath: f.repoPath,
        prNumber: f.prNumber,
        headSha: f.headSha,
        patchId: f.patchId,
        decision: verdict.decision,
        reviewedPatchIds,
        updatedAt: this.now(),
      });

      // Best-effort token attribution (issue #502); a missing transcript leaves totals null.
      await captureUsage(
        this.readUsage,
        this.deps.store.completeReviewerSpawn.bind(this.deps.store),
        f.worktreePath,
        f.criticSessionId,
        this.now(),
        `pr:${f.repoPath}#${f.prNumber}`,
      );
    } finally {
      reapRun(this.deps.herdr.stop, this.deps.worktree.remove, f.terminalId, f.worktreePath);
    }
  }

  /** PR keys with a critic run currently in flight (for diagnostics / shutdown). */
  inFlightKeys(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Worktree paths of standalone critic runs currently owned in-memory — the GC sweep must spare
   *  these (a re-adopted #631 orphan's tick() still needs its worktree). */
  inflightWorktrees(): string[] {
    return [...this.inFlight.values()].map((f) => f.worktreePath);
  }

  /** Tear down every in-flight run (reap its terminal + worktree). For process shutdown. */
  stopAll(): void {
    for (const f of this.inFlight.values()) {
      reapRun(this.deps.herdr.stop, this.deps.worktree.remove, f.terminalId, f.worktreePath);
    }
    this.inFlight.clear();
    this.starting.clear();
  }
}
