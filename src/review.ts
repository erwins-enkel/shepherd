import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { HerdrDriver, HerdrAgent } from "./herdr";
import type { WorktreeMgr } from "./worktree";
import type { GitForge, GitState, PrStatus } from "./forge/types";
import { CRITIC_REVIEW_MARKER, AUTHOR_RESPONSE_MARKER } from "./forge/types";
import type { ReviewVerdict, ReviewerEnv, Session, ReviewerSpawnRow, AgentProvider } from "./types";
import type { RoleEnvironment } from "./default-model";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { apiKeyFailClosed } from "./spawn-auth";
import { jsonlPathFor, readSessionUsage, type SessionUsage } from "./usage";
import { readActivitySignal } from "./activity-signal";
import {
  createCodexRolloutResolver,
  readCodexTranscriptSignals,
  parseCodexUsage,
  type CodexRolloutResolver,
} from "./codex-activity";
import { checksCleared } from "./checks-gate";
import { isSpawnAlive, decideVerdictAction, STARTUP_GRACE_MS } from "./json-tolerant";
import type { VerdictAction, VerdictRead } from "./json-tolerant";
import {
  reviewPrompt,
  defaultReadVerdict,
  defaultComputePatchId,
  defaultCollectBaseDelta,
  scopeFindings,
  buildVerdictCore,
  shouldSkipForPatchId,
  captureUsage,
  reapRun,
  VERDICT_FILE,
  type RawVerdict,
  type EpicBaseDelta,
  type EpicContext,
} from "./critic-core";
import { scrubStaleVerdictArtifacts } from "./codex-last-message";
import { isEpicIntegrationBranch } from "./epic-branch";
import { resolveAuxSpawn, type MembraneSeams } from "./spawn-membrane";

// Session-agnostic critic helpers now live in ./critic-core (a forthcoming standalone-PR-critic
// service reuses them). Re-exported here so existing importers (and tests) keep their paths.
export { reviewPrompt, defaultComputePatchId, scopeFindings };

/** Outcome of a consider()/forceReview() call: a critic was spawned, the run was declined
 *  (preconditions unmet / dedup / ceiling / race guard), or begin() bailed before spawning. */
export type ReviewOutcome = "started" | "skipped" | "error";

/** Agent-facing steer that carries critic findings into the task PTY. NOT i18n'd.
 *
 *  `epicBase` (issue #1757): epic children are deliberately never rebased onto their moving
 *  integration branch, so the CHILD's own worktree is missing the sibling work that has merged into
 *  the base — exactly like the critic's was. The critic can now ground a finding in that base code;
 *  without this note the agent receiving the finding would be unable to SEE the code it names (and
 *  would "fix" it against a tree that lacks it). So tell it where the base is. */
function steerText(findings: string[], prNumber: number, epicBase: string | null): string {
  const lines = [
    "The PR critic reviewed your latest push. Address each point below in this PR:",
    "",
    ...findings.map((f, i) => `${i + 1}. ${f}`),
    "",
  ];
  if (epicBase) {
    lines.push(
      `NOTE: this PR is an epic child based on \`${epicBase}\`, and your branch has NOT been rebased onto it.`,
      "Sibling work already merged into that base is NOT in your worktree, so a finding may refer to code you cannot see locally. Inspect the base with:",
      `  git fetch origin ${epicBase} && git diff --name-only HEAD...FETCH_HEAD   # what merged since you forked`,
      "  git show FETCH_HEAD:<path>                                              # read a file as it exists on the base",
      "",
    );
  }
  lines.push(
    "Fix what's valid. If you genuinely disagree with a point, don't silently skip it —",
    `post a brief note on the PR explaining your reasoning so the critic can weigh it, e.g.:`,
    `  gh pr comment ${prNumber} --body "${AUTHOR_RESPONSE_MARKER} <which finding + why it shouldn't change>"`,
    "Then commit & push so CI and the critic re-run.",
  );
  return lines.join("\n");
}

// Max auto-address steers per outstanding-findings streak, and the same ceiling for the
// consecutive-error counter. Surfaced on every verdict as `addressCap`, so the UI badge
// reads it off the payload instead of mirroring this number (which would silently drift
// if `deps.cap` ever varies per deployment).
const DEFAULT_CAP = 3;
// How long a delivered final round may run before the badge escalates from dimmed
// FINAL to orange STALLED on its own (covers an agent that abandons the last round
// without re-pushing). Surfaced per-verdict as `finalRoundTimeoutMs` so the UI reads
// the live value instead of mirroring this number.
const DEFAULT_FINAL_ROUND_TIMEOUT_MS = 15 * 60_000;

interface InFlight {
  sessionId: string;
  headSha: string;
  patchId: string; // fingerprint of this run's reviewed diff; persisted on the verdict for rebase-skip
  baseSha: string | null; // the concrete base the critic diffs against (== the fingerprint's base); null = total git failure
  files: string[]; // repo-relative paths in `git diff baseSha...HEAD`; drives the buildVerdict scope backstop
  epicBase: string | null; // the epic integration branch when this session is an epic child (#1757); else null — carried so the auto-address steer can point the agent at the base its worktree lacks
  prNumber: number;
  branch: string; // head branch, for the at-finalize live PR-state recheck (prStatus keys on it)
  repoPath: string;
  worktreePath: string;
  terminalId: string;
  criticSessionId: string; // the critic's claude session id → locates its transcript for live activity
  reviewerProvider: ReviewerEnv["provider"];
  reviewerModel: string | null;
  reviewerEffort: string | null;
  startedAt: number;
  priorRound: number; // auto-address steers already spent on this findings streak
  priorErrorRound: number; // consecutive critic error/timeout verdicts before this run
  priorStreakReviews: number; // critic reviews finalized on this streak before this run (bounds spawns at 2*cap)
  priorReviewedPatchIds: string[]; // patch-ids reviewed on this streak before this run (churn/revert dedup set)
  priorSeenNoteIds: string[]; // seen-note set carried in (before this run's fetch)
  seenNoteIds: string[]; // priorSeen + notes fed to THIS run's critic; only "consumed" on a real verdict
  finalizing?: boolean;
}

/** The prior verdict's streak-accountability state, carried into a fresh run's InFlight (no
 *  prior → fresh defaults). Extracted from begin() so its per-field `??` defaults don't inflate
 *  that method's branch count past the complexity budget. */
type PriorStreakState = Pick<
  InFlight,
  | "priorRound"
  | "priorErrorRound"
  | "priorStreakReviews"
  | "priorReviewedPatchIds"
  | "priorSeenNoteIds"
>;
function priorStreakState(prior: ReviewVerdict | null): PriorStreakState {
  return {
    priorRound: prior?.addressRound ?? 0,
    priorErrorRound: prior?.errorRound ?? 0,
    priorStreakReviews: prior?.streakReviews ?? 0,
    priorReviewedPatchIds: prior?.reviewedPatchIds ?? [],
    priorSeenNoteIds: prior?.seenNoteIds ?? [],
  };
}

