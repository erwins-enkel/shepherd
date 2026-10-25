import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { GitState } from "../src/forge/types";

function harness(git: Record<string, GitState> = {}) {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    prCache: { get: (id: string) => git[id], snapshot: () => git } as any,
  };
  return { app: makeApp(deps), store };
}

const create = (store: SessionStore, name: string) =>
  store.create({
    name,
    prompt: "p",
    repoPath: "/nonexistent/repo",
    baseBranch: "main",
    branch: `shepherd/${name}`,
    worktreePath: "/nonexistent/repo",
    isolated: false,
    herdrSession: "h",
    herdrAgentId: `agent-${name}`,
    claudeSessionId: "",
    model: null,
  });

test("GET /api/sessions and /api/sessions/:id carry the derived phase (#2586)", async () => {
  const git: Record<string, GitState> = {};
  const { app, store } = harness(git);
  const running = create(store, "running");
  store.update(running.id, { status: "running" });
  const atRest = create(store, "rest");
  store.update(atRest.id, { status: "done" });
  git[atRest.id] = { kind: "github", state: "open", checks: "none", deployConfigured: false };
  const gone = create(store, "gone");
  store.archive(gone.id);

  const list = await (await app.fetch(new Request("http://x/api/sessions"))).json();
  const phases = Object.fromEntries(
    list.map((r: { id: string; phase: string }) => [r.id, r.phase]),
  );
  expect(phases).toEqual({ [running.id]: "working", [atRest.id]: "pr_open" });

  const show = async (id: string) =>
    (await (await app.fetch(new Request(`http://x/api/sessions/${id}`))).json()).phase;
  expect(await show(atRest.id)).toBe("pr_open");
  expect(await show(gone.id)).toBe("finished");
});
