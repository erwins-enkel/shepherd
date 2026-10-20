import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { queuedEpicRun, type EpicRun } from "../src/epic-core";

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
      ignoreUsageCeiling: false,
      landing: "integration",
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

describe("epic_run.ignoreUsageCeiling", () => {
  const run = (extra: Partial<EpicRun> = {}): EpicRun => ({
    repoPath: "/repo",
    parentIssueNumber: 327,
    mode: "auto",
    status: "running",
    ...extra,
  });

  test("defaults to false", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run());
    expect(s.getEpicRun("/repo")!.ignoreUsageCeiling).toBe(false);
  });

  test("round-trips as a boolean while the run is running", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run({ ignoreUsageCeiling: true }));
    expect(s.getEpicRun("/repo")!.ignoreUsageCeiling).toBe(true);
    expect(s.listEpicRuns()[0]!.ignoreUsageCeiling).toBe(true);
    s.setEpicRun(run({ ignoreUsageCeiling: false }));
    expect(s.getEpicRun("/repo")!.ignoreUsageCeiling).toBe(false);
  });

  test("any write that leaves running clears it", () => {
    for (const status of ["paused", "idle"] as const) {
      const s = new SessionStore(":memory:");
      s.setEpicRun(run({ ignoreUsageCeiling: true }));
      s.setEpicRun(run({ status, ignoreUsageCeiling: true }));
      expect(s.getEpicRun("/repo")!.ignoreUsageCeiling).toBe(false);
    }
  });

  test("another epic taking the run row does not inherit it", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run({ ignoreUsageCeiling: true }));
    s.setEpicRun(run({ parentIssueNumber: 400 }));
    expect(s.getEpicRun("/repo")).toMatchObject({
      parentIssueNumber: 400,
      ignoreUsageCeiling: false,
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
      landing: "integration",
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

describe("epic_run_end (why an epic stopped leading)", () => {
  const run = (parentIssueNumber: number, status: EpicRun["status"]): EpicRun => ({
    repoPath: "/repo",
    parentIssueNumber,
    mode: "auto",
    status,
  });

  test("a start over the leader records it as superseded; leading again clears it", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "running"));
    expect(s.getEpicRunEnd("/repo", 1)).toBeNull();
    const before = Date.now();
    s.setEpicRun(run(2, "running"), { via: "ci-bot" });
    const end = s.getEpicRunEnd("/repo", 1)!;
    expect(end).toMatchObject({ cause: "superseded", successor: 2, via: "ci-bot" });
    expect(end.at).toBeGreaterThanOrEqual(before);
    s.setEpicRun(run(1, "running"));
    expect(s.getEpicRunEnd("/repo", 1)).toBeNull();
    expect(s.getEpicRunEnd("/repo", 2)).toMatchObject({ cause: "superseded", successor: 1 });
  });

  test("ending the leader records ended (via null from the UI); completion records completed", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "running"));
    s.setEpicRun(run(1, "idle"));
    expect(s.getEpicRunEnd("/repo", 1)).toMatchObject({
      cause: "ended",
      successor: null,
      via: null,
    });
    s.setEpicRun(run(1, "running"));
    s.setEpicRun(run(1, "idle"), { completed: true });
    expect(s.getEpicRunEnd("/repo", 1)).toMatchObject({ cause: "completed" });
  });

  test("replacing an idle run records nothing", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "idle"));
    s.setEpicRun(run(2, "idle"));
    expect(s.getEpicRunEnd("/repo", 1)).toBeNull();
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

