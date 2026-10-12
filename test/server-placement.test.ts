import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { instanceIdentity } from "../src/remote-instances/identity";
import { localMachine } from "../src/remote-instances/placement";
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
import type { TaskText } from "../src/requirements-classify-core";
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
  /** How often this node's capabilities were probed on demand (`refresh`). */
  probes: number;
  port: number;
  /** The next task this node sends to a machine reaches it, but the answer is lost. */
  dropCreate: boolean;
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
function fixedCapabilities(node: { ok: Capability[]; probes: number }): CapabilityService {
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
    refresh: async () => {
      node.probes++;
      return snapshot();
    },
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
  const node = { ok: [...ok], probes: 0, dropCreate: false } as Node;
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
  // As index.ts wires it: a task waiting for a machine (#2775) is followed up after every probe.
  const dispatcher = new RemoteDispatcher({
    store,
    instances: remoteInstances,
    events,
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (node.dropCreate && init.method === "POST" && input.endsWith("/api/sessions")) {
        node.dropCreate = false;
        await res.body?.cancel();
        throw new TypeError("connection reset after the machine accepted");
      }
      return res;
    },
    here: () => localMachine(instanceIdentity(store, platform), deps.capabilities.report()),
  });
  Object.assign(deps, { remoteDispatch: dispatcher });
  remoteInstances.onChange((id) => {
    void (node.deps.remoteDispatch as RemoteDispatcher).reconcile(id).catch(() => {});
  });
  const server = serve(deps, 0);
  Object.assign(node, {
    deps,
    server,
    port: server.port,
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

/** `node` goes to sleep: its server stops answering, and `seenBy`'s probe notices. */
async function sleep(node: Node, seenBy: Node): Promise<void> {
  node.server.stop(true);
  await seenBy.deps.remoteInstances.check(node.id);
}

/** `node` wakes up on the same address, and `seenBy`'s next probe finds it. */
async function wake(node: Node, seenBy: Node): Promise<void> {
  node.server = serve(node.deps, node.port);
  await seenBy.deps.remoteInstances.check(node.id);
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

type Listed = { id: string; state: string; readiness?: { state: string }; [k: string]: unknown };

async function waiting(node: Node): Promise<Listed[]> {
  return ((await call(node, "GET", "/api/remote-dispatches")).body as { dispatches: Listed[] })
    .dispatches;
}

const redirect = (node: Node, id: string, instanceId: string) =>
  call(node, "POST", `/api/remote-dispatches/${id}/redirect`, { target: { instanceId } });

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

  test("the fitting machine out of reach is waited for, never replaced", async () => {
    const { linux, mac } = await pair();
    await sleep(mac, linux);
    const res = await create(linux, task(linux, { requirements: ["xcode"] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      held: true,
      waiting: true,
      host: { instanceId: mac.id },
      dispatch: { state: "waiting", alternatives: [] },
    });
    expect(ranOn([linux, mac])).toEqual([]);
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

// ── requirements read from the task (#2773) ─────────────────────────────────────────────────────
// The helper is stubbed: a deterministic stand-in for the model that records what it was given.

type Answer = Awaited<ReturnType<NonNullable<AppDeps["deriveTaskRequirements"]>>>;

function stubHelper(node: Node, answer: (task: TaskText) => Answer): TaskText[] {
  const seen: TaskText[] = [];
  node.deps.deriveTaskRequirements = async (task) => {
    seen.push(task);
    return answer(task);
  };
  return seen;
}

const derive = (node: Node, over: Record<string, unknown> = {}) =>
  call(node, "POST", "/api/requirements/derive", {
    repoPath: node.checkout,
    prompt: "Implementiere die Web-Einstellungen",
    ...over,
  });

describe("requirements read from the task", () => {
  test("two tasks of one repo land on the Mac and on Linux by what they ask for", async () => {
    const { linux, mac } = await pair();
    // The repository carries native code; only the task text reaches the helper.
    mkdirSync(join(linux.checkout, "native"));
    writeFileSync(join(linux.checkout, "Package.swift"), "// swift-tools-version:6.0\n");
    const seen = stubHelper(linux, (t) => ({
      status: "derived",
      requirements: t.prompt.includes("macOS") ? ["xcode"] : [],
    }));
    for (const [prompt, expected] of [
      ["Erweitere die native macOS-App", mac],
      ["Implementiere die Web-Einstellungen", linux],
    ] as const) {
      linux.created.length = 0;
      mac.created.length = 0;
      const shown = await preview(linux);
      expect(shown.body.deriveRequirements).toBe(true);
      const derived = await derive(linux, { prompt });
      expect(derived.status).toBe(200);
      const requirements = (derived.body as { requirements: Capability[] }).requirements;
      const res = await create(
        linux,
        task(linux, { prompt, ...(requirements.length > 0 && { requirements }) }),
      );
      expect(res.status).toBe(201);
      expect(ranOn([linux, mac])).toEqual([expected]);
    }
    expect(seen).toEqual([
      { prompt: "Erweitere die native macOS-App", issue: null },
      { prompt: "Implementiere die Web-Einstellungen", issue: null },
    ]);
  });

  test("the helper's answer comes through as data: unclear, failed, an attached issue", async () => {
    const { linux } = await pair();
    stubHelper(linux, () => ({ status: "unclear", options: [["xcode"], []] }));
    expect(await derive(linux)).toEqual({
      status: 200,
      body: { status: "unclear", options: [["xcode"], []] },
    });
    stubHelper(linux, () => ({ status: "failed", cause: "timeout" }));
    expect(await derive(linux)).toEqual({
      status: 200,
      body: { status: "failed", cause: "timeout" },
    });
    const seen = stubHelper(linux, () => ({ status: "derived", requirements: ["android-sdk"] }));
    const issue = { title: "Android: Push fehlt", body: "Die Android-App zeigt nichts an." };
    expect((await derive(linux, { prompt: "", issue })).body).toEqual({
      status: "derived",
      requirements: ["android-sdk"],
    });
    expect(seen).toEqual([{ prompt: "", issue }]);
  });

  test("no helper wired: nothing derived, and it says why", async () => {
    const { linux } = await pair();
    expect((await derive(linux)).body).toEqual({ status: "failed", cause: "unavailable" });
  });

  test("a named machine is the operator's pick: the preview does not ask to derive", async () => {
    const { linux, mac } = await pair();
    expect((await preview(linux, { target: { instanceId: mac.id } })).body.deriveRequirements).toBe(
      false,
    );
    expect(
      (await preview(linux, { target: { instanceId: linux.id } })).body.deriveRequirements,
    ).toBe(false);
  });

  test("machines that verify the same: skipped, the helper never runs", async () => {
    const a = startNode("app", "linux", ["platform:linux", "agent:claude"]);
    const b = startNode("app-b", "linux", ["platform:linux", "agent:claude"]);
    await connect(a, b);
    const seen = stubHelper(a, () => ({ status: "derived", requirements: ["xcode"] }));
    expect((await preview(a)).body).toMatchObject({ active: true, deriveRequirements: false });
    expect(await derive(a)).toEqual({ status: 200, body: { status: "skipped" } });
    expect(seen).toEqual([]);
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

  test("reading requirements from the task is skipped, and nothing runs", async () => {
    const solo = startNode("app", "linux", ["platform:linux"]);
    const seen = stubHelper(solo, () => ({ status: "derived", requirements: ["xcode"] }));
    expect(await derive(solo)).toEqual({ status: 200, body: { status: "skipped" } });
    expect(seen).toEqual([]);
  });

  test("the derive route validates its input and the repository grant", async () => {
    const solo = startNode("app", "linux", ["platform:linux"]);
    mkdirSync(join(root, "other"));
    for (const bad of [
      { prompt: "" },
      { prompt: "   ", issue: { title: " " } },
      { prompt: 42 },
      { prompt: "x".repeat(8001) },
      { requirements: ["xcode"] },
      { issue: "#12" },
      { issue: { title: "t", url: "https://x" } },
      { issue: { title: "t", body: 7 } },
      { repoPath: join(root, "nope") },
    ]) {
      expect((await derive(solo, bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const restricted = solo.deps.accessTokens!.mint("repo", null, "full", [solo.checkout]).token;
    const denied = await call(
      solo,
      "POST",
      "/api/requirements/derive",
      { repoPath: join(root, "other"), prompt: "x" },
      { token: restricted },
    );
    expect(denied).toEqual({ status: 403, body: { error: "repository_not_allowed" } });
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

describe("waiting for the right machine (#2775)", () => {
  test("a sleeping MacBook: the Xcode task waits, then starts there once it is back and checked", async () => {
    const { linux, mac } = await pair();
    await sleep(mac, linux);
    const body = task(linux, { requirements: ["xcode"] });
    const res = await create(linux, body, { key: "xcode-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      held: true,
      waiting: true,
      count: 1,
      host: { instanceId: mac.id },
      dispatch: {
        state: "waiting",
        readiness: { state: "offline" },
        placement: {
          requirements: ["xcode"],
          basis: "requirements",
          target: { instanceId: mac.id },
        },
      },
    });
    expect(ranOn([linux, mac])).toEqual([]);
    // The preview says the same before a submit.
    expect((await preview(linux, { requirements: ["xcode"] })).body).toMatchObject({
      active: true,
      placement: { target: { instanceId: mac.id } },
      wait: { alternatives: [] },
    });
    // A retry under the key: still that one waiting task.
    const again = await create(linux, body, { key: "xcode-1" });
    expect(again.body).toMatchObject({ waiting: true, id: res.body.id });
    expect(await waiting(linux)).toHaveLength(1);

    const probes = mac.probes;
    await wake(mac, linux);
    await until(
      () => mac.created.length,
      (n) => n === 1,
    );
    // The Mac checked its capabilities right before the task was sent.
    expect(mac.probes).toBeGreaterThan(probes);
    expect(mac.created[0]).toMatchObject({
      repoPath: mac.checkout,
      placement: { requirements: ["xcode"], target: { instanceId: mac.id } },
    });
    expect(
      await until(
        () => waiting(linux),
        (l) => l.length === 0,
      ),
    ).toEqual([]);
    expect(linux.created).toEqual([]);
    // The retry now gets the session that runs on the Mac.
    const replay = await create(linux, body, { key: "xcode-1" });
    expect(replay.status).toBe(201);
    expect(mac.created).toHaveLength(1);
  });

  test("back without Xcode it is blocked and nothing is sent; with Xcode again it starts", async () => {
    const { linux, mac } = await pair();
    await sleep(mac, linux);
    await create(linux, task(linux, { requirements: ["xcode"] }));
    mac.ok = mac.ok.filter((c) => c !== "xcode");
    await wake(mac, linux);
    const [blocked] = await until(
      () => waiting(linux),
      (l) => l[0]?.readiness?.state === "missing_capabilities",
    );
    expect(blocked).toMatchObject({
      state: "waiting",
      readiness: { missing: [{ capability: "xcode", reason: "not_installed" }] },
    });
    expect(mac.created).toEqual([]);
    mac.ok.push("xcode");
    await linux.deps.remoteInstances.check(mac.id);
    await until(
      () => mac.created.length,
      (n) => n === 1,
    );
  });

  test("while it waits: an unfit machine is refused, a cancel makes sure it never starts", async () => {
    const { linux, mac } = await pair();
    await sleep(mac, linux);
    const { body } = await create(linux, task(linux, { requirements: ["xcode"] }));
    const id = body.id as string;
    // Linux has no Xcode: refused with the reason, and it keeps waiting.
    const unfit = await redirect(linux, id, linux.id);
    expect(unfit.status).toBe(422);
    expect(unfit.body).toMatchObject({
      code: "missing_capabilities",
      host: { instanceId: linux.id },
      missing: [{ capability: "xcode" }],
    });
    expect((await redirect(linux, id, "nope")).body).toMatchObject({
      code: "remote_target_unknown",
    });
    // The Mac is asleep: not a machine to run it on now either.
    expect((await redirect(linux, id, mac.id)).body).toMatchObject({
      code: "remote_target_unavailable",
    });
    expect((await redirect(linux, "nope", linux.id)).status).toBe(404);
    expect((await call(linux, "POST", `/api/remote-dispatches/${id}/redirect`, {})).status).toBe(
      400,
    );
    expect((await waiting(linux)).map((d) => d.state)).toEqual(["waiting"]);

    const canceled = await call(linux, "DELETE", `/api/remote-dispatches/${id}`);
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({ state: "canceled" });
    expect(await waiting(linux)).toEqual([]);
    const late = await redirect(linux, id, linux.id);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({
      code: "remote_dispatch_not_redirectable",
      dispatch: { state: "canceled" },
    });
    await wake(mac, linux);
    await Bun.sleep(50);
    expect(ranOn([linux, mac])).toEqual([]);
  });

  test("Linux only preferred and asleep: no fallback, the Mac is offered and taken by hand", async () => {
    const { linux, mac } = await pair();
    await sleep(linux, mac);
    const body = task(mac);
    const res = await create(mac, body, { key: "web-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      waiting: true,
      host: { instanceId: linux.id },
      dispatch: {
        placement: { basis: "preference", preferred: "linux" },
        alternatives: [{ instanceId: mac.id }],
      },
    });
    expect((await preview(mac)).body).toMatchObject({
      placement: { target: { instanceId: linux.id } },
      wait: { alternatives: [{ instanceId: mac.id }] },
    });
    expect(ranOn([linux, mac])).toEqual([]);

    // Taken by hand to the Mac — this Shepherd — under the task's own key.
    const moved = await redirect(mac, res.body.id as string, mac.id);
    expect(moved.status).toBe(201);
    expect(mac.created).toHaveLength(1);
    expect(mac.created[0]).toMatchObject({ placement: { mode: "manual", basis: "manual" } });
    expect(await waiting(mac)).toEqual([]);
    // The original create, retried under its key, replays that start.
    const replay = await create(mac, body, { key: "web-1" });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(moved.body.id);
    expect(mac.created).toHaveLength(1);
    // Linux back: nothing goes there.
    await wake(linux, mac);
    await Bun.sleep(50);
    expect(linux.created).toEqual([]);
  });

  test("redirected to another fitting machine, it runs there once and never on the first", async () => {
    const { linux, mac } = await pair();
    const box = startNode("app-box", "linux", ["platform:linux", "agent:claude"]);
    await connect(mac, box);
    box.id = await instanceId(box);
    // The one the order prefers (lower ID among the two Linux machines) is asleep.
    const [first, second] = [linux, box].sort((a, b) => (a.id < b.id ? -1 : 1)) as [Node, Node];
    await sleep(first, mac);
    const res = await create(mac, task(mac), { key: "web-2" });
    expect(res.body).toMatchObject({
      waiting: true,
      host: { instanceId: first.id },
      dispatch: { alternatives: [{ instanceId: second.id }, { instanceId: mac.id }] },
    });
    const id = res.body.id as string;
    const moved = await redirect(mac, id, second.id);
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ host: { instanceId: second.id } });
    expect(second.created).toHaveLength(1);
    expect(second.created[0]).toMatchObject({ placement: { mode: "manual" } });
    expect(await waiting(mac)).toEqual([]);
    // Started there: no longer redirectable, and the first machine never gets it.
    expect((await redirect(mac, id, mac.id)).status).toBe(409);
    await wake(first, mac);
    await Bun.sleep(50);
    expect(first.created).toEqual([]);
    expect(mac.created).toEqual([]);
  });

  test("a restart of the coordinator keeps it waiting, and it starts once", async () => {
    const { linux, mac } = await pair();
    await sleep(mac, linux);
    await create(linux, task(linux, { requirements: ["xcode"] }), { key: "xcode-2" });
    // Restarted: a fresh dispatcher over the same store, nothing in memory.
    linux.deps.remoteDispatch = new RemoteDispatcher({
      store: linux.deps.store,
      instances: linux.deps.remoteInstances,
      events: linux.deps.events,
    });
    expect((await waiting(linux)).map((d) => [d.state, d.readiness?.state])).toEqual([
      ["waiting", "offline"],
    ]);
    await wake(mac, linux);
    await until(
      () => mac.created.length,
      (n) => n === 1,
    );
    await linux.deps.remoteInstances.check(mac.id);
    await Bun.sleep(50);
    expect(mac.created).toHaveLength(1);
  });

  test("offline, busy, missing capability and start status unknown are told apart", async () => {
    const { linux, mac } = await pair();
    const seen: [string, string | undefined][] = [];
    const snapshot = async () => {
      const [d] = await waiting(linux);
      seen.push([d!.state, d!.readiness?.state]);
      return d!;
    };
    // Offline: the Mac sleeps.
    await sleep(mac, linux);
    const { body } = await create(linux, task(linux, { requirements: ["xcode"] }));
    await snapshot();
    // Missing capability: back, but without Xcode.
    mac.ok = mac.ok.filter((c) => c !== "xcode");
    await wake(mac, linux);
    await until(
      () => waiting(linux),
      (l) => l[0]?.readiness?.state === "missing_capabilities",
    );
    await snapshot();
    await call(linux, "DELETE", `/api/remote-dispatches/${body.id as string}`);
    // Busy: the Mac holds the task (its capacity).
    mac.deps.codexCapacity = async () => false;
    const codex = { agentProvider: "codex", model: null, effort: null };
    const held = await create(linux, { ...task(linux, codex), target: { instanceId: mac.id } });
    expect(held.body).toMatchObject({ held: true, host: { instanceId: mac.id } });
    expect(held.body).not.toHaveProperty("waiting");
    const busy = await snapshot();
    expect(busy).toMatchObject({ state: "held", heldId: held.body.id });
    // A cancel discards it there.
    const cancel = await call(linux, "DELETE", `/api/remote-dispatches/${busy.id}`);
    expect(cancel.body).toMatchObject({ state: "canceled" });
    expect(mac.deps.store.listHeldTasks()).toEqual([]);
    // Start status unknown: the answer is lost on the way back.
    linux.dropCreate = true;
    const lost = await create(linux, { ...task(linux), target: { instanceId: mac.id } });
    expect(lost.status).toBe(504);
    await snapshot();

    expect(seen).toEqual([
      ["waiting", "offline"],
      ["waiting", "missing_capabilities"],
      ["held", undefined],
      ["unknown", undefined],
    ]);
  });
});
