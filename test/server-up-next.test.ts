import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { DISABLED_HEAVY_SLOT } from "../src/heavy-slot-snapshot";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { buildSnapshot, type UpNextSnapshot, type UpNextSection } from "../src/up-next-core";
import type { Issue, PrReviewMeta } from "../src/forge/types";
import type { UpNextPr } from "../src/up-next-prs";
import { WorktreeMissingBaseError } from "../src/worktree";
import { repositoryRoutePolicy } from "../src/token-repositories";
import { scopeAllows } from "../src/token-scopes";
import type { StandardCreateInput, Session } from "../src/types";

let tmpRoot: string;
let repoDir: string;
const oldUsageHoldEnabled = config.usageHoldEnabled;
const oldUsageHoldPct = config.usageHoldPct;
const oldDefaultModel = config.defaultModel;
const oldDefaultCodexModel = config.defaultCodexModel;
const oldDefaultAgentProvider = config.defaultAgentProvider;
const oldDefaultEffort = config.defaultEffort;
const oldDefaultClaudeEffort = config.defaultClaudeEffort;
const oldDefaultCodexEffort = config.defaultCodexEffort;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-upnext-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  config.usageHoldEnabled = oldUsageHoldEnabled;
  config.usageHoldPct = oldUsageHoldPct;
  config.defaultModel = oldDefaultModel;
  config.defaultCodexModel = oldDefaultCodexModel;
  config.defaultAgentProvider = oldDefaultAgentProvider;
  config.defaultEffort = oldDefaultEffort;
  config.defaultClaudeEffort = oldDefaultClaudeEffort;
  config.defaultCodexEffort = oldDefaultCodexEffort;
});
afterEach(() => {
  config.usageHoldEnabled = oldUsageHoldEnabled;
  config.usageHoldPct = oldUsageHoldPct;
  config.defaultModel = oldDefaultModel;
  config.defaultCodexModel = oldDefaultCodexModel;
  config.defaultAgentProvider = oldDefaultAgentProvider;
  config.defaultEffort = oldDefaultEffort;
  config.defaultClaudeEffort = oldDefaultClaudeEffort;
  config.defaultCodexEffort = oldDefaultCodexEffort;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SNAP: UpNextSnapshot = {
  generatedAt: 123,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [],
  filter: buildSnapshot([], 0).filter,
};

function harness(
  opts: {
    snapshot?: UpNextSnapshot | null;
    getIssue?: (number: number) => Promise<Issue | null>;
    noForge?: boolean;
    hiddenRepoPathsRaw?: () => Set<string>;
    create?: (input: StandardCreateInput) => Promise<Session>;
    defaultBranch?: () => Promise<string>;
    limits?: () => { session5h?: { pct: number }; week?: { pct: number } };
    /** #3245: forge slug per repo dir (target-repo routing). */
    slugOf?: (repoPath: string) => string | null;
    prReviewMeta?: (number: number) => Promise<PrReviewMeta | null>;
    heavySlot?: AppDeps["heavySlot"];
  } = {},
) {
  const store = new SessionStore(":memory:");
  const createCalls: Array<{
    at: number;
    repoPath: string;
    number: number | undefined;
    prompt: string;
    agentProvider: StandardCreateInput["agentProvider"];
    model: StandardCreateInput["model"];
    effort: StandardCreateInput["effort"];
    issueRepoPath?: string;
  }> = [];
  const labelCalls: number[] = [];
  const recomputeCalls: Array<Array<{ repoPath: string; issueNumber: number }>> = [];
  let refreshCalls = 0;
  let refilterCalls = 0;
  const staleRefreshCalls: number[] = [];
  let n = 0;
  const deps: AppDeps = {
    store,
    service: {
      create:
        opts.create ??
        (async (input: StandardCreateInput) => {
          createCalls.push({
            at: ++n,
            repoPath: input.repoPath,
            number: input.issueRef?.number,
            prompt: input.prompt,
            agentProvider: input.agentProvider,
            model: input.model,
            effort: input.effort,
            issueRepoPath: input.issueRepoPath,
          });
          return { id: `s${n}` } as Session;
        }),
    } as unknown as AppDeps["service"],
    events: new EventHub(),
    usageLimits: { limits: opts.limits ?? (() => ({})) } as unknown as AppDeps["usageLimits"],
    heavySlot: opts.heavySlot,
    resolveForge: (repoPath: string) =>
      opts.noForge
        ? null
        : ({
            getIssue: opts.getIssue,
            prReviewMeta: opts.prReviewMeta,
            slug: opts.slugOf?.(repoPath) ?? null,
            defaultBranch: opts.defaultBranch ?? (async () => "main"),
            addIssueLabel: async (num: number) => {
              labelCalls.push(num);
            },
          } as unknown as ReturnType<NonNullable<AppDeps["resolveForge"]>>),
    upNext: {
      snapshot: () => opts.snapshot ?? null,
      refresh: async () => {
        refreshCalls++;
        return SNAP;
      },
      refreshIfStale: (maxAgeMs) => {
        staleRefreshCalls.push(maxAgeMs);
      },
      recomputeUntilCleared: async (started) => {
        recomputeCalls.push(started.map((s) => ({ ...s })));
      },
      hiddenRepoPathsRaw: opts.hiddenRepoPathsRaw ?? (() => new Set<string>()),
      refilter: () => {
        refilterCalls++;
      },
    },
  };
  return {
    app: makeApp(deps),
    store,
    createCalls,
    labelCalls,
    refreshCalls: () => refreshCalls,
    refilterCalls: () => refilterCalls,
    staleRefreshCalls,
    recomputeCalls,
  };
}

const startReq = (items: unknown, extra: Record<string, unknown> = {}) =>
  new Request("http://x/api/up-next/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, ...extra }),
  });

test("GET /api/up-next returns the cached snapshot and kicks a 60s-gated recompute", async () => {
  const { app, refreshCalls, staleRefreshCalls } = harness({ snapshot: SNAP });
  const res = await app.fetch(new Request("http://x/api/up-next"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAP);
  expect(staleRefreshCalls).toEqual([60_000]); // lens-open reuses a <60s-old snapshot (#2658)
  expect(refreshCalls()).toBe(0);
});

test("GET /api/up-next?peek paints cached only (no recompute)", async () => {
  const { app, refreshCalls, staleRefreshCalls } = harness({ snapshot: SNAP });
  const res = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAP);
  expect(staleRefreshCalls).toEqual([]);
  expect(refreshCalls()).toBe(0); // app-load path costs zero cross-repo gh fan-out
});

test("POST /api/up-next/refresh returns 202", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/up-next/refresh", { method: "POST" }));
  expect(res.status).toBe(202);
});

