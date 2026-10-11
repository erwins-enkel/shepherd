import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { FetchLike } from "../src/remote-instances/client";
import { RemoteDispatcher, type RemoteSubmit } from "../src/remote-instances/dispatch";
import type { RemoteInstanceSummary } from "../src/remote-instances/service";

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
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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
    };
    calls.push(call);
    let answer = input.endsWith("/api/repos") ? repos : posts.shift();
    if (typeof answer === "function") answer = answer(call);
    if (!answer) throw new Error(`unexpected ${call.method} ${input}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, calls, posts: () => calls.filter((c) => c.method === "POST") };
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
): { store: SessionStore; dispatcher: RemoteDispatcher } {
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
  };
  return { store, dispatcher: new RemoteDispatcher({ store, instances, fetch, now: () => 42 }) };
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
    expect(post!.body).toEqual({ ...BODY, repoPath: "/Users/kai/dev/app" });
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
