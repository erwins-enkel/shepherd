import { afterEach, describe, expect, it, vi } from "vitest";

const getSteerLog = vi.fn();
vi.mock("./api", () => ({ getSteerLog: (id: string) => getSteerLog(id) }));

const { steerLogs } = await import("./steerLogs.svelte");

afterEach(() => getSteerLog.mockReset());

describe("steerLogs", () => {
  it("stores a session's log, keeps it on a failed read, and collapses overlapping refreshes", async () => {
    getSteerLog.mockResolvedValueOnce([{ ts: 1, kind: "ci_fix" }]);
    await steerLogs.refresh("a");
    expect(steerLogs.map.a).toEqual([{ ts: 1, kind: "ci_fix" }]);

    getSteerLog.mockRejectedValueOnce(new Error("offline"));
    await steerLogs.refresh("a");
    expect(steerLogs.map.a).toEqual([{ ts: 1, kind: "ci_fix" }]);

    let release!: (v: unknown) => void;
    getSteerLog.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = steerLogs.refresh("b");
    await steerLogs.refresh("b");
    release([]);
    await first;
    expect(getSteerLog).toHaveBeenCalledTimes(3);
    expect(steerLogs.map.b).toEqual([]);
  });
});