test("POST /api/up-next/start spawns one session and stamps the claim", async () => {
  const { app, createCalls, labelCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }]),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { created: unknown[]; errors: unknown[] };
  expect(body.created).toHaveLength(1);
  expect(body.errors).toHaveLength(0);
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0]!.number).toBe(7);
  // An ordinary title spawns on the bare title, byte-identical — the namer derives branch and
  // worktree names from it, so the common case must not change.
  expect(createCalls[0]!.prompt).toBe("t");
  // claim is stamped asynchronously, so it should have recorded #7.
  await new Promise((r) => setTimeout(r, 5));
  expect(labelCalls).toContain(7);
});

test("POST /api/up-next/start templates a slash-leading title so the CLI can't parse it as a command", async () => {
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([
      { repoPath: repoDir, issueRef: { number: 7, url: "u", title: "/foo bar", body: "b" } },
    ]),
  );
  expect(res.status).toBe(201);
  expect(createCalls).toHaveLength(1);
  // The prompt is delivered as a positional argv; a leading "/" there is parsed as a slash
  // command ("Unknown command: /foo bar") and the session dies before it starts.
  expect(createCalls[0]!.prompt).toBe("Work on issue #7: /foo bar");
  expect(createCalls[0]!.prompt.startsWith("/")).toBe(false);
});

