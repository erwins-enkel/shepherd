import type { PlanGate } from "../../src/types";
import type { VisualBlock } from "../../src/visual-blocks";

/** One block of each of the five types the native renderer implements first, plus one the
 *  contract declares and the renderer degrades. Typed with the SERVER's VisualBlock, so a member
 *  rename in src/visual-blocks.ts breaks `bun run typecheck` before it can drift past the
 *  contract. */
export const blocks: VisualBlock[] = [
  { type: "rich-text", id: "b1", markdown: "Adds the token bucket and its tests." },
  { type: "callout", id: "b2", tone: "risk", markdown: "Two call sites bypass the limiter." },
  {
    type: "file-tree",
    id: "b3",
    title: "Touched",
    entries: [
      { path: "src/limiter.ts", change: "modified", note: "the bucket" },
      { path: "src/admin/route.ts", change: "added" },
    ],
  },
  {
    type: "checklist",
    id: "b4",
    items: [
      { id: "i1", label: "wire the admin route", checked: false },
      { id: "i2", label: "document the burst window", checked: true, note: "in README" },
    ],
  },
  {
    type: "question-form",
    id: "b5",
    questions: [
      {
        id: "q1",
        prompt: "Per-IP or per-token?",
        kind: "single",
        options: ["per-IP", "per-token"],
      },
      {
        id: "q2",
        prompt: "Which routes are exempt?",
        kind: "multi",
        options: ["/health", "/metrics"],
      },
      { id: "q3", prompt: "Burst window?", kind: "freeform" },
    ],
  },
  { type: "table", id: "b6", columns: ["route", "limit"], rows: [["/api", "100/m"]] },
];

/** A gate in the state the two actions care about: planning, approved, with open questions. */
export const gate: PlanGate = {
  sessionId: "sess_fixture",
  planHash: "7f2a".repeat(16),
  decision: "approved",
  summary: "Plan is sound; two questions open",
  body: "The bucket design is fine. Two decisions are still open.",
  findings: [],
  round: 1,
  cap: 3,
  approved: true,
  plan: "# Rate limiter\n\nAdd a token bucket in front of the admin route.",
  livePlanHash: "7f2a".repeat(16),
  reviewerProvider: "claude",
  reviewerModel: "claude-opus-5",
  reviewerEffort: "high",
  blocks,
  answeredQuestionKeys: ["b5 q1"],
  finalRoundPending: false,
  updatedAt: 1_800_000_060_000,
};

/** The rework shape at cap, which is what `canShowPlanStallActions` keys on. */
export const stalledGate: PlanGate = {
  ...gate,
  decision: "changes_requested",
  approved: false,
  summary: "Rework requested",
  findings: ["name the exempt routes", "state the burst window"],
  round: 3,
  cap: 3,
  finalRoundPending: false,
};

export const inflight = {
  id: "sess_fixture",
  provider: "claude" as const,
  model: "claude-opus-5",
  effort: "high",
};