export interface ReviewServiceDeps extends MembraneSeams {
  store: Pick<
    SessionStore,
    | "getRepoConfig"
    | "getReview"
    | "putReview"
    | "bumpReviewHead"
    | "dropReview"
    | "snapshotReviews"
    | "addSignal"
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "listReviewerSpawns"
    | "get"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "closeTab" | "paneForegroundProcs">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove" | "gitCommonDir">;
  resolveForge: (repoPath: string) => GitForge | null;
  onChange: (id: string, verdict: ReviewVerdict) => void;
  /** Fired when a critic run starts (true) and when it ends (false) for a session. The start
   *  transition carries the exact environment captured for that spawn; end omits it. */
  onReviewing?: (id: string, reviewing: boolean, env?: ReviewerEnv) => void;
  /**
   * Fired each tick a critic is still running, with its latest *meaningful* tool-use
   * summary (e.g. "$ git diff", "read review.ts") — surfaced live in the UI badge
   * tooltip so the operator can see what the critic is doing, not just that it's busy.
   * Only fired when a summary is available; the run-ended (onReviewing false) signal
   * clears it client-side.
   */
  onActivity?: (id: string, summary: string) => void;
  /**
   * Steer critic findings into a session's live PTY (typically SessionService.reply).
   * Returns false (or throws — both treated as not-delivered) when the steer can't
   * land; only a true return advances the round. Absent → the auto-address loop is
   * disabled regardless of per-repo config.
   */
  autoAddress?: (sessionId: string, text: string) => Promise<boolean>;
  /**
   * Max auto-address rounds before escalating to the human (default 3). Pass a thunk to
   * read a live, UI-configurable value per-use — the cap is resolved on every read so a
   * settings change takes effect on the next critic run without a restart.
   */
  cap?: number | (() => number);
  // optional environment thunk for the critic (CLI + model, read per spawn → live settings)
  env?: () => RoleEnvironment;
  now?: () => number;
  timeoutMs?: number; // give up waiting on the verdict file
  /** default: `existsSync` — whether a reviewer's disposable worktree is still on disk.
   *  reapOrphans() uses it to tell a true restart-orphan (worktree survives) from an
   *  already-finalized review (finalize reaps the worktree). */
  worktreeExists?: (p: string) => boolean;
  /** Injectable verdict reader (default: read VERDICT_FILE from the worktree). 3-way result so
   *  tick() can fail fast on a present-but-unparseable verdict and gate a repaired parse on the
   *  critic spawn having finished. */
  readVerdict?: (worktreePath: string, spawnSessionId?: string) => VerdictRead<RawVerdict>;
  /** Injectable content fingerprint of `git diff base...HEAD` in the worktree (default:
   *  real `git patch-id`). Returns the patch-id (null when there's no diff or git fails →
   *  never skips), the concrete base SHA it fetched-and-diffed (null on a total git failure →
   *  prompt falls back to the local base, backstop is skipped), and the changed-file set (the
   *  same fresh base feeds the buildVerdict scope backstop). */
  computePatchId?: (
    worktreePath: string,
    base: string,
  ) => Promise<{ patchId: string | null; baseSha: string | null; files: string[] }>;
  /** Injectable collector of the sibling work an epic child's tree is missing (default: real
   *  read-only git). Called ONLY for an epic child with a resolved baseSha; null on any git
   *  failure → the epic block degrades to telling the critic to run the commands itself. */
  collectBaseDelta?: (worktreePath: string, baseSha: string) => Promise<EpicBaseDelta | null>;
  /** Injectable reader for the critic's latest tool-use summary (default: parse its JSONL transcript
   *  via readActivitySignal for claude, or resolve its Codex rollout for codex). null = no parseable
   *  activity yet. */
  readActivity?: (
    worktreePath: string,
    criticSessionId: string,
    provider: AgentProvider | null,
  ) => string | null;
  /** Injectable per-service Codex rollout resolver (backoff + positive cache, keyed by critic
   *  session id). Default: a fresh {@link createCodexRolloutResolver}. */
  codexResolver?: CodexRolloutResolver;
  /** Injectable reader of a finished reviewer's token totals from its transcript (default:
   *  readSessionUsage for claude, or parse the resolved Codex rollout for codex). null = transcript
   *  unresolved/unreadable → the row's token totals stay NULL (unknown), NOT zero. */
  readUsage?: (
    worktreePath: string,
    criticSessionId: string,
    provider: AgentProvider | null,
    model: string | null,
  ) => Promise<SessionUsage | null>;
  /** Injectable reader for the session's approved `.shepherd-plan.md` (#1812 finding A; default
   *  reads it from the LIVE session worktree). null when no plan was written. Fed to the critic as
   *  UNTRUSTED intent-context. MUST read from `session.worktreePath`, NOT the critic's detached
   *  worktree — the plan file is git-excluded, so it can never exist in a fresh head checkout. */
  readPlan?: (worktreePath: string) => string | null;
}

export class ReviewService {
  private inflight = new Map<string, InFlight>();
  // Session ids whose critic is mid-spawn but not yet in `inflight`. begin() awaits a
  // gh fetch on the re-review path, so this claims the slot across that await — without
  // it, a second session:git event would pass the inflight guard and double-spawn,
  // orphaning the first run's worktree + terminal.
  private starting = new Set<string>();
  private now: () => number;
  private timeoutMs: number;
  // Resolve the cap on every read so a live config thunk (UI setting) takes effect on the
  // next critic run. A plain number or absent dep collapses to a constant thunk.
  private capFn: () => number;
  private get cap(): number {
    return this.capFn();
  }
  private readVerdict: (worktreePath: string, spawnSessionId?: string) => VerdictRead<RawVerdict>;
  private computePatchId: (
    worktreePath: string,
    base: string,
  ) => Promise<{ patchId: string | null; baseSha: string | null; files: string[] }>;
  private collectBaseDelta: (
    worktreePath: string,
    baseSha: string,
  ) => Promise<EpicBaseDelta | null>;
  private readActivity: (
    worktreePath: string,
    criticSessionId: string,
    provider: AgentProvider | null,
  ) => string | null;
  private codexResolver: CodexRolloutResolver;
  private readUsage: (
    worktreePath: string,
    criticSessionId: string,
    provider: AgentProvider | null,
    model: string | null,
  ) => Promise<SessionUsage | null>;
  private readPlan: (worktreePath: string) => string | null;
  private worktreeExists: (p: string) => boolean;

  constructor(private deps: ReviewServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    // capture into a const so the constant-thunk closure keeps the narrowed type.
    const cap = deps.cap;
    this.capFn = typeof cap === "function" ? cap : () => cap ?? DEFAULT_CAP;
    this.readVerdict = deps.readVerdict ?? defaultReadVerdict;
    this.computePatchId = deps.computePatchId ?? defaultComputePatchId;
    this.collectBaseDelta = deps.collectBaseDelta ?? defaultCollectBaseDelta;
    this.codexResolver = deps.codexResolver ?? createCodexRolloutResolver();
    this.readActivity =
      deps.readActivity ??
      ((wt, id, provider) => defaultReadActivity(wt, id, provider, this.codexResolver));
    this.readUsage =
      deps.readUsage ??
      ((wt, id, provider, model) => defaultReadUsage(wt, id, provider, model, this.codexResolver));
    this.readPlan = deps.readPlan ?? defaultReadPlan;
    this.worktreeExists = deps.worktreeExists ?? existsSync;
  }

  /** Decide whether `git` warrants a fresh critic run for `session`, and start one. With
   *  `opts.force` (the operator's manual re-review via forceReview) the same-head dedup,
   *  the spawn ceiling, and the patch-id churn-skip are bypassed — but the hard preconditions
   *  (PR open + CI green + critic enabled + not already running) still gate. */
  async consider(
    session: Session,
    git: GitState,
    opts?: { force?: boolean },
  ): Promise<ReviewOutcome> {
    const force = opts?.force === true;
    if (
      git.state !== "open" ||
      !checksCleared(git.checks, git.noCi ?? false) ||
      !git.headSha ||
      !git.number
    )
      return "skipped";
    if (!session.branch) return "skipped";
    if (!this.deps.store.getRepoConfig(session.repoPath).criticEnabled) return "skipped";
    if (this.inflight.has(session.id) || this.starting.has(session.id)) return "skipped"; // in flight / mid-spawn
    const prior = this.deps.store.getReview(session.id);
    // Head already reviewed → skip. EXCEPT a spawn-abort row: the critic never ran (e.g. the pool
    // had no usable account), so the head is NOT reviewed — re-attempt it every poll (cheap: a
    // still-cold pool aborts again pre-spawn) so the review self-heals once the pool warms.
    if (!force && prior?.headSha === git.headSha && !prior.spawnAborted) return "skipped";
    // Per-streak spawn ceiling: review token spend is unbounded otherwise (consider() would
    // spawn a critic on every new CI-green head forever). Cap *findings-bearing* reviews per
    // outstanding-findings streak at 2*cap (the live cap, derived inline — a persisted
    // spawnCap field would be dead weight nothing reads). Bail BEFORE allocating the probe
    // worktree so even that is saved.
    //
    // STRICT for findings reviews, APPROXIMATE for total spawns. streakReviews increments
    // only on a findings verdict and an error/timeout verdict preserves it while carrying
    // findings=[] (it earns no progress) — so an error verdict can never itself reach the
    // ceiling (reaching it needs a findings verdict, which then blocks the next spawn), and
    // it never trips this gate's findings>0 leg. Net: findings-bearing reviews are hard-capped
    // at 2*cap, but a critic flapping on *timeouts* keeps re-spawning on each new head. That
    // error churn is deliberately governed by the separate errorRound escalation in finalize()
    // (a stall signal at the cap), NOT this ceiling: a transient timeout must neither be
    // charged against the findings budget nor permanently halt review. So total critic spawns
    // can exceed 2*cap while errors interleave — bounded by errorRound + the human it escalates
    // to, not by this gate.
    //
    // RE-ENGAGEMENT CLIFF: a PR paused one round short of clean stays paused on the AUTO path.
    // Crossing the ceiling halts only auto re-spawns here — the resume paths are a clean verdict
    // that lands while still under budget (won't happen once paused — we don't auto re-spawn), a
    // human archiving the session (forget() → dropReview clears the row, resetting the streak),
    // or an operator manually re-engaging via forceReview (which resets the streak as hygiene so
    // the next auto consider() re-engages too). `force` here is that manual path bypassing the
    // ceiling for one run.
    if (!force && prior && prior.findings.length > 0 && prior.streakReviews >= 2 * this.cap)
      return "skipped";
    // Claim the slot synchronously, BEFORE begin()'s await, so a concurrent consider bails.
    this.starting.add(session.id);
    try {
      await this.begin(session, git, force);
    } finally {
      this.starting.delete(session.id);
    }
    // begin() populates `inflight` only when it actually spawned a critic; its silent early
    // returns (worktree/spawn fail, api-key-mode-without-key, post-await `starting` tombstone,
    // or a non-force rebaseSkip churn-skip) leave it unset → "error". The auto caller ignores
    // this return, so the non-force churn-skip "error" is irrelevant there; it's authoritative
    // only for the manual/force path.
    return this.inflight.has(session.id) ? "started" : "error";
  }

