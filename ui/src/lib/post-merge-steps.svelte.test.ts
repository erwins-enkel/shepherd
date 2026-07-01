import { test, expect, vi, beforeEach } from "vitest";

vi.mock("./api", () => ({
  getOutstandingManualSteps: vi.fn(),
  setManualStepDone: vi.fn(),
  dismissManualSteps: vi.fn(),
}));

import { postMergeSteps } from "./post-merge-steps.svelte";
import { getOutstandingManualSteps } from "./api";

beforeEach(() => {
  postMergeSteps.records = [];
  postMergeSteps.loaded = false;
  postMergeSteps.settled = false;
  vi.clearAllMocks();
});

test("initial state: settled is false before any load", () => {
  expect(postMergeSteps.settled).toBe(false);
});

test("successful load flips both loaded and settled", async () => {
  vi.mocked(getOutstandingManualSteps).mockResolvedValue([]);
  await postMergeSteps.load();
  expect(postMergeSteps.loaded).toBe(true);
  expect(postMergeSteps.settled).toBe(true);
});

test("failed load flips settled but not loaded", async () => {
  vi.mocked(getOutstandingManualSteps).mockRejectedValue(new Error("network error"));
  await postMergeSteps.load();
  expect(postMergeSteps.settled).toBe(true);
  expect(postMergeSteps.loaded).toBe(false);
});