test("POST /api/up-next/start forwards selected provider, model and effort to create", async () => {
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    }),
  );
  expect(res.status).toBe(201);
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0]!.agentProvider).toBe("codex");
  expect(createCalls[0]!.model).toBe("gpt-5.5");
  expect(createCalls[0]!.effort).toBe("high");
});

test("POST /api/up-next/start treats selected provider default model as null", async () => {
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
      agentProvider: "codex",
      model: "default",
      effort: "default",
    }),
  );
  expect(res.status).toBe(201);
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0]!.agentProvider).toBe("codex");
  expect(createCalls[0]!.model).toBeNull();
  expect(createCalls[0]!.effort).toBeNull();
});

test("POST /api/up-next/start preserves default model and effort for provider-only choice", async () => {
  config.defaultModel = "sonnet";
  config.defaultEffort = "high";
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
      agentProvider: "claude",
    }),
  );
  expect(res.status).toBe(201);
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0]!.agentProvider).toBe("claude");
  expect(createCalls[0]!.model).toBe("sonnet");
  expect(createCalls[0]!.effort).toBe("high");
});

test("POST /api/up-next/start uses each engine's own default effort for a provider-only choice", async () => {
  config.defaultEffort = "high";
  config.defaultClaudeEffort = "inherit";
  config.defaultCodexEffort = "xhigh";
  const { app, createCalls } = harness();
  for (const agentProvider of ["codex", "claude"] as const) {
    const res = await app.fetch(
      startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
        agentProvider,
      }),
    );
    expect(res.status).toBe(201);
  }
  expect(createCalls.map((c) => [c.agentProvider, c.effort])).toEqual([
    ["codex", "xhigh"],
    ["claude", "high"],
  ]);
});

test("POST /api/up-next/start uses the saved Codex model for a provider-only choice", async () => {
  config.defaultModel = "sonnet";
  config.defaultCodexModel = "gpt-5.4";
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
      agentProvider: "codex",
    }),
  );
  expect(res.status).toBe(201);
  expect(createCalls[0]!.agentProvider).toBe("codex");
  expect(createCalls[0]!.model).toBe("gpt-5.4");
});

test("POST /api/up-next/start uses the saved model for the global default provider", async () => {
  config.defaultAgentProvider = "codex";
  config.defaultModel = "sonnet";
  config.defaultCodexModel = "default";
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }]),
  );
  expect(res.status).toBe(201);
  expect(createCalls[0]!.agentProvider).toBeUndefined();
  expect(createCalls[0]!.model).toBeNull();
});

test("POST /api/up-next/start rejects invalid provider/model/effort choices", async () => {
  const { app, createCalls } = harness();
  const item = { repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } };
  expect((await app.fetch(startReq([item], { agentProvider: "bad" }))).status).toBe(400);
  expect(
    (await app.fetch(startReq([item], { agentProvider: "codex", model: "opus" }))).status,
  ).toBe(400);
  expect(
    (await app.fetch(startReq([item], { agentProvider: "codex", effort: "turbo" }))).status,
  ).toBe(400);
  expect(createCalls).toHaveLength(0);
});

test("POST /api/up-next/start accepts Codex xhigh effort for argv pass-through", async () => {
  const { app, createCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    }),
  );
  expect(res.status).toBe(201);
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0]!.effort).toBe("xhigh");
});

test("POST /api/up-next/start holds capped Claude without spawning and clears the lens", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;
  const { app, createCalls, labelCalls, recomputeCalls } = harness({
    limits: () => ({ session5h: { pct: 90 }, week: { pct: 10 } }),
  });
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }], {
      agentProvider: "claude",
      model: "default",
      effort: "default",
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { created: unknown[]; held: unknown[]; errors: unknown[] };
  expect(body.created).toHaveLength(0);
  expect(body.held).toHaveLength(1);
  expect(body.errors).toHaveLength(0);
  expect(createCalls).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 20));
  expect(labelCalls).toContain(7);
  expect(recomputeCalls).toEqual([[{ repoPath: repoDir, issueNumber: 7 }]]);
});

