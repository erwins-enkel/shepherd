import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { serve, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { AccessTokenService } from "../src/access-tokens";
import { RemoteInstanceService } from "../src/remote-instances/service";
import { RemoteSessionMirror } from "../src/remote-instances/sessions";
import { instanceId } from "../src/remote-instances/identity";
import { HandoffRefusedError, type HandoffSource } from "../src/session-handoff";
import type { CreateSessionInput, Session, StandardCreateInput } from "../src/types";
import type { GitForge } from "../src/forge/types";

// "Continue with…" on another machine, end to end over real Shepherd servers in one process: the
// coordinator moves a session of its own to a machine, and a machine's session to itself. Each
// node's service is a recorder, so "who prepared, who created what, who archived" is observable.

interface Node {
  deps: AppDeps & { remoteInstances: RemoteInstanceService; remoteSessions: RemoteSessionMirror };
  server: ReturnType<typeof serve>;
  base: string;
  token: string;
  created: StandardCreateInput[];
  prepared: string[];
  aborted: string[];
  archived: string[];
  checkout: string;
  failPrepare?: HandoffRefusedError;
}

const nodes: Node[] = [];
let restore: Partial<typeof config>;
let root: string;
const HEAD = "a".repeat(40);

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-move-"));
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "move-test-secret",
    token: null,
    host: "127.0.0.1",
  });
});

afterEach(() => {
  for (const node of nodes.splice(0)) {
    node.deps.remoteSessions.stop();
    node.server.stop(true);
  }
  Object.assign(config, restore);
  rmSync(root, { recursive: true, force: true });
});

