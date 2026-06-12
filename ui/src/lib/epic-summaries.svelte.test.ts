import { test, expect, vi, beforeEach, afterEach } from "vitest";
import type { EpicSummary } from "./types";

const getEpics = vi.fn<(repoPath: string) => Promise<EpicSummary[]>>();
vi.mock("./api", () => ({ getEpics: (repoPath: string) => getEpics(repoPath) }));

// import after the mock is registered
const { epicSummaries } = await import("./epic-summaries.svelte");

function S(parentIssueNumber: number): EpicSummary {
  return {
    parentIssueNumber,
    parentTitle: `epic #${parentIssueNumber}`,
    total: 3,
    merged: 1,
    status: "running",
  };
}

beforeEach(() => {
  getEpics.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  // reset cache + throttle between tests (singleton)
  epicSummaries.byRepo = {};
  // @ts-expect-error private — clear throttle stamps
  epicSummaries.lastFetchedAt = {};
});

afterEach(() => {
  vi.useRealTimers();
});

test("refresh fetches and lookup resolves by parentIssueNumber", async () => {
  getEpics.mockResolvedValue([S(327), S(400)]);
  await epicSummaries.refresh(["repo/a"]);
  expect(getEpics).toHaveBeenCalledTimes(1);
  expect(epicSummaries.lookup("repo/a", 327)).toEqual(S(327));
  expect(epicSummaries.lookup("repo/a", 999)).toBeUndefined();
});

test("throttles within THROTTLE_MS, re-fetches after it elapses", async () => {
  getEpics.mockResolvedValue([S(327)]);
  await epicSummaries.refresh(["repo/a"]);
  expect(getEpics).toHaveBeenCalledTimes(1);

  // within window → no new fetch
  vi.setSystemTime(44_999);
  await epicSummaries.refresh(["repo/a"]);
  expect(getEpics).toHaveBeenCalledTimes(1);

  // past window → fetch again
  vi.setSystemTime(45_000);
  await epicSummaries.refresh(["repo/a"]);
  expect(getEpics).toHaveBeenCalledTimes(2);
});

test("dedupes duplicate repoPaths in one call", async () => {
  getEpics.mockResolvedValue([S(327)]);
  await epicSummaries.refresh(["repo/a", "repo/a"]);
  expect(getEpics).toHaveBeenCalledTimes(1);
});

test("a rejecting repo doesn't throw and doesn't corrupt other cached entries", async () => {
  // seed repo/a successfully
  getEpics.mockResolvedValueOnce([S(327)]);
  await epicSummaries.refresh(["repo/a"]);
  expect(epicSummaries.lookup("repo/a", 327)).toEqual(S(327));

  // advance past throttle; repo/a rejects, repo/b succeeds
  vi.setSystemTime(45_000);
  getEpics.mockImplementation(async (repo: string) => {
    if (repo === "repo/a") throw new Error("boom");
    return [S(500)];
  });
  await expect(epicSummaries.refresh(["repo/a", "repo/b"])).resolves.toBeUndefined();

  // repo/a's prior good entry survives; repo/b populated
  expect(epicSummaries.lookup("repo/a", 327)).toEqual(S(327));
  expect(epicSummaries.lookup("repo/b", 500)).toEqual(S(500));
});