test("POST /api/up-next/start reuses an existing held task for the same issue", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;
  const { app, store, createCalls } = harness({
    limits: () => ({ session5h: { pct: 90 }, week: { pct: 10 } }),
  });
  const item = { repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } };
  const first = await app.fetch(startReq([item], { agentProvider: "claude" }));
  const second = await app.fetch(startReq([item], { agentProvider: "claude" }));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const firstBody = (await first.json()) as { held: { id: string }[] };
  const secondBody = (await second.json()) as { held: { id: string; reused?: boolean }[] };
  expect(secondBody.held[0]!.id).toBe(firstBody.held[0]!.id);
  expect(secondBody.held[0]!.reused).toBe(true);
  expect(store.listHeldTasks()).toHaveLength(1);
  expect(createCalls).toHaveLength(0);
});

test("POST /api/up-next/start holds under memory pressure; a reheld issue withdraws its waiter", async () => {
  const asked: string[] = [];
  const forgot: string[] = [];
  const heavySlot = {
    snapshot: () => DISABLED_HEAVY_SLOT,
    release: () => false,
    admitStart: async (e: { key: string }) => {
      asked.push(e.key);
      return false; // the brake holds
    },
    forgetStart: (key: string) => void forgot.push(key),
  };
  const { app, store, createCalls } = harness({ heavySlot });
  const item = { repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } };
  const first = await app.fetch(startReq([item], { agentProvider: "claude" }));
  expect(first.status).toBe(200);
  const body = (await first.json()) as { held: { id: string; reason: string }[] };
  expect(body.held).toMatchObject([{ reason: "memory" }]);
  expect(asked).toEqual([`task:${body.held[0]!.id}`]);
  expect(store.getHeldTask(body.held[0]!.id)?.reason).toBe("memory");
  expect(createCalls).toHaveLength(0);

  const second = await app.fetch(startReq([item], { agentProvider: "claude" }));
  const again = (await second.json()) as { held: { id: string; reused?: boolean }[] };
  expect(again.held[0]).toMatchObject({ id: body.held[0]!.id, reused: true, reason: "memory" });
  expect(forgot).toEqual([asked[1]!]);
});

test("POST /api/up-next/start recomputes the lens via recomputeUntilCleared (not an immediate refresh)", async () => {
  const { app, refreshCalls, recomputeCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }]),
  );
  expect(res.status).toBe(201);
  // The recompute is backgrounded behind the claim-settle race — let it run.
  await new Promise((r) => setTimeout(r, 20));
  expect(refreshCalls()).toBe(0); // no stale immediate refresh
  expect(recomputeCalls).toHaveLength(1);
  expect(recomputeCalls[0]).toEqual([{ repoPath: repoDir, issueNumber: 7 }]);
});

test("POST /api/up-next/start serializes multiple spawns (no overlap)", async () => {
  let active = 0;
  let maxActive = 0;
  const { app, createCalls } = harness({
    create: async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { id: `s${input.issueRef?.number}` } as Session;
    },
  });
  const items = [1, 2, 3].map((num) => ({
    repoPath: repoDir,
    issueRef: { number: num, url: "u", title: `t${num}`, body: "" },
  }));
  const res = await app.fetch(startReq(items));
  expect(res.status).toBe(201);
  void createCalls; // create is overridden in this case; serialization is asserted via maxActive
  expect(maxActive).toBe(1);
});

test("POST /api/up-next/start rejects an empty / malformed body", async () => {
  const { app } = harness();
  expect((await app.fetch(startReq([]))).status).toBe(400);
  const bad = await app.fetch(startReq([{ repoPath: repoDir, issueRef: { number: "x" } }]));
  expect(bad.status).toBe(400);
});

