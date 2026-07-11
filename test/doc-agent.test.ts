import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DocAgentService,
  DOC_AGENT_LABEL,
  SERVER_INSTALL_ROOT,
  PrettierFormatError,
  assertPrettierClean,
  defaultPrettierWrite,
  isDocRelevantMerge,
  type DocAgentFinalize,
  type DocAgentDeps,
} from "../src/doc-agent";
import { config, parseHour } from "../src/config";
import type { GitState } from "../src/forge/types";
import type { Session } from "../src/types";
import { PluginSpawnAborted } from "../src/plugins/types";

function withAuth(
  mode: typeof config.authMode,
  helper: string | null,
  fn: () => void | Promise<void>,
) {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  const restore = () => {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  };
  const r = fn();
  if (r instanceof Promise) return r.finally(restore);
  restore();
  return r;
}

interface GitCall {
  cwd: string;
  args: string[];
}

interface PrettierCall {
  cwd: string;
  configPath: string;
  files: string[];
  /** Snapshot of gitCalls op-names (args[0]) at the instant prettier was called. */
  gitOpsAtCall: string[];
}

interface SpawnRow {
  reviewerSessionId: string;
  taskSessionId: string;
  kind: string;
  worktreePath: string;
  model: string | null;
  spawnedAt: number;
  completedAt: number | null;
}

interface CompletedRow {
  reviewerSessionId: string;
  completedAt: number;
  total: number;
}

interface Harness {
  svc: DocAgentService;
  gitCalls: GitCall[];
  prettierCalls: PrettierCall[];
  starts: { name: string; cwd: string }[];
  closedTabs: string[];
  removedWorktrees: string[];
  openPrInputs: unknown[];
  mergeCalls: number;
  finalizes: DocAgentFinalize[];
  ensureBaseRefCalls: { repo: string; base: string }[];
  kv: Map<string, string>;
  spawnRows: SpawnRow[];
  completedRows: CompletedRow[];
  deletedRemote: string[];
  /** Re-target marker files written by the service, keyed by absolute path. */
  markers: Map<string, string>;
  /** Args of every herdr.start (incl. the wrapped argv) for prompt-grounding assertions. */
  startArgs: { name: string; cwd: string; argv: string[] }[];
  /** Captured editPr calls (prNumber + patch). */
  editPrCalls: { prNumber: number; title?: string; body?: string }[];
  /** terminalIds passed to herdr.stop (mirrors removedWorktrees pattern). */
  stoppedTerminals: string[];
  __merge: number;
}

/** Minimal Session stub for the re-target sweep tests. */
function mkSession(o: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task",
    prompt: "",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feature/x",
    worktreePath: "/owner/wt",
    isolated: true,
    herdrSession: "",
    herdrAgentId: "",
    claudeSessionId: "",
    model: null,
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    mergingPrNumber: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    completionRepromptCount: 0,
    planGateEnabled: null,
    planPhase: null,
    research: false,
    epicAuthoring: false,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    autoMergeRebaseHead: null,
    auto: false,
    issueNumber: null,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    status: "idle",
    lastState: "idle" as Session["lastState"],
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    ...o,
  } as Session;
}

/** Minimal open+green+doc-relevant GitState for a re-targetable session. */
function mkGitState(o: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "success",
    number: 7,
    headSha: "headsha1",
    title: "feat(ui): add thing",
    url: "https://forge/pr/7",
    deployConfigured: false,
    ...o,
  } as GitState;
}

