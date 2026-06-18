import { test, expect } from "bun:test";
import { upsertLearningsBlock, LEARNINGS_START, LEARNINGS_END } from "../src/promote";

test("upsertLearningsBlock appends a block when none exists", () => {
  const out = upsertLearningsBlock("# Repo\n\nintro\n", ["use bun", "rebase onto main"]);
  expect(out).toContain(LEARNINGS_START);
  expect(out).toContain("- use bun");
  expect(out).toContain("- rebase onto main");
  expect(out.trimEnd().endsWith(LEARNINGS_END)).toBe(true);
});

test("upsertLearningsBlock replaces block contents idempotently", () => {
  const first = upsertLearningsBlock("# Repo\n", ["a"]);
  const second = upsertLearningsBlock(first, ["a"]);
  expect(second).toBe(first); // applying same rules twice is a no-op
  const third = upsertLearningsBlock(first, ["a", "b"]);
  expect(third).toContain("- b");
  // exactly one managed block, never duplicated
  expect(third.split(LEARNINGS_START).length - 1).toBe(1);
  expect(third.split(LEARNINGS_END).length - 1).toBe(1);
});

test("upsertLearningsBlock handles empty file", () => {
  const out = upsertLearningsBlock("", ["only rule"]);
  expect(out.startsWith(LEARNINGS_START)).toBe(true);
});

import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Promoter } from "../src/promote";
import { SessionStore } from "../src/store";

function fakeForge(over: Partial<any> = {}) {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    defaultBranch: async () => "main",
    openPr: async () => ({
      state: "open",
      number: 7,
      url: "https://pr/7",
      checks: "none",
      deployConfigured: false,
    }),
    ...over,
  } as never;
}

test("Promoter.promote opens a PR and marks the rule promoted", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({
    repoPath: "/r",
    rule: "rebase onto main",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-test-"));
  const gitCalls: string[][] = [];
  const removed: string[] = [];

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({
        worktreePath: wtDir,
        branch: "shepherd/learnings-promote-x",
        isolated: true,
      }),
      remove: (path: string) => removed.push(path),
    },
    resolveForge: () => fakeForge(),
    git: async (_cwd, args) => {
      gitCalls.push(args);
    },
  });

  const res = await p.promote(l.id);
  expect(res).toEqual({ ok: true, url: "https://pr/7" });
  expect(store.getLearning(l.id)!.status).toBe("promoted");
  expect(store.getLearning(l.id)!.promotedPrUrl).toBe("https://pr/7");
  expect(readFileSync(join(wtDir, "CLAUDE.md"), "utf8")).toContain("- rebase onto main");
  expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
  expect(removed).toContain(wtDir);
  // local branch force-deleted on cleanup (the pushed remote branch backs the PR)
  expect(gitCalls).toContainEqual(["branch", "-D", "shepherd/learnings-promote-x"]);
});

test("Promoter.promote falls back to the local base ref when origin/<base> is unavailable", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "stay linear", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-fallback-"));
  const baseRefs: string[] = [];
  const p = new Promoter({
    store,
    worktree: {
      // origin/main unavailable (offline); local main works — mirrors worktree.create
      // now throwing on an unresolvable base ref rather than returning isolated:false.
      create: (_repo: string, baseRef: string) => {
        baseRefs.push(baseRef);
        if (baseRef !== "main") throw new Error(`invalid reference: ${baseRef}`);
        return { worktreePath: wtDir, branch: "shepherd/fallback", isolated: true };
      },
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(true);
  // tried origin/<base> first (hygiene), then fell back to the local base ref
  expect(baseRefs).toEqual(["origin/main", "main"]);
  expect(store.getLearning(l.id)!.status).toBe("promoted");
});

test("Promoter.promote rejects non-active rules", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/x", branch: "b", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(409);
});

test("Promoter.promote 400s when no forge configured", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/x", branch: "b", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => null,
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(400);
});

test("Promoter.promote returns a generic 500 (not raw git stderr) on failure", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "y", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-fail-"));
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "shepherd/x", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async (_cwd, args) => {
      if (args[0] === "push") throw new Error("fatal: remote rejected [secret-token-in-stderr]");
    },
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(500);
    expect(res.error).toBe("promote failed"); // no raw stderr leaked to the client
  }
  // rule stays active (not wedged) so a retry can succeed
  expect(store.getLearning(l.id)!.status).toBe("active");
});

test("Promoter.promote rejects a concurrent double-click with 409", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "z", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-race-"));
  let releaseForge: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseForge = resolve));
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "shepherd/z", isolated: true }),
      remove: () => {},
    },
    // hold the first promote inside its first await so the second click overlaps it
    resolveForge: () => fakeForge({ defaultBranch: async () => (await gate, "main") }),
    git: async () => {},
  });
  const first = p.promote(l.id);
  const second = await p.promote(l.id); // claim was synchronous → this sees in-flight
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.status).toBe(409);
  releaseForge();
  const firstRes = await first;
  expect(firstRes.ok).toBe(true);
});

