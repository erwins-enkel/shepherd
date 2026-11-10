import { afterEach, describe, expect, it, vi } from "vitest";
import { listScheduleRuns } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("listScheduleRuns", () => {
  it("encodes the schedule ID and unwraps the newest-first runs", async () => {
    const runs = [
      {
        id: 2,
        scheduleId: "a/b ?",
        slotKey: "manual:now",
        outcome: "noop",
        at: 123,
        sessionId: "session-1",
        reason: "Nothing changed",
      },
    ];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ runs })));
    expect(await listScheduleRuns("a/b ?")).toEqual(runs);
    expect(fetch.mock.calls[0][0]).toBe("/api/schedules/a%2Fb%20%3F/runs");
  });

  it("rejects unsuccessful reads instead of reporting an empty history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    await expect(listScheduleRuns("missing")).rejects.toThrow("404");
  });
});