test("GET /api/up-next?peek strips hidden-repo sections via hiddenRepoPathsRaw", async () => {
  const hiddenPath = "/r/hidden";
  const visiblePath = "/r/visible";
  const hiddenSection: UpNextSection = {
    kind: "repo",
    repoPath: hiddenPath,
    repoSlug: "hidden",
    repoLabel: "hidden",
    items: [],
    totalCount: 0,
  };
  const visibleSection: UpNextSection = {
    kind: "repo",
    repoPath: visiblePath,
    repoSlug: "visible",
    repoLabel: "visible",
    items: [],
    totalCount: 0,
  };
  const snap: UpNextSnapshot = {
    generatedAt: 999,
    repoCount: 2,
    fallback: null,
    failedRepoCount: 0,
    sections: [hiddenSection, visibleSection],
    filter: buildSnapshot([], 0).filter,
  };
  const { app } = harness({
    snapshot: snap,
    hiddenRepoPathsRaw: () => new Set([hiddenPath]),
  });
  const res = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as UpNextSnapshot;
  const repoPaths = body.sections.map((s) => s.repoPath);
  expect(repoPaths).not.toContain(hiddenPath);
  expect(repoPaths).toContain(visiblePath);
});

test("#3245: a bodyless issue naming another registered Target repo starts there; claim stays home", async () => {
  const bDir = mkdtempSync(join(config.repoRoot, "shepherd-upnext-target-"));
  try {
    const { app, createCalls, labelCalls } = harness({
      slugOf: (p) => (p.includes("shepherd-upnext-target-") ? "org/B" : "org/A"),
      getIssue: async (n) => loadedIssue(n, "Target repo: org/B"),
    });
    const res = await app.fetch(
      startReq([
        {
          repoPath: repoDir,
          issueRef: { number: 7, url: "u", title: "t" },
        },
      ]),
    );
    expect(res.status).toBe(201);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.repoPath).toContain("shepherd-upnext-target-");
    expect(createCalls[0]!.issueRepoPath).toBe(repoDir);
    await new Promise((r) => setTimeout(r, 5));
    expect(labelCalls).toContain(7);
  } finally {
    rmSync(bDir, { recursive: true, force: true });
  }
});

test("#3245: an unregistered Target repo is refused per item, nothing spawned", async () => {
  const { app, createCalls, labelCalls } = harness({ slugOf: () => "org/A" });
  const res = await app.fetch(
    startReq([
      {
        repoPath: repoDir,
        issueRef: { number: 7, url: "u", title: "t", body: "Target repo: org/Nope" },
      },
    ]),
  );
  expect(res.status).toBe(502);
  const body = (await res.json()) as { errors: { number: number; error: string }[] };
  expect(body.errors).toEqual([{ number: 7, error: "target repo not registered" }]);
  expect(createCalls).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 5));
  expect(labelCalls).toHaveLength(0);
});

test("Up Next conditional reads preserve null, filtering and recompute semantics", async () => {
  for (const snapshot of [undefined, SNAP]) {
    const { app, staleRefreshCalls } = harness({ snapshot });
    const first = await app.fetch(new Request("http://x/api/up-next?peek=1"));
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    for (const validator of [etag!, etag!.slice(2), `"other", ${etag}`, "*"]) {
      const res = await app.fetch(
        new Request("http://x/api/up-next", {
          headers: { "If-None-Match": validator },
        }),
      );
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
    }
    expect(staleRefreshCalls).toHaveLength(4);
    const different = await app.fetch(
      new Request("http://x/api/up-next?peek=1", {
        headers: { "If-None-Match": '"other"' },
      }),
    );
    expect(different.status).toBe(200);
    expect(await different.json()).toEqual(snapshot ?? null);
  }
});

