import { test, expect } from "bun:test";
import { makeApp } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { EGRESS_MUTED_DEFAULTS } from "../src/egress-settings";

// Global egress settings: standard allowed hosts, their default, and muted hosts.

function setup() {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const emitted: unknown[] = [];
  events.subscribe((e, d) => {
    if (e === "settings:egress") emitted.push(d);
  });
  const reapplied: string[] = [];
  const app = makeApp({
    store,
    service: { reapplyEgressAllowlist: async (repo: string) => void reapplied.push(repo) } as any,
    events,
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => null,
  });
  const req = (method: string, body?: unknown) =>
    app.fetch(
      new Request("http://localhost:7330/api/settings", {
        method,
        headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { store, req, emitted, reapplied };
}

test("GET returns an empty standard list, default off, seeded mutes", async () => {
  const { req } = setup();
  expect(await (await req("GET")).json()).toMatchObject({
    egressStandardHosts: [],
    egressStandardDefault: false,
    egressMutedHosts: [...EGRESS_MUTED_DEFAULTS],
  });
});

test("PUT validates, normalizes, dedupes and persists the lists", async () => {
  const { req, emitted } = setup();
  expect((await req("PUT", { egressMutedHosts: ["ph.varlock.dev:443"] })).status).toBe(400);
  expect((await req("PUT", { egressMutedHosts: ["nodot"] })).status).toBe(400);
  expect((await req("PUT", { egressStandardHosts: "x.dev" })).status).toBe(400);
  expect((await req("PUT", { egressStandardDefault: "yes" })).status).toBe(400);

  const r = await req("PUT", {
    egressStandardHosts: ["CDN.playwright.dev", "cdn.playwright.dev", "r.dev:8443"],
  });
  expect(r.status).toBe(200);
  expect((await r.json()).egressStandardHosts).toEqual(["cdn.playwright.dev", "r.dev:8443"]);
  expect((await req("PATCH", { egressMutedHosts: [] })).status).toBe(200);
  expect(await (await req("GET")).json()).toMatchObject({
    egressStandardHosts: ["cdn.playwright.dev", "r.dev:8443"],
    egressMutedHosts: [],
  });
  expect(emitted).toHaveLength(2);
});

test("standard changes reapply every repo with active sessions; mutes reapply nothing", async () => {
  const { store, req, reapplied } = setup();
  const mk = (repoPath: string) =>
    store.create({
      name: "s",
      prompt: "x",
      repoPath,
      baseBranch: "main",
      branch: null,
      worktreePath: repoPath,
      isolated: false,
      herdrSession: "default",
      herdrAgentId: "term",
    } as any);
  mk("/a");
  mk("/a");
  mk("/b");
  expect((await req("PUT", { egressStandardDefault: true })).status).toBe(200);
  await Bun.sleep(0);
  expect(reapplied.sort()).toEqual(["/a", "/b"]);
  reapplied.length = 0;
  expect((await req("PUT", { egressMutedHosts: ["ph.varlock.dev"] })).status).toBe(200);
  await Bun.sleep(0);
  expect(reapplied).toEqual([]);
});
