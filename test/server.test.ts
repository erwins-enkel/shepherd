import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";

function harness() {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "tank/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
    } as any,
  });
  return makeApp({ store, service, events });
}

test("POST /api/sessions creates, GET lists", async () => {
  const app = harness();
  const post = await app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      body: JSON.stringify({ repoPath: "/r", baseBranch: "main", prompt: "go" }),
    }),
  );
  expect(post.status).toBe(201);
  const created = await post.json();
  expect(created.desig).toBe("UNIT-01");

  const list = await (await app.fetch(new Request("http://x/api/sessions"))).json();
  expect(list.length).toBe(1);
});

test("DELETE /api/sessions/:id archives", async () => {
  const app = harness();
  const created = await (
    await app.fetch(
      new Request("http://x/api/sessions", {
        method: "POST",
        body: JSON.stringify({ repoPath: "/r", baseBranch: "main", prompt: "go" }),
      }),
    )
  ).json();
  const del = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}`, { method: "DELETE" }),
  );
  expect(del.status).toBe(200);
});