function mkHarness(opts?: {
  forgeKind?: "github" | "local" | null;
  docTreePresent?: boolean;
  inScopeFilesPresent?: boolean;
  sentinel?: string | null;
  stagedNames?: string; // stdout of `git diff --cached --name-only`
  worktreeListPorcelain?: string;
  herdrAgents?: { name: string; tabId: string; cwd?: string; terminalId?: string }[];
  repos?: string[];
  originSha?: string | (() => string);
  originShaThrows?: boolean;
  now?: () => number;
  nightlyHour?: number;
  act?: boolean;
  defaultBranchThrows?: boolean;
  /** Short-names returned by forge.listBranches; when undefined, listBranches is absent. */
  remoteBranches?: string[];
  /** Drives forge.prStatus(branch).state for the remote-branch reap. */
  prStatusByBranch?: Record<string, "none" | "open" | "merged" | "closed">;
  /** stdout of `git for-each-ref … refs/remotes/origin/…` (git fallback path). */
  forEachRefStdout?: string;
  /** When true, the injected prettier stub throws (exercises the best-effort failure path). */
  prettierThrows?: boolean;
  /** Sessions the re-target sweep iterates (store.list()). */
  sessions?: Session[];
  /** Cached PR state per session id (the gitState seam). */
  gitStateById?: Record<string, GitState | undefined>;
  /** Settled-idle debounce threshold (ms) for the re-target sweep. */
  idleThresholdMs?: number;
  /** Full prStatus (state + url) per branch — drives the re-target finalize re-check. Falls back to
   *  prStatusByBranch (state only) when absent. */
  prStatusFull?: Record<string, { state: "none" | "open" | "merged" | "closed"; url?: string }>;
  /** Pre-seeded re-target marker files (abs path → JSON), read by reapOneWorktree. */
  markerFiles?: Record<string, string>;
  /** Owner-worktree git responses for the ff guard: porcelain status + rev-parse HEAD. */
  ownerStatusPorcelain?: string;
  ownerHead?: string;
  /** Open standalone docs PRs returned by forge.listPullRequests (roll-up tests). */
  openDocPrs?: { number: number; headRefName: string; url?: string }[];
  /** When true, forge.listPullRequests throws (fail-open test). */
  listPullRequestsThrows?: boolean;
  /** When true, `git push --force` throws (deferred roll-up test). */
  forcePushThrows?: boolean;
  /** When true, forge.editPr throws after recording the call. */
  editPrThrows?: boolean;
  /** When true, forge has no editPr method (stale-body fallback test). */
  noEditPr?: boolean;
  /** Inject a plugin onSpawn hook runner (issue #1205 abort-path test). */
  runSpawnHooks?: (d: unknown) => Promise<unknown>;
  /** Per-role reasoning-effort override threaded into the spawn env (issue #1418). */
  effort?: string | null;
}): Harness {
  const o = {
    forgeKind: "github" as "github" | "local" | null,
    docTreePresent: true,
    inScopeFilesPresent: true,
    sentinel: "## Changes\n- updated configuration.md (grounded in src/config.ts)\n" as
      string | null,
    stagedNames: "docs-site/src/content/docs/reference/configuration.md",
    worktreeListPorcelain: "",
    herdrAgents: [] as { name: string; tabId: string; cwd?: string; terminalId?: string }[],
    repos: [] as string[],
    originSha: "origin-sha-1" as string,
    originShaThrows: false,
    now: () => 1000,
    nightlyHour: 3,
    act: false,
    defaultBranchThrows: false,
    forEachRefStdout: "",
    prettierThrows: false,
    sessions: [] as Session[],
    gitStateById: {} as Record<string, GitState | undefined>,
    markerFiles: {} as Record<string, string>,
    ownerStatusPorcelain: "",
    ownerHead: "headsha1",
    openDocPrs: undefined as { number: number; headRefName: string; url?: string }[] | undefined,
    listPullRequestsThrows: false,
    forcePushThrows: false,
    editPrThrows: false,
    noEditPr: false,
    effort: null as string | null,
    ...opts,
  };

  const gitCalls: GitCall[] = [];
  const prettierCalls: PrettierCall[] = [];
  const starts: { name: string; cwd: string }[] = [];
  const startArgs: { name: string; cwd: string; argv: string[] }[] = [];
  const markers = new Map<string, string>(Object.entries(o.markerFiles));
  const closedTabs: string[] = [];
  const removedWorktrees: string[] = [];
  const openPrInputs: unknown[] = [];
  const finalizes: DocAgentFinalize[] = [];
  const ensureBaseRefCalls: { repo: string; base: string }[] = [];
  const kv = new Map<string, string>();
  const spawnRows: SpawnRow[] = [];
  const completedRows: CompletedRow[] = [];
  const deletedRemote: string[] = [];
  const editPrCalls: { prNumber: number; title?: string; body?: string }[] = [];
  const stoppedTerminals: string[] = [];
  const store = {
    getSetting: (key: string) => kv.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      kv.set(key, value);
    },
    recordReviewerSpawn: (r: {
      reviewerSessionId: string;
      taskSessionId: string;
      kind: string;
      worktreePath: string;
      model: string | null;
      spawnedAt: number;
    }) => {
      spawnRows.push({ ...r, completedAt: null });
    },
    completeReviewerSpawn: (
      reviewerSessionId: string,
      u: { total: number },
      completedAt: number,
    ) => {
      completedRows.push({ reviewerSessionId, completedAt, total: u.total });
      const row = spawnRows.find((s) => s.reviewerSessionId === reviewerSessionId);
      if (row) row.completedAt = completedAt;
    },
    listReviewerSpawns: () => spawnRows,
    recordDocAgentRun: (repoPath: string, run: import("../src/types").DocAgentRun) => {
      const key = `docagent:runs:${repoPath}`;
      const existing: import("../src/types").DocAgentRun[] = (() => {
        try {
          return JSON.parse(kv.get(key) ?? "[]") as import("../src/types").DocAgentRun[];
        } catch {
          return [];
        }
      })();
      kv.set(key, JSON.stringify([run, ...existing].slice(0, 10)));
    },
    listDocAgentRuns: (repoPath: string): import("../src/types").DocAgentRun[] => {
      try {
        return JSON.parse(
          kv.get(`docagent:runs:${repoPath}`) ?? "[]",
        ) as import("../src/types").DocAgentRun[];
      } catch {
        return [];
      }
    },
    list: () => o.sessions,
  };
  let mergeCalls = 0;

  const git = async (cwd: string, args: string[]): Promise<string> => {
    gitCalls.push({ cwd, args });
    if (args[0] === "diff" && args[1] === "--cached") return o.stagedNames;
    if (args[0] === "worktree" && args[1] === "list") return o.worktreeListPorcelain;
    if (args[0] === "for-each-ref") {
      // Faithfully model `git for-each-ref`'s literal-pattern matching (complete, or up to a slash:
      // refname starts with the pattern AND ends at a component boundary, OR the pattern ends in
      // `/`). Treat each forEachRefStdout line as a `%(refname:short)` for a `refs/remotes/*` ref.
      // This makes a mid-component pattern (`…/shepherd/docs-update-`) correctly match nothing.
      const pattern = args[args.length - 1] ?? "";
      return o.forEachRefStdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((short) => {
          const ref = `refs/remotes/${short}`;
          return (
            ref.startsWith(pattern) &&
            (ref.length === pattern.length || ref[pattern.length] === "/" || pattern.endsWith("/"))
          );
        })
        .map((s) => `${s}\n`)
        .join("");
    }
    if (args[0] === "push" && args[1] === "origin" && args[2] === "--delete") {
      deletedRemote.push(args[3]!);
      return "";
    }
    if (args[0] === "rev-parse" && args[1]?.startsWith("refs/remotes/origin/")) {
      if (o.originShaThrows) throw new Error("no such ref");
      return typeof o.originSha === "function" ? (o.originSha as () => string)() : o.originSha;
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return o.ownerHead;
    if (args[0] === "status" && args[1] === "--porcelain") return o.ownerStatusPorcelain;
    if (args[0] === "push" && args[1] === "--force" && o.forcePushThrows)
      throw new Error("non-ff (stub)");
    return "";
  };

  const forge =
    o.forgeKind === null
      ? null
      : ({
          kind: o.forgeKind,
          isLightweight: o.forgeKind === "local",
          defaultBranch: async () => {
            if (o.defaultBranchThrows) throw new Error("forge offline");
            return "main";
          },
          openPr: async (input: unknown) => {
            openPrInputs.push(input);
            return { url: "https://forge/pr/42" };
          },
          merge: async () => {
            mergeCalls++;
          },
          // listBranches is present ONLY when remoteBranches is provided (mirrors the
          // optional GitHub matching-refs API; absent → git-fallback path exercised).
          ...(o.remoteBranches !== undefined ? { listBranches: async () => o.remoteBranches } : {}),
          prStatus: async (branch: string) => {
            const full = o.prStatusFull?.[branch];
            if (full) return full;
            return { state: o.prStatusByBranch?.[branch] ?? "none" };
          },
          listPullRequests: async () => {
            if (o.listPullRequestsThrows) throw new Error("gh pr list failed (stub)");
            return (o.openDocPrs ?? []).map((p) => ({
              number: p.number,
              title: "docs: sync docs to recent source changes",
              url: p.url ?? `https://forge/pr/${p.number}`,
              author: "shepherd",
              kind: "other",
              createdAt: 0,
              isDraft: false,
              mergeable: true,
              checks: "success",
              jobs: [],
              headRefName: p.headRefName,
            }));
          },
          ...(o.noEditPr
            ? {}
            : {
                editPr: async (prNumber: number, eo: { title?: string; body?: string }) => {
                  editPrCalls.push({ prNumber, title: eo.title, body: eo.body });
                  if (o.editPrThrows) throw new Error("gh pr edit failed (stub)");
                },
              }),
        } as any);

  const herdr = {
    start: async (name: string, cwd: string, wrapped?: string[]) => {
      starts.push({ name, cwd });
      startArgs.push({ name, cwd, argv: wrapped ?? [] });
      return { terminalId: "term-" + starts.length } as any;
    },
    stop: async (terminalId: string) => {
      stoppedTerminals.push(terminalId);
    },
    list: () =>
      o.herdrAgents.map(
        (a) =>
          ({
            name: a.name,
            tabId: a.tabId,
            cwd: a.cwd ?? "",
            terminalId: a.terminalId ?? "",
          }) as any,
      ),
    closeTab: async (tabId: string) => {
      closedTabs.push(tabId);
    },
  };

  const worktree = {
    create: (_repo: string, _base: string, name: string) => ({
      worktreePath: `/wt/${name}`,
      branch: `shepherd/${name}`,
      isolated: true,
    }),
    remove: (p: string) => {
      removedWorktrees.push(p);
    },
    gitCommonDir: (p: string) => `${p}/.git`,
    ensureBaseRef: async (repo: string, base: string) => {
      ensureBaseRefCalls.push({ repo, base });
      return {
        baseRef: base,
        behind: 0,
        ahead: 0,
        diverged: false,
        hasUpstream: true,
        localExists: true,
        localFf: "not-needed" as const,
      };
    },
  };

  const svc = new DocAgentService({
    herdr: herdr as any,
    worktree: worktree as any,
    resolveForge: () => forge,
    repos: () => o.repos,
    store: store as any,
    nightlyHour: o.nightlyHour,
    env: () => ({ provider: "claude", model: null, effort: o.effort }),
    act: o.act,
    onChange: (f) => finalizes.push(f),
    now: o.now,
    git,
    prettier: async (args) => {
      // Capture a snapshot of the git op-names at call time to assert ordering in tests.
      prettierCalls.push({ ...args, gitOpsAtCall: gitCalls.map((c) => c.args[0]!) });
      if (o.prettierThrows) throw new Error("prettier failed (stub)");
    },
    detectBackend: () => null,
    membraneEnv: () => ({ claudeDir: "/c", home: "/h", nodeBinReal: "/n", extraEnv: {} }),
    runSpawnHooks: o.runSpawnHooks as DocAgentDeps["runSpawnHooks"],
    fileExists: (p: string) => {
      if (p.endsWith("docs-site/src/content/docs")) return o.docTreePresent;
      return o.inScopeFilesPresent;
    },
    readSentinel: () => o.sentinel,
    gitState: (id: string) => o.gitStateById[id],
    idleThresholdMs: o.idleThresholdMs,
    writeMarker: (p: string, c: string) => {
      markers.set(p, c);
    },
    readMarker: (p: string) => markers.get(p) ?? null,
    readUsage: async () => ({
      input: 5,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      total: 12,
      messageCount: 1,
      lastActivity: null,
      byModel: {},
      fullRecaches: 0,
      sidechainCount: 0,
    }),
  });

  return {
    svc,
    gitCalls,
    prettierCalls,
    starts,
    closedTabs,
    removedWorktrees,
    openPrInputs,
    finalizes,
    ensureBaseRefCalls,
    kv,
    spawnRows,
    completedRows,
    deletedRemote,
    markers,
    startArgs,
    editPrCalls,
    stoppedTerminals,
    mergeCalls: 0,
    get __merge() {
      return mergeCalls;
    },
  } as any as Harness & {
    __merge: number;
    ensureBaseRefCalls: typeof ensureBaseRefCalls;
    kv: Map<string, string>;
  };
}

