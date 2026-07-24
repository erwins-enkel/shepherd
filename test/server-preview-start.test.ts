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
      startPreview: async () => {
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
  const { app, store } = harness({ startPreview: async () => true }, {});
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
      startPreview: async (id: string, command: string) => {
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

test("preview/start: probesUnavailable=true when the backend can't detect (#1912); start still proceeds", async () => {
  const calls: { id: string; command: string }[] = [];
  const { app, store } = harness({
    // Backend detection is dead/stale on this host.
    probeHealth: () => ({ state: "none" }),
    startPreview: async (id: string, command: string) => {
      calls.push({ id, command });
      return true;
    },
  });
  const id = makeSession(store);
  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "bun run dev" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; probesUnavailable?: boolean };
  expect(body.ok).toBe(true);
  expect(body.probesUnavailable).toBe(true);
  // The start still proceeded — a dev server has value independent of preview binding.
  expect(calls).toEqual([{ id, command: "bun run dev" }]);
});

test("preview/start: probesUnavailable absent/false when the cell is fresh", async () => {
  const { app, store } = harness({
    probeHealth: () => ({ state: "fresh" }),
    startPreview: async () => true,
  });
  const id = makeSession(store);
  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "bun run dev" }),
  );
  const body = (await res.json()) as { probesUnavailable?: boolean };
  expect(body.probesUnavailable ?? false).toBe(false);
});