  private async begin(session: Session, git: GitState, force: boolean): Promise<void> {
    // The prior verdict (an earlier head — consider() never re-reviews the same head)
    // carries this streak's accountability state: its findings get fed to the critic
    // to verify they were addressed, and its addressRound bounds the auto-address loop.
    const prior = this.deps.store.getReview(session.id);

    // Mint the per-spawn critic session id BEFORE createDetached so it can key the worktree path
    // (A0, issue #1816): passing it as the `slug` makes the critic's cwd unique per spawn, which is
    // the invariant the Codex rollout resolver relies on (`session_meta.cwd` → exactly one rollout).
    // Without it, two reviews at the same head SHA would share `…-review-<sha>` and the resolver
    // couldn't tell their rollouts apart. criticArgv takes the pre-minted id and pins the same
    // `--session-id`, so the path/transcript wiring is unchanged.
    const criticSessionId = randomUUID();

    // Allocate the disposable worktree at the PR head first: it's the cheap, reliable way
    // to resolve both head + base locally (a force-pushed SHA may not be in the repo until
    // it's checked out), and it's exactly the tree the critic would review.
    let wt;
    try {
      wt = await this.deps.worktree.createDetached(
        session.repoPath,
        session.branch!,
        git.headSha!,
        criticSessionId,
      );
    } catch (err) {
      console.warn(`[review] worktree failed for ${session.id}:`, err);
      return;
    }

    const { patchId, baseSha, files, skipped } = await this.rebaseSkip(
      session,
      git,
      prior,
      wt.worktreePath,
      force,
    );
    if (skipped) return;
    // The base the critic diffs against == the base the fingerprint (and file set) used —
    // a concrete SHA captured from the fresh fetch, so already-merged main commits never fold
    // into the review. `?? session.baseBranch` is the ONLY genuine fallback: a total git
    // failure left baseSha null, so we degrade to the local base ref (today's behavior).
    const diffBase = baseSha ?? session.baseBranch;

    // Notes are fetched lazily (only a re-review under auto-address needs them) so a first
    // review / critic-only repo stays fully synchronous up to the spawn — the await below is
    // never reached when `wantNotes` is false, so it doesn't suspend.
    const wantNotes =
      !!prior?.findings?.length &&
      this.deps.store.getRepoConfig(session.repoPath).autoAddressEnabled;
    const { seenNoteIds, authorNotes } = wantNotes
      ? await this.gatherAuthorNotes(session, git, prior)
      : { seenNoteIds: prior?.seenNoteIds ?? [], authorNotes: [] as string[] };

    // Pre-inject the originating issue's body as UNTRUSTED critic context (the critic has no
    // gh/network — the sandbox stays airtight). Best-effort: a missing issue / forge / getIssue
    // must never block or throw the review, so any failure degrades to no issue context. This
    // sits BEFORE the `starting` re-check so that re-check stays the LAST await-gated step before
    // the spawn and covers this getIssue suspension too (matches plan-gate.ts's ordering).
    const issueBody = await this.fetchIssueBody(session);

    // Epic child (#1757): the base is the epic INTEGRATION branch, and this branch was never
    // rebased onto it — so the checked-out tree is missing every sibling that merged since the
    // fork, and the critic's "grep the tree to confirm it exists" rule would report merged sibling
    // work as absent. Collect the base delta so the epic block can hand it the exact missing
    // surface (best-effort; null ⇒ the block tells it to run the commands itself).
    //
    // Placed HERE deliberately: after rebaseSkip (which resolves baseSha) and BESIDE fetchIssueBody
    // — i.e. still BEFORE the `starting` re-check below, so that re-check remains the LAST
    // await-gated step before the spawn and covers this suspension too (same reasoning as the
    // issue-body fetch above).
    const epicBase = isEpicIntegrationBranch(session.baseBranch) ? session.baseBranch : null;
    const epic = await this.resolveEpicContext(epicBase, wt.worktreePath, baseSha);

    // forget() (session archived) may have fired during any await above (author-notes, issue-body
    // fetch, or the epic base-delta collection); it clears our `starting` claim as a tombstone.
    // Abort (reaping the worktree we allocated) before spawning so we don't run for — and re-post a
    // review + re-insert a verdict row for — a gone session.
    if (!this.starting.has(session.id)) {
      this.deps.worktree.remove(wt.worktreePath);
      return;
    }

    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    // Checked AFTER the worktree allocation + the post-await re-check so the worktree cleanup
    // here has wt.worktreePath — but BEFORE membrane/backend construction so we skip that work.
    const reviewerEnv = this.reviewerEnv();
    if (apiKeyFailClosed(reviewerEnv.provider)) {
      console.warn(
        "[review] api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)",
      );
      this.deps.worktree.remove(wt.worktreePath);
      return;
    }
    // Read the approved plan LAST — a synchronous local-file read (no await, so it does NOT touch
    // the "last await-gated step before spawn" invariant that fixes the issue-body / epic-delta
    // fetches above). Placed AFTER the rebaseSkip churn-skip, the tombstone re-check, and the
    // api-key fail-closed early returns, so none of those common/early exits wastes a read. Read
    // from session.worktreePath (the LIVE tree) — NOT wt.worktreePath (the critic's detached head
    // checkout), where the git-excluded plan can never exist. Best-effort: null ⇒ no plan context.
    const plan = this.readPlan(session.worktreePath);
    // #1824 finding C: per-repo POSSIBLE-SMELLS lens flag (default OFF). Read here (not cached from
    // the criticEnabled gate above) so a toggle mid-session takes effect on the next review round.
    const smellLens = this.deps.store.getRepoConfig(session.repoPath).criticSmellLensEnabled;
    const { argv } = this.criticArgv(
      session,
      diffBase,
      prior?.findings ?? [],
      authorNotes,
      issueBody,
      reviewerEnv,
      epic,
      plan,
      smellLens,
      criticSessionId,
    );
    // Fire plugin onSpawn hooks for this reviewer-style spawn (issue #1205) and bind any patched
    // env THROUGH the membrane (apiKeyPassthroughEnv handled inside). A hook that calls abortSpawn
    // cleanly skips the review (worktree reaped), mirroring the spawn-failure path below.
    const aux = await resolveAuxSpawn({
      argv,
      worktreePath: wt.worktreePath,
      repoPath: session.repoPath,
      worktree: this.deps.worktree,
      seams: this.deps,
      descriptor: {
        sessionId: criticSessionId,
        kind: "review",
        parentSessionId: session.id,
        model: reviewerEnv.model,
      },
    });
    if ("aborted" in aux) {
      console.warn(`[review] onSpawn aborted for ${session.id}: ${aux.aborted.reason}`);
      this.deps.worktree.remove(wt.worktreePath);
      // Surface WHY instead of failing silently: an onSpawn abort (e.g. the claude-swap pool has
      // no usable account) becomes a visible `error` verdict carrying the reason, so the badge
      // reads "REVIEW ERR: <reason>" rather than a generic failure or a misleading "critic did not
      // produce a verdict". Self-heals — the next consider() that lands a real verdict overwrites it.
      this.publishSpawnAbort(session, git, aux.aborted.reason, prior);
      return;
    }
    // The worktree is checked out at the UNTRUSTED PR head; a malicious PR could commit a strict-JSON
    // verdict / `-o` fallback to short-circuit the real critic (see scrubStaleVerdictArtifacts).
    // Scrub HERE — after rebaseSkip, which can re-materialize a committed artifact — right before spawn.
    scrubStaleVerdictArtifacts(wt.worktreePath, VERDICT_FILE);
    let terminalId: string;
    try {
      terminalId = (
        await this.deps.herdr.start(
          `review ${session.desig}`,
          wt.worktreePath,
          aux.wrapped,
          aux.spawnEnv,
        )
      ).terminalId;
    } catch (err) {
      console.warn(`[review] spawn failed for ${session.id}:`, err);
      this.deps.worktree.remove(wt.worktreePath);
      return;
    }
    this.inflight.set(session.id, {
      sessionId: session.id,
      headSha: git.headSha!,
      patchId,
      baseSha,
      files,
      epicBase,
      prNumber: git.number!,
      branch: session.branch!,
      repoPath: session.repoPath,
      worktreePath: wt.worktreePath,
      terminalId,
      criticSessionId,
      reviewerProvider: reviewerEnv.provider,
      reviewerModel: reviewerEnv.model,
      reviewerEffort: reviewerEnv.effort ?? null,
      startedAt: this.now(),
      ...priorStreakState(prior),
      seenNoteIds,
    });
    // Persist the spawn row now (totals NULL until finalize) so review burn is attributable
    // even if the run crashes/times out before producing a verdict (issue #502).
    this.deps.store.recordReviewerSpawn({
      reviewerSessionId: criticSessionId,
      taskSessionId: session.id,
      kind: "review",
      worktreePath: wt.worktreePath,
      reviewerProvider: reviewerEnv.provider,
      model: reviewerEnv.model,
      reviewerEffort: reviewerEnv.effort ?? null,
      spawnedAt: this.now(),
    });
    this.deps.onReviewing?.(session.id, true, {
      provider: reviewerEnv.provider,
      model: reviewerEnv.model,
      effort: reviewerEnv.effort ?? null,
    });
  }