// --- resyncPromoted tests ---

test("Promoter.resyncPromoted rebuilds block and opens a PR", async () => {
  const store = new SessionStore(":memory:");
  const l1 = store.addLearning({
    repoPath: "/repo",
    rule: "rule one",
    rationale: "",
    evidence: [],
  });
  const l2 = store.addLearning({
    repoPath: "/repo",
    rule: "rule two",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(l1.id, "active");
  store.setLearningStatus(l1.id, "promoted");
  store.setLearningStatus(l2.id, "active");
  store.setLearningStatus(l2.id, "promoted");

  const wtDir = mkdtempSync(join(tmpdir(), "resync-test-"));
  const gitCalls: string[][] = [];
  const removed: string[] = [];
  let prOpened = false;

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "learnings-resync-abcd1234", isolated: true }),
      remove: (path: string) => removed.push(path),
    },
    resolveForge: () =>
      fakeForge({
        openPr: async () => {
          prOpened = true;
          return {
            state: "open",
            number: 8,
            url: "https://pr/8",
            checks: "none",
            deployConfigured: false,
          };
        },
      }),
    git: async (_cwd, args) => {
      gitCalls.push(args);
    },
    // start with stale CLAUDE.md (no learnings block)
    readClaudeMd: () => "# Repo\n\nsome existing content\n",
    writeClaudeMd: () => {},
  });

  const res = await p.resyncPromoted("/repo");
  expect(res).toEqual({ ok: true, url: "https://pr/8" });
  expect(prOpened).toBe(true);
  expect(gitCalls.some((a) => a[0] === "commit")).toBe(true);
  expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
  // no DB status transition — rules stay promoted
  expect(store.getLearning(l1.id)!.status).toBe("promoted");
  expect(store.getLearning(l2.id)!.status).toBe("promoted");
  // cleanup ran
  expect(removed).toContain(wtDir);
});

test("Promoter.resyncPromoted is a no-op when CLAUDE.md already has the current block", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({
    repoPath: "/repo2",
    rule: "stay linear",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(l.id, "active");
  store.setLearningStatus(l.id, "promoted");

  const gitCalls: string[][] = [];
  let prOpened = false;

  // Precompute what the block should look like
  const { upsertLearningsBlock: ulb } = await import("../src/promote");
  const upToDate = ulb("# Repo\n\n", ["stay linear"]);

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/wt2", branch: "learnings-resync-xyz", isolated: true }),
      remove: () => {},
    },
    resolveForge: () =>
      fakeForge({
        openPr: async () => {
          prOpened = true;
          return {
            state: "open",
            number: 9,
            url: "https://pr/9",
            checks: "none",
            deployConfigured: false,
          };
        },
      }),
    git: async (_cwd, args) => {
      gitCalls.push(args);
    },
    readClaudeMd: () => upToDate,
    writeClaudeMd: () => {},
  });

  const res = await p.resyncPromoted("/repo2");
  expect(res).toEqual({ ok: true, url: "" });
  expect(prOpened).toBe(false);
  expect(gitCalls.some((a) => a[0] === "commit")).toBe(false);
});

test("Promoter.resyncPromoted returns no-op when no promoted rules exist", async () => {
  const store = new SessionStore(":memory:");
  // no learnings added for /repo3
  let worktreeCreated = false;

  const p = new Promoter({
    store,
    worktree: {
      create: () => {
        worktreeCreated = true;
        return { worktreePath: "/wt3", branch: "b", isolated: true };
      },
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });

  const res = await p.resyncPromoted("/repo3");
  expect(res).toEqual({ ok: true, url: "" });
  expect(worktreeCreated).toBe(false);
});

test("Promoter.resyncPromoted rejects a concurrent call for the same repo with 409", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/repo4", rule: "rule x", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  store.setLearningStatus(l.id, "promoted");

  const wtDir = mkdtempSync(join(tmpdir(), "resync-race-"));
  let releaseForge: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseForge = resolve));

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "learnings-resync-racetest", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge({ defaultBranch: async () => (await gate, "main") }),
    git: async () => {},
    readClaudeMd: () => "",
    writeClaudeMd: () => {},
  });

  const first = p.resyncPromoted("/repo4");
  const second = await p.resyncPromoted("/repo4"); // inflight → 409
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.status).toBe(409);
  releaseForge();
  const firstRes = await first;
  expect(firstRes.ok).toBe(true);
});
