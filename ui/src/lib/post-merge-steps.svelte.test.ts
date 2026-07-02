import { test, expect, vi, beforeEach } from "vitest";

vi.mock("./api", () => ({
  getOutstandingManualSteps: vi.fn(),
  setManualStepDone: vi.fn(),
  dismissManualSteps: vi.fn(),
}));

import { postMergeSteps, owedRecordsForRepo } from "./post-merge-steps.svelte";
import { getOutstandingManualSteps } from "./api";
import type { PostMergeSteps } from "./types";

const rec = (sessionId: string, repoPath: string): PostMergeSteps => ({
  sessionId,
  desig: sessionId,
  repoPath,
  prNumber: null,
  prTitle: "",
  steps: [],
  trackingIssueUrl: null,
  trackingIssueNumber: null,
  createdAt: 0,
  updatedAt: 0,
  clearedAt: null,
});

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

test("owedRecordsForRepo: null filter returns records unchanged (same ref)", () => {
  const records = [rec("a", "/repo/x"), rec("b", "/repo/y")];
  expect(owedRecordsForRepo(records, null)).toBe(records);
});

test("owedRecordsForRepo: keeps only records matching the active repo path", () => {
  const records = [rec("a", "/repo/x"), rec("b", "/repo/y"), rec("c", "/repo/x")];
  const out = owedRecordsForRepo(records, "/repo/x");
  expect(out.map((r) => r.sessionId)).toEqual(["a", "c"]);
});

test("owedRecordsForRepo: no match yields empty list", () => {
  const records = [rec("a", "/repo/x")];
  expect(owedRecordsForRepo(records, "/repo/z")).toEqual([]);
});