test("happy path: in-scope edits → commit --no-verify + push + openPr (never merge)", async () => {
  const h = mkHarness({ act: true });
  const res = await h.svc.consider("/repo");
  expect(res.status).toBe("started");
  expect(h.starts).toHaveLength(1);
  expect(h.starts[0]!.name.startsWith(DOC_AGENT_LABEL)).toBe(true);

  await h.svc.tick();

  expect(h.gitCalls.some((c) => c.args[0] === "commit" && c.args.includes("--no-verify"))).toBe(
    true,
  );
  expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(true);
  expect(h.openPrInputs).toHaveLength(1);
  expect((h.openPrInputs[0] as any).base).toBe("main");
  expect((h.openPrInputs[0] as any).head).toMatch(/^shepherd\/docs-update-/);
  // never merges
  expect((h as any).__merge).toBe(0);
  // PR body carries the grounding summary + human-review banner
  expect((h.openPrInputs[0] as any).body).toContain("never auto-merged");
  expect((h.openPrInputs[0] as any).body).toContain("configuration.md");
  // finalize emits the url + outcome
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: "https://forge/pr/42", outcome: "pr" }]);
  // cleanup
  expect(h.removedWorktrees.length).toBeGreaterThan(0);
});

test("threads env.effort into the spawn argv (issue #1418)", async () => {
  const h = mkHarness({ act: true, effort: "high" });
  await h.svc.consider("/repo");
  expect(h.startArgs).toHaveLength(1);
  const argv = h.startArgs[0]!.argv;
  expect(argv).toContain("--effort");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
});

test("emits no --effort when env.effort is null (issue #1418)", async () => {
  const h = mkHarness({ act: true, effort: null });
  await h.svc.consider("/repo");
  expect(h.startArgs[0]!.argv).not.toContain("--effort");
});

test("structural off-limits: only the in-scope file list is ever staged (no cli/*, no Astro app)", async () => {
  const h = mkHarness();
  await h.svc.consider("/repo");
  await h.svc.tick();
  const add = h.gitCalls.find((c) => c.args[0] === "add");
  expect(add).toBeDefined();
  const staged = add!.args.slice(2); // after ["add","--"]
  for (const p of staged) {
    expect(p.includes("/reference/cli/")).toBe(false);
    expect(p.endsWith("astro.config.mjs")).toBe(false);
    expect(p.endsWith("package.json")).toBe(false);
    expect(p).not.toBe(".shepherd-doc-update.md");
  }
  // and it did stage the known in-scope page
  expect(staged).toContain("docs-site/src/content/docs/reference/configuration.md");
});

test("nothing staged (docs already current) → no commit/push/PR, no error", async () => {
  const h = mkHarness({ stagedNames: "" });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.gitCalls.some((c) => c.args[0] === "commit")).toBe(false);
  expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
  expect(h.openPrInputs).toHaveLength(0);
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: null, outcome: "nochange" }]);
});

test("fail-closed: api-key mode without a configured key → skip, no spawn", async () => {
  await withAuth("api-key", null, async () => {
    const h = mkHarness();
    const res = await h.svc.consider("/repo");
    expect(res.status).toBe("skipped");
    expect(h.starts).toHaveLength(0);
  });
});

test("fail-closed: local forge (lightweight repo) → skip, no spawn", async () => {
  const h = mkHarness({ forgeKind: "local" });
  const res = await h.svc.consider("/repo");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
});

test("guard: no forge configured → error, no spawn", async () => {
  const h = mkHarness({ forgeKind: null });
  const res = await h.svc.consider("/repo");
  expect(res.status).toBe("error");
  expect(h.starts).toHaveLength(0);
});

test("layout guard: repo without docs-site doc tree → skip, no spawn", async () => {
  const h = mkHarness({ docTreePresent: false });
  const res = await h.svc.consider("/repo");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
});

test("in-flight guard: a second trigger while one runs is skipped", async () => {
  const h = mkHarness();
  expect((await h.svc.consider("/repo")).status).toBe("started");
  expect((await h.svc.consider("/repo")).status).toBe("skipped");
  expect(h.starts).toHaveLength(1);
});

test("restart safety: unique-per-run agent names never collide", async () => {
  const h = mkHarness();
  await h.svc.consider("/repo");
  await h.svc.tick(); // clears inflight for /repo
  await h.svc.consider("/repo");
  expect(h.starts).toHaveLength(2);
  expect(h.starts[0]!.name).not.toBe(h.starts[1]!.name);
});

test("reapOrphans: closes only __docagent__ tabs and prunes only docs-update worktrees (no sentinel/no tab)", async () => {
  const porcelain = [
    "worktree /repo",
    "branch refs/heads/main",
    "",
    "worktree /wt/docs-update-abc12345",
    "branch refs/heads/shepherd/docs-update-abc12345",
    "",
    "worktree /wt/feature",
    "branch refs/heads/shepherd/some-feature",
    "",
  ].join("\n");
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: porcelain,
    sentinel: null, // agent died mid-edit → prune (not re-adopt)
    herdrAgents: [
      { name: "__docagent__deadbeef", tabId: "tab-doc", cwd: "/wt/gone" },
      { name: "review TASK-7", tabId: "tab-review" },
    ],
  });
  await h.svc.reapOrphans();
  // only the doc-agent husk tab closed
  expect(h.closedTabs).toEqual(["tab-doc"]);
  // only the docs-update worktree removed; main + unrelated feature left alone
  expect(h.removedWorktrees).toEqual(["/wt/docs-update-abc12345"]);
  // the orphan branch force-deleted
  expect(
    h.gitCalls.some(
      (c) =>
        c.args[0] === "branch" &&
        c.args[1] === "-D" &&
        c.args[2] === "shepherd/docs-update-abc12345",
    ),
  ).toBe(true);
  // unrelated feature branch NOT deleted
  expect(h.gitCalls.some((c) => c.args.includes("shepherd/some-feature"))).toBe(false);
});

// ── reapOrphans: re-adoption + dangling sweep + remote reap (issue #905) ────────

const DOCS_WT_PORCELAIN = (id: string) =>
  [
    "worktree /repo",
    "branch refs/heads/main",
    "",
    `worktree /wt/docs-update-${id}`,
    `branch refs/heads/shepherd/docs-update-${id}`,
    "",
  ].join("\n");

test("reapOrphans: re-adopts a sentinel-present orphan and finalizes it (not discarded)", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: DOCS_WT_PORCELAIN("x0000001"),
    sentinel: "## Changes\n- updated configuration.md\n",
    act: true,
  });
  await h.svc.reapOrphans();
  // re-adopted, NOT pruned by reapOrphans itself
  expect(h.removedWorktrees).not.toContain("/wt/docs-update-x0000001");
  // the work is finalized on the next tick (act:true → openPr fires)
  await h.svc.tick();
  expect(h.openPrInputs).toHaveLength(1);
  expect((h.openPrInputs[0] as any).head).toBe("shepherd/docs-update-x0000001");
});

test("reapOrphans: prunes a no-sentinel/no-tab orphan and completes its dangling row", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: DOCS_WT_PORCELAIN("dead0001"),
    sentinel: null,
  });
  // an uncompleted doc_agent row exists for the orphan worktree
  h.spawnRows.push({
    reviewerSessionId: "sess-dead",
    taskSessionId: "/repo",
    kind: "doc_agent",
    worktreePath: "/wt/docs-update-dead0001",
    model: null,
    spawnedAt: 500,
    completedAt: null,
  });
  await h.svc.reapOrphans();
  expect(h.removedWorktrees).toContain("/wt/docs-update-dead0001");
  expect(
    h.gitCalls.some(
      (c) =>
        c.args[0] === "branch" &&
        c.args[1] === "-D" &&
        c.args[2] === "shepherd/docs-update-dead0001",
    ),
  ).toBe(true);
  expect(h.completedRows.some((r) => r.reviewerSessionId === "sess-dead")).toBe(true);
});

test("reapOrphans: transient forge (defaultBranch throws) + sentinel present → keep, do not prune/complete", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: DOCS_WT_PORCELAIN("keep0001"),
    sentinel: "## Changes\n- something\n",
    defaultBranchThrows: true,
  });
  h.spawnRows.push({
    reviewerSessionId: "sess-keep",
    taskSessionId: "/repo",
    kind: "doc_agent",
    worktreePath: "/wt/docs-update-keep0001",
    model: null,
    spawnedAt: 500,
    completedAt: null,
  });
  await h.svc.reapOrphans();
  // finished edits preserved across the blip — a later boot retries
  expect(h.removedWorktrees).not.toContain("/wt/docs-update-keep0001");
  expect(h.completedRows.some((r) => r.reviewerSessionId === "sess-keep")).toBe(false);
});

test("reapOrphans: dangling-row sweep completes a row whose worktree is gone from disk", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: "worktree /repo\nbranch refs/heads/main\n\n",
    inScopeFilesPresent: false, // fileExists → false for the gone worktree path
  });
  h.spawnRows.push({
    reviewerSessionId: "sess-gone",
    taskSessionId: "/repo",
    kind: "doc_agent",
    worktreePath: "/wt/docs-update-gone0001",
    model: null,
    spawnedAt: 500,
    completedAt: null,
  });
  await h.svc.reapOrphans();
  expect(h.completedRows.some((r) => r.reviewerSessionId === "sess-gone")).toBe(true);
});

