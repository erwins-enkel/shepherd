import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { validateEpicRunPatch } from "../src/validate";
import type { Epic, EpicRun } from "../src/epic-core";

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

type FakeDrain = NonNullable<AppDeps["drain"]>;

function harness(opts?: {
  drainOverrides?: Partial<FakeDrain>;
  resolveForge?: AppDeps["resolveForge"];
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
  test("missing drain → empty array", async () => {
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
    expect(await res.json()).toEqual([]);
  });

  test("no forge → empty array", async () => {
    const { app } = harness({ resolveForge: () => null });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(99);
    expect(body[0].status).toBe("running");
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
    expect(body.length).toBe(1);
    expect(body[0].total).toBe(3);
    expect(body[0].merged).toBe(3); // 10, 11, 12 all absent from open set
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
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(7);
    expect(body[0].total).toBe(3); // native: 3 sub-issues
    expect(body[0].merged).toBe(2); // two closed sub-issues
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
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(50);
    expect(body[0].total).toBe(3); // markdown: 3 members
    expect(body[0].merged).toBe(2); // #100 and #102 absent from open set
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
    expect(body.length).toBe(1);
    expect(body[0].total).toBe(2); // native counts used
    expect(body[0].merged).toBe(1);
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
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(77);
    expect(body[0].total).toBe(2); // native counts
    expect(body[0].merged).toBe(1); // 1 closed sub
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
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(8);
    expect(body[0].total).toBe(4);
    expect(body[0].merged).toBe(2); // #31 and #33 not in open set
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
      listSubIssueSummaries: async () => summaryMap,
      listSubIssues: async () => [],
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(42);
    expect(body[0].source).toBe("native");
    expect(body[0].total).toBe(5);
    expect(body[0].merged).toBe(3);
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
      listSubIssueSummaries: async () => summaryMap,
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].parentIssueNumber).toBe(7);
    expect(body[0].source).toBe("markdown");
    expect(body[0].total).toBe(2);
    expect(body[0].merged).toBe(1); // #100 absent from open set
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
      listSubIssueSummaries: async () => summaryMap,
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].source).toBe("markdown");
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
      listSubIssueSummaries: async () => summaryMap,
      listSubIssues: async () => [],
    };
    const { app } = harness({ resolveForge: () => forge });
    const res = await app.fetch(new Request(`http://x/api/epics?repo=${encRepo(repoDir)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.find((e: any) => e.parentIssueNumber === 999)).toBeUndefined();
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
    expect(body).toEqual([]); // no epics — no markdown, no native
  });

  // native discovery adds no extra listSubIssues probe for native candidates
  test("native candidate: no per-candidate listSubIssues probe called", async () => {
    let listSubIssuesCallCount = 0;
    const summaryMap = new Map([[55, { total: 4, completed: 2 }]]);
    const forge: any = {
      listIssues: async () => [
        { number: 55, title: "Native only", body: "", url: "", labels: [], createdAt: 0 },
      ],
      listSubIssueSummaries: async () => summaryMap,
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
    const body: { parentIssueNumber: number; status: string }[] = await res.json();
    const epicA = body.find((e) => e.parentIssueNumber === 10);
    const epicB = body.find((e) => e.parentIssueNumber === 11);
    expect(epicA?.status).toBe("running");
    expect(epicB?.status).toBe("idle");
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
