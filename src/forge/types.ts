export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  createdAt: number;
}

export type ForgeKind = "github" | "gitea";
export type MergeMethod = "merge" | "squash" | "rebase";

/** Invisible marker appended to every critic-posted review body so the review
 *  fetch can tell the critic's own reviews apart from human ones (they share one
 *  gh identity). HTML comments don't render in GitHub's UI. */
export const CRITIC_REVIEW_MARKER = "<!-- shepherd-critic -->";

/** Invisible marker the task agent prefixes onto a PR comment when it declines a
 *  critic finding. Lets the re-review fetch the author's justifications back out of
 *  the PR's comments (so a sound decline isn't blindly re-raised) without parsing
 *  free-form human chatter. HTML comments don't render in GitHub's UI. */
export const AUTHOR_RESPONSE_MARKER = "<!-- shepherd-author-note -->";

/** One issue comment on a PR (author responses to review rounds). */
export interface PrComment {
  author: string;
  body: string;
  createdAt: number; // epoch ms
}

/** Worst-of CI rollup: failure dominates, then pending, then success. */
export type ChecksState = "none" | "pending" | "success" | "failure";

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
  createdAt: number; // epoch ms
  isDraft: boolean;
  /** null = host still computing mergeability. */
  mergeable: boolean | null;
  /** Worst-of CI rollup over the head commit. */
  checks: ChecksState;
  /** Newest *human* review (critic-marked reviews excluded), or undefined. */
  latestReview?: PrReview;
}

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  /** null = host still computing mergeability. */
  mergeable?: boolean | null;
  checks: ChecksState;
  /** Head commit SHA of the PR branch; undefined when there is no PR. Drives
   *  "review this head once" dedup and per-push re-review. */
  headSha?: string;
  /** Newest *human* PR review (critic-marked reviews excluded), or undefined. */
  latestReview?: PrReview;
  /** A deploy workflow is configured for this host. */
  deployConfigured: boolean;
}

/** A session's forge kind plus its current PR status — the GET /api/sessions/:id/git
 *  payload and the value cached/pushed for the list overview. */
export interface GitState extends PrStatus {
  kind: ForgeKind;
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
}

export interface MergeInput {
  method: MergeMethod;
  deleteBranch: boolean;
}

export interface RedeployInput {
  workflow: string;
  ref: string;
}

/** A critic review verdict the forge can post. Shepherd never approves a PR. */
export type ReviewEvent = "REQUEST_CHANGES" | "COMMENT";

export interface PostReviewInput {
  event: ReviewEvent;
  body: string;
}

export interface GitForge {
  readonly kind: ForgeKind;
  readonly slug: string | null;
  /** Default merge method for this host (from config; "squash" if unset). */
  readonly mergeMethod: MergeMethod;
  /** Configured deploy workflow filename, or null if redeploy is unavailable. */
  readonly deployWorkflow: string | null;
  listIssues(): Promise<Issue[]>;
  /** Open PRs for the backlog PRs tab (newest first), capped server-side. */
  listPullRequests(): Promise<PullRequest[]>;
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
  prStatus(headBranch: string): Promise<PrStatus>;
  openPr(o: OpenPrInput): Promise<PrStatus>;
  /** Rename a branch on the host, retargeting any open PR to the new name. Optional:
   *  hosts that can't do this safely (Gitea) omit it, and the caller falls back to a
   *  display-only rename so an open PR is never orphaned. */
  renameBranch?(oldBranch: string, newBranch: string): Promise<void>;
  merge(prNumber: number, o: MergeInput): Promise<void>;
  redeploy(o: RedeployInput): Promise<void>;
  /** Post a critic review (request-changes / comment) on a PR. Returns the
   *  review's URL when the host provides one. */
  postReview(prNumber: number, o: PostReviewInput): Promise<{ url?: string }>;
  /** Issue comments on a PR (oldest first), used to read back the author's
   *  responses to earlier review rounds. Optional: only hosts with a comments API
   *  implement it (GitHub); others omit it and no author notes are surfaced. */
  listPrComments?(prNumber: number): Promise<PrComment[]>;
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

/** One forge-reported check run: a lifecycle status + (when complete) a conclusion. */
export interface CheckRun {
  status?: string | null;
  conclusion?: string | null;
}