  /**
   * Reset the prior review verdict's escalation counters WITHOUT re-triggering a review.
   * Used by the "dismiss" quota action so the block clears on the next poll tick without
   * spawning a new critic run. Only acts when a prior verdict row exists.
   */
  clearStallState(session: Session): void {
    const prior = this.deps.store.getReview(session.id);
    if (!prior) return;
    const reset: typeof prior = {
      ...prior,
      addressRound: 0,
      finalRoundPending: false,
      streakReviews: 0,
      errorRound: 0,
      reviewedPatchIds: [],
      // Operator took over: the rework classification (REWORK RUNNING / banner / rundown) stops
      // counting this verdict as active rework even though decision stays changes_requested, and
      // attachReviewPush skips the emit below so the takeover doesn't re-notify.
      dismissed: true,
    };
    this.deps.store.putReview(reset);
    this.deps.onChange(session.id, reset);
  }

  /** Operator-initiated (re)start of a critic review for `session`, bypassing the auto path's
   *  same-head dedup, spawn ceiling, and patch-id churn-skip. Aborts a hung in-flight run first. */
  async forceReview(session: Session, git: GitState): Promise<ReviewOutcome> {
    // 1. mid-spawn window: can't safely abort begin()'s async fetch; operator retries.
    if (this.starting.has(session.id)) return "skipped";
    // 2. in-flight: abort it, but NOT if tick()'s finalize() already owns the teardown+verdict.
    const f = this.inflight.get(session.id);
    if (f) {
      if (f.finalizing) return "skipped";
      await reapRun(this.deps.herdr, this.deps.worktree, f.terminalId, f.worktreePath);
      this.deps.onReviewing?.(session.id, false);
      this.inflight.delete(session.id);
    }
    // 3. escalation/streak HYGIENE on the prior verdict (NOT the re-trigger lever — rebaseSkip's
    //    force bypass is): reset errorRound so finalize() doesn't immediately re-fire the
    //    consecutive-error stall signal, reset the streak so the next AUTO consider() re-engages
    //    instead of re-hitting the ceiling, and reset the auto-address streak (addressRound /
    //    finalRoundPending) so a session stalled at the address cap gets a fresh budget — forcing a
    //    review implies "try again". Preserve outstanding-work state the critic must re-verify
    //    (findings, body, headSha, etc.).
    //
    //    Deliberately NO onChange here — the reset is hygiene before the real re-review; emitting
    //    a zeroed-counter row now would flicker the badge to "clean" before the verdict lands.
    //    onChange fires once when finalize() persists the real verdict via consider().
    const priorForReset = this.deps.store.getReview(session.id);
    if (priorForReset) {
      this.deps.store.putReview({
        ...priorForReset,
        errorRound: 0,
        streakReviews: 0,
        reviewedPatchIds: [],
        addressRound: 0,
        finalRoundPending: false,
        // Forcing a fresh review re-engages active rework — clear any prior dismiss so the
        // re-reviewed verdict classifies normally.
        dismissed: false,
      });
    }
    // 4. one code path:
    return this.consider(session, git, { force: true });
  }

  /**
   * Rebase-skip: dedup on WHAT the critic reviews (the branch diff `base...HEAD`), not on
   * the head SHA. A rebase/force-push moves the SHA but leaves the branch's own diff
   * identical, so its patch-id is stable (patch-id ignores line numbers — robust to the new
   * base shifting hunks). Skip when the incoming fingerprint is a member of the streak's
   * reviewed-patch-id SET — the prior verdict's own patchId OR any earlier id in
   * `reviewedPatchIds` (churn/revert: a diff bounced back to a state already reviewed this
   * streak must not be re-reviewed). On a match the prior verdict still holds: re-point it at
   * the new head (so consider()'s SHA guard short-circuits next poll), reap the probe
   * worktree, and skip the run — deliberately preserving findings/decision/rounds (those
   * still apply, and we must not double-post). Empty/failed fingerprint ('' or null) → never
   * skip; review. Returns the fingerprint (persisted on the verdict) + whether we skipped.
   *
   * Keep the `prior.patchId === patchId` OR-branch alongside set-membership: a clean verdict
   * resets `reviewedPatchIds` to [] (but keeps its patchId), and every migrated DB row
   * backfills the set to '[]' — set-membership alone would lose the rebase-skip for both on a
   * same-diff force-push. The clean-reset also means a diff that was clean then reverted to an
   * earlier buggy state IS reviewed again (its id is no longer in the now-empty set).
   *
   * Never skip past an `error` verdict: a timeout/unparseable run produced no real verdict,
   * so its decision is a transient failure to RETRY, not a result to preserve — inheriting it
   * across an identical-diff rebase would freeze the PR on a stale error. (Defensive even
   * though buildVerdict no longer fingerprints error verdicts: this also covers error rows
   * persisted before that change.)
   */
  private async rebaseSkip(
    session: Session,
    git: GitState,
    prior: ReviewVerdict | null,
    worktreePath: string,
    force: boolean,
  ): Promise<{ patchId: string; baseSha: string | null; files: string[]; skipped: boolean }> {
    // Threads the fresh base SHA + changed-file set through alongside the fingerprint (all from
    // ONE computePatchId resolution) so the critic prompt and the buildVerdict backstop key off
    // the same base the skip decision did. The fingerprint is always computed; only the skip
    // short-circuit is suppressed under `force` — this is the lever that makes an operator's
    // manual re-review of an unchanged head actually RUN. `shouldSkipForPatchId` matches via its
    // `prior.patchId === patchId` OR-branch for any non-error prior, so clearing reviewedPatchIds
    // alone would not prevent the skip; bypassing the decision under force is what works.
    const res = await this.computePatchId(worktreePath, session.baseBranch);
    const { baseSha, files } = res;
    const patchId = res.patchId ?? "";
    if (!force && shouldSkipForPatchId(prior, patchId)) {
      this.deps.store.bumpReviewHead(session.id, git.headSha!, this.now());
      this.deps.worktree.remove(worktreePath);
      return { patchId, baseSha, files, skipped: true };
    }
    return { patchId, baseSha, files, skipped: false };
  }

  /**
   * Pull the author's PR notes for a re-review so a justified decline isn't blindly
   * re-raised (caller gates this on a prior-with-findings under auto-address).
   *
   * Inject only notes NOT already shown to the critic on an earlier round (tracked by comment
   * id, carried on the prior verdict): each note responded to one round's findings, so
   * re-feeding every marked comment every round would grow the prompt unboundedly and
   * resurrect stale justifications. Id-based — never timestamp-based: the host clock and
   * GitHub's comment clock can skew and drop a valid decline. Returns the per-round seen-note
   * set to carry forward plus the note bodies for the critic prompt.
   */
  private async gatherAuthorNotes(
    session: Session,
    git: GitState,
    prior: ReviewVerdict | null,
  ): Promise<{ seenNoteIds: string[]; authorNotes: string[] }> {
    const priorSeenNoteIds = prior?.seenNoteIds ?? [];
    const fresh = await this.fetchAuthorNotes(session.repoPath, git.number!, priorSeenNoteIds);
    return { seenNoteIds: [...priorSeenNoteIds, ...fresh.ids], authorNotes: fresh.notes };
  }

