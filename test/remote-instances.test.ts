import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import {
  FEDERATION_API_VERSION,
  defaultInstanceName,
  instanceIdentity,
  instancePlatform,
  parseInstanceNamePatch,
  setInstanceName,
} from "../src/remote-instances/identity";
import { type FetchLike, probeRemote } from "../src/remote-instances/client";
import {
  RemoteInstanceService,
  type RemoteInstanceSummary,
  normalizeRemoteUrl,
  parseConnectRequest,
  parseLabelPatch,
} from "../src/remote-instances/service";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("instance identity", () => {
  test("the instance id is generated once and survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-identity-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "shepherd.db");
    const first = instanceIdentity(new SessionStore(dbPath));
    expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    const reopened = new SessionStore(dbPath);
    expect(instanceIdentity(reopened).instanceId).toBe(first.instanceId);
    expect(instanceIdentity(reopened).instanceId).toBe(first.instanceId);
  });

  test("two stores get two different ids", () => {
    const a = instanceIdentity(new SessionStore(":memory:"));
    const b = instanceIdentity(new SessionStore(":memory:"));
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  test("reports version, federation level, platform and arch", () => {
    const id = instanceIdentity(new SessionStore(":memory:"));
    expect(id.federationApi).toBe(FEDERATION_API_VERSION);
    expect(id.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(id.platform).toBe(instancePlatform());
    expect(id.arch).toBe(process.arch);
  });

  test("the name defaults to the host name, can be changed and reset", () => {
    const store = new SessionStore(":memory:");
    expect(instanceIdentity(store).name).toBe(defaultInstanceName());
    setInstanceName(store, "MacBook");
    expect(instanceIdentity(store).name).toBe("MacBook");
    setInstanceName(store, null);
    expect(instanceIdentity(store).name).toBe(defaultInstanceName());
  });

  test("platform names map node's identifiers onto the contract's", () => {
    expect(instancePlatform("darwin")).toBe("macos");
    expect(instancePlatform("win32")).toBe("windows");
    expect(instancePlatform("linux")).toBe("linux");
    expect(instancePlatform("freebsd")).toBe("freebsd");
  });

  test("the default name is the first host label", () => {
    expect(defaultInstanceName("Kais-MBP.local")).toBe("Kais-MBP");
    expect(defaultInstanceName("moes-tavern")).toBe("moes-tavern");
    expect(defaultInstanceName("")).toBe("shepherd");
  });

  test("parseInstanceNamePatch accepts a name or null and rejects everything else", () => {
    expect(parseInstanceNamePatch({ name: "  Linux box " })).toEqual({ name: "Linux box" });
    expect(parseInstanceNamePatch({ name: null })).toEqual({ name: null });
    expect(parseInstanceNamePatch({ name: "   " })).toEqual({ name: null });
    expect(parseInstanceNamePatch({ name: "x".repeat(65) })).toHaveProperty("error");
    expect(parseInstanceNamePatch({ name: 3 })).toHaveProperty("error");
    expect(parseInstanceNamePatch({ name: "a", extra: 1 })).toHaveProperty("error");
    expect(parseInstanceNamePatch(null)).toHaveProperty("error");
  });
});

// ── probe client + service ─────────────────────────────────────────────────

const REMOTE_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "shp_remote-secret-token-value-0123456789abcdef";
const TARGET = { url: "http://mac.test:7330", token: TOKEN };

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeShepherd {
  me: unknown;
  instance: unknown;
  repos: unknown;
  /** The machine's `GET /api/update`; absent = the route 404s. */
  update?: unknown;
  /** Per-path status override (non-2xx answers carry `{error}`). */
  status: Record<string, number>;
}

function fakeShepherd(over: Partial<FakeShepherd> = {}): FakeShepherd {
  return {
    me: {
      authenticated: true,
      access: { tokenId: "t1", scope: "full", repoPaths: null, expiresAt: null },
    },
    instance: {
      instanceId: REMOTE_ID,
      name: "MacBook",
      version: "2.1.0",
      federationApi: FEDERATION_API_VERSION,
      platform: "macos",
      arch: "arm64",
    },
    repos: {
      repos: [
        {
          name: "shepherd",
          path: "/Users/k/repos/shepherd",
          realPath: "/Users/k/repos/shepherd",
          remoteSlug: "erwins-enkel/shepherd",
        },
        { name: "scratch", path: "/Users/k/repos/scratch", realPath: "/Users/k/repos/scratch" },
        {
          name: "shepherd-fork",
          path: "/Users/k/repos/shepherd-fork",
          realPath: "/Volumes/work/shepherd-fork",
          remoteSlug: "erwins-enkel/shepherd",
        },
        { name: "app", remoteSlug: "acme/app" },
      ],
      recentWindowDays: 3,
    },
    status: {},
    ...over,
  };
}

/** A fetch answering like `remote` (mutable between calls) and recording every call. */
function stubFetch(remote: FakeShepherd | (() => Promise<Response>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (typeof remote === "function") return remote();
    const path = new URL(url).pathname;
    const status = remote.status[path];
    if (status) return jsonRes({ error: "nope" }, status);
    if (path === "/api/me") return jsonRes(remote.me);
    if (path === "/api/instance") return jsonRes(remote.instance);
    if (path === "/api/repos") return jsonRes(remote.repos);
    if (path === "/api/update" && remote.update !== undefined) return jsonRes(remote.update);
    return jsonRes({ error: "not found" }, 404);
  };
  return Object.assign(fn, { calls });
}

describe("probeRemote", () => {
  test("a reachable, compatible machine reports identity and unique sorted project slugs", async () => {
    const fetch = stubFetch(fakeShepherd());
    const outcome = await probeRemote(TARGET, { fetch });
    expect(outcome).toEqual({
      status: "connected",
      info: {
        instanceId: REMOTE_ID,
        name: "MacBook",
        version: "2.1.0",
        federationApi: FEDERATION_API_VERSION,
        platform: "macos",
        arch: "arm64",
      },
      projects: ["acme/app", "erwins-enkel/shepherd"],
      repoSlugs: new Map([
        ["/Users/k/repos/shepherd", "erwins-enkel/shepherd"],
        ["/Users/k/repos/shepherd-fork", "erwins-enkel/shepherd"],
        ["/Volumes/work/shepherd-fork", "erwins-enkel/shepherd"],
      ]),
      capabilities: null,
      load: null,
      loadReadAt: expect.any(Number),
    });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      "http://mac.test:7330/api/me",
      "http://mac.test:7330/api/instance",
      "http://mac.test:7330/api/repos",
    ]);
    for (const { init } of fetch.calls) {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      expect(init.redirect).toBe("manual");
    }
  });

  test("the env SHEPHERD_TOKEN (no access block) counts as unrestricted", async () => {
    const outcome = await probeRemote(TARGET, {
      fetch: stubFetch(fakeShepherd({ me: { authenticated: true } })),
    });
    expect(outcome.status).toBe("connected");
  });

  const cases: [string, Partial<FakeShepherd>, string, string][] = [
    ["401", { status: { "/api/me": 401 } }, "unauthorized", "token_rejected"],
    [
      "a read-scoped token",
      { me: { authenticated: true, access: { scope: "read", repoPaths: null } } },
      "unauthorized",
      "token_scope",
    ],
    [
      "a repository-restricted token",
      { me: { authenticated: true, access: { scope: "full", repoPaths: [] } } },
      "unauthorized",
      "token_restricted",
    ],
    [
      "a 403 from the scope gate",
      { status: { "/api/instance": 403 } },
      "unauthorized",
      "token_scope",
    ],
    [
      "a Shepherd without /api/instance",
      { status: { "/api/instance": 404 } },
      "incompatible",
      "api_missing",
    ],
    [
      "another federation level",
      {
        instance: {
          ...(fakeShepherd().instance as object),
          federationApi: FEDERATION_API_VERSION + 1,
        },
      },
      "incompatible",
      "api_version",
    ],
    ["a redirect", { status: { "/api/me": 302 } }, "unreachable", "redirect"],
    ["a server error", { status: { "/api/repos": 500 } }, "unreachable", "bad_response"],
    [
      "an identity without a UUID",
      { instance: { ...(fakeShepherd().instance as object), instanceId: "x" } },
      "unreachable",
      "bad_response",
    ],
    ["repos without a list", { repos: { nope: true } }, "unreachable", "bad_response"],
  ];
  for (const [name, over, status, reason] of cases) {
    test(`${name} ⇒ ${status}/${reason}`, async () => {
      const outcome = await probeRemote(TARGET, { fetch: stubFetch(fakeShepherd(over)) });
      expect(outcome).toEqual({ status, reason } as never);
    });
  }

  test("a refused connection ⇒ unreachable/network", async () => {
    const outcome = await probeRemote(TARGET, {
      fetch: stubFetch(() => Promise.reject(new TypeError("Unable to connect"))),
    });
    expect(outcome).toEqual({ status: "unreachable", reason: "network" });
  });

  test("no answer within the timeout ⇒ unreachable/timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    expect(await probeRemote(TARGET, { fetch: hang, timeoutMs: 10 })).toEqual({
      status: "unreachable",
      reason: "timeout",
    });
  });

  test("a body that is not JSON ⇒ unreachable/bad_response", async () => {
    const outcome = await probeRemote(TARGET, {
      fetch: stubFetch(() => Promise.resolve(new Response("<html>", { status: 200 }))),
    });
    expect(outcome).toEqual({ status: "unreachable", reason: "bad_response" });
  });
});

