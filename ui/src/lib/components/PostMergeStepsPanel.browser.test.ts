import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { PostMergeSteps } from "$lib/types";
import { m } from "$lib/paraglide/messages";

// Mock api so the store's tick/dismiss never hit the network; capture calls.
const setManualStepDone = vi.fn(
  async (sessionId: string, stepId: string, done: boolean): Promise<PostMergeSteps> => ({
    ...record({ sessionId }),
    steps: [
      { id: "ms1", text: "Set FLAG=1", postMerge: false, doneAt: done ? 1 : null },
      { id: "ms2", text: "rotate secret", postMerge: true, doneAt: null },
    ],
  }),
);
const dismissManualSteps = vi.fn(async (sessionId: string): Promise<PostMergeSteps> => ({
  ...record({ sessionId }),
  clearedAt: Date.now(),
}));
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getOutstandingManualSteps: vi.fn(async () => []),
    setManualStepDone: (...a: [string, string, boolean]) => setManualStepDone(...a),
    dismissManualSteps: (...a: [string]) => dismissManualSteps(...a),
  };
});

const { postMergeSteps } = await import("$lib/post-merge-steps.svelte");
const PostMergeStepsPanel = (await import("./PostMergeStepsPanel.svelte")).default;

function record(p: Partial<PostMergeSteps> & { sessionId: string }): PostMergeSteps {
  return {
    desig: "TASK-09",
    repoPath: "/repo/shepherd",
    prNumber: 12,
    prTitle: "Add the flag",
    steps: [
      { id: "ms1", text: "Set FLAG=1", postMerge: false, doneAt: null },
      { id: "ms2", text: "rotate secret", postMerge: true, doneAt: null },
    ],
    trackingIssueUrl: null,
    trackingIssueNumber: null,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    clearedAt: null,
    ...p,
  };
}

describe("PostMergeStepsPanel", () => {
  beforeEach(() => {
    postMergeSteps.records = [];
    setManualStepDone.mockClear();
    dismissManualSteps.mockClear();
  });

  it("shows the empty state when nothing is owed", async () => {
    render(PostMergeStepsPanel);
    await expect.element(page.getByText(m.owed_empty())).toBeInTheDocument();
  });

  it("renders each owed record's steps with the POST-MERGE badge + count", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    render(PostMergeStepsPanel);
    await expect.element(page.getByText("Set FLAG=1")).toBeInTheDocument();
    await expect.element(page.getByText("rotate secret")).toBeInTheDocument();
    await expect.element(page.getByText("TASK-09")).toBeInTheDocument();
    // POST-MERGE badge appears for the postMerge step (exact: the panel title also contains "Post-merge")
    await expect
      .element(page.getByText(m.owed_post_merge_badge(), { exact: true }))
      .toBeInTheDocument();
    // count "0 of 2 done"
    await expect
      .element(page.getByText(m.owed_steps_count({ done: 0, total: 2 })))
      .toBeInTheDocument();
  });

  it("renders the tracking-issue link when present", async () => {
    postMergeSteps.records = [
      record({ sessionId: "s1", trackingIssueUrl: "https://example.test/issues/9" }),
    ];
    render(PostMergeStepsPanel);
    const link = page.getByText(m.owed_tracking_issue());
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute("href", "https://example.test/issues/9");
  });

  it("ticking a step calls the api with done=true", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    render(PostMergeStepsPanel);
    const boxes = page.getByRole("checkbox");
    await boxes.first().click();
    expect(setManualStepDone).toHaveBeenCalledWith("s1", "ms1", true);
  });

  it("dismiss is arm-then-confirm: first click arms, second confirms (no modal)", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    render(PostMergeStepsPanel);
    const btn = page.getByText(m.owed_dismiss(), { exact: true });
    await btn.click();
    // armed → label switches to the confirm copy; api not called yet
    expect(dismissManualSteps).not.toHaveBeenCalled();
    await expect.element(page.getByText(m.owed_dismiss_confirm())).toBeInTheDocument();
    await page.getByText(m.owed_dismiss_confirm()).click();
    expect(dismissManualSteps).toHaveBeenCalledWith("s1");
  });
});