  /** Build the read-only critic's argv — deliberately NOT --dangerously-skip-permissions. It
   *  inspects an UNTRUSTED PR diff, so a prompt-injection hidden in that diff must not be able
   *  to run commands or escape its worktree. `dontAsk` auto-denies anything off the allowlist
   *  (an unattended PTY would otherwise hang on a permission prompt); the allowlist is
   *  read-only inspection + read-only git + writing files in its own disposable worktree. */
  private criticArgv(
    session: Session,
    diffBase: string,
    priorFindings: string[],
    authorNotes: string[],
    issueBody: string | null,
    env: RoleEnvironment,
    epic: EpicContext | null,
    plan: string | null,
    smellLens: boolean,
    sessionId: string,
  ): { argv: string[]; sessionId: string } {
    // Shared with the plan reviewer: same read-only injection-contained sandbox (the PR diff is
    // UNTRUSTED). The prompt is the only critic-specific part. `diffBase` is the resolved base
    // commit (SHA) threaded from rebaseSkip, NOT session.baseBranch — so the review diffs the
    // identical fresh base the fingerprint used (no stale-local-main fold-in). `issueBody` is the
    // originating issue's body, fetched in begin() and injected as UNTRUSTED context. `epic` is
    // non-null only for an epic child (#1757) — it adds the EPIC CONTEXT block; a non-epic review's
    // prompt is byte-identical to before.
    return buildTransientAgentArgv("reviewer", {
      provider: env.provider,
      model: env.model,
      effort: env.effort,
      // #1812 finding A: the approved plan rides as UNTRUSTED intent-context (augmenting the task).
      // The SCOPE-CREEP lens (finding B) is emitted by reviewPrompt itself (the session critic always
      // has a task); prReviewPrompt omits it, so the standalone-critic prompt stays byte-identical.
      // #1824 finding C: `smellLens` (per-repo flag, default OFF) appends the POSSIBLE-SMELLS lens.
      // Absent plan + no epic + smellLens off ⇒ the non-epic session-critic prompt is unchanged.
      prompt: reviewPrompt(diffBase, session.prompt, priorFindings, authorNotes, issueBody, epic, {
        plan,
        smellLens,
      }),
      // The critic READS the `-o` last-message fallback (per-spawn name for its untrusted checkout).
      captureLastMessage: true,
      // Pre-minted in begin() so it also keys the disposable worktree path (A0, #1816).
      sessionId,
    });
  }

  private reviewerEnv(): RoleEnvironment {
    return this.deps.env?.() ?? { provider: "claude", model: null, effort: null };
  }

  /** Epic-child critic context (#1757), or null for an ordinary session. Collects the sibling work
   *  the child's tree is missing so the epic block can hand the critic the exact missing surface
   *  rather than relying on it to enumerate that itself. Best-effort: a null `baseSha` (the base
   *  fetch failed — an epic branch usually has no local ref) means no base command could work, so
   *  we don't shell out at all and the block degrades to its no-base mode. */
  private async resolveEpicContext(
    epicBase: string | null,
    worktreePath: string,
    baseSha: string | null,
  ): Promise<EpicContext | null> {
    if (!epicBase) return null;
    return {
      base: epicBase,
      baseSha,
      delta: baseSha ? await this.collectBaseDelta(worktreePath, baseSha) : null,
    };
  }

  /** Best-effort fetch of the originating issue's body for UNTRUSTED reviewer context.
   *  Never throws/blocks the review: missing issue / no forge / fetch error ⇒ null. */
  private async fetchIssueBody(session: Session): Promise<string | null> {
    if (session.issueNumber == null) return null;
    try {
      return (
        (await this.deps.resolveForge(session.repoPath)?.getIssue?.(session.issueNumber))?.body ??
        null
      );
    } catch (err) {
      // Log only the message, not the raw error: getIssue shells `gh`, whose error object
      // can carry request/response detail we don't want in logs.
      console.warn(
        `[review] getIssue failed for ${session.id}: ${(err as Error)?.message ?? String(err)}`,
      );
      return null;
    }
  }