describe("request parsing", () => {
  test("normalizeRemoteUrl keeps http(s) origin + path and rejects credentials, query, fragment", () => {
    expect(normalizeRemoteUrl(" https://mac.ts.net:7330/ ")).toBe("https://mac.ts.net:7330");
    expect(normalizeRemoteUrl("http://127.0.0.1:7360")).toBe("http://127.0.0.1:7360");
    expect(normalizeRemoteUrl("https://host/shepherd//")).toBe("https://host/shepherd");
    for (const bad of [
      "ftp://host",
      "https://user:pw@host",
      "https://host/?t=1",
      "https://host/#x",
      "host:7330",
      42,
    ]) {
      expect(normalizeRemoteUrl(bad)).toBeNull();
    }
  });

  test("parseConnectRequest validates url, token and optional label", () => {
    expect(parseConnectRequest({ url: "https://h", token: ` ${TOKEN} ` })).toEqual({
      url: "https://h",
      token: TOKEN,
      label: null,
    });
    expect(parseConnectRequest({ url: "https://h", token: TOKEN, label: " Mac " })).toEqual({
      url: "https://h",
      token: TOKEN,
      label: "Mac",
    });
    expect(parseConnectRequest({ url: "nope", token: TOKEN })).toEqual({ error: "invalid_url" });
    expect(parseConnectRequest({ url: "https://h", token: "a b" })).toEqual({
      error: "invalid_token",
    });
    expect(parseConnectRequest({ url: "https://h", token: "" })).toEqual({
      error: "invalid_token",
    });
    expect(parseConnectRequest({ url: "https://h", token: TOKEN, label: "x".repeat(65) })).toEqual({
      error: "invalid_label",
    });
    expect(parseConnectRequest({ url: "https://h", token: TOKEN, extra: 1 })).toEqual({
      error: "invalid_body",
    });
  });

  test("parseLabelPatch takes exactly {label}", () => {
    expect(parseLabelPatch({ label: "Mac" })).toEqual({ label: "Mac" });
    expect(parseLabelPatch({ label: null })).toEqual({ label: null });
    expect(parseLabelPatch({ label: 1 })).toEqual({ error: "invalid_label" });
    expect(parseLabelPatch({})).toEqual({ error: "invalid_body" });
  });
});