test("reapOrphans: a re-adopted repo's claim blocks a concurrent consider (no double-spawn)", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: DOCS_WT_PORCELAIN("claim001"),
    sentinel: "## Changes\n- x\n",
  });
  await h.svc.reapOrphans();
  // the repo is now inflight → a concurrent consider is skipped
  const res = await h.svc.consider("/repo");
  expect(res.status).toBe("skipped");
});

test("reapOrphans: remote reap deletes only no-PR branches (state none), keeps open/merged/closed", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: "worktree /repo\nbranch refs/heads/main\n\n",
    remoteBranches: ["shepherd/docs-update-aaa", "shepherd/docs-update-bbb"],
    prStatusByBranch: {
      "shepherd/docs-update-aaa": "none",
      "shepherd/docs-update-bbb": "open",
    },
  });
  await h.svc.reapOrphans();
  expect(h.deletedRemote).toEqual(["shepherd/docs-update-aaa"]);
});

test("reapOrphans: git fallback (no listBranches) runs `git remote prune origin` before for-each-ref", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: "worktree /repo\nbranch refs/heads/main\n\n",
    // remoteBranches omitted → forge.listBranches absent → git fallback
    forEachRefStdout: "origin/shepherd/docs-update-ccc\n",
    prStatusByBranch: { "shepherd/docs-update-ccc": "none" },
  });
  await h.svc.reapOrphans();
  const pruneIdx = h.gitCalls.findIndex(
    (c) => c.args[0] === "remote" && c.args[1] === "prune" && c.args[2] === "origin",
  );
  const forEachIdx = h.gitCalls.findIndex((c) => c.args[0] === "for-each-ref");
  expect(pruneIdx).toBeGreaterThanOrEqual(0);
  expect(forEachIdx).toBeGreaterThan(pruneIdx);
  // the stale-but-PR-less branch is reaped (short-name, origin/ stripped)
  expect(h.deletedRemote).toEqual(["shepherd/docs-update-ccc"]);
});

// ── cadence: scheduling (issue #904) ───────────────────────────────────────────

/** Local-time timestamp at hour `h` on a fixed day → `getHours()===h` regardless of TZ. */
const at = (h: number, day = 1) => new Date(2030, 0, day, h, 0, 0).getTime();
const LAST_SHA = (repo: string) => `docagent:last-sha:${repo}`;
const NIGHTLY_DAY = (repo: string) => `docagent:nightly-day:${repo}`;
const MERGED_SEEN = (repo: string, pr: number) => `docagent:merged-seen:${repo}:${pr}`;

test("isDocRelevantMerge: feat/config relevant; fix/docs/chore/bare/absent not", () => {
  for (const t of [
    "feat: x",
    "feat(ui): x",
    "feat!: x",
    "feat(ui)!: x",
    "config: x",
    "config(env): x",
    "fix(config): x",
  ])
    expect(isDocRelevantMerge(t)).toBe(true);
  for (const t of [
    "fix: x",
    "fix(ui): x",
    "chore: x",
    "docs: sync docs to recent source changes",
    "refactor(ui): x",
    "Land epic #875: docs site",
    "just a bare title",
    "",
    undefined,
  ])
    expect(isDocRelevantMerge(t)).toBe(false);
});

test("parseHour: valid 0–23 kept; invalid/empty/out-of-range fall back to default", () => {
  expect(parseHour("0", 3)).toBe(0);
  expect(parseHour("23", 3)).toBe(23);
  expect(parseHour("5", 3)).toBe(5);
  expect(parseHour(undefined, 3)).toBe(3);
  expect(parseHour("", 3)).toBe(3);
  expect(parseHour("24", 3)).toBe(3);
  expect(parseHour("-1", 3)).toBe(3);
  expect(parseHour("3.5", 3)).toBe(3);
  expect(parseHour("abc", 3)).toBe(3);
});

test("nightly hour-gate: before nightlyHour → no rev-parse, no spawn, no marker writes", async () => {
  const h = mkHarness({ repos: ["/repo"], nightlyHour: 3, now: () => at(2) });
  await h.svc.sweepNightly();
  expect(h.starts).toHaveLength(0);
  expect(h.gitCalls.some((c) => c.args[0] === "rev-parse")).toBe(false);
  expect(h.ensureBaseRefCalls).toHaveLength(0);
  expect(h.kv.size).toBe(0);
});

test("nightly freshens origin/<base> (ensureBaseRef) before comparing, at most once/day/repo", async () => {
  const h = mkHarness({ repos: ["/repo"], nightlyHour: 3, now: () => at(4) });
  await h.svc.sweepNightly();
  expect(h.ensureBaseRefCalls).toContainEqual({ repo: "/repo", base: "main" });
  const freshenCount = h.ensureBaseRefCalls.filter((c) => c.repo === "/repo").length;
  // second sweep same day → early-skip, no extra freshen
  await h.svc.sweepNightly();
  expect(h.ensureBaseRefCalls.filter((c) => c.repo === "/repo").length).toBe(freshenCount);
});

test("nightly sha-gate: base advanced → spawn + last-sha stamped from origin/<base>", async () => {
  const h = mkHarness({ repos: ["/repo"], nightlyHour: 3, now: () => at(4), originSha: "new-sha" });
  await h.svc.sweepNightly();
  expect(h.starts).toHaveLength(1);
  expect(h.kv.get(LAST_SHA("/repo"))).toBe("new-sha");
  expect(h.kv.get(NIGHTLY_DAY("/repo"))).toBe("2030-01-01");
});

test("nightly sha-gate: base unchanged → no spawn, dayKey stamped", async () => {
  const h = mkHarness({ repos: ["/repo"], nightlyHour: 3, now: () => at(4), originSha: "same" });
  h.kv.set(LAST_SHA("/repo"), "same");
  await h.svc.sweepNightly();
  expect(h.starts).toHaveLength(0);
  expect(h.kv.get(NIGHTLY_DAY("/repo"))).toBe("2030-01-01");
});

test("nightly once/day: second sweep same day → early-skip (no rev-parse)", async () => {
  const h = mkHarness({ repos: ["/repo"], nightlyHour: 3, now: () => at(4), originSha: "same" });
  h.kv.set(LAST_SHA("/repo"), "same");
  await h.svc.sweepNightly();
  const revParseCount = h.gitCalls.filter((c) => c.args[0] === "rev-parse").length;
  await h.svc.sweepNightly();
  expect(h.gitCalls.filter((c) => c.args[0] === "rev-parse").length).toBe(revParseCount);
});

test("nightly → consider skipped (already running): nightly-day stamped, last-sha NOT stamped", async () => {
  const h = mkHarness({ repos: ["/repo"], nightlyHour: 3, now: () => at(4), originSha: "new-sha" });
  // a run is already in flight for the repo → consider() returns skipped, begin() never reached
  await h.svc.consider("/repo");
  h.kv.delete(LAST_SHA("/repo")); // clear the stamp the in-flight run just wrote
  await h.svc.sweepNightly();
  expect(h.kv.get(NIGHTLY_DAY("/repo"))).toBe("2030-01-01");
  expect(h.kv.has(LAST_SHA("/repo"))).toBe(false);
  // only the one (manual) spawn — nightly did not spawn a second
  expect(h.starts).toHaveLength(1);
});

test("nightly rev-parse failure: dayKey stamped, spawn skipped", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    nightlyHour: 3,
    now: () => at(4),
    originShaThrows: true,
  });
  await h.svc.sweepNightly();
  expect(h.starts).toHaveLength(0);
  expect(h.kv.get(NIGHTLY_DAY("/repo"))).toBe("2030-01-01");
});

test("nightly rev-parse failure then next-day success fires", async () => {
  let throws = true;
  let nowVal = at(4, 1);
  const h = mkHarness({
    repos: ["/repo"],
    nightlyHour: 3,
    now: () => nowVal,
    originSha: () => {
      if (throws) throw new Error("no ref");
      return "fresh";
    },
  });
  await h.svc.sweepNightly();
  expect(h.starts).toHaveLength(0);
  // next local day, ref resolves
  throws = false;
  nowVal = at(4, 2);
  await h.svc.sweepNightly();
  expect(h.starts).toHaveLength(1);
  expect(h.kv.get(NIGHTLY_DAY("/repo"))).toBe("2030-01-02");
});

