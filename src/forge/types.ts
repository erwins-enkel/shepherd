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

/** Worst-of CI rollup: failure dominates, then pending, then success. */
export type ChecksState = "none" | "pending" | "success" | "failure";

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
  latestReview?: {
    state: "approved" | "changes_requested" | "commented";
    author: string;
    url?: string;
    submittedAt: number; // epoch ms
  };
  /** A deploy workflow is configured for this host. */
  deployConfigured: boolean;
}

/** A session's forge kind plus its current PR status — the GET /api/sessions/:id/git
 *  payload and the value cached/pushed for the list overview. */
export interface GitState extends PrStatus {
  kind: ForgeKind;
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
