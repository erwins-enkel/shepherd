import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { validateEpicRunPatch } from "../src/validate";
import type { Epic, EpicChild, EpicRun } from "../src/epic-core";
import type { EpicDiagnosis } from "../src/epic-diagnosis";

// ── validateEpicRunPatch unit tests ──────────────────────────────────────────

describe("validateEpicRunPatch", () => {
  test("empty object passes (no required fields)", () => {
    expect(validateEpicRunPatch({})).toEqual({});
  });

  test("valid {status:'running'} passes", () => {
    expect(validateEpicRunPatch({ status: "running" })).toEqual({ status: "running" });
  });

  test("valid {status:'idle'} passes", () => {
    expect(validateEpicRunPatch({ status: "idle" })).toEqual({ status: "idle" });
  });

  test("valid {status:'paused'} passes", () => {
    expect(validateEpicRunPatch({ status: "paused" })).toEqual({ status: "paused" });
  });

  test("valid {mode:'attended'} passes", () => {
    expect(validateEpicRunPatch({ mode: "attended" })).toEqual({ mode: "attended" });
  });

  test("valid {mode:'auto'} passes", () => {
    expect(validateEpicRunPatch({ mode: "auto" })).toEqual({ mode: "auto" });
  });

  test("valid combo {mode:'attended', status:'running'} passes", () => {
    expect(validateEpicRunPatch({ mode: "attended", status: "running" })).toEqual({
      mode: "attended",
      status: "running",
    });
  });

  test("valid provider/model/effort patch preserves explicit null clears", () => {
    expect(
      validateEpicRunPatch({
        agentProvider: null,
        model: null,
        effort: null,
      }),
    ).toEqual({ agentProvider: null, model: null, effort: null });
    expect(
      validateEpicRunPatch({
        agentProvider: "codex",
        model: "gpt-5.5",
        effort: "high",
      }),
    ).toEqual({ agentProvider: "codex", model: "gpt-5.5", effort: "high" });
  });

  test("invalid provider/model/effort values → null", () => {
    expect(validateEpicRunPatch({ agentProvider: "bogus" })).toBeNull();
    expect(validateEpicRunPatch({ agentProvider: "claude", model: "gpt-5.5" })).toBeNull();
    expect(validateEpicRunPatch({ effort: "bogus" })).toBeNull();
    expect(validateEpicRunPatch({ unexpected: true })).toBeNull();
  });

  test("invalid {status:'bogus'} → null", () => {
    expect(validateEpicRunPatch({ status: "bogus" })).toBeNull();
  });

  test("invalid {mode:'manual'} → null", () => {
    expect(validateEpicRunPatch({ mode: "manual" })).toBeNull();
  });

  test("null → null", () => {
    expect(validateEpicRunPatch(null)).toBeNull();
  });

  test("string → null", () => {
    expect(validateEpicRunPatch("running")).toBeNull();
  });

  test("number → null", () => {
    expect(validateEpicRunPatch(42)).toBeNull();
  });

  test("array → null", () => {
    expect(validateEpicRunPatch([])).toBeNull();
  });
});

// ── route harness ────────────────────────────────────────────────────────────

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-epic-server-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeEpic(repoPath: string, parentIssueNumber: number, run: EpicRun): Epic {
  return {
    repoPath,
    parentIssueNumber,
    parentTitle: `Epic #${parentIssueNumber}`,
    source: "native",
    children: [],
    warnings: [],
    run,
  };
}

function makeDiagnosis(parentIssueNumber: number): EpicDiagnosis {
  return {
    parentIssueNumber,
    recognized: true,
    source: "native",
    findings: [{ id: "all-parallel", severity: "warning", params: { count: 3 } }],
    additionalWarnings: [],
  };
}

type FakeDrain = NonNullable<AppDeps["drain"]>;

function harness(opts?: {
  drainOverrides?: Partial<FakeDrain>;
  resolveForge?: AppDeps["resolveForge"];
  authMode?: "chatgpt" | "apikey" | "unknown";
}): { app: ReturnType<typeof makeApp>; store: SessionStore; emitted: unknown[] } {
  const store = new SessionStore(":memory:");
  const emitted: unknown[] = [];
  const events = new EventHub();
  events.subscribe((event, data) => {
    if (event === "epic:update") emitted.push(data);
  });

  const defaultDrain: FakeDrain = {
    snapshot: async () => [],
    queue: async () => [],
    retainClaim: () => {},
    buildEpic: async (repoPath, run) => makeEpic(repoPath, run.parentIssueNumber, run),
    diagnoseEpic: async (_repoPath, run) => makeDiagnosis(run.parentIssueNumber),
    approveEpicNext: () => {},
    tick: async () => {},
  };

  const drain: FakeDrain = { ...defaultDrain, ...(opts?.drainOverrides ?? {}) };

  const deps: AppDeps = {
    store,
    service: {} as AppDeps["service"],
    events,
    usageLimits: { limits: () => ({}) } as any,
    drain,
    resolveForge: opts?.resolveForge,
    readCodexAuthMode: () => opts?.authMode ?? "unknown",
  };
  return { app: makeApp(deps), store, emitted };
}

const encRepo = (dir: string) => encodeURIComponent(dir);

// ── PUT /api/epic — 400 on invalid body ──────────────────────────────────────

