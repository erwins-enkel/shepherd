import type { AutoMergeStatus, MergeWaitCode } from "./types";

// Pure state selection for the terminal "full auto-merge" strip (TASK-1368), mirroring the
// ci-banner.ts / review-banner.ts pattern so the predicates are unit-testable without rendering.
// The server says WHICH full-auto PRs the merge train holds and why (AutoMergeStatus.waiting,
// computed by the same gates that decide the merge); this module only decides who owns the next
// move and whether the strip may claim the bottom slot. It never re-derives full-auto itself.

/** Who makes the next move on a held PR: Shepherd on its own, or the operator. */
export type AutoMergeOwner = "shepherd" | "operator";

export type AutoMergeView =
  | { code: null; show: false; owned: false }
  | {
      code: MergeWaitCode;
      owner: AutoMergeOwner;
      /** The bottom strip renders (no review / CI banner holds the slot). */
      show: boolean;
      /** Shepherd is actively carrying the PR: dim the terminal and relabel the recap. */
      owned: boolean;
    };

export interface AutoMergeViewInput {
  status: AutoMergeStatus | null | undefined;
  sessionId: string;
  /** A critic run for this session is in flight. */
  criticRunning: boolean;
  /** The repo's auto-address loop is on (critic findings are steered to the agent). */
  autoAddressOn: boolean;
  /** The review-in-flight or CI banner already occupies the bottom strip. */
  stripTaken: boolean;
}

/** Codes only the operator can clear — the train holds until someone acts. */
const OPERATOR_CODES: ReadonlySet<MergeWaitCode> = new Set([
  "critic_error",
  "rebase_cap",
  "merge_backoff",
  "manual_steps",
  "stacked",
  "signoff",
  "protection_blocked",
]);

/** Who owns the next move for `code`. Critic findings are Shepherd's only when auto-address
 *  steers them to the agent; otherwise they wait for the operator. */
export function waitOwner(code: MergeWaitCode, autoAddressOn: boolean): AutoMergeOwner {
  if (code === "changes_requested") return autoAddressOn ? "shepherd" : "operator";
  return OPERATOR_CODES.has(code) ? "operator" : "shepherd";
}

/** This session's wait code on the repo's train status, or null when the train doesn't hold it. */
export function waitCodeFor(
  status: AutoMergeStatus | null | undefined,
  sessionId: string,
): MergeWaitCode | null {
  return status?.waiting?.find((w) => w.sessionId === sessionId)?.code ?? null;
}

/**
 * The strip + dim decision. `owned` (dim the terminal, relabel the recap) needs a Shepherd-owned
 * code; for `critic_pending` it additionally needs a critic actually in flight — a pending verdict
 * with no run (cancelled, paused, never started) must not tell the operator "hands off" forever.
 * The strip yields the bottom slot to the review and CI banners, which carry the more specific
 * signal; dimming does not depend on which strip renders.
 */
export function autoMergeView(input: AutoMergeViewInput): AutoMergeView {
  const code = waitCodeFor(input.status, input.sessionId);
  if (!code) return { code: null, show: false, owned: false };
  const owner = waitOwner(code, input.autoAddressOn);
  const owned = owner === "shepherd" && (code !== "critic_pending" || input.criticRunning);
  return { code, owner, show: !input.stripTaken, owned };
}
