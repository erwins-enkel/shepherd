import { expect, test } from "bun:test";
import { SessionActivityPublisher } from "../src/activity-publisher";
import { createBacklogBroadcast } from "../src/backlog-poller";
import { DrainService } from "../src/drain";
import { RemoteSessionMirror } from "../src/remote-instances/sessions";
import type { OpenSocket } from "../src/remote-instances/sessions";
import type { RemoteInstanceSummary } from "../src/remote-instances/service";
import { SessionStore } from "../src/store";
import type { BacklogPayload } from "../src/server";
import { usageEvent } from "./contract/event-fixtures";
import { activityClock } from "./helpers/activity-clock";

// Synthetic workload, not a substitute for the 180-s Moe field measurement. The opening
// snapshots warm the publishers but are excluded from both stationary byte totals.
test("180 s stationary traffic falls by at least half while full changes remain live", async () => {
  const clock = activityClock();
  const before: Record<string, { bytes: number; count: number }> = {};
  const after: Record<string, { bytes: number; count: number }> = {};
  let measuring = false;
  const record = (target: typeof before, event: string, data: unknown) => {
    if (!measuring) return;
    const bytes = Buffer.byteLength(JSON.stringify({ event, data }));
    expect(bytes).toBeLessThan(64 * 1024);
    const row = (target[event] ??= { bytes: 0, count: 0 });
    row.bytes += bytes;
    row.count++;
  };
  const activity = new SessionActivityPublisher(
    (id, activity) => record(after, "session:activity", { id, activity }),
    () => true,
    clock,
  );
  const backlog: BacklogPayload = {
    pinnedPath: "/projects/project-0",
    projects: Array.from({ length: 65 }, (_, i) => ({
      path: `/home/operator/projects/project-${i}`,
      display: `Project ${i}`,
      slug: `organization/project-${i}`,
      kind: "github",
      lastUsedAt: 1_800_000_000_000,
      recentAgentCount: 3,
      openIssues: 10,
      openPRs: 2,
      prKinds: { regular: 1, dependabot: 1, release: 0 },
      workflows: 4,
      ciStatus: "success",
      hidden: false,
      pinned: false,
      defaultBranch: "main",
      faviconUrl: "https://github.com/organization.png?size=40",
      noPrCiHold: false,
    })),
    totals: { openIssues: 650, openPRs: 130 },
  };
  const broadcast = createBacklogBroadcast(
    async () => backlog,
    (p) => record(after, "backlog:update", p),
  );
  const store = new SessionStore(":memory:");
  const repos = ["/repo/a", "/repo/b", "/repo/c"];
  for (const repo of repos)
    store.setRepoConfig(repo, { ...store.getRepoConfig(repo), autoDrainEnabled: true });
  const drain = new DrainService({
    store,
    service: {
      create: async () => {
        throw new Error("unexpected spawn");
      },
      archive: async () => 0,
    },
    resolveForge: () => null,
    prCache: { snapshot: () => ({}) },
    usage: { limits: () => usageEvent },
    repos: () => repos,
    rebaseCap: 3,
    now: clock.now,
    emitStatus: (s) => record(after, "drain:status", s),
    emitArchived: () => {},
    dropPrCache: () => {},
  });
  const machines: RemoteInstanceSummary[] = ["1", "2"].map((n) => ({
    instanceId: `00000000-0000-4000-8000-00000000000${n}`,
    name: `machine-${n}`,
    label: null,
    reportedName: "test-machine",
    url: `http://machine-${n}.test`,
    tokenHint: "test",
    createdAt: 1,
    status: "connected",
    reason: null,
    checkedAt: 1,
    lastSeenAt: 1,
    info: null,
    projects: [],
    capabilities: null,
    released: true,
  }));
  const remoteRows = Array.from({ length: 35 }, (_, i) => ({
    id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `Task ${i}`,
    desig: `TASK-${i}`,
    status: "idle",
    repoPath: `/projects/project-${i}`,
    branch: `shepherd/task-${i}`,
    worktreePath: `/projects/.worktrees/task-${i}`,
  }));
  const sockets: Parameters<OpenSocket>[2][] = [];
  const mirror = new RemoteSessionMirror({
    store: {
      getRemoteInstance: (id) => ({
        instanceId: id,
        url: machines.find((m) => m.instanceId === id)!.url,
        token: "test",
        label: null,
        reportedName: "test-machine",
        createdAt: 1,
      }),
    },
    instances: {
      list: () => machines,
      check: async () => machines[0]!,
      repoSlugs: () => new Map(),
    },
    fetch: async (url) => Response.json(url.endsWith("/api/git") ? {} : remoteRows),
    openSocket: (_url, _headers, on) => {
      sockets.push(on);
      return { close() {} };
    },
    now: clock.now,
    recheckDelaysMs: [],
  });
  mirror.subscribe((event, data) => record(after, event, data));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await broadcast();
    for (const repo of repos) await drain.pump(repo);
    for (const machine of machines) mirror.sync(machine.instanceId);
    for (const on of sockets) on.open();
    await flush();
    measuring = true;
    for (let elapsed = 500; elapsed <= 180_000; elapsed += 500) {
      clock.advance(500);
      if (elapsed % 7500 === 0) {
        const id = elapsed % 15_000 === 0 ? "a" : "b";
        const ts = 1_800_000_000_000 + elapsed;
        const signal = {
          lastActivityTs: ts,
          summary: "Read",
          recentTs: Array.from({ length: 420 }, (_, i) => ts - (419 - i) * 500),
          recentErrTs: [],
        };
        record(before, "session:activity", { id, activity: signal });
        activity.publish(id, signal);
      }
      if (elapsed % 10_000 === 0) {
        for (const status of await drain.snapshot()) record(before, "drain:status", status);
        for (const repo of repos) await drain.pump(repo);
      }
      if (elapsed % 30_000 === 0) {
        for (const machine of machines) mirror.sync(machine.instanceId);
        await flush();
        for (const machine of machines)
          record(before, "remote:sessions", {
            instanceId: machine.instanceId,
            sessions: mirror.list().filter((s) => s.host.instanceId === machine.instanceId),
          });
      }
      if (elapsed % 45_000 === 0) {
        record(before, "backlog:update", backlog);
        await broadcast();
        // The same unchanged background traffic counts on both sides, without compression.
        const plugin = { id: "example", content: "x".repeat(9500) };
        record(before, "plugin:ui", plugin);
        record(after, "plugin:ui", plugin);
      }
    }
    const total = (rows: typeof before) =>
      Object.values(rows).reduce((sum, row) => sum + row.bytes, 0);
    expect(before["session:activity"]?.count).toBe(24);
    expect(before["drain:status"]?.count).toBe(54);
    expect(after["session:activity"]).toEqual(before["session:activity"]);
    expect(after["plugin:ui"]).toEqual(before["plugin:ui"]);
    expect(after["drain:status"]).toBeUndefined();
    expect(after["backlog:update"]).toBeUndefined();
    expect(after["remote:sessions"]).toBeUndefined();
    expect(total(after)).toBeLessThanOrEqual(total(before) / 2);
    console.log(
      "Synthetic 180-s JSON bytes:",
      JSON.stringify({ before, after, reduction: 1 - total(after) / total(before) }),
    );
    // A real backlog change still sends its complete payload immediately after the idle run.
    backlog.totals.openIssues++;
    await broadcast();
    expect(after["backlog:update"]?.count).toBe(1);
  } finally {
    activity.stop();
    mirror.stop();
  }
});
