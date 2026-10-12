import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionStore } from "../src/store";
import type { FetchLike } from "../src/remote-instances/client";
import {
  RemoteDispatcher,
  type RemoteDispatchRow,
  type RemoteDispatchView,
  type RemoteSubmit,
  waitingAttachments,
} from "../src/remote-instances/dispatch";
import type { RemoteInstanceSummary } from "../src/remote-instances/service";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityReport,
} from "../src/remote-instances/capabilities";
import { localMachine } from "../src/remote-instances/placement";

// The coordinator's side of a task sent to a connected machine (#2763), against a scripted fetch:
// pre-flight and path mapping, stored before sent, the outcome vocabulary, and retries that only
// ever go out again under the same dispatch ID to the same machine.

const MAC = "11111111-1111-4111-8111-111111111111";
const LINUX = "22222222-2222-4222-8222-222222222222";

function machine(
  instanceId: string,
  over: Partial<RemoteInstanceSummary> = {},
): RemoteInstanceSummary {
  return {
    instanceId,
    name: instanceId === MAC ? "MacBook" : "moes-tavern",
    label: null,
    reportedName: "x",
    url: `http://${instanceId === MAC ? "mac" : "linux"}.test`,
    tokenHint: null,
    createdAt: 1,
    status: "connected",
    reason: null,
    checkedAt: 1,
    lastSeenAt: 1,
    info: { version: "2.2.0", federationApi: 1, platform: "macos", arch: "arm64" },
    projects: ["acme/app"],
    capabilities: null,
    released: true,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** The JSON text as sent, for a JSON POST. */
  raw: string | null;
  /** The multipart body, for an upload. */
  form: FormData | null;
}

type Answer = Response | Error | ((call: Call) => Response | Error);

/** A fetch that records every request and answers `/api/repos` with a checkout of acme/app and
 *  `POST /api/sessions` from `posts`, in order. */
function scripted(posts: Answer[], repos: Answer = reposAnswer("/Users/kai/dev/app")) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      url: input,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      raw: typeof init.body === "string" ? init.body : null,
      form: init.body instanceof FormData ? init.body : null,
    };
    calls.push(call);
    let answer = input.endsWith("/api/repos") ? repos : posts.shift();
    if (typeof answer === "function") answer = answer(call);
    if (!answer) throw new Error(`unexpected ${call.method} ${input}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    fetch,
    calls,
    posts: () => calls.filter((c) => c.method === "POST"),
    uploads: () => calls.filter((c) => c.url.endsWith("/api/uploads")),
    creates: () => calls.filter((c) => c.url.endsWith("/api/sessions")),
  };
}

function reposAnswer(path: string): Response {
  return Response.json({
    repos: [
      { path: "/Users/kai/dev/other", remoteSlug: "acme/other" },
      { path, remoteSlug: "acme/app" },
      { path: "/Users/kai/dev/app-clone", remoteSlug: "acme/app" },
    ],
  });
}

function setup(
  fetch: FetchLike,
  machines: RemoteInstanceSummary[] = [machine(MAC)],
): { store: SessionStore; dispatcher: RemoteDispatcher; events: [string, unknown][] } {
  const store = new SessionStore(":memory:");
  for (const m of machines) {
    store.insertRemoteInstance({
      instanceId: m.instanceId,
      url: m.url,
      token: `token-${m.instanceId}`,
      label: null,
      reportedName: m.name,
      createdAt: 1,
    });
  }
  const instances = {
    get: (id: string) => machines.find((m) => m.instanceId === id) ?? null,
    list: () => machines,
    noteCapabilities: () => {},
  };
  const events: [string, unknown][] = [];
  const hub = { emit: (event: string, data: unknown) => void events.push([event, data]) };
  return {
    store,
    events,
    dispatcher: new RemoteDispatcher({ store, instances, events: hub, fetch, now: () => 42 }),
  };
}

const BODY = {
  repoPath: "/home/moe/projects/app",
  baseBranch: "main",
  prompt: "build it",
  research: true,
  planGateEnabled: false,
};

function submit(over: Partial<RemoteSubmit> = {}): RemoteSubmit {
  return {
    clientKey: "key-1",
    instanceId: MAC,
    project: "acme/app",
    body: BODY,
    payloadHash: "hash-1",
    ...over,
  };
}

const session = (id: string) =>
  Response.json({ id, desig: "TASK-01", status: "running" }, { status: 201 });

describe("RemoteDispatcher", () => {
  test("maps the project onto the machine's own checkout and sends everything else verbatim", async () => {
    const net = scripted([session("s-1")]);
    const { dispatcher } = setup(net.fetch);
    const outcome = await dispatcher.submit(submit());

    expect(outcome).toEqual({
      kind: "started",
      session: {
        id: "s-1",
        desig: "TASK-01",
        status: "running",
        host: { instanceId: MAC, name: "MacBook", platform: "macos" },
        connection: { state: "connected", since: 42 },
      },
    });
    const [post] = net.posts();
    expect(post!.url).toBe("http://mac.test/api/sessions");
    // `target` names the machine itself (#2772): it runs the task and never places it again.
    expect(post!.body).toEqual({
      ...BODY,
      repoPath: "/Users/kai/dev/app",
      target: { instanceId: MAC },
    });
    expect(post!.headers.authorization).toBe(`Bearer token-${MAC}`);
    // The machine gets the dispatch ID generated here, never the client's key.
    expect(post!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post!.headers["idempotency-key"]).not.toBe("key-1");
  });

  test("the dispatch is stored before it is sent", async () => {
    let seen: unknown = "not called";
    const net = scripted([
      () => {
        seen = store.getRemoteDispatchByKey("key-1");
        return session("s-1");
      },
    ]);
    const { store, dispatcher } = setup(net.fetch);
    await dispatcher.submit(submit());
    expect(seen).toMatchObject({ clientKey: "key-1", instanceId: MAC, state: "sending" });
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      state: "started",
      sessionId: "s-1",
    });
  });

  test("a hold on the machine is reported with the machine", async () => {
    const net = scripted([Response.json({ held: true, id: "h-1", count: 3 })]);
    const { store, dispatcher } = setup(net.fetch);
    expect(await dispatcher.submit(submit())).toEqual({
      kind: "held",
      id: "h-1",
      count: 3,
      host: { instanceId: MAC, name: "MacBook", platform: "macos" },
    });
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({ state: "held", heldId: "h-1" });
  });

  test("a refusal by the machine carries its reason and is final", async () => {
    const net = scripted([
      Response.json({ error: "base branch main not found", code: "base_missing" }, { status: 422 }),
    ]);
    const { store, dispatcher } = setup(net.fetch);
    expect(await dispatcher.submit(submit())).toMatchObject({
      kind: "rejected",
      reason: "base branch main not found",
      remoteStatus: 422,
      remoteCode: "base_missing",
    });
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      state: "rejected",
      reason: "base branch main not found",
      httpStatus: 422,
    });
  });

  test("no answer is unknown; the retry goes to the same machine under the same dispatch ID", async () => {
    const net = scripted([new TypeError("socket closed"), session("s-1")]);
    // A second machine has the project too — it must never see this task.
    const { store, dispatcher } = setup(net.fetch, [machine(MAC), machine(LINUX)]);
    const first = await dispatcher.submit(submit());
    expect(first).toMatchObject({ kind: "unknown", dispatchKey: "key-1" });
    expect(store.getRemoteDispatchByKey("key-1")!.state).toBe("unknown");

    const again = await dispatcher.submit(submit());
    expect(again).toMatchObject({ kind: "started", session: { id: "s-1" } });
    const [a, b] = net.posts();
    expect(b!.url).toBe(a!.url);
    expect(b!.headers["idempotency-key"]).toBe(a!.headers["idempotency-key"]);
    expect(b!.body).toEqual(a!.body);
    expect(net.calls.some((c) => c.url.startsWith("http://linux.test"))).toBe(false);
    // The retry used the stored body: the project was not mapped a second time.
    expect(net.calls.filter((c) => c.url.endsWith("/api/repos"))).toHaveLength(1);
  });

  test("a non-JSON answer (a proxy page) leaves the dispatch unknown", async () => {
    const net = scripted([new Response("<html>bad gateway</html>", { status: 502 })]);
    const { dispatcher } = setup(net.fetch);
    expect(await dispatcher.submit(submit())).toMatchObject({ kind: "unknown" });
  });

  test("a retry that gets no answer never downgrades a known outcome", async () => {
    const net = scripted([session("s-1"), new TypeError("down")]);
    const { store, dispatcher } = setup(net.fetch);
    await dispatcher.submit(submit());
    expect(await dispatcher.submit(submit())).toMatchObject({ kind: "unknown" });
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      state: "started",
      sessionId: "s-1",
    });
  });

  test("the same key with a different body is refused and nothing is sent", async () => {
    const net = scripted([session("s-1")]);
    const { dispatcher } = setup(net.fetch);
    await dispatcher.submit(submit());
    const before = net.calls.length;
    expect(await dispatcher.submit(submit({ payloadHash: "hash-2" }))).toEqual({
      kind: "refused",
      code: "dispatch_payload_mismatch",
      reason: null,
    });
    expect(net.calls).toHaveLength(before);
  });

  test("concurrent duplicates share one send", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = scripted([session("s-1")]);
    const slow: FetchLike = async (input, init) => {
      if (init.method === "POST") await gate;
      return net.fetch(input, init);
    };
    const { dispatcher } = setup(slow);
    const one = dispatcher.submit(submit());
    await Bun.sleep(5);
    const two = dispatcher.submit(submit());
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(a).toEqual(b);
    expect(net.posts()).toHaveLength(1);
  });

  test("a dispatch left sending by a restart is sent again with its stored ID", async () => {
    const net = scripted([session("s-1")]);
    const { store, dispatcher } = setup(net.fetch);
    store.insertRemoteDispatch({
      id: "d-1",
      clientKey: "key-1",
      instanceId: MAC,
      payloadHash: "hash-1",
      wireBody: JSON.stringify({ ...BODY, repoPath: "/Users/kai/dev/app" }),
      state: "sending",
      sessionId: null,
      heldId: null,
      reason: null,
      code: null,
      httpStatus: null,
      createdAt: 1,
      updatedAt: 1,
      uploads: null,
      project: "acme/app",
    });
    expect(await dispatcher.submit(submit())).toMatchObject({ kind: "started" });
    expect(net.posts()[0]!.headers["idempotency-key"]).toBe("d-1");
  });

  test("without a client key a fresh one is generated and reported for the retry", async () => {
    const net = scripted([new TypeError("down")]);
    const { store, dispatcher } = setup(net.fetch);
    const outcome = await dispatcher.submit(submit({ clientKey: undefined }));
    expect(outcome.kind).toBe("unknown");
    const key = (outcome as { dispatchKey: string }).dispatchKey;
    expect(store.getRemoteDispatchByKey(key)).not.toBeNull();
  });

  describe("pre-flight refusals store and send nothing", () => {
    const cases: [string, RemoteInstanceSummary[], Answer | undefined, string][] = [
      ["an unknown machine", [], undefined, "remote_target_unknown"],
      [
        "a machine that is not connected",
        [machine(MAC, { status: "unreachable", reason: "timeout" })],
        undefined,
        "remote_target_unavailable",
      ],
      [
        "a connected machine whose platform is not released (Windows, #2770)",
        [
          machine(MAC, {
            info: { version: "2.2.0", federationApi: 1, platform: "windows", arch: "x64" },
            released: false,
          }),
        ],
        undefined,
        "remote_target_unreleased",
      ],
      [
        "a machine without the project",
        [machine(MAC, { projects: ["acme/other"] })],
        undefined,
        "remote_project_missing",
      ],
      [
        "a machine whose repo list cannot be read",
        [machine(MAC)],
        new TypeError("down"),
        "remote_target_unavailable",
      ],
      [
        "a machine whose repo list lost the project",
        [machine(MAC)],
        Response.json({ repos: [] }),
        "remote_project_missing",
      ],
    ];
    for (const [name, machines, repos, code] of cases) {
      test(name, async () => {
        const net = scripted([], repos);
        const { store, dispatcher } = setup(net.fetch, machines);
        expect(await dispatcher.submit(submit())).toMatchObject({ kind: "refused", code });
        expect(net.posts()).toHaveLength(0);
        expect(store.getRemoteDispatchByKey("key-1")).toBeNull();
      });
    }
  });

  test("a Windows machine is refused with its platform as the reason, before its repos are read", async () => {
    const net = scripted([]);
    const windows = machine(MAC, {
      info: { version: "2.2.0", federationApi: 1, platform: "windows", arch: "x64" },
      released: false,
    });
    const { dispatcher } = setup(net.fetch, [windows]);
    expect(await dispatcher.submit(submit())).toEqual({
      kind: "refused",
      code: "remote_target_unreleased",
      reason: "windows",
    });
    expect(net.calls).toHaveLength(0);
  });

  test("a stored dispatch whose machine was removed is refused, never sent elsewhere", async () => {
    const net = scripted([new TypeError("down")]);
    const { store, dispatcher } = setup(net.fetch, [machine(MAC), machine(LINUX)]);
    await dispatcher.submit(submit());
    store.deleteRemoteInstance(MAC);
    expect(await dispatcher.submit(submit())).toEqual({
      kind: "refused",
      code: "remote_target_unavailable",
      reason: "removed",
    });
    expect(net.posts()).toHaveLength(1);
  });
});

// #2774: a dispatch no machine has confirmed is reconciled with its machine — never sent anywhere
// else, never started twice — and can be cancelled so a late arrival never starts.
describe("RemoteDispatcher start status unknown", () => {
  const HOST = { instanceId: MAC, name: "MacBook", platform: "macos" };
  const WIRE = JSON.stringify({ ...BODY, repoPath: "/Users/kai/dev/app" });

  function stored(store: SessionStore, over: Partial<RemoteDispatchRow> = {}): RemoteDispatchRow {
    const row: RemoteDispatchRow = {
      id: "d-1",
      clientKey: "key-1",
      instanceId: MAC,
      payloadHash: "hash-1",
      wireBody: WIRE,
      state: "unknown",
      sessionId: null,
      heldId: null,
      reason: null,
      code: null,
      httpStatus: null,
      createdAt: 1,
      updatedAt: 1,
      uploads: null,
      project: "acme/app",
      ...over,
    };
    store.insertRemoteDispatch(row);
    return row;
  }

  /** The machine's record of a dispatch, as its GET /api/dispatches/{id} answers (#2761). */
  const record = (fields: Record<string, unknown>, status = 200) =>
    Response.json({ id: "d-1", createdAt: 1, updatedAt: 2, ...fields }, { status });

  const states = (events: [string, unknown][]) =>
    events.map(([event, data]) => [event, (data as { state: string }).state]);

  test("a dispatch its machine started settles as started — asked, not sent again", async () => {
    const net = scripted([record({ state: "started", sessionId: "s-1" })]);
    const { store, dispatcher, events } = setup(net.fetch);
    stored(store);
    expect(dispatcher.list()).toEqual([
      {
        id: "d-1",
        state: "unknown",
        host: HOST,
        summary: "build it",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await dispatcher.reconcile(MAC);
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://mac.test/api/dispatches/d-1",
    ]);
    expect(net.calls[0]!.headers.authorization).toBe(`Bearer token-${MAC}`);
    expect(store.getRemoteDispatch("d-1")).toMatchObject({ state: "started", sessionId: "s-1" });
    expect(events).toEqual([
      [
        "remote:dispatch",
        {
          id: "d-1",
          state: "started",
          host: HOST,
          summary: "build it",
          sessionId: "s-1",
          createdAt: 1,
          updatedAt: 42,
        },
      ],
    ]);
    expect(dispatcher.list()).toEqual([]);
  });

  test("held or failed there settles as held or rejected with the machine's reason", async () => {
    const answer = (call: Call) =>
      call.url.endsWith("/d-1")
        ? record({ state: "held", heldId: "h-1" })
        : record({
            id: "d-2",
            state: "failed",
            reason: "Shepherd restarted before this start finished",
            code: "dispatch_interrupted",
          });
    const net = scripted([answer, answer]);
    const { store, dispatcher } = setup(net.fetch);
    stored(store);
    stored(store, { id: "d-2", clientKey: "key-2" });
    await dispatcher.reconcile(MAC);
    expect(store.getRemoteDispatch("d-1")).toMatchObject({ state: "held", heldId: "h-1" });
    expect(store.getRemoteDispatch("d-2")).toMatchObject({
      state: "rejected",
      reason: "Shepherd restarted before this start finished",
      code: "dispatch_interrupted",
    });
    expect(net.posts()).toEqual([]);
  });

  test("never arrived (404): the same task again, under the same ID, to the same machine", async () => {
    const net = scripted([Response.json({ error: "not found" }, { status: 404 }), session("s-1")]);
    const { store, dispatcher, events } = setup(net.fetch, [machine(MAC), machine(LINUX)]);
    stored(store);
    await dispatcher.reconcile(MAC);
    const [post] = net.posts();
    expect(post!.url).toBe("http://mac.test/api/sessions");
    expect(post!.headers["idempotency-key"]).toBe("d-1");
    expect(post!.raw).toBe(WIRE);
    expect(net.calls.some((c) => c.url.startsWith("http://linux.test"))).toBe(false);
    expect(store.getRemoteDispatch("d-1")).toMatchObject({ state: "started", sessionId: "s-1" });
    expect(states(events)).toEqual([["remote:dispatch", "started"]]);
  });

  test("still starting there, an error or no answer leaves it unknown for the next check", async () => {
    const net = scripted([
      record({ state: "pending" }),
      Response.json({ error: "boom" }, { status: 500 }),
      new TypeError("down"),
    ]);
    const { store, dispatcher, events } = setup(net.fetch);
    stored(store);
    for (let i = 0; i < 3; i++) await dispatcher.reconcile(MAC);
    expect(net.calls.filter((c) => c.method === "GET")).toHaveLength(3);
    expect(net.posts()).toEqual([]);
    expect(store.getRemoteDispatch("d-1")!.state).toBe("unknown");
    expect(events).toEqual([]);
  });

  test("a machine that is not connected is not asked", async () => {
    const net = scripted([]);
    const { store, dispatcher } = setup(net.fetch, [machine(MAC, { status: "unreachable" })]);
    stored(store);
    await dispatcher.reconcile(MAC);
    await dispatcher.reconcile(LINUX);
    expect(net.calls).toEqual([]);
  });

  test("a dispatch left sending by a restart reads unknown and is reconciled", async () => {
    const net = scripted([record({ state: "started", sessionId: "s-1" })]);
    const { store, dispatcher, events } = setup(net.fetch);
    stored(store, { state: "sending" });
    expect(dispatcher.list().map((d) => d.state)).toEqual(["unknown"]);
    await dispatcher.reconcile(MAC);
    expect(store.getRemoteDispatch("d-1")!.state).toBe("started");
    expect(states(events)).toEqual([["remote:dispatch", "started"]]);
  });

  test("only what dashboards show is announced: unknown, and how it resolves", async () => {
    // Two fresh submissions read the repo list twice: a fresh answer each time.
    const net = scripted([session("s-1"), new TypeError("down"), session("s-2")], () =>
      reposAnswer("/Users/kai/dev/app"),
    );
    const { dispatcher, events } = setup(net.fetch);
    await dispatcher.submit(submit());
    expect(events).toEqual([]);
    await dispatcher.submit(submit({ clientKey: "key-2", payloadHash: "hash-2" }));
    await dispatcher.submit(submit({ clientKey: "key-2", payloadHash: "hash-2" }));
    expect(states(events)).toEqual([
      ["remote:dispatch", "unknown"],
      ["remote:dispatch", "started"],
    ]);
  });

  test("a dispatch being sent here is neither listed nor checked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = scripted([session("s-1")]);
    const slow: FetchLike = async (input, init) => {
      if (init.method === "POST") await gate;
      return net.fetch(input, init);
    };
    const { dispatcher } = setup(slow);
    const sent = dispatcher.submit(submit());
    await Bun.sleep(5);
    expect(dispatcher.list()).toEqual([]);
    await dispatcher.reconcile(MAC);
    expect(net.calls.filter((c) => c.url.includes("/api/dispatches/"))).toEqual([]);
    release();
    expect(await sent).toMatchObject({ kind: "started" });
  });

  test("the list holds only unconfirmed dispatches of machines still connected here", async () => {
    const net = scripted([]);
    const { store, dispatcher } = setup(net.fetch);
    const long = "x".repeat(200);
    stored(store, {
      wireBody: JSON.stringify({ ...BODY, issueRef: { number: 7, title: "Fix the login" } }),
    });
    stored(store, {
      id: "d-2",
      clientKey: "key-2",
      state: "canceling",
      createdAt: 2,
      wireBody: JSON.stringify({ ...BODY, prompt: `\n  ${long}\nmore` }),
    });
    stored(store, { id: "d-3", clientKey: "key-3", state: "started", sessionId: "s-3" });
    stored(store, { id: "d-4", clientKey: "key-4", instanceId: LINUX });
    expect(dispatcher.list().map((d) => [d.id, d.state, d.summary])).toEqual([
      ["d-1", "unknown", "Fix the login"],
      ["d-2", "canceling", `${"x".repeat(119)}…`],
    ]);
  });

  test("a cancel the machine confirms: never sent again, never checked again", async () => {
    const net = scripted([record({ state: "failed", code: "dispatch_canceled" })]);
    const { store, dispatcher, events } = setup(net.fetch);
    stored(store);
    expect(await dispatcher.cancel("d-1")).toMatchObject({
      kind: "canceled",
      dispatch: { id: "d-1", state: "canceled", host: HOST },
    });
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE http://mac.test/api/dispatches/d-1",
    ]);
    expect(states(events)).toEqual([
      ["remote:dispatch", "canceling"],
      ["remote:dispatch", "canceled"],
    ]);

    // The client's retry under its key is refused here; the machine is not asked again.
    expect(await dispatcher.submit(submit())).toEqual({ kind: "canceled", host: HOST });
    await dispatcher.reconcile(MAC);
    expect(await dispatcher.cancel("d-1")).toMatchObject({ kind: "canceled" });
    expect(net.calls).toHaveLength(1);
    expect(dispatcher.list()).toEqual([]);
  });

  test("out of reach, the cancel waits and the next check delivers it — no GET, no POST", async () => {
    const net = scripted([new TypeError("down"), record({ state: "failed" })]);
    const { store, dispatcher } = setup(net.fetch);
    stored(store);
    expect(await dispatcher.cancel("d-1")).toMatchObject({
      kind: "canceling",
      dispatch: { state: "canceling" },
    });
    // Not confirmed yet: it may have reached the machine first, so a retry is promised nothing —
    // and is not sent either.
    expect(await dispatcher.submit(submit())).toEqual({ kind: "cancel_pending", host: HOST });
    await dispatcher.reconcile(MAC);
    expect(net.calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
    expect(store.getRemoteDispatch("d-1")!.state).toBe("canceled");
    expect(await dispatcher.submit(submit())).toEqual({ kind: "canceled", host: HOST });
  });

  test("a machine that is not connected gets the cancel later, without a request now", async () => {
    const net = scripted([]);
    const { store, dispatcher } = setup(net.fetch, [machine(MAC, { status: "unreachable" })]);
    stored(store, { state: "sending" });
    expect(await dispatcher.cancel("d-1")).toMatchObject({ kind: "canceling" });
    expect(net.calls).toEqual([]);
  });

  test("a dispatch the machine already has cannot be cancelled; what it became there counts", async () => {
    const arrived = (dispatch: Record<string, unknown>) =>
      Response.json(
        { error: "dispatch already arrived", code: "dispatch_arrived", dispatch },
        { status: 409 },
      );
    const net = scripted([
      arrived({ id: "d-1", state: "started", sessionId: "s-1" }),
      arrived({ id: "d-2", state: "pending" }),
    ]);
    const { store, dispatcher } = setup(net.fetch);
    stored(store);
    stored(store, { id: "d-2", clientKey: "key-2" });
    expect(await dispatcher.cancel("d-1")).toMatchObject({
      kind: "not_cancelable",
      dispatch: { state: "started", sessionId: "s-1" },
    });
    // Still starting there: unknown again, for the next check to follow.
    expect(await dispatcher.cancel("d-2")).toMatchObject({
      kind: "not_cancelable",
      dispatch: { state: "unknown" },
    });
    expect(store.getRemoteDispatch("d-2")!.state).toBe("unknown");
  });

  test("an unknown id, a settled dispatch or one of a removed machine is not cancelled", async () => {
    const net = scripted([]);
    const { store, dispatcher } = setup(net.fetch);
    stored(store, { state: "started", sessionId: "s-1" });
    stored(store, { id: "d-2", clientKey: "key-2", instanceId: LINUX });
    expect(await dispatcher.cancel("nope")).toEqual({ kind: "not_found" });
    expect(await dispatcher.cancel("d-2")).toEqual({ kind: "not_found" });
    expect(await dispatcher.cancel("d-1")).toMatchObject({
      kind: "not_cancelable",
      dispatch: { state: "started" },
    });
    expect(net.calls).toEqual([]);
  });

  test("a retry while a cancel is on its way waits for it, then is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = scripted([record({ state: "failed" })]);
    const slow: FetchLike = async (input, init) => {
      if (init.method === "DELETE") await gate;
      return net.fetch(input, init);
    };
    const { store, dispatcher } = setup(slow);
    stored(store);
    const canceling = dispatcher.cancel("d-1");
    await Bun.sleep(5);
    const retry = dispatcher.submit(submit());
    await dispatcher.reconcile(MAC);
    release();
    expect(await canceling).toMatchObject({ kind: "canceled" });
    expect(await retry).toEqual({ kind: "canceled", host: HOST });
    expect(net.calls.map((c) => c.method)).toEqual(["DELETE"]);
  });
});

// #2766: a task's attachments reach the machine right before the task does, and only once.
describe("RemoteDispatcher attachments", () => {
  const HOST = { instanceId: MAC, name: "MacBook", platform: "macos" };
  const MAC_STAGING = "/Users/kai/dev/.shepherd-uploads-staging";
  let dir: string;
  let shot: string;
  let spec: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-remote-uploads-"));
    shot = join(dir, "0b5e-shot.png");
    spec = join(dir, "7c1d-spec.pdf");
    writeFileSync(shot, "PNG-BYTES");
    writeFileSync(spec, "PDF-BYTES");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const uploaded = (name: string) => Response.json({ path: `${MAC_STAGING}/${name}` });

  function withAttachments(images: string[]): RemoteSubmit {
    const attachmentNames = images.map((_, i) => `Attachment ${i + 1}.png`);
    return submit({ body: { ...BODY, images, attachmentNames } });
  }

  test("each file goes to the machine's staging first, and the task names the machine's copies", async () => {
    const net = scripted([uploaded("m-1.png"), uploaded("m-2.pdf"), session("s-1")]);
    const { store, dispatcher } = setup(net.fetch);
    const outcome = await dispatcher.submit(withAttachments([shot, spec]));
    expect(outcome).toMatchObject({ kind: "started", session: { id: "s-1" } });

    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://mac.test/api/repos",
      "POST http://mac.test/api/uploads",
      "POST http://mac.test/api/uploads",
      "POST http://mac.test/api/sessions",
    ]);
    // As it goes over the wire: the bytes and the extension — not this machine's staged name.
    const wire = await Promise.all(net.uploads().map((c) => new Response(c.form).text()));
    expect(wire.map((w) => w.match(/name="file"; filename="([^"]*)"/)?.[1])).toEqual([
      "attachment.png",
      "attachment.pdf",
    ]);
    for (const w of wire) expect(w).not.toContain(basename(shot));
    expect(wire[0]).toContain("PNG-BYTES");
    expect(wire[1]).toContain("PDF-BYTES");
    for (const w of wire) expect(w).not.toContain(dir);
    expect(net.uploads()[0]!.headers.authorization).toBe(`Bearer token-${MAC}`);

    const [create] = net.creates();
    expect(create!.body).toEqual({
      ...BODY,
      repoPath: "/Users/kai/dev/app",
      images: [`${MAC_STAGING}/m-1.png`, `${MAC_STAGING}/m-2.pdf`],
      attachmentNames: ["Attachment 1.png", "Attachment 2.png"],
      target: { instanceId: MAC },
    });
    // No path of this machine reaches the other one.
    expect(create!.raw).not.toContain(dir);
    expect(JSON.parse(store.getRemoteDispatchByKey("key-1")!.uploads!)).toEqual([
      `${MAC_STAGING}/m-1.png`,
      `${MAC_STAGING}/m-2.pdf`,
    ]);
  });

  test("a retry after no answer uploads nothing again and sends the very same text", async () => {
    const net = scripted([uploaded("m-1.png"), new TypeError("socket closed"), session("s-1")]);
    const { dispatcher } = setup(net.fetch);
    expect(await dispatcher.submit(withAttachments([shot]))).toMatchObject({ kind: "unknown" });
    expect(await dispatcher.submit(withAttachments([shot]))).toMatchObject({ kind: "started" });

    expect(net.uploads()).toHaveLength(1);
    const [a, b] = net.creates();
    // Byte-identical, so the machine's own idempotency check (#2761) replays instead of a 409.
    expect(b!.raw).toBe(a!.raw);
    expect(b!.headers["idempotency-key"]).toBe(a!.headers["idempotency-key"]);
  });

  test("concurrent duplicates share one upload", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = scripted([uploaded("m-1.png"), session("s-1")]);
    const slow: FetchLike = async (input, init) => {
      if (input.endsWith("/api/uploads")) await gate;
      return net.fetch(input, init);
    };
    const { dispatcher } = setup(slow);
    const one = dispatcher.submit(withAttachments([shot]));
    await Bun.sleep(5);
    const two = dispatcher.submit(withAttachments([shot]));
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(a).toEqual(b);
    expect(net.uploads()).toHaveLength(1);
    expect(net.creates()).toHaveLength(1);
  });

  test("a file the machine refuses ends the dispatch before the task is sent, for good", async () => {
    const net = scripted([
      uploaded("m-1.png"),
      Response.json({ error: "file too large" }, { status: 413 }),
    ]);
    const { store, dispatcher } = setup(net.fetch);
    const failed = {
      kind: "upload_failed" as const,
      host: HOST,
      reason: "attachment 2 of 2: the machine answered 413 (file too large)",
    };
    expect(await dispatcher.submit(withAttachments([shot, spec]))).toEqual(failed);
    expect(net.creates()).toEqual([]);
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      state: "upload_failed",
      code: "remote_upload_failed",
      reason: failed.reason,
      httpStatus: 413,
      uploads: null,
    });

    // The same key again: the refusal, with nothing sent or uploaded.
    const before = net.calls.length;
    expect(await dispatcher.submit(withAttachments([shot, spec]))).toEqual(failed);
    expect(net.calls).toHaveLength(before);
  });

  test("no answer to an upload, or a staged file that is gone, fails the same way", async () => {
    const down = scripted([new TypeError("down")]);
    expect(await setup(down.fetch).dispatcher.submit(withAttachments([shot]))).toEqual({
      kind: "upload_failed",
      host: HOST,
      reason: "attachment 1 of 1: no answer from the machine (network)",
    });
    expect(down.creates()).toEqual([]);

    const gone = scripted([]);
    const missing = join(dir, "swept.png");
    expect(await setup(gone.fetch).dispatcher.submit(withAttachments([missing]))).toEqual({
      kind: "upload_failed",
      host: HOST,
      reason: "attachment 1 of 1 is no longer staged here",
    });
    expect(gone.posts()).toEqual([]);
  });

  test("a task without attachments goes out exactly as stored", async () => {
    const net = scripted([session("s-1")]);
    const { store, dispatcher } = setup(net.fetch);
    await dispatcher.submit(submit());
    const row = store.getRemoteDispatchByKey("key-1")!;
    expect(net.creates()[0]!.raw).toBe(row.wireBody);
    expect(row.uploads).toBeNull();
    expect(net.uploads()).toEqual([]);
  });
});

// #2775: a task meant for a machine that is out of reach waits here — nothing is sent, nothing is
// uploaded — until a probe finds the machine able to take it; it can be canceled or redirected
// meanwhile. A task its machine holds is followed until it starts or is dropped there.
describe("RemoteDispatcher waiting tasks", () => {
  const MAC_HOST = { instanceId: MAC, name: "MacBook", platform: "macos" };
  const LINUX_HOST = { instanceId: LINUX, name: "moes-tavern", platform: "linux" };
  const HERE = "33333333-3333-4333-8333-333333333333";

  function report(ok: Capability[], stale = false): CapabilityReport {
    return {
      vocabulary: 1,
      probedAt: 0,
      ageMs: stale ? 20 * 60_000 : 1_000,
      stale,
      checks: CAPABILITIES.map((id) =>
        ok.includes(id)
          ? { id, ok: true, reason: null }
          : { id, ok: false, reason: "not_installed" },
      ),
    };
  }

  /** The machine's `POST /api/instance/capabilities` answer: a probe it just ran. */
  const probed = (ok: Capability[]) =>
    Response.json({ instanceId: MAC, capabilities: { ...report(ok), ageMs: 0 } });

  const asleep = (over: Partial<RemoteInstanceSummary> = {}) =>
    machine(MAC, { status: "unreachable", reason: "timeout", ...over });
  const awake = (over: Partial<RemoteInstanceSummary> = {}) =>
    machine(MAC, { capabilities: report(["platform:macos", "xcode"]), ...over });
  const linuxBox = (over: Partial<RemoteInstanceSummary> = {}) =>
    machine(LINUX, {
      info: { version: "2.2.0", federationApi: 2, platform: "linux", arch: "x64" },
      capabilities: report(["platform:linux"]),
      ...over,
    });

  function placed(requirements: Capability[], target = MAC_HOST) {
    return {
      mode: "auto",
      target,
      requirements,
      basis: requirements.length > 0 ? "requirements" : "only_candidate",
      preferred: null,
      by: { instanceId: HERE, name: "here" },
      decidedAt: 1,
    };
  }

  const XCODE_BODY = { ...BODY, requirements: ["xcode"], placement: placed(["xcode"]) };

  /** Machines that can change between probes, this Shepherd as `here`, and every
   *  `noteCapabilities` the dispatcher made. */
  function world(fetch: FetchLike, initial: RemoteInstanceSummary[], store?: SessionStore) {
    const machines = new Map(initial.map((m) => [m.instanceId, m]));
    const db = store ?? new SessionStore(":memory:");
    if (!store) {
      for (const m of initial) {
        db.insertRemoteInstance({
          instanceId: m.instanceId,
          url: m.url,
          token: `token-${m.instanceId}`,
          label: null,
          reportedName: m.name,
          createdAt: 1,
        });
      }
    }
    const noted: [string, Capability[]][] = [];
    const instances = {
      get: (id: string) => machines.get(id) ?? null,
      list: () => [...machines.values()],
      noteCapabilities: (id: string, snapshot: { checks: { id: Capability; ok: boolean }[] }) => {
        noted.push([id, snapshot.checks.filter((c) => c.ok).map((c) => c.id)]);
      },
    };
    const events: RemoteDispatchView[] = [];
    const hub = {
      emit: (_: string, data: unknown) => void events.push(data as RemoteDispatchView),
    };
    const here = () =>
      localMachine(
        { instanceId: HERE, name: "here", platform: "linux" },
        report(["platform:linux"]),
      );
    const dispatcher = new RemoteDispatcher({
      store: db,
      instances,
      events: hub,
      fetch,
      now: () => 42,
      here,
    });
    const set = (m: RemoteInstanceSummary) => machines.set(m.instanceId, m);
    return { store: db, dispatcher, events, set, noted, machines };
  }

  const waitFor = (over: Partial<RemoteSubmit> = {}) => submit({ body: XCODE_BODY, ...over });
  const urls = (calls: { method: string; url: string }[]) =>
    calls.map((c) => `${c.method} ${c.url}`);

  test("a task for a machine out of reach is stored and nothing is sent or uploaded", async () => {
    const net = scripted([]);
    const { store, dispatcher, events } = world(net.fetch, [asleep()]);
    const outcome = await dispatcher.wait(waitFor());
    expect(outcome).toMatchObject({
      kind: "waiting",
      count: 1,
      dispatch: {
        state: "waiting",
        host: MAC_HOST,
        summary: "build it",
        placement: { requirements: ["xcode"], target: MAC_HOST },
        readiness: { state: "offline", status: "timeout" },
        alternatives: [],
      },
    });
    expect(net.calls).toEqual([]);
    const row = store.getRemoteDispatchByKey("key-1")!;
    expect(row).toMatchObject({ state: "waiting", instanceId: MAC, project: "acme/app" });
    // As this Shepherd holds it: no target yet, its own repo path.
    expect(JSON.parse(row.wireBody)).toEqual(XCODE_BODY);
    expect(events.map((e) => e.state)).toEqual(["waiting"]);
    expect(dispatcher.list().map((d) => d.state)).toEqual(["waiting"]);

    // A retry under the key answers that it waits — and still sends nothing.
    expect(await dispatcher.submit(waitFor())).toMatchObject({ kind: "waiting" });
    expect(await dispatcher.wait(waitFor())).toMatchObject({ kind: "waiting" });
    expect(await dispatcher.submit(waitFor({ payloadHash: "other" }))).toMatchObject({
      kind: "refused",
      code: "dispatch_payload_mismatch",
    });
    // Its machine still out of reach: nothing is asked.
    await dispatcher.reconcile(MAC);
    expect(net.calls).toEqual([]);
  });

  test("its machine back, a fresh check passes: sent once — check, repos, uploads, task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-waiting-"));
    try {
      const shot = join(dir, "0b5e-shot.png");
      writeFileSync(shot, "PNG");
      const net = scripted([
        probed(["platform:macos", "xcode"]),
        Response.json({ path: "/Users/kai/dev/.shepherd-uploads-staging/m-1.png" }),
        session("s-1"),
      ]);
      const { store, dispatcher, events, set, noted } = world(net.fetch, [asleep()]);
      await dispatcher.wait(waitFor({ body: { ...XCODE_BODY, images: [shot] } }));
      expect(waitingAttachments(store)).toEqual(new Set(["0b5e-shot.png"]));
      set(awake());
      await dispatcher.reconcile(MAC);

      expect(urls(net.calls)).toEqual([
        "POST http://mac.test/api/instance/capabilities",
        "GET http://mac.test/api/repos",
        "POST http://mac.test/api/uploads",
        "POST http://mac.test/api/sessions",
      ]);
      const row = store.getRemoteDispatchByKey("key-1")!;
      const [create] = net.creates();
      expect(create!.headers["idempotency-key"]).toBe(row.id);
      expect(create!.body).toMatchObject({
        repoPath: "/Users/kai/dev/app",
        target: { instanceId: MAC },
        images: ["/Users/kai/dev/.shepherd-uploads-staging/m-1.png"],
        placement: { requirements: ["xcode"] },
      });
      expect(row).toMatchObject({ state: "started", sessionId: "s-1" });
      expect(noted).toEqual([[MAC, ["platform:macos", "xcode"]]]);
      expect(events.map((e) => e.state)).toEqual(["waiting", "started"]);
      expect(dispatcher.list()).toEqual([]);
      expect(waitingAttachments(store)).toEqual(new Set());
      // Nothing more on the next probe.
      await dispatcher.reconcile(MAC);
      expect(net.creates()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("back without the capability it is blocked: nothing is sent, the machine is not re-probed", async () => {
    const net = scripted([]);
    const { dispatcher, events, set } = world(net.fetch, [asleep()]);
    await dispatcher.wait(waitFor());
    set(awake({ capabilities: report(["platform:macos"]) }));
    await dispatcher.reconcile(MAC);
    await dispatcher.reconcile(MAC);
    expect(net.calls).toEqual([]);
    expect(events.map((e) => [e.state, e.readiness])).toEqual([
      ["waiting", { state: "offline", status: "timeout" }],
      [
        "waiting",
        {
          state: "missing_capabilities",
          missing: [{ capability: "xcode", reason: "not_installed" }],
        },
      ],
    ]);
  });

  test("a stale report is checked fresh, and a check that lacks the capability sends nothing", async () => {
    const net = scripted([
      probed(["platform:macos"]),
      probed(["platform:macos", "xcode"]),
      session("s-1"),
    ]);
    const { store, dispatcher, set, noted } = world(net.fetch, [
      awake({ capabilities: report(["xcode"], true) }),
    ]);
    await dispatcher.wait(waitFor());
    await dispatcher.reconcile(MAC);
    expect(urls(net.calls)).toEqual(["POST http://mac.test/api/instance/capabilities"]);
    expect(store.getRemoteDispatchByKey("key-1")!.state).toBe("waiting");
    expect(noted).toEqual([[MAC, ["platform:macos"]]]);
    // Still stale here (the fake does not apply the note): asked again, now it has Xcode.
    set(awake({ capabilities: report(["xcode"], true) }));
    await dispatcher.reconcile(MAC);
    expect(store.getRemoteDispatchByKey("key-1")!.state).toBe("started");
  });

  test("without requirements it goes out with the next probe, no capability check", async () => {
    const net = scripted([session("s-1")]);
    const { store, dispatcher, set } = world(net.fetch, [asleep()]);
    await dispatcher.wait(submit({ body: { ...BODY, placement: placed([]) } }));
    set(awake());
    await dispatcher.reconcile(MAC);
    expect(urls(net.calls)).toEqual([
      "GET http://mac.test/api/repos",
      "POST http://mac.test/api/sessions",
    ]);
    expect(store.getRemoteDispatchByKey("key-1")!.state).toBe("started");
  });

  test("no checkout of the project there: it keeps waiting as project missing", async () => {
    const net = scripted([]);
    const { dispatcher, set } = world(net.fetch, [asleep()]);
    await dispatcher.wait(waitFor());
    set(awake({ projects: ["acme/other"] }));
    await dispatcher.reconcile(MAC);
    expect(net.calls).toEqual([]);
    expect(dispatcher.list()[0]!.readiness).toEqual({ state: "project_missing" });
  });

  test("a restart keeps it waiting, and the next probe sends it once", async () => {
    const before = scripted([]);
    const first = world(before.fetch, [asleep()]);
    await first.dispatcher.wait(waitFor());
    // Restarted: a fresh dispatcher over the same store.
    const after = scripted([probed(["platform:macos", "xcode"]), session("s-1")]);
    const second = world(after.fetch, [asleep()], first.store);
    expect(second.dispatcher.list().map((d) => [d.state, d.readiness?.state])).toEqual([
      ["waiting", "offline"],
    ]);
    second.set(awake());
    await second.dispatcher.reconcile(MAC);
    await second.dispatcher.reconcile(MAC);
    expect(after.creates()).toHaveLength(1);
    expect(first.store.getRemoteDispatchByKey("key-1")!.state).toBe("started");
  });

  test("canceled while it waits, it never goes out", async () => {
    const net = scripted([]);
    const { store, dispatcher, events, set } = world(net.fetch, [asleep()]);
    await dispatcher.wait(waitFor());
    const id = store.getRemoteDispatchByKey("key-1")!.id;
    expect(await dispatcher.cancel(id)).toMatchObject({
      kind: "canceled",
      dispatch: { state: "canceled" },
    });
    expect(await dispatcher.cancel(id)).toMatchObject({ kind: "canceled" });
    expect(await dispatcher.submit(waitFor())).toEqual({ kind: "canceled", host: MAC_HOST });
    set(awake());
    await dispatcher.reconcile(MAC);
    expect(net.calls).toEqual([]);
    expect(events.map((e) => e.state)).toEqual(["waiting", "canceled"]);
    expect(dispatcher.list()).toEqual([]);
  });

  test("a machine removed here takes the tasks waiting for it along", async () => {
    const net = scripted([]);
    const { store, dispatcher, events, machines } = world(net.fetch, [asleep()]);
    await dispatcher.wait(waitFor());
    machines.delete(MAC);
    await dispatcher.reconcile(MAC);
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      state: "canceled",
      code: "machine_removed",
    });
    expect(events.map((e) => e.state)).toEqual(["waiting", "canceled"]);
  });

  test("redirected to another machine: sent there under the same dispatch ID, never to the first", async () => {
    const net = scripted([session("s-1")]);
    const { store, dispatcher, events } = world(net.fetch, [asleep(), linuxBox()]);
    await dispatcher.wait(submit({ body: { ...BODY, placement: placed([]) } }));
    const row = store.getRemoteDispatchByKey("key-1")!;
    const manual = { ...placed([], LINUX_HOST), mode: "manual" as const, basis: "manual" as const };
    const result = await dispatcher.redirect(row.id, { instanceId: LINUX, placement: manual });
    expect(result).toMatchObject({ kind: "redirected", outcome: { kind: "started" } });
    expect(urls(net.calls)).toEqual([
      "GET http://linux.test/api/repos",
      "POST http://linux.test/api/sessions",
    ]);
    expect(net.creates()[0]!.headers["idempotency-key"]).toBe(row.id);
    expect(net.creates()[0]!.body).toMatchObject({
      target: { instanceId: LINUX },
      placement: { mode: "manual", target: LINUX_HOST },
    });
    expect(store.getRemoteDispatch(row.id)).toMatchObject({ instanceId: LINUX, state: "started" });
    expect(events.map((e) => [e.state, e.host.instanceId])).toEqual([
      ["waiting", MAC],
      ["waiting", LINUX],
      ["started", LINUX],
    ]);
    // It is not waiting any more.
    expect(await dispatcher.redirect(row.id, { instanceId: MAC, placement: manual })).toMatchObject(
      { kind: "not_redirectable", dispatch: { state: "started" } },
    );
  });

  test("redirected to a machine that cannot take it yet, it waits for that one", async () => {
    const net = scripted([], new TypeError("down"));
    const { store, dispatcher } = world(net.fetch, [asleep(), linuxBox()]);
    await dispatcher.wait(submit({ body: { ...BODY, placement: placed([]) } }));
    const row = store.getRemoteDispatchByKey("key-1")!;
    const result = await dispatcher.redirect(row.id, {
      instanceId: LINUX,
      placement: placed([], LINUX_HOST) as never,
    });
    expect(result).toMatchObject({
      kind: "redirected",
      outcome: { kind: "waiting", dispatch: { state: "waiting", host: LINUX_HOST } },
    });
    expect(net.creates()).toEqual([]);
  });

  test("taken to run here, the row is gone and nothing sends it any more", async () => {
    const net = scripted([]);
    const { store, dispatcher, events, set } = world(net.fetch, [asleep()]);
    await dispatcher.wait(waitFor());
    const row = store.getRemoteDispatchByKey("key-1")!;
    const claim = await dispatcher.claimForHere(row.id);
    expect(claim).toEqual({ kind: "claimed", row });
    expect(store.getRemoteDispatch(row.id)).toBeNull();
    dispatcher.announceRedirected(row, { instanceId: HERE, name: "here", platform: "linux" });
    expect(events.at(-1)).toMatchObject({
      id: row.id,
      state: "redirected",
      host: { instanceId: HERE },
    });
    set(awake());
    await dispatcher.reconcile(MAC);
    expect(net.calls).toEqual([]);
    expect(await dispatcher.claimForHere(row.id)).toEqual({ kind: "not_found" });
    expect(await dispatcher.cancel(row.id)).toEqual({ kind: "not_found" });
  });

  test("a send and a claim never both win", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = scripted([probed(["platform:macos", "xcode"]), session("s-1")]);
    const slow: FetchLike = async (input, init) => {
      if (input.endsWith("/api/instance/capabilities")) await gate;
      return net.fetch(input, init);
    };
    const { store, dispatcher, set } = world(slow, [asleep()]);
    await dispatcher.wait(waitFor());
    const id = store.getRemoteDispatchByKey("key-1")!.id;
    set(awake());
    const probing = dispatcher.reconcile(MAC);
    await Bun.sleep(5);
    const claim = dispatcher.claimForHere(id);
    const cancel = dispatcher.cancel(id);
    release();
    await probing;
    expect(await claim).toMatchObject({ kind: "not_redirectable", dispatch: { state: "started" } });
    expect(await cancel).toMatchObject({ kind: "not_cancelable" });
    expect(net.creates()).toHaveLength(1);

    // The other way round: claimed first, the probe finds nothing to send.
    const net2 = scripted([]);
    const second = world(net2.fetch, [asleep()]);
    await second.dispatcher.wait(waitFor());
    const id2 = second.store.getRemoteDispatchByKey("key-1")!.id;
    expect((await second.dispatcher.claimForHere(id2)).kind).toBe("claimed");
    second.set(awake());
    await second.dispatcher.reconcile(MAC);
    expect(net2.calls).toEqual([]);
  });

  test("what it could run on now: connected machines that fit — this one included — best first", async () => {
    const net = scripted([]);
    const { dispatcher, set, events } = world(net.fetch, [
      asleep(),
      linuxBox({ status: "unreachable" }),
    ]);
    await dispatcher.wait(submit({ body: { ...BODY, placement: placed([]) } }));
    expect(dispatcher.list()[0]!.alternatives).toEqual([
      { instanceId: HERE, name: "here", platform: "linux" },
    ]);
    // The other Linux comes back: announced again with it in the list, in platform/ID order.
    set(linuxBox());
    await dispatcher.reconcile(LINUX);
    expect(events.at(-1)!.alternatives).toEqual([
      LINUX_HOST,
      { instanceId: HERE, name: "here", platform: "linux" },
    ]);
    const count = events.length;
    await dispatcher.reconcile(LINUX);
    expect(events).toHaveLength(count);
    // Xcode: neither Linux fits.
    await dispatcher.wait(waitFor({ clientKey: "key-2", payloadHash: "hash-2" }));
    expect(events.at(-1)!.alternatives).toEqual([]);
  });

  describe("held there", () => {
    const record = (fields: Record<string, unknown>) =>
      Response.json({ id: "d-1", createdAt: 1, updatedAt: 2, ...fields });
    const held = () => Response.json({ held: true, id: "h-1", count: 1 });

    test("a task its machine holds is shown until the machine starts it", async () => {
      const net = scripted([
        held(),
        record({ state: "held", heldId: "h-1" }),
        record({ state: "started", sessionId: "s-1" }),
      ]);
      const { store, dispatcher, events } = world(net.fetch, [awake()]);
      expect(await dispatcher.submit(submit())).toMatchObject({ kind: "held", id: "h-1" });
      expect(dispatcher.list().map((d) => [d.state, d.heldId])).toEqual([["held", "h-1"]]);
      await dispatcher.reconcile(MAC);
      expect(dispatcher.list().map((d) => d.state)).toEqual(["held"]);
      await dispatcher.reconcile(MAC);
      expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
        state: "started",
        sessionId: "s-1",
      });
      expect(events.map((e) => e.state)).toEqual(["held", "started"]);
      expect(dispatcher.list()).toEqual([]);
    });

    test("dropped there, it settles as rejected with the machine's reason", async () => {
      const net = scripted([
        held(),
        record({ state: "failed", code: "held_discarded", reason: "held task discarded" }),
      ]);
      const { store, dispatcher } = world(net.fetch, [awake()]);
      await dispatcher.submit(submit());
      await dispatcher.reconcile(MAC);
      expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
        state: "rejected",
        code: "held_discarded",
      });
    });

    test("canceled, it is discarded there and settles once the machine's record says so", async () => {
      const net = scripted([
        held(),
        Response.json({ ok: true }),
        record({ state: "failed", code: "held_discarded" }),
      ]);
      const { store, dispatcher } = world(net.fetch, [awake()]);
      await dispatcher.submit(submit());
      const id = store.getRemoteDispatchByKey("key-1")!.id;
      expect(await dispatcher.cancel(id)).toMatchObject({ kind: "canceled" });
      expect(urls(net.calls).slice(2)).toEqual([
        "DELETE http://mac.test/api/held/h-1",
        `GET http://mac.test/api/dispatches/${id}`,
      ]);
      expect(await dispatcher.submit(submit())).toEqual({ kind: "canceled", host: MAC_HOST });
    });

    test("out of reach, the cancel waits and the next check delivers it", async () => {
      const net = scripted([held(), Response.json({ ok: true }), record({ state: "failed" })]);
      const { store, dispatcher, set } = world(net.fetch, [awake()]);
      await dispatcher.submit(submit());
      const id = store.getRemoteDispatchByKey("key-1")!.id;
      set(asleep());
      expect(await dispatcher.cancel(id)).toMatchObject({ kind: "canceling" });
      expect(net.calls).toHaveLength(2);
      set(awake());
      await dispatcher.reconcile(MAC);
      expect(store.getRemoteDispatch(id)!.state).toBe("canceled");
    });

    test("started there meanwhile, it is not cancelable and reads as started", async () => {
      const net = scripted([
        held(),
        Response.json({ ok: true }),
        record({ state: "started", sessionId: "s-1" }),
      ]);
      const { store, dispatcher } = world(net.fetch, [awake()]);
      await dispatcher.submit(submit());
      const id = store.getRemoteDispatchByKey("key-1")!.id;
      expect(await dispatcher.cancel(id)).toMatchObject({
        kind: "not_cancelable",
        dispatch: { state: "started", sessionId: "s-1" },
      });
    });
  });
});