describe("PUT /api/epic", () => {
  test("invalid body → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "bogus" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("non-object body → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("notobject"),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("invalid repo → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=/nope/not/here&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("valid {status:'running'} persists via setEpicRun and returns 200", async () => {
    const { app, store } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(200);
    const stored = store.getEpicRun(repoDir);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("running");
    expect(stored!.parentIssueNumber).toBe(327);
  });

  test("valid patch updates mode and preserves other fields", async () => {
    const { app, store } = harness();
    // seed a run first
    store.setEpicRun({
      repoPath: repoDir,
      parentIssueNumber: 327,
      mode: "auto",
      status: "idle",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "attended" }),
      }),
    );
    expect(res.status).toBe(200);
    const stored = store.getEpicRun(repoDir);
    expect(stored!.mode).toBe("attended");
    expect(stored!.status).toBe("idle"); // preserved
  });

  test("valid provider patch persists future-spawn settings", async () => {
    const { app, store } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentProvider: "codex", model: "gpt-5.5", effort: "high" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(store.getEpicRun(repoDir)).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
  });

  test("explicit blocked Codex model is rejected under ChatGPT auth", async () => {
    const { app, store } = harness({ authMode: "chatgpt" });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentProvider: "codex", model: "gpt-5.3-codex" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'model "gpt-5.3-codex" is not supported when using Codex with a ChatGPT account',
    });
    expect(store.getEpicRun(repoDir)).toBeNull();
  });

  test("an existing blocked epic model remains stored across unrelated patches", async () => {
    const { app, store } = harness({ authMode: "chatgpt" });
    store.setEpicRun({
      repoPath: repoDir,
      parentIssueNumber: 327,
      mode: "auto",
      status: "idle",
      agentProvider: "codex",
      model: "gpt-5.3-codex",
      effort: null,
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "attended" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(store.getEpicRun(repoDir)?.model).toBe("gpt-5.3-codex");
  });

  test("explicit agentProvider null clears model and effort to inherit", async () => {
    const { app, store } = harness();
    store.setEpicRun({
      repoPath: repoDir,
      parentIssueNumber: 327,
      mode: "auto",
      status: "running",
      agentProvider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentProvider: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(store.getEpicRun(repoDir)).toMatchObject({
      agentProvider: null,
      model: null,
      effort: null,
    });
  });

  test("rejects explicit model while provider is inherited", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "opus" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("valid patch emits epic:update event", async () => {
    const { app, emitted } = harness();
    await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(emitted.length).toBe(1);
    expect((emitted[0] as Epic).run.status).toBe("running");
  });

  test("{status:'running'} kicks drain.tick() (first sub-issue spawns at once)", async () => {
    let tickCalled = false;
    const { app } = harness({
      drainOverrides: {
        tick: async () => {
          tickCalled = true;
        },
      },
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(tickCalled).toBe(true);
  });

  test("non-running status does not kick drain.tick()", async () => {
    // seed a running run so the patch transitions OUT of running
    let tickCalled = false;
    const { app, store } = harness({
      drainOverrides: {
        tick: async () => {
          tickCalled = true;
        },
      },
    });
    store.setEpicRun({
      repoPath: repoDir,
      parentIssueNumber: 327,
      mode: "auto",
      status: "running",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "idle" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(tickCalled).toBe(false);
  });

  test("{status:'running'} with a throwing drain.tick() still returns 200 (kick is best-effort)", async () => {
    const { app } = harness({
      drainOverrides: {
        tick: async () => {
          throw new Error("tick boom");
        },
      },
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ── GET /api/epic ─────────────────────────────────────────────────────────────

describe("GET /api/epic", () => {
  test("invalid repo → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(new Request(`http://x/api/epic?repo=/nope/not/here&parent=327`));
    expect(res.status).toBe(400);
  });

  test("missing drain → 503", async () => {
    const store = new SessionStore(":memory:");
    const deps: AppDeps = {
      store,
      service: {} as AppDeps["service"],
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      drain: undefined,
    };
    const app = makeApp(deps);
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`),
    );
    expect(res.status).toBe(503);
  });

  test("buildEpic returning null → 404", async () => {
    const { app } = harness({
      drainOverrides: { buildEpic: async () => null },
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`),
    );
    expect(res.status).toBe(404);
  });

  test("valid repo + parent → 200 with assembled epic", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic?repo=${encRepo(repoDir)}&parent=327`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parentIssueNumber).toBe(327);
  });
});

// ── GET /api/epic/diagnose ────────────────────────────────────────────────────

describe("GET /api/epic/diagnose", () => {
  test("invalid repo → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic/diagnose?repo=/nope/not/here&parent=327`),
    );
    expect(res.status).toBe(400);
  });

  test("non-integer parent → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic/diagnose?repo=${encRepo(repoDir)}&parent=abc`),
    );
    expect(res.status).toBe(400);
  });

  test("absent parent → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(new Request(`http://x/api/epic/diagnose?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(400);
  });

  test("missing drain → 503", async () => {
    const store = new SessionStore(":memory:");
    const deps: AppDeps = {
      store,
      service: {} as AppDeps["service"],
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      drain: undefined,
    };
    const app = makeApp(deps);
    const res = await app.fetch(
      new Request(`http://x/api/epic/diagnose?repo=${encRepo(repoDir)}&parent=327`),
    );
    expect(res.status).toBe(503);
  });

  test("diagnoseEpic returning null → 404", async () => {
    const { app } = harness({
      drainOverrides: { diagnoseEpic: async () => null },
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic/diagnose?repo=${encRepo(repoDir)}&parent=327`),
    );
    expect(res.status).toBe(404);
  });

  test("valid repo + parent → 200 with diagnosis", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic/diagnose?repo=${encRepo(repoDir)}&parent=327`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parentIssueNumber).toBe(327);
    expect(body.recognized).toBe(true);
    expect(body.source).toBe("native");
    expect(body.findings[0].id).toBe("all-parallel");
  });
});

// ── POST /api/epic/approve-next ───────────────────────────────────────────────

describe("POST /api/epic/approve-next", () => {
  test("invalid repo → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic/approve-next?repo=/nope&parent=327`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("calls approveEpicNext + tick", async () => {
    let approvedRepo = "";
    let tickCalled = false;
    const { app } = harness({
      drainOverrides: {
        approveEpicNext: (r) => {
          approvedRepo = r;
        },
        tick: async () => {
          tickCalled = true;
        },
      },
    });
    const res = await app.fetch(
      new Request(`http://x/api/epic/approve-next?repo=${encRepo(repoDir)}&parent=327`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(approvedRepo).toBe(repoDir);
    expect(tickCalled).toBe(true);
  });
});

// ── GET /api/epics ────────────────────────────────────────────────────────────

describe("GET /api/epics", () => {
  test("missing drain → empty epics/subIssues", async () => {
    const store = new SessionStore(":memory:");
    const deps: AppDeps = {
      store,
      service: {} as AppDeps["service"],
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      drain: undefined,
    };
    const app = makeApp(deps);
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epics: [], subIssues: [] });
  });

  test("no forge → empty epics/subIssues", async () => {
    const { app } = harness({ resolveForge: () => null });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epics: [], subIssues: [] });
  });

  test("stored epic_run surfaces even with no forge issues match", async () => {
    const { app, store } = harness({
      resolveForge: () =>
        ({
          listIssues: async () => [],
        }) as any,
    });
    store.setEpicRun({
      repoPath: repoDir,
      parentIssueNumber: 99,
      mode: "auto",
      status: "running",
    });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(99);
    expect(body.epics[0].status).toBe("running");
  });

  test("invalid repo → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(new Request(`http://x/api/epics?repo=/nope/not/here`));
    expect(res.status).toBe(400);
  });

  // Pre-filter: with <200 open issues and a markdown candidate, listSubIssues is never called
  test("pre-filter: markdown candidate with complete open list skips listSubIssues entirely", async () => {
    let listSubIssuesCallCount = 0;
    const epicBody = "- [x] #10\n- [ ] #11\n- [ ] #12";
    const forge: any = {
      listIssues: async () => [
        // issue 1: epic body — the one candidate
        { number: 1, title: "Epic issue", body: epicBody, url: "", labels: [], createdAt: 0 },
        // issues 2–5: plain issues with no epic body
        { number: 2, title: "Plain A", body: "just a bug", url: "", labels: [], createdAt: 0 },
        { number: 3, title: "Plain B", body: "", url: "", labels: [], createdAt: 0 },
        {
          number: 4,
          title: "Plain C",
          body: "no checklist here",
          url: "",
          labels: [],
          createdAt: 0,
        },
        {
          number: 5,
          title: "Plain D",
          body: "## Description\nsome text",
          url: "",
          labels: [],
          createdAt: 0,
        },
      ],
      listSubIssues: async () => {
        listSubIssuesCallCount++;
        return [];
      },
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Markdown counts: members [10, 11, 12], only #10 is absent from open set (open = [1,2,3,4,5])
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].total).toBe(3);
    expect(body.epics[0].merged).toBe(3); // 10, 11, 12 all absent from open set
    // Native probe must be skipped entirely — open list is complete (<200 items)
    expect(listSubIssuesCallCount).toBe(0);
  });

  // Native counts: subs → total/merged from closed field (requires openTruncated=true)
  test("native sub-issues: total and merged computed from closed flag when open list is truncated", async () => {
    let listSubIssuesCallCount = 0;
    // Build 200 open issues to trigger openTruncated=true; issue #7 is the epic candidate
    const openIssues = Array.from({ length: 200 }, (_, i) => {
      const n = i + 1;
      return {
        number: n,
        title: n === 7 ? "Epic native" : `Issue ${n}`,
        body: n === 7 ? "- [x] #20\n- [ ] #21" : "",
        url: "",
        labels: [],
        createdAt: 0,
      };
    });
    const forge: any = {
      listIssues: async () => openIssues,
      listSubIssues: async () => {
        listSubIssuesCallCount++;
        return [
          { number: 20, title: "Child A", url: "", body: "", closed: true, labels: [] },
          { number: 21, title: "Child B", url: "", body: "", closed: false, labels: [] },
          { number: 22, title: "Child C", url: "", body: "", closed: true, labels: [] },
        ];
      },
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(7);
    expect(body.epics[0].total).toBe(3); // native: 3 sub-issues
    expect(body.epics[0].merged).toBe(2); // two closed sub-issues
    expect(listSubIssuesCallCount).toBe(1); // probe was made
  });

  // Small repo: <200 issues, markdown candidate → listSubIssues never called, markdown counts used
  test("small repo: markdown candidate uses markdown counts, listSubIssues not called", async () => {
    let listSubIssuesCallCount = 0;
    const forge: any = {
      listIssues: async () => [
        {
          number: 50,
          title: "My epic",
          body: "- [x] #100\n- [ ] #101\n- [x] #102",
          url: "",
          labels: [],
          createdAt: 0,
        },
        { number: 101, title: "Open sub", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssues: async () => {
        listSubIssuesCallCount++;
        return [];
      },
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(50);
    expect(body.epics[0].total).toBe(3); // markdown: 3 members
    expect(body.epics[0].merged).toBe(2); // #100 and #102 absent from open set
    expect(listSubIssuesCallCount).toBe(0); // no native probe
  });

  // Truncated repo: >=200 open issues → native probe is used when available
  test("truncated repo: >=200 open issues causes native probe to be called", async () => {
    let listSubIssuesCallCount = 0;
    const openIssues = Array.from({ length: 200 }, (_, i) => ({
      number: i + 200,
      title: `Issue ${i + 200}`,
      body: i === 0 ? "- [x] #10\n- [ ] #11" : "",
      url: "",
      labels: [],
      createdAt: 0,
    }));
    const forge: any = {
      listIssues: async () => openIssues,
      listSubIssues: async (n: number) => {
        listSubIssuesCallCount++;
        return n === 200
          ? [
              { number: 10, title: "Sub A", url: "", body: "", closed: true, labels: [] },
              { number: 11, title: "Sub B", url: "", body: "", closed: false, labels: [] },
            ]
          : [];
      },
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].total).toBe(2); // native counts used
    expect(body.epics[0].merged).toBe(1);
    expect(listSubIssuesCallCount).toBe(1); // native probe was called
  });

  // No-body parent: stored-run parent with no markdown body → native probe happens
  test("no-body parent: stored-run with no markdown body triggers native probe", async () => {
    let listSubIssuesCallCount = 0;
    const forge: any = {
      listIssues: async () => [],
      listSubIssues: async () => {
        listSubIssuesCallCount++;
        return [
          { number: 5, title: "Sub A", url: "", body: "", closed: true, labels: [] },
          { number: 6, title: "Sub B", url: "", body: "", closed: false, labels: [] },
        ];
      },
    };
    const { app, store } = harness({ resolveForge: () => forge });
    store.setEpicRun({ repoPath: repoDir, parentIssueNumber: 77, mode: "auto", status: "idle" });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(77);
    expect(body.epics[0].total).toBe(2); // native counts
    expect(body.epics[0].merged).toBe(1); // 1 closed sub
    expect(listSubIssuesCallCount).toBe(1); // probe was called
  });

  // Markdown counts: members vs open set
  test("markdown members: merged = members absent from open issues set", async () => {
    // Issues 30 and 32 are open; 31 and 33 are not in open list → counted as merged
    const forge: any = {
      listIssues: async () => [
        {
          number: 8,
          title: "Epic markdown",
          body: "- [x] #30\n- [ ] #31\n- [x] #32\n- [ ] #33",
          url: "",
          labels: [],
          createdAt: 0,
        },
        { number: 30, title: "Open A", body: "", url: "", labels: [], createdAt: 0 },
        { number: 32, title: "Open B", body: "", url: "", labels: [], createdAt: 0 },
      ],
      // no listSubIssues → falls back to markdown
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(8);
    expect(body.epics[0].total).toBe(4);
    expect(body.epics[0].merged).toBe(2); // #31 and #33 not in open set
  });

  // ── listSubIssueSummaries integration ────────────────────────────────────

  // native-only parent (no markdown body) → source:"native", counts from summary map
  test("native-only parent: source is native, counts from listSubIssueSummaries", async () => {
    const summaryMap = new Map([[42, { total: 5, completed: 3 }]]);
    const forge: any = {
      listIssues: async () => [
        // issue 42 has no markdown body — purely native
        { number: 42, title: "Native Epic", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({ summaries: summaryMap, subIssueNumbers: [] }),
      listSubIssues: async () => [],
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(42);
    expect(body.epics[0].source).toBe("native");
    expect(body.epics[0].total).toBe(5);
    expect(body.epics[0].merged).toBe(3);
    // native candidate must NOT trigger listSubIssues per-candidate probe
    // (counts come from the summary map directly)
  });

  // markdown parent → source:"markdown", counts unchanged
  test("markdown parent: source is markdown, counts from markdown members", async () => {
    const summaryMap = new Map<number, { total: number; completed: number }>();
    const forge: any = {
      listIssues: async () => [
        {
          number: 7,
          title: "Md Epic",
          body: "- [x] #100\n- [ ] #101",
          url: "",
          labels: [],
          createdAt: 0,
        },
        { number: 101, title: "Open sub", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({ summaries: summaryMap, subIssueNumbers: [] }),
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(7);
    expect(body.epics[0].source).toBe("markdown");
    expect(body.epics[0].total).toBe(2);
    expect(body.epics[0].merged).toBe(1); // #100 absent from open set
  });

  // both markdown + native → source:"markdown" (markdown takes precedence in list)
  test("both markdown and native: source is markdown (list precedence)", async () => {
    const summaryMap = new Map([[8, { total: 10, completed: 7 }]]);
    const forge: any = {
      listIssues: async () => [
        {
          number: 8,
          title: "Both Epic",
          body: "- [x] #200\n- [ ] #201",
          url: "",
          labels: [],
          createdAt: 0,
        },
        { number: 201, title: "Open sub", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({ summaries: summaryMap, subIssueNumbers: [] }),
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].source).toBe("markdown");
  });

  // "someone else is working this" flags: in-flight children (viewer-excluded) + assigned + authored
  test("epic summary carries inFlight/inFlightBy/assignedOthers/authoredByOther, viewer-excluded", async () => {
    const forge: any = {
      listIssues: async () => [
        {
          number: 16,
          title: "Operator language",
          body: "- [ ] #24\n- [ ] #25",
          url: "",
          labels: [],
          createdAt: 0,
          assignees: ["scoop", "kai"], // kai is the viewer → excluded
          author: "scoop", // non-viewer author → authoredByOther
        },
        { number: 24, title: "child a", body: "", url: "", labels: [], createdAt: 0 },
        { number: 25, title: "child b", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({
        summaries: new Map(),
        subIssueNumbers: [],
        childrenByParent: new Map(),
      }),
      // #24 has a scoop PR (counts); #25 only the viewer's own PR (excluded)
      listOpenPrLinkedIssues: async () =>
        new Map([
          [24, [{ prNumber: 300, author: "scoop" }]],
          [25, [{ prNumber: 301, author: "kai" }]],
        ]),
      currentUser: async () => "kai",
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    const epic = body.epics.find((e: any) => e.parentIssueNumber === 16);
    expect(epic).toBeTruthy();
    expect(epic.inFlight).toBe(1); // only #24's non-viewer PR counts
    expect(epic.inFlightBy).toEqual(["scoop"]);
    expect(epic.assignedOthers).toEqual(["scoop"]); // kai (viewer) dropped
    expect(epic.authoredByOther).toBe("scoop");
  });

  // native children (from childrenByParent) also feed the in-flight count
  test("epic summary counts native in-flight children via childrenByParent", async () => {
    const forge: any = {
      listIssues: async () => [
        // native parent: no markdown body, discovered via summaries
        { number: 50, title: "Native Epic", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({
        summaries: new Map([[50, { total: 2, completed: 0 }]]),
        subIssueNumbers: [61, 62],
        childrenByParent: new Map([[50, [61, 62]]]),
      }),
      listSubIssues: async () => [],
      listOpenPrLinkedIssues: async () => new Map([[61, [{ prNumber: 400, author: "scoop" }]]]),
      currentUser: async () => "kai",
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    const body = await res.json();
    const epic = body.epics.find((e: any) => e.parentIssueNumber === 50);
    expect(epic.inFlight).toBe(1);
    expect(epic.inFlightBy).toEqual(["scoop"]);
  });

  // native parent absent from the visible listIssues set → NOT surfaced. IssuesPanel renders an
  // epic badge only on a matching visible issue row, so an out-of-window summary could never be
  // displayed; surfacing it would only emit an unused row.
  test("native parent outside listIssues window: not surfaced (gated to visible issues)", async () => {
    // listIssues returns only issue 1; native parent #999 is beyond the visible window
    const summaryMap = new Map([[999, { total: 3, completed: 1 }]]);
    const forge: any = {
      listIssues: async () => [
        { number: 1, title: "Unrelated", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({ summaries: summaryMap, subIssueNumbers: [] }),
      listSubIssues: async () => [],
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.find((e: any) => e.parentIssueNumber === 999)).toBeUndefined();
  });

  // forge without listSubIssueSummaries → no native candidates, no error
  test("forge without listSubIssueSummaries: no native candidates, no error", async () => {
    const forge: any = {
      listIssues: async () => [
        { number: 5, title: "Plain", body: "", url: "", labels: [], createdAt: 0 },
      ],
      // listSubIssueSummaries intentionally absent (Gitea-like)
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics).toEqual([]); // no epics — no markdown, no native
    expect(body.subIssues).toEqual([]);
  });

  // native discovery adds no extra listSubIssues probe for native candidates
  test("native candidate: no per-candidate listSubIssues probe called", async () => {
    let listSubIssuesCallCount = 0;
    const summaryMap = new Map([[55, { total: 4, completed: 2 }]]);
    const forge: any = {
      listIssues: async () => [
        { number: 55, title: "Native only", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({ summaries: summaryMap, subIssueNumbers: [] }),
      listSubIssues: async () => {
        listSubIssuesCallCount++;
        return [];
      },
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    expect(listSubIssuesCallCount).toBe(0); // no per-candidate probe for native
  });

  // Status: stored run's status is reflected; non-stored defaults to "idle"
  test("status: reflects storedRun.status for matched parent, idle otherwise", async () => {
    const { app, store } = harness({
      resolveForge: () =>
        ({
          listIssues: async () => [
            { number: 10, title: "Epic A", body: "- [x] #1", url: "", labels: [], createdAt: 0 },
            { number: 11, title: "Epic B", body: "- [x] #2", url: "", labels: [], createdAt: 0 },
          ],
        }) as any,
    });
    store.setEpicRun({ repoPath: repoDir, parentIssueNumber: 10, mode: "auto", status: "running" });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body: { epics: { parentIssueNumber: number; status: string }[]; subIssues: number[] } =
      await res.json();
    const epicA = body.epics.find((e) => e.parentIssueNumber === 10);
    const epicB = body.epics.find((e) => e.parentIssueNumber === 11);
    expect(epicA?.status).toBe("running");
    expect(epicB?.status).toBe("idle");
  });

  // ── response shape { epics, subIssues } ──────────────────────────────────────

  test("response shape: happy path returns { epics: [...], subIssues: [...] }", async () => {
    const summaryMap = new Map([[30, { total: 2, completed: 1 }]]);
    const forge: any = {
      listIssues: async () => [
        { number: 30, title: "Epic", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => ({
        summaries: summaryMap,
        subIssueNumbers: [5, 6],
      }),
      listSubIssues: async () => [],
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.epics)).toBe(true);
    expect(Array.isArray(body.subIssues)).toBe(true);
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(30);
    expect(body.subIssues).toEqual([5, 6]);
  });

  test("response shape: listIssues throws → { epics: [], subIssues: [] }", async () => {
    const forge: any = {
      listIssues: async () => {
        throw new Error("network failure");
      },
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ epics: [], subIssues: [] });
  });

  test("response shape: missing drain → { epics: [], subIssues: [] } (shape not bare array)", async () => {
    const store = new SessionStore(":memory:");
    const deps: AppDeps = {
      store,
      service: {} as AppDeps["service"],
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as any,
      drain: undefined,
    };
    const app = makeApp(deps);
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    const body = await res.json();
    expect(body).toEqual({ epics: [], subIssues: [] });
    expect(Array.isArray(body)).toBe(false); // must be object, not bare array
  });

  test("response shape: no forge → { epics: [], subIssues: [] } (shape not bare array)", async () => {
    const { app } = harness({ resolveForge: () => null });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    const body = await res.json();
    expect(body).toEqual({ epics: [], subIssues: [] });
    expect(Array.isArray(body)).toBe(false);
  });

  // ── markdown epic members count as sub-issues ────────────────────────────────
  // A markdown (epic-dag) epic's children have no GitHub-native parent, so they never
  // appear in the native `subIssueNumbers`. The backlog "hide sub-issues" filter must
  // still hide them, so subIssues folds in the open markdown members too.
  test("markdown epic: open members are surfaced in subIssues", async () => {
    const forge: any = {
      // #50 is a markdown epic with members #100 (closed) / #101 (open) / #102 (open).
      // Only the open members render in the list, so only those should be hidden.
      listIssues: async () => [
        {
          number: 50,
          title: "Epic",
          body: "- [x] #100\n- [ ] #101\n- [ ] #102",
          url: "",
          labels: [],
          createdAt: 0,
        },
        { number: 101, title: "Open sub", body: "", url: "", labels: [], createdAt: 0 },
        { number: 102, title: "Open sub", body: "", url: "", labels: [], createdAt: 0 },
        { number: 200, title: "Ordinary", body: "", url: "", labels: [], createdAt: 0 },
      ],
      // No native sub-issues in this repo (markdown epic only).
      listSubIssueSummaries: async () => ({ summaries: new Map(), subIssueNumbers: [] }),
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epics.length).toBe(1);
    expect(body.epics[0].parentIssueNumber).toBe(50);
    // Open members #101/#102 surface; closed #100 and the parent/ordinary do not.
    expect([...body.subIssues].sort((a: number, b: number) => a - b)).toEqual([101, 102]);
  });

  // Native + markdown sub-issues union without duplicates.
  test("markdown + native: subIssues unions both with no duplicates", async () => {
    const forge: any = {
      listIssues: async () => [
        {
          number: 50,
          title: "MD Epic",
          body: "- [ ] #101\n- [ ] #7",
          url: "",
          labels: [],
          createdAt: 0,
        },
        { number: 101, title: "Open md sub", body: "", url: "", labels: [], createdAt: 0 },
        { number: 7, title: "Both", body: "", url: "", labels: [], createdAt: 0 },
      ],
      // #7 is also a native sub-issue → must appear once, not twice.
      listSubIssueSummaries: async () => ({ summaries: new Map(), subIssueNumbers: [7] }),
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    const body = await res.json();
    expect([...body.subIssues].sort((a: number, b: number) => a - b)).toEqual([7, 101]);
  });
});

// ── completed-epics band (GET /api/epics/completed + dismiss) ─────────────────

function mergedChild(number: number): EpicChild {
  return {
    number,
    title: `Child #${number}`,
    url: `https://x/issues/${number}`,
    order: number,
    body: "",
    blockedBy: [],
    state: "merged",
    sessionId: null,
    prNumber: null,
    issueClosed: true,
    integrationMerged: true,
    claimed: true,
  };
}

// Harness that also captures epic:completed-cleared events (the default harness only
// captures epic:update).
function completedHarness(opts?: {
  drainOverrides?: Partial<NonNullable<AppDeps["drain"]>>;
  drain?: AppDeps["drain"] | null;
  resolveForge?: AppDeps["resolveForge"];
}): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
  cleared: { repoPath: string; parentIssueNumber: number }[];
} {
  const store = new SessionStore(":memory:");
  const cleared: { repoPath: string; parentIssueNumber: number }[] = [];
  const events = new EventHub();
  events.subscribe((event, data) => {
    if (event === "epic:completed-cleared")
      cleared.push(data as { repoPath: string; parentIssueNumber: number });
  });

  const defaultDrain: NonNullable<AppDeps["drain"]> = {
    snapshot: async () => [],
    queue: async () => [],
    retainClaim: () => {},
    buildEpic: async (repoPath, run) => makeEpic(repoPath, run.parentIssueNumber, run),
    diagnoseEpic: async (_repoPath, run) => makeDiagnosis(run.parentIssueNumber),
    approveEpicNext: () => {},
    tick: async () => {},
  };
  const drain =
    opts?.drain === null ? undefined : { ...defaultDrain, ...(opts?.drainOverrides ?? {}) };

  const deps: AppDeps = {
    store,
    service: {} as AppDeps["service"],
    events,
    usageLimits: { limits: () => ({}) } as any,
    drain,
    resolveForge: opts?.resolveForge,
  };
  return { app: makeApp(deps), store, cleared };
}

describe("GET /api/epics/completed", () => {
  test("returns persisted completed epics with parsed children", async () => {
    const { app, store } = completedHarness({ resolveForge: () => null });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 42,
      parentTitle: "Epic Done",
      completedAt: 5000,
      childrenJson: JSON.stringify([
        {
          number: 1,
          title: "C1",
          url: "u1",
          prNumber: 9,
          prUrl: "pu9",
          mergedAt: 4000,
          integrated: true,
        },
      ]),
    });
    const res = await app.fetch(new Request(`http://x/api/epics/completed`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].parentIssueNumber).toBe(42);
    expect(body[0].parentTitle).toBe("Epic Done");
    expect(body[0].childrenJson).toBeUndefined();
    expect(body[0].children).toEqual([
      {
        number: 1,
        title: "C1",
        url: "u1",
        prNumber: 9,
        prUrl: "pu9",
        mergedAt: 4000,
        integrated: true,
      },
    ]);
  });

  test("response carries landing-PR fields; landingAttempts excluded", async () => {
    const { app, store } = completedHarness({ resolveForge: () => null });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 42,
      parentTitle: "Epic Done",
      completedAt: 5000,
      childrenJson: "[]",
    });
    store.setEpicLandingPr(repoDir, 42, {
      state: "open",
      prNumber: 42,
      prUrl: "https://example/pr/42",
      attempts: 0,
    });
    const res = await app.fetch(new Request(`http://x/api/epics/completed`));
    const body = await res.json();
    expect(body).toHaveLength(1);
    const row = body[0];
    expect(row.landingPrNumber).toBe(42);
    expect(row.landingPrUrl).toBe("https://example/pr/42");
    expect(row.landingState).toBe("open");
    // Internal counters are stripped; landingRebasePauseReason is API-facing and passes through.
    expect("landingAttempts" in row).toBe(false);
    expect("landingRebaseCount" in row).toBe(false);
    expect("landingRebaseDriverMisses" in row).toBe(false);
    expect("landingRebasePauseReason" in row).toBe(true);
    expect(row.landingRebasePauseReason).toBe(null); // not paused
  });

  test("landingRebasePauseReason passes through with its value when set", async () => {
    const { app, store } = completedHarness({ resolveForge: () => null });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 43,
      parentTitle: "Paused Epic",
      completedAt: 5000,
      childrenJson: "[]",
    });
    store.setEpicLandingPr(repoDir, 43, {
      state: "open",
      prNumber: 43,
      prUrl: "https://example/pr/43",
      attempts: 0,
    });
    store.setEpicLandingRebaseState(repoDir, 43, { pauseReason: "conflict" });
    const res = await app.fetch(new Request(`http://x/api/epics/completed`));
    const body = await res.json();
    expect(body).toHaveLength(1);
    const row = body[0];
    expect(row.landingRebasePauseReason).toBe("conflict");
    expect("landingRebaseCount" in row).toBe(false);
    expect("landingRebaseDriverMisses" in row).toBe(false);
  });

  test("plain record → default landing fields (pending/null/null)", async () => {
    const { app, store } = completedHarness({ resolveForge: () => null });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 7,
      parentTitle: "Fresh",
      completedAt: 1,
      childrenJson: "[]",
    });
    const res = await app.fetch(new Request(`http://x/api/epics/completed`));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].landingState).toBe("pending");
    expect(body[0].landingPrNumber).toBe(null);
    expect(body[0].landingPrUrl).toBe(null);
  });

  test("?repo= filters to one repo", async () => {
    const other = join(tmpRoot, "other");
    mkdirSync(other);
    const { app, store } = completedHarness({ resolveForge: () => null });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 1,
      parentTitle: "A",
      completedAt: 1,
      childrenJson: "[]",
    });
    store.recordEpicCompleted({
      repoPath: other,
      parentIssueNumber: 2,
      parentTitle: "B",
      completedAt: 2,
      childrenJson: "[]",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].parentIssueNumber).toBe(1);
  });

  test("invalid ?repo= → 400", async () => {
    const { app } = completedHarness();
    const res = await app.fetch(new Request(`http://x/api/epics/completed?repo=/nope/not/here`));
    expect(res.status).toBe(400);
  });

  test("auto-dismiss: confidently-closed parent cleared + event; still-open retained", async () => {
    const { app, store, cleared } = completedHarness({
      // open set = [7] (the retained one); #5 is absent → confidently closed
      resolveForge: () =>
        ({
          listIssues: async () => [
            { number: 7, title: "Open epic", body: "", url: "", labels: [], createdAt: 0 },
          ],
        }) as any,
    });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 5,
      parentTitle: "Closed",
      completedAt: 1,
      childrenJson: "[]",
    });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 7,
      parentTitle: "Still open",
      completedAt: 2,
      childrenJson: "[]",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    const body = await res.json();
    expect(body.map((e: any) => e.parentIssueNumber)).toEqual([7]);
    expect(cleared).toEqual([{ repoPath: repoDir, parentIssueNumber: 5 }]);
  });

  test("auto-dismiss: skipped when open list is truncated (>=200)", async () => {
    const openIssues = Array.from({ length: 200 }, (_, i) => ({
      number: i + 1000,
      title: `I${i}`,
      body: "",
      url: "",
      labels: [],
      createdAt: 0,
    }));
    const { app, store, cleared } = completedHarness({
      resolveForge: () => ({ listIssues: async () => openIssues }) as any,
    });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 5,
      parentTitle: "Maybe closed",
      completedAt: 1,
      childrenJson: "[]",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    const body = await res.json();
    // not confidently closed → retained, no clear event
    expect(body.map((e: any) => e.parentIssueNumber)).toEqual([5]);
    expect(cleared).toEqual([]);
  });

  test("backfill: idle all-merged epic with no record → recorded + returned", async () => {
    const { app, store } = completedHarness({
      resolveForge: () =>
        ({
          listIssues: async () => [
            { number: 88, title: "Epic", body: "", url: "", labels: [], createdAt: 0 },
          ],
        }) as any,
      drainOverrides: {
        buildEpic: async (repoPath, run) => ({
          ...makeEpic(repoPath, run.parentIssueNumber, run),
          children: [mergedChild(1), mergedChild(2)],
        }),
      },
    });
    store.setEpicRun({ repoPath: repoDir, parentIssueNumber: 88, mode: "auto", status: "idle" });
    store.recordEpicIntegrated(repoDir, 88, 1, { number: 11, url: "pr11" });
    store.recordEpicIntegrated(repoDir, 88, 2, { number: 22, url: "pr22" });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].parentIssueNumber).toBe(88);
    expect(body[0].children).toHaveLength(2);
    expect(body[0].children.every((c: any) => c.integrated)).toBe(true);
    // backfill seeds the retry-able pending state the drain tick will resolve
    expect(body[0].landingState).toBe("pending");
    expect(body[0].landingPrNumber).toBe(null);
    // persisted
    expect(store.listEpicCompleted(repoDir)).toHaveLength(1);
  });

  test("backfill: NOT-all-merged epic → no record created (skip logged)", async () => {
    const { app, store } = completedHarness({
      resolveForge: () =>
        ({
          listIssues: async () => [
            { number: 88, title: "Epic", body: "", url: "", labels: [], createdAt: 0 },
          ],
        }) as any,
      drainOverrides: {
        buildEpic: async (repoPath, run) => ({
          ...makeEpic(repoPath, run.parentIssueNumber, run),
          children: [
            mergedChild(1),
            { ...mergedChild(2), state: "in-review", integrationMerged: false },
          ],
        }),
      },
    });
    store.setEpicRun({ repoPath: repoDir, parentIssueNumber: 88, mode: "auto", status: "idle" });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    const body = await res.json();
    expect(body).toEqual([]);
    expect(store.listEpicCompleted(repoDir)).toHaveLength(0);
  });

  test("backfill: dismissed idle run is NOT re-backfilled (buildEpic not re-called)", async () => {
    let buildEpicCalls = 0;
    const { app, store } = completedHarness({
      // open set includes the parent → not auto-dismissed by the open-set sweep; the dismissed
      // row must be honored by the hasEpicCompleted pre-check, not by absence from the open set.
      resolveForge: () =>
        ({
          listIssues: async () => [
            { number: 88, title: "Epic", body: "", url: "", labels: [], createdAt: 0 },
          ],
        }) as any,
      drainOverrides: {
        buildEpic: async (repoPath, run) => {
          buildEpicCalls++;
          return {
            ...makeEpic(repoPath, run.parentIssueNumber, run),
            children: [mergedChild(1), mergedChild(2)],
          };
        },
      },
    });
    // Record + dismiss the completed epic, leaving an idle run for the same parent.
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 88,
      parentTitle: "Epic",
      completedAt: 1,
      childrenJson: "[]",
    });
    store.dismissEpicCompleted(repoDir, 88);
    store.setEpicRun({ repoPath: repoDir, parentIssueNumber: 88, mode: "auto", status: "idle" });

    const res1 = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual([]); // dismissed → stays absent from response
    const res2 = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    expect(await res2.json()).toEqual([]);
    // hasEpicCompleted (dismissedAt-agnostic) short-circuits the backfill → buildEpic never fires.
    expect(buildEpicCalls).toBe(0);
  });

  test("forge throw during reconcile → still 200 with DB rows (fail-safe)", async () => {
    const { app, store } = completedHarness({
      resolveForge: () =>
        ({
          listIssues: async () => {
            throw new Error("boom");
          },
        }) as any,
    });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 5,
      parentTitle: "Persisted",
      completedAt: 1,
      childrenJson: "[]",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].parentIssueNumber).toBe(5);
  });

  test("no drain → still serves DB rows + auto-dismiss (backfill skipped)", async () => {
    const { app, store } = completedHarness({
      drain: null,
      resolveForge: () => ({ listIssues: async () => [] }) as any,
    });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 5,
      parentTitle: "Closed",
      completedAt: 1,
      childrenJson: "[]",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    expect(res.status).toBe(200);
    // open set empty → #5 confidently closed → auto-dismissed even without drain
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /api/epics/completed/dismiss", () => {
  test("dismiss hides row from subsequent GET + emits event", async () => {
    const { app, store, cleared } = completedHarness({ resolveForge: () => null });
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: 5,
      parentTitle: "X",
      completedAt: 1,
      childrenJson: "[]",
    });
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 5 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cleared).toEqual([{ repoPath: repoDir, parentIssueNumber: 5 }]);
    const get = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    expect(await get.json()).toEqual([]);
  });

  test("invalid repo → 400", async () => {
    const { app } = completedHarness();
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "/nope/not/here", parent: 5 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("invalid parent → 400", async () => {
    const { app } = completedHarness();
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: -1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("missing body (no repo) → 400", async () => {
    const { app } = completedHarness();
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: 5 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── POST /api/epic/import ─────────────────────────────────────────────────────

describe("POST /api/epic/import", () => {
  const EPIC_BODY = "```epic-dag\n#10\n#11 <- #10\n#12\n```";

  function makeImportForge(opts?: {
    getIssueResult?: {
      number: number;
      title: string;
      body: string;
      url: string;
      labels: string[];
      createdAt: number;
    } | null;
  }) {
    const subIssueAdded: Array<{ parent: number; child: number }> = [];
    const blockedByAdded: Array<{ issue: number; blocker: number }> = [];
    const forge: any = {
      slug: "owner/repo",
      kind: "github",
      listIssues: async () => [],
      getIssue: async () =>
        opts?.getIssueResult !== undefined
          ? opts.getIssueResult
          : {
              number: 5,
              title: "My epic",
              body: EPIC_BODY,
              url: "https://github.com/owner/repo/issues/5",
              labels: [],
              createdAt: 0,
            },
      listSubIssues: async () => [],
      listBlockedBy: async () => [],
      addSubIssue: async (parent: number, child: number) => {
        subIssueAdded.push({ parent, child });
      },
      addBlockedBy: async (issue: number, blocker: number) => {
        blockedByAdded.push({ issue, blocker });
      },
    };
    return { forge, subIssueAdded, blockedByAdded };
  }

  test("no/invalid repo → 400", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request(`http://x/api/epic/import?repo=/nope/not/here&parent=5`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  test("no forge → 404", async () => {
    const { app } = harness({ resolveForge: () => null });
    const res = await app.fetch(
      new Request(`http://x/api/epic/import?repo=${encRepo(repoDir)}&parent=5`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no forge/i);
  });

  test("getIssue returns null → 404", async () => {
    const { forge } = makeImportForge({ getIssueResult: null });
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(
      new Request(`http://x/api/epic/import?repo=${encRepo(repoDir)}&parent=5`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  test("success: returns ImportResult with correct counts", async () => {
    const { forge, subIssueAdded, blockedByAdded } = makeImportForge();
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(
      new Request(`http://x/api/epic/import?repo=${encRepo(repoDir)}&parent=5`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const result = await res.json();
    // EPIC_BODY has 3 members (#10, #11, #12) → 3 sub-issues added (none pre-exist)
    expect(result.subIssuesAdded).toBe(3);
    // #11 is blocked-by #10 → 1 dependency added
    expect(result.dependenciesAdded).toBe(1);
    expect(result.skipped).toBe(0);
    // verify the forge calls were made
    expect(subIssueAdded).toEqual([
      { parent: 5, child: 10 },
      { parent: 5, child: 11 },
      { parent: 5, child: 12 },
    ]);
    expect(blockedByAdded).toEqual([{ issue: 11, blocker: 10 }]);
  });

  test("forge missing required epic methods → 400 with error", async () => {
    const { forge } = makeImportForge();
    // remove the methods that importEpicLinks requires
    delete forge.addSubIssue;
    delete forge.addBlockedBy;
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(
      new Request(`http://x/api/epic/import?repo=${encRepo(repoDir)}&parent=5`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/native epic links/i);
  });
});

// ── POST /api/epics/completed/ack-migrations (#645) ───────────────────────────

describe("POST /api/epics/completed/ack-migrations", () => {
  function seedRow(store: SessionStore, parent: number) {
    store.recordEpicCompleted({
      repoPath: repoDir,
      parentIssueNumber: parent,
      parentTitle: "E",
      completedAt: 1,
      childrenJson: "[]",
    });
    store.setEpicMigrationPaths(repoDir, parent, ["server/migrations/001.sql"]);
  }

  test("acknowledges migrations: dismisses the row, clears band, emits cleared", async () => {
    const { app, store, cleared } = completedHarness({ resolveForge: () => null });
    seedRow(store, 327);
    expect(store.listEpicCompleted(repoDir)).toHaveLength(1);

    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/ack-migrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 327 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // acknowledging dismisses → row cleared from the band + cleared event emitted
    expect(store.listEpicCompleted(repoDir)).toHaveLength(0);
    expect(cleared).toEqual([{ repoPath: repoDir, parentIssueNumber: 327 }]);
    const get = await app.fetch(
      new Request(`http://x/api/epics/completed?repo=${encRepo(repoDir)}`),
    );
    expect(await get.json()).toEqual([]);
  });

  test("invalid repo → 400", async () => {
    const { app } = completedHarness();
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/ack-migrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "/nope/not/here", parent: 327 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("non-positive parent → 400", async () => {
    const { app } = completedHarness();
    const res = await app.fetch(
      new Request(`http://x/api/epics/completed/ack-migrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 0 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
