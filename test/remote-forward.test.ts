import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/remote-instances/client";
import {
  clearMergedAcross,
  clearMergedSummaryAcross,
  forwardSessionRequest,
  forwardedLeaf,
} from "../src/remote-instances/forward";
import type { MachineRoute } from "../src/remote-instances/sessions";

// The forwarding module on its own (#2765): what it sends a machine and what it hands back,
// with the machine replaced by an injected fetch. The two-server path is test/server-remote-actions.

const ID = "0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d";
const TOKEN = "shp_remote-token-for-b-0123456789";
const host = { instanceId: "m-b", name: "MacBook", platform: "macos" };
const live: MachineRoute = { host, target: { url: "http://b.test:7777", token: TOKEN } };
const down: MachineRoute = { host, target: null };

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A machine answering `answer` (or throwing it), recording each request. */
function machine(answer: Response | Error | (() => Response | Promise<Response>) = new Response()) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const raw = init.body;
    sent.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body:
        raw == null
          ? null
          : typeof raw === "string"
            ? raw
            : new TextDecoder().decode(raw as ArrayBuffer),
    });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  };
  return { fetch, sent };
}

function request(method: string, path: string, init: RequestInit = {}) {
  const url = new URL(`http://coordinator.test${path}`);
  return {
    req: new Request(url, { method, ...init }),
    url,
    parts: url.pathname.split("/").filter(Boolean),
  };
}

async function forward(
  method: string,
  path: string,
  m: ReturnType<typeof machine>,
  init: RequestInit = {},
  route = live,
) {
  const { req, url, parts } = request(method, path, init);
  return forwardSessionRequest(req, url, parts, route, { fetch: m.fetch, timeoutMs: 50 });
}

describe("allowlist", () => {
  const parts = (leaf: string) => ["api", "sessions", ID, ...leaf.split("/").filter(Boolean)];

  test("remote parity routes support the complete native session controls", () => {
    for (const [method, leaf] of [
      ["GET", "git"],
      ["POST", "resume"],
      ["POST", "relaunch"],
      ["POST", "variant"],
      ["POST", "replace"],
      ["POST", "review-plan"],
      ["POST", "git/merge"],
      ["GET", "queue"],
      ["PUT", "queue"],
      ["POST", "terminal"],
      ["GET", ""],
      ["POST", "recommend-prompt"],
      ["POST", "recap/regenerate"],
      ["GET", "git/reviewers"],
      ["POST", "git/pr"],
      ["POST", "git/ready"],
      ["POST", "git/draft"],
      ["POST", "git/close"],
      ["POST", "git/request-review"],
      ["POST", "review-pr"],
      ["POST", "review-hold"],
      ["POST", "review-cancel"],
      ["POST", "quota/resume"],
      ["POST", "quota/dismiss"],
      ["POST", "queue/approve"],
      ["POST", "git/redeploy"],
      ["POST", "ack-manual-steps"],
    ])
      expect(forwardedLeaf(method!, parts(leaf!))).toBe(leaf!);
  });

  test.each([
    ["POST", "reply"],
    ["POST", "interrupt"],
    ["DELETE", ""],
    ["GET", "leftovers"],
    ["POST", "go"],
    ["POST", "answer-plan-questions"],
    ["POST", "rename"],
    ["POST", "amendments"],
    ["DELETE", "amendments/a1"],
    ["PUT", "autopilot"],
    ["PUT", "automerge"],
    ["POST", "ready"],
    ["GET", "diff"],
    ["GET", "diff/annotations"],
    ["GET", "messages"],
    ["GET", "activity"],
    ["GET", "usage"],
    ["GET", "worktree"],
    ["GET", "worktree/download"],
    ["GET", "scratchpad"],
    ["GET", "scratchpad/download"],
    ["POST", "scratchpad/upload"],
    ["GET", "preview"],
    ["POST", "preview/start"],
    ["POST", "preview/stop"],
  ])("%s %s is forwarded", (method, leaf) => {
    expect(forwardedLeaf(method, parts(leaf))).toBe(leaf);
  });

  test.each([
    ["POST", "restore"],
    ["GET", "preview/start"],
    ["POST", "preview"],
    ["POST", "preview/relay"],
    ["POST", "hooks"],
    ["GET", "steer-log"],
    ["POST", "reply/extra"], // exact leaves only
    ["GET", "reply"], // and the listed method only
    ["DELETE", "amendments"],
    ["DELETE", "amendments/a1/x"],
  ])("%s %s is not", (method, leaf) => {
    expect(forwardedLeaf(method, parts(leaf))).toBeNull();
  });
});

