import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { AccessTokenService } from "../src/access-tokens";
import { serve, type AppDeps } from "../src/server";
import type { CdpClient, CdpPipeClient } from "../src/cdp-pipe";

let root: string, repo: string;
let restore: Pick<typeof config, "repoRoot" | "cookieSecret" | "token" | "host">;
let deps: AppDeps;
let sessionId: string;
let attaches: { repo: string; sink: CdpClient; received: any[]; detached: number }[];

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-browser-view-"));
  repo = join(root, "a");
  mkdirSync(repo);
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "bv-secret",
    token: null,
    host: "127.0.0.1",
  });
  const store = new SessionStore(":memory:");
  attaches = [];
  deps = {
    store,
    events: new EventHub(),
    service: {} as never,
    accessTokens: new AccessTokenService(store),
    sharedBrowser: {
      attach: async (repoPath: string, sink: CdpClient): Promise<CdpPipeClient> => {
        const rec = { repo: repoPath, sink, received: [] as any[], detached: 0 };
        attaches.push(rec);
        return {
          receive: (t) => rec.received.push(JSON.parse(t)),
          detach: () => rec.detached++,
          ready: Promise.resolve(),
        };
      },
      open: async () => "T1",
      sessionTab: () => null,
      stop: () => {},
    },
  } as unknown as AppDeps;
  sessionId = store.create({
    name: "s",
    prompt: "task",
    repoPath: repo,
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: repo,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term-1",
  }).id;
  store.setRepoConfig(repo, { ...store.getRepoConfig(repo), sharedBrowserEnabled: true });
});
afterEach(() => {
  Object.assign(config, restore);
  rmSync(root, { recursive: true, force: true });
});

const bearer = (scope: "read" | "submit" | "full", repos: string[] | null = null) => ({
  Authorization: `Bearer ${deps.accessTokens!.mint("t", null, scope, repos).token}`,
});

async function status(path: string, headers: Record<string, string> = {}) {
  const server = serve(deps, 0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
    return r.status;
  } finally {
    server.stop(true);
  }
}

test("browser view: needs credentials (never public like the SPA shell)", async () => {
  expect(await status(`/browser-view/${sessionId}`)).toBe(401);
});

test("browser view: refused for bad origin, unknown session, disabled repo, limited tokens", async () => {
  const full = bearer("full");
  expect(await status(`/browser-view/${sessionId}`, { ...full, Origin: "https://evil.com" })).toBe(
    403,
  );
  expect(await status(`/browser-view/nope`, full)).toBe(404);
  expect(await status(`/browser-view/${sessionId}`, bearer("read"))).toBe(403);
  expect(await status(`/browser-view/${sessionId}`, bearer("submit"))).toBe(403);
  expect(await status(`/browser-view/${sessionId}`, bearer("full", [join(root, "other")]))).toBe(
    404,
  );
  deps.store.setRepoConfig(repo, {
    ...deps.store.getRepoConfig(repo),
    sharedBrowserEnabled: false,
  });
  expect(await status(`/browser-view/${sessionId}`, full)).toBe(409);
});

test("browser view: attaches to the repo's browser and relays the typed protocol", async () => {
  const server = serve(deps, 0);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/browser-view/${sessionId}`, {
    headers: bearer("full", [repo]),
  } as never);
  try {
    const messages: any[] = [];
    ws.addEventListener("message", (e) => {
      messages.push(JSON.parse(String(e.data)));
    });
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(5);
      expect(pred()).toBe(true);
    };
    await until(() => attaches.length === 1 && attaches[0]!.received.length >= 2);
    const a = attaches[0]!;
    expect(a.repo).toBe(repo);
    const getTargets = a.received.find((m) => m.method === "Target.getTargets");
    a.sink.send(
      JSON.stringify({
        id: getTargets.id,
        result: {
          targetInfos: [
            { targetId: "T1", type: "page", url: "http://localhost:3000/", title: "App" },
          ],
        },
      }),
    );
    await until(() => messages.some((m) => m.type === "targets"));
    expect(messages[0]).toEqual({
      type: "targets",
      targets: [{ id: "T1", title: "App", url: "http://localhost:3000/" }],
      selected: "T1",
    });
    const attach = a.received.find((m) => m.method === "Target.attachToTarget");
    a.sink.send(JSON.stringify({ id: attach.id, result: { sessionId: "C1" } }));
    ws.send(JSON.stringify({ type: "text", text: "secret" }));
    await until(() => a.received.some((m) => m.method === "Input.insertText"));
    expect(a.received.find((m) => m.method === "Input.insertText")).toMatchObject({
      sessionId: "C1",
      params: { text: "secret" },
    });
    const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
    a.sink.close(1011, "browser stopped"); // e.g. the repo was opted out
    expect(await closed).toBe(1011);
    await until(() => a.detached === 1);
  } finally {
    ws.close();
    server.stop(true);
  }
});
