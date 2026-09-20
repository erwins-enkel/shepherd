import type { AutoMergeStatus } from "../../src/automerge";
import type { BlockReason } from "../../src/blocked";
import type { SessionStatus } from "../../src/types";
import type { UsageLimits } from "../../src/usage-limits";

/** Payloads for events the stubbed server cannot emit on its own. Each constant is annotated
 *  with the server's own type, so `bun run typecheck` fails if the server shape moves. The
 *  contract test emits them through deps.events and validates the frame the client sees.
 *
 *  session:status / session:renamed / session:ready are emitted from inline object literals in
 *  src/index.ts (the poller callbacks) and src/service.ts — there is no named payload type to
 *  import — so those three are annotated structurally, reusing the server's `SessionStatus`
 *  union for the one field that has a name. */

export const statusEvent: {
  id: string;
  status: SessionStatus;
  hasScratchpadFiles?: boolean;
} = {
  id: "sess_fixture",
  status: "blocked",
  hasScratchpadFiles: false,
};

export const renamedEvent: { id: string; name: string; branch: string | null } = {
  id: "sess_fixture",
  name: "renamed task",
  branch: "shepherd/renamed-task",
};

const block: BlockReason = {
  shape: "yes-no",
  options: [
    { label: "Yes", send: "y\n" },
    { label: "No", send: "n\n" },
  ],
  tail: ["Proceed? (y/n)"],
};
export const blockEvent: { id: string; block: BlockReason | null } = { id: "sess_fixture", block };
export const unblockEvent: { id: string; block: BlockReason | null } = {
  id: "sess_fixture",
  block: null,
};

export const readyEvent: { id: string; ready: boolean } = { id: "sess_fixture", ready: true };

export const automergeEvent: AutoMergeStatus = {
  repoPath: "/tmp/repo",
  enabled: true,
  state: "merging",
  detail: "PR #12",
  sessionId: "sess_fixture",
};

export const usageEvent: UsageLimits = {
  observed: {
    session5h: { pct: 40, resetAt: 1_800_000_000_000, scrapedAt: 1_799_999_000_000 },
    week: { pct: 9, resetAt: 1_800_500_000_000, scrapedAt: 1_799_999_000_000 },
  },
  session5h: { pct: 42, resetAt: 1_800_000_000_000 },
  week: { pct: 10, resetAt: 1_800_500_000_000 },
  perModelWeek: [
    { model: "fable", pct: 5, resetAt: null, scrapedAt: 1_799_000_000_000, stale: false },
  ],
  credits: null,
  stale: false,
  calibratedAt: 1_799_000_000_000,
  subscriptionOnly: false,
};

/** No provider sample yet; both observed windows are explicitly null on the wire. */
export const unobservedUsageEvent: UsageLimits = {
  ...usageEvent,
  observed: { session5h: null, week: null },
};
