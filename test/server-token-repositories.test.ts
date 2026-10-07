import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { AccessTokenService } from "../src/access-tokens";
import { EventHub } from "../src/events";
import { makeApp, serve, type AppDeps } from "../src/server";
import type { TokenScope } from "../src/token-scopes";
import { PtyBridge, type PtySocket } from "../src/pty-bridge";
import { stagingDir } from "../src/uploads";

let root: string, a: string, b: string;
let restore: Pick<typeof config, "repoRoot" | "cookieSecret" | "token" | "host">;
let deps: AppDeps;
let sessions: ReturnType<SessionStore["create"]>[];

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-repo-boundary-"));
  a = join(root, "a");
  b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "repo-test-secret",
    token: null,
    host: "127.0.0.1",
  });
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    events,
    namer: async () => "test",
    worktree: {} as never,
    herdr: {} as never,
  });
  deps = { store, events, service, accessTokens: new AccessTokenService(store) } as AppDeps;
  sessions = [a, b].map((repoPath, i) =>
    store.create({
      name: `session-${i}`,
      prompt: "task",
      repoPath,
      baseBranch: "main",
      branch: `shepherd/${i}`,
      worktreePath: repoPath,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term-${i}`,
    }),
  );
});
afterEach(() => {
  Object.assign(config, restore);
  rmSync(root, { recursive: true, force: true });
});
const mint = (scope: TokenScope = "full", repoPaths: string[] | null = [a]) =>
  deps.accessTokens!.mint("remote", null, scope, repoPaths);
function request(token: string, path: string, method = "GET", body?: unknown) {
  return makeApp(deps).fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

test("repo boundary: filters discovery, snapshots and held tasks without foreign IDs", async () => {
  const ids = sessions.map((s) => s.id);
  deps.holds = {
    snapshot: () => Object.fromEntries(ids.map((id) => [id, { reason: id }])),
  } as never;
  deps.reviewCache = {
    reviewing: () =>
      ids.map((id) => ({ id, env: { provider: "claude", model: "opus", effort: "high" } })),
  } as never;
  for (const scope of ["read", "submit", "full"] as const) {
    const { token } = mint(scope);
    const repos = await request(token, "/api/repos");
    expect(repos.status).toBe(200);
    expect((await repos.json()).repos.map((r: { path: string }) => r.path)).toEqual([a]);
    expect(
      (await (await request(token, "/api/sessions")).json()).map((s: { id: string }) => s.id),
    ).toEqual([ids[0]]);
    expect(Object.keys(await (await request(token, "/api/holds")).json())).toEqual([ids[0]!]);
    expect(await (await request(token, "/api/reviews/inflight")).json()).toHaveLength(1);
    expect((await request(token, `/api/branches?repo=${encodeURIComponent(b)}`)).status).toBe(403);
  }
});

test("repo boundary: direct, task, socket, query and global routes cannot reach another repo", async () => {
  const { token } = mint();
  const own = sessions[0]!,
    other = sessions[1]!;
  expect((await request(token, `/api/sessions/${own.id}`)).status).toBe(200);
  for (const path of [
    `/api/sessions/${other.id}`,
    `/api/sessions/${other.id}/activity`,
    `/api/tasks/${other.desig}/export`,
    `/api/tasks/${other.id}/transcript`,
    `/pty/${other.id}`,
    `/browser-view/${other.id}`,
  ]) {
    expect((await request(token, path)).status).toBe(404);
  }
  for (const path of [
    "/api/settings",
    "/api/fs/dirs",
    "/api/backlog",
    "/api/sessions/clear-merged",
    `/api/sessions/${own.id}/hooks`,
    `/api/sessions/${own.id}/activity/extra`,
  ]) {
    expect((await request(token, path)).status).toBe(403);
  }
  expect((await request(token, "/api/halt", "POST")).status).toBe(403);
  expect((await request(token, `/api/sessions/${other.id}`, "DELETE")).status).toBe(404);
  expect(deps.store.get(other.id)?.status).not.toBe("archived");
});

test("repo boundary: read and submit cannot steer; full forwards only allowed replies", async () => {
  const reply = spyOn(deps.service, "operatorReply").mockResolvedValue(true);
  for (const scope of ["read", "submit", "full"] as const) {
    const { token } = mint(scope);
    const res = await request(token, `/api/sessions/${sessions[0]!.id}/reply`, "POST", {
      text: "continue",
    });
    expect(res.status).toBe(scope === "full" ? 200 : 403);
    const denied = await request(token, `/api/sessions/${sessions[1]!.id}/reply`, "POST", {
      text: "continue",
    });
    expect(denied.status).toBe(scope === "full" ? 404 : 403);
  }
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledWith(sessions[0]!.id, "continue");
});

test("repo boundary: create and relaunch reject foreign targets before side effects", async () => {
  const create = spyOn(deps.service, "create").mockResolvedValue(sessions[0]!);
  const relaunch = spyOn(deps.service, "relaunch").mockResolvedValue(sessions[0]!);
  const { token } = mint();
  expect(
    (
      await request(token, "/api/sessions", "POST", {
        repoPath: b,
        baseBranch: "main",
        prompt: "task",
        force: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(token, "/api/sessions", "POST", { repoPath: b, terminal: true })).status,
  ).toBe(403);
  expect(
    (await request(token, `/api/sessions/${sessions[0]!.id}/relaunch`, "POST", { repoPath: b }))
      .status,
  ).toBe(403);
  expect(create).not.toHaveBeenCalled();
  expect(relaunch).not.toHaveBeenCalled();
});

test("repo boundary: symlink aliases work but cannot be retargeted to a foreign repository", async () => {
  const alias = join(root, "alias");
  symlinkSync(a, alias);
  const { token } = mint();
  expect((await request(token, `/api/branches?repo=${encodeURIComponent(alias)}`)).status).toBe(
    200,
  );
  rmSync(alias);
  symlinkSync(b, alias);
  expect((await request(token, `/api/branches?repo=${encodeURIComponent(alias)}`)).status).toBe(
    403,
  );
  const blocked = mint("full", []);
  expect(await (await request(blocked.token, "/api/sessions")).json()).toEqual([]);
});

test("repo boundary: staged uploads are token-owned and foreign session uploads are refused", async () => {
  const { token, entry } = mint("submit");
  const upload = async (query = "") => {
    const form = new FormData();
    form.append("file", new File(["attachment"], "notes.txt"));
    return makeApp(deps).fetch(
      new Request(`http://localhost/api/uploads${query}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }),
    );
  };
  expect((await upload(`?session=${sessions[1]!.id}`)).status).toBe(404);
  const staged = await (await upload()).json();
  expect(staged.path).toContain(entry.id);
  const foreign = join(stagingDir(root), "other.txt");
  writeFileSync(foreign, "secret");
  const res = await request(token, "/api/sessions", "POST", {
    repoPath: a,
    baseBranch: "main",
    prompt: "task",
    images: [foreign],
    force: true,
  });
  expect(res.status).toBe(403);
});

