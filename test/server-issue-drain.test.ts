import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import type { GitForge, Issue } from "../src/forge/types";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(labels: string[] = []) {
  const dir = mkdtempSync(join(config.repoRoot, "issue-drain-test-"));
  roots.push(dir);
  const clone = join(dir, "clone");
  mkdirSync(clone);
  const store = new SessionStore(":memory:");
  store.setRepoConfig(dir, { ...store.getRepoConfig(dir), autoLabel: "custom:auto" });
  let issue: Issue | null = {
    number: 42,
    title: "untrusted",
    body: "secret issue body",
    url: "",
    labels: [...labels],
    createdAt: 0,
    assignees: [],
    state: "open",
  };
  const writes: string[] = [];
  const forge = {
    kind: "github",
    slug: "owner/repo",
    getIssue: async () => issue && { ...issue, labels: [...issue.labels] },
    addIssueLabel: async (_n: number, label: string) => {
      writes.push(`+${label}`);
      issue!.labels.push(label);
    },
    removeIssueLabel: async (_n: number, label: string) => {
      writes.push(`-${label}`);
      issue!.labels = issue!.labels.filter((l) => l !== label);
    },
    hasOpenPrForIssue: async () => false,
  } as unknown as GitForge;
  let refreshes = 0;
  const deps = {
    store,
    service: {},
    usageLimits: { limits: () => ({}) },
    resolveForge: (p: string) => (p === dir || p === clone ? forge : null),
    refreshBacklog: async () => {
      refreshes++;
    },
  } as unknown as AppDeps;
  const app = makeApp(deps);
  const post = (body: unknown, repo = dir, number = "42") =>
    app.fetch(
      new Request(`http://x/api/issues/${number}/drain?repo=${encodeURIComponent(repo)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const session = (repoPath = dir, auto = false) =>
    store.create({
      name: "worker",
      prompt: "",
      repoPath,
      worktreePath: repoPath,
      baseBranch: "main",
      branch: "task",
      isolated: false,
      herdrSession: "h",
      herdrAgentId: "agent",
      claudeSessionId: "claude",
      model: null,
      issueNumber: 42,
      auto,
    });
  return {
    dir,
    clone,
    store,
    forge,
    writes,
    post,
    session,
    get refreshes() {
      return refreshes;
    },
    get issue() {
      return issue;
    },
    set issue(value: Issue | null) {
      issue = value;
    },
  };
}

test("queue uses the configured label, preserves claims and priority, and is idempotent", async () => {
  const h = setup(["shepherd:active", "shepherd:priority"]);
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(200);
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(200);
  expect(h.writes).toEqual(["+custom:auto"]);
  expect((await h.post({ operation: "queue", enabled: false })).status).toBe(200);
  expect(h.issue!.labels).toEqual(["shepherd:active", "shepherd:priority"]);
  expect(h.refreshes).toBeGreaterThan(0);
});

test("priority high/low/normal removes conflicting markers without enqueueing", async () => {
  const h = setup(["shepherd:priority", "shepherd:low-priority", "bug"]);
  for (const [priority, expected] of [
    ["high", ["bug", "shepherd:priority"]],
    ["low", ["bug", "shepherd:low-priority"]],
    ["normal", ["bug"]],
  ] as const) {
    expect((await h.post({ operation: "priority", priority })).status).toBe(200);
    expect([...h.issue!.labels].sort()).toEqual([...expected].sort());
  }
});

test("release removes only orphaned claims and is idempotent", async () => {
  const h = setup(["custom:auto", "shepherd:active", "bug"]);
  const res = await h.post({ operation: "release" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ issueNumber: 42, claimed: false, queued: true });
  expect((await h.post({ operation: "release" })).status).toBe(200);
  expect(h.writes).toEqual(["-shepherd:active"]);
});

test("release refuses manual, auto, paused, done and other-checkout sessions", async () => {
  for (const kind of ["manual", "auto", "blocked", "done", "clone"]) {
    const h = setup(["shepherd:active"]);
    const s = h.session(kind === "clone" ? h.clone : h.dir, kind === "auto");
    if (kind === "blocked" || kind === "done") h.store.update(s.id, { status: kind });
    expect((await h.post({ operation: "release" })).status).toBe(409);
    expect(h.writes).toEqual([]);
  }
});

test("archived sessions do not prevent releasing an orphan", async () => {
  const h = setup(["shepherd:active"]);
  h.store.update(h.session().id, { status: "archived" });
  expect((await h.post({ operation: "release" })).status).toBe(200);
});

test("release rechecks sessions after the PR read", async () => {
  const h = setup(["shepherd:active"]);
  h.forge.hasOpenPrForIssue = async () => {
    h.session();
    return false;
  };
  expect((await h.post({ operation: "release" })).status).toBe(409);
  expect(h.writes).toEqual([]);
});

test("release fails closed on open PRs, missing capability or failed PR reads", async () => {
  for (const kind of ["open", "missing", "failed"]) {
    const h = setup(["shepherd:active"]);
    h.forge.hasOpenPrForIssue =
      kind === "missing"
        ? undefined
        : async () => {
            if (kind === "failed") throw new Error("offline");
            return true;
          };
    expect((await h.post({ operation: "release" })).status).toBe(
      kind === "open" ? 409 : kind === "missing" ? 503 : 502,
    );
    expect(h.writes).toEqual([]);
  }
});

test("invalid inputs and unavailable issue capabilities never write", async () => {
  const h = setup();
  for (const body of [
    null,
    [],
    {},
    { operation: "queue", enabled: "yes" },
    { operation: "release", force: true },
    { operation: "priority", priority: "high", enabled: true },
  ]) {
    expect((await h.post(body)).status).toBe(400);
  }
  expect((await h.post({ operation: "release" }, "/outside")).status).toBe(400);
  for (const n of ["0", "-1", "1.5", "9007199254740992"])
    expect((await h.post({ operation: "release" }, h.dir, n)).status).toBe(400);
  h.issue = null;
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(404);
  h.forge.getIssue = undefined;
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(503);
  expect(h.writes).toEqual([]);
});

test("closed or unverified issue state, reads, and partial writes never report success", async () => {
  const h = setup(["shepherd:priority"]);
  h.issue!.state = "closed";
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(409);
  h.issue!.state = undefined;
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(502);
  h.issue!.state = "open";
  h.forge.addIssueLabel = async () => {
    throw new Error("write failed");
  };
  expect((await h.post({ operation: "priority", priority: "low" })).status).toBe(502);
  h.forge.getIssue = async () => {
    throw new Error("read failed");
  };
  expect((await h.post({ operation: "queue", enabled: true })).status).toBe(502);
});

test("queue and priority reject reserved autoLabel collisions instead of bypassing claim release", async () => {
  for (const autoLabel of ["shepherd:active", "shepherd:priority", "shepherd:low-priority"]) {
    const h = setup(["shepherd:active", "shepherd:priority", "shepherd:low-priority"]);
    h.store.setRepoConfig(h.dir, { ...h.store.getRepoConfig(h.dir), autoLabel });
    h.session();
    for (const operation of [
      { operation: "queue", enabled: false },
      { operation: "queue", enabled: true },
      { operation: "priority", priority: "normal" },
    ]) {
      expect((await h.post(operation)).status).toBe(409);
    }
    expect(h.writes).toEqual([]);
    expect((await h.post({ operation: "release" })).status).toBe(409);
  }
});