test("merge: feat-subject PR into default base → spawn once + merged-seen persisted; no fetch in onMergedPr", async () => {
  const h = mkHarness();
  const res = await h.svc.onMergedPr("/repo", 42, "feat(ui): add thing", "main");
  expect(res.status).toBe("started");
  expect(h.starts).toHaveLength(1);
  expect(h.kv.get(MERGED_SEEN("/repo", 42))).toBe("1");
  // onMergedPr itself does no rev-parse before consider(); begin()'s stampLastSha does the only one
  const revParses = h.gitCalls.filter((c) => c.args[0] === "rev-parse");
  expect(revParses).toHaveLength(1);
});

test("merge: non-doc-relevant subject → skip, no spawn, no merged-seen", async () => {
  const h = mkHarness();
  const res = await h.svc.onMergedPr("/repo", 7, "fix: a bug", "main");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
  expect(h.kv.has(MERGED_SEEN("/repo", 7))).toBe(false);
});

test("merge: feat PR into NON-default base (epic/stacked) → skip, no spawn, no merged-seen", async () => {
  const h = mkHarness(); // forge.defaultBranch() === "main"
  const res = await h.svc.onMergedPr("/repo", 99, "feat: epic sub-task", "epic/875-docs-site");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
  expect(h.kv.has(MERGED_SEEN("/repo", 99))).toBe(false);
});

test("merge restart-idempotency: merged-seen already set → skip (boot-replay no-op)", async () => {
  const h = mkHarness();
  h.kv.set(MERGED_SEEN("/repo", 42), "1");
  const res = await h.svc.onMergedPr("/repo", 42, "feat: x", "main");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
});

test("merge: absent PR number → skip", async () => {
  const h = mkHarness();
  const res = await h.svc.onMergedPr("/repo", undefined, "feat: x", "main");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
});

// ── soak flags: observe → act (issue #905) ─────────────────────────────────────

test("observe mode (act:false): staged changes → OBSERVE warn, NO push, NO PR, worktree removed", async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.join(" "));
  };
  try {
    const h = mkHarness({ act: false });
    await h.svc.consider("/repo");
    await h.svc.tick();
    // no PR opened, no push run
    expect(h.openPrInputs).toHaveLength(0);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(h.gitCalls.some((c) => c.args[0] === "commit")).toBe(false);
    // worktree still cleaned up
    expect(h.removedWorktrees.length).toBeGreaterThan(0);
    // url stays null; observe outcome because staged changes existed but act:false
    expect(h.finalizes).toEqual([{ repoPath: "/repo", url: null, outcome: "observe" }]);
    // the OBSERVE line fired
    expect(warns.some((w) => w.includes("[doc-agent] OBSERVE:"))).toBe(true);
  } finally {
    console.warn = orig;
  }
});

test("act mode (act:true): staged changes → one PR opened (current behavior preserved)", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.openPrInputs).toHaveLength(1);
});

// ── durable spawn-row tracking (cost attribution) ──────────────────────────────

test("spawn row recorded: a successful begin() persists one doc_agent reviewer_spawns row", async () => {
  const h = mkHarness();
  await h.svc.consider("/repo");
  expect(h.spawnRows).toHaveLength(1);
  const row = h.spawnRows[0]!;
  expect(row.kind).toBe("doc_agent");
  expect(row.taskSessionId).toBe("/repo");
  expect(row.worktreePath).toMatch(/^\/wt\/docs-update-/);
  expect(row.spawnedAt).not.toBeNull();
});

test("row completed at finalize: observe path completes the spawn row", async () => {
  const h = mkHarness({ act: false });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.completedRows).toHaveLength(1);
  expect(h.completedRows[0]!.reviewerSessionId).toBe(h.spawnRows[0]!.reviewerSessionId);
  // real (non-zero) usage recorded via the readUsage stub
  expect(h.completedRows[0]!.total).toBe(12);
  expect(h.spawnRows[0]!.completedAt).not.toBeNull();
});

test("row completed at finalize: act path completes the spawn row", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.completedRows).toHaveLength(1);
  expect(h.completedRows[0]!.reviewerSessionId).toBe(h.spawnRows[0]!.reviewerSessionId);
});

// ── prettier pre-format (fix: doc-agent auto-PRs fail CI lint gate) ─────────────

test("prettier: called exactly once with cwd=SERVER_INSTALL_ROOT and worktree .prettierrc", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();

  expect(h.prettierCalls).toHaveLength(1);
  const call = h.prettierCalls[0]!;
  // cwd must be the SERVER's install root (not the worktree — the worktree may have no node_modules)
  expect(call.cwd).toBe(SERVER_INSTALL_ROOT);
  // config must come from the managed repo's worktree so CI's own formatting rules drive the output
  expect(call.configPath).toMatch(/^\/wt\/docs-update-[0-9a-f]{8}\/.prettierrc$/);
});

test("prettier: files are the absolute worktree paths of the root docs/*.md in-scope files", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();

  const call = h.prettierCalls[0]!;
  // The three root docs/*.md entries from IN_SCOPE_PATHS (abs paths under the worktree).
  const wtBase = call.configPath.replace("/.prettierrc", "");
  expect(call.files).toEqual([
    `${wtBase}/docs/external-task-api.md`,
    `${wtBase}/docs/sandbox-security.md`,
    `${wtBase}/docs/token-usage-analysis.md`,
  ]);
});

test("prettier ordering: prettier runs BEFORE git add (no 'add' in gitCalls snapshot at call time)", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();

  const call = h.prettierCalls[0]!;
  expect(call.gitOpsAtCall).not.toContain("add");
});

test("prettier regression: docs-site paths are never passed to prettier", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();

  const call = h.prettierCalls[0]!;
  for (const f of call.files) {
    expect(f).not.toContain("docs-site");
  }
});

// ── real-prettier tests: the ignore-path fix + fail-closed --check guard ────────
// These drive the REAL defaultPrettierWrite/assertPrettierClean (not the mocked seam), so they
// prove the two halves the seam-based tests above cannot: (1) formatting is not silently skipped
// when the worktree lives under a `.shepherd-*` path, and (2) the `--check` guard actually detects
// a non-conformant file. They use SERVER_INSTALL_ROOT as cwd (real node_modules → prettier plugins
// resolve) and the repo's real .prettierrc as the config, matching production.

const execFileP = promisify(execFile);
const REPO_PRETTIERRC = join(SERVER_INSTALL_ROOT, ".prettierrc");
// A deliberately non-canonical Markdown table: prettier re-pads the first column to the width of
// `attachmentNames`, so the input differs from prettier's output (the exact #1517 failure shape).
const UNFORMATTED_MD = [
  "# Doc",
  "",
  "| Field | Notes |",
  "| --- | --- |",
  "| `x` | short |",
  "| `attachmentNames` | longer |",
  "",
].join("\n");

/** Make a temp "worktree" whose path contains a `.shepherd-*` component (like the real
 *  `.shepherd-worktrees/…`), holding a single unformatted `docs/<name>.md`. Returns the abs file
 *  path + a cleanup thunk. */
function mkShepherdWorktreeDoc(name = "foo.md"): { file: string; cleanup: () => void } {
  // mkdtemp prefix `.shepherd-wt-` → the created dir matches the `.shepherd-*` glob in the repo's
  // .prettierignore, reproducing the silent-skip that made doc PRs fail CI.
  const wt = mkdtempSync(join(tmpdir(), ".shepherd-wt-"));
  mkdirSync(join(wt, "docs"));
  const file = join(wt, "docs", name);
  writeFileSync(file, UNFORMATTED_MD);
  return { file, cleanup: () => rmSync(wt, { recursive: true, force: true }) };
}

