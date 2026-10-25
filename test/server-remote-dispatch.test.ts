import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { payloadHash } from "../src/dispatch";
import { stagingDir } from "../src/uploads";
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

/** Stage a file on `node` the way New Task does (`POST /api/uploads`); its staged path. */
async function stage(node: Node, content: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "image/png" }));
  const res = await fetch(`${node.base}/api/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}` },
    body: form,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { path: string }).path;
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
  // Plus the record of the choice (#2772): named by the operator, decided where it was submitted.
  const placement = {
    mode: "manual",
    basis: "manual",
    target: { instanceId: toId, name: expect.any(String), platform: expect.any(String) },
    by: { instanceId: from.deps.store.getSetting("instanceId"), name: expect.any(String) },
  };
  expect(to.created).toEqual([
    {
      ...local.value,
      repoPath: to.checkout,
      placement: expect.objectContaining(placement),
    } as CreateSessionInput,
  ]);
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

  test("a named machine must fit: its report's gaps are refused here, the machine re-checks the rest", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    // The machine probes a host with claude only (#2770): no Android SDK, no codex, no Xcode.
    let loggedIn = true;
    mac.deps.capabilities = new CapabilityService({
      platform: "macos",
      env: {},
      home: "/nonexistent",
      codexBin: "codex",
      readdir: () => null,
      detectSandbox: () => ({ backend: false, egress: false }),
      exec: async (cmd, args) => ({
        code: cmd === "claude" ? 0 : null,
        stdout: args[0] === "auth" ? JSON.stringify({ loggedIn }) : "",
        timedOut: false,
        notFound: cmd !== "claude",
      }),
    });
    await mac.deps.capabilities.refresh();
    await linux.deps.remoteInstances.check(macId);

    // What the machine's report lacks is refused here by name (#2772), and nothing is sent.
    const res = await create(linux, {
      ...task(linux),
      requirements: ["agent:claude", "android-sdk", "xcode"],
      target: { instanceId: macId },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "missing_capabilities",
      error: expect.stringContaining(
        "is missing capabilities: android-sdk (sdk_not_found), xcode (not_installed)",
      ),
      missing: [
        { capability: "android-sdk", reason: "sdk_not_found" },
        { capability: "xcode", reason: "not_installed" },
      ],
      host: { instanceId: macId },
    });
    expect(linux.deps.store.listOpenRemoteDispatches()).toEqual([]);

    // What the report confirms, the machine still verifies with a fresh probe when the task arrives.
    loggedIn = false;
    const stale = await create(linux, {
      ...task(linux),
      requirements: ["agent:claude"],
      target: { instanceId: macId },
    });
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({
      code: "remote_rejected",
      remoteStatus: 422,
      remoteCode: "missing_capabilities",
      error: "missing capabilities: agent:claude (not_logged_in)",
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

  test("an unknown machine, an unstaged attachment and a clean terminal are refused before anything is sent", async () => {
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

    // Below full, a machine's repo profile is unknown here: only the tightest override passes.
    const submit = linux.deps.accessTokens!.mint("cli", null, "submit", null).token;
    expect((await create(linux, body, { token: submit })).status).toBe(403);
    expect(mac.created).toEqual([]);
    const tightest = { ...body, sandboxProfile: "autonomous" };
    expect((await create(linux, tightest, { token: submit })).status).toBe(201);
    expect(mac.created).toHaveLength(1);
  });

  test("naming this instance runs here; without a target a plain task stays on Linux", async () => {
    const linux = startNode("app");
    linux.deps.hostPlatform = "linux";
    const mac = startNode("app-mac");
    mac.deps.hostPlatform = "macos";
    await connect(linux, mac);
    const selfId = linux.deps.store.getSetting("instanceId")!;

    expect((await create(linux, task(linux))).status).toBe(201);
    expect((await create(linux, { ...task(linux), target: { instanceId: selfId } })).status).toBe(
      201,
    );
    expect(linux.created).toHaveLength(2);
    expect(linux.created[1]).not.toHaveProperty("target");
    // Each records how it got here (#2772): chosen by the platform order, or by the operator.
    expect(linux.created[0]).toMatchObject({
      placement: { mode: "auto", basis: "preference", preferred: "linux" },
    });
    expect(linux.created[1]).toMatchObject({ placement: { mode: "manual", basis: "manual" } });
    expect(mac.created).toEqual([]);
  });

  // #2766: attachments travel with the task — uploaded right before it is sent, never twice.
  test("an attachment reaches the machine's staging, and the task names the machine's copy", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    const staged = await stage(linux, "PNG-BYTES", "shot.png");

    const res = await create(linux, {
      ...task(linux, { images: [staged], attachmentNames: ["Login screen.png"] }),
      target: { instanceId: macId },
    });
    expect(res.status).toBe(201);
    expect(linux.created).toEqual([]);
    expect(mac.created).toHaveLength(1);
    const input = mac.created[0] as CreateSessionInput & { images: string[] };
    // The machine's own staged copy — it passed the machine's own attachment checks to get here.
    expect(input.images).toHaveLength(1);
    expect(input.images[0]).not.toBe(staged);
    expect(input.images[0]!.startsWith(stagingDir(root))).toBe(true);
    expect(readFileSync(input.images[0]!, "utf8")).toBe("PNG-BYTES");
    expect(input).toMatchObject({ attachmentNames: ["Login screen.png"] });
  });

  test("a retry after a lost answer uploads nothing twice and is no 409", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    const staged = await stage(linux, "PNG-BYTES", "shot.png");

    let uploads = 0;
    let drop = true;
    const lossy: FetchLike = async (input, init) => {
      if (input.endsWith("/api/uploads")) uploads++;
      const res = await fetch(input, init);
      if (drop && input.endsWith("/api/sessions")) {
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

    const body = {
      ...task(linux, { images: [staged], attachmentNames: ["shot.png"] }),
      target: { instanceId: macId },
    };
    expect((await create(linux, body, { key: "ui-attempt-1" })).status).toBe(504);
    expect(mac.created).toHaveLength(1);

    const again = await create(linux, body, { key: "ui-attempt-1" });
    expect(again.status).toBe(201);
    expect(uploads).toBe(1);
    expect(mac.created).toHaveLength(1);
  });

  test("an attachment that does not reach the machine starts nothing, there or here", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    const staged = await stage(linux, "PNG-BYTES", "shot.png");
    mac.deps.maxUploadBytes = 1;

    const body = {
      ...task(linux, { images: [staged], attachmentNames: ["shot.png"] }),
      target: { instanceId: macId },
    };
    const res = await create(linux, body, { key: "ui-attempt-1" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "remote_upload_failed",
      error: "attachment 1 of 1: the machine answered 413 (file too large)",
      host: { instanceId: macId },
    });
    expect(mac.created).toEqual([]);
    expect(linux.created).toEqual([]);

    // Ended for good under that key: the same answer, nothing sent.
    mac.deps.maxUploadBytes = undefined;
    const again = await create(linux, body, { key: "ui-attempt-1" });
    expect(again.status).toBe(502);
    expect(mac.created).toEqual([]);
  });
});

