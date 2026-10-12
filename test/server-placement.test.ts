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
import type { FetchLike } from "../src/remote-instances/client";
import type { CapabilityService } from "../src/remote-instances/capability-probe";
import {
  CAPABILITIES,
  type Capability,
  type CapabilitySnapshot,
  capabilityReport,
  missingRequirements,
} from "../src/remote-instances/capabilities";
import type { CreateSessionInput } from "../src/types";
import type { GitForge } from "../src/forge/types";

// Automatic machine choice (#2772) end to end: two real Shepherd servers in one process, connected
// to each other, one standing in for Linux and one for a MacBook with Xcode. Each node's
// `service.create` records what started there, so "where did it run" is observable from both
// entries. Capabilities are a fixed report per node (what the probe would have found).

interface Node {
  deps: AppDeps & { remoteInstances: RemoteInstanceService; remoteSessions: RemoteSessionMirror };
  server: ReturnType<typeof serve>;
  base: string;
  token: string;
  id: string;
  created: CreateSessionInput[];
  checkout: string;
  /** The capabilities this node's report says are available; mutable. */
  ok: Capability[];
}

const nodes: Node[] = [];
let restore: Partial<typeof config>;
let root: string;

beforeEach(() => {
  restore = { repoRoot: config.repoRoot, cookieSecret: config.cookieSecret, token: config.token };
  root = mkdtempSync(join(tmpdir(), "shepherd-placement-"));
  Object.assign(config, { repoRoot: root, cookieSecret: "placement-test-secret", token: null });
});

afterEach(() => {
  for (const node of nodes.splice(0)) {
    node.deps.remoteSessions.stop();
    node.server.stop(true);
  }
  Object.assign(config, restore);
  rmSync(root, { recursive: true, force: true });
});

/** A report of `node.ok`, always fresh: what the node's own probe found just now. */
function fixedCapabilities(node: { ok: Capability[] }): CapabilityService {
  const snapshot = (): CapabilitySnapshot => ({
    vocabulary: 1,
    probedAt: Date.now(),
    checks: CAPABILITIES.map((id) =>
      node.ok.includes(id)
        ? { id, ok: true, reason: null }
        : { id, ok: false, reason: "not_installed" },
    ),
  });
  return {
    report: () => capabilityReport(snapshot(), Date.now()),
    refresh: async () => snapshot(),
    verify: async (requirements: Capability[]) => missingRequirements(snapshot(), requirements),
  } as unknown as CapabilityService;
}

