import { test, expect } from "bun:test";
import { DocAgentService, DOC_AGENT_LABEL, type DocAgentFinalize } from "../src/doc-agent";
import { config } from "../src/config";

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

interface Harness {
  svc: DocAgentService;
  gitCalls: GitCall[];
  starts: { name: string; cwd: string }[];
  closedTabs: string[];
  removedWorktrees: string[];
  openPrInputs: unknown[];
  mergeCalls: number;
  finalizes: DocAgentFinalize[];
}

function mkHarness(opts?: {
  forgeKind?: "github" | "local" | null;
  docTreePresent?: boolean;
  inScopeFilesPresent?: boolean;
  sentinel?: string | null;
  stagedNames?: string; // stdout of `git diff --cached --name-only`
  worktreeListPorcelain?: string;
  herdrAgents?: { name: string; tabId: string }[];
  repos?: string[];
}): Harness {
  const o = {
    forgeKind: "github" as "github" | "local" | null,
    docTreePresent: true,
    inScopeFilesPresent: true,
    sentinel: "## Changes\n- updated configuration.md (grounded in src/config.ts)\n" as
      | string
      | null,
    stagedNames: "docs-site/src/content/docs/reference/configuration.md",
    worktreeListPorcelain: "",
    herdrAgents: [] as { name: string; tabId: string }[],
    repos: [] as string[],
    ...opts,
  };

  const gitCalls: GitCall[] = [];
  const starts: { name: string; cwd: string }[] = [];
  const closedTabs: string[] = [];
  const removedWorktrees: string[] = [];
  const openPrInputs: unknown[] = [];
  const finalizes: DocAgentFinalize[] = [];
  let mergeCalls = 0;

  const git = async (cwd: string, args: string[]): Promise<string> => {
    gitCalls.push({ cwd, args });
    if (args[0] === "diff" && args[1] === "--cached") return o.stagedNames;
    if (args[0] === "worktree" && args[1] === "list") return o.worktreeListPorcelain;
    return "";
  };

  const forge =
    o.forgeKind === null
      ? null
      : ({
          kind: o.forgeKind,
          defaultBranch: async () => "main",
          openPr: async (input: unknown) => {
            openPrInputs.push(input);
            return { url: "https://forge/pr/42" };
          },
          merge: async () => {
            mergeCalls++;
          },
        } as any);

  const herdr = {
    start: (name: string, cwd: string) => {
      starts.push({ name, cwd });
      return { terminalId: "term-" + starts.length } as any;
    },
    stop: () => {},
    list: () => o.herdrAgents.map((a) => ({ name: a.name, tabId: a.tabId }) as any),
    closeTab: (tabId: string) => {
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
    ensureBaseRef: async (_repo: string, base: string) => ({
      baseRef: base,
      behind: 0,
      ahead: 0,
      diverged: false,
      hasUpstream: true,
      localExists: true,
      localFf: "not-needed" as const,
    }),
  };

  const svc = new DocAgentService({
    herdr: herdr as any,
    worktree: worktree as any,
    resolveForge: () => forge,
    repos: () => o.repos,
    model: null,
    onChange: (f) => finalizes.push(f),
    now: () => 1000,
    git,
    detectBackend: () => null,
    membraneEnv: () => ({ claudeDir: "/c", home: "/h", nodeBinReal: "/n", extraEnv: {} }),
    fileExists: (p: string) => {
      if (p.endsWith("docs-site/src/content/docs")) return o.docTreePresent;
      return o.inScopeFilesPresent;
    },
    readSentinel: () => o.sentinel,
  });

  return {
    svc,
    gitCalls,
    starts,
    closedTabs,
    removedWorktrees,
    openPrInputs,
    finalizes,
    mergeCalls: 0,
    get __merge() {
      return mergeCalls;
    },
  } as any as Harness & { __merge: number };
}

test("happy path: in-scope edits → commit --no-verify + push + openPr (never merge)", async () => {
  const h = mkHarness();
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
  // finalize emits the url
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: "https://forge/pr/42" }]);
  // cleanup
  expect(h.removedWorktrees.length).toBeGreaterThan(0);
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
  expect(h.finalizes).toEqual([{ repoPath: "/repo", url: null }]);
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

test("sweepOrphans: closes only __docagent__ tabs and prunes only docs-update worktrees", async () => {
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
    herdrAgents: [
      { name: "__docagent__deadbeef", tabId: "tab-doc" },
      { name: "review TASK-7", tabId: "tab-review" },
    ],
  });
  await h.svc.sweepOrphans();
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
