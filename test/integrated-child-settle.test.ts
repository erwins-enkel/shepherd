import { describe, test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";
import { IntegratedChildSettler, restRefusal } from "../src/integrated-child-settle";
import type { PrReviewMeta } from "../src/forge/types";

// #3016: the machine that ran an epic child settles it once the epic's leading machine merged it.
// Nothing is taken on the leader's word: its own session, a fresh forge read, and an archive that
// starts in the same tick as its last checks and holds every resume off while it runs.

const EPIC = "epic/3016-repo-settings";
const ORIGIN = "http://localhost:7330";

interface HarnessOpts {
  /** Block the archive in its recap hook until `release()`. */
  gated?: boolean;
  /** The forge's answer for the PR, null = unknown. */
  meta?: PrReviewMeta | null;
}

function harness(opts: HarnessOpts = {}) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const emitted: string[] = [];
  events.subscribe((event, data: any) => {
    if (event === "session:archived") emitted.push(data.id);
  });
  let entered!: () => void;
  let release: () => void = () => {};
  const began = new Promise<void>((r) => (entered = r));
  const gate = opts.gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  const counts = { stop: 0, remove: 0, start: 0 };
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => counts.remove++,
    } as any,
    herdr: {
      start: async () => {
        counts.start++;
        return {} as any;
      },
      listAsync: async () => [],
      stop: async () => {
        counts.stop++;
      },
      send: () => {},
    } as any,
    events,
    beforeArchive: async () => {
      entered();
      await gate;
    },
  });
  const cache = new Map<string, any>();
  const prCache = {
    snapshot: () => Object.fromEntries(cache),
    get: (id: string) => cache.get(id),
    set: (id: string, g: any) => cache.set(id, g),
    drop: (id: string) => cache.delete(id),
  };
  const metaReads: number[] = [];
  let meta: PrReviewMeta | null =
    opts.meta === undefined
      ? { body: "", baseRefName: EPIC, isCrossRepository: false, state: "merged" }
      : opts.meta;
  let metaGate: Promise<void> = Promise.resolve();
  const forge = {
    kind: "github",
    prReviewMeta: async (n: number) => {
      metaReads.push(n);
      await metaGate;
      return meta;
    },
    closeIssue: async () => {
      closed.push(true);
    },
  } as any;
  const closed: boolean[] = [];
  const retained: string[] = [];
  const materialized: number[] = [];
  const settler = new IntegratedChildSettler({
    store,
    service,
    prOf: (id) => prCache.get(id),
    resolveForge: () => forge,
    materializeManualSteps: (_s, pr) => materialized.push(pr),
    retainClaim: (id) => retained.push(id),
    dropPrCache: (id) => prCache.drop(id),
    emitArchived: (id) => events.emit("session:archived", { id }),
  });
  const app = makeApp({ store, service, events, prCache, integratedChildSettler: settler } as any);
  /** A child session at rest whose PR #`pr` the poller saw merged into the epic branch. */
  const child = (
    pr = 3955,
    status: "idle" | "done" | "running" | "blocked" = "done",
    issueNumber: number | null = 3013,
  ) => {
    const s = store.create({
      name: `c${pr}`,
      prompt: "p",
      repoPath: "/r",
      baseBranch: EPIC,
      branch: `shepherd/c${pr}`,
      worktreePath: `/wt/c${pr}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term_${pr}`,
      ...(issueNumber != null && { issueNumber }),
    } as any);
    store.update(s.id, { status });
    cache.set(s.id, {
      state: "merged",
      number: pr,
      title: "feat: child",
      baseRefName: EPIC,
    });
    return s;
  };
  const post = (id: string, body: unknown, path = "settle-integrated") =>
    app.fetch(
      new Request(`${ORIGIN}/api/sessions/${id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(body),
      }),
    );
  return {
    store,
    service,
    settler,
    app,
    child,
    post,
    cache,
    began,
    release: () => release(),
    counts,
    emitted,
    retained,
    materialized,
    closed,
    metaReads,
    setMeta: (m: PrReviewMeta | null) => (meta = m),
    holdMeta: () => {
      let open!: () => void;
      metaGate = new Promise<void>((r) => (open = r));
      return () => open();
    },
    entered: () => began,
  };
}

describe("POST /api/sessions/:id/settle-integrated (#3016)", () => {
  test("settles a merged child at rest: archived merged, claim kept, issue left open", async () => {
    const h = harness();
    const s = h.child();
    const res = await h.post(s.id, { prNumber: 3955 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settled: true });
    const row = h.store.get(s.id)!;
    expect(row.status).toBe("archived");
    expect(row.archiveReason).toBe("merged");
    expect(h.retained).toEqual([s.id]);
    expect(h.closed).toEqual([]);
    expect(h.materialized).toEqual([3955]);
    expect(h.emitted).toEqual([s.id]);
    expect(h.cache.has(s.id)).toBe(false);
    // Again: idempotent, nothing torn down twice.
    const again = await h.post(s.id, { prNumber: 3955 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ settled: true, already: true });
    expect(h.counts.stop).toBe(1);
    expect(h.emitted).toEqual([s.id]);
  });

  test("a prNumber is optional: the session's own PR is the one checked", async () => {
    const h = harness();
    const s = h.child(3973);
    const res = await h.post(s.id, {});
    expect(res.status).toBe(200);
    expect(h.metaReads).toEqual([3973]);
  });

  test("a stale poller cache does not block: the fresh forge read decides", async () => {
    const h = harness();
    const s = h.child();
    h.cache.set(s.id, { ...h.cache.get(s.id), state: "open" });
    expect((await h.post(s.id, { prNumber: 3955 })).status).toBe(200);
    expect(h.store.get(s.id)?.status).toBe("archived");
  });

  test("refusals change nothing and name the reason", async () => {
    const cases: [string, (h: ReturnType<typeof harness>) => string, unknown, string][] = [
      [
        "forge says open",
        (h) => (
          h.setMeta({ body: "", baseRefName: EPIC, isCrossRepository: false, state: "open" }),
          h.child().id
        ),
        { prNumber: 3955 },
        "not_merged",
      ],
      [
        "forge read unknown",
        (h) => (h.setMeta(null), h.child().id),
        { prNumber: 3955 },
        "not_merged",
      ],
      ["another PR than the integrated one", (h) => h.child().id, { prNumber: 4000 }, "not_merged"],
      [
        "merged into main",
        (h) => (
          h.setMeta({ body: "", baseRefName: "main", isCrossRepository: false, state: "merged" }),
          h.child().id
        ),
        {},
        "not_epic_child",
      ],
      ["no issue", (h) => h.child(3955, "done", null).id, {}, "not_epic_child"],
      ["agent working", (h) => h.child(3955, "running").id, {}, "busy"],
      ["agent waiting on the operator", (h) => h.child(3955, "blocked").id, {}, "busy"],
      [
        "shelved",
        (h) => {
          const s = h.child();
          h.store.setShelved(s.id, true);
          return s.id;
        },
        {},
        "held",
      ],
    ];
    for (const [name, make, body, code] of cases) {
      const h = harness();
      const id = make(h);
      const res = await h.post(id, body);
      expect({ name, status: res.status }).toEqual({ name, status: 409 });
      expect({ name, code: (await res.json()).code }).toEqual({ name, code });
      expect(h.store.get(id)?.status).not.toBe("archived");
      expect(h.counts.stop).toBe(0);
      expect(h.retained).toEqual([]);
      expect(h.emitted).toEqual([]);
    }
  });

  test("unknown session → 404 with its code; a bad body → 400", async () => {
    const h = harness();
    const missing = await h.post("00000000-0000-4000-8000-000000000000", {});
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("session_not_found");
    const s = h.child();
    expect((await h.post(s.id, { prNumber: "3955" })).status).toBe(400);
    expect((await h.post(s.id, { prNumber: -1 })).status).toBe(400);
    expect((await h.post(s.id, [1])).status).toBe(400);
  });

  test("two requests at once: one teardown, both answered settled", async () => {
    const h = harness({ gated: true });
    const s = h.child();
    const a = h.post(s.id, { prNumber: 3955 });
    const b = h.post(s.id, { prNumber: 3955 });
    await h.entered();
    h.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(await ra.json()).toEqual({ settled: true });
    expect(await rb.json()).toEqual({ settled: true });
    expect(h.counts).toEqual({ stop: 1, remove: 1, start: 0 });
    expect(h.emitted).toEqual([s.id]);
  });

  test("a settle running while the operator archives or clears it: one teardown", async () => {
    for (const other of ["delete", "clear-merged"] as const) {
      const h = harness({ gated: true });
      const s = h.child();
      const settling = h.post(s.id, { prNumber: 3955 });
      await h.entered();
      const second =
        other === "delete"
          ? h.app.fetch(
              new Request(`${ORIGIN}/api/sessions/${s.id}`, {
                method: "DELETE",
                headers: { Origin: ORIGIN },
              }),
            )
          : h.app.fetch(
              new Request(`${ORIGIN}/api/sessions/clear-merged`, {
                method: "POST",
                headers: { "content-type": "application/json", Origin: ORIGIN },
                body: JSON.stringify({ ids: [s.id] }),
              }),
            );
      h.release();
      expect((await settling).status).toBe(200);
      expect((await second).status).toBe(200);
      expect({ other, counts: h.counts }).toEqual({
        other,
        counts: { stop: 1, remove: 1, start: 0 },
      });
      expect(h.store.get(s.id)?.status).toBe("archived");
    }
  });

  test("while the settle's archive runs, reply/resume/shelve answer 409 session_closing", async () => {
    const h = harness({ gated: true });
    const s = h.child();
    const settling = h.post(s.id, { prNumber: 3955 });
    await h.entered();
    for (const [path, body] of [
      ["reply", { text: "go on" }],
      ["resume", {}],
      ["shelve", { shelved: true }],
    ] as const) {
      const res = await h.post(s.id, body, path);
      expect({ path, status: res.status }).toEqual({ path, status: 409 });
      expect((await res.json()).code).toBe("session_closing");
    }
    h.release();
    expect((await settling).status).toBe(200);
    expect(h.counts.start).toBe(0);
    expect(h.store.get(s.id)?.shelved).toBeFalsy();
  });

  test("resumed or shelved between the forge read and the archive: refused, nothing lost", async () => {
    for (const change of ["resumed", "shelved"] as const) {
      const h = harness();
      const s = h.child();
      const open = h.holdMeta();
      const settling = h.post(s.id, { prNumber: 3955 });
      await Promise.resolve();
      if (change === "resumed") h.store.update(s.id, { status: "running" });
      else h.store.setShelved(s.id, true);
      open();
      const res = await settling;
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe(change === "resumed" ? "busy" : "held");
      expect(h.store.get(s.id)?.status).not.toBe("archived");
      expect(h.counts).toEqual({ stop: 0, remove: 0, start: 0 });
      expect(h.materialized).toEqual([]);
      expect(h.emitted).toEqual([]);
      expect(h.retained).toEqual([]);
    }
  });
});

describe("restRefusal", () => {
  test("only an idle or done session that is not held may be archived", () => {
    const base = { status: "done", shelved: false, usagePause: null } as any;
    expect(restRefusal(base)).toBeNull();
    expect(restRefusal({ ...base, status: "idle" })).toBeNull();
    expect(restRefusal({ ...base, status: "running" })).toBe("busy");
    expect(restRefusal({ ...base, status: "blocked" })).toBe("busy");
    expect(restRefusal({ ...base, shelved: true })).toBe("held");
    expect(restRefusal({ ...base, usagePause: { phase: "paused" } })).toBe("held");
  });
});
