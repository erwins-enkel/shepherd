import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapExitReached,
  bootstrapMissing,
  bootstrapSessionPhase,
  hasProjectManifest,
  heldAdvanceTarget,
  phaseAfterBootstrapMerge,
  postMergeCi,
  type RepoBootstrap,
} from "../src/bootstrap";
import type { ForgeRun } from "../src/forge/types";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";

const active = (phase: number, overrideAt: number | null = null): RepoBootstrap => ({
  state: "active",
  phase,
  overrideAt,
  ciPendingAt: null,
});

describe("bootstrapMissing", () => {
  test("off and done never gate", () => {
    expect(
      bootstrapMissing({ state: "off", phase: 1, overrideAt: null, ciPendingAt: null }, []),
    ).toBeNull();
    expect(
      bootstrapMissing({ state: "done", phase: 5, overrideAt: null, ciPendingAt: null }, ["ci"]),
    ).toBeNull();
  });
  test("an override lifts the gate", () => {
    expect(bootstrapMissing(active(1, 123), [])).toBeNull();
  });
  test("lists the incomplete phases, then the red must-haves", () => {
    expect(bootstrapMissing(active(1), [])).toEqual(["P1", "P2", "P3", "P4"]);
    expect(bootstrapMissing(active(3), ["ci"])).toEqual(["P3", "P4", "ci"]);
    expect(bootstrapMissing(active(5), ["ci"])).toEqual(["ci"]);
  });
});

describe("bootstrapSessionPhase", () => {
  test("P3 only once an active repo reached phase 3", () => {
    expect(bootstrapSessionPhase(active(1))).toBe(1);
    expect(bootstrapSessionPhase(active(2))).toBe(1);
    expect(bootstrapSessionPhase(active(3))).toBe(3);
    expect(bootstrapSessionPhase(active(4))).toBe(3);
    expect(
      bootstrapSessionPhase({ state: "off", phase: 3, overrideAt: null, ciPendingAt: null }),
    ).toBe(1);
    expect(
      bootstrapSessionPhase({ state: "done", phase: 5, overrideAt: null, ciPendingAt: null }),
    ).toBe(1);
  });
});

describe("phaseAfterBootstrapMerge", () => {
  test("P1+P2 merge → 3, P3 merge → 4", () => {
    expect(phaseAfterBootstrapMerge(active(1), 1)).toBe(3);
    expect(phaseAfterBootstrapMerge(active(2), 1)).toBe(3);
    expect(phaseAfterBootstrapMerge(active(3), 3)).toBe(4);
  });
  test("never lowers the phase; inactive repos are untouched", () => {
    expect(phaseAfterBootstrapMerge(active(3), 1)).toBeNull();
    expect(phaseAfterBootstrapMerge(active(5), 3)).toBeNull();
    expect(
      phaseAfterBootstrapMerge({ state: "off", phase: 1, overrideAt: null, ciPendingAt: null }, 1),
    ).toBeNull();
    expect(
      phaseAfterBootstrapMerge({ state: "done", phase: 5, overrideAt: null, ciPendingAt: null }, 3),
    ).toBeNull();
  });
});

describe("heldAdvanceTarget", () => {
  test("P1+P2 → 3, P3 → 4, nothing past P3", () => {
    expect(heldAdvanceTarget(active(1))).toBe(3);
    expect(heldAdvanceTarget(active(2))).toBe(3);
    expect(heldAdvanceTarget(active(3))).toBe(4);
    expect(heldAdvanceTarget(active(4))).toBeNull();
  });
});