// #2774: a lost answer is "start status unknown", never "failed, start elsewhere". The coordinator
// asks the machine after every probe that finds it connected, re-sends only what never arrived —
// same ID, same machine — and a cancelled dispatch never starts, however late it arrives.
describe("start status unknown", () => {
  interface RemoteDispatchJson {
    id: string;
    state: string;
    host: { instanceId: string };
    summary: string;
    sessionId?: string;
  }

  /** The dispatcher index.ts wires: on `node`'s events, reconciled after every probe. */
  function reconciling(node: Node, net: FetchLike): RemoteDispatcher {
    const dispatcher = new RemoteDispatcher({
      store: node.deps.store,
      instances: node.deps.remoteInstances,
      events: node.deps.events,
      fetch: net,
    });
    node.deps.remoteDispatch = dispatcher;
    node.deps.remoteInstances.onChange((id) => void dispatcher.reconcile(id));
    return dispatcher;
  }

  async function remoteDispatches(node: Node): Promise<RemoteDispatchJson[]> {
    const res = await fetch(`${node.base}/api/remote-dispatches`, {
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { dispatches: RemoteDispatchJson[] }).dispatches;
  }

  function cancel(node: Node, id: string): Promise<Response> {
    return fetch(`${node.base}/api/remote-dispatches/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${node.token}` },
    });
  }

  const frames = (node: Node) =>
    node.hub.filter(([event]) => event === "remote:dispatch").map(([, data]) => data);

  const isCreate = (input: string, init: RequestInit) =>
    init.method === "POST" && input.endsWith("/api/sessions");

  test("an answer lost after the machine accepted: unknown, then running — one session", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    let drop = true;
    reconciling(linux, async (input, init) => {
      const res = await fetch(input, init);
      if (drop && isCreate(input, init)) {
        drop = false;
        await res.body?.cancel();
        throw new TypeError("connection reset after the machine accepted");
      }
      return res;
    });

    const res = await create(
      linux,
      { ...task(linux), target: { instanceId: macId } },
      { key: "ui-attempt-1" },
    );
    expect(res.status).toBe(504);
    expect(mac.created).toHaveLength(1);
    const [unknown] = await remoteDispatches(linux);
    expect(unknown).toMatchObject({
      state: "unknown",
      host: { instanceId: macId },
      summary: "Run on a machine",
    });
    // A token restricted to repositories does not reach the list.
    const restricted = linux.deps.accessTokens!.mint("ext", null, "full", [linux.checkout]).token;
    const denied = await fetch(`${linux.base}/api/remote-dispatches`, {
      headers: { authorization: `Bearer ${restricted}` },
    });
    expect(denied.status).toBe(403);

    // The next probe of the Mac reconciles it.
    await linux.deps.remoteInstances.check(macId);
    await until(
      () => remoteDispatches(linux),
      (l) => l.length === 0,
    );
    expect(mac.created).toHaveLength(1);
    const [running] = mac.deps.store.list();
    expect(frames(linux)).toEqual([
      expect.objectContaining({ id: unknown!.id, state: "unknown" }),
      expect.objectContaining({ id: unknown!.id, state: "started", sessionId: running!.id }),
    ]);
    // The session that runs there is in this herd, labelled with its machine.
    const herd = await until(
      () => sessions(linux),
      (l) => l.some((s) => s.id === running!.id),
    );
    expect(herd.find((s) => s.id === running!.id)!.host).toMatchObject({ instanceId: macId });
  });

  test("a restart of this Shepherd mid-hand-off is reconciled without a duplicate", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    // (a) the answer is lost — it started there; (b) the request is lost — it never arrived.
    let lose: "answer" | "request" | null = "answer";
    linux.deps.remoteDispatch = new RemoteDispatcher({
      store: linux.deps.store,
      instances: linux.deps.remoteInstances,
      events: linux.deps.events,
      fetch: async (input, init) => {
        if (lose === "request" && isCreate(input, init)) {
          lose = null;
          throw new TypeError("connection refused");
        }
        const res = await fetch(input, init);
        if (lose === "answer" && isCreate(input, init)) {
          lose = "request";
          await res.body?.cancel();
          throw new TypeError("connection reset");
        }
        return res;
      },
    });
    const a = { ...task(linux, { prompt: "task a" }), target: { instanceId: macId } };
    const b = { ...task(linux, { prompt: "task b" }), target: { instanceId: macId } };
    expect((await create(linux, a, { key: "key-a" })).status).toBe(504);
    expect((await create(linux, b, { key: "key-b" })).status).toBe(504);
    expect(mac.created.map((c) => (c as { prompt: string }).prompt)).toEqual(["task a"]);

    // Restarted: a fresh dispatcher over the same store, nothing in flight.
    let creates = 0;
    const restarted = new RemoteDispatcher({
      store: linux.deps.store,
      instances: linux.deps.remoteInstances,
      events: linux.deps.events,
      fetch: (input, init) => {
        if (isCreate(input, init)) creates++;
        return fetch(input, init);
      },
    });
    linux.deps.remoteDispatch = restarted;
    expect((await remoteDispatches(linux)).map((d) => d.state)).toEqual(["unknown", "unknown"]);
    await restarted.reconcile(macId);
    expect(await remoteDispatches(linux)).toEqual([]);
    // a was only asked about; b — which never arrived — went out once more, to the same machine.
    expect(creates).toBe(1);
    expect(mac.created.map((c) => (c as { prompt: string }).prompt)).toEqual(["task a", "task b"]);

    // The clients' retries under their keys start nothing more.
    expect((await create(linux, a, { key: "key-a" })).status).toBe(201);
    expect((await create(linux, b, { key: "key-b" })).status).toBe(201);
    expect(mac.created).toHaveLength(2);
    expect(mac.deps.store.list()).toHaveLength(2);
    expect(linux.created).toEqual([]);
  });

  test("a restart of the machine mid-start reads as interrupted — nothing starts", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    // The machine reserved the dispatch, then went down before it started anything.
    let dies = true;
    reconciling(linux, async (input, init) => {
      if (dies && isCreate(input, init)) {
        dies = false;
        mac.deps.store.reserveDispatch({
          id: (init.headers as Record<string, string>)["idempotency-key"]!,
          payloadHash: payloadHash(JSON.parse(init.body as string)),
          repoPath: mac.checkout,
          now: Date.now(),
        });
        throw new TypeError("connection reset");
      }
      return fetch(input, init);
    });
    const body = { ...task(linux), target: { instanceId: macId } };
    expect((await create(linux, body, { key: "ui-attempt-1" })).status).toBe(504);

    await linux.deps.remoteInstances.check(macId);
    await until(
      () => remoteDispatches(linux),
      (l) => l.length === 0,
    );
    expect(linux.deps.store.getRemoteDispatchByKey("ui-attempt-1")).toMatchObject({
      state: "rejected",
      code: "dispatch_interrupted",
    });
    expect(frames(linux).at(-1)).toMatchObject({ state: "rejected", code: "dispatch_interrupted" });

    // A retry under the key gets the machine's replay of that: still nothing starts.
    const again = await create(linux, body, { key: "ui-attempt-1" });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({
      code: "remote_rejected",
      remoteCode: "dispatch_interrupted",
    });
    expect(mac.created).toEqual([]);
  });

  test("a canceled dispatch never starts there, even when it arrives late", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    let lost: [string, RequestInit] | null = null;
    reconciling(linux, async (input, init) => {
      if (!lost && isCreate(input, init)) {
        lost = [input, init];
        throw new TypeError("connection reset");
      }
      return fetch(input, init);
    });
    const body = { ...task(linux), target: { instanceId: macId } };
    expect((await create(linux, body, { key: "ui-attempt-1" })).status).toBe(504);
    const [d] = await remoteDispatches(linux);

    const res = await cancel(linux, d!.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: d!.id, state: "canceled" });
    expect(await remoteDispatches(linux)).toEqual([]);
    expect(frames(linux).map((f) => (f as { state: string }).state)).toEqual([
      "unknown",
      "canceling",
      "canceled",
    ]);

    // The request lost on the way arrives after all: refused there, nothing starts.
    const late = await fetch(...lost!);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "dispatch_canceled" });
    // The client's retry under its key is refused here.
    const again = await create(linux, body, { key: "ui-attempt-1" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "remote_dispatch_canceled" });
    // Canceling again is fine; a settled or unknown one is not.
    expect((await cancel(linux, d!.id)).status).toBe(200);
    expect((await cancel(linux, "no-such-dispatch")).status).toBe(404);
    expect(mac.created).toEqual([]);
  });

  test("a cancel while the machine is out of reach is delivered once it is back", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    let down = false;
    let lost: [string, RequestInit] | null = null;
    reconciling(linux, async (input, init) => {
      if (down) throw new TypeError("network unreachable");
      if (!lost && isCreate(input, init)) {
        lost = [input, init];
        throw new TypeError("connection reset");
      }
      return fetch(input, init);
    });
    const body = { ...task(linux), target: { instanceId: macId } };
    expect((await create(linux, body, { key: "ui-attempt-1" })).status).toBe(504);
    const [d] = await remoteDispatches(linux);

    down = true;
    const res = await cancel(linux, d!.id);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "canceling" });
    expect((await remoteDispatches(linux)).map((x) => x.state)).toEqual(["canceling"]);
    // Until the machine confirms the cancel, a retry is told so — never that it cannot start.
    const pending = await create(linux, body, { key: "ui-attempt-1" });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "remote_dispatch_cancel_pending" });

    down = false;
    await linux.deps.remoteInstances.check(macId);
    await until(
      () => remoteDispatches(linux),
      (l) => l.length === 0,
    );
    expect(linux.deps.store.getRemoteDispatch(d!.id)!.state).toBe("canceled");
    expect((await fetch(...lost!)).status).toBe(409);
    expect(mac.created).toEqual([]);
  });

  test("a dispatch the machine already started cannot be canceled", async () => {
    const linux = startNode("app");
    const mac = startNode("app-mac");
    const macId = await connect(linux, mac);
    let drop = true;
    reconciling(linux, async (input, init) => {
      const res = await fetch(input, init);
      if (drop && isCreate(input, init)) {
        drop = false;
        await res.body?.cancel();
        throw new TypeError("connection reset");
      }
      return res;
    });
    const body = { ...task(linux), target: { instanceId: macId } };
    expect((await create(linux, body, { key: "ui-attempt-1" })).status).toBe(504);
    const [d] = await remoteDispatches(linux);

    const res = await cancel(linux, d!.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "remote_dispatch_not_cancelable",
      dispatch: { id: d!.id, state: "started", sessionId: mac.deps.store.list()[0]!.id },
    });
    expect(mac.created).toHaveLength(1);
  });
});
