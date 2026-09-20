import type { ActivityEntry } from "../../src/activity";
import type { SessionActivity } from "../../src/activity-signal";
import type { DiffFileStatus } from "../../src/types";
import type { MergeConfirm } from "../../src/merge-gate";
import {
  EmptyDiffError,
  type ChecksState,
  type GitForge,
  type GitState,
  type MergeStateStatus,
  type PrReview,
  type PrStatus,
} from "../../src/forge/types";

/** Pins each detail-stream open enum to the server's own TS union. `satisfies Record<T, true>`
 *  against an exhaustive object literal fails `bun run typecheck` in BOTH directions — a member
 *  removed from the union leaves an excess key here, a member added to the union leaves a key
 *  missing here — so contracts/openapi.yaml's enum can't silently drift from src/. */
export const CHECKS_STATES = {
  none: true,
  pending: true,
  success: true,
  failure: true,
} satisfies Record<ChecksState, true>;

export const PR_STATES = {
  none: true,
  open: true,
  merged: true,
  closed: true,
} satisfies Record<PrStatus["state"], true>;

export const MERGE_STATE_STATUSES = {
  behind: true,
  blocked: true,
  clean: true,
  dirty: true,
  draft: true,
  has_hooks: true,
  unknown: true,
  unstable: true,
} satisfies Record<MergeStateStatus, true>;

export const PR_REVIEW_STATES = {
  approved: true,
  changes_requested: true,
  commented: true,
} satisfies Record<PrReview["state"], true>;

export const DIFF_FILE_STATUSES = {
  added: true,
  modified: true,
  deleted: true,
  renamed: true,
} satisfies Record<DiffFileStatus, true>;

export const ACTIVITY_STATUSES = {
  ok: true,
  error: true,
  pending: true,
} satisfies Record<ActivityEntry["status"], true>;

/** Event payloads, annotated with the server's own types so a shape change in src/ breaks
 *  `bun run typecheck` before it can drift out of the contract. */
export const gitEvent: { id: string; git: GitState } = {
  id: "sess_fixture",
  git: {
    kind: "github",
    state: "open",
    number: 12,
    url: "https://github.com/acme/demo/pull/12",
    title: "add the thing",
    createdAt: 1_800_000_000_000,
    mergeable: true,
    checks: "success",
    mergeStateStatus: "clean",
    isDraft: false,
    deployConfigured: false,
    requestedReviewers: ["octocat"],
    authorLogin: "shepherd-bot",
    latestReview: { state: "approved", author: "octocat", submittedAt: 1_800_000_100_000 },
    handoff: "merger",
    handoffWho: "hubot",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseRefName: "release",
    mergeGate: { handoff: "merger", handoffWho: "hubot" },
  },
};

/** A reviewer has requested changes, so the author must address the block before handoff. */
export const reviewBlockedGitEvent: { id: string; git: GitState } = {
  id: gitEvent.id,
  git: {
    ...gitEvent.git,
    handoff: undefined,
    handoffWho: undefined,
    mergeGate: { handoff: "reviewer", handoffWho: "octocat", reviewBlockBy: "octocat" },
    mergeStateStatus: "blocked",
    latestReview: {
      state: "changes_requested",
      author: "octocat",
      submittedAt: 1_800_000_100_000,
    },
    reviewBlock: {
      reviewer: "octocat",
      state: "changes_requested",
      latestAt: 1_800_000_100_000,
    },
  },
};

/** Some forges cannot supply the timestamp of the blocking review. */
export const undatedReviewBlockedGitEvent: { id: string; git: GitState } = {
  id: gitEvent.id,
  git: {
    ...reviewBlockedGitEvent.git,
    reviewBlock: { reviewer: "octocat", state: "changes_requested", latestAt: null },
  },
};