describe("postMergeCi (#3411)", () => {
  const MIN = 60_000;
  const since = 100 * MIN;
  const run = (o: Partial<ForgeRun>): ForgeRun => ({
    id: 1,
    workflowName: "ci",
    workflowFile: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    attempt: 1,
    headSha: "new",
    createdAt: since,
    url: "",
    ...o,
  });

  test("no run since the merge → waiting", () => {
    expect(postMergeCi([], since)).toBe("waiting");
    expect(postMergeCi([run({ createdAt: since - 31 * MIN })], since)).toBe("waiting");
  });
  test("a run created shortly before the observed merge still counts (skew)", () => {
    expect(postMergeCi([run({ createdAt: since - 5 * MIN })], since)).toBe("green");
  });
  test("judges only the newest head", () => {
    const old = run({ headSha: "old", createdAt: since - MIN, conclusion: "failure" });
    expect(postMergeCi([old, run({ createdAt: since + MIN })], since)).toBe("green");
    const oldOk = run({ headSha: "old", createdAt: since - MIN });
    expect(postMergeCi([oldOk, run({ conclusion: "failure" })], since)).toBe("failed");
  });
  test("a 0-job workflow-file-issue run fails; startup_failure fails", () => {
    expect(postMergeCi([run({ conclusion: "failure" })], since)).toBe("failed");
    expect(postMergeCi([run({ conclusion: "startup_failure" })], since)).toBe("failed");
  });
  test("in progress → waiting, unless a finished one already failed", () => {
    const busy = run({ id: 2, status: "in_progress", conclusion: null });
    expect(postMergeCi([run({}), busy], since)).toBe("waiting");
    expect(postMergeCi([run({ conclusion: "failure" }), busy], since)).toBe("failed");
  });
  test("success, skipped and neutral are green", () => {
    const runs = [
      run({}),
      run({ id: 2, conclusion: "skipped" }),
      run({ id: 3, conclusion: "neutral" }),
    ];
    expect(postMergeCi(runs, since)).toBe("green");
  });
});

describe("bootstrapExitReached", () => {
  test("needs phase 5 AND no red must-have", () => {
    expect(bootstrapExitReached(active(5), [])).toBe(true);
    expect(bootstrapExitReached(active(5), ["ci"])).toBe(false);
    expect(bootstrapExitReached(active(4), [])).toBe(false);
    expect(
      bootstrapExitReached({ state: "off", phase: 5, overrideAt: null, ciPendingAt: null }, []),
    ).toBe(false);
  });
});

