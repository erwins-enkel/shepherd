import { describe, expect, test } from "vitest";
import { summarizeClearMerged } from "./clear-merged-result";

describe("summarizeClearMerged (#2765)", () => {
  test("a complete run has no failed machine and nothing to retry", () => {
    expect(
      summarizeClearMerged({
        cleared: ["l1", "b1"],
        leftovers: 0,
        partial: false,
        machines: [
          { instanceId: "b", name: "MacBook", ok: true, requested: ["b1"], cleared: ["b1"] },
        ],
      }),
    ).toEqual({ count: 2, failedMachines: [], retryIds: [] });
  });

  test("a partial run names the machines that did not answer and retries only their ids", () => {
    expect(
      summarizeClearMerged({
        cleared: ["l1"],
        leftovers: 0,
        partial: true,
        machines: [
          { instanceId: "b", name: "MacBook", ok: true, requested: ["b1"], cleared: [] },
          {
            instanceId: "c",
            name: "Studio",
            ok: false,
            reason: "disconnected",
            requested: ["c1", "c2"],
            cleared: [],
          },
        ],
      }),
    ).toEqual({ count: 1, failedMachines: ["Studio"], retryIds: ["c1", "c2"] });
  });

  test("an answer without machines (an older server) reads as complete", () => {
    expect(
      summarizeClearMerged({ cleared: ["l1"], leftovers: 0 } as Parameters<
        typeof summarizeClearMerged
      >[0]),
    ).toEqual({ count: 1, failedMachines: [], retryIds: [] });
  });
});