test("preview/start: configured local script starts without steering the agent", async () => {
  const calls: string[] = [];
  const { store } = harness(
    {
      startPreview: async () => {
        throw new Error("agent steer must not be used");
      },
    },
    {},
  );
  const id = makeSession(store, "/wt/local-script");
  store.setRepoConfig("/r", {
    ...store.getRepoConfig("/r"),
    previewStartScript: "/git/shepherd/preview-start.sh",
    previewStartCommand: "bun run dev",
  });

  const localDeps: AppDeps = {
    store,
    service: {
      startPreview: async () => {
        throw new Error("agent steer must not be used");
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: { snapshot: () => ({}) },
    previewLauncher: {
      findDevPort: async () => null,
      scriptExists: async () => true,
      scriptPath: async () => "/git/shepherd/preview-start.sh",
      ensureScript: async () => {
        throw new Error("script already exists");
      },
      startScript: async (scriptPath, worktreePath) => {
        calls.push(`${scriptPath} @ ${worktreePath}`);
      },
    },
  };
  const localApp = makeApp(localDeps);

  const res = await localApp.fetch(postJson(`/api/sessions/${id}/preview/start`, {}));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; mode: string; command: string };
  expect(body).toMatchObject({ ok: true, mode: "local", command: "bun run dev" });
  expect(calls).toEqual(["/git/shepherd/preview-start.sh @ /wt/local-script"]);
});

test("preview/start: ignores a non-canonical stored local script path", async () => {
  const replies: { id: string; text: string }[] = [];
  let spawned = false;
  const { store } = harness();
  const id = makeSession(store, "/wt/non-canonical-script");
  store.setRepoConfig("/r", {
    ...store.getRepoConfig("/r"),
    previewStartScript: "/tmp/run-anything.sh",
    previewStartCommand: "bun run dev",
  });

  const app = makeApp({
    store,
    service: {
      reply: async (sessionId: string, text: string) => {
        replies.push({ id: sessionId, text });
        return true;
      },
      startPreview: async () => {
        throw new Error("legacy start steer must not be used");
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: { snapshot: () => ({}) },
    previewLauncher: {
      findDevPort: async () => null,
      scriptExists: async () => true,
      scriptPath: async () => "/git/shepherd/preview-start.sh",
      ensureScript: async () => {
        throw new Error("setup steer should author the script");
      },
      startScript: async () => {
        spawned = true;
      },
    },
  });

  const res = await app.fetch(postJson(`/api/sessions/${id}/preview/start`, {}));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; mode: string; script: string };
  expect(body).toMatchObject({
    ok: true,
    mode: "agent_setup",
    script: "/git/shepherd/preview-start.sh",
  });
  expect(spawned).toBe(false);
  expect(replies).toHaveLength(1);
  expect(replies[0]!.text).toContain("/git/shepherd/preview-start.sh");
  expect(replies[0]!.text).not.toContain("/tmp/run-anything.sh");
  expect(store.getRepoConfig("/r").previewStartScript).toBe("/git/shepherd/preview-start.sh");
});

test("preview/start: missing local script sends one-time repo setup steer", async () => {
  const replies: { id: string; text: string }[] = [];
  let spawned = false;
  let ensured = false;
  const { store } = harness();
  const id = makeSession(store, "/wt/setup-script");

  const app = makeApp({
    store,
    service: {
      reply: async (sessionId: string, text: string) => {
        replies.push({ id: sessionId, text });
        return true;
      },
      startPreview: async () => {
        throw new Error("legacy start steer must not be used");
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: { snapshot: () => ({}) },
    previewLauncher: {
      findDevPort: async () => null,
      scriptExists: async () => false,
      scriptPath: async () => "/git/shepherd/preview-start.sh",
      ensureScript: async () => {
        ensured = true;
        return "/git/shepherd/preview-start.sh";
      },
      startScript: async () => {
        spawned = true;
      },
    },
  });

  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "cd ui && bun run dev" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; mode: string; command: string; script: string };
  expect(body).toMatchObject({
    ok: true,
    mode: "agent_setup",
    command: "cd ui && bun run dev",
    script: "/git/shepherd/preview-start.sh",
  });
  expect(replies).toHaveLength(1);
  expect(replies[0]!.id).toBe(id);
  expect(replies[0]!.text).toContain("set up this repo's local Shepherd preview script");
  expect(replies[0]!.text).toContain("/git/shepherd/preview-start.sh");
  expect(store.getRepoConfig("/r").previewStartScript).toBe("/git/shepherd/preview-start.sh");
  expect(store.getRepoConfig("/r").previewStartCommand).toBe("cd ui && bun run dev");
  expect(spawned).toBe(false);
  expect(ensured).toBe(false);
});

test("preview/start: existing dev port binds preview without spawning or steering", async () => {
  const ensured: { id: string; port: number }[] = [];
  let spawned = false;
  let steered = false;
  const { store } = harness();
  const id = makeSession(store, "/wt/running");
  const app = makeApp({
    store,
    service: {
      startPreview: async () => {
        steered = true;
        return true;
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: {
      snapshot: () => ({}),
      ensure: (sessionId, devPort) => {
        ensured.push({ id: sessionId, port: devPort });
        return 8001;
      },
    },
    previewLauncher: {
      findDevPort: async () => 5173,
      scriptExists: async () => true,
      scriptPath: async () => "/git/shepherd/preview-start.sh",
      ensureScript: async () => "/git/shepherd/preview-start.sh",
      startScript: async () => {
        spawned = true;
      },
    },
  });

  const res = await app.fetch(postJson(`/api/sessions/${id}/preview/start`, {}));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    mode: string;
    alreadyRunning: boolean;
    previewPort: number;
  };
  expect(body).toMatchObject({
    ok: true,
    mode: "local",
    alreadyRunning: true,
    previewPort: 8001,
  });
  expect(ensured).toEqual([{ id, port: 5173 }]);
  expect(spawned).toBe(false);
  expect(steered).toBe(false);
});

test("preview/start: existing dev port with no preview slot returns an error", async () => {
  let spawned = false;
  let steered = false;
  const { store } = harness();
  const id = makeSession(store, "/wt/no-slot");
  const app = makeApp({
    store,
    service: {
      startPreview: async () => {
        steered = true;
        return true;
      },
    } as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    preview: {
      snapshot: () => ({}),
      ensure: () => null,
    },
    previewLauncher: {
      findDevPort: async () => 5173,
      scriptExists: async () => true,
      scriptPath: async () => "/git/shepherd/preview-start.sh",
      ensureScript: async () => "/git/shepherd/preview-start.sh",
      startScript: async () => {
        spawned = true;
      },
    },
  });

  const res = await app.fetch(postJson(`/api/sessions/${id}/preview/start`, {}));
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("preview_slot_unavailable");
  expect(spawned).toBe(false);
  expect(steered).toBe(false);
});

test("preview/start: dead pane → 404 when startPreview returns false", async () => {
  const { app, store } = harness({ startPreview: async () => false }, {});
  const id = makeSession(store);
  const res = await app.fetch(
    postJson(`/api/sessions/${id}/preview/start`, { command: "bun run dev" }),
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not found");
});

test("preview/start: unknown session id → 404", async () => {
  const { app } = harness({ startPreview: async () => true }, {});
  const res = await app.fetch(
    postJson("/api/sessions/ghost-id/preview/start", { command: "bun run dev" }),
  );
  expect(res.status).toBe(404);
});

test("preview/start: missing content-type → 415", async () => {
  const { app, store } = harness({ startPreview: async () => true }, {});
  const id = makeSession(store);
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${id}/preview/start`, {
      method: "POST",
      body: JSON.stringify({ command: "bun run dev" }),
    }),
  );
  expect(res.status).toBe(415);
});
