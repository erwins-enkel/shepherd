import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getReviews: vi.fn(async () => ({})), getReviewingIds: vi.fn(async () => []) };
});

const { default: RenameAllViewHarness } = await import("./RenameAllViewHarness.svelte");
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
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  };
}

beforeEach(() => {
  reviews.reviewing = {};
  reviews.map = {};
});

describe("all-view tile Rename handoff", () => {
  it("switches from grid tile menu into the selected Viewport rename editor", async () => {
    render(RenameAllViewHarness, {
      sessions: [session({ id: "tile-rename", name: "tile rename target" })],
      nowMs: Date.now(),
    });

    const tile = page.getByRole("button", {
      name: m.unit_open_aria({ name: "tile rename target" }),
    });
    tile.element().dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 60, clientY: 60, bubbles: true }),
    );
    await page.getByRole("menuitem", { name: m.cardmenu_rename() }).click();

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    expect((input.element() as HTMLInputElement).value).toBe("tile rename target");
  });
});
