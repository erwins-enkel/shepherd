import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { UpNextSnapshot, UpNextSection } from "../src/up-next-core";
import type { CreateSessionInput, Session } from "../src/types";

let tmpRoot: string;
let repoDir: string;
const oldUsageHoldEnabled = config.usageHoldEnabled;
const oldUsageHoldPct = config.usageHoldPct;
const oldDefaultModel = config.defaultModel;
const oldDefaultCodexModel = config.defaultCodexModel;
const oldDefaultAgentProvider = config.defaultAgentProvider;
const oldDefaultEffort = config.defaultEffort;

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
});
afterEach(() => {
  config.usageHoldEnabled = oldUsageHoldEnabled;
  config.usageHoldPct = oldUsageHoldPct;
  config.defaultModel = oldDefaultModel;
  config.defaultCodexModel = oldDefaultCodexModel;
  config.defaultAgentProvider = oldDefaultAgentProvider;
  config.defaultEffort = oldDefaultEffort;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SNAP: UpNextSnapshot = {
  generatedAt: 123,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [],
};

function harness(
  opts: {
    snapshot?: UpNextSnapshot | null;
    hiddenRepoPathsRaw?: () => Set<string>;
    create?: (input: CreateSessionInput) => Promise<Session>;
    defaultBranch?: () => Promise<string>;
    limits?: () => { session5h?: { pct: number }; week?: { pct: number } };
  } = {},
) {
  const store = new SessionStore(":memory:");
  const createCalls: Array<{
    at: number;
    repoPath: string;
    number: number | undefined;
    prompt: string;
    agentProvider: CreateSessionInput["agentProvider"];
    model: CreateSessionInput["model"];
    effort: CreateSessionInput["effort"];
  }> = [];
  const labelCalls: number[] = [];
  const recomputeCalls: Array<Array<{ repoPath: string; issueNumber: number }>> = [];
  let refreshCalls = 0;
  let n = 0;
  const deps: AppDeps = {
    store,
    service: {
      create:
        opts.create ??
        (async (input: CreateSessionInput) => {
          createCalls.push({
            at: ++n,
            repoPath: input.repoPath,
            number: input.issueRef?.number,
            prompt: input.prompt,
            agentProvider: input.agentProvider,
            model: input.model,
            effort: input.effort,
          });
          return { id: `s${n}` } as Session;
        }),
    } as unknown as AppDeps["service"],
    events: new EventHub(),
    usageLimits: { limits: opts.limits ?? (() => ({})) } as unknown as AppDeps["usageLimits"],
    resolveForge: () =>
      ({
        defaultBranch: opts.defaultBranch ?? (async () => "main"),
        addIssueLabel: async (num: number) => {
          labelCalls.push(num);
        },
      }) as unknown as ReturnType<NonNullable<AppDeps["resolveForge"]>>,
    upNext: {
      snapshot: () => opts.snapshot ?? null,
      refresh: async () => {
        refreshCalls++;
        return SNAP;
      },
      recomputeUntilCleared: async (started) => {
        recomputeCalls.push(started.map((s) => ({ ...s })));
      },
      hiddenRepoPathsRaw: opts.hiddenRepoPathsRaw ?? (() => new Set<string>()),
    },
  };
  return {
    app: makeApp(deps),
    store,
    createCalls,
    labelCalls,
    refreshCalls: () => refreshCalls,
    recomputeCalls,
  };
}

const startReq = (items: unknown, extra: Record<string, unknown> = {}) =>
  new Request("http://x/api/up-next/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, ...extra }),
  });

test("GET /api/up-next returns the cached snapshot and kicks a recompute", async () => {
  const { app, refreshCalls } = harness({ snapshot: SNAP });
  const res = await app.fetch(new Request("http://x/api/up-next"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAP);
  expect(refreshCalls()).toBe(1); // lens-open path kicks a recompute
});

test("GET /api/up-next?peek paints cached only (no recompute)", async () => {
  const { app, refreshCalls } = harness({ snapshot: SNAP });
  const res = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAP);
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

test("POST /api/up-next/start accepts Codex xhigh effort for argv-build clamping", async () => {
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