  /** Read the author's marked decline notes back off the PR, restricted to comments not
   *  already fed to the critic on an earlier round (`seenIds`). Returns the stripped note
   *  bodies and the ids that backed them (so the caller can mark them seen). Best-effort:
   *  empty on any failure, on a host without a comments API, or when nothing new is marked.
   *  The marker is stripped so only the author's reasoning reaches the critic prompt. */
  private async fetchAuthorNotes(
    repoPath: string,
    prNumber: number,
    seenIds: string[],
  ): Promise<{ notes: string[]; ids: string[] }> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge?.listPrComments) return { notes: [], ids: [] };
    try {
      const seen = new Set(seenIds);
      const comments = await forge.listPrComments(prNumber);
      const notes: string[] = [];
      const ids: string[] = [];
      for (const c of comments) {
        if (!c.body.includes(AUTHOR_RESPONSE_MARKER)) continue;
        if (c.id && seen.has(c.id)) continue; // already shown on an earlier round
        const note = c.body.split(AUTHOR_RESPONSE_MARKER).join("").trim();
        if (!note) continue;
        notes.push(note);
        if (c.id) ids.push(c.id); // id-less hosts: note still injected, just not deduped
      }
      return { notes, ids };
    } catch (err) {
      console.warn(`[review] listPrComments failed for ${repoPath}#${prNumber}:`, err);
      return { notes: [], ids: [] };
    }
  }

  /** Finalize any in-flight review whose verdict file is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue; // already being finalized by an overlapping tick
      f.finalizing = true; // claim BEFORE the first await — prevents a second overlapping tick
      // from passing the guard above while we await isSpawnAlive below and both ticks racing
      // to finalize the same entry (double-reap / double-putReview).
      let action: VerdictAction;
      let read: VerdictRead<RawVerdict>;
      try {
        // Pass the critic's per-spawn session id so the read reconstructs the unguessable `-o`
        // fallback name for THIS run — a PR can't pre-commit a matching file (see codex-last-message).
        read = this.readVerdict(f.worktreePath, f.criticSessionId);
        const elapsed = this.now() - f.startedAt;
        const timedOut = elapsed > this.timeoutMs;
        // Use ground-truth process liveness (paneForegroundProcs) rather than the transient
        // agentStatus field: a live critic between API turns reads "idle"/"done" but still has
        // claude/node-MainThread in its foreground — isSpawnAlive catches that and returns true
        // (alive → finished=false → wait), preventing premature finalize-null + reap.
        // isSpawnAlive never throws; any herdr error is caught internally → fail-closed alive.
        const finished = !(await isSpawnAlive(this.deps.herdr, f.worktreePath));
        // Same gate as RecapService.tick (shared decideVerdictAction): repaired verdict trusted
        // only once finished; unparseable fails fast; absent fails fast past boot grace.
        action = decideVerdictAction(read, finished, timedOut, elapsed > STARTUP_GRACE_MS);
      } catch (err) {
        // readVerdict or decideVerdictAction threw (isSpawnAlive itself never throws).
        // Release the flag so the next tick retries — otherwise f.finalizing stays true forever,
        // wedging the session's critic and leaking its worktree/terminal.
        f.finalizing = false;
        console.warn(`[review] liveness/read failed for ${f.sessionId}, retrying next tick:`, err);
        continue;
      }
      if (action === "wait") {
        f.finalizing = false; // release: not finalizing this tick
        // still running (or gated, awaiting completion) — surface what the critic is doing right
        // now. Emit every tick (not only on change) so a reloaded client repopulates within one
        // tick; the client dedups identical summaries to stay quiet.
        const summary = this.readActivity(f.worktreePath, f.criticSessionId, f.reviewerProvider);
        if (summary) this.deps.onActivity?.(f.sessionId, summary);
        continue;
      }
      const raw: RawVerdict | null =
        action === "finalize-value" && read.status === "parsed" ? read.value : null;
      // f.finalizing stays true; always drop the entry, even if finalize throws — otherwise it
      // stays `finalizing=true` and every later tick `continue`s past it, wedging the session's
      // critic forever (and leaking its worktree/terminal).
      try {
        await this.finalize(f, raw);
      } finally {
        this.inflight.delete(f.sessionId);
      }
    }
  }

  private async finalize(f: InFlight, raw: RawVerdict | null): Promise<void> {
    // Reap the critic terminal + disposable worktree no matter what happens above
    // (a forge/store/steer failure must not strand them).
    try {
      const verdict = this.buildVerdict(f, raw);
      // A verdict for a PR that's no longer open is moot. The real branch handles that inside
      // publishVerdict(); the error branch needs its own gate (finalizeErrorVerdict) since it
      // never reaches publishVerdict. When persist is false we skip persisting the verdict as
      // session review state — see below.
      let persist = true;
      if (verdict.decision === "error") {
        persist = await this.finalizeErrorVerdict(f, verdict);
      } else {
        // Per-streak review accounting — independent of publish/steer outcome and of
        // autoAddressEnabled (review token spend happens whether or not findings are steered).
        // A clean verdict (findings:[]) resets the streak; any findings-bearing verdict
        // increments it and appends this run's patch-id (deduped) to the churn-skip set.
        if (verdict.findings.length === 0) {
          verdict.streakReviews = 0;
          verdict.reviewedPatchIds = [];
        } else {
          verdict.streakReviews = f.priorStreakReviews + 1;
          verdict.reviewedPatchIds = [...new Set([...f.priorReviewedPatchIds, f.patchId])];
          // Escalate once, when the streak first reaches the ceiling (2*cap). `>=` with a
          // crossing guard (priorStreakReviews < ceiling) so a cap lowered between runs still
          // fires rather than being stepped over, while reviews past the ceiling don't
          // re-signal every tick (consider() bails before re-spawning anyway). Mirrors the
          // errorRound crossing-guard pattern below in the error path.
          const ceiling = 2 * this.cap;
          if (verdict.streakReviews >= ceiling && f.priorStreakReviews < ceiling) {
            this.deps.store.addSignal({
              repoPath: f.repoPath,
              sessionId: f.sessionId,
              kind: "stall",
              payload: `critic reviewed this PR ${verdict.streakReviews} times without reaching clean — auto-review paused; needs human attention`,
            });
          }
        }
        await this.publishVerdict(f, verdict);
      }
      // Skipped only for a moot post-merge error verdict (persist=false above): it must not
      // become the session's review state. captureUsage + the finally-reap below still run, so
      // the critic spawn's token cost is attributed and its terminal/worktree are reaped.
      if (persist) {
        this.deps.store.putReview(verdict);
        this.deps.onChange(f.sessionId, verdict);
      }
      // Persist the critic's token total for exact cost attribution (issue #502). Best-effort:
      // a missing/half-written transcript leaves the spawn row's totals null rather than
      // stranding finalize. The reviewer transcript lives under ~/.claude/projects (keyed by
      // worktree path) and survives the worktree removal in the `finally`, so reading it here
      // is safe. Individually guarded — a transcript-read failure must never strand finalize.
      await captureUsage(
        (wt, id) => this.readUsage(wt, id, f.reviewerProvider, f.reviewerModel),
        this.deps.store.completeReviewerSpawn.bind(this.deps.store),
        f.worktreePath,
        f.criticSessionId,
        this.now(),
        f.sessionId,
      );
    } finally {
      this.deps.onReviewing?.(f.sessionId, false);
      await reapRun(this.deps.herdr, this.deps.worktree, f.terminalId, f.worktreePath);
    }
  }

  /**
   * Bookkeeping for a transient critic *error* verdict (timeout / unparseable). Returns whether
   * the verdict should be persisted as session review state.
   *
   * Critic spawn and PR merge both fire on CI-green, so they race: the critic can finish AFTER
   * the merge is observable. An error on a PR that already merged/closed is moot — persisting it
   * would flip a not-yet-decommissioned session to a stale REVIEW ERR badge until archive, and
   * escalating it is noise (no merge left to gate). So suppress (return false) on a CONFIRMED
   * terminal state only; fail OPEN on an unconfirmable state (no forge / fetch threw) so a genuine
   * error on a still-open PR is never hidden by a failed recheck — at the cost of a residual
   * transient REVIEW ERR if the PR did merge but the recheck couldn't see it (logged so the field
   * cause is distinguishable; self-clears at archive).
   */
  private async finalizeErrorVerdict(f: InFlight, verdict: ReviewVerdict): Promise<boolean> {
    const live = await this.livePrState(f);
    if (live === "merged" || live === "closed") {
      console.warn(
        `[review] error verdict suppressed for ${f.sessionId}: PR ${live} before finalize (moot)`,
      );
      return false;
    }
    if (live === undefined)
      console.warn(
        `[review] error verdict kept for ${f.sessionId}: live PR state unconfirmable (fail-open) — may surface a transient REVIEW ERR if the PR already merged`,
      );
    // A transient critic failure posts nothing and has no findings to steer. Don't let it pose as
    // "clean": count it on a separate no-progress streak so a flapping critic still escalates
    // instead of looping forever, and preserve the findings round (those findings are still
    // outstanding, just un-reverified this push).
    verdict.errorRound = f.priorErrorRound + 1;
    verdict.addressRound = f.priorRound;
    // Error verdicts deliberately do NOT increment streakReviews: error-spawn token cost is
    // bounded by the separate errorRound counter + its own cap escalation, not by the spawn
    // ceiling. Preserve the streak's review count + reviewed-patch-id set so the ceiling math and
    // churn dedup stay correct across a transient failure (and the errored patch-id is NOT added —
    // mirrors patchId:"" so the same diff re-reviews).
    verdict.streakReviews = f.priorStreakReviews;
    verdict.reviewedPatchIds = f.priorReviewedPatchIds;
    // The critic never produced a verdict, so it didn't actually consider this run's freshly-
    // fetched notes — roll the seen set back so they re-inject next round instead of being
    // silently swallowed by an error pass.
    verdict.seenNoteIds = f.priorSeenNoteIds;
    // Escalate once, when the streak first reaches the cap. `>=` with a crossing guard (not
    // `=== cap`) so a cap lowered between runs still fires rather than being stepped over, while
    // errors past the cap don't re-signal every tick.
    if (verdict.errorRound >= this.cap && f.priorErrorRound < this.cap) {
      this.deps.store.addSignal({
        repoPath: f.repoPath,
        sessionId: f.sessionId,
        kind: "stall",
        payload: `critic produced ${verdict.errorRound} consecutive error verdicts for this PR — auto-address can't make progress`,
      });
    }
    return true;
  }

  /**
   * Live PR state for the at-finalize recheck. `undefined` when it can't be confirmed (no forge,
   * or the forge throws) — callers treat that as "unconfirmable" and decide their own fail mode.
   * Mirrors the fetch publishVerdict() does for real verdicts; the error branch uses it too so a
   * transient critic error finishing AFTER the merge isn't persisted as a stale REVIEW ERR.
   */
  private async livePrState(f: InFlight): Promise<PrStatus["state"] | undefined> {
    const forge = this.deps.resolveForge(f.repoPath);
    if (!forge) return undefined;
    try {
      return (await forge.prStatus(f.branch))?.state;
    } catch (err) {
      console.warn(`[review] PR-state recheck failed for ${f.sessionId}:`, err);
      return undefined;
    }
  }

  /**
   * Emit a real verdict's outward effects, branching on the PR's LIVE state. Critic spawn and
   * PR merge both fire on CI-green, so they race by construction: the critic can finish AFTER
   * the PR merged/closed. Live fetch (not the cached snapshot — the 120s poll can lag the merge).
   *  - open   → full effects: post the review, steer findings to the agent, record the critic
   *             signal, set finalRoundPending. (Unchanged.)
   *  - merged → the critic lost the race. We can't request-changes on a merged PR, so when there
   *             are findings we record them as a best-effort post-merge ISSUE COMMENT (for a
   *             human follow-up), then RETURN — no auto-address / signal (the merge is done;
   *             steering findings about merged code is noise). A clean verdict stays silent.
   *  - closed (unmerged) → moot (the code won't land) → stay silent.
   * Fail-closed: if we can't confirm the state (no forge / forge throws / unexpected state) we
   * emit nothing. The verdict row itself is still persisted by the caller.
   */
  private async publishVerdict(f: InFlight, verdict: ReviewVerdict): Promise<void> {
    const forge = this.deps.resolveForge(f.repoPath);
    let state: PrStatus["state"] | undefined;
    try {
      state = (await forge?.prStatus(f.branch))?.state;
    } catch (err) {
      console.warn(`[review] PR-state recheck failed for ${f.sessionId}:`, err);
    }
    if (!forge) return; // no forge → can't confirm anything, emit nothing
    if (state === "merged") {
      // Critic finished after the PR merged: record findings (if any) as a post-merge comment so
      // they aren't silently dropped, then stop — there's no merge left to gate (#596 gap a).
      if (verdict.findings.length > 0 && forge.comment) {
        try {
          await forge.comment(
            f.prNumber,
            `_Critic review completed after this PR merged — recording the findings here for a follow-up._\n\n${verdict.body}\n\n${CRITIC_REVIEW_MARKER}`,
          );
        } catch (err) {
          console.warn(`[review] post-merge comment failed for ${f.sessionId}:`, err);
        }
      }
      return; // no auto-address / signal: the PR is gone, addressRound/finalRoundPending keep their buildVerdict defaults
    }
    if (state !== "open") return; // closed-unmerged (or unconfirmable) → moot, emit nothing
    try {
      const event = verdict.decision === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
      const { url } = await forge.postReview(f.prNumber, {
        event,
        body: `${verdict.body}\n\n${CRITIC_REVIEW_MARKER}`,
      });
      verdict.url = url;
    } catch (err) {
      console.warn(`[review] postReview failed for ${f.sessionId}:`, err);
    }
    verdict.addressRound = await this.runAutoAddress(f, verdict); // reached only when the PR is open
    // The cap-th steer was just delivered when the round ADVANCES into the cap
    // (priorRound < cap → addressRound === cap). The agent is now addressing that
    // final round → dimmed FINAL badge, not orange. A round HELD at the cap
    // (addressRound === priorRound) means that final round already failed re-review
    // → confirmed stall. A moot/closed PR returns above before this, leaving the
    // buildVerdict default false. Error verdicts hold the round, so they stay false too.
    verdict.finalRoundPending =
      verdict.findings.length > 0 &&
      verdict.addressRound >= this.cap &&
      verdict.addressRound > f.priorRound;
    if (verdict.decision === "changes_requested") {
      this.deps.store.addSignal({
        repoPath: f.repoPath,
        sessionId: f.sessionId,
        kind: "critic",
        payload: `${verdict.summary}\n\n${verdict.body}`,
      });
    }
  }

  /**
   * Close the loop: feed the verdict's findings back to the task agent and return the
   * new streak round. Only real (non-error) verdicts reach here — error verdicts are
   * counted on the separate no-progress streak in finalize(). Empty findings = clean
   * (e.g. a "comment" verdict with nothing left to fix) → reset to 0. Otherwise, if auto-address
   * is enabled and the prior round is under the cap, steer once and advance — but only
   * if the steer actually reached the agent (a dead/unreachable pane holds the round).
   * At/over the cap we stop steering and leave the round in place; the posted review,
   * the stalled badge, and (for blocking verdicts) the critic signal escalate it.
   */
  private async runAutoAddress(f: InFlight, verdict: ReviewVerdict): Promise<number> {
    if (verdict.findings.length === 0) return 0; // clean → streak resets
    const enabled =
      !!this.deps.autoAddress && this.deps.store.getRepoConfig(f.repoPath).autoAddressEnabled;
    // Loop off (never on, or toggled off mid-streak) → clear the streak so the badge
    // doesn't keep showing a stale "round N/3" for a loop that's no longer running.
    if (!enabled) return 0;
    // Note: a fresh, unrelated finding introduced on a later push still counts toward
    // this streak rather than resetting — the cap bounds total agent churn per PR, which
    // is fine for the prototype. Revisit if per-issue rounds become the intended model.
    if (f.priorRound >= this.cap) return f.priorRound; // gave up → hold (stalled badge persists)
    // The PR's still-open check lives in publishVerdict() (it also gates postReview + the
    // critic signal), so reaching here already means the PR is open — just steer.
    // autoAddress (SessionService.reply) liveness-checks the pane and resolves false for a
    // dead one, so a steer that can't land normally reports false. A rejection is now only a
    // narrow race — the pane dies between the liveness check and herdr.send — and still
    // counts as not-delivered: the round must not advance on a steer that never landed,
    // and the rejection must not strand finalize().
    let delivered = false;
    try {
      delivered = await this.deps.autoAddress!(
        f.sessionId,
        steerText(verdict.findings, f.prNumber, f.epicBase),
      );
    } catch (err) {
      console.warn(`[review] auto-address steer failed for ${f.sessionId}:`, err);
    }
    return delivered ? f.priorRound + 1 : f.priorRound; // no progress if it didn't land
  }

  /** Assemble the full session verdict from buildVerdictCore (the pure normalize + scope
   *  backstop + summary-fallback, now shared with the standalone PR critic in ./critic-core)
   *  plus the session-specific streak/note fields. The core decides decision/summary/body/
   *  findings/patchId byte-identically to before; this method only stamps on the per-session
   *  bookkeeping (finalize() overwrites the streak/error/round fields for the non-clean paths). */
  private buildVerdict(f: InFlight, raw: RawVerdict | null): ReviewVerdict {
    const core = buildVerdictCore(raw, f.baseSha, f.files, f.patchId, f.sessionId);
    return {
      sessionId: f.sessionId,
      headSha: f.headSha,
      // Fingerprint of this run's diff; a later identical head skips re-review. NOT recorded
      // for an error verdict (timeout/unparseable): that's a transient failure to retry, so a
      // content-identical rebase must re-review rather than inherit the stale error.
      patchId: core.patchId,
      decision: core.decision,
      summary: core.summary,
      body: core.body,
      findings: core.findings,
      addressRound: 0, // publishVerdict() overwrites with the streak round (finalize()'s error path holds priorRound)
      addressCap: this.cap, // surface the live cap so the UI badge need not mirror it
      // streakReviews increments on ANY finalized verdict with findings (regardless of
      // publish/steer outcome) and resets on clean — finalize() overwrites for findings/error;
      // a clean (findings:[]) verdict keeps this 0 reset. reviewedPatchIds tracks the churn/
      // revert dedup set: clean → [] (set above), findings → dedup append, error → preserve;
      // finalize() overwrites for the non-clean branches.
      streakReviews: 0,
      reviewedPatchIds: [],
      errorRound: 0, // finalize() overwrites on an error verdict
      finalRoundPending: false, // finalize() sets this on a real verdict
      finalRoundTimeoutMs: DEFAULT_FINAL_ROUND_TIMEOUT_MS, // live escalation timeout
      seenNoteIds: f.seenNoteIds, // carry the per-round note dedup set forward
      updatedAt: this.now(),
    };
  }

  /**
   * Persist an onSpawn-abort (the critic never spawned — e.g. the claude-swap pool had no usable
   * account) as a visible `error` verdict carrying the abort reason. The row is flagged
   * `spawnAborted` so consider()'s same-head dedup re-attempts it (the head was never reviewed) —
   * which means consider() reaches here again every poll while the pool stays cold; the (headSha,
   * reason) dedup below keeps that from churning putReview/onChange every tick. The verdict is
   * intentionally NOT findings-bearing (findings:[]) and preserves the prior streak/error counters,
   * so an abort neither trips the spawn ceiling nor escalates the consecutive-error stall — it is a
   * pre-spawn refusal, not a finished critic run.
   */
  private publishSpawnAbort(
    session: Session,
    git: GitState,
    reason: string,
    prior: ReviewVerdict | null,
  ): void {
    const summary = reason.slice(0, 100);
    if (
      prior?.decision === "error" &&
      prior.headSha === git.headSha! &&
      prior.summary === summary
    ) {
      return; // already surfaced for this head — no churn
    }
    const verdict: ReviewVerdict = {
      sessionId: session.id,
      headSha: git.headSha!,
      patchId: "", // transient: a later identical head must re-attempt, not inherit this abort
      decision: "error",
      summary,
      body: "",
      findings: [],
      addressRound: prior?.addressRound ?? 0,
      addressCap: this.cap,
      streakReviews: prior?.streakReviews ?? 0,
      reviewedPatchIds: prior?.reviewedPatchIds ?? [],
      errorRound: prior?.errorRound ?? 0,
      finalRoundPending: prior?.finalRoundPending ?? false,
      finalRoundTimeoutMs: prior?.finalRoundTimeoutMs ?? DEFAULT_FINAL_ROUND_TIMEOUT_MS,
      seenNoteIds: prior?.seenNoteIds ?? [],
      spawnAborted: true, // exempt from the same-head dedup → auto path re-attempts when the pool warms
      updatedAt: this.now(),
    };
    this.deps.store.putReview(verdict);
    this.deps.onChange(session.id, verdict);
  }

  /** Find a live herdr agent that was spawned for a review run, resolved by NAME first
   *  ("review TASK-<n>"), falling back to the worktree cwd. ONE `list()` call per
   *  invocation. An empty/falsy `label` (session gone) skips the name match entirely —
   *  an unnamed agent (name="") would otherwise match every gone-session lookup and
   *  close an unrelated agent. Returns undefined when no live agent matches. */
  private findSquatter(label: string, cwd: string): HerdrAgent | undefined {
    const agents = this.deps.herdr.list();
    const byName = label ? agents.find((a) => a.name === label) : undefined;
    return byName ?? agents.find((a) => a.cwd === cwd);
  }

  /** Boot reconcile: close dangling `reviewer_spawns` rows from the last run and kill
   *  any still-alive orphaned critic processes.
   *
   *  An "orphan" is a review that was in flight when the server last restarted. Because
   *  `inflight` is in-memory only, tick() never finalizes it; the still-alive `claude`
   *  holds the stable herdr name "review TASK-<n>", and the next consider() for that
   *  session collides with `agent_name_taken`. This sweep detects and reaps them.
   *
   *  The orphan SIGNAL is the surviving disposable worktree — finalize() always removes
   *  it, so a present worktree means finalize() NEVER ran (i.e., a true restart-orphan).
   *  A row whose worktree is already gone (finalize ran but captureUsage's `if (usage)`
   *  guard left the row uncompleted) is NOT an orphan: it's a completed-but-unclosed row.
   *  We close those too (step a), but we do NOT reap/drop/re-kick them — preserving any
   *  genuine-timeout `error` verdict's errorRound/streak escalation accounting.
   *
   *  Returns the taskSessionIds that should be re-kicked by the caller (index.ts wiring
   *  in a separate task). Logs a one-line summary of what was reaped. */
  async reapOrphans(): Promise<string[]> {
    const reKick: string[] = [];
    let danglingClosed = 0;
    let orphansReaped = 0;

    for (const row of this.deps.store.listReviewerSpawns()) {
      // Only handle uncompleted review rows; plan_gate/recap/rundown are handled elsewhere.
      if (row.kind !== "review" || row.completedAt != null) continue;
      // Defensive: if already tracked in-memory (shouldn't be at boot, but guard anyway).
      if (this.inflight.has(row.taskSessionId) || this.starting.has(row.taskSessionId)) continue;

      // Wrap the entire row body so one bad row cannot abort the sweep.
      try {
        const result = await this.reapOneOrphanRow(row);
        if (result.kind === "dangling") {
          danglingClosed++;
        } else if (result.kind === "orphan") {
          orphansReaped++;
          if (result.reKickId) reKick.push(result.reKickId);
        }
      } catch (err) {
        console.warn(`[review] reapOrphans: error processing row ${row.reviewerSessionId}:`, err);
      }
    }

    console.warn(
      `[review] reapOrphans: ${orphansReaped} orphan(s) reaped, ${danglingClosed} dangling row(s) closed`,
    );
    return reKick;
  }

  /** Process a single uncompleted reviewer_spawns row during the boot orphan sweep.
   *  Returns `{ kind: "dangling" }` for rows whose worktree is already gone (finalize ran),
   *  or `{ kind: "orphan", reKickId }` for true restart-orphans (worktree still present).
   *  Always closes the DB row first. Never throws — caller's try/catch scopes the error. */
  private async reapOneOrphanRow(
    row: ReviewerSpawnRow,
  ): Promise<{ kind: "dangling" } | { kind: "orphan"; reKickId: string | null }> {
    // a. Always close the dangling row first — read real usage when available, else NULL (so the
    //    row is never re-listed every boot). This is ONE unconditional completion, avoiding
    //    captureUsage's `if (usage)` double-complete trap. null (an unresolved Codex rollout) books
    //    NULL token columns (unknown, backfillable), NOT 0 — 0 is reserved for a resolved-but-empty
    //    transcript (issue #1816).
    const usage = await this.readUsage(
      row.worktreePath,
      row.reviewerSessionId,
      row.reviewerProvider,
      row.model,
    ).catch(() => null);
    this.deps.store.completeReviewerSpawn(row.reviewerSessionId, usage, this.now());

    // b. Worktree gone → finalize already ran; just a dangling completion row.
    //    Do NOT reap/drop/re-kick — preserves genuine-timeout error verdict accounting.
    if (!this.worktreeExists(row.worktreePath)) {
      return { kind: "dangling" };
    }

    // c. True orphan: the disposable worktree still exists → finalize never ran.
    const s = this.deps.store.get(row.taskSessionId);
    // Free the name AND kill the still-alive claude process by closing its herdr tab.
    // Resolve by NAME first ("review TASK-<n>"), fall back to cwd only as a safety net
    // (avoids a second list() call for the name-absent case when the session is gone).
    const squatter = this.findSquatter(s ? `review ${s.desig}` : "", row.worktreePath);
    if (squatter) await this.deps.herdr.closeTab(squatter.tabId);
    // Remove the worktree AFTER freeing the name so the herdr slot is open before
    // the worktree is gone (mirrors plan-gate's ordering invariant).
    this.deps.worktree.remove(row.worktreePath);

    // Re-engage only when the session is still present — a gone session needs no kick.
    if (!s) return { kind: "orphan", reKickId: null };

    // An error verdict carries no findings — drop it so the next run starts fresh
    // without a sticky REVIEW ERR badge (and so the re-kick's plain consider() isn't head-deduped).
    // Non-error verdicts are left intact: the re-kick re-reviews them under normal rules (on a moved
    // head, within the spawn ceiling), which preserves their streak accounting — no dropReview reset.
    if (this.deps.store.getReview(row.taskSessionId)?.decision === "error") {
      this.deps.store.dropReview(row.taskSessionId);
    }
    return { kind: "orphan", reKickId: row.taskSessionId };
  }

  snapshot(): Record<string, ReviewVerdict> {
    return this.deps.store.snapshotReviews();
  }

  /** Session ids with a critic run currently in flight (for client bootstrap). */
  reviewingIds(): string[] {
    return [...this.inflight.keys()];
  }

  /** In-flight critic reviews with the exact environment captured for each spawn. */
  reviewingInflight(): Array<{ id: string } & ReviewerEnv> {
    return [...this.inflight.values()].map((f) => ({
      id: f.sessionId,
      provider: f.reviewerProvider,
      model: f.reviewerModel,
      effort: f.reviewerEffort,
    }));
  }

  /** Worktree paths of critic runs currently owned in-memory — the GC sweep must spare
   *  these (a re-adopted #631 orphan's tick() still needs its worktree). */
  inflightWorktrees(): string[] {
    return [...this.inflight.values()].map((f) => f.worktreePath);
  }

  forget(sessionId: string): void {
    // Clear any mid-spawn claim: a begin() suspended in either gh fetch (author-notes or
    // issue-body) checks this on resume and aborts, so an archived session can't get a critic
    // run after forget().
    this.starting.delete(sessionId);
    const f = this.inflight.get(sessionId);
    if (f) {
      void this.deps.herdr.stop(f.terminalId).catch(() => {});
      this.deps.worktree.remove(f.worktreePath);
      this.inflight.delete(sessionId);
      this.deps.onReviewing?.(sessionId, false);
    }
    this.deps.store.dropReview(sessionId);
  }
}

