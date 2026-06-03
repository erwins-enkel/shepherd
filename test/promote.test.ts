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
