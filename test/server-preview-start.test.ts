import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { SessionPreviewState } from "../src/types";

// Minimal harness: real SessionStore (in-memory) + injected service/preview spies.
function harness(
  serviceOverride: Partial<AppDeps["service"]> = {},
  previewSnapshot: Record<string, SessionPreviewState> = {},
): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: serviceOverride as AppDeps["service"],
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: { snapshot: () => previewSnapshot },
  };
  return { app: makeApp(deps), store };
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Create a session in the store so the handler can resolve its worktreePath.
function makeSession(store: SessionStore, worktreePath = "/wt/test"): string {
  const s = store.create({
    name: "preview-test",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/preview-test",
    worktreePath,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_p",
  });
  return s.id;
}

// ── POST /api/sessions/:id/preview/start ──────────────────────────────────────

test("preview/start: already_bound → 409, detectDevCommand/startPreview NOT called", async () => {
  let startPreviewCalled = false;
  const store = new SessionStore(":memory:");
  const id = makeSession(store);
  // Pre-populate snapshot with this session already bound
  const previewSnap: Record<string, SessionPreviewState> = { [id]: { previewPort: 9999 } };
  const deps: AppDeps = {
    store,
    service: {
      startPreview: () => {
        startPreviewCalled = true;
        return true;
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: { snapshot: () => previewSnap },
  };
  const app = makeApp(deps);

  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "bun run dev" }),
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("already_bound");
  expect(startPreviewCalled).toBe(false);
});

test("preview/start: command_unknown → 409 when no command in body and detectDevCommand returns null", async () => {
  // Use a session with a worktreePath that has no package.json (real fs won't find one
  // at a non-existent path — detectDevCommand returns null).
  const { app, store } = harness({ startPreview: () => true }, {});
  const id = makeSession(store, "/nonexistent/path/12345");
  const res = await app.fetch(postJson(`/api/sessions/${id}/preview/start`, {}));
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("command_unknown");
});

test("preview/start: success → 200 {ok, command} when command provided in body", async () => {
  const calls: { id: string; command: string }[] = [];
  const { app, store } = harness(
    {
      startPreview: (id: string, command: string) => {
        calls.push({ id, command });
        return true;
      },
    },
    {},
  );
  const id = makeSession(store);
  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "bun run dev" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; command: string };
  expect(body.ok).toBe(true);
  expect(body.command).toBe("bun run dev");
  expect(calls).toEqual([{ id, command: "bun run dev" }]);
});

test("preview/start: dead pane → 404 when startPreview returns false", async () => {
  const { app, store } = harness({ startPreview: () => false }, {});
  const id = makeSession(store);
  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "bun run dev" }),
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not found");
});

test("preview/start: unknown session id → 404", async () => {
  const { app } = harness({ startPreview: () => true }, {});
  const res = await app.fetch(
    postJson("/api/sessions/ghost-id/preview/start", { command: "bun run dev" }),
  );
  expect(res.status).toBe(404);
});

test("preview/start: missing content-type → 415", async () => {
  const { app, store } = harness({ startPreview: () => true }, {});
  const id = makeSession(store);
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${id}/preview/start`, {
      method: "POST",
      body: JSON.stringify({ command: "bun run dev" }),
    }),
  );
  expect(res.status).toBe(415);
});