test("prettier fix (regression): defaultPrettierWrite formats a doc under a .shepherd-* worktree that the old path silently skipped", async () => {
  const { file, cleanup } = mkShepherdWorktreeDoc();
  try {
    const binary = join(SERVER_INSTALL_ROOT, "node_modules", ".bin", "prettier");

    // NEGATIVE CONTROL: the OLD invocation (no --ignore-path devNull) from cwd=SERVER_INSTALL_ROOT
    // must leave the file BYTE-UNCHANGED — prettier treats it as ignored (path matches `.shepherd-*`
    // in the repo .prettierignore). Without this, a mis-built temp layout would make the assertion
    // below pass vacuously (the file would have formatted even without the fix).
    await execFileP(binary, ["--write", "--config", REPO_PRETTIERRC, "--", file], {
      cwd: SERVER_INSTALL_ROOT,
    });
    expect(readFileSync(file, "utf8")).toBe(UNFORMATTED_MD); // proven: layout reproduces the skip

    // PATCHED: the real defaultPrettierWrite (adds --ignore-path devNull) MUST format it.
    await defaultPrettierWrite({
      cwd: SERVER_INSTALL_ROOT,
      configPath: REPO_PRETTIERRC,
      files: [file],
    });
    const formatted = readFileSync(file, "utf8");
    expect(formatted).not.toBe(UNFORMATTED_MD);
    // Alignment happened: prettier pads every table row to one width, so the short (`x`) row and the
    // wide (`attachmentNames`) row now have identical length.
    const rowX = formatted.split("\n").find((l) => l.includes("`x`"))!;
    const rowLong = formatted.split("\n").find((l) => l.includes("`attachmentNames`"))!;
    expect(rowX.length).toBe(rowLong.length);

    // INDEPENDENT CONFIRMATION: the output passes `prettier --check` from a NON-nested path (a clean
    // checkout equivalent, honoring default ignores) — i.e. it would go green in CI.
    const plain = mkdtempSync(join(tmpdir(), "plain-doc-"));
    try {
      const plainFile = join(plain, "external-task-api.md");
      writeFileSync(plainFile, formatted);
      // exit 0 ⇒ resolves; a non-zero exit would reject and fail the test.
      await execFileP(binary, ["--check", "--config", REPO_PRETTIERRC, "--", plainFile], {
        cwd: SERVER_INSTALL_ROOT,
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("prettier guard: assertPrettierClean REJECTS an unformatted doc and RESOLVES a formatted one (detection half)", async () => {
  const { file, cleanup } = mkShepherdWorktreeDoc();
  try {
    // Unformatted (and under a `.shepherd-*` path): --ignore-path devNull keeps --check non-vacuous,
    // so the guard must detect the non-conformance and reject — this is the abort trigger.
    await expect(
      assertPrettierClean({ cwd: SERVER_INSTALL_ROOT, configPath: REPO_PRETTIERRC, files: [file] }),
    ).rejects.toThrow();

    // After formatting the SAME file, the guard must resolve (idempotency: no false-positive abort).
    await defaultPrettierWrite({
      cwd: SERVER_INSTALL_ROOT,
      configPath: REPO_PRETTIERRC,
      files: [file],
    });
    await assertPrettierClean({
      cwd: SERVER_INSTALL_ROOT,
      configPath: REPO_PRETTIERRC,
      files: [file],
    });
  } finally {
    cleanup();
  }
});

test("PrettierFormatError: is exported, carries repoPath + files, name is set correctly", () => {
  const cause = new Error("binary not found");
  const err = new PrettierFormatError("/repo", ["/wt/docs/a.md"], { cause });
  expect(err).toBeInstanceOf(PrettierFormatError);
  expect(err.name).toBe("PrettierFormatError");
  expect(err.repoPath).toBe("/repo");
  expect(err.files).toEqual(["/wt/docs/a.md"]);
  expect(err.cause).toBe(cause);
  expect(err.message).toContain("/repo");
  expect(err.message).toContain("/wt/docs/a.md");
});

test("prettier failure path: throwing prettier ABORTS the run (no commit/push/PR), records error outcome, cleans up (fail-closed)", async () => {
  const h = mkHarness({ act: true, prettierThrows: true });
  await h.svc.consider("/repo");
  await h.svc.tick();

  // fail-closed: no commit, no push, no PR
  expect(h.gitCalls.some((c) => c.args[0] === "commit")).toBe(false);
  expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
  expect(h.openPrInputs).toHaveLength(0);

  // error outcome recorded and fired through onChange
  expect(h.finalizes).toHaveLength(1);
  expect(h.finalizes[0]).toEqual({ repoPath: "/repo", url: null, outcome: "error" });

  // recorded in store
  const runs = h.kv.get("docagent:runs:/repo");
  expect(runs).toBeDefined();
  const parsed = JSON.parse(runs!) as { outcome: string; url: string | null }[];
  expect(parsed[0]!.outcome).toBe("error");
  expect(parsed[0]!.url).toBeNull();

  // cleanup still ran: worktree removed AND herdr.stop called
  expect(h.removedWorktrees).toHaveLength(1);
  expect(h.stoppedTerminals).toHaveLength(1);
});

// ── outcome tracking (issue #906) ────────────────────────────────────────────
test("finalize: act + staged changes → outcome 'pr', onChange carries it, run recorded", async () => {
  const h = mkHarness({ act: true });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.finalizes).toHaveLength(1);
  expect(h.finalizes[0]).toEqual({ repoPath: "/repo", url: "https://forge/pr/42", outcome: "pr" });
  const runs = h.kv.get("docagent:runs:/repo");
  expect(runs).toBeDefined();
  const parsed = JSON.parse(runs!) as { outcome: string; url: string | null; at: number }[];
  expect(parsed).toHaveLength(1);
  expect(parsed[0]!.outcome).toBe("pr");
  expect(parsed[0]!.url).toBe("https://forge/pr/42");
});

test("finalize: observe (act:false) + staged changes → outcome 'observe', url null", async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    const h = mkHarness({ act: false });
    await h.svc.consider("/repo");
    await h.svc.tick();
    expect(h.finalizes).toHaveLength(1);
    expect(h.finalizes[0]).toEqual({ repoPath: "/repo", url: null, outcome: "observe" });
    const runs = h.kv.get("docagent:runs:/repo");
    const parsed = JSON.parse(runs!) as { outcome: string }[];
    expect(parsed[0]!.outcome).toBe("observe");
  } finally {
    console.warn = orig;
  }
});

test("finalize: no staged changes → outcome 'nochange', url null", async () => {
  const h = mkHarness({ stagedNames: "" });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.finalizes).toHaveLength(1);
  expect(h.finalizes[0]).toEqual({ repoPath: "/repo", url: null, outcome: "nochange" });
  const runs = h.kv.get("docagent:runs:/repo");
  const parsed = JSON.parse(runs!) as { outcome: string }[];
  expect(parsed[0]!.outcome).toBe("nochange");
});

// ── re-target: fold docs into the open code PR (issue #956 Option B) ─────────────

const PR_SYNCED = (repo: string, pr: number) => `docagent:pr-synced:${repo}:${pr}`;
const RETARGET_MARKER_FILE = ".shepherd-doc-retarget.json";

/** A re-target sweep fixture: one idle session whose code PR is open+green+doc-relevant, with the
 *  debounce threshold at 0 so a single sweep tick fires immediately (no idle-clock advance needed). */
function mkRetargetHarness(over?: Parameters<typeof mkHarness>[0]) {
  const session = mkSession({
    id: "sess-1",
    repoPath: "/repo",
    branch: "feature/x",
    worktreePath: "/owner/wt",
    status: "idle",
  });
  return mkHarness({
    idleThresholdMs: 0,
    sessions: [session],
    gitStateById: {
      "sess-1": mkGitState({ number: 7, headSha: "headsha1", url: "https://forge/pr/7" }),
    },
    ...over,
  });
}

test("re-target sweep: open+green+doc-relevant+settled → beginRetarget, claims prSyncedKey, worktree at headSha", async () => {
  const h = mkRetargetHarness();
  // first tick starts the idle clock (threshold 0 → still needs the second tick per the debounce model)
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(1);
  expect(h.kv.get(PR_SYNCED("/repo", 7))).toBe("1");
  // a durable doc_agent cost row was recorded for the re-target run
  expect(h.spawnRows).toHaveLength(1);
  expect(h.spawnRows[0]!.kind).toBe("doc_agent");
  // a re-target marker was written into the new worktree root
  const markerEntry = [...h.markers.entries()].find(([p]) => p.endsWith(RETARGET_MARKER_FILE));
  expect(markerEntry).toBeDefined();
  const parsed = JSON.parse(markerEntry![1]) as { prNumber: number; headBranch: string };
  expect(parsed.prNumber).toBe(7);
  expect(parsed.headBranch).toBe("feature/x");
});

test("re-target gate: running/blocked session → no fire, debounce reset", async () => {
  for (const status of ["running", "blocked"] as const) {
    const h = mkRetargetHarness({
      sessions: [mkSession({ id: "sess-1", status })],
    });
    await h.svc.sweepReadyPrs();
    await h.svc.sweepReadyPrs();
    expect(h.starts).toHaveLength(0);
  }
});

test("re-target gate: checks !== success → no fire", async () => {
  const h = mkRetargetHarness({
    gitStateById: { "sess-1": mkGitState({ checks: "pending" }) },
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
});

test("re-target gate: state !== open → no fire", async () => {
  const h = mkRetargetHarness({
    gitStateById: { "sess-1": mkGitState({ state: "merged" }) },
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
});

test("re-target gate: non-doc-relevant title → no fire", async () => {
  const h = mkRetargetHarness({
    gitStateById: { "sess-1": mkGitState({ title: "fix: a bug" }) },
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
});

test("re-target gate: prSyncedKey already set → no fire", async () => {
  const h = mkRetargetHarness();
  h.kv.set(PR_SYNCED("/repo", 7), "1");
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
});

test("re-target gate: missing git / headSha / number / branch / doc-tree → no fire", async () => {
  // no git state
  let h = mkRetargetHarness({ gitStateById: {} });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  // missing headSha
  h = mkRetargetHarness({ gitStateById: { "sess-1": mkGitState({ headSha: undefined }) } });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  // missing number
  h = mkRetargetHarness({ gitStateById: { "sess-1": mkGitState({ number: undefined }) } });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  // missing branch
  h = mkRetargetHarness({ sessions: [mkSession({ id: "sess-1", branch: null })] });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  // no doc tree
  h = mkRetargetHarness({ docTreePresent: false });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
});

test("re-target debounce: first settle tick does NOT fire; fires only after idleMs >= threshold", async () => {
  let nowVal = 1000;
  const h = mkRetargetHarness({ idleThresholdMs: 5000, now: () => nowVal });
  await h.svc.sweepReadyPrs(); // first settle tick: starts the clock
  expect(h.starts).toHaveLength(0);
  nowVal = 1000 + 4999; // not yet settled long enough
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  nowVal = 1000 + 5000; // threshold reached
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(1);
});

test("re-target debounce: resets when the session goes running then settles again", async () => {
  let nowVal = 1000;
  const session = mkSession({ id: "sess-1", status: "idle" });
  const h = mkHarness({
    idleThresholdMs: 5000,
    now: () => nowVal,
    sessions: [session],
    gitStateById: { "sess-1": mkGitState() },
  });
  await h.svc.sweepReadyPrs(); // start clock
  session.status = "running"; // re-activated → debounce reset
  nowVal = 1000 + 6000;
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  // settles again — clock restarts from now
  session.status = "idle";
  await h.svc.sweepReadyPrs(); // restart clock
  expect(h.starts).toHaveLength(0);
  nowVal = nowVal + 5000;
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(1);
});

test("re-target debounce: per-repo inflight lock blocks fire WITHOUT setting fired (retries next tick)", async () => {
  const session = mkSession({ id: "sess-1", status: "idle" });
  const h = mkHarness({
    idleThresholdMs: 0,
    sessions: [session],
    gitStateById: { "sess-1": mkGitState() },
  });
  // a fresh run is in flight for the repo (occupies the lock)
  await h.svc.consider("/repo");
  expect(h.svc.isRunning("/repo")).toBe(true);
  await h.svc.sweepReadyPrs(); // start clock
  await h.svc.sweepReadyPrs(); // would fire, but the lock blocks it (fired NOT set)
  expect(h.starts).toHaveLength(1); // only the fresh consider's spawn
  // free the lock by finalizing the fresh run, then the next sweep fires the re-target
  await h.svc.tick();
  expect(h.svc.isRunning("/repo")).toBe(false);
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(2);
});

test("re-target finalize, PR still open: commits + pushes HEAD:refs/heads/<headBranch>, opens NO new PR, outcome 'pr'", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  // committed --no-verify
  expect(h.gitCalls.some((c) => c.args[0] === "commit" && c.args.includes("--no-verify"))).toBe(
    true,
  );
  // pushed onto the code PR's head branch with the exact refspec (no force, no -u of docs-update)
  const push = h.gitCalls.find((c) => c.args[0] === "push");
  expect(push!.args).toEqual(["push", "origin", "HEAD:refs/heads/feature/x"]);
  // NO new PR opened
  expect(h.openPrInputs).toHaveLength(0);
  // outcome pr with the existing PR url
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: "https://forge/pr/7", outcome: "pr" }]);
  // never force-pushed
  expect(h.gitCalls.some((c) => c.args.includes("--force") || c.args.includes("-f"))).toBe(false);
});

test("re-target finalize cleanup: deletes the local docs-update branch, never the code PR head branch", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  const branchDeletes = h.gitCalls.filter((c) => c.args[0] === "branch" && c.args[1] === "-D");
  expect(branchDeletes).toHaveLength(1);
  expect(branchDeletes[0]!.args[2]).toMatch(/^shepherd\/docs-update-/);
  // the code PR head branch is NEVER deleted
  expect(h.gitCalls.some((c) => c.args.includes("feature/x") && c.args.includes("-D"))).toBe(false);
});

test("re-target merged-first: PR not open at finalize → ONE fresh PR (openPr + push docs-update), onMergedPr then skipped", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "merged" } },
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  // fell through to the fresh path: pushed the docs-update branch + opened exactly one PR
  expect(h.openPrInputs).toHaveLength(1);
  expect((h.openPrInputs[0] as any).head).toMatch(/^shepherd\/docs-update-/);
  const push = h.gitCalls.find((c) => c.args[0] === "push");
  expect(push!.args[1]).toBe("-u");
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: "https://forge/pr/42", outcome: "pr" }]);
  // the prSyncedKey is set → a now-merged onMergedPr for that PR is deferred (no second doc run)
  const res = await h.svc.onMergedPr("/repo", 7, "feat(ui): add thing", "main");
  expect(res.status).toBe("skipped");
  expect(res.reason).toContain("re-target already owns");
});

