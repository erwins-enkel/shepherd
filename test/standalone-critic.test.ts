import { test, expect, beforeEach, afterEach } from "bun:test";
import { StandalonePrCriticService } from "../src/standalone-critic";
import type { RawVerdict } from "../src/critic-core";
import type { VerdictRead } from "../src/json-tolerant";
import { CRITIC_REVIEW_MARKER, EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import { graphRateLimit } from "../src/forge/rate-limit";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";
import type { GitForge, PrReviewMeta, PullRequest } from "../src/forge/types";
import type { PrReview } from "../src/types";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
  graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
});

async function withAuth<T>(
  mode: typeof config.authMode,
  helper: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  try {
    return await fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "Add a feature",
    url: "u",
    author: "alice",
    kind: "regular",
    createdAt: 0,
    isDraft: false,
    mergeable: true,
    checks: "success",
    jobs: [],
    headSha: "abc123",
    headRefName: "feat/x",
    ...over,
  };
}

const OPEN_META: PrReviewMeta = {
  body: "does the thing",
  baseRefName: "main",
  isCrossRepository: false,
  state: "open",
};

interface Spies {
  posted: { n: number; event: string; body: string }[];
  comments: { n: number; body: string }[];
  started: { name: string; cwd: string; argv: string[]; env?: Record<string, string> }[];
  stopped: string[];
  removed: string[];
  created: { branch: string; sha: string; slug?: string; pullRef?: string }[];
  bumped: { repoPath: string; prNumber: number; headSha: string }[];
  puts: PrReview[];
  recordedSpawns: any[];
  completedSpawns: any[];
  logs: string[];
}

function makeForge(
  spies: Spies,
  opts: {
    prs?: PullRequest[];
    meta?: (n: number) => Promise<PrReviewMeta | null>;
    noComment?: boolean;
    noMeta?: boolean;
  } = {},
): GitForge {
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => opts.prs ?? [pr()],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "open", checks: "success", deployConfigured: false }),
    openPr: async () => ({ state: "open", checks: "success", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    defaultBranch: async () => "main",
    postReview: async (n, o) => {
      spies.posted.push({ n, event: o.event, body: o.body });
      return { url: "ru" };
    },
  };
  if (!opts.noMeta) forge.prReviewMeta = opts.meta ?? (async () => OPEN_META);
  if (!opts.noComment)
    forge.comment = async (n, body) => {
      spies.comments.push({ n, body });
    };
  return forge;
}