function startNode(dir: string, platform: "linux" | "macos", ok: Capability[]): Node {
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
    return store.create({
      name: `task-${created.length}`,
      prompt: input.terminal === true ? "" : input.prompt,
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
  const node = { ok: [...ok] } as Node;
  const deps = {
    store,
    events,
    service,
    accessTokens: new AccessTokenService(store),
    remoteInstances,
    remoteSessions,
    hostPlatform: platform,
    capabilities: fixedCapabilities(node),
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
  Object.assign(node, {
    deps,
    server,
    base: `http://127.0.0.1:${server.port}`,
    token: deps.accessTokens.mint("machine", null, "full", null).token,
    id: store.getSetting("instanceId") ?? "",
    created,
    checkout,
  });
  nodes.push(node);
  return node;
}

/** Linux (no Xcode) and a MacBook with Xcode, connected to each other, both with acme/app. */
async function pair(): Promise<{ linux: Node; mac: Node }> {
  const linux = startNode("app", "linux", ["platform:linux", "agent:claude"]);
  const mac = startNode("app-mac", "macos", [
    "platform:macos",
    "xcode",
    "sdk:macos",
    "agent:claude",
  ]);
  await connect(linux, mac);
  await connect(mac, linux);
  linux.id = await instanceId(linux);
  mac.id = await instanceId(mac);
  return { linux, mac };
}

async function instanceId(node: Node): Promise<string> {
  const res = await call(node, "GET", "/api/instance");
  return (res.body as { instanceId: string }).instanceId;
}

async function connect(from: Node, to: Node): Promise<void> {
  const result = await from.deps.remoteInstances.connect({
    url: to.base,
    token: to.token,
    label: null,
  });
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
}

async function call(
  node: Node,
  method: string,
  path: string,
  body?: unknown,
  opts: { key?: string; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token ?? node.token}`,
    "content-type": "application/json",
  };
  if (opts.key) headers["idempotency-key"] = opts.key;
  const res = await fetch(`${node.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function task(node: Node, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoPath: node.checkout,
    baseBranch: "main",
    prompt: "change the settings screen",
    model: null,
    ...over,
  };
}

const create = (node: Node, body: Record<string, unknown>, opts: { key?: string } = {}) =>
  call(node, "POST", "/api/sessions", body, opts);

function preview(node: Node, over: Record<string, unknown> = {}) {
  return call(node, "POST", "/api/placement", { repoPath: node.checkout, ...over });
}

/** The nodes whose `service.create` ran something — where a task started. */
function ranOn(pair: Node[]): Node[] {
  return pair.filter((n) => n.created.length > 0);
}

describe("automatic machine choice", () => {
  test("no requirements ⇒ Linux, Xcode ⇒ the Mac — whichever Shepherd it is submitted to", async () => {
    const { linux, mac } = await pair();
    const cases: [Node, Capability[], Node][] = [
      [linux, [], linux],
      [mac, [], linux],
      [linux, ["xcode"], mac],
      [mac, ["xcode"], mac],
    ];
    for (const [at, requirements, expected] of cases) {
      linux.created.length = 0;
      mac.created.length = 0;
      const body = task(at, requirements.length > 0 ? { requirements } : {});
      const res = await create(at, body);
      expect(res.status).toBe(201);
      expect(ranOn([linux, mac])).toEqual([expected]);
      // Sent elsewhere, the answer names the machine; started here, it is a local session.
      if (expected === at) expect(res.body.host).toBeUndefined();
      else expect(res.body.host).toMatchObject({ instanceId: expected.id });
      // The record of the choice travels with the task: decided where it was submitted.
      expect(expected.created[0]!).toMatchObject({
        placement: {
          mode: "auto",
          target: { instanceId: expected.id },
          requirements,
          basis: requirements.length > 0 ? "requirements" : "preference",
          preferred: requirements.length > 0 ? null : "linux",
          by: { instanceId: at.id },
        },
      });
    }
  });

  test("the preview names the machine the create then uses (the form and the API agree)", async () => {
    const { linux, mac } = await pair();
    for (const at of [linux, mac]) {
      for (const requirements of [[], ["xcode"], ["agent:claude"]] as Capability[][]) {
        linux.created.length = 0;
        mac.created.length = 0;
        const shown = await preview(at, { requirements });
        expect(shown.status).toBe(200);
        expect(shown.body.active).toBe(true);
        const placement = shown.body.placement as { target: { instanceId: string } };
        const res = await create(at, task(at, requirements.length > 0 ? { requirements } : {}));
        expect(res.status).toBe(201);
        expect(ranOn([linux, mac]).map((n) => n.id)).toEqual([placement.target.instanceId]);
      }
    }
  });

  test("a named machine that does not fit is refused with the reason, and nothing starts", async () => {
    const { linux, mac } = await pair();
    const res = await create(linux, {
      ...task(linux, { requirements: ["android-sdk"] }),
      target: { instanceId: mac.id },
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: "missing_capabilities",
      host: { instanceId: mac.id },
      missing: [{ capability: "android-sdk", reason: "not_installed" }],
    });
    expect(linux.deps.store.listOpenRemoteDispatches()).toEqual([]);
    expect(ranOn([linux, mac])).toEqual([]);
    // The preview says the same before anything is submitted.
    const shown = await preview(linux, {
      requirements: ["android-sdk"],
      target: { instanceId: mac.id },
    });
    expect(shown.body).toMatchObject({
      active: true,
      refusal: { code: "missing_capabilities", host: { instanceId: mac.id } },
    });
  });

  test("no machine fits: the task is blocked and the missing capability is named", async () => {
    const { linux, mac } = await pair();
    const res = await create(linux, task(linux, { requirements: ["android-sdk"] }));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      code: "no_suitable_machine",
      error: "no connected machine has android-sdk; nothing was started",
      missing: ["android-sdk"],
      together: false,
      elsewhere: [],
    });
    expect(ranOn([linux, mac])).toEqual([]);
  });

  test("the fitting machine out of reach is refused and explained, never replaced", async () => {
    const { linux, mac } = await pair();
    mac.server.stop(true);
    await linux.deps.remoteInstances.check(mac.id);
    const res = await create(linux, task(linux, { requirements: ["xcode"] }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "remote_target_unavailable" });
    expect(linux.created).toEqual([]);
    // A task Linux fits still runs on Linux.
    expect((await create(linux, task(linux))).status).toBe(201);
    expect(linux.created).toHaveLength(1);
  });

  test("a keyed retry goes where its first submission went, whatever the choice says now", async () => {
    const { linux, mac } = await pair();
    const body = task(linux, { requirements: ["xcode"] });
    expect((await create(linux, body, { key: "k-remote" })).status).toBe(201);
    expect(ranOn([linux, mac])).toEqual([mac]);
    // Linux gains Xcode: the same task would now stay on Linux — but this one was sent already.
    linux.ok.push("xcode");
    expect((await preview(linux, { requirements: ["xcode"] })).body).toMatchObject({
      placement: { target: { instanceId: linux.id } },
    });
    expect((await create(linux, body, { key: "k-remote" })).status).toBe(201);
    expect(mac.created).toHaveLength(1);
    expect(linux.created).toEqual([]);

    // And a keyed task that started here replays here, even once the Mac would be preferred.
    const local = task(linux);
    expect((await create(linux, local, { key: "k-local" })).status).toBe(201);
    linux.deps.store.setSetting("machinePlatformOrder", JSON.stringify(["macos", "linux"]));
    const again = await create(linux, local, { key: "k-local" });
    expect(again.status).toBe(201);
    expect(linux.created).toHaveLength(1);
    expect(mac.created).toHaveLength(1);
  });

  test("concurrent keyed duplicates never start one key on two machines", async () => {
    const { linux, mac } = await pair();
    // The Mac's hand-off to Linux stalls while it maps the project (GET /api/repos)…
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let stalled!: () => void;
    const reached = new Promise<void>((resolve) => (stalled = resolve));
    const slow: FetchLike = async (input, init) => {
      if (String(input).endsWith("/api/repos")) {
        stalled();
        await gate;
      }
      return fetch(input, init);
    };
    mac.deps.remoteDispatch = new RemoteDispatcher({
      store: mac.deps.store,
      instances: mac.deps.remoteInstances,
      fetch: slow,
    });
    const body = task(mac);
    const first = create(mac, body, { key: "k-race" });
    await reached;
    // …and meanwhile the choice flips to the Mac itself: the duplicate must still follow the first.
    mac.deps.store.setSetting("machinePlatformOrder", JSON.stringify(["macos", "linux"]));
    const second = create(mac, body, { key: "k-race" });
    await Bun.sleep(50);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    expect(linux.created).toHaveLength(1);
    expect(mac.created).toEqual([]);
  });

  test("a placement record counts only when it names this machine as its target", async () => {
    const { linux } = await pair();
    const record = {
      mode: "auto",
      target: { instanceId: linux.id, name: "moes-tavern", platform: "linux" },
      requirements: [],
      basis: "only_candidate",
      preferred: null,
      by: { instanceId: "coordinator-1", name: "MacBook" },
      decidedAt: 7,
    };
    const here = { target: { instanceId: linux.id } };
    expect((await create(linux, task(linux, { ...here, placement: record }))).status).toBe(201);
    expect(linux.created[0]).toMatchObject({ placement: record });
    const forged = { ...record, target: { ...record.target, instanceId: "elsewhere-1" } };
    expect((await create(linux, task(linux, { ...here, placement: forged }))).status).toBe(201);
    expect(linux.created[1]).toMatchObject({
      placement: { mode: "manual", basis: "manual", by: { instanceId: linux.id } },
    });
  });

  test("the platform order is this instance's setting", async () => {
    const { linux, mac } = await pair();
    expect((await call(linux, "GET", "/api/settings")).body.machinePlatformOrder).toEqual([
      "linux",
      "macos",
    ]);
    const bad = await call(linux, "PATCH", "/api/settings", { machinePlatformOrder: ["linux"] });
    expect(bad.status).toBe(400);
    const set = await call(linux, "PATCH", "/api/settings", {
      machinePlatformOrder: ["macos", "linux"],
    });
    expect(set).toEqual({ status: 200, body: { machinePlatformOrder: ["macos", "linux"] } });
    expect((await create(linux, task(linux))).status).toBe(201);
    expect(ranOn([linux, mac])).toEqual([mac]);
    expect(mac.created[0]).toMatchObject({
      placement: { basis: "preference", preferred: "macos" },
    });
  });
});

describe("without connected machines", () => {
  test("a create is exactly what it was, and the preview says the choice is not active", async () => {
    const solo = startNode("app", "linux", ["platform:linux"]);
    const res = await create(solo, task(solo, { requirements: ["platform:linux"] }));
    expect(res.status).toBe(201);
    expect(solo.created).toHaveLength(1);
    expect(Object.keys(solo.created[0]!)).not.toContain("placement");
    expect(await preview(solo)).toEqual({ status: 200, body: { active: false } });
  });

  test("the preview validates its input and the repository grant", async () => {
    const solo = startNode("app", "linux", ["platform:linux"]);
    mkdirSync(join(root, "other"));
    expect((await preview(solo, { requirements: ["arch:x64"] })).status).toBe(400);
    expect((await preview(solo, { prompt: "x" })).status).toBe(400);
    expect(
      (await call(solo, "POST", "/api/placement", { repoPath: join(root, "nope") })).status,
    ).toBe(400);
    const restricted = solo.deps.accessTokens!.mint("repo", null, "full", [solo.checkout]).token;
    const denied = await call(
      solo,
      "POST",
      "/api/placement",
      { repoPath: join(root, "other") },
      { token: restricted },
    );
    expect(denied).toEqual({ status: 403, body: { error: "repository_not_allowed" } });
    const allowed = await call(
      solo,
      "POST",
      "/api/placement",
      { repoPath: solo.checkout },
      {
        token: restricted,
      },
    );
    expect(allowed).toEqual({ status: 200, body: { active: false } });
  });
});