/** Latest meaningful tool-use summary from the critic's JSONL transcript (its claude
 *  session id forces a predictable path under the disposable worktree). null when the
 *  transcript is missing or has no parseable activity yet. */
function defaultReadActivity(
  worktreePath: string,
  criticSessionId: string,
  provider: AgentProvider | null,
  codexResolver: CodexRolloutResolver,
): string | null {
  if (provider === "codex") {
    // Codex writes no ~/.claude/projects JSONL; resolve its rollout (by launch-unique cwd, A0) and
    // read the same activity signal from there. Unresolved → null (backoff retries next tick).
    const hit = codexResolver.resolve({
      trackingId: criticSessionId,
      worktreePath,
      source: "exec",
    });
    return hit ? (readCodexTranscriptSignals(hit.path).activity?.summary ?? null) : null;
  }
  return readActivitySignal(jsonlPathFor(worktreePath, criticSessionId))?.summary ?? null;
}

/** Provider-aware token-total reader, called only at finalize (a one-shot, so the Codex path always
 *  bypasses the resolver backoff — its last chance). Returns null when the transcript is
 *  unresolved/unreadable so the row books NULL (unknown), not 0. */
async function defaultReadUsage(
  worktreePath: string,
  criticSessionId: string,
  provider: AgentProvider | null,
  model: string | null,
  codexResolver: CodexRolloutResolver,
): Promise<SessionUsage | null> {
  if (provider === "codex") {
    const hit = codexResolver.resolve(
      { trackingId: criticSessionId, worktreePath, source: "exec" },
      { bypassBackoff: true },
    );
    if (!hit) return null;
    try {
      return parseCodexUsage(readFileSync(hit.path, "utf8"), model);
    } catch {
      return null;
    }
  }
  return readSessionUsage(worktreePath, criticSessionId);
}

/** #1812 finding A: read the session's approved `.shepherd-plan.md` from the LIVE session worktree.
 *  null when absent/unreadable. Mirrors plan-gate.ts's reader — the plan file is git-excluded, so
 *  this MUST be passed `session.worktreePath` (never the critic's detached head checkout, where it
 *  can never exist). */
const PLAN_FILE = ".shepherd-plan.md";
function defaultReadPlan(worktreePath: string): string | null {
  const p = join(worktreePath, PLAN_FILE);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