describe("landing (#3191) survives every run/queue/settings move", () => {
  test("legacy default is integration on run, settings and queue rows", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 1, mode: "auto", status: "idle" });
    expect(s.getEpicRun("/repo")!.landing).toBe("integration");
    s.setEpicSettings({
      repoPath: "/repo",
      parentIssueNumber: 2,
      mode: "auto",
      agentProvider: null,
      model: null,
      effort: null,
    });
    expect(s.getEpicSettings("/repo", 2)!.landing).toBe("integration");
    s.enqueueEpic({
      repoPath: "/repo",
      parentIssueNumber: 3,
      mode: "auto",
      agentProvider: null,
      model: null,
      effort: null,
    });
    expect(s.getEpicQueueEntry("/repo", 3)!.landing).toBe("integration");
    expect(s.listEpicQueue("/repo")[0]!.landing).toBe("integration");
  });

  test("run -> supersede (settings) -> enqueue -> promote keeps incremental", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({
      repoPath: "/repo",
      parentIssueNumber: 1,
      mode: "auto",
      status: "running",
      landing: "incremental",
    });
    expect(s.getEpicRun("/repo")!.landing).toBe("incremental");
    // Another epic takes the row: #1's settings move to epic_settings.
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 2, mode: "auto", status: "running" });
    const saved = s.getEpicSettings("/repo", 1)!;
    expect(saved.landing).toBe("incremental");
    // Queue it from its remembered settings, as enqueueBehindLeader does.
    s.enqueueEpic(saved);
    s.deleteEpicSettings("/repo", 1);
    expect(s.getEpicQueueEntry("/repo", 1)!.landing).toBe("incremental");
    // Promotion: shift the head and start it from its queued settings.
    const head = s.shiftEpicQueue("/repo")!;
    s.setEpicRun({ ...queuedEpicRun(head), status: "running" });
    expect(s.getEpicRun("/repo")).toMatchObject({ parentIssueNumber: 1, landing: "incremental" });
    // And #2 (integration) moved to settings unchanged.
    expect(s.getEpicSettings("/repo", 2)!.landing).toBe("integration");
  });

  test("updateEpicQueueSettings rewrites landing in place", () => {
    const s = new SessionStore(":memory:");
    const e = {
      repoPath: "/repo",
      parentIssueNumber: 5,
      mode: "auto" as const,
      agentProvider: null,
      model: null,
      effort: null,
    };
    s.enqueueEpic(e);
    s.updateEpicQueueSettings({ ...e, landing: "incremental" });
    expect(s.getEpicQueueEntry("/repo", 5)!.landing).toBe("incremental");
  });

  test("a pre-landing database migrates every epic table to integration", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-epic-landing-migrate-"));
    const dbPath = join(dir, "test.db");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE epic_run (
      repoPath TEXT PRIMARY KEY, parentIssueNumber INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'idle', updatedAt INTEGER NOT NULL)`);
    db.run(
      `INSERT INTO epic_run (repoPath, parentIssueNumber, mode, status, updatedAt) VALUES ('/repo', 4, 'auto', 'running', 1)`,
    );
    db.run(`CREATE TABLE epic_queue (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL, position INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto', agentProvider TEXT, model TEXT, effort TEXT,
      createdAt INTEGER NOT NULL, PRIMARY KEY (repoPath, parentIssueNumber))`);
    db.run(
      `INSERT INTO epic_queue (repoPath, parentIssueNumber, position, mode, createdAt) VALUES ('/repo', 5, 1, 'auto', 1)`,
    );
    db.run(`CREATE TABLE epic_settings (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto', agentProvider TEXT, model TEXT, effort TEXT,
      updatedAt INTEGER NOT NULL, PRIMARY KEY (repoPath, parentIssueNumber))`);
    db.run(
      `INSERT INTO epic_settings (repoPath, parentIssueNumber, mode, updatedAt) VALUES ('/repo', 6, 'auto', 1)`,
    );
    db.close();
    try {
      const s = new SessionStore(dbPath);
      expect(s.getEpicRun("/repo")!.landing).toBe("integration");
      expect(s.getEpicQueueEntry("/repo", 5)!.landing).toBe("integration");
      expect(s.getEpicSettings("/repo", 6)!.landing).toBe("integration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
