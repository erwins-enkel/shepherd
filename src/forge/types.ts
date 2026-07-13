import type { PrKind } from "./pr-kind";

/** Per-child native state from the sub_issues REST payload — carries closed/labels/body so
 * gating escapes listIssues()'s 200-open-issue cap.
 */
export interface SubIssueRef {
  number: number;
  title: string;
  url: string;
  body: string;
  closed: boolean;
  labels: string[];
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  /** Label name → hex color (`#rrggbb`) from the forge, when available. Additive/optional:
   *  `labels` stays the authoritative membership list; this is presentational metadata keyed
   *  by name (forge label names are unique per issue). Absent/partial ⇒ UI falls back to a
   *  neutral chip. Populated by the issue-LIST display paths only. */
  labelColors?: Record<string, string>;
  createdAt: number;
  /** GitHub/Gitea logins assigned to the issue (empty when unassigned). Drives the
   *  UI's "mine & unassigned" filter (#824); filtering is purely client-side. */
  assignees: string[];
  /** Login of the issue's author. Optional — only forges/paths that fetch it populate
   *  it (GitHub `listIssues`); absent elsewhere. Up Next (#1169) uses it to exclude
   *  bot-authored issues (the PR-only `classifyPr` heuristics don't transfer to issues,
   *  so the bot filter collapses to author-login matching). */
  author?: string;
  /** GitHub authorAssociation of the issue's author (OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR |
   *  FIRST_TIME_CONTRIBUTOR | FIRST_TIMER | MANNEQUIN | NONE). Populated only by GitHub's GraphQL
   *  getIssue path; absent elsewhere (Gitea has no equivalent). Drives the autonomous-spawn author
   *  trust gate — an absent value fails closed. */
  authorAssociation?: string;
  /** Numbers of the issue's still-OPEN blockers (GitHub issue dependencies). Populated only by
   *  consumers that attach it (Up Next, /api/issues) via listBlockedByOpen — absent/empty means
   *  not blocked. NOT fetched by listIssues (which has no dependency data). */
  blockedBy?: number[];
}

/** An open PR linked to an issue (via `closingIssuesReferences`), reduced to the PR's
 *  number + author login. Carried per closed-issue number by {@link GitForge.listOpenPrLinkedIssues};
 *  drives the epic-summary "in progress · by {author}" signal (#1616). Author is "" when the
 *  forge omits it. */
export interface LinkedPr {
  prNumber: number;
  author: string;
}

export type ForgeKind = "github" | "gitea" | "local";
export type MergeMethod = "merge" | "squash" | "rebase";

/** Default-branch CI rollup state, or null when unknown / no CI / non-GitHub. */
export type CiStatus = "success" | "failure" | "pending" | null;

/** Lightweight per-repo counts for the overview/backlog row. Each forge answers in
 *  its own way via {@link GitForge.listBacklogCounts}; null fields mean "unknown /
 *  not supported by this host" (e.g. Gitea has no Actions rollup or PR-kind split). */
export interface RepoCounts {
  openIssues: number | null;
  openPRs: number | null;
  /** Default-branch CI health for the Actions tab marker. GitHub-only; null otherwise. */
  ciStatus: CiStatus;
  /** Open-PR breakdown by kind for the repo-list row. GitHub-only; null for Gitea/unknown. */
  prKinds: { release: number; dependabot: number; regular: number } | null;
}

/** All-null counts — a forge with no remote backlog surface (LocalForge), a fetch
 *  failure, or a not-yet-resolved repo. Shared so the seam, the caller's fallbacks,
 *  and test doubles agree on one shape. */
export const EMPTY_BACKLOG_COUNTS: RepoCounts = {
  openIssues: null,
  openPRs: null,
  ciStatus: null,
  prKinds: null,
};

/** Invisible marker appended to every critic-posted review body so the review
 *  fetch can tell the critic's own reviews apart from human ones (they share one
 *  gh identity). HTML comments don't render in GitHub's UI. */
export const CRITIC_REVIEW_MARKER = "<!-- shepherd-critic -->";