test("re-target owner ff: runs when owner worktree clean + at pre-push head; never force", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
    ownerStatusPorcelain: "",
    ownerHead: "headsha1", // equals git.headSha
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  // ff fetched the code branch + merged --ff-only into the owner worktree
  const fetch = h.gitCalls.find((c) => c.args[0] === "fetch" && c.cwd === "/owner/wt");
  expect(fetch!.args).toEqual(["fetch", "origin", "feature/x"]);
  const ff = h.gitCalls.find((c) => c.args[0] === "merge" && c.cwd === "/owner/wt");
  expect(ff!.args).toEqual(["merge", "--ff-only", "origin/feature/x"]);
});

test("re-target owner ff: skipped when owner worktree dirty", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
    ownerStatusPorcelain: " M src/index.ts", // dirty
    ownerHead: "headsha1",
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  expect(h.gitCalls.some((c) => c.args[0] === "merge" && c.cwd === "/owner/wt")).toBe(false);
  expect(h.gitCalls.some((c) => c.args[0] === "fetch" && c.cwd === "/owner/wt")).toBe(false);
});

test("re-target owner ff: skipped when owner HEAD moved off the pre-push head", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
    ownerStatusPorcelain: "",
    ownerHead: "movedsha", // != git.headSha
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  expect(h.gitCalls.some((c) => c.args[0] === "merge" && c.cwd === "/owner/wt")).toBe(false);
});

test("onMergedPr: skips when prSyncedKey set; fires fresh consider when unset", async () => {
  // unset → fires (current behavior)
  const h1 = mkHarness();
  const r1 = await h1.svc.onMergedPr("/repo", 7, "feat: x", "main");
  expect(r1.status).toBe("started");
  // set → defers, and crucially does NOT consume mergedSeenKey
  const h2 = mkHarness();
  h2.kv.set(PR_SYNCED("/repo", 7), "1");
  const r2 = await h2.svc.onMergedPr("/repo", 7, "feat: x", "main");
  expect(r2.status).toBe("skipped");
  expect(h2.starts).toHaveLength(0);
  expect(h2.kv.has(MERGED_SEEN("/repo", 7))).toBe(false);
});

test("reapOrphans: worktree with a re-target marker re-adopts as mode:retarget and pushes onto the PR head", async () => {
  const markerPath = "/wt/docs-update-rt000001/.shepherd-doc-retarget.json";
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: DOCS_WT_PORCELAIN("rt000001"),
    sentinel: "## Changes\n- updated configuration.md\n",
    act: true,
    markerFiles: {
      [markerPath]: JSON.stringify({ prNumber: 7, headBranch: "feature/x", base: "main" }),
    },
    prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
  });
  await h.svc.reapOrphans();
  await h.svc.tick();
  // re-adopted as a re-target run → pushed onto the code PR's head branch, opened no new PR
  const push = h.gitCalls.find((c) => c.args[0] === "push");
  expect(push!.args).toEqual(["push", "origin", "HEAD:refs/heads/feature/x"]);
  expect(h.openPrInputs).toHaveLength(0);
});

test("reapOrphans: worktree WITHOUT a marker re-adopts as mode:fresh (opens a standalone PR)", async () => {
  const h = mkHarness({
    repos: ["/repo"],
    worktreeListPorcelain: DOCS_WT_PORCELAIN("fr000001"),
    sentinel: "## Changes\n- updated configuration.md\n",
    act: true,
  });
  await h.svc.reapOrphans();
  await h.svc.tick();
  expect(h.openPrInputs).toHaveLength(1);
  expect((h.openPrInputs[0] as any).head).toBe("shepherd/docs-update-fr000001");
});