function socketEvent(socket: WebSocket, name: "open" | "close"): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`socket ${name} timeout`));
      socket.close();
    }, 2000);
    socket.addEventListener(
      name,
      (event) => {
        clearTimeout(timer);
        if (name === "close" && (event as CloseEvent).code !== 1008)
          reject(new Error("expected authorization close"));
        else resolve(event);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("socket failed"));
      },
      { once: true },
    );
  });
}

test("repo boundary: live events filter foreign payloads and disconnect on a changed grant", async () => {
  const server = serve(deps, 0);
  const { token, entry } = mint("read");
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  } as never);
  try {
    const messages: unknown[] = [];
    let finish!: () => void;
    const delivered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      messages.push(message);
      if (message.data?.marker === "last") finish();
    });
    await socketEvent(ws, "open");
    deps.events.emit("session:status", { id: sessions[1]!.id, secret: "other repo" });
    deps.events.emit("unknown:event", { id: sessions[0]!.id, secret: "global" });
    deps.events.emit("held:changed", { count: 100 });
    deps.events.emit("session:status", { id: sessions[0]!.id, marker: "last" });
    await delivered;
    expect(messages).toEqual([
      { event: "terminal:owners", data: { owners: {} } },
      { event: "held:changed", data: { count: 0 } },
      { event: "session:status", data: { id: sessions[0]!.id, marker: "last" } },
    ]);
    const closed = socketEvent(ws, "close");
    deps.accessTokens!.updateRepositories(entry.id, [b]);
    await closed;
    expect((await request(token, `/api/sessions/${sessions[0]!.id}`)).status).toBe(403); // read scope still disallows individual reads
  } finally {
    ws.close();
    server.stop(true);
  }
});

