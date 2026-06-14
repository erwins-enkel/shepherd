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

describe("getOrInitEpicIntegrationBranch (pin-and-record)", () => {
  test("first call on an existing row lazily pins + returns the derived name", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" });
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-efi-cluster")).toBe(
      "epic/327-efi-cluster",
    );
  });

  test("second call returns the PINNED value even when given a different derived (title-edit regression)", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" });
    // first use pins "epic/327-efi-cluster"
    s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-efi-cluster");
    // operator renames the epic mid-run → derived now slugs differently, but the pinned
    // name must stick so already-merged children + the landing base stay consistent.
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-renamed-thing")).toBe(
      "epic/327-efi-cluster",
    );
  });

  test("no epic_run row: returns derived without persisting (best-effort)", () => {
    const s = new SessionStore(":memory:");
    expect(s.getOrInitEpicIntegrationBranch("/repo", 999, "epic/999-x")).toBe("epic/999-x");
    // nothing was written — still no row
    expect(s.getEpicRun("/repo")).toBeNull();
  });

  test("pin is scoped per-repo and survives setEpicRun status churn", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" });
    s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-efi-cluster");
    // a status change re-upserts the row but must NOT clear the pinned branch
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "paused" });
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-anything-else")).toBe(
      "epic/327-efi-cluster",
    );
  });
});