function startNode(dir: string): Node {
  const checkout = join(root, dir);
  mkdirSync(checkout);
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    events,
    namer: async () => "x",
    worktree: {} as never,
    herdr: { list: () => [] } as never,
  });
  const remoteInstances = new RemoteInstanceService({ store });
  const remoteSessions = new RemoteSessionMirror({
    store,
    instances: remoteInstances,
    recheckDelaysMs: [20],
  });
  remoteInstances.onChange((id) => remoteSessions.sync(id));
  const forge = { slug: "acme/app", isFork: false } as unknown as GitForge;
  const deps = {
    hostPlatform: "linux",
    store,
    events,
    service,
    accessTokens: new AccessTokenService(store),
    remoteInstances,
    remoteSessions,
    resolveForge: ((path: string) => (path === checkout ? forge : null)) as AppDeps["resolveForge"],
    usageLimits: {
      limits: () => ({
        session5h: null,
        week: null,
        perModelWeek: [],
        credits: null,
        stale: true,
        calibratedAt: null,
        subscriptionOnly: false,
      }),
      projections: () => [],
    },
  };
  const server = serve(deps, 0);
  const node: Node = {
    deps,
    server,
    base: `http://127.0.0.1:${server.port}`,
    token: deps.accessTokens.mint("machine", null, "full", null).token,
    created: [],
    prepared: [],
    aborted: [],
    archived: [],
    checkout,
  };
  service.create = (async (input: CreateSessionInput) => {
    if (input.terminal === true) throw new Error("unexpected terminal");
    node.created.push(input);
    return store.create({
      name: `moved-${node.created.length}`,
      prompt: input.prompt,
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      branch: input.continuation?.branch ?? "shepherd/fresh",
      worktreePath: join(input.repoPath, "wt"),
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term-moved-${node.created.length}`,
    });
  }) as SessionService["create"];
  spyOn(service, "prepareHandoff").mockImplementation(
    async (id: string): Promise<HandoffSource> => {
      if (node.failPrepare) throw node.failPrepare;
      node.prepared.push(id);
      const s = store.get(id)!;
      return {
        branch: s.branch!,
        headCommit: HEAD,
        committed: true,
        repoPath: s.repoPath,
        baseBranch: s.baseBranch,
        prompt: s.prompt,
        desig: s.desig,
        agentProvider: "claude",
        planGateEnabled: null,
        autopilotEnabled: null,
        research: false,
        epicAuthoring: false,
        plain: false,
        amendments: [],
        files: [],
      };
    },
  );
  // The recorded prepare stands in for the real one, which holds the session while it moves.
  spyOn(service, "handoffHeld").mockImplementation((id: string) => node.prepared.includes(id));
  spyOn(service, "abortHandoff").mockImplementation(async (id: string) => {
    node.aborted.push(id);
    return null;
  });
  spyOn(service, "archiveMany").mockImplementation(async (ids: string[]) => {
    for (const id of ids) {
      store.archive(id);
      node.archived.push(id);
    }
    return { cleared: ids, leftovers: 0 };
  });
  nodes.push(node);
  return node;
}

function seed(node: Node, name: string): Session {
  const s = node.deps.store.create({
    name,
    prompt: `do ${name}`,
    repoPath: node.checkout,
    baseBranch: "main",
    branch: `shepherd/${name}`,
    worktreePath: join(node.checkout, name),
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `term-${name}`,
  });
  node.deps.events.emit("session:new", s);
  return s;
}

async function connect(from: Node, to: Node): Promise<string> {
  const result = await from.deps.remoteInstances.connect({
    url: to.base,
    token: to.token,
    label: null,
  });
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
  return result.instance.instanceId;
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

function move(
  node: Node,
  id: string,
  body: Record<string, unknown>,
  token = node.token,
): Promise<Response> {
  return fetch(`${node.base}/api/sessions/${id}/move`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const selfId = (node: Node) => instanceId(node.deps.store);

test("a session of this Shepherd moves to a connected machine on its own branch, and is archived here", async () => {
  const a = startNode("a");
  const b = startNode("b");
  const bId = await connect(a, b);
  const s = seed(a, "ios-parity");

  const res = await move(a, s.id, {
    target: { instanceId: bId },
    agentProvider: "codex",
    model: null,
    handoffMode: "summarize",
  });
  expect(res.status).toBe(201);
  const out = (await res.json()) as {
    session: Session & { host: { instanceId: string } };
    archived: boolean;
  };
  expect(out.archived).toBe(true);
  expect(out.session.host.instanceId).toBe(bId);

  expect(a.prepared).toEqual([s.id]);
  expect(b.created).toHaveLength(1);
  const input = b.created[0]!;
  expect(input.repoPath).toBe(b.checkout);
  expect(input.prompt).toBe("do ios-parity");
  expect(input.agentProvider).toBe("codex");
  expect(input.continuation).toEqual({
    branch: "shepherd/ios-parity",
    headCommit: HEAD,
    handoffMode: "summarize",
    from: { machine: expect.any(String), desig: s.desig, provider: "claude" },
  });
  expect(a.archived).toEqual([s.id]);
  expect(a.created).toEqual([]);
});

test("a machine's session moves here: the machine prepares and archives, this Shepherd creates", async () => {
  const a = startNode("a");
  const b = startNode("b");
  await connect(a, b);
  const s = seed(b, "mac-task");
  await until(
    () => a.deps.remoteSessions.list().find((x) => x.id === s.id),
    (x) => !!x && x.remoteSlug === "acme/app",
  );

  const res = await move(a, s.id, { target: { instanceId: selfId(a) }, model: null });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { archived: boolean }).archived).toBe(true);
  expect(b.prepared).toEqual([s.id]);
  expect(a.created).toHaveLength(1);
  expect(a.created[0]!.repoPath).toBe(a.checkout);
  expect(a.created[0]!.continuation?.branch).toBe("shepherd/mac-task");
  expect(a.created[0]!.continuation?.handoffMode).toBe("resume");
  expect(b.archived).toEqual([s.id]);
});

test("moving to the machine the session already runs on is refused before anything happens", async () => {
  const a = startNode("a");
  const s = seed(a, "here");
  const res = await move(a, s.id, { target: { instanceId: selfId(a) }, model: null });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { code: string }).code).toBe("move_same_machine");
  expect(a.prepared).toEqual([]);
});

test("a source that refuses passes its reason on; nothing is created", async () => {
  const a = startNode("a");
  const b = startNode("b");
  const bId = await connect(a, b);
  const s = seed(a, "merging");
  a.failPrepare = new HandoffRefusedError("move_merging");
  const res = await move(a, s.id, { target: { instanceId: bId }, model: null });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("move_merging");
  expect(b.created).toEqual([]);
});

test("the handoff routes serve only unrestricted callers and only this Shepherd's sessions", async () => {
  const a = startNode("a");
  const s = seed(a, "guarded");
  const restricted = a.deps.accessTokens!.mint("ci", null, "full", [a.checkout]).token;
  const post = (id: string, token: string) =>
    fetch(`${a.base}/api/sessions/${id}/handoff/prepare`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: { name: "macbook" } }),
    });
  // a repository grant is refused before the route (the request boundary), never reaching it
  expect((await post(s.id, restricted)).status).toBe(403);
  expect((await post("00000000-0000-4000-8000-000000000000", a.token)).status).toBe(404);
  const complete = () =>
    fetch(`${a.base}/api/sessions/${s.id}/handoff/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      body: JSON.stringify({ carriedIssue: false }),
    });
  // nothing to complete before a prepare: a stray call never archives a session
  expect((await complete()).status).toBe(409);
  expect(a.archived).toEqual([]);
  const ok = await post(s.id, a.token);
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { handoff: { branch: string } }).handoff.branch).toBe(
    "shepherd/guarded",
  );
  expect(await (await complete()).json()).toEqual({ archived: true });
  expect(a.archived).toEqual([s.id]);
});
