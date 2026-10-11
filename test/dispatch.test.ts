import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { payloadHash } from "../src/dispatch";
import { releaseHeldTasks } from "../src/held-release";
import type { Session, StandardCreateInput } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";

// Idempotent acceptance of POST /api/sessions (#2761) through the real route, with a fake service
// that writes a REAL session row — a replay reads the session back from the store.

let tmpRoot: string;
let repoDir: string;
let savedEnabled: boolean;
let savedPct: number;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-dispatch-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  savedEnabled = config.usageHoldEnabled;
  savedPct = config.usageHoldPct;
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  config.usageHoldEnabled = savedEnabled;
  config.usageHoldPct = savedPct;
});

interface Harness {
  app: ReturnType<typeof makeApp>;
  deps: AppDeps;
  store: SessionStore;
  creates: StandardCreateInput[];
  /** Set to make every create wait until it resolves. */
  gate: { wait: Promise<void> | null };
  /** Set to make the next creates throw. */
  fail: { error: Error | null };
  usage: { pct: number };
}

function harness(store = new SessionStore(":memory:"), creates: StandardCreateInput[] = []) {
  const h = {
    store,
    creates,
    gate: { wait: null },
    fail: { error: null },
    usage: { pct: 0 },
  } as Omit<Harness, "app" | "deps">;
  const limits = (): UsageLimits => ({
    session5h: { pct: h.usage.pct, resetAt: 0 },
    week: null,
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
  });
  const service = {
    async create(input: StandardCreateInput): Promise<Session> {
      creates.push(input);
      if (h.gate.wait) await h.gate.wait;
      if (h.fail.error) throw h.fail.error;
      return store.create({
        name: `task-${creates.length}`,
        prompt: input.prompt,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: null,
        worktreePath: input.repoPath,
        isolated: false,
        herdrSession: "default",
        herdrAgentId: `term_${creates.length}`,
      });
    },
  };
  const deps: AppDeps = {
    store,
    service: service as any,
    events: new EventHub(),
    usageLimits: { limits } as any,
  };
  return { ...h, deps, app: makeApp(deps) } as Harness;
}

const body = (extra: Record<string, unknown> = {}) => ({
  repoPath: repoDir,
  baseBranch: "main",
  prompt: "do something",
  model: null,
  images: [],
  ...extra,
});

function post(h: Harness, key: string | null, extra?: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["Idempotency-Key"] = key;
  return h.app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(body(extra)),
    }),
  );
}

const call = (h: Harness, method: string, path: string) =>
  h.app.fetch(new Request(`http://x${path}`, { method }));