test("Up Next ETag changes when the read-time hidden filter changes", async () => {
  const hidden = new Set<string>();
  const snapshot = {
    ...SNAP,
    sections: [
      {
        kind: "repo" as const,
        repoPath: "/r",
        repoSlug: null,
        repoLabel: "r",
        items: [],
        totalCount: 0,
      },
    ],
  };
  const { app } = harness({ snapshot, hiddenRepoPathsRaw: () => hidden });
  const first = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  hidden.add("/r");
  const second = await app.fetch(
    new Request("http://x/api/up-next?peek=1", {
      headers: { "If-None-Match": first.headers.get("etag")! },
    }),
  );
  expect(second.status).toBe(200);
  expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
  expect(await second.json()).toMatchObject({ sections: [] });
});

test("Up Next conditional read changes validator when content changes at the same timestamp", async () => {
  const snapshot = { ...SNAP };
  const { app } = harness({ snapshot });
  const first = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  snapshot.failedRepoCount = 1;
  const next = await app.fetch(
    new Request("http://x/api/up-next?peek=1", {
      headers: { "If-None-Match": first.headers.get("etag")! },
    }),
  );
  expect(next.status).toBe(200);
  expect(next.headers.get("etag")).not.toBe(first.headers.get("etag"));
  expect(await next.json()).toEqual(snapshot);
});

const fullBody = "## Complete issue\n\n" + "ü😀 private text\n".repeat(400);
const loadedIssue = (number: number, body = fullBody): Issue => ({
  number,
  body,
  title: `Issue ${number}`,
  url: `https://example.test/${number}`,
  labels: [],
  assignees: [],
  createdAt: 1,
});
const bodyReq = (repo = repoDir, number = "7") =>
  new Request(`http://x/api/up-next/body?repo=${encodeURIComponent(repo)}&number=${number}`);

test("up-next body returns untruncated Unicode text without refreshing the list", async () => {
  const h = harness({ getIssue: async (number) => loadedIssue(number) });
  const res = await h.app.fetch(bodyReq());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ body: fullBody });
  expect(h.refreshCalls()).toBe(0);
  expect(h.staleRefreshCalls).toEqual([]);
});

test("up-next body returns the issue author when the forge provides one", async () => {
  const h = harness({ getIssue: async (n) => ({ ...loadedIssue(n), author: "bob" }) });
  expect(await (await h.app.fetch(bodyReq())).json()).toEqual({ body: fullBody, author: "bob" });
});

test("up-next body handles empty text, invalid parameters and unavailable issues", async () => {
  const empty = harness({ getIssue: async (n) => loadedIssue(n, "") });
  expect(await (await empty.app.fetch(bodyReq())).json()).toEqual({ body: "" });
  for (const number of ["", "0", "-1", "NaN", "1.5", "1000000000"]) {
    expect((await empty.app.fetch(bodyReq(repoDir, number))).status).toBe(400);
  }
  expect((await empty.app.fetch(bodyReq("/outside/root"))).status).toBe(400);
  expect((await harness({ noForge: true }).app.fetch(bodyReq())).status).toBe(503);
  expect((await harness().app.fetch(bodyReq())).status).toBe(503);
  expect((await harness({ getIssue: async () => null }).app.fetch(bodyReq())).status).toBe(404);
  expect(
    (
      await harness({
        getIssue: async () => {
          throw new Error("transport failed");
        },
      }).app.fetch(bodyReq())
    ).status,
  ).toBe(502);
});

test("up-next body preserves full-only scope and repository default deny", () => {
  for (const scope of ["read", "submit", "full"] as const) {
    expect(scopeAllows(scope, "GET", "/api/up-next/body")).toBe(scope === "full");
  }
  expect(repositoryRoutePolicy("GET", new URL(bodyReq().url))).toBeNull();
});