/** Invisible marker the task agent prefixes onto a PR comment when it declines a
 *  critic finding. Lets the re-review fetch the author's justifications back out of
 *  the PR's comments (so a sound decline isn't blindly re-raised) without parsing
 *  free-form human chatter. HTML comments don't render in GitHub's UI. */
export const AUTHOR_RESPONSE_MARKER = "<!-- shepherd-author-note -->";

/** The opt-in command a maintainer posts on a Dependabot PR to make Dependabot
 *  rebase it onto the base branch. Posted by the dependabot-rebase endpoint. */
export const DEPENDABOT_REBASE_COMMAND = "@dependabot rebase";

/** Invisible marker appended to every issue-log comment Shepherd authors (the
 *  ⏸️ waiting / ✅ merged workflow notes). Lets a task spawned from that issue
 *  filter Shepherd's own machine chatter back out of the comment thread it feeds
 *  to the agent — they're posted under the operator's gh identity (so not `[bot]`)
 *  and would otherwise read as discussion. HTML comments don't render in GitHub's UI. */
export const SHEPHERD_ISSUE_LOG_MARKER = "<!-- shepherd-issue-log -->";

/** One issue comment on a PR (author responses to review rounds). */
export interface PrComment {
  /** Host-stable comment id, used to inject each author note into the critic exactly
   *  once (scoped to the round it responded to) rather than re-feeding every marked
   *  comment on every re-review. Empty when the host can't supply one. */
  id: string;
  author: string;
  body: string;
  createdAt: number; // epoch ms
}

/** One comment on an issue (the human discussion that refines the original request),
 *  fed into a task spawned from that issue alongside the body. `authorAssociation` is
 *  GitHub's per-comment relationship enum (OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR |
 *  FIRST_TIME_CONTRIBUTOR | FIRST_TIMER | MANNEQUIN | NONE), used to scope the included
 *  comments to repo-standing authors — bounding the prompt-injection surface, which would
 *  otherwise widen from the single issue author to any GitHub commenter. */
export interface IssueComment {
  author: string;
  authorAssociation: string;
  body: string;
  createdAt: number; // epoch ms
}

/** Worst-of CI rollup: failure dominates, then pending, then success. */
export type ChecksState = "none" | "pending" | "success" | "failure";

/** GitHub's merge-eligibility signal (`mergeStateStatus`). Lowercase mirror of
 *  the GitHub enum (BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS |
 *  UNKNOWN | UNSTABLE). */
export type MergeStateStatus =
  "behind" | "blocked" | "clean" | "dirty" | "draft" | "has_hooks" | "unknown" | "unstable";

/** A newest-review summary (critic-marked reviews excluded). Shared by PrStatus
 *  and the backlog PullRequest row. */
export interface PrReview {
  state: "approved" | "changes_requested" | "commented";
  author: string;
  submittedAt: number; // epoch ms
}

