import { test, expect } from "bun:test";
import { releaseHeldTasks, type HeldReleaseDeps } from "../src/held-release";
import type { CreateSessionInput, Session } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";

// Minimal Session stub — these tests only ever read `.id` off the created session
// (it's the session:new payload), so a full literal would be noise.
const fakeSession = (id: string) => ({ id }) as unknown as Session;

function makeInput(prompt: string, issueNumber?: number): CreateSessionInput {
  return {
    repoPath: "/tmp/repo",
    baseBranch: "main",
    prompt,
    model: null,
    images: [],
    ...(issueNumber
      ? { issueRef: { number: issueNumber, url: "http://x/i", title: "t", body: "" } }
      : {}),
  };
}

function makeDeps(
  tasks: { id: string; input: CreateSessionInput }[],
  limits: Partial<UsageLimits> = {},
  createFn?: (input: CreateSessionInput) => Promise<Session>,
): HeldReleaseDeps & {
  emitted: { event: string; data: unknown }[];
  creates: CreateSessionInput[];
  labeled: number[];
} {
  const rows = tasks.map((t, i) => ({ ...t, repoPath: "/tmp/repo", createdAt: i + 1 }));
  const emitted: { event: string; data: unknown }[] = [];
  const creates: CreateSessionInput[] = [];
  const labeled: number[] = [];

  const defaultLimits: UsageLimits = {
    session5h: null,
    week: null,
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
    ...limits,
  };

  return {
    store: {
      listHeldTasks: () => [...rows],
      removeHeldTask: (id: string) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i !== -1) rows.splice(i, 1);
      },
      countHeldTasks: () => rows.length,
    },
    service: {
      async create(input: CreateSessionInput): Promise<Session> {
        if (createFn) return createFn(input);
        creates.push(input);
        return fakeSession("fake-session");
      },
    },
    usageLimits: { limits: () => defaultLimits },
    events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) },
    resolveForge: () =>
      ({
        async addIssueLabel(n: number) {
          labeled.push(n);
        },
      }) as unknown as import("../src/forge/types").GitForge,
    emitted,
    creates,
    labeled,
  };
}

// Flush the setTimeout(0) macrotask the claim-stamp is deferred onto.
const flush = () => new Promise((r) => setTimeout(r, 0));

// ── held-release tests ────────────────────────────────────────────────────────

test("usage high (>=holdPct) + enabled → released:0, service not called", async () => {
  const deps = makeDeps([{ id: "t1", input: makeInput("task 1") }], {
    session5h: { pct: 85, resetAt: 0 },
    week: null,
  });

  const result = await releaseHeldTasks(deps, { enabled: true, holdPct: 80 }, Date.now());
  expect(result.released).toBe(0);
  expect(deps.creates).toHaveLength(0);
  expect(deps.emitted).toHaveLength(0);
});

test("usage low + 3 held → releases all 3 FIFO", async () => {
  const creates: CreateSessionInput[] = [];
  const tasks = [
    { id: "t1", input: makeInput("task 1") },
    { id: "t2", input: makeInput("task 2") },
    { id: "t3", input: makeInput("task 3") },
  ];

  const deps = makeDeps(
    tasks,
    { session5h: { pct: 30, resetAt: 0 }, week: null },
    async (input) => {
      creates.push(input);
      return fakeSession("fake");
    },
  );

  const result = await releaseHeldTasks(deps, { enabled: true, holdPct: 80 }, Date.now(), 10);
  expect(result.released).toBe(3);
  expect(creates).toHaveLength(3);
  expect(creates[0]!.prompt).toBe("task 1");
  expect(creates[1]!.prompt).toBe("task 2");
  expect(creates[2]!.prompt).toBe("task 3");
  expect(deps.store.countHeldTasks()).toBe(0);
  expect(deps.emitted.some((e) => e.event === "held:changed")).toBe(true);
  // each released task surfaces in the Herd via session:new (one per release)
  expect(deps.emitted.filter((e) => e.event === "session:new")).toHaveLength(3);
});

test("5 held, maxPerTick=2 → only 2 released, 3 remain", async () => {
  const tasks = [
    { id: "t1", input: makeInput("task 1") },
    { id: "t2", input: makeInput("task 2") },
    { id: "t3", input: makeInput("task 3") },
    { id: "t4", input: makeInput("task 4") },
    { id: "t5", input: makeInput("task 5") },
  ];

  const deps = makeDeps(tasks, {
    session5h: { pct: 20, resetAt: 0 },
    week: null,
  });

  const result = await releaseHeldTasks(deps, { enabled: true, holdPct: 80 }, Date.now(), 2);
  expect(result.released).toBe(2);
  expect(deps.store.countHeldTasks()).toBe(3);
});

test("service.create throws on 2nd → 1 released, loop stops, rows intact", async () => {
  let callCount = 0;
  const tasks = [
    { id: "t1", input: makeInput("task 1") },
    { id: "t2", input: makeInput("task 2") },
    { id: "t3", input: makeInput("task 3") },
  ];
  const deps = makeDeps(tasks, { session5h: { pct: 20, resetAt: 0 }, week: null }, async () => {
    callCount++;
    if (callCount === 2) throw new Error("spawn failed");
    return fakeSession("fake");
  });

  const result = await releaseHeldTasks(deps, { enabled: true, holdPct: 80 }, Date.now(), 10);
  expect(result.released).toBe(1);
  // row for t1 removed, t2 and t3 still in the list (t2 failed → loop breaks; t3 untouched)
  expect(deps.store.countHeldTasks()).toBe(2);
  // held:changed emitted for the 1 successful release
  expect(deps.emitted.some((e) => e.event === "held:changed")).toBe(true);
});

test("disabled + tasks present → releases them (below-threshold behavior)", async () => {
  const tasks = [
    { id: "t1", input: makeInput("task 1") },
    { id: "t2", input: makeInput("task 2") },
  ];
  const deps = makeDeps(tasks, {
    session5h: { pct: 95, resetAt: 0 },
    week: null,
  });

  // disabled: ignore usage, release anyway
  const result = await releaseHeldTasks(deps, { enabled: false, holdPct: 80 }, Date.now(), 10);
  expect(result.released).toBe(2);
  expect(deps.store.countHeldTasks()).toBe(0);
});

test("released task with linked issue → re-stamps the drain claim", async () => {
  const deps = makeDeps(
    [
      { id: "t1", input: makeInput("linked", 42) },
      { id: "t2", input: makeInput("unlinked") },
    ],
    { session5h: { pct: 20, resetAt: 0 }, week: null },
  );

  const result = await releaseHeldTasks(deps, { enabled: true, holdPct: 80 }, Date.now(), 10);
  await flush();
  expect(result.released).toBe(2);
  // only the issue-linked task stamps ACTIVE_LABEL (one claim, for #42)
  expect(deps.labeled).toEqual([42]);
});
