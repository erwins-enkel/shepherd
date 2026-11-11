import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DrainService } from "../src/drain";
import { SessionStore } from "../src/store";
import { RepoConfigService } from "../src/repo-config-service";
import { RepoLeitrechnerService } from "../src/repo-leitrechner";
import { instanceIdentity } from "../src/remote-instances/identity";
import { configRepo, git } from "./helpers/repo-config-git";
import type { GitForge, Issue } from "../src/forge/types";
import type { StandardCreateInput } from "../src/types";
import { StandalonePrCriticService } from "../src/standalone-critic";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  __setApiKeyConfigDirProvisionForTest(null);
});

function fixture() {
  const r = configRepo();
  cleanup.push(() => r.close());
  let now = Date.now();
  const rows = new Map<string, { name: string; status: string }>();
  function node(repo: string, db: string) {
    const store = new SessionStore(db);
    store.setRepoConfig(repo, {
      ...store.getRepoConfig(repo),
      sandboxProfile: "trusted",
      maxAuto: 1,
    });
    const events: unknown[] = [];
    const identity = instanceIdentity(store);
    const leitrechner = new RepoLeitrechnerService({
      config: (p) => store.getRepoConfig(p),
      self: () => identity,
      remote: (id) => rows.get(id) ?? null,
      now: () => now,
      emit: (repoPath, leitrechnerStatus) => events.push({ repoPath, leitrechnerStatus }),
    });
    const cfg = new RepoConfigService(store, () => "trusted", leitrechner);
    const creates: StandardCreateInput[] = [];
    const issues: Issue[] = [
      {
        number: 1,
        title: "Task",
        body: "Task body",
        url: "https://example.invalid/1",
        labels: ["shepherd:auto"],
        createdAt: 0,
        assignees: [],
      },
    ];
    const claims: number[] = [];
    let listed = 0;
    const forge = {
      kind: "github",
      slug: "test/repo",
      mergeMethod: "squash",
      deployWorkflow: null,
      // Deliberately no shared active-label memory: ownership must prevent the race itself.
      listIssues: async () => {
        listed++;
        return issues;
      },
      getIssue: async () => issues[0],
      addIssueLabel: async (n: number) => {
        claims.push(n);
      },
      removeIssueLabel: async () => {},
      defaultBranch: async () => "main",
      listPullRequests: async () => [
        {
          number: 9,
          title: "PR",
          url: "https://example.invalid/9",
          author: "alice",
          kind: "regular",
          createdAt: 0,
          isDraft: false,
          mergeable: true,
          checks: "success",
          jobs: [],
          headSha: "abc",
          headRefName: "feature/pr",
        },
      ],
      prReviewMeta: async () => ({
        state: "open",
        body: "PR",
        baseRefName: "main",
        isCrossRepository: false,
      }),
    } as unknown as GitForge;
    const drain = new DrainService({
      rebaseCap: 5,
      store,
      leitrechner,
      resolveForge: () => forge,
      repos: () => [repo],
      prCache: { snapshot: () => ({}) },
      usage: {
        limits: () => ({
          session5h: null,
          week: null,
          perModelWeek: [],
          credits: null,
          stale: false,
          calibratedAt: null,
          subscriptionOnly: false,
        }),
      },
      emitStatus: () => {},
      emitArchived: () => {},
      dropPrCache: () => {},
      service: {
        create: async (input) => {
          creates.push(input as StandardCreateInput);
          const task = input as StandardCreateInput;
          return store.create({
            name: "Task",
            prompt: task.prompt,
            repoPath: repo,
            baseBranch: "main",
            branch: "shepherd/task",
            worktreePath: repo,
            isolated: true,
            herdrSession: "default",
            herdrAgentId: "fake",
            auto: true,
            issueNumber: task.issueRef?.number ?? null,
          });
        },
        archive: async (id) => {
          store.archive(id);
          return 1;
        },
      },
    });
    const critics: string[] = [];
    const critic = new StandalonePrCriticService({
      detectBackend: () => null,
      membraneEnv: () => ({
        claudeDir: "/fake/.claude",
        home: "/fake/home",
        nodeBinReal: "/fake/bin/node",
      }),
      store,
      leitrechner,
      resolveForge: () => forge,
      repos: () => [repo],
      managedBranches: () => new Set(),
      openPrSnapshot: { get: async () => null },
      herdr: {
        start: async (name: string) => {
          critics.push(name);
          return { terminalId: "fake" };
        },
        stop: async () => {},
        listAsync: async () => [],
        tabsAsync: async () => [],
        closeTab: async () => {},
      } as never,
      worktree: {
        createDetached: async () => ({ worktreePath: repo, branch: "feature/pr", isolated: true }),
        remove: () => {},
        gitCommonDir: () => "/unused",
      } as never,
      computePatchId: async () => ({ patchId: "patch", baseSha: "base", files: [] }),
      readReviewPolicy: async () => null,
    });
    return {
      repo,
      store,
      identity,
      cfg,
      leitrechner,
      drain,
      critic,
      creates,
      critics,
      claims,
      events,
      listed: () => listed,
    };
  }
  const a = node(r.a, join(r.dir, "a.sqlite"));
  const b = node(r.b, join(r.dir, "b.sqlite"));
  rows.set(a.identity.instanceId, { name: "A", status: "connected" });
  rows.set(b.identity.instanceId, { name: "B", status: "connected" });
  return {
    r,
    a,
    b,
    rows,
    advance: () => {
      now += 30_001;
    },
  };
}

