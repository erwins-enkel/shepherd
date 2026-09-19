import type { SessionActivity } from "../../src/activity-signal";
import { EmptyDiffError, type GitForge, type GitState, type PrStatus } from "../../src/forge/types";

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