function makeDeps(
  over: Partial<any> = {},
  opts: {
    repos?: string[];
    criticAllPrs?: boolean | ((r: string) => boolean);
    criticEnabled?: boolean;
    managed?: (r: string) => Set<string>;
    forge?: (r: string) => GitForge | null;
    priorReviews?: Record<string, PrReview>; // keyed `${repo}#${n}`
    concurrency?: number;
    // epic_completed rows surfaced by store.listEpicCompleted() (Stage B, #635). A row whose
    // landingState is "open" unions its repo into the swept set even with criticAllPrs OFF; a
    // "merged" row is no longer reviewable and drops out.
    epicCompleted?: {
      repoPath: string;
      landingPrNumber: number | null;
      landingState?: string;
    }[];
  } = {},
) {
  const spies: Spies = {
    posted: [],
    comments: [],
    started: [],
    stopped: [],
    removed: [],
    created: [],
    bumped: [],
    puts: [],
    recordedSpawns: [],
    completedSpawns: [],
    logs: [],
  };
  const reviews: Record<string, PrReview> = { ...(opts.priorReviews ?? {}) };
  const rk = (repoPath: string, n: number) => `${repoPath}#${n}`;
  const deps = {
    store: {
      getRepoConfig: (r: string) => ({
        criticAllPrs:
          typeof opts.criticAllPrs === "function"
            ? opts.criticAllPrs(r)
            : (opts.criticAllPrs ?? true),
        criticEnabled: opts.criticEnabled ?? true,
      }),
      getPrReview: (repoPath: string, n: number) => reviews[rk(repoPath, n)] ?? null,
      putPrReview: (v: PrReview) => {
        spies.puts.push(v);
        reviews[rk(v.repoPath, v.prNumber)] = v;
      },
      bumpPrReviewHead: (repoPath: string, prNumber: number, headSha: string, now: number) => {
        spies.bumped.push({ repoPath, prNumber, headSha });
        const r = reviews[rk(repoPath, prNumber)];
        if (r) reviews[rk(repoPath, prNumber)] = { ...r, headSha, updatedAt: now };
      },
      recordReviewerSpawn: (r: any) => spies.recordedSpawns.push(r),
      completeReviewerSpawn: (id: string, u: any, at: number) =>
        spies.completedSpawns.push({ id, u, at }),
      // Minimal listEpicCompleted: returns the injected rows (filtered by repoPath when given),
      // shaped just enough for sweep()'s landingPrNumber != null filter + repoPath map.
      listEpicCompleted: (repoPath?: string) =>
        (opts.epicCompleted ?? []).filter((r) => repoPath === undefined || r.repoPath === repoPath),
    },
    herdr: new (class {
      readonly recorded = spies.stopped; // this-dependent: unbound call loses this.recorded
      async start(name: string, cwd: string, argv: string[], env?: Record<string, string>) {
        spies.started.push({ name, cwd, argv, env });
        return { terminalId: "rt" } as any;
      }
      async stop(t: string) {
        this.recorded.push(t); // this.recorded → throws TypeError if called unbound
      }
    })(),
    worktree: new (class {
      readonly recorded = spies.removed; // this-dependent: unbound call loses this.recorded
      createDetached = async (
        _repo: string,
        branch: string,
        sha: string,
        slug?: string,
        pullRef?: string,
      ) => {
        spies.created.push({ branch, sha, slug, pullRef });
        return { worktreePath: "/review-wt", branch: null, isolated: true };
      };
      remove(p: string) {
        this.recorded.push(p); // this.recorded → throws TypeError if called unbound
      }
      gitCommonDir = () => "/fake-git-common";
    })(),
    resolveForge: opts.forge ?? (() => makeForge(spies)),
    repos: () => opts.repos ?? ["/r"],
    managedBranches: opts.managed ?? (() => new Set<string>()),
    concurrency: opts.concurrency,
    now: () => 1000,
    log: (msg: string) => spies.logs.push(msg),
    // no real git: keep base unknown so the scope backstop is skipped (findings pass through)
    computePatchId: async () => ({ patchId: "p1", baseSha: null, files: [] }),
    readUsage: async () => null,
    // default: backend null → wrapArgv passthrough = current (pre-sandbox) behavior, so existing
    // tests stay green without spawning the real bwrap probe. membraneEnv stub keeps host paths out.
    detectBackend: () => null,
    membraneEnv: () => ({
      claudeDir: "/fake/.claude",
      home: "/fake/home",
      nodeBinReal: "/fake/bin/node",
    }),
    ...over,
    // Adapt the legacy `() => RawVerdict | null` reader (default or `over.readVerdict`) into the
    // 3-way VerdictRead the service now consumes — placed AFTER `...over` so the wrap always wins.
    // (default: a request-changes verdict with one finding.)
    readVerdict: ((): ((wt: string) => VerdictRead<RawVerdict>) => {
      const legacy: () => RawVerdict | null =
        over.readVerdict ??
        (() => ({
          decision: "request-changes",
          summary: "1 issue",
          body: "## findings",
          findings: ["feat/x: a bug"],
        }));
      return () => {
        const v = legacy();
        return v == null ? { status: "absent" } : { status: "parsed", value: v, repaired: false };
      };
    })(),
  };
  return { deps, spies, reviews };
}

// ── 1. filter ────────────────────────────────────────────────────────────────

test("reviews a fresh open green regular session-less PR", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(1);
  expect(spies.started[0]!.name).toBe("pr-critic /r#7");
  expect(spies.recordedSpawns).toHaveLength(1);
  expect(spies.recordedSpawns[0]!.taskSessionId).toBe("pr:/r#7");
  // The thinking-budget env channel was retired (issue #1419): the standalone PR critic's
  // reasoning now rides on --effort, so its --settings carries NO env key.
  const argv = spies.started[0]!.argv;
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
  expect(settings.env).toBeUndefined();
});