test("re-target OBSERVE (act:false): logs, does not push or openPr", async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.join(" "));
  };
  try {
    const h = mkRetargetHarness({
      act: false,
      prStatusFull: { "feature/x": { state: "open", url: "https://forge/pr/7" } },
    });
    await h.svc.sweepReadyPrs();
    await h.svc.sweepReadyPrs();
    await h.svc.tick();
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(h.gitCalls.some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.openPrInputs).toHaveLength(0);
    expect(h.finalizes).toEqual([{ repoPath: "/repo", url: null, outcome: "observe" }]);
    expect(warns.some((w) => w.includes("[doc-agent] OBSERVE:") && w.includes("PR #7"))).toBe(true);
  } finally {
    console.warn = orig;
  }
});

test("onArchived: frees the readyDebounce entry so a re-archive session is treated as a fresh first-tick", async () => {
  // Build a harness with idleThresholdMs=0 so the second sweep tick fires immediately.
  const h = mkRetargetHarness({ idleThresholdMs: 0 });
  // First tick starts the idle clock (records a readyDebounce entry, does NOT fire).
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0);
  // Archive the session — onArchived should delete the debounce entry.
  h.svc.onArchived("sess-1");
  // A subsequent settled sweep must treat this as a fresh first-tick (NOT fire immediately),
  // because the debounce entry was cleared and the idle clock needs to restart.
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(0); // still on first tick post-archive
  // One more tick crosses the threshold (idleThresholdMs=0, so any non-zero elapsed qualifies).
  await h.svc.sweepReadyPrs();
  expect(h.starts).toHaveLength(1); // fires only on the second post-archive tick
});

// ── roll-up: never >1 open standalone docs PR ─────────────────────────────────

test("roll-up: one existing docs PR → rolls up, no openPr, body refreshed", async () => {
  const h = mkHarness({
    act: true,
    openDocPrs: [{ number: 5, headRefName: "shepherd/docs-update-old00001" }],
  });
  await h.svc.consider("/repo");
  await h.svc.tick();
  // no new PR opened
  expect(h.openPrInputs).toHaveLength(0);
  // force-pushed onto the existing PR's head branch
  expect(
    h.gitCalls.some(
      (c) =>
        c.args[0] === "push" &&
        c.args[1] === "--force" &&
        c.args[2] === "origin" &&
        c.args[3] === "HEAD:refs/heads/shepherd/docs-update-old00001",
    ),
  ).toBe(true);
  // editPr called once with PR #5 and body containing expected content
  expect(h.editPrCalls).toHaveLength(1);
  expect(h.editPrCalls[0]!.prNumber).toBe(5);
  expect(h.editPrCalls[0]!.body).toContain("never auto-merged");
  expect(h.editPrCalls[0]!.body).toContain("configuration.md");
  // finalize emits the existing PR url + outcome pr
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: "https://forge/pr/5", outcome: "pr" }]);
});

test("roll-up: two existing docs PRs → rolls up onto LOWEST number, opens no PR", async () => {
  const h = mkHarness({
    act: true,
    openDocPrs: [
      { number: 9, headRefName: "shepherd/docs-update-bbb99999" },
      { number: 4, headRefName: "shepherd/docs-update-aaa44444" },
    ],
  });
  await h.svc.consider("/repo");
  await h.svc.tick();
  // force-pushed onto the LOWEST-numbered PR's branch
  expect(
    h.gitCalls.some(
      (c) =>
        c.args[0] === "push" &&
        c.args[1] === "--force" &&
        c.args[3] === "HEAD:refs/heads/shepherd/docs-update-aaa44444",
    ),
  ).toBe(true);
  expect(h.openPrInputs).toHaveLength(0);
  expect(h.editPrCalls[0]!.prNumber).toBe(4);
  expect(h.finalizes[0]!.url).toBe("https://forge/pr/4");
});

test("roll-up: zero existing docs PRs → opens fresh PR (regression)", async () => {
  const h = mkHarness({ act: true, openDocPrs: [] });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.openPrInputs).toHaveLength(1);
  expect(h.gitCalls.some((c) => c.args.includes("--force"))).toBe(false);
});

test("roll-up OBSERVE (act:false): logs roll-up intent, no side effects", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
  };
  try {
    const h = mkHarness({
      openDocPrs: [{ number: 5, headRefName: "shepherd/docs-update-old00001" }],
    });
    await h.svc.consider("/repo");
    await h.svc.tick();
    // no commit, no push, no openPr, no editPr
    expect(h.gitCalls.some((c) => c.args[0] === "commit")).toBe(false);
    expect(h.gitCalls.some((c) => c.args[0] === "push")).toBe(false);
    expect(h.openPrInputs).toHaveLength(0);
    expect(h.editPrCalls).toHaveLength(0);
    // observe outcome
    expect(h.finalizes[0]!.outcome).toBe("observe");
    // OBSERVE log mentions roll-up + PR number
    expect(warnings.some((w) => w.includes("roll up") && w.includes("#5"))).toBe(true);
  } finally {
    console.warn = orig;
  }
});

test("roll-up: force-push fails → defer (null url), no fresh PR, no editPr", async () => {
  const h = mkHarness({
    act: true,
    openDocPrs: [{ number: 5, headRefName: "shepherd/docs-update-old00001" }],
    forcePushThrows: true,
  });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.openPrInputs).toHaveLength(0);
  expect(h.editPrCalls).toHaveLength(0);
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: null, outcome: "nochange" }]);
});

test("roll-up: editPr absent → push lands, outcome pr (stale-body fallback)", async () => {
  const h = mkHarness({
    act: true,
    openDocPrs: [{ number: 5, headRefName: "shepherd/docs-update-old00001" }],
    noEditPr: true,
  });
  await h.svc.consider("/repo");
  await h.svc.tick();
  // force-push still happened
  expect(h.gitCalls.some((c) => c.args[0] === "push" && c.args[1] === "--force")).toBe(true);
  expect(h.openPrInputs).toHaveLength(0);
  expect(h.finalizes[0]).toEqual({ repoPath: "/repo", url: "https://forge/pr/5", outcome: "pr" });
});

test("roll-up: editPr throws → push lands, outcome pr, edit was attempted", async () => {
  const h = mkHarness({
    act: true,
    openDocPrs: [{ number: 5, headRefName: "shepherd/docs-update-old00001" }],
    editPrThrows: true,
  });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.editPrCalls).toHaveLength(1);
  expect(h.openPrInputs).toHaveLength(0);
  expect(h.finalizes[0]!.url).toBe("https://forge/pr/5");
  expect(h.finalizes[0]!.outcome).toBe("pr");
});

test("roll-up: listPullRequests throws → fail-open opens fresh PR", async () => {
  const h = mkHarness({ act: true, listPullRequestsThrows: true });
  await h.svc.consider("/repo");
  await h.svc.tick();
  expect(h.openPrInputs).toHaveLength(1);
  expect(h.gitCalls.some((c) => c.args.includes("--force"))).toBe(false);
});

test("roll-up: re-target merged-mid-run fallback with existing docs PR → rolls up, no fresh PR", async () => {
  const h = mkRetargetHarness({
    act: true,
    prStatusFull: { "feature/x": { state: "merged" } },
    openDocPrs: [{ number: 5, headRefName: "shepherd/docs-update-old00001" }],
  });
  await h.svc.sweepReadyPrs();
  await h.svc.sweepReadyPrs();
  await h.svc.tick();
  // rolled up rather than opening a fresh PR
  expect(h.openPrInputs).toHaveLength(0);
  expect(
    h.gitCalls.some(
      (c) =>
        c.args[0] === "push" &&
        c.args[1] === "--force" &&
        c.args[3] === "HEAD:refs/heads/shepherd/docs-update-old00001",
    ),
  ).toBe(true);
  expect(h.editPrCalls[0]!.prNumber).toBe(5);
  expect(h.finalizes[0]).toEqual({ repoPath: "/repo", url: "https://forge/pr/5", outcome: "pr" });
});

// ── plugin onSpawn hook: abort → skipped (issue #1205) ───────────────────────

test("onSpawn abortSpawn → doc run skipped, worktree reaped, no spawn", async () => {
  const h = mkHarness({
    act: true,
    runSpawnHooks: async () => {
      throw new PluginSpawnAborted("pool exhausted", "cswap");
    },
  });
  const res = await h.svc.consider("/repo");
  expect(res.status).toBe("skipped");
  expect(res.reason).toBe("plugin aborted spawn");
  expect(h.starts).toHaveLength(0); // herdr.start never reached
  expect(h.removedWorktrees.length).toBeGreaterThan(0); // the doc worktree was reaped
});