/** An open PR surfaced in the backlog PRs tab. Lighter than PrStatus: it is a
 *  list row across all forge repos, not one session's live git state. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  /** Which kind of PR this is — drives the PRs tab type tag. Computed via classifyPr. */
  kind: PrKind;
  createdAt: number; // epoch ms
  isDraft: boolean;
  /** null = host still computing mergeability. */
  mergeable: boolean | null;
  /** Worst-of CI rollup over the head commit. */
  checks: ChecksState;
  /** Per-check breakdown of the head commit (one entry per CI job / status
   *  context), powering the PRs tab's expand-the-dot view. Empty when the host
   *  reports no checks. */
  jobs: WorkflowJob[];
  /** Newest *human* review (critic-marked reviews excluded), or undefined. */
  latestReview?: PrReview;
  /** The PR's base (target) branch, populated ONLY when it is NOT the repo's
   *  default branch (e.g. an epic/stacked branch); `undefined` for the common
   *  default-targeting PR. This is intentionally NOT the raw base ref — do not
   *  rely on it to read a PR's actual target; it exists solely to surface
   *  non-default (stacked) PRs in the backlog PRs tab. */
  nonDefaultBase?: string;
  /** Head commit SHA (`headRefOid`); drives the standalone critic's per-head dedup. */
  headSha?: string;
  /** Head branch name; used to skip PRs already managed by a live session. */
  headRefName?: string;
  /** True when a GitHub Actions workflow run on this PR's head is awaiting manual
   *  approval to run (`conclusion=action_required` — the fork/outside-contributor &
   *  Actions-bot flavor; deployment-environment `waiting` gates are NOT detected).
   *  Display-only: does not affect merge gating. Absent ⇒ treat as false. */
  awaitingWorkflowApproval?: boolean;
}

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  /** ms epoch the PR was opened; undefined when there is no PR (or a cached
   *  payload predates the field). Drives the UI's "PR open for X" wait line. */
  createdAt?: number;
  /** null = host still computing mergeability. */
  mergeable?: boolean | null;
  checks: ChecksState;
  /** Names of the checks currently in flight (the `pending` subset of the rollup),
   *  e.g. `["verify / test", "PR hygiene / i18n"]`. Populated only on the GitHub
   *  `gh pr list` path; absent on the REST rate-limit fallback and on Gitea, and
   *  absent (rather than `[]`) when nothing is running. Drives the terminal
   *  "CI running: <names>" banner. Order isn't stable — compare as a set. */
  runningChecks?: string[];
  /** Head commit SHA of the PR branch; undefined when there is no PR. Drives
   *  "review this head once" dedup and per-push re-review. */
  headSha?: string;
  /** Newest *human* PR review (critic-marked reviews excluded), or undefined. */
  latestReview?: PrReview;
  /** GitHub logins with a pending review request on the PR (teams/bots without a
   *  login are dropped). Drives merger auto-inference when the repo has no
   *  `.shepherd/roles.json`. Optional: a cached payload predating the field ⇒ treat as `[]`. */
  requestedReviewers?: string[];
  /** true = PR is a draft / not ready-for-review. Optional; absent ⇒ treat as false downstream. */
  isDraft?: boolean;
  /** GitHub's merge-eligibility signal; undefined on forges that don't supply it (Gitea). */
  mergeStateStatus?: MergeStateStatus;
  /** The PR's actual base (target) branch ref name, e.g. "main". Drives the diff/recap
   *  base so they match the PR's "Files changed" even when it targets a non-default branch.
   *  Undefined when there is no PR, or on forges/payloads that don't supply it. Unlike
   *  {@link PullRequest.nonDefaultBase} this IS the raw base ref — safe to diff against. */
  baseRefName?: string;
  /** A deploy workflow is configured for this host. */
  deployConfigured: boolean;
}

/** A session's forge kind plus its current PR status — the GET /api/sessions/:id/git
 *  payload and the value cached/pushed for the list overview. */
export interface GitState extends PrStatus {
  kind: ForgeKind;
  /** True when the repo has no CI to wait on (GitHub + zero defined workflows), so a terminal
   *  `checks:"none"` should be treated as cleared for review/merge/surface rather than as a
   *  not-yet-green CI race. Stamped once in `annotateHandoff` (the poller + on-demand `/git`
   *  chokepoint); consumed via `checksCleared`. Absent ⇒ false. */
  noCi?: boolean;
  /** Who is up once the PR is open + green, when it isn't the operator — computed
   *  server-side from `.shepherd/roles.json` + the operator's login. Absent = the
   *  operator's turn (today's "awaiting merge"). Drives the herd's
   *  waiting-on-reviewer / waiting-on-merger groups. */
  handoff?: "reviewer" | "merger";
  /** The login to display for {@link handoff} (e.g. "scoop"); absent for self. */
  handoffWho?: string;
  /** true when `handoff` was auto-inferred from PR reviewers (no
   *  `.shepherd/roles.json`); suppresses the outward issue-log comment, which
   *  stays opt-in to explicitly-configured roles. */
  handoffInferred?: boolean;
  /** Web URL of the backlog issue this session was spawned for (session.issueNumber),
   *  or absent when the session has no linked issue or the repo has no web forge
   *  (LocalForge). Lets GitRail surface an "open issue" link. */
  issueUrl?: string;
}