test("two instances: only the selected owner starts label agents and general PR critics; offline never takes over", async () => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
  const { a, b, rows, advance } = fixture();
  expect(
    (
      await a.cfg.patch(a.repo, {
        leitrechner: a.identity.instanceId,
        autoDrainEnabled: true,
        criticAllPrs: true,
      })
    ).ok,
  ).toBe(true);
  await Promise.all([a.drain.pump(a.repo), b.drain.pump(b.repo)]);
  expect(a.creates).toHaveLength(1);
  expect(b.creates).toHaveLength(0);
  expect(b.claims).toHaveLength(0);
  expect(b.listed()).toBe(0);
  await Promise.all([a.critic.sweep(), b.critic.sweep()]);
  expect(a.critics).toHaveLength(1);
  expect(b.critics).toHaveLength(0);
  rows.set(a.identity.instanceId, { name: "A", status: "unreachable" });
  advance();
  await b.drain.pump(b.repo);
  await b.critic.sweep();
  expect(b.creates).toHaveLength(0);
  expect(b.critics).toHaveLength(0);
  expect(b.cfg.read(b.repo).leitrechnerStatus).toMatchObject({
    name: "A",
    reachable: false,
    allowed: false,
    pauseReason: "leitrechner_unreachable",
  });
  expect(b.events.at(-1)).toMatchObject({
    leitrechnerStatus: b.cfg.read(b.repo).leitrechnerStatus,
  });
});

test("manual switch is fetched before a returning owner starts; persisted instance IDs survive restart", async () => {
  const { r, a, b } = fixture();
  await a.cfg.patch(a.repo, { leitrechner: a.identity.instanceId, autoDrainEnabled: true });
  await a.leitrechner.refresh(a.repo);
  await b.cfg.patch(b.repo, { leitrechner: b.identity.instanceId });
  // a still has its old origin ref and a cached local-owner answer.
  expect(a.leitrechner.status(a.repo).role).toBe("local");
  const returning = new RepoLeitrechnerService({
    config: (p) => a.store.getRepoConfig(p),
    self: () => instanceIdentity(a.store),
    remote: (id) => (id === b.identity.instanceId ? { name: "B", status: "connected" } : null),
  });
  expect((await returning.refresh(a.repo)).allowed).toBe(false);
  expect(git(a.repo, "rev-parse", "origin/main")).toBe(git(r.origin, "rev-parse", "main"));
  expect(instanceIdentity(a.store).instanceId).toBe(a.identity.instanceId);
});

test("unknown installation keeps legacy spawning; failed startup fetch pauses and recovers", async () => {
  const { r, a, b, advance } = fixture();
  await a.cfg.patch(a.repo, { leitrechner: "foreign-installation", autoDrainEnabled: true });
  git(b.repo, "remote", "set-url", "origin", join(r.dir, "missing-origin"));
  await b.drain.pump(b.repo);
  expect(b.creates).toHaveLength(0);
  expect(b.cfg.read(b.repo).leitrechnerStatus.pauseReason).toBe("config_refresh_failed");
  git(b.repo, "remote", "set-url", "origin", r.origin);
  advance();
  await b.drain.pump(b.repo);
  expect(b.creates).toHaveLength(1);
  expect(b.cfg.read(b.repo).leitrechnerStatus).toMatchObject({ role: "unknown", allowed: true });
});