describe("hasProjectManifest", () => {
  test("detects package.json / Cargo.toml, else false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-manifest-"));
    try {
      expect(await hasProjectManifest(dir)).toBe(false);
      writeFileSync(join(dir, "Cargo.toml"), "");
      expect(await hasProjectManifest(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore repo bootstrap", () => {
  test("defaults to off; off deletes the row", () => {
    const s = new SessionStore(":memory:");
    expect(s.getRepoBootstrap("/r")).toEqual({
      state: "off",
      phase: 1,
      overrideAt: null,
      ciPendingAt: null,
    });
    s.setRepoBootstrap("/r", { state: "active", phase: 2 });
    expect(s.getRepoBootstrap("/r")).toEqual({
      state: "active",
      phase: 2,
      overrideAt: null,
      ciPendingAt: null,
    });
    s.setRepoBootstrap("/r", { state: "off", phase: 1 });
    expect(s.getRepoBootstrap("/r").state).toBe("off");
  });

  test("bootstrap state never creates a repo_config row", () => {
    const s = new SessionStore(":memory:");
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.automationRowExists("/r")).toBe(false);
  });

  test("override only applies while active; a phase move keeps it, a state change clears it", () => {
    const s = new SessionStore(":memory:");
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(false);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(true);
    expect(s.getRepoBootstrap("/r").overrideAt).not.toBeNull();
    s.setRepoBootstrap("/r", { state: "active", phase: 2 });
    expect(s.getRepoBootstrap("/r").overrideAt).not.toBeNull();
    s.setRepoBootstrap("/r", { state: "done", phase: 5 });
    expect(s.getRepoBootstrap("/r").overrideAt).toBeNull();
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(false);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(true);
    expect(s.setRepoBootstrapOverride("/r", false)).toBe(true);
    expect(s.getRepoBootstrap("/r").overrideAt).toBeNull();
  });

  test("phaseAt restarts on a phase move or entering active, never on an override (#3112)", () => {
    const s = new SessionStore(":memory:");
    const db = (s as unknown as { db: Database }).db;
    const phaseAt = () => s.listActiveRepoBootstraps()[0]?.phaseAt;
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    db.run(`UPDATE repo_bootstrap SET phaseAt = 1`);
    s.setRepoBootstrapOverride("/r", true);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(phaseAt()).toBe(1);
    s.setRepoBootstrap("/r", { state: "active", phase: 3 });
    expect(phaseAt()).toBeGreaterThan(1);
    expect(s.listActiveRepoBootstraps()).toEqual([
      { repoPath: "/r", phase: 3, phaseAt: phaseAt()!, ciPendingAt: null },
    ]);
    s.setRepoBootstrap("/r", { state: "done", phase: 5 });
    expect(s.listActiveRepoBootstraps()).toEqual([]);
  });

  test("a held CI advance is set on active rows and cleared by a phase or state move (#3411)", () => {
    const s = new SessionStore(":memory:");
    s.setBootstrapCiPending("/r", 5, "s1");
    expect(s.getRepoBootstrap("/r").ciPendingAt).toBeNull();
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    s.setBootstrapCiPending("/r", 5, "s1");
    expect(s.getRepoBootstrap("/r").ciPendingAt).toBe(5);
    expect(s.getBootstrapCiPendingSession("/r")).toBe("s1");
    expect(s.listActiveRepoBootstraps()[0]?.ciPendingAt).toBe(5);
    s.setRepoBootstrapOverride("/r", true);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.getRepoBootstrap("/r").ciPendingAt).toBe(5);
    s.setRepoBootstrap("/r", { state: "active", phase: 3 });
    expect(s.getRepoBootstrap("/r").ciPendingAt).toBeNull();
    expect(s.getBootstrapCiPendingSession("/r")).toBeNull();
  });

  test("phaseAt migration backfills updatedAt on a legacy table (#3112)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-mig-"));
    try {
      const file = join(dir, "s.db");
      const raw = new Database(file);
      raw.run(`CREATE TABLE repo_bootstrap (repoPath TEXT PRIMARY KEY, state TEXT NOT NULL,
        phase INTEGER NOT NULL DEFAULT 1, overrideAt INTEGER, updatedAt INTEGER NOT NULL)`);
      raw.run(`INSERT INTO repo_bootstrap VALUES ('/r', 'active', 3, NULL, 42)`);
      raw.close();
      const s = new SessionStore(file);
      expect(s.listActiveRepoBootstraps()).toEqual([
        { repoPath: "/r", phase: 3, phaseAt: 42, ciPendingAt: null },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reconcile facts: merged bootstrap sessions + approved epic drafts since (#3112)", () => {
    const s = new SessionStore(":memory:");
    const base = {
      name: "b",
      prompt: "p",
      repoPath: "/r",
      baseBranch: "main",
      branch: "b",
      worktreePath: "/w",
      isolated: true,
      herdrSession: "default",
    };
    const p1 = s.create({ ...base, herdrAgentId: "a1", bootstrapPhase: 1 });
    const p3 = s.create({ ...base, herdrAgentId: "a3", bootstrapPhase: 3 });
    const epic = s.create({ ...base, herdrAgentId: "a4" });
    expect(s.bootstrapSessionMergedAt("/r", 1, 0)).toBeNull();
    s.archive(p1.id, "merged");
    s.archive(p3.id, "operator");
    expect(s.bootstrapSessionMergedAt("/r", 1, 0)).toEqual({
      at: s.get(p1.id)!.archivedAt!,
      id: p1.id,
    });
    expect(s.bootstrapSessionMergedAt("/r", 1, Date.now() + 60_000)).toBeNull();
    expect(s.bootstrapSessionMergedAt("/other", 1, 0)).toBeNull();
    expect(s.bootstrapSessionMergedAt("/r", 3, 0)).toBeNull();
    s.replaceEpicDraft(epic.id, {
      parent: { title: "t", body: "b", acceptanceCriteria: [], nonGoals: [] },
      children: [],
    });
    expect(s.epicDraftApprovedAt("/r", 0)).toBeNull();
    s.setEpicDraftApproved(epic.id, 7, "u");
    expect(s.epicDraftApprovedAt("/r", 0)).toEqual(expect.any(Number));
    expect(s.epicDraftApprovedAt("/r", Date.now() + 60_000)).toBeNull();
  });
});
