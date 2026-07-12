import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { ReviewVerdict } from "../src/types";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-reviews-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(reviewCache?: AppDeps["reviewCache"]): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    reviewCache,
  };
  return { app: makeApp(deps), store };
}

// ── GET /api/reviews ──────────────────────────────────────────────────────────

test("GET /api/reviews returns snapshot when reviewCache is present", async () => {
  const verdict: ReviewVerdict = {
    sessionId: "sess-1",
    headSha: "abc123",
    patchId: "pid-abc123",
    decision: "commented",
    summary: "Looks good",
    body: "Full body here",
    findings: [],
    addressRound: 0,
    addressCap: 3,
    streakReviews: 0,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: [],
    updatedAt: 1000,
  };
  const { app } = harness({ snapshot: () => ({ "sess-1": verdict }) });
  const res = await app.fetch(new Request("http://x/api/reviews"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ "sess-1": verdict });
});

test("GET /api/reviews returns {} when reviewCache is absent", async () => {
  const { app } = harness(undefined);
  const res = await app.fetch(new Request("http://x/api/reviews"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("GET /api/reviews/inflight returns in-flight session ids", async () => {
  const { app } = harness({ snapshot: () => ({}), reviewing: () => ["sess-1", "sess-2"] });
  const res = await app.fetch(new Request("http://x/api/reviews/inflight"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(["sess-1", "sess-2"]);
});

test("GET /api/reviews/inflight returns [] when reviewCache is absent", async () => {
  const { app } = harness(undefined);
  const res = await app.fetch(new Request("http://x/api/reviews/inflight"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

// ── GET /api/repo-config ──────────────────────────────────────────────────────

test("GET /api/repo-config defaults to critic on + auto-address off", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: false,
    automationRowExists: false,
  });
});

test("GET /api/repo-config with empty repo param → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/repo-config"));
  expect(res.status).toBe(400);
});

test("GET /api/repo-config with repo outside root → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent("/etc")}`),
  );
  expect(res.status).toBe(400);
});

// ── PUT /api/repo-config ──────────────────────────────────────────────────────

test("PUT /api/repo-config sets criticEnabled=false, GET reflects it", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;

  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: false }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({
    criticEnabled: false,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: false,
    automationRowExists: true,
  });

  const get = await app.fetch(new Request(url));
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({
    criticEnabled: false,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: false,
    automationRowExists: true,
  });
});

test("PUT /api/repo-config toggles autoAddressEnabled independently of criticEnabled", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoAddressEnabled: true }), // critic left untouched
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: true,
    learningsEnabled: true,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: false,
    automationRowExists: true,
  });
});

test("PUT /api/repo-config sets learningsEnabled independently of criticEnabled", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learningsEnabled: false }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    egressExtraHosts: [],
    repoMode: "forge",
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: false,
    automationRowExists: true,
  });
});

test("PUT /api/repo-config with empty body (no recognized fields) → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config with non-boolean body → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: "yes" }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config with null body → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config with repo outside root → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent("/etc")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: false }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config rejects non-canonical previewStartScript", async () => {
  const { app, store } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewStartScript: "/tmp/run-anything.sh" }),
    }),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("previewStartScript");
  expect(store.getRepoConfig(repoDir).previewStartScript).toBeNull();
});

// ── repoMode ──────────────────────────────────────────────────────────────────

test("PUT /api/repo-config repoMode=lightweight persists, GET returns lightweight", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoMode: "lightweight" }),
    }),
  );
  expect(put.status).toBe(200);
  expect(((await put.json()) as { repoMode: string }).repoMode).toBe("lightweight");

  const get = await app.fetch(new Request(url));
  expect(get.status).toBe(200);
  expect(((await get.json()) as { repoMode: string }).repoMode).toBe("lightweight");
});

test("PUT /api/repo-config repoMode=bogus → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoMode: "bogus" }),
    }),
  );
  expect(res.status).toBe(400);
});

// ── previewOpenMode ──────────────────────────────────────────────────────────

test("PUT /api/repo-config previewOpenMode=tab persists, GET returns tab", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewOpenMode: "tab" }),
    }),
  );
  expect(put.status).toBe(200);
  expect(((await put.json()) as { previewOpenMode: string }).previewOpenMode).toBe("tab");

  const get = await app.fetch(new Request(url));
  expect(get.status).toBe(200);
  expect(((await get.json()) as { previewOpenMode: string }).previewOpenMode).toBe("tab");
});

test("PUT /api/repo-config previewOpenMode=bogus → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewOpenMode: "bogus" }),
    }),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("previewOpenMode");
});