async function dispatch(h: Harness, key: string) {
  const res = await call(h, "GET", `/api/dispatches/${key}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("two concurrent requests with the same key create exactly one session", async () => {
  const h = harness();
  let release!: () => void;
  h.gate.wait = new Promise<void>((r) => (release = r));

  const first = post(h, "k-concurrent");
  const second = post(h, "k-concurrent");
  await Bun.sleep(10); // both requests are in: the first is spawning, the second is waiting on it
  expect(h.creates).toHaveLength(1);
  expect((await dispatch(h, "k-concurrent")).body.state).toBe("pending");

  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const [sa, sb] = [(await a.json()) as Session, (await b.json()) as Session];
  expect(sb.id).toBe(sa.id);
  expect(a.headers.get("Idempotent-Replayed")).toBeNull();
  expect(b.headers.get("Idempotent-Replayed")).toBe("true");
  expect(h.creates).toHaveLength(1);
  expect(h.store.list()).toHaveLength(1);
  expect((await dispatch(h, "k-concurrent")).body).toMatchObject({
    id: "k-concurrent",
    state: "started",
    sessionId: sa.id,
  });
});

test("a retry after a restart replays the session instead of starting another", async () => {
  const dbPath = join(tmpRoot, "shepherd.db");
  const creates: StandardCreateInput[] = [];
  const before = harness(new SessionStore(dbPath), creates);
  const first = await post(before, "k-restart");
  expect(first.status).toBe(201);
  const created = (await first.json()) as Session;

  // A fresh store + app on the same database file: everything in-process is gone.
  const after = harness(new SessionStore(dbPath), creates);
  const retry = await post(after, "k-restart");
  expect(retry.status).toBe(201);
  expect(((await retry.json()) as Session).id).toBe(created.id);
  expect(creates).toHaveLength(1);
  expect((await dispatch(after, "k-restart")).body).toMatchObject({
    state: "started",
    sessionId: created.id,
  });
});

test("a key whose start was cut off by a restart reports failed and never starts", async () => {
  const dbPath = join(tmpRoot, "shepherd.db");
  // The previous process reserved the key, then died before learning the outcome.
  new SessionStore(dbPath).reserveDispatch({
    id: "k-cut",
    payloadHash: payloadHash(body()),
    repoPath: repoDir,
    now: 1,
  });
  const h = harness(new SessionStore(dbPath));
  expect(await dispatch(h, "k-cut")).toEqual({
    status: 200,
    body: expect.objectContaining({ state: "failed", code: "dispatch_interrupted" }),
  });
  const retry = await post(h, "k-cut");
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({ code: "dispatch_interrupted" });
  expect(h.creates).toHaveLength(0);
});

test("the same key with a different body is refused 409 and starts nothing", async () => {
  const h = harness();
  expect((await post(h, "k-mismatch")).status).toBe(201);
  const other = await post(h, "k-mismatch", { prompt: "something else" });
  expect(other.status).toBe(409);
  expect(await other.json()).toMatchObject({ code: "dispatch_payload_mismatch" });
  expect(other.headers.get("Idempotent-Replayed")).toBeNull();
  expect(h.creates).toHaveLength(1);
  // key order is not part of "the same body"
  const reordered = await h.app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "k-mismatch" },
      body: JSON.stringify(Object.fromEntries(Object.entries(body()).reverse())),
    }),
  );
  expect(reordered.status).toBe(201);
  expect(h.creates).toHaveLength(1);
});

test("a failed start is final for its key: the retry replays the failure", async () => {
  const h = harness();
  h.fail.error = new Error("herdr exploded");
  const first = await post(h, "k-fail");
  expect(first.status).toBe(502);
  h.fail.error = null;
  const retry = await post(h, "k-fail");
  expect(retry.status).toBe(502);
  expect(await retry.json()).toEqual({ error: "herdr exploded" });
  expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
  expect(h.creates).toHaveLength(1);
  expect((await dispatch(h, "k-fail")).body).toMatchObject({
    state: "failed",
    reason: "herdr exploded",
  });
});

test("a held dispatch reports held, replays the hold, and turns started on release", async () => {
  const h = harness();
  h.usage.pct = 95;
  const res = await post(h, "k-held");
  expect(res.status).toBe(200);
  const { id: heldId } = (await res.json()) as { id: string };
  expect((await dispatch(h, "k-held")).body).toMatchObject({ state: "held", heldId });

  const again = await post(h, "k-held");
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ held: true, id: heldId });
  expect(h.store.countHeldTasks()).toBe(1);

  const spawned = await call(h, "POST", `/api/held/${heldId}/spawn`);
  expect(spawned.status).toBe(201);
  const session = (await spawned.json()) as Session;
  expect((await dispatch(h, "k-held")).body).toMatchObject({
    state: "started",
    sessionId: session.id,
    heldId,
  });
  // …and a retry now answers with that session.
  const later = await post(h, "k-held");
  expect(later.status).toBe(201);
  expect(((await later.json()) as Session).id).toBe(session.id);
  expect(h.creates).toHaveLength(1);
});

test("the release sweep and a discard settle held dispatches too", async () => {
  const h = harness();
  h.usage.pct = 95;
  expect((await post(h, "k-swept")).status).toBe(200);
  const discarded = (await (await post(h, "k-dropped", { prompt: "other" })).json()) as {
    id: string;
  };
  expect((await call(h, "DELETE", `/api/held/${discarded.id}`)).status).toBe(200);
  expect((await dispatch(h, "k-dropped")).body).toMatchObject({
    state: "failed",
    code: "held_discarded",
  });

  await releaseHeldTasks(
    {
      store: h.store,
      service: h.deps.service,
      usageLimits: h.deps.usageLimits,
      events: h.deps.events,
    },
    { enabled: false, holdPct: 80, autoRelease: true },
    Date.now(),
  );
  const swept = await dispatch(h, "k-swept");
  expect(swept.body.state).toBe("started");
  expect(h.store.get(swept.body.sessionId as string)).not.toBeNull();
});

test("DELETE reserves an unknown key as cancelled, so a late arrival never starts", async () => {
  const h = harness();
  const del = await call(h, "DELETE", "/api/dispatches/k-cancel");
  expect(del.status).toBe(200);
  expect(await del.json()).toMatchObject({ state: "failed", code: "dispatch_canceled" });
  expect((await call(h, "DELETE", "/api/dispatches/k-cancel")).status).toBe(200);

  const late = await post(h, "k-cancel");
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ code: "dispatch_canceled" });
  expect(h.creates).toHaveLength(0);
  expect(h.store.list()).toHaveLength(0);

  // Once a key has arrived it can no longer be withdrawn here.
  expect((await post(h, "k-arrived")).status).toBe(201);
  const tooLate = await call(h, "DELETE", "/api/dispatches/k-arrived");
  expect(tooLate.status).toBe(409);
  expect(await tooLate.json()).toMatchObject({
    code: "dispatch_arrived",
    dispatch: { state: "started" },
  });
});

test("without a key every request creates, exactly as before", async () => {
  const h = harness();
  expect((await post(h, null)).status).toBe(201);
  expect((await post(h, null)).status).toBe(201);
  expect(h.creates).toHaveLength(2);
});

test("keys are validated; an sf-string (quoted) key is accepted", async () => {
  const h = harness();
  const bad = await post(h, "not a key!");
  expect(bad.status).toBe(400);
  expect(h.creates).toHaveLength(0);
  expect((await post(h, '"k-quoted"')).status).toBe(201);
  expect((await dispatch(h, "k-quoted")).body.state).toBe("started");

  expect((await call(h, "GET", "/api/dispatches/never-sent")).status).toBe(404);
  expect((await call(h, "GET", "/api/dispatches/-bad")).status).toBe(400);
  expect((await call(h, "DELETE", "/api/dispatches/-bad")).status).toBe(400);
});
