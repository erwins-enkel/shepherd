import { test, expect, describe } from "bun:test";
import { SessionStore } from "../src/store";
import type { EpicRun } from "../src/epic-core";

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
      agentProvider: null,
      model: null,
      effort: null,
    });
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 400, mode: "auto", status: "idle" }); // replaces
    expect(s.getEpicRun("/repo")!.parentIssueNumber).toBe(400);
  });

  test("provider/model/effort round-trip and clear to inherit", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({
      repoPath: "/repo",
      parentIssueNumber: 327,
      mode: "auto",
      status: "running",
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(s.getEpicRun("/repo")).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    s.setEpicRun({
      repoPath: "/repo",
      parentIssueNumber: 327,
      mode: "auto",
      status: "running",
      agentProvider: null,
      model: "gpt-5.5",
      effort: "high",
    });
    expect(s.getEpicRun("/repo")).toMatchObject({
      agentProvider: null,
      model: null,
      effort: null,
    });
  });
});

describe("epic_settings (an epic off the run row)", () => {
  const run = (parentIssueNumber: number, extra: Partial<EpicRun> = {}): EpicRun => ({
    repoPath: "/repo",
    parentIssueNumber,
    mode: "auto",
    status: "running",
    ...extra,
  });

  test("absent until set; set+get round-trips and clears model/effort without a provider", () => {
    const s = new SessionStore(":memory:");
    expect(s.getEpicSettings("/repo", 7)).toBeNull();
    s.setEpicSettings({
      repoPath: "/repo",
      parentIssueNumber: 7,
      mode: "attended",
      agentProvider: null,
      model: "opus",
      effort: "high",
    });
    expect(s.getEpicSettings("/repo", 7)).toEqual({
      repoPath: "/repo",
      parentIssueNumber: 7,
      mode: "attended",
      agentProvider: null,
      model: null,
      effort: null,
    });
    s.deleteEpicSettings("/repo", 7);
    expect(s.getEpicSettings("/repo", 7)).toBeNull();
  });

  test("setEpicRun moves the previous epic's settings off the row and drops the new epic's", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, { mode: "attended", agentProvider: "codex", model: "gpt-5.5" }));
    s.setEpicSettings({
      repoPath: "/repo",
      parentIssueNumber: 2,
      mode: "auto",
      agentProvider: "claude",
      model: "opus",
      effort: null,
    });
    s.setEpicRun(run(2, { agentProvider: "claude", model: "opus" }));
    expect(s.getEpicSettings("/repo", 1)).toMatchObject({
      mode: "attended",
      agentProvider: "codex",
      model: "gpt-5.5",
    });
    expect(s.getEpicSettings("/repo", 2)).toBeNull();
  });

  test("setEpicRun for the same epic leaves remembered settings untouched elsewhere", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1));
    s.setEpicRun(run(1, { status: "idle" }));
    expect(s.getEpicSettings("/repo", 1)).toBeNull();
  });
});

describe("getOrInitEpicIntegrationBranch (pin-and-record)", () => {
  test("first call pins + returns the derived name", () => {
    const s = new SessionStore(":memory:");
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-efi-cluster")).toBe(
      "epic/327-efi-cluster",
    );
  });

  test("second call returns the PINNED value even when given a different derived (title-edit regression)", () => {
    const s = new SessionStore(":memory:");
    // first use pins "epic/327-efi-cluster"
    s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-efi-cluster");
    // operator renames the epic mid-run → derived now slugs differently, but the pinned
    // name must stick so already-merged children + the landing base stay consistent.
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-renamed-thing")).toBe(
      "epic/327-efi-cluster",
    );
  });

  test("the pin is independent of epic_run lifecycle (persists with no epic_run row)", () => {
    const s = new SessionStore(":memory:");
    // No setEpicRun — the pin lives in its own per-epic table, so it persists regardless.
    expect(s.getOrInitEpicIntegrationBranch("/repo", 999, "epic/999-x")).toBe("epic/999-x");
    expect(s.getEpicRun("/repo")).toBeNull(); // pinning did not fabricate an epic_run row
    // and a later derive (e.g. at landing, after a title edit) still returns the pinned name
    expect(s.getOrInitEpicIntegrationBranch("/repo", 999, "epic/999-renamed")).toBe("epic/999-x");
  });

  test("pin survives setEpicRun status churn (not stored on epic_run)", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" });
    s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-efi-cluster");
    // a status change re-upserts the epic_run row but must NOT affect the pinned branch
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "paused" });
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-anything-else")).toBe(
      "epic/327-efi-cluster",
    );
  });

  test("a second epic superseding the same repo gets its OWN pin (no inheritance); the first epic's pin survives for its landing", () => {
    const s = new SessionStore(":memory:");
    // Epic A runs on /repo and pins its branch.
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" });
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-alpha")).toBe("epic/327-alpha");
    // Epic B supersedes the repo's single epic_run row (server replaces parentIssueNumber).
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 400, mode: "auto", status: "running" });
    // B must NOT inherit A's pin — it pins its own branch...
    expect(s.getOrInitEpicIntegrationBranch("/repo", 400, "epic/400-beta")).toBe("epic/400-beta");
    // ...and A's pin is still retrievable (e.g. for A's still-pending landing PR).
    expect(s.getOrInitEpicIntegrationBranch("/repo", 327, "epic/327-whatever-now")).toBe(
      "epic/327-alpha",
    );
  });
});