describe("forwardSessionRequest", () => {
  test("sends method, rebuilt path, query, body and content-type with the machine's token only", async () => {
    const m = machine(Response.json({ ok: true }));
    const res = await forward("POST", `/api/sessions/${ID}/reply?x=1`, m, {
      headers: {
        "content-type": "application/json",
        cookie: "shepherd_session=caller",
        authorization: "Bearer caller-token",
        origin: "https://coordinator.test",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.sent).toEqual([
      {
        url: `http://b.test:7777/api/sessions/${ID}/reply?x=1`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: "hi" }),
      },
    ]);
  });

  test("archive goes to the session itself, its reap list included", async () => {
    const m = machine(Response.json({ ok: true }));
    await forward("DELETE", `/api/sessions/${ID}`, m, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reap: ["k1"] }),
    });
    expect(m.sent[0]).toMatchObject({
      url: `http://b.test:7777/api/sessions/${ID}`,
      method: "DELETE",
      body: JSON.stringify({ reap: ["k1"] }),
    });
  });

  test("a multipart upload reaches the machine byte for byte, boundary included", async () => {
    const m = machine(Response.json({ path: "notes.txt" }));
    const form = new FormData();
    form.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    const original = new Request("http://x.test/", { method: "POST", body: form });
    const contentType = original.headers.get("content-type")!;
    const bytes = await original.arrayBuffer();
    const res = await forward("POST", `/api/sessions/${ID}/scratchpad/upload?path=docs`, m, {
      headers: { "content-type": contentType },
      body: bytes,
    });
    expect(await res.json()).toEqual({ path: "notes.txt" });
    expect(m.sent[0]!.url).toBe(
      `http://b.test:7777/api/sessions/${ID}/scratchpad/upload?path=docs`,
    );
    expect(m.sent[0]!.headers["content-type"]).toBe(contentType);
    expect(m.sent[0]!.body).toBe(new TextDecoder().decode(bytes));
  });

  test("the machine's status, body and download headers pass through; other headers do not", async () => {
    const m = machine(
      new Response("file-bytes", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="a.txt"',
          "set-cookie": "x=1",
          "x-other": "1",
        },
      }),
    );
    const res = await forward("GET", `/api/sessions/${ID}/worktree/download?path=a.txt`, m);
    expect(await res.text()).toBe("file-bytes");
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="a.txt"',
      "x-content-type-options": "nosniff",
    });
    const conflict = await forward(
      "POST",
      `/api/sessions/${ID}/go`,
      machine(Response.json({ error: "plan not approved" }, { status: 409 })),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "plan not approved" });
  });

  test("nothing a machine sends is rendered as a page here", async () => {
    const page = () =>
      new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
    // A download is an attachment whatever the machine says…
    const download = await forward(
      "GET",
      `/api/sessions/${ID}/scratchpad/download?path=x.html`,
      machine(page),
    );
    expect(download.headers.get("content-disposition")).toBe("attachment");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    // …a download's error is the JSON the route answers, not an attachment…
    const missing = await forward(
      "GET",
      `/api/sessions/${ID}/worktree/download?path=nope`,
      machine(() => Response.json({ error: "not found" }, { status: 404 })),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-disposition")).toBeNull();
    // …and every other route must answer JSON, or the machine's answer is refused.
    const html = await forward("GET", `/api/sessions/${ID}/diff`, machine(page));
    expect(html.status).toBe(502);
    expect(await html.json()).toMatchObject({
      code: "machine_unreachable",
      reason: "bad_response",
    });
  });

  test("a route outside the allowlist is refused with an explanation and never sent", async () => {
    const m = machine();
    const res = await forward("POST", `/api/sessions/${ID}/restore`, m);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "remote_unsupported", machine: "MacBook" });
    expect(m.sent).toEqual([]);
  });

  test("a disconnected machine is reported unreachable without a request", async () => {
    const m = machine();
    const res = await forward("POST", `/api/sessions/${ID}/interrupt`, m, {}, down);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "machine_unreachable",
      machine: "MacBook",
      reason: "disconnected",
    });
    expect(m.sent).toEqual([]);
  });

  test.each([
    ["a 401", () => new Response("no", { status: 401 }), "machine_unauthorized"],
    ["a 403", () => new Response("no", { status: 403 }), "machine_unauthorized"],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "http://evil.test/" } }),
      "machine_unreachable",
    ],
  ])("%s from the machine becomes a 502, never passed through", async (_, answer, code) => {
    const res = await forward("POST", `/api/sessions/${ID}/interrupt`, machine(answer));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code, machine: "MacBook" });
  });

  test("a network failure and a timeout are told apart", async () => {
    const failed = await forward("GET", `/api/sessions/${ID}/diff`, machine(new TypeError("down")));
    expect(await failed.json()).toMatchObject({ code: "machine_unreachable", reason: "network" });
    const slow = machine(async () => {
      await Bun.sleep(200);
      return Response.json({});
    });
    // The injected fetch ignores the signal, so emulate the abort the real fetch would raise.
    const timedOut = await forward("GET", `/api/sessions/${ID}/diff`, {
      sent: slow.sent,
      fetch: (url, init) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          void slow.fetch(url, init).then(resolve, reject);
        }),
    });
    expect(timedOut.status).toBe(502);
    expect(await timedOut.json()).toMatchObject({ code: "machine_timeout", reason: "timeout" });
  });
});