test("bodyless up-next starts and holds hydrate full context before creating", async () => {
  for (const hold of [false, true]) {
    config.usageHoldEnabled = hold;
    const inputs: StandardCreateInput[] = [];
    const h = harness({
      limits: () => ({ session5h: { pct: 100 } }),
      getIssue: async (n) => loadedIssue(n),
      create: async (input) => {
        inputs.push(input);
        return { id: "s1" } as Session;
      },
    });
    const res = await h.app.fetch(
      startReq([
        {
          repoPath: repoDir,
          issueRef: { number: 7, url: "https://example.test/7", title: "Issue 7" },
        },
      ]),
    );
    expect(res.status).toBe(hold ? 200 : 201);
    const input = hold ? h.store.listHeldTasks()[0]!.input : inputs[0]!;
    expect(input.issueRef?.body).toBe(fullBody);
  }
});

test("bodyless batch start reports failed reads and continues without creating or claiming them", async () => {
  const h = harness({ getIssue: async (n) => (n === 7 ? null : loadedIssue(n)) });
  const refs = [7, 8].map((number) => ({
    repoPath: repoDir,
    issueRef: { number, url: `https://example.test/${number}`, title: `Issue ${number}` },
  }));
  const res = await h.app.fetch(startReq(refs));
  const result = await res.json();
  expect(result.errors).toEqual([{ number: 7, error: expect.any(String) }]);
  expect(result.created).toHaveLength(1);
  expect(h.createCalls.map((c) => c.number)).toEqual([8]);
  expect(h.labelCalls).toEqual([8]);
  expect(h.store.listHeldTasks()).toEqual([]);
});

test("up-next start preserves an explicitly supplied empty body without a forge read", async () => {
  const inputs: StandardCreateInput[] = [];
  let reads = 0;
  const h = harness({
    getIssue: async () => {
      reads++;
      throw new Error("must not read");
    },
    create: async (input) => {
      inputs.push(input);
      return { id: "s1" } as Session;
    },
  });
  const res = await h.app.fetch(
    startReq([
      {
        repoPath: repoDir,
        issueRef: { number: 7, url: "https://example.test/7", title: "Issue 7", body: "" },
      },
    ]),
  );
  expect(res.status).toBe(201);
  expect(inputs[0]?.issueRef?.body).toBe("");
  expect(reads).toBe(0);
});

// ── PRs in Up Next: fix sessions and PR bodies ──────────────────────────────

function waitingPr(over: Partial<UpNextPr> = {}): UpNextPr {
  return {
    repoPath: repoDir,
    repoSlug: "o/r",
    repoLabel: "r",
    number: 42,
    title: "Add the thing",
    url: "https://x/pull/42",
    author: "me",
    kind: "regular",
    createdAt: 1,
    checks: "success",
    mergeable: false,
    mergeStateStatus: "dirty",
    baseRefName: "main",
    band: "blocked",
    action: "fix",
    blockReason: "conflict",
    headRefName: "feat/thing",
    jobs: [],
    ...over,
  };
}
const prSnap = (...prs: UpNextPr[]): UpNextSnapshot => ({ ...SNAP, pullRequests: prs });
const fixReq = (body: unknown) =>
  new Request("http://x/api/up-next/pr-fix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("POST /api/up-next/pr-fix starts a push-only repair session on the PR's head branch", async () => {
  const inputs: StandardCreateInput[] = [];
  const h = harness({
    snapshot: prSnap(waitingPr()),
    create: async (input) => {
      inputs.push(input);
      return { id: "fix1" } as Session;
    },
  });
  const res = await h.app.fetch(fixReq({ repo: repoDir, number: 42, steer: "Keep it small." }));
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ session: { id: "fix1" } });
  expect(inputs).toHaveLength(1);
  const input = inputs[0]!;
  expect(input.baseBranch).toBe("feat/thing");
  expect(input.landingRepair).toBe(true);
  expect(input.auto).toBe(false);
  expect(input.issueRef).toBeUndefined();
  expect(input.prompt.startsWith("Operator instruction:\nKeep it small.")).toBe(true);
  expect(input.prompt).toContain("git push --force-with-lease origin HEAD:feat/thing");
  expect(h.refilterCalls()).toBe(1);
});