test("Codex critic records its resolved provider and completes without Claude usage", async () => {
  const { deps, spies } = makeDeps({
    env: () => ({ provider: "codex", model: "gpt-5.6", effort: "high" }),
    readUsage: async () => null,
  });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();

  expect(spies.recordedSpawns[0]).toMatchObject({
    reviewerProvider: "codex",
    model: "gpt-5.6",
    reviewerEffort: "high",
  });
  expect(spies.completedSpawns).toHaveLength(1);
  expect(spies.completedSpawns[0]!.u).toBeNull();
});

test("reviews a REST-enumerated green PR while GraphQL backoff is active", async () => {
  graphRateLimit.noteLimitError(60);
  let metaCalls = 0;
  const { deps, spies } = makeDeps(
    {},
    {
      forge: () =>
        makeForge(spies, {
          prs: [
            pr({
              number: 9,
              url: "https://github.com/o/r/pull/9",
              checks: "success",
              jobs: [],
              latestReview: undefined,
              headSha: "rest-sha",
              headRefName: "feat/rest",
            }),
          ],
          meta: async () => {
            metaCalls++;
            return {
              body: "REST body",
              baseRefName: "main",
              isCrossRepository: false,
              state: "open",
            };
          },
        }),
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(1);
  expect(spies.started[0]!.name).toBe("pr-critic /r#9");
  expect(metaCalls).toBe(1);
  expect(spies.created[0]).toMatchObject({ branch: "feat/rest", sha: "rest-sha" });
});

test("threads env.effort into the standalone critic argv (issue #1418)", async () => {
  const { deps, spies } = makeDeps({
    env: () => ({ provider: "claude" as const, model: null, effort: "high" }),
  });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  const argv = spies.started[0]!.argv;
  expect(argv).toContain("--effort");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
});

test("emits no --effort when env.effort is null/default (issue #1418)", async () => {
  const { deps, spies } = makeDeps({
    env: () => ({ provider: "claude" as const, model: null, effort: null }),
  });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started[0]!.argv).not.toContain("--effort");
});

test("skips draft / non-green / bot PRs", async () => {
  for (const bad of [
    pr({ number: 1, isDraft: true }),
    pr({ number: 2, checks: "pending" }),
    pr({ number: 3, checks: "failure" }),
    pr({ number: 4, kind: "dependabot" }),
    pr({ number: 5, kind: "release" }),
  ]) {
    const local = makeDeps({}, { forge: undefined });
    local.deps.resolveForge = () => makeForge(local.spies, { prs: [bad] });
    const svc = new StandalonePrCriticService(local.deps as any);
    await svc.sweep();
    expect(local.spies.started).toHaveLength(0);
  }
});

test("no-CI GitHub repo (zero workflows) reviews a checks:none PR", async () => {
  // repos() defaults to "/r" (no .github/workflows) ⇒ repoHasNoCiCached(github) → true.
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, { prs: [pr({ number: 1, checks: "none" })] });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(1);
});

test("non-GitHub forge never treats checks:none as no-CI → skips", async () => {
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () => ({
    ...makeForge(local.spies, { prs: [pr({ number: 1, checks: "none" })] }),
    kind: "gitea",
  });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(0);
});

// tiny helper for tests that re-wire the forge with throwaway spies
function spies0(): Spies {
  return {
    posted: [],
    comments: [],
    started: [],
    stopped: [],
    removed: [],
    created: [],
    bumped: [],
    puts: [],
    recordedSpawns: [],
    completedSpawns: [],
    logs: [],
  };
}