describe("clear-merged across machines", () => {
  const other: MachineRoute = {
    host: { instanceId: "m-c", name: "Studio", platform: "linux" },
    target: { url: "http://c.test:7777", token: TOKEN },
  };
  const local = { ids: ["l1"], leftovers: 1, leftoversById: { l1: 1 }, probesUnavailable: false };

  test("the summary merges every reachable machine and names the one that is not", async () => {
    const m = machine(
      Response.json({
        ids: ["b1"],
        leftovers: 2,
        leftoversById: { b1: 2 },
        probesUnavailable: true,
      }),
    );
    const summary = await clearMergedSummaryAcross(local, [live, { ...other, target: null }], {
      fetch: m.fetch,
    });
    expect(summary).toEqual({
      ids: ["l1", "b1"],
      leftovers: 3,
      leftoversById: { l1: 1, b1: 2 },
      probesUnavailable: true,
      machines: [
        { instanceId: "m-b", name: "MacBook", ok: true, ids: ["b1"] },
        { instanceId: "m-c", name: "Studio", ok: false, reason: "disconnected", ids: [] },
      ],
    });
    expect(m.sent.map((s) => s.url)).toEqual([
      "http://b.test:7777/api/sessions/clear-merged?host=local",
    ]);
  });

  test("clearing reports one outcome per machine and a partial result when one fails", async () => {
    const sent: Sent[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, method: init.method ?? "GET", headers: {}, body: String(init.body ?? "") });
      if (url.startsWith("http://c.test")) throw new TypeError("down");
      return Response.json({ cleared: ["b1"], leftovers: 2 });
    };
    const result = await clearMergedAcross(
      { cleared: ["l1"], leftovers: 1 },
      [
        { route: live, ids: ["b1", "b2"] },
        { route: other, ids: ["c1"] },
      ],
      { fetch },
    );
    expect(result).toEqual({
      cleared: ["l1", "b1"],
      leftovers: 3,
      partial: true,
      machines: [
        { instanceId: "m-b", name: "MacBook", ok: true, requested: ["b1", "b2"], cleared: ["b1"] },
        {
          instanceId: "m-c",
          name: "Studio",
          ok: false,
          reason: "network",
          requested: ["c1"],
          cleared: [],
        },
      ],
    });
    expect(sent.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "http://b.test:7777/api/sessions/clear-merged?host=local",
        method: "POST",
        body: JSON.stringify({ ids: ["b1", "b2"] }),
      },
      {
        url: "http://c.test:7777/api/sessions/clear-merged?host=local",
        method: "POST",
        body: JSON.stringify({ ids: ["c1"] }),
      },
    ]);
  });

  test("no ids means the machine's whole merged set; a bad answer is not a success", async () => {
    const m = machine(new Response("oops", { status: 500 }));
    const result = await clearMergedAcross(
      { cleared: [], leftovers: 0 },
      [{ route: live, ids: null }],
      { fetch: m.fetch },
    );
    expect(m.sent[0]!.body).toBeNull();
    expect(result.partial).toBe(true);
    expect(result.machines).toEqual([
      {
        instanceId: "m-b",
        name: "MacBook",
        ok: false,
        reason: "bad_response",
        requested: [],
        cleared: [],
      },
    ]);
  });
});

describe("owner annotations on session answers", () => {
  test.each([
    "",
    "resume",
    "variant",
    "replace",
    "terminal",
    "autopilot",
    "automerge",
    "rename",
    "relaunch",
  ])("%s preserves the response shape and replaces claimed ownership", async (leaf) => {
    const nested = leaf === "rename" || leaf === "relaunch";
    const session = { id: ID, name: "result", host: { instanceId: "forged" } };
    const body = nested ? { session, archived: true } : session;
    const method = leaf === "" ? "GET" : ["autopilot", "automerge"].includes(leaf) ? "PUT" : "POST";
    const result = await forward(
      method,
      `/api/sessions/${ID}/${leaf}`,
      machine(Response.json(body)),
    );
    expect(result.status).toBe(200);
    const answer = await result.json();
    expect(nested ? answer.session : answer).toMatchObject({
      id: ID,
      host,
      connection: { state: "connected" },
    });
    if (nested) expect(answer.archived).toBe(true);
  });
  test("HTML and malformed session results are refused; archive keeps its own shape", async () => {
    const bad = await forward(
      "GET",
      `/api/sessions/${ID}`,
      machine(new Response(JSON.stringify({ id: ID }))),
    );
    expect(bad.status).toBe(502);
    const missing = await forward(
      "POST",
      `/api/sessions/${ID}/variant`,
      machine(Response.json({ ok: true })),
    );
    expect(missing.status).toBe(502);
    const archive = await forward(
      "DELETE",
      `/api/sessions/${ID}`,
      machine(Response.json({ ok: true })),
    );
    expect(await archive.json()).toEqual({ ok: true });
  });
});
