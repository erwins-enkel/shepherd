/** `schedule_noop` through the real MCP route (#3469): the no-op archive does the same fan-out as
 *  the operator's archive — PR-cache drop + `session:archived` — with archive reason `noop`. */
import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { makeApp, type AppDeps } from "../src/server";
import { EventHub } from "../src/events";

test("schedule_noop archives with reason noop, drops the PR cache and emits session:archived", async () => {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const emitted: string[] = [];
  const origEmit = events.emit.bind(events);
  events.emit = ((event: string, data: unknown) => {
    emitted.push(`${event}:${JSON.stringify(data)}`);
    return origEmit(event as never, data as never);
  }) as typeof events.emit;
  const session = store.create({
    name: "triage",
    prompt: "/triage-feedback",
    repoPath: "/repo",
    baseBranch: "main",
    branch: null,
    worktreePath: "/repo",
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    scheduleId: "sch-1",
  });
  store.claimScheduleRun("sch-1", "2026-10-27T09:00", 1);
  store.settleScheduleRun("sch-1", "2026-10-27T09:00", "spawned", { sessionId: session.id });
  const archiveCalls: unknown[][] = [];
  const dropped: string[] = [];
  const deps = {
    store,
    events,
    prCache: { get: () => undefined, drop: (id: string) => dropped.push(id) },
    service: {
      spawningAgentCapabilities: () => null,
      archive: async (...args: unknown[]) => {
        archiveCalls.push(args);
        return 0;
      },
    },
  } as unknown as AppDeps;
  const res = await makeApp(deps).fetch(
    new Request(`http://x/api/sessions/${session.id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "schedule_noop", arguments: { summary: "0 open feedback items" } },
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean } };
  expect(body.result.isError).toBeUndefined();
  await new Promise((r) => setTimeout(r, 10));
  expect(archiveCalls).toEqual([[session.id, undefined, "noop"]]);
  expect(dropped).toEqual([session.id]);
  expect(emitted).toContain(`session:archived:${JSON.stringify({ id: session.id })}`);
  expect(store.getScheduleRun("sch-1", "2026-10-27T09:00")?.outcome).toBe("noop");
});