test("skips a PR already reviewed at this exact head", async () => {
  const { deps, spies } = makeDeps(
    {},
    {
      priorReviews: {
        "/r#7": {
          repoPath: "/r",
          prNumber: 7,
          headSha: "abc123", // same as pr().headSha → already reviewed
          patchId: "old",
          decision: "commented",
          reviewedPatchIds: [],
          updatedAt: 0,
        },
      },
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
});

test("skips a PR missing headSha/headRefName (logged)", async () => {
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () => makeForge(local.spies, { prs: [pr({ headSha: undefined })] });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(0);
  expect(local.spies.logs.some((l) => l.includes("missing headSha"))).toBe(true);
});

// ── 2. session-managed exclusion + criticEnabled coverage hole ───────────────

test("skips a session-managed branch when criticEnabled is ON", async () => {
  const { deps, spies } = makeDeps({}, { criticEnabled: true, managed: () => new Set(["feat/x"]) });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
});

test("REVIEWS a session-managed branch when criticEnabled is OFF (coverage hole)", async () => {
  const { deps, spies } = makeDeps(
    {},
    { criticEnabled: false, managed: () => new Set(["feat/x"]) },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(1);
});

test("does nothing for a repo whose criticAllPrs is OFF", async () => {
  const { deps, spies } = makeDeps({}, { criticAllPrs: false });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
});

// ── 2b. epic landing PR coverage (Stage B, #635) ─────────────────────────────

test("reviews the epic landing PR even with criticAllPrs OFF everywhere", async () => {
  // criticAllPrs off, but an epic_completed row with a landing PR number unions /r into the swept
  // set. The open green regular PR's head is the epic integration branch → eligible.
  const local = makeDeps(
    {},
    {
      criticAllPrs: false,
      epicCompleted: [{ repoPath: "/r", landingPrNumber: 42, landingState: "open" }],
      forge: undefined,
    },
  );
  local.deps.resolveForge = () =>
    makeForge(local.spies, {
      prs: [pr({ number: 42, headRefName: "epic/327-foo" })],
    });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(1);
  expect(local.spies.started[0]!.name).toBe("pr-critic /r#42");
});

test("with criticAllPrs OFF, a non-epic PR in the (epic-unioned) repo is NOT reviewed", async () => {
  // /r is swept ONLY because of its landing PR; a normal green regular PR whose head is a plain
  // task branch must stay excluded (eligible carves the OFF repo down to the integration branch).
  const local = makeDeps(
    {},
    {
      criticAllPrs: false,
      epicCompleted: [{ repoPath: "/r", landingPrNumber: 42, landingState: "open" }],
      forge: undefined,
    },
  );
  local.deps.resolveForge = () =>
    makeForge(local.spies, {
      prs: [
        pr({ number: 42, headRefName: "epic/327-foo" }), // the landing PR — eligible
        pr({ number: 8, headRefName: "feature/x" }), // a normal PR — excluded
      ],
    });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(1);
  expect(local.spies.started[0]!.name).toBe("pr-critic /r#42");
});

test("empty union (no criticAllPrs, no pending landing PR) → no forge call, no spawn", async () => {
  // Neither flagged nor epic-unioned: sweep() must early-return before resolving/listing the forge.
  let listed = 0;
  const local = makeDeps(
    {},
    {
      criticAllPrs: false,
      // no open landing PR → not in union
      epicCompleted: [{ repoPath: "/r", landingPrNumber: null, landingState: "none" }],
      forge: undefined,
    },
  );
  local.deps.resolveForge = () => {
    const f = makeForge(local.spies, {});
    f.listPullRequests = async () => {
      listed++;
      return [];
    };
    return f;
  };
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(listed).toBe(0);
  expect(local.spies.started).toHaveLength(0);
});

test("a merged epic landing PR is NOT swept (no longer reviewable)", async () => {
  // The landing PR has merged → landingState "merged"; even though landingPrNumber is still set,
  // the union keys off "open" only, so the repo is no longer swept (no list, no spawn).
  let listed = 0;
  const local = makeDeps(
    {},
    {
      criticAllPrs: false,
      epicCompleted: [{ repoPath: "/r", landingPrNumber: 42, landingState: "merged" }],
      forge: undefined,
    },
  );
  local.deps.resolveForge = () => {
    const f = makeForge(local.spies, { prs: [pr({ number: 42, headRefName: "epic/327-foo" })] });
    f.listPullRequests = async () => {
      listed++;
      return [pr({ number: 42, headRefName: "epic/327-foo" })];
    };
    return f;
  };
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(listed).toBe(0);
  expect(local.spies.started).toHaveLength(0);
});

test("per-head dedup still holds for the epic landing PR across two sweeps", async () => {
  const local = makeDeps(
    {},
    {
      criticAllPrs: false,
      epicCompleted: [{ repoPath: "/r", landingPrNumber: 42, landingState: "open" }],
      forge: undefined,
    },
  );
  local.deps.resolveForge = () =>
    makeForge(local.spies, { prs: [pr({ number: 42, headRefName: "epic/327-foo" })] });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  await svc.sweep(); // still in flight (no tick) → the in-flight guard blocks a re-spawn
  expect(local.spies.started).toHaveLength(1);
  expect(local.spies.created).toHaveLength(1);
});

// ── 3. in-flight exclusion across sweeps ─────────────────────────────────────

test("does not double-spawn an in-flight PR across two sweeps", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.sweep(); // no tick() between → still in flight
  expect(spies.started).toHaveLength(1);
  expect(spies.created).toHaveLength(1);
});

// ── 4. patch-id skip ─────────────────────────────────────────────────────────

test("patch-id match: no spawn, head bumped, worktree reaped, skip logged", async () => {
  const { deps, spies } = makeDeps(
    {
      computePatchId: async () => ({ patchId: "p1", baseSha: null, files: [] }),
    },
    {
      priorReviews: {
        "/r#7": {
          repoPath: "/r",
          prNumber: 7,
          headSha: "OLDHEAD", // different head → passes the head-dedup, reaches patch-id skip
          patchId: "p1", // same patch-id → pure rebase, skip
          decision: "commented",
          reviewedPatchIds: [],
          updatedAt: 0,
        },
      },
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(spies.started).toHaveLength(0);
  expect(spies.bumped).toEqual([{ repoPath: "/r", prNumber: 7, headSha: "abc123" }]);
  expect(spies.removed).toEqual(["/review-wt"]);
  expect(spies.logs.some((l) => l.includes("unchanged diff"))).toBe(true);
});

// ── 5. concurrency cap ───────────────────────────────────────────────────────

test("concurrency=1: only one of two eligible PRs spawns, the other is deferred", async () => {
  const local = makeDeps({}, { concurrency: 1, forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, { prs: [pr({ number: 7 }), pr({ number: 8, headRefName: "feat/y" })] });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.started).toHaveLength(1);
  expect(local.spies.logs.some((l) => l.includes("deferred"))).toBe(true);
});

// ── 6. finalize publish ──────────────────────────────────────────────────────

test("open PR: finalize posts a COMMENT (never REQUEST_CHANGES) even on a request-changes verdict", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();
  expect(spies.posted).toHaveLength(1);
  expect(spies.posted[0]!.event).toBe("COMMENT");
  expect(spies.posted[0]!.body).toContain(CRITIC_REVIEW_MARKER);
  expect(spies.stopped).toEqual(["rt"]);
  expect(spies.removed).toEqual(["/review-wt"]);
  // dedup row persisted
  expect(spies.puts).toHaveLength(1);
  expect(spies.puts[0]!.decision).toBe("changes_requested");
});

test("merged PR with findings: post-merge comment, no review posted", async () => {
  let calls = 0;
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, {
      meta: async () => {
        // open at begin(), merged at finalize
        calls++;
        return calls === 1 ? OPEN_META : { ...OPEN_META, state: "merged" };
      },
    });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  await svc.tick();
  expect(local.spies.posted).toHaveLength(0); // no review on a merged PR
  expect(local.spies.comments).toHaveLength(1);
  expect(local.spies.comments[0]!.body).toContain("after this PR merged");
});

test("closed PR: silent (no review, no comment)", async () => {
  let calls = 0;
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, {
      meta: async () => {
        calls++;
        return calls === 1 ? OPEN_META : { ...OPEN_META, state: "closed" };
      },
    });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  await svc.tick();
  expect(local.spies.posted).toHaveLength(0);
  expect(local.spies.comments).toHaveLength(0);
  // dedup row still written
  expect(local.spies.puts).toHaveLength(1);
});

// ── 7. fork ──────────────────────────────────────────────────────────────────

test("cross-repository PR: createDetached is called with the pull ref", async () => {
  const local = makeDeps({}, { forge: undefined });
  local.deps.resolveForge = () =>
    makeForge(local.spies, { meta: async () => ({ ...OPEN_META, isCrossRepository: true }) });
  const svc = new StandalonePrCriticService(local.deps as any);
  await svc.sweep();
  expect(local.spies.created).toHaveLength(1);
  expect(local.spies.created[0]!.pullRef).toBe("refs/pull/7/head");
});

// ── 8. dedup persistence ─────────────────────────────────────────────────────

test("findings verdict appends the patch-id to reviewedPatchIds", async () => {
  const { deps, spies } = makeDeps({
    computePatchId: async () => ({ patchId: "pNEW", baseSha: null, files: [] }),
  });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();
  expect(spies.puts[0]!.reviewedPatchIds).toEqual(["pNEW"]);
});

test("clean verdict resets reviewedPatchIds to []", async () => {
  const { deps, spies } = makeDeps(
    {
      readVerdict: () => ({ decision: "comment", summary: "ok", body: "lgtm", findings: [] }),
      computePatchId: async () => ({ patchId: "pNEW", baseSha: null, files: [] }),
    },
    {
      priorReviews: {
        "/r#7": {
          repoPath: "/r",
          prNumber: 7,
          headSha: "OLDHEAD",
          patchId: "pOLD",
          decision: "changes_requested",
          reviewedPatchIds: ["pOLD"],
          updatedAt: 0,
        },
      },
    },
  );
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick();
  expect(spies.puts[0]!.reviewedPatchIds).toEqual([]);
  expect(spies.puts[0]!.decision).toBe("commented");
});

test("error verdict: persists decision=error; a new push with the same diff re-reviews (patch-id skip bypassed)", async () => {
  // Simulate a timed-out run: readVerdict returns null, timeout fires (timeoutMs=0, clock advances).
  let clock = 0;
  const { deps, spies } = makeDeps({
    readVerdict: () => null, // no verdict file ever written
    computePatchId: async () => ({ patchId: "p1", baseSha: null, files: [] }),
    timeoutMs: 0,
    now: () => ++clock,
  });
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  await svc.tick(); // clock advanced → timedOut=true; finalizes with raw=null → error
  // dedup row must carry decision:"error"
  expect(spies.puts).toHaveLength(1);
  expect(spies.puts[0]!.decision).toBe("error");
  // ...and NOTHING is posted: an error verdict (body:"") on an OPEN PR must not leave a
  // contentless review comment on a third-party PR. Mirrors ReviewService (posts nothing on error).
  expect(spies.posted).toHaveLength(0);
  // New push (different headSha, same diff patch-id). A non-error prior with patchId="p1" would
  // be skipped by shouldSkipForPatchId; an error prior is NEVER skipped by the patch-id gate.
  const newHead = pr({ headSha: "newpush123" });
  deps.resolveForge = () => makeForge(spies, { prs: [newHead] });
  await svc.sweep();
  expect(spies.started).toHaveLength(2); // re-reviewed despite same patch-id
});

// ── 9. round-robin fairness ──────────────────────────────────────────────────

test("two enabled repos: the round-robin offset rotates which repo is considered first", async () => {
  // Fairness is about ORDER of consideration, not who ultimately spawns (the cap can block the
  // later repo). Record the repo each sweep enumerates FIRST via the listPullRequests call order,
  // and assert it alternates /a, /b, /a, … so one busy repo can't perpetually preempt the other.
  const considered: string[] = [];
  const base = makeDeps({}, { repos: ["/a", "/b"], concurrency: 5, forge: undefined });
  base.deps.resolveForge = (r: string) => {
    const f = makeForge(spies0(), {});
    f.listPullRequests = async () => {
      considered.push(r);
      return []; // empty so nothing spawns and the cap never fills — isolates the ordering
    };
    return f;
  };
  const svc = new StandalonePrCriticService(base.deps as any);
  await svc.sweep(); // offset 0 → /a, /b
  await svc.sweep(); // offset 1 → /b, /a
  await svc.sweep(); // offset 0 → /a, /b
  expect(considered).toEqual(["/a", "/b", "/b", "/a", "/a", "/b"]);
});

// ── 10. api-key auth membrane (7th spawn path, mirrors review.test) ───────────

test("api-key mode (passthrough host): apiKeyHelper in argv + CLAUDE_CONFIG_DIR env", async () => {
  // detectBackend()→null on the test host → no membrane → passthrough env carries the mirror dir.
  await withAuth("api-key", "/helper.sh", async () => {
    const { deps, spies } = makeDeps({ detectBackend: () => null });
    const svc = new StandalonePrCriticService(deps as any);
    await svc.sweep();
    expect(spies.started).toHaveLength(1);
    const argv = spies.started[0]!.argv;
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!).apiKeyHelper).toBe("/helper.sh");
    expect(Object.keys(spies.started[0]!.env!)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });
});