test("repo boundary: formerly unrestricted sockets close on restriction and revoked sockets close", async () => {
  const server = serve(deps, 0);
  try {
    for (const revoke of [false, true]) {
      const { token, entry } = mint("full", null);
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events`, {
        headers: { Authorization: `Bearer ${token}` },
      } as never);
      await socketEvent(ws, "open");
      const closed = socketEvent(ws, "close");
      if (revoke) deps.accessTokens!.revoke(entry.id);
      else deps.accessTokens!.updateRepositories(entry.id, [a]);
      await closed;
    }
  } finally {
    server.stop(true);
  }
});

test("repo boundary: an idle token socket closes at expiry", async () => {
  let offset = 30 * 24 * 60 * 60 * 1000 - 150;
  deps.accessTokens = new AccessTokenService(deps.store, () => Date.now() - offset);
  const { token } = deps.accessTokens.mint("expiring", 30, "read", [a]);
  offset = 0;
  const server = serve(deps, 0);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  } as never);
  try {
    await socketEvent(ws, "open");
    await socketEvent(ws, "close");
  } finally {
    ws.close();
    server.stop(true);
  }
});

test("repo boundary: submit creates work in each granted repo and gates held moves", async () => {
  deps.usageLimits = { limits: () => ({ session5h: null, week: null }) } as never;
  const create = spyOn(deps.service, "create").mockImplementation(async (input) =>
    deps.store.create({
      name: "new",
      prompt: "task",
      repoPath: input.repoPath,
      baseBranch: "main",
      branch: "shepherd/new",
      worktreePath: input.repoPath,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "new-terminal",
    }),
  );
  const { token, entry } = mint("submit", [a, b]);
  for (const repoPath of [a, b]) {
    const res = await request(token, "/api/sessions", "POST", {
      repoPath,
      baseBranch: "main",
      prompt: "task",
      force: true,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).repoPath).toBe(repoPath);
  }
  expect(create).toHaveBeenCalledTimes(2);
  for (const [id, repoPath] of [
    ["held-a", a],
    ["held-b", b],
  ])
    deps.store.addHeldTask({
      id: id!,
      repoPath: repoPath!,
      createdAt: 1,
      reason: "usage",
      input: { repoPath, baseBranch: "main", prompt: "task", model: "opus", images: [] } as never,
    });
  deps.accessTokens!.updateRepositories(entry.id, [a]);
  expect(
    (await (await request(token, "/api/held")).json()).map((h: { id: string }) => h.id),
  ).toEqual(["held-a"]);
  expect(
    (
      await request(token, "/api/held/held-a", "PATCH", {
        repoPath: b,
        baseBranch: "main",
        prompt: "move",
      })
    ).status,
  ).toBe(403);
  expect(deps.store.getHeldTask("held-a")?.input.repoPath).toBe(a);
  expect((await request(token, "/api/held/held-b/spawn", "POST")).status).toBe(404);
  expect((await request(token, "/api/held/held-b", "DELETE")).status).toBe(404);
  expect((await request(token, "/api/held/held-a/spawn", "POST")).status).toBe(201);
  expect(deps.store.getHeldTask("held-a")).toBeNull();
});

test("repo boundary: leading duplicate separators cannot bypass authentication or repository checks", async () => {
  const { token } = mint();
  expect((await request(token, `//api//sessions/${sessions[1]!.id}`)).status).toBe(404);
  expect((await request(token, "//api/settings")).status).toBe(403);
  const anon = await makeApp(deps).fetch(new Request("http://localhost//api/sessions"));
  expect(anon.status).toBe(401);
});

test("repo boundary: a live PTY stops input and output when its repository grant changes", async () => {
  let output!: PtySocket;
  const opened = spyOn(PtyBridge.prototype, "open").mockImplementation(function (this: PtyBridge) {
    output = (this as unknown as { ws: PtySocket }).ws;
  });
  let received!: () => void;
  const input = new Promise<void>((resolve) => {
    received = resolve;
  });
  const written = spyOn(PtyBridge.prototype, "write").mockImplementation(() => {
    received();
  });
  const stopped = spyOn(PtyBridge.prototype, "close").mockImplementation(() => {});
  const server = serve(deps, 0);
  const { token, entry } = mint();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/pty/${sessions[0]!.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  } as never);
  try {
    const frames: string[] = [];
    let delivered!: () => void;
    const frame = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    ws.addEventListener("message", (e) => {
      frames.push(String(e.data));
      delivered();
    });
    await socketEvent(ws, "open");
    expect(opened).toHaveBeenCalledTimes(1);
    ws.send("allowed input");
    await input;
    output.send("allowed output");
    await frame;
    expect(written).toHaveBeenCalledWith("allowed input");
    const closed = socketEvent(ws, "close");
    deps.accessTokens!.updateRepositories(entry.id, [b]);
    output.send("forbidden output");
    await closed;
    expect(frames).toEqual(["allowed output"]);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledTimes(1);
    expect(
      (
        await fetch(`http://127.0.0.1:${server.port}/pty/${sessions[0]!.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
  } finally {
    ws.close();
    server.stop(true);
    opened.mockRestore();
    written.mockRestore();
    stopped.mockRestore();
  }
});

test("repo boundary: bare session reads resolve permitted task designations like the dispatcher", async () => {
  const { token } = mint();
  for (const key of [
    sessions[0]!.id,
    sessions[0]!.desig,
    sessions[0]!.desig.replace("TASK-", ""),
  ]) {
    const res = await request(token, `/api/sessions/${key}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(sessions[0]!.id);
  }
  expect((await request(token, `/api/sessions/${sessions[1]!.desig}`)).status).toBe(404);
});
