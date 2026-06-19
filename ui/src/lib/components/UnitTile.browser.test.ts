import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

// Mock api so the reviews store's load() never fires real network calls.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getReviews: vi.fn(async () => ({})), getReviewingIds: vi.fn(async () => []) };
});

const { default: UnitTile } = await import("./UnitTile.svelte");
const { reviews } = await import("$lib/reviews.svelte");

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    ...partial,
  };
}

beforeEach(() => {
  reviews.reviewing = {};
  reviews.map = {};
});

describe("UnitTile badge mutual-exclusion (reviewing vs autopilot)", () => {
  it("reviewing + autopilotPaused: REVIEWING… shown, Needs you hidden", async () => {
    const s = session({ id: "tx1", status: "done", autopilotPaused: true });
    reviews.reviewing = { tx1: true };
    render(UnitTile, {
      session: s,
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByText(m.criticbadge_reviewing())).toBeInTheDocument();
    await expect
      .element(page.getByText(m.session_autopilot_paused_label()))
      .not.toBeInTheDocument();
  });
});