test("api-key without a configured key fails closed (no spawn, worktree reaped)", async () => {
  await withAuth("api-key", null, async () => {
    const { deps, spies } = makeDeps();
    const svc = new StandalonePrCriticService(deps as any);
    await svc.sweep();
    expect(spies.started).toHaveLength(0);
    expect(spies.removed).toEqual(["/review-wt"]);
  });
});

test("bwrap backend present: critic spawn is wrapped + isolated, credential masked", async () => {
  await withAuth("api-key", "/helper.sh", async () => {
    const { deps, spies } = makeDeps({
      detectBackend: () => "bwrap",
      membraneEnv: () => ({
        claudeDir: "/fake/.claude",
        home: "/fake/home",
        nodeBinReal: "/fake/bin/node",
      }),
    });
    const svc = new StandalonePrCriticService(deps as any);
    await svc.sweep();
    expect(spies.started).toHaveLength(1);
    const argv = spies.started[0]!.argv;
    expect(argv[0]).toBe("bwrap");
    // membrane uses isolated:true → worktree + gitCommonDir binds, not the whole repo.
    expect(argv).toContain("/review-wt");
    expect(argv).toContain("/fake-git-common");
    expect(argv).not.toContain("/r"); // not the whole-repo bind
    // api-key maskCredentials: NO `.credentials.json` rw bind anywhere — the credential is masked.
    expect(argv.some((a) => a.includes(".credentials.json"))).toBe(false);
    // inner reviewer argv follows the "--" separator (not another bwrap).
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv[sep + 1]).not.toBe("bwrap");
    // membrane masks creds in place → no passthrough CLAUDE_CONFIG_DIR env.
    expect(spies.started[0]!.env).toBeUndefined();
  });
});