test("POST /api/up-next/pr-fix refuses what is not a fixable waiting PR", async () => {
  const h = harness({ snapshot: prSnap(waitingPr(), waitingPr({ number: 43, action: "merge" })) });
  for (const body of [{}, { repo: repoDir }, { repo: repoDir, number: 0 }, { number: 42 }]) {
    expect((await h.app.fetch(fixReq(body))).status).toBe(400);
  }
  expect((await h.app.fetch(fixReq({ repo: "/outside", number: 42 }))).status).toBe(400);
  expect((await h.app.fetch(fixReq({ repo: repoDir, number: 42, steer: 7 }))).status).toBe(400);
  expect((await h.app.fetch(fixReq({ repo: repoDir, number: 43 }))).status).toBe(404);
  expect((await h.app.fetch(fixReq({ repo: repoDir, number: 44 }))).status).toBe(404);
  expect((await harness().app.fetch(fixReq({ repo: repoDir, number: 42 }))).status).toBe(404);
});

test("POST /api/up-next/pr-fix refuses a PR a live session already works on", async () => {
  const h = harness({ snapshot: prSnap(waitingPr()) });
  h.store.create({
    name: "fix",
    prompt: "p",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "feat/thing",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "s",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
  });
  const res = await h.app.fetch(fixReq({ repo: repoDir, number: 42 }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("pr_in_flight");
});

test("POST /api/up-next/pr-fix names a head branch the repo does not have", async () => {
  const h = harness({
    snapshot: prSnap(waitingPr()),
    create: async () => {
      throw new WorktreeMissingBaseError("feat/thing");
    },
  });
  const res = await h.app.fetch(fixReq({ repo: repoDir, number: 42 }));
  expect(res.status).toBe(422);
  expect(((await res.json()) as { code: string }).code).toBe("head_not_in_repo");
  const failing = harness({
    snapshot: prSnap(waitingPr()),
    create: async () => {
      throw new Error("spawn failed");
    },
  });
  expect((await failing.app.fetch(fixReq({ repo: repoDir, number: 42 }))).status).toBe(502);
  expect(failing.refilterCalls()).toBe(0);
});

test("POST /api/up-next/pr-fix is full-scope only and repository default-deny", () => {
  for (const scope of ["read", "submit", "full"] as const) {
    expect(scopeAllows(scope, "POST", "/api/up-next/pr-fix")).toBe(scope === "full");
  }
  expect(repositoryRoutePolicy("POST", new URL("http://x/api/up-next/pr-fix"))).toBeNull();
});

const prBodyReq = (repo = repoDir, number = "42") =>
  new Request(
    `http://x/api/up-next/pr-body?repo=${encodeURIComponent(repo)}&number=${encodeURIComponent(number)}`,
  );
const prMeta = (body: string): PrReviewMeta => ({
  body,
  baseRefName: "main",
  isCrossRepository: false,
  state: "open",
});

test("GET /api/up-next/pr-body returns the PR description and its failure statuses", async () => {
  const ok = harness({ prReviewMeta: async () => prMeta("## Summary\n- one") });
  const res = await ok.app.fetch(prBodyReq());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ body: "## Summary\n- one" });
  expect(ok.refreshCalls()).toBe(0);
  for (const number of ["", "0", "1.5", "1000000000"]) {
    expect((await ok.app.fetch(prBodyReq(repoDir, number))).status).toBe(400);
  }
  expect((await ok.app.fetch(prBodyReq("/outside/root"))).status).toBe(400);
  expect((await harness({ noForge: true }).app.fetch(prBodyReq())).status).toBe(503);
  expect((await harness().app.fetch(prBodyReq())).status).toBe(503);
  expect((await harness({ prReviewMeta: async () => null }).app.fetch(prBodyReq())).status).toBe(
    404,
  );
  const throwing = harness({
    prReviewMeta: async () => {
      throw new Error("transport failed");
    },
  });
  expect((await throwing.app.fetch(prBodyReq())).status).toBe(502);
  expect(scopeAllows("read", "GET", "/api/up-next/pr-body")).toBe(false);
});
