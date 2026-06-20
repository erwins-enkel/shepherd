import { test, expect } from "bun:test";
import {
  DocAgentService,
  DOC_AGENT_LABEL,
  isDocRelevantMerge,
  type DocAgentFinalize,
} from "../src/doc-agent";
import { config, parseHour } from "../src/config";

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
  ensureBaseRefCalls: { repo: string; base: string }[];
  kv: Map<string, string>;
  __merge: number;
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
  originSha?: string | (() => string);
  originShaThrows?: boolean;
  now?: () => number;
  nightlyHour?: number;
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
    originSha: "origin-sha-1" as string,
    originShaThrows: false,
    now: () => 1000,
    nightlyHour: 3,
    ...opts,
  };

  const gitCalls: GitCall[] = [];
  const starts: { name: string; cwd: string }[] = [];
  const closedTabs: string[] = [];
  const removedWorktrees: string[] = [];
  const openPrInputs: unknown[] = [];
  const finalizes: DocAgentFinalize[] = [];
  const ensureBaseRefCalls: { repo: string; base: string }[] = [];
  const kv = new Map<string, string>();
  const store = {
    getSetting: (key: string) => kv.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      kv.set(key, value);
    },
  };
  let mergeCalls = 0;

  const git = async (cwd: string, args: string[]): Promise<string> => {
    gitCalls.push({ cwd, args });
    if (args[0] === "diff" && args[1] === "--cached") return o.stagedNames;
    if (args[0] === "worktree" && args[1] === "list") return o.worktreeListPorcelain;
    if (args[0] === "rev-parse" && args[1]?.startsWith("refs/remotes/origin/")) {
      if (o.originShaThrows) throw new Error("no such ref");
      return typeof o.originSha === "function" ? (o.originSha as () => string)() : o.originSha;
    }
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
    store,
    nightlyHour: o.nightlyHour,
    model: null,
    onChange: (f) => finalizes.push(f),
    now: o.now,
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
    ensureBaseRefCalls,
    kv,
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

test("merge: feat-subject PR → spawn once + merged-seen persisted; no fetch in onMergedPr", async () => {
  const h = mkHarness();
  const res = await h.svc.onMergedPr("/repo", 42, "feat(ui): add thing");
  expect(res.status).toBe("started");
  expect(h.starts).toHaveLength(1);
  expect(h.kv.get(MERGED_SEEN("/repo", 42))).toBe("1");
  // onMergedPr itself does no rev-parse before consider(); begin()'s stampLastSha does the only one
  const revParses = h.gitCalls.filter((c) => c.args[0] === "rev-parse");
  expect(revParses).toHaveLength(1);
});

test("merge: non-doc-relevant subject → skip, no spawn, no merged-seen", async () => {
  const h = mkHarness();
  const res = await h.svc.onMergedPr("/repo", 7, "fix: a bug");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
  expect(h.kv.has(MERGED_SEEN("/repo", 7))).toBe(false);
});

test("merge restart-idempotency: merged-seen already set → skip (boot-replay no-op)", async () => {
  const h = mkHarness();
  h.kv.set(MERGED_SEEN("/repo", 42), "1");
  const res = await h.svc.onMergedPr("/repo", 42, "feat: x");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
});

test("merge: absent PR number → skip", async () => {
  const h = mkHarness();
  const res = await h.svc.onMergedPr("/repo", undefined, "feat: x");
  expect(res.status).toBe("skipped");
  expect(h.starts).toHaveLength(0);
});
