import { expect, test } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { SteeringReportService, type SteeringEvent } from "../src/steering";
import type { SteeringMessages, SteeringReport } from "../src/steering-core";
import type { Session } from "../src/types";

const DAY = 86_400_000;
const NOW = 100 * DAY;

/** An auto session archived in the window: no typed prompt and no operator steer, so the run
 *  settles `empty` without spawning a helper. */
const autoSession = {
  id: "s1",
  desig: "TASK-1",
  prompt: "drain issue #1",
  repoPath: "/repo/app",
  auto: true,
  issueNumber: 1,
  scheduleId: null,
  landingRepair: false,
  terminal: false,
  archiveReason: "merged",
  createdAt: NOW - 2 * DAY,
  settledAt: NOW - 2 * DAY + DAY / 8,
  archivedAt: NOW - 2 * DAY + DAY / 6,
} as Session;

function harness(stored: SteeringReport[] = []) {
  const reports: SteeringReport[] = [...stored];
  const settings = new Map<string, string>();
  const newest = (trigger?: string) =>
    reports.filter((r) => !trigger || r.trigger === trigger).toReversed();
  const events: SteeringEvent[] = [];
  let release!: (m: SteeringMessages) => void;
  const read = new Promise<SteeringMessages>((r) => (release = r));
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const steering = new SteeringReportService({
    store: {
      listArchivedSessions: () => [autoSession],
      insertSteeringReport: (r) => void reports.push(r),
      latestSteeringReport: (trigger) => newest(trigger)[0] ?? null,
      listSteeringReports: (trigger) => newest(trigger),
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => void settings.set(k, v),
    },
    readMessages: () => read,
    herdr: {
      start: async () => {
        throw new Error("no helper expected");
      },
      stop: async () => {},
    } as never,
    env: () => ({ provider: "claude", model: "sonnet", effort: null }) as never,
    now: () => NOW,
    emit: (e) => {
      events.push(e);
      if (!e.running) finished();
    },
  });
  const deps: AppDeps = {
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    steering,
  };
  return { app: makeApp(deps), events, release, done };
}

const get = (app: ReturnType<typeof makeApp>) =>
  app.fetch(new Request("http://x/api/steering/report"));
const run = (app: ReturnType<typeof makeApp>) =>
  app.fetch(new Request("http://x/api/steering/report/run", { method: "POST" }));

const seen = (app: ReturnType<typeof makeApp>) =>
  app.fetch(new Request("http://x/api/steering/report/seen", { method: "POST" }));

test("steering seen route clears the weekly digest's unread flag", async () => {
  const weekly: SteeringReport = {
    id: "w1",
    createdAt: NOW - DAY,
    windowStart: NOW - 8 * DAY,
    windowEnd: NOW - DAY,
    trigger: "weekly",
    status: "ok",
    error: null,
    model: null,
    sample: null,
    sessions: [],
    labels: { prompts: [], steers: [], findings: [], examples: [] },
    tables: null,
  };
  const h = harness([weekly]);
  const before = (await (await get(h.app)).json()) as { unread: boolean; trend: unknown[] };
  expect(before.unread).toBe(true);
  expect(before.trend).toHaveLength(1);
  const res = await seen(h.app);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ unread: false });
  expect(((await (await get(h.app)).json()) as { unread: boolean }).unread).toBe(false);
  const wrongMethod = await h.app.fetch(new Request("http://x/api/steering/report/seen"));
  expect(wrongMethod.status).not.toBe(200);
});

test("steering routes drive the real service: 202, 409 while in flight, then the report", async () => {
  const h = harness();
  expect(await (await get(h.app)).json()).toEqual({
    running: false,
    report: null,
    trend: [],
    unread: false,
  });

  const started = await run(h.app);
  expect(started.status).toBe(202);
  expect(await started.json()).toEqual({ running: true });
  expect(await (await get(h.app)).json()).toMatchObject({ running: true, report: null });

  const busy = await run(h.app);
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ error: "already running", running: true });

  h.release({ messages: [], unavailable: null });
  await h.done;
  const body = (await (await get(h.app)).json()) as { running: boolean; report: SteeringReport };
  expect(body.running).toBe(false);
  expect(body.report).toMatchObject({ trigger: "manual", status: "empty", labels: null });
  expect(h.events).toEqual([
    { running: true },
    { running: false, id: body.report.id, status: body.report.status },
  ]);
});

test("steering routes answer 503 when the service is unwired; other methods fall through", async () => {
  const app = makeApp({
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  });
  expect((await get(app)).status).toBe(503);
  expect((await run(app)).status).toBe(503);
  expect((await seen(app)).status).toBe(503);
  const wrongMethod = await app.fetch(
    new Request("http://x/api/steering/report", { method: "POST" }),
  );
  expect(wrongMethod.status).not.toBe(503);
});