/** One job within a workflow run, mapped to the four-light CI vocab. */
export interface WorkflowJob {
  name: string;
  state: ChecksState;
  /** Link to the job on the host, when provided. */
  url?: string;
}

/** The latest run of one workflow on a repo's default branch, broken into its
 *  individual jobs. Surfaced in the backlog Actions tab (GitHub only). */
export interface WorkflowRun {
  /** Host run id (gh's `databaseId`) — the handle re-run / cancel act on. */
  runId: number;
  /** The workflow's stable id (gh's `workflowDatabaseId`) — the handle the
   *  run-history call filters on (`gh run list --workflow <id>`). */
  workflowId: number;
  workflowName: string;
  runUrl: string;
  headSha: string;
  createdAt: number; // epoch ms
  /** Worst-of state for the whole run (the run's own status/conclusion). */
  state: ChecksState;
  jobs: WorkflowJob[];
}

export interface OpenPrInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

/** Thrown by a forge's openPr when the head branch has no net diff vs the base — there is
 *  nothing to open a PR for (already landed, or commits that net to zero). Forge-agnostic so a
 *  caller (epic landing, #635) can resolve "nothing to land" instead of retrying openPr forever. */
export class EmptyDiffError extends Error {
  constructor(
    readonly head: string,
    readonly base: string,
    cause?: unknown,
  ) {
    super(`no commits between ${base} and ${head}`);
    this.name = "EmptyDiffError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface MergeInput {
  method: MergeMethod;
  deleteBranch: boolean;
}

export interface RedeployInput {
  workflow: string;
  ref: string;
}

/** Number-keyed PR metadata for the standalone critic. Fetched once at spawn time
 *  (body/base/fork) and re-fetched at finalize (state). Number-keyed so a recurring
 *  or fork head branch name can't resolve a different PR. */
export interface PrReviewMeta {
  body: string;
  baseRefName: string;
  isCrossRepository: boolean;
  /** Live PR state, number-keyed (unlike branch-keyed prStatus). */
  state: "open" | "merged" | "closed" | "none";
}

/** A critic review verdict the forge can post. Shepherd never approves a PR. */
export type ReviewEvent = "REQUEST_CHANGES" | "COMMENT";

export interface PostReviewInput {
  event: ReviewEvent;
  body: string;
}

/** One per-repo open-PR fetch (`gh pr list --state open`) mapped into every shape its
 *  consumers need, so a single query feeds the PRs-tab rows and the pr-poller batch. */
export interface OpenPrSnapshot {
  /** Backlog PRs-tab rows (newest-first, as listPullRequests returns today). */
  prs: PullRequest[];
  /** pr-poller batch keyed by headRefName, as listOpenPrStatuses returns today. */
  statuses: Map<string, PrStatus>;
  /** True when ≥200 open PRs were returned (tail truncated by the --limit 200 cap). */
  capped: boolean;
  /** Transport used to produce this snapshot; absent on older/test doubles. */
  source?: "graphql" | "rest";
}

export interface GitForge {
  readonly kind: ForgeKind;
  readonly slug: string | null;
  /** Default merge method for this host (from config; "squash" if unset). */
  readonly mergeMethod: MergeMethod;
  /** Configured deploy workflow filename, or null if redeploy is unavailable. */
  readonly deployWorkflow: string | null;
  /** Repo's web home page (e.g. https://github.com/owner/repo); null when unbuildable; absent → null. */
  readonly webUrl?: string | null;
  /** True when this forge runs in fork mode — `origin` is a fork and `slug` is the
   *  upstream it was forked from (the `gh repo fork --clone` topology). Drives the
   *  repo picker's per-fork "Sync fork" affordance. Absent/false ⇒ not a fork. */
  readonly isFork?: boolean;
  /** True only for the lightweight LocalForge (no remote/PR surface). Optional and
   *  defined only where true — mirrors {@link isFork}; absent ⇒ falsy ⇒ not lightweight.
   *  Lets callers gate the no-PR-surface paths (nightly docs, worktree reaping) without
   *  branching on `kind`. NB: the issue (#1096) proposed a `isLightweight()` method; a
   *  readonly property is used here for consistency with the other capability flags. */
  readonly isLightweight?: boolean;
  listIssues(): Promise<Issue[]>;
  /** Open PRs for the backlog PRs tab (newest first), capped server-side. */
  listPullRequests(): Promise<PullRequest[]>;
  /** Lightweight issue/PR counts (+ GitHub CI rollup / PR-kind split) for the overview
   *  row. Each adapter answers in its own way; the caller never branches on `kind`. */
  listBacklogCounts(): Promise<RepoCounts>;
  /** Latest run per workflow on the default branch, with per-job breakdown, for
   *  the backlog Actions tab. Optional: only hosts with an Actions API implement
   *  it (GitHub); others omit it and the tab shows a "GitHub only" state. */
  listWorkflowRuns?(): Promise<WorkflowRun[]>;
  /** Re-run a workflow run by id. `failedOnly` re-runs just the failed jobs
   *  (`gh run rerun --failed`); otherwise the whole run. Optional: only Actions
   *  hosts (GitHub) implement it; others omit it and the tab hides the button. */
  rerunWorkflowRun?(runId: number, o: { failedOnly: boolean }): Promise<void>;
  /** Cancel an in-progress workflow run by id (`gh run cancel`). Optional, same
   *  GitHub-only gating as {@link rerunWorkflowRun}. */
  cancelWorkflowRun?(runId: number): Promise<void>;
  /** Prior runs of one workflow on the default branch (summary rows; `jobs`
   *  empty), newest-first, capped by `limit`. Optional, GitHub-only like
   *  {@link listWorkflowRuns}; other forges omit it and the history UI degrades. */
  listWorkflowRunHistory?(workflowId: number, o: { limit: number }): Promise<WorkflowRun[]>;
  /** Per-job breakdown for a single run, lazy-loaded when a history row expands.
   *  Optional, same GitHub-only gating as {@link listWorkflowRunHistory}. */
  listRunJobs?(runId: number): Promise<WorkflowJob[]>;
  /** Resolve the id of a PR head's most recent FAILED workflow run, so a one-click
   *  "Retry CI" can rerun it (a `ci-red` hold carries only the PR number, not a runId).
   *  Prefers a run whose headSha matches the PR head, else the newest failed run on the
   *  head branch; null when none. Optional, same GitHub-only gating as
   *  {@link rerunWorkflowRun} — pairs with it for the retry-ci endpoint. Note: resolves runs
   *  on the base repo's head branch, so a fork-origin PR (runs live in the fork) yields null. */
  latestFailedRunForPr?(prNumber: number): Promise<number | null>;
  prStatus(headBranch: string): Promise<PrStatus>;
  /** The operator's own login on this host (`gh api user`), cached. Drives the
   *  "is the configured reviewer/merger someone *other* than me" decision. Null
   *  when it can't be resolved. Optional: hosts without an identity API omit it. */
  currentUser?(): Promise<string | null>;
  /** Logins with access to the repo, for the roles dialog's people picker.
   *  `unavailable` is true when the host refused the list (e.g. GitHub 403 with no
   *  push access) so the dialog falls back to free-text. Optional. */
  listCollaborators?(): Promise<{ logins: string[]; unavailable: boolean }>;
  openPr(o: OpenPrInput): Promise<PrStatus>;
  /** Whether the operator has push access to the repo on this host. Gates the
   *  gitignore-adopt flow (no push → it can't open the adopt PR; the caller shows
   *  an info toast rather than an error). Optional: hosts without an access API omit
   *  it and the adopter treats absence as "no push access". */
  canPush?(): Promise<boolean>;
  /** Sync the fork's default branch from the upstream on the host (`gh repo sync`),
   *  keeping the fork current so fresh PR branches cut off it aren't already behind.
   *  Only meaningful in fork mode ({@link isFork}); throws on a non-fork forge and
   *  propagates the host error (auth / a diverged fork default) for the caller to
   *  classify. The local clone is fast-forwarded separately by the caller. Optional:
   *  only hosts with a fork-sync API (GitHub) implement it; others omit it and the
   *  sync-fork endpoint 400s. */
  syncFork?(): Promise<void>;
  /** The repo's default branch name (the promote PR's base). */
  defaultBranch(): Promise<string>;
  /** Short-names of all host branches under `prefix` (e.g. `"epic/"`), `refs/heads/`
   *  stripped. Used by epic-branch divergence detection (#645) to spot stray `epic/*`
   *  branches that diverge from the pinned integration branch. Optional: only hosts with a
   *  matching-refs API (GitHub) implement it; absent → divergence signal (c) degrades to off. */
  listBranches?(prefix: string): Promise<string[]>;
  /** Ensure a branch exists on the host, creating it at `fromRef`'s tip when absent
   *  (idempotent; a present branch is left untouched — its tip is NOT reset). Used to
   *  cut an epic integration branch off the default branch. Optional: hosts without a
   *  refs API omit it and the caller skips epic-branch orchestration. */
  ensureBranch?(branch: string, fromRef: string): Promise<void>;
  /** Rename a branch on the host, retargeting any open PR to the new name. Optional:
   *  hosts that can't do this safely (Gitea) omit it, and the caller falls back to a
   *  display-only rename so an open PR is never orphaned. */
  renameBranch?(oldBranch: string, newBranch: string): Promise<void>;
  merge(prNumber: number, o: MergeInput): Promise<void>;
  /** Post a plain issue comment on a PR (`gh pr comment`). Optional: only hosts
   *  with a comment API (GitHub) implement it; others omit it and the
   *  dependabot-rebase endpoint 400s. */
  comment?(prNumber: number, body: string): Promise<void>;
  /** Edit an open PR's title and/or body (`gh pr edit`). Used to refresh a rolled-up
   *  docs PR's body so it matches the force-pushed diff (doc agent). Optional: only hosts
   *  with a PR-edit API (GitHub) implement it; others omit it and the caller logs that the
   *  body may be stale. */
  editPr?(prNumber: number, o: { title?: string; body?: string }): Promise<void>;
  /** Stamp a label on a PR, creating it on the host if absent (best-effort). Used to flag
   *  Codex-authored session PRs (`codex-authored`) for extra review care. Optional: only
   *  hosts with a label + PR-edit API (GitHub) implement it; others omit it and flagging is
   *  skipped. Idempotent — re-adding an already-present label is a no-op. */
  addPrLabel?(prNumber: number, label: string): Promise<void>;
  /** Flip an open draft PR to ready-for-review (`gh pr ready <n>`). Optional: only
   *  hosts with a draft API implement it; the draft-reconcile service treats absence
   *  as "cannot promote on this host". */
  markReady?(prNumber: number): Promise<void>;
  /** Convert an open ready PR back to draft (`gh pr ready <n> --undo`). Optional,
   *  same host gating as {@link markReady}. */
  convertToDraft?(prNumber: number): Promise<void>;
  redeploy(o: RedeployInput): Promise<void>;
  /** Post a critic review (request-changes / comment) on a PR. Returns the
   *  review's URL when the host provides one. */
  postReview(prNumber: number, o: PostReviewInput): Promise<{ url?: string }>;
  /** Issue comments on a PR (oldest first), used to read back the author's
   *  responses to earlier review rounds. Optional: only hosts with a comments API
   *  implement it (GitHub); others omit it and no author notes are surfaced. */
  listPrComments?(prNumber: number): Promise<PrComment[]>;
  /** The changed file paths of a PR (`gh pr view <n> --json files`). Used by the epic-landing
   *  migration-awareness check (#645) to detect migration files carried by the landing PR.
   *  Optional: only hosts with a PR-files API (GitHub) implement it; others omit it and the
   *  migration check degrades to off (no chip). Best-effort; the caller wraps the call so a
   *  failure never breaks the landing. */
  prChangedPaths?(prNumber: number): Promise<string[]>;
  /** Number-keyed PR metadata for the standalone critic: body + base branch + fork flag +
   *  live state, via `gh pr view <number>`. Number-keyed so a recurring/fork head branch
   *  name can't resolve a different PR (unlike branch-keyed prStatus). Optional: only hosts
   *  with a PR-view API (GitHub) implement it; others omit it and the standalone critic skips
   *  that PR. Returns null when the PR is gone/unreadable. */
  prReviewMeta?(prNumber: number): Promise<PrReviewMeta | null>;
  /** Close an issue by number (best-effort; used by the drain to retire a backlog
   *  issue once its auto PR merges). Optional: hosts without an issues-close API omit it. */
  closeIssue?(issueNumber: number): Promise<void>;
  /** Post a plain comment on an issue (the issue-log's workflow protocol: one note
   *  when the session's PR enters the waiting-on-handoff state, one when it merges).
   *  Best-effort; optional (hosts without an issue-comment API omit it and the
   *  issue-log stays silent). */
  commentIssue?(issueNumber: number, body: string): Promise<void>;
  /** Ensure the PR body links the issue so the forge auto-closes it on merge.
   *  Idempotent: appends a `Closes #<issueNumber>` line only when no closing
   *  keyword for that issue is already present. Best-effort; optional (hosts
   *  without a PR-body edit API omit it). */
  ensureIssueLink?(prNumber: number, issueNumber: number): Promise<void>;
  /** Stamp a label on an issue, creating it on the host if absent (best-effort; the
   *  drain claims a backlog issue with `ACTIVE_LABEL` when it spawns, so a second
   *  shepherd instance skips it). Optional: hosts without a label API omit it and
   *  claims degrade to single-instance local dedup. */
  addIssueLabel?(issueNumber: number, label: string): Promise<void>;
  /** Remove a label from an issue (best-effort; releases the drain's claim when an
   *  auto session is abandoned, returning the issue to the pool). Optional. */
  removeIssueLabel?(issueNumber: number, label: string): Promise<void>;
  /** Fetch ONE issue fresh (UNCACHED) by number, for the drain's pre-spawn claim
   *  re-check. The cached `listIssues` view a candidate is selected from can be up to
   *  `issuesTtlMs` stale, so a second instance may still see an issue another instance
   *  stamped `ACTIVE_LABEL` on seconds ago. A fresh single-issue read closes that
   *  stale-cache window: if it already carries the claim, the spawn is yielded. Returns
   *  null when the issue is gone/unreadable. Best-effort and optional — hosts without it
   *  (or a transient failure → null) fall back to the cached candidate set + local dedup. */
  getIssue?(issueNumber: number): Promise<Issue | null>;
  /** Issue comments (oldest first), fed into a task spawned from the issue so the
   *  agent sees the discussion that refined the request, not just the body. Optional:
   *  only hosts with a comments API (GitHub) implement it; others omit it and the spawn
   *  prompt stays body-only. Best-effort — the caller wraps the call so a failure never
   *  blocks or fails a spawn. */
  listIssueComments?(issueNumber: number): Promise<IssueComment[]>;
  /** Open a new issue (capture-extension delivery path). Returns the created
   *  issue's number + URL. Optional: hosts without an issue-create API omit it
   *  and POST /api/issues 400s. */
  createIssue?(o: { title: string; body: string }): Promise<{ number: number; url: string }>;
  // Epic structure (GitHub only; absent → markdown fallback)
  listSubIssues?(parentNumber: number): Promise<SubIssueRef[]>;
  listBlockedBy?(issueNumber: number): Promise<number[]>;
  issueId?(issueNumber: number): Promise<number | null>;
  addSubIssue?(parentNumber: number, childNumber: number): Promise<void>;
  addBlockedBy?(issueNumber: number, blockerNumber: number): Promise<void>;
  /** Batched: one call returning every open issue that has >=1 OPEN blocker, mapped to its
   *  open-blocker numbers. Distinct from the per-issue listBlockedBy(n) (which returns ALL
   *  blockers for one issue and is used by the epic pipeline). Optional — hosts without issue
   *  dependencies (Gitea) omit it; callers must fail open when it's absent. */
  listBlockedByOpen?(): Promise<Map<number, number[]>>;
  /** Cheap per-parent native sub-issue counts for the backlog epic-badge discovery
   *  (GitHub only; absent → no native-epic discovery, markdown fallback only). Map keyed
   *  by parent issue number; only entries with total > 0 are included. Also returns the
   *  numbers of all open issues that are native sub-issues (i.e. have a non-null parent). */
  listSubIssueSummaries?(): Promise<{
    summaries: Map<number, { total: number; completed: number }>;
    subIssueNumbers: number[];
    /** Native sub-issue child numbers grouped by their parent issue number — the same
     *  `parent{number}` field already selected for `subIssueNumbers`, kept per-parent so
     *  the epic-summary route can map in-flight children to their epic (#1616) without a
     *  per-parent `listSubIssues` probe. Optional so existing callers/fakes that predate it
     *  stay valid; GithubForge always populates it. */
    childrenByParent?: Map<number, number[]>;
  }>;
  /** Issue numbers that an OPEN pull request would close (GraphQL `closingIssuesReferences`,
   *  GitHub only). Catches UI-linked PRs and `Closes #N`/`Fixes #N` bodies alike. Used by
   *  Up Next (#1169) as the best-effort secondary "this issue already has work in flight"
   *  exclusion (the primary signal is the `shepherd:active` label). Best-effort: a forge
   *  without it, or a transient failure, yields an empty set and the exclusion degrades to
   *  `shepherd:active`-only. Optional: only hosts with the GraphQL field implement it. */
  listOpenPrClosingIssues?(): Promise<number[]>;
  /** Like {@link listOpenPrClosingIssues} but keyed by closed-issue number and carrying the
   *  open PR's number + author — the epic-summary route's "someone else is already working
   *  this" signal (the pill's "by {author}"). Same single bounded query
   *  (`closingIssuesReferences`), extended with `number author{login}`; capped to the ~200
   *  newest open PRs (`MAX_SUMMARY_PAGES`) so repos above that undercount. Best-effort:
   *  failure/rate-limit yields an empty map. Optional: GitHub only. */
  listOpenPrLinkedIssues?(): Promise<Map<number, LinkedPr[]>>;
  /** Open PRs for this repo as full poll-grade PrStatus objects keyed by head
   *  branch name, fetched in ONE `gh pr list --state open` call — the per-repo
   *  batch the PrPoller matches sessions against locally (collapsing N× per-branch
   *  prStatus to O(repos)). On a headRefName collision the implementation may
   *  deterministically prefer the repo-owned PR, but it does NOT filter by owner —
   *  every open PR is returned. Optional: forges without it (Gitea/Local), and
   *  fork-mode repos (which the poller routes around → per-session), fall back to
   *  per-session prStatus. */
  listOpenPrStatuses?(): Promise<Map<string, PrStatus>>;
  /** Cheap open-PR count (`gh pr list --state open --json number --limit 200`,
   *  ~1 GraphQL point regardless of count) — the poller's count-gate uses it to
   *  decide whether the full listOpenPrStatuses batch is cheaper than per-session
   *  for this repo. Capped at 200 (a ≥200 result means "at least 200"). Optional. */
  countOpenPrs?(): Promise<number>;
  /** Open PRs for this repo fetched ONCE and mapped into both consumer shapes (PRs-tab
   *  rows + headRefName-keyed poll statuses). Optional: only GitHub implements it;
   *  Gitea/Local omit it and callers fall back to listPullRequests / per-session prStatus. */
  listOpenPrSnapshot?(): Promise<OpenPrSnapshot>;
}

/** Per-host configuration loaded from ~/.shepherd/forges.json. */
export interface ForgeConfig {
  type?: ForgeKind;
  baseUrl?: string;
  token?: string;
  deployWorkflow?: string;
  mergeMethod?: MergeMethod;
}

export type ForgeMap = Record<string, ForgeConfig>;

/** One raw entry in GitHub's `statusCheckRollup`: either a modern CheckRun (an
 *  Actions job — lifecycle status + conclusion) or a legacy StatusContext (a
 *  commit status — a flat state). The two shapes are disjoint, so every field is
 *  optional and the checks helpers branch on `__typename` to read the right ones. */
export interface RollupEntry {
  __typename?: string;
  // CheckRun
  name?: string | null;
  workflowName?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  // StatusContext
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  createdAt?: string | null;
}
