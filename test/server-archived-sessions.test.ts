// Archived sessions stay reachable (#2590): `GET /api/sessions/archived` lists every one, and the
// bare `GET /api/sessions/{id}` also resolves a designation (`TASK-07`, `7`), archived included.
import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { Session } from "../src/types";

function harness() {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  };
  const mk = (name: string) =>
    store.create({
      name,
      prompt: "go",
      repoPath: "/repo",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/repo/${name}`,
      isolated: true,
      herdrSession: `sess-${name}`,
      herdrAgentId: `term_${name}`,
      claudeSessionId: `claude-${name}`,
      model: null,
    });
  return { app: makeApp(deps), store, mk };
}

test("GET /api/sessions/archived lists every archived session newest-first, no live ones", async () => {
  const { app, store, mk } = harness();
  const live = mk("live");
  const a = mk("old");
  store.archive(a.id);
  await Bun.sleep(2); // distinct archivedAt so the order is deterministic
  const b = mk("new");
  store.archive(b.id);

  const res = await app.fetch(new Request("http://x/api/sessions/archived"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Session[];
  expect(body.map((s) => s.id)).toEqual([b.id, a.id]);
  expect(body.every((s) => s.status === "archived" && typeof s.archivedAt === "number")).toBe(true);
  expect(body.map((s) => s.id)).not.toContain(live.id);
});

test("GET /api/sessions/{designation} finds an archived session", async () => {
  const { app, store, mk } = harness();
  const s = mk("gone");
  store.archive(s.id);

  for (const key of [s.desig, s.desig.toLowerCase(), String(Number(s.desig.split("-")[1]))]) {
    const res = await app.fetch(new Request(`http://x/api/sessions/${key}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session;
    expect(body.id).toBe(s.id);
    expect(body.archivedAt).toBeNumber();
  }
  const missing = await app.fetch(new Request("http://x/api/sessions/TASK-99999"));
  expect(missing.status).toBe(404);
});
