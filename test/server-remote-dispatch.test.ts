import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { RemoteDispatcher } from "../src/remote-instances/dispatch";
import { CapabilityService } from "../src/remote-instances/capability-probe";
import type { FetchLike } from "../src/remote-instances/client";
import { validateCreate } from "../src/validate";
import { WorktreeMissingBaseError } from "../src/worktree";
import type { CreateSessionInput, Session } from "../src/types";
import type { GitForge } from "../src/forge/types";

// Starting a task on a connected machine (#2763) end to end: real Shepherd servers in one process,
// each with its own store, auth gate, tokens, probe and mirror. Each node's `service.create` is
// replaced by a recorder, so "where did the agent start" and "with what" are observable. Every node
// has the project acme/app checked out in its OWN directory, so the path mapping is visible too.

interface Node {
  deps: AppDeps & { remoteInstances: RemoteInstanceService; remoteSessions: RemoteSessionMirror };
  server: ReturnType<typeof serve>;
  base: string;
  token: string;
  /** Inputs this node's `service.create` received — i.e. what started HERE. */
  created: CreateSessionInput[];
  hub: [string, unknown][];
  checkout: string;
}

const nodes: Node[] = [];
let restore: Partial<typeof config>;
let root: string;

beforeEach(() => {
  restore = {
    repoRoot: config.repoRoot,
    cookieSecret: config.cookieSecret,
    token: config.token,
    host: config.host,
  };
  root = mkdtempSync(join(tmpdir(), "shepherd-remote-dispatch-"));
  Object.assign(config, {
    repoRoot: root,
    cookieSecret: "dispatch-test-secret",
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

/** A node whose checkout of acme/app is `<root>/<dir>`; no other directory has a forge slug. */
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
  const created: CreateSessionInput[] = [];
  service.create = (async (input: CreateSessionInput) => {
    created.push(input);
    const prompt = input.terminal === true ? "" : input.prompt;
    if (prompt === "fail on the base") throw new WorktreeMissingBaseError("main");
    return store.create({
      name: `task-${created.length}`,
      prompt,
      repoPath: input.repoPath,
      baseBranch: "main",
      branch: `shepherd/task-${created.length}`,
      worktreePath: input.repoPath,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term-${created.length}`,
    });
  }) as SessionService["create"];
  const remoteInstances = new RemoteInstanceService({ store });
  const remoteSessions = new RemoteSessionMirror({
    store,
    instances: remoteInstances,
    recheckDelaysMs: [20],
  });
  remoteInstances.onChange((id) => remoteSessions.sync(id));
  const forge = { slug: "acme/app", isFork: false } as unknown as GitForge;
  const deps = {
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
  const hub: [string, unknown][] = [];
  events.subscribe((event, data) => hub.push([event, data]));
  const node: Node = {
    deps,
    server,
    base: `http://127.0.0.1:${server.port}`,
    token: deps.accessTokens.mint("machine", null, "full", null).token,
    created,
    hub,
    checkout,
  };
  nodes.push(node);
  return node;
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

/** Everything the dialog can carry except attachments: modes, options, issue, base, engine. */
function task(node: Node, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoPath: node.checkout,
    baseBranch: "release/2.2",
    prompt: "port the settings screen",
    agentProvider: "claude",
    model: "opus",
    effort: "high",
    issueRef: {
      number: 2763,
      title: "Run on a machine",
      url: "https://github.com/acme/app/issues/2763",
      body: "issue body",
    },
    launchUiState: {
      researchChecked: false,
      planGateChecked: true,
      autopilotChecked: false,
      epicAuthoringChecked: false,
      plainChecked: false,
    },
    planGateEnabled: true,
    autopilotEnabled: false,
    sandboxProfile: "standard",
    research: false,
    epicAuthoring: false,
    plain: false,
    ...over,
  };
}

function create(
  node: Node,
  body: Record<string, unknown>,
  opts: { key?: string; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token ?? node.token}`,
    "content-type": "application/json",
  };
  if (opts.key) headers["idempotency-key"] = opts.key;
  return fetch(`${node.base}/api/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 2_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

async function sessions(node: Node): Promise<(Session & Record<string, unknown>)[]> {
  const res = await fetch(`${node.base}/api/sessions`, {
    headers: { authorization: `Bearer ${node.token}` },
  });
  return (await res.json()) as (Session & Record<string, unknown>)[];
}

/** Run a task from `from` on `to` and check that it started there — and only there. */
async function runsOn(from: Node, to: Node, toId: string): Promise<void> {
  const body = task(from);
  const res = await create(from, { ...body, target: { instanceId: toId } });
  expect(res.status).toBe(201);
  const started = (await res.json()) as Session & Record<string, unknown>;
  expect(started.host).toEqual({
    instanceId: toId,
    name: expect.any(String),
    platform: expect.any(String),
  });
  expect(started.connection).toEqual({ state: "connected", since: expect.any(Number) });

  // The machine got exactly what a local create would have, with its own checkout as the repo.
  const local = validateCreate(body, root);
  if (!local.ok) throw new Error(local.error);
  expect(to.created).toEqual([{ ...local.value, repoPath: to.checkout }]);
  expect(to.deps.store.get(started.id)).not.toBeNull();

  // Nothing started here, nothing entered this store or this node's own event hub.
  expect(from.created).toEqual([]);
  expect(from.deps.store.get(started.id)).toBeNull();
  expect(JSON.stringify(from.hub)).not.toContain(started.id);

  // The session reaches this node's herd through the mirror, labelled with its machine.
  const listed = await until(
    () => sessions(from),
    (l) => l.some((s) => s.id === started.id),
  );
  expect(listed.find((s) => s.id === started.id)!.host).toMatchObject({ instanceId: toId });
}

describe("starting a task on a connected machine", () => {
  test("Linux → Mac and Mac → Linux: the whole session starts on the chosen machine", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    const linuxId = await connect(mac, linux);

    await runsOn(linux, mac, macId);
    linux.created.length = 0;
    mac.created.length = 0;
    // Roles swapped: the Mac's Shepherd hands a task to Linux.
    await runsOn(mac, linux, linuxId);
  });

  test("a lost answer is never re-sent elsewhere, and the retry starts nothing twice", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const spare = startNode("app-spare");
    const macId = await connect(linux, mac);
    await connect(linux, spare);

    let drop = true;
    const lossy: FetchLike = async (input, init) => {
      const res = await fetch(input, init);
      if (drop && init.method === "POST") {
        drop = false;
        await res.body?.cancel();
        throw new TypeError("connection reset after the request was sent");
      }
      return res;
    };
    linux.deps.remoteDispatch = new RemoteDispatcher({
      store: linux.deps.store,
      instances: linux.deps.remoteInstances,
      fetch: lossy,
    });

    const body = { ...task(linux), target: { instanceId: macId } };
    const lost = await create(linux, body, { key: "ui-attempt-1" });
    expect(lost.status).toBe(504);
    expect(await lost.json()).toMatchObject({
      code: "remote_dispatch_unknown",
      dispatchId: "ui-attempt-1",
      host: { instanceId: macId },
    });
    // It did arrive and start on the Mac.
    expect(mac.created).toHaveLength(1);

    const again = await create(linux, body, { key: "ui-attempt-1" });
    expect(again.status).toBe(201);
    const started = (await again.json()) as Session;
    expect(mac.created).toHaveLength(1);
    expect(mac.deps.store.list().map((s) => s.id)).toEqual([started.id]);
    expect(spare.created).toEqual([]);
    expect(linux.created).toEqual([]);

    // Same key, different task: refused before anything is sent.
    const changed = await create(
      linux,
      { ...body, prompt: "something else" },
      { key: "ui-attempt-1" },
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "dispatch_payload_mismatch" });
    expect(mac.created).toHaveLength(1);
  });

  test("a hold on the machine is reported as held there", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    mac.deps.codexCapacity = async () => false;

    const res = await create(linux, {
      ...task(linux, { agentProvider: "codex", model: null, effort: null }),
      target: { instanceId: macId },
    });
    expect(res.status).toBe(200);
    const held = (await res.json()) as Record<string, unknown>;
    expect(held).toMatchObject({ held: true, host: { instanceId: macId } });
    expect(mac.deps.store.listHeldTasks().map((t) => t.id)).toEqual([held.id as string]);
    expect(linux.deps.store.countHeldTasks()).toBe(0);
    expect(mac.created).toEqual([]);
  });

  test("a refusal by the machine comes back with its reason", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);

    const res = await create(linux, {
      ...task(linux, { prompt: "fail on the base" }),
      target: { instanceId: macId },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "remote_rejected",
      remoteStatus: 422,
      error: expect.stringContaining('base ref "main" does not resolve'),
      host: { instanceId: macId },
    });
    expect(linux.created).toEqual([]);
  });

  test("the machine checks the task's requirements itself and refuses a missing one by name", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    // The machine probes a host with claude only (#2770): no Android SDK, no codex.
    mac.deps.capabilities = new CapabilityService({
      platform: "macos",
      env: {},
      home: "/nonexistent",
      codexBin: "codex",
      readdir: () => null,
      detectSandbox: () => ({ backend: false, egress: false }),
      exec: async (cmd, args) => ({
        code: cmd === "claude" ? 0 : null,
        stdout: args[0] === "auth" ? JSON.stringify({ loggedIn: true }) : "",
        timedOut: false,
        notFound: cmd !== "claude",
      }),
    });

    const res = await create(linux, {
      ...task(linux),
      requirements: ["agent:claude", "android-sdk"],
      target: { instanceId: macId },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "remote_rejected",
      remoteStatus: 422,
      remoteCode: "missing_capabilities",
      error: "missing capabilities: android-sdk (sdk_not_found)",
      host: { instanceId: macId },
    });
    expect(mac.created).toEqual([]);
    expect(linux.created).toEqual([]);
  });

  test("a machine whose platform is not released (Windows) is refused and sent nothing", async () => {
    const linux = startNode("app");
    const win = startNode("app-win");
    const winId = await connect(linux, win);
    // The coordinator sees it as Windows: the release gate (#2770) applies before any send.
    const instances = linux.deps.remoteInstances;
    const get = instances.get.bind(instances);
    instances.get = (id: string) => {
      const m = get(id);
      return m && m.info ? { ...m, info: { ...m.info, platform: "windows" }, released: false } : m;
    };

    const res = await create(linux, { ...task(linux), target: { instanceId: winId } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "remote_target_unreleased", reason: "windows" });
    expect(win.created).toEqual([]);
    expect(linux.created).toEqual([]);
  });

  test("an unknown machine, attachments and a clean terminal are refused before anything is sent", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);

    const unknown = await create(linux, {
      ...task(linux),
      target: { instanceId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ code: "remote_target_unknown" });

    const attached = await create(linux, {
      ...task(linux, { images: ["/tmp/shot.png"], attachmentNames: ["shot.png"] }),
      target: { instanceId: macId },
    });
    expect(attached.status).toBe(400);

    const terminal = await create(linux, {
      repoPath: linux.checkout,
      terminal: true,
      target: { instanceId: macId },
    });
    expect(terminal.status).toBe(400);

    const malformed = await create(linux, { ...task(linux), target: { instanceId: 7 } });
    expect(malformed.status).toBe(400);
    expect(mac.created).toEqual([]);
    expect(linux.created).toEqual([]);
  });

  test("starting on a machine needs the same scope as starting here", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    const body = { ...task(linux), target: { instanceId: macId } };

    const read = linux.deps.accessTokens!.mint("viewer", null, "read", null).token;
    expect((await create(linux, body, { token: read })).status).toBe(403);
    expect(mac.created).toEqual([]);

    const submit = linux.deps.accessTokens!.mint("cli", null, "submit", null).token;
    expect((await create(linux, body, { token: submit })).status).toBe(201);
    expect(mac.created).toHaveLength(1);
  });

  test("without a target, or naming this instance, the task starts here as before", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    await connect(linux, mac);
    const selfId = linux.deps.store.getSetting("instanceId")!;

    expect((await create(linux, task(linux))).status).toBe(201);
    expect((await create(linux, { ...task(linux), target: { instanceId: selfId } })).status).toBe(
      201,
    );
    expect(linux.created).toHaveLength(2);
    expect(linux.created[1]).not.toHaveProperty("target");
    expect(mac.created).toEqual([]);
  });
});