describe("RemoteInstanceService", () => {
  const connectReq = { url: TARGET.url, token: TOKEN, label: null };

  function setup(remote = fakeShepherd(), now = () => 1_000) {
    const store = new SessionStore(":memory:");
    const fetch = stubFetch(remote);
    const svc = new RemoteInstanceService({ store, fetch, now });
    return { store, fetch, svc, remote };
  }

  test("connect stores the machine and answers a summary without the token", async () => {
    const { svc, store } = setup();
    const result = await svc.connect(connectReq);
    expect(result.ok).toBe(true);
    const instance = (result as { instance: RemoteInstanceSummary }).instance;
    expect(instance).toEqual({
      instanceId: REMOTE_ID,
      name: "MacBook",
      label: null,
      reportedName: "MacBook",
      url: TARGET.url,
      tokenHint: TOKEN.slice(-4),
      createdAt: 1_000,
      status: "connected",
      reason: null,
      checkedAt: 1_000,
      lastSeenAt: 1_000,
      info: {
        version: "2.1.0",
        federationApi: FEDERATION_API_VERSION,
        platform: "macos",
        arch: "arm64",
      },
      projects: ["acme/app", "erwins-enkel/shepherd"],
      capabilities: null,
      load: null,
      released: true,
    });
    expect(JSON.stringify(instance)).not.toContain(TOKEN);
    expect(store.getRemoteInstance(REMOTE_ID)?.token).toBe(TOKEN);
    expect(svc.list()).toEqual([instance]);
  });

  test("a short env token gets no hint", async () => {
    const { svc } = setup();
    const result = await svc.connect({ ...connectReq, token: "short-env-token" });
    expect((result as { instance: RemoteInstanceSummary }).instance.tokenHint).toBeNull();
  });

  test("a failed check stores nothing and names the failure", async () => {
    const { svc, store } = setup(fakeShepherd({ status: { "/api/me": 401 } }));
    expect(await svc.connect(connectReq)).toEqual({
      ok: false,
      error: "remote_unauthorized",
      reason: "token_rejected",
    });
    expect(store.listRemoteInstances()).toEqual([]);
  });

  test("connecting this instance to itself is refused", async () => {
    const { svc, store, remote } = setup();
    remote.instance = {
      ...(remote.instance as object),
      instanceId: instanceIdentity(store).instanceId,
    };
    expect(await svc.connect(connectReq)).toEqual({ ok: false, error: "self_connection" });
    expect(store.listRemoteInstances()).toEqual([]);
  });

  test("the same machine cannot be connected twice", async () => {
    const { svc } = setup();
    await svc.connect(connectReq);
    expect(await svc.connect({ ...connectReq, url: "http://other.test" })).toEqual({
      ok: false,
      error: "already_connected",
    });
  });

  test("a later failure keeps the last-seen identity and projects", async () => {
    let t = 1_000;
    const { svc, remote } = setup(fakeShepherd(), () => t);
    await svc.connect(connectReq);
    t = 2_000;
    remote.status = { "/api/me": 401 };
    const checked = await svc.check(REMOTE_ID);
    expect(checked).toMatchObject({
      status: "unauthorized",
      reason: "token_rejected",
      checkedAt: 2_000,
      lastSeenAt: 1_000,
      info: { version: "2.1.0" },
      projects: ["acme/app", "erwins-enkel/shepherd"],
    });
    expect(svc.repoSlugs(REMOTE_ID).get("/Users/k/repos/shepherd")).toBe("erwins-enkel/shepherd");
  });

  test("each checkout path names its project; unknown before a probe, absent from the summary", async () => {
    const { svc } = setup();
    expect(svc.repoSlugs(REMOTE_ID).size).toBe(0);
    const { instance } = (await svc.connect(connectReq)) as { instance: object };
    expect([...svc.repoSlugs(REMOTE_ID)]).toEqual([
      ["/Users/k/repos/shepherd", "erwins-enkel/shepherd"],
      ["/Users/k/repos/shepherd-fork", "erwins-enkel/shepherd"],
      ["/Volumes/work/shepherd-fork", "erwins-enkel/shepherd"],
    ]);
    expect(instance).not.toHaveProperty("repoSlugs");
  });

  // ── capabilities and platform release (#2770) ──

  const capabilityReport = (over: Record<string, unknown> = {}) => ({
    vocabulary: 1,
    probedAt: 999_999_999_999, // the machine's own clock: never trusted across machines
    ageMs: 30_000,
    stale: false,
    checks: [
      { id: "platform:macos", ok: true, reason: null },
      { id: "agent:claude", ok: true, reason: null },
      { id: "xcode", ok: false, reason: "not_probed" },
    ],
    ...over,
  });

  test("carries the machine's capabilities, re-based onto this clock and aged here", async () => {
    let t = 100_000;
    const remote = fakeShepherd();
    remote.instance = { ...(remote.instance as object), capabilities: capabilityReport() };
    const { svc } = setup(remote, () => t);
    const { instance } = (await svc.connect(connectReq)) as { instance: RemoteInstanceSummary };
    expect(instance.capabilities).toMatchObject({ probedAt: 70_000, ageMs: 30_000, stale: false });
    expect(instance.capabilities?.checks.find((c) => c.id === "agent:claude")?.ok).toBe(true);
    t = 70_000 + 15 * 60_000 + 1;
    expect(svc.list()[0]?.capabilities?.stale).toBe(true);
  });

  test("a machine out of reach keeps its last capabilities, which turn stale", async () => {
    let t = 100_000;
    const remote = fakeShepherd();
    remote.instance = { ...(remote.instance as object), capabilities: capabilityReport() };
    const { svc } = setup(remote, () => t);
    await svc.connect(connectReq);
    t = 70_000 + 20 * 60_000;
    remote.status = { "/api/me": 401 };
    const checked = await svc.check(REMOTE_ID);
    expect(checked).toMatchObject({ status: "unauthorized", capabilities: { probedAt: 70_000 } });
    expect(checked?.capabilities?.stale).toBe(true);
  });

  test("an older machine without capabilities, or a garbled report, stays connected", async () => {
    for (const capabilities of [undefined, { checks: "garbled" }]) {
      const remote = fakeShepherd();
      remote.instance = { ...(remote.instance as object), capabilities };
      const { svc } = setup(remote);
      const result = await svc.connect(connectReq);
      expect(result).toMatchObject({ ok: true, instance: { status: "connected" } });
      expect((result as { instance: RemoteInstanceSummary }).instance.capabilities).toBeNull();
    }
  });

  test("a Windows machine is listed but not released for tasks", async () => {
    const remote = fakeShepherd();
    remote.instance = { ...(remote.instance as object), platform: "windows", arch: "x64" };
    const { svc } = setup(remote);
    await svc.connect(connectReq);
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]).toMatchObject({
      status: "connected",
      info: { platform: "windows" },
      released: false,
    });
  });

  test("a machine whose platform is not known yet is not released", async () => {
    const { svc, store } = setup();
    await svc.connect(connectReq);
    const fresh = new RemoteInstanceService({ store, fetch: stubFetch(fakeShepherd()) });
    expect(fresh.list()[0]).toMatchObject({ status: "checking", info: null, released: false });
  });

  test("a different instance answering at the address is flagged and not adopted", async () => {
    const { svc, remote, store } = setup();
    await svc.connect(connectReq);
    remote.instance = {
      ...(remote.instance as object),
      instanceId: "99999999-2222-4333-8444-555555555555",
      name: "Impostor",
    };
    const checked = await svc.check(REMOTE_ID);
    expect(checked).toMatchObject({ status: "identity_mismatch", reason: null, name: "MacBook" });
    expect(store.getRemoteInstance(REMOTE_ID)?.reportedName).toBe("MacBook");
  });

  test("a name change on the machine updates the stored name; a label overrides it", async () => {
    const { svc, remote, store } = setup();
    await svc.connect(connectReq);
    remote.instance = { ...(remote.instance as object), name: "Work Mac" };
    expect(await svc.check(REMOTE_ID)).toMatchObject({ name: "Work Mac" });
    expect(store.getRemoteInstance(REMOTE_ID)?.reportedName).toBe("Work Mac");
    expect(svc.rename(REMOTE_ID, "Mac")).toMatchObject({ name: "Mac", label: "Mac" });
    expect(svc.rename(REMOTE_ID, null)).toMatchObject({ name: "Work Mac", label: null });
    expect(svc.rename("nope", "x")).toBeNull();
  });

  test("concurrent checks share one probe", async () => {
    const { svc, fetch } = setup();
    await svc.connect(connectReq);
    fetch.calls.length = 0;
    await Promise.all([svc.check(REMOTE_ID), svc.check(REMOTE_ID), svc.probeAll()]);
    // The three probe requests, then the answering machine's self-update.
    expect(fetch.calls.length).toBe(4);
  });

  test("a machine that answers reports its self-update; one out of reach keeps the last", async () => {
    const update = {
      behind: 2,
      current: "aaaaaaa",
      latest: "bbbbbbb",
      commits: [{ sha: "bbbbbbb", subject: "fix: two" }],
      checkedAt: 7,
    };
    const remote = fakeShepherd({
      update: { ...update, commits: [...update.commits, { sha: "not a sha", subject: "dropped" }] },
    });
    const { svc } = setup(remote);
    expect(svc.updates()).toEqual([]);
    await svc.connect(connectReq);
    expect(svc.updates()).toEqual([
      { instanceId: REMOTE_ID, name: "MacBook", platform: "macos", status: "connected", update },
    ]);

    remote.status["/api/me"] = 500;
    await svc.check(REMOTE_ID);
    expect(svc.updates()[0]).toMatchObject({ status: "unreachable", update });

    // Incompatible still answered: exactly the machine an update would bring back.
    delete remote.status["/api/me"];
    remote.instance = { ...(remote.instance as object), federationApi: FEDERATION_API_VERSION + 1 };
    remote.update = { ...update, behind: 5 };
    await svc.check(REMOTE_ID);
    expect(svc.updates()[0]).toMatchObject({ status: "incompatible", update: { behind: 5 } });

    // A machine that does not say reads as unknown, never as up to date.
    remote.instance = { ...(remote.instance as object), federationApi: FEDERATION_API_VERSION };
    remote.update = { behind: -1, checkedAt: 7 };
    await svc.check(REMOTE_ID);
    expect(svc.updates()[0]).toMatchObject({ status: "connected", update: null });
  });

  test("relayed self-update requests carry the machine's answer, never a lost token as one", async () => {
    const remote = fakeShepherd();
    const { svc, fetch } = setup(remote);
    await svc.connect(connectReq);

    remote.status["/api/update"] = 409;
    expect(await svc.relaySelfUpdate(REMOTE_ID, { kind: "apply", discard: false })).toEqual({
      ok: true,
      status: 409,
      body: { error: "nope" },
    });
    const sent = fetch.calls.at(-1)!;
    expect([sent.url, sent.init.method, sent.init.body]).toEqual([
      `${TARGET.url}/api/update`,
      "POST",
      "{}",
    ]);
    expect((sent.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    remote.status["/api/update"] = 403;
    expect(
      await svc.relaySelfUpdate(REMOTE_ID, { kind: "apply", discard: true, sig: "s1" }),
    ).toEqual({ ok: false, failure: { status: "unauthorized", reason: "token_scope" } });
    expect(fetch.calls.at(-1)!.init.body).toBe(JSON.stringify({ discard: true, sig: "s1" }));

    remote.status["/api/update/log"] = 500;
    expect(await svc.relaySelfUpdate(REMOTE_ID, { kind: "log" })).toEqual({
      ok: false,
      failure: { status: "unreachable", reason: "bad_response" },
    });
    expect(await svc.relaySelfUpdate("nope", { kind: "dirty" })).toBeNull();
  });

  test("a machine removed while its probe is in flight stays removed", async () => {
    const { svc, store, remote } = setup();
    await svc.connect(connectReq);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new RemoteInstanceService({
      store,
      fetch: async (url, init) => {
        await gate;
        return stubFetch(remote)(url, init);
      },
    });
    const pending = slow.check(REMOTE_ID);
    expect(slow.remove(REMOTE_ID)).toBe(true);
    release();
    expect(await pending).toBeNull();
    expect(slow.list()).toEqual([]);
    expect(svc.remove(REMOTE_ID)).toBe(false);
  });

  test("listeners hear every probe result, rename and removal", async () => {
    const { svc } = setup();
    const heard: string[] = [];
    const unsubscribe = svc.onChange((id) => heard.push(`${id}:${svc.get(id)?.status ?? "gone"}`));
    await svc.connect(connectReq);
    await svc.check(REMOTE_ID);
    svc.rename(REMOTE_ID, "Mac");
    svc.remove(REMOTE_ID);
    svc.remove(REMOTE_ID); // nothing left to remove → no call
    unsubscribe();
    await svc.connect(connectReq);
    expect(heard).toEqual([
      `${REMOTE_ID}:connected`,
      `${REMOTE_ID}:connected`,
      `${REMOTE_ID}:connected`,
      `${REMOTE_ID}:gone`,
    ]);
  });

  test("without machines there is no outbound request", async () => {
    const { svc, fetch } = setup();
    svc.start();
    await svc.probeAll();
    svc.stop();
    expect(fetch.calls).toEqual([]);
    expect(await svc.check(REMOTE_ID)).toBeNull();
    expect(fetch.calls).toEqual([]);
  });

  test("the token never reaches a log line", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    try {
      const { svc, remote } = setup();
      await svc.connect(connectReq);
      const rounds: Record<string, number>[] = [{ "/api/me": 401 }, { "/api/repos": 500 }, {}];
      for (const status of rounds) {
        remote.status = status;
        await svc.check(REMOTE_ID);
      }
      svc.remove(REMOTE_ID);
      const logged = spies.flatMap((s) => s.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.some((line) => line.includes("[remote-instances]"))).toBe(true);
      expect(logged.filter((line) => line.includes(TOKEN))).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("remote host load", () => {
  const wireLoad = (load1 = 1, ageMs = 0) => ({
    sampledAt: 999_999,
    load1,
    cpuCount: 8,
    runningSessions: 2,
    ageMs,
    stale: false,
  });
  async function setupLoad() {
    let now = 100_000;
    const remote = fakeShepherd();
    const instance = remote.instance as Record<string, unknown>;
    instance.load = wireLoad();
    const fetch = stubFetch(remote);
    const store = new SessionStore(":memory:");
    const svc = new RemoteInstanceService({ store, fetch, now: () => now });
    await svc.connect({ ...TARGET, label: null });
    return {
      remote,
      instance,
      fetch,
      store,
      svc,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("uses cached fresh data, refreshes only instance load, and throttles missing reports", async () => {
    const { svc, fetch, instance, advance } = await setupLoad();
    const initialCalls = fetch.calls.length;
    await svc.refreshLoads([REMOTE_ID]);
    expect(fetch.calls).toHaveLength(initialCalls);
    advance(15_001);
    instance.load = wireLoad(9.6);
    await svc.refreshLoads([REMOTE_ID, REMOTE_ID]);
    expect(fetch.calls).toHaveLength(initialCalls + 1);
    expect(fetch.calls.at(-1)?.url).toEndWith("/api/instance");
    expect(svc.get(REMOTE_ID)?.load).toMatchObject({
      load1: 9.6,
      sampledAt: 115_001,
      stale: false,
    });
    advance(15_001);
    instance.load = null;
    await svc.refreshLoads([REMOTE_ID]);
    expect(svc.get(REMOTE_ID)?.status).toBe("connected");
    expect(svc.get(REMOTE_ID)?.load).toBeNull();
    const calls = fetch.calls.length;
    await svc.refreshLoads([REMOTE_ID]);
    expect(fetch.calls).toHaveLength(calls);
  });

  test("bad identity, incompatible versions and HTTP failure never imply spare capacity", async () => {
    for (const change of ["identity", "version", "http"] as const) {
      const { svc, remote, instance, advance } = await setupLoad();
      advance(15_001);
      if (change === "identity") instance.instanceId = "different";
      if (change === "version") instance.federationApi = FEDERATION_API_VERSION - 1;
      if (change === "http") remote.status["/api/instance"] = 500;
      await svc.refreshLoads([REMOTE_ID]);
      expect(svc.get(REMOTE_ID)?.load).toBeNull();
      expect(svc.get(REMOTE_ID)?.status).toBe(
        change === "identity"
          ? "identity_mismatch"
          : change === "version"
            ? "incompatible"
            : "connected",
      );
    }
  });

  test("network delay ages the sample; a removed machine cannot receive a late read", async () => {
    let now = 100_000;
    const remote = fakeShepherd();
    const instance = remote.instance as Record<string, unknown>;
    instance.load = wireLoad();
    const base = stubFetch(remote);
    let deferred: ((r: Response) => void) | undefined;
    let delay = false;
    const svc = new RemoteInstanceService({
      store: new SessionStore(":memory:"),
      now: () => now,
      fetch: async (url, init) => {
        if (delay && url.endsWith("/api/instance"))
          return new Promise<Response>((resolve) => {
            deferred = resolve;
          });
        return base(url, init);
      },
    });
    await svc.connect({ ...TARGET, label: null });
    now += 15_001;
    delay = true;
    const read = svc.refreshLoads([REMOTE_ID]);
    const duplicate = svc.refreshLoads([REMOTE_ID]);
    now += 2_000;
    deferred!(jsonRes({ ...instance, load: wireLoad(4, 1_000) }));
    await Promise.all([read, duplicate]);
    expect(svc.get(REMOTE_ID)?.load?.ageMs).toBe(3_000);
    now += 15_001;
    const late = svc.refreshLoads([REMOTE_ID]);
    svc.remove(REMOTE_ID);
    deferred!(jsonRes(instance));
    await late;
    expect(svc.get(REMOTE_ID)).toBeNull();
  });

  test("a slow older full probe does not replace a newer load read", async () => {
    let now = 100_000;
    const remote = fakeShepherd();
    const instance = remote.instance as Record<string, unknown>;
    instance.load = wireLoad(8);
    const base = stubFetch(remote);
    let finishRepos: ((r: Response) => void) | undefined;
    let holdRepos = false;
    const svc = new RemoteInstanceService({
      store: new SessionStore(":memory:"),
      now: () => now,
      fetch: async (url, init) => {
        if (holdRepos && url.endsWith("/api/repos"))
          return new Promise<Response>((resolve) => {
            finishRepos = resolve;
          });
        return base(url, init);
      },
    });
    await svc.connect({ ...TARGET, label: null });
    now += 15_001;
    holdRepos = true;
    const probe = svc.check(REMOTE_ID);
    // Allow the full probe to reach its project read without real sleeps.
    for (let i = 0; i < 50 && !finishRepos; i++) await Promise.resolve();
    expect(finishRepos).toBeDefined();
    now += 1_000;
    instance.load = wireLoad(2);
    await svc.refreshLoads([REMOTE_ID]);
    finishRepos!(jsonRes(remote.repos));
    await probe;
    expect(svc.get(REMOTE_ID)?.load?.load1).toBe(2);
  });
});
