import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
      uploads: null,
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
