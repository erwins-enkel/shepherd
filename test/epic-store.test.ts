import { test, expect, describe } from "bun:test";
import { SessionStore } from "../src/store";

describe("epic_run", () => {
  test("absent until set", () =>
    expect(new SessionStore(":memory:").getEpicRun("/repo")).toBeNull());
  test("set+get round-trips (one per repo)", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({
      repoPath: "/repo",
      parentIssueNumber: 327,
      mode: "attended",
      status: "running",
    });
    expect(s.getEpicRun("/repo")).toEqual({
      repoPath: "/repo",
      parentIssueNumber: 327,
      mode: "attended",
      status: "running",
    });
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 400, mode: "auto", status: "idle" }); // replaces
    expect(s.getEpicRun("/repo")!.parentIssueNumber).toBe(400);
  });
});