test("inflightWorktrees: empty before any sweep", () => {
  const { deps } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  expect(svc.inflightWorktrees()).toEqual([]);
});

test("inflightWorktrees: returns worktree path after sweep() spawns a critic run", async () => {
  const { deps } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(svc.inflightWorktrees()).toEqual(["/review-wt"]);
});

// ── regression: reapRun unbound-this (stop/remove must not throw) ────────────

test("stopAll: reaps in-flight run without throwing (regression: unbound this)", async () => {
  const { deps, spies } = makeDeps();
  const svc = new StandalonePrCriticService(deps as any);
  await svc.sweep();
  expect(svc.inflightWorktrees()).toEqual(["/review-wt"]);
  expect(() => svc.stopAll()).not.toThrow();
  expect(spies.stopped).toEqual(["rt"]);
  expect(spies.removed).toEqual(["/review-wt"]);
  expect(svc.inflightWorktrees()).toEqual([]);
});

// ── boot reapOrphans (issue #1136) ──────────────────────────────────────────

test("reapOrphans closes orphaned pr-critic tabs, sparing unrelated names", () => {
  const closed: string[] = [];
  const listed = [
    { name: "pr-critic /r#42", terminalId: "orphan1", tabId: "tabO", agentStatus: "done" },
    { name: "my-feature-branch", terminalId: "u1", tabId: "tabU", agentStatus: "running" },
    { name: "review TASK-09", terminalId: "rv1", tabId: "tabR", agentStatus: "done" },
  ];
  const { deps } = makeDeps({
    herdr: {
      start: async () => ({ terminalId: "rt" }),
      stop: async () => {},
      list: () => listed,
      closeTab: async (id: string) => closed.push(id),
    },
  });
  const svc = new StandalonePrCriticService(deps as any);
  svc.reapOrphans(); // no in-flight runs at boot → empty owned set
  expect(closed).toEqual(["tabO"]); // only the pr-critic orphan; unrelated + sibling reviewer spared
});

test("reapOrphans is a no-op when herdr is unavailable", () => {
  let closes = 0;
  const { deps } = makeDeps({
    herdr: {
      start: async () => ({ terminalId: "rt" }),
      stop: async () => {},
      list: () => {
        throw new Error("herdr unavailable");
      },
      closeTab: async () => {
        closes++;
      },
    },
  });
  const svc = new StandalonePrCriticService(deps as any);
  expect(() => svc.reapOrphans()).not.toThrow();
  expect(closes).toBe(0);
});