export const activityEvent: { id: string; activity: SessionActivity } = {
  id: "sess_fixture",
  activity: {
    lastActivityTs: 1_800_000_000_000,
    summary: "edited server.ts",
    recentTs: [1_800_000_000_000],
    recentErrTs: [],
    runtimeModel: "fable",
    runtimeEffort: "high",
  },
};

/** Pending CI hides the herd handoff but must not hide configured takeover responsibility. */
export const takeoverStatus: PrStatus = {
  state: "open",
  checks: "pending",
  number: 12,
  deployConfigured: false,
  headSha: "head-a",
  baseRefName: "release",
  reviewerStates: { reviewer: { state: "changes_requested", latestAt: null } },
};

export const takeoverConfirm: MergeConfirm = {
  headSha: "head-a",
  baseRefName: "release",
  handoff: "reviewer",
  handoffWho: "reviewer",
  reviewBlockBy: "reviewer",
};

const openStatus: PrStatus = {
  state: "open",
  number: 12,
  url: "https://github.com/acme/demo/pull/12",
  title: "add the thing",
  checks: "success",
  isDraft: false,
  deployConfigured: false,
  authorLogin: "shepherd-bot",
  requestedReviewers: [],
};

/** A hand-rolled forge. `GitForge` is a wide interface and these routes touch only these
 *  members, so the cast mirrors how deps.ts stubs herdr and worktree. Nothing shells out. */
export function makeForge(over: Record<string, unknown> = {}): GitForge {
  return {
    kind: "github",
    slug: "acme/demo",
    mergeMethod: "squash",
    deployWorkflow: null,
    isFork: false,
    prStatus: async () => openStatus,
    openPr: async () => openStatus,
    merge: async () => undefined,
    closePr: async () => undefined,
    markReady: async () => undefined,
    convertToDraft: async () => undefined,
    requestReview: async () => undefined,
    listCollaborators: async () => ({ logins: ["octocat", "hubot"], unavailable: false }),
    ...over,
  } as unknown as GitForge;
}

/** No PR at all — every action needing one answers 409. */
export const noPrForge = (): GitForge =>
  makeForge({ prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) });

/** Every call fails, so the /git family's 502 catch-all is reachable. `openPr` throws too:
 *  it is the one action that never reads `prStatus` first. */
export const angryForge = (): GitForge =>
  makeForge({
    prStatus: async () => {
      throw new Error("boom");
    },
    openPr: async () => {
      throw new Error("boom");
    },
  });

/** openPr rejects with the typed "nothing to land" error the route maps to 409. */
export const emptyDiffForge = (): GitForge =>
  makeForge({
    openPr: async () => {
      throw new EmptyDiffError("shepherd/x", "main");
    },
  });

/** No `closePr` — mirrors LocalForge, which implements none of the PR-mutation optionals.
 *  The open PR from `openStatus` is enough: forgeClosePr never looks at `isDraft`. */
export const noClosePrForge = (): GitForge => makeForge({ closePr: undefined });

/** No `convertToDraft`. `openStatus.isDraft` is falsy, so POST /git/draft always needs the
 *  conversion and hits the missing method. */
export const noMarkReadyForDraftForge = (): GitForge => makeForge({ convertToDraft: undefined });

/** No `markReady`, and the PR itself is already a draft, so POST /git/ready needs the
 *  conversion and hits the missing method. */
export const noMarkReadyForge = (): GitForge =>
  makeForge({
    markReady: undefined,
    prStatus: async () => ({ ...openStatus, isDraft: true }),
  });

/** The host rejects the review request outright (branch protection, no push access, …). */
export const forbiddenReviewForge = (): GitForge =>
  makeForge({
    requestReview: async () => {
      throw new Error("review_request_forbidden");
    },
  });

/** The host rejects the named reviewer (not a collaborator, no push access, …). */
export const invalidReviewerForge = (): GitForge =>
  makeForge({
    requestReview: async () => {
      throw new Error("review_request_invalid_reviewer");
    },
  });
