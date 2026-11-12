import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { Steer } from "../src/types";
import type { FetchLike, RemoteRepo } from "../src/remote-instances/client";
import type { RemoteInstanceSummary } from "../src/remote-instances/service";
import {
  type LocalRepo,
  SETTINGS_RELAY_HEADER,
  SettingsSourceService,
  parseSettingsSourceBody,
  sourceIconKeys,
  translateIcons,
  validateIconMap,
} from "../src/settings-source";

const A = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";

const A_REPOS: RemoteRepo[] = [
  {
    name: "shepherd",
    path: "/a/shepherd",
    realPath: "/real/a/shepherd",
    remoteSlug: "Erwins-Enkel/Shepherd",
  },
  { name: "scratch", path: "/a/scratch", realPath: "/a/scratch", remoteSlug: null },
  { name: "app", path: "/a/app", realPath: "/a/app", remoteSlug: "acme/app" },
];

const LOCAL: LocalRepo[] = [
  { path: "/b/sheep", realPath: "/real/b/sheep", slug: "erwins-enkel/shepherd" },
  { path: "/b/other", realPath: "/b/other", slug: "acme/other" },
  { path: "/b/loose", realPath: "/b/loose", slug: null },
];

const steer = (label: string): Steer => ({
  id: `id-${label}`,
  label,
  text: `${label} text`,
  inSteerBar: true,
  onIssues: false,
});

describe("validateIconMap", () => {
  test("accepts a map of paths to emojis, trimming both", () => {
    expect(validateIconMap({ "/a/x": "🐑", " project:a/b ": " 🧪 " })).toEqual({
      "/a/x": "🐑",
      "project:a/b": "🧪",
    });
    expect(validateIconMap({})).toEqual({});
  });

  test("one bad entry rejects the whole map", () => {
    expect(validateIconMap({ "/a/x": "🐑", "/a/y": "" })).toBeNull();
    expect(validateIconMap({ "/a/x": "🐑", "/a/y": 3 })).toBeNull();
    expect(validateIconMap({ "   ": "🐑" })).toBeNull();
    expect(validateIconMap({ ["/" + "x".repeat(1024)]: "🐑" })).toBeNull();
    expect(validateIconMap({ "/a/x": "123456789" })).toBeNull();
    expect(validateIconMap({ "/a/x": "\u0007" })).toBeNull();
  });

  test("anything but an object, or over 500 entries, is refused", () => {
    for (const body of [null, [], "x", 1, undefined]) expect(validateIconMap(body)).toBeNull();
    const big = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`/r/${i}`, "🐑"]));
    expect(validateIconMap(big)).toBeNull();
    delete big["/r/0"];
    expect(Object.keys(validateIconMap(big) ?? {})).toHaveLength(500);
  });
});

describe("translateIcons", () => {
  test("keys a source emoji by both path forms, the project and each local checkout of it", () => {
    expect(translateIcons({ "/a/shepherd": "🐑" }, A_REPOS, LOCAL)).toEqual({
      "/a/shepherd": "🐑",
      "/real/a/shepherd": "🐑",
      "project:erwins-enkel/shepherd": "🐑",
      "/b/sheep": "🐑",
      "/real/b/sheep": "🐑",
    });
  });

  test("a key in realpath form works the same", () => {
    expect(translateIcons({ "/real/a/shepherd": "🐑" }, A_REPOS, LOCAL)).toMatchObject({
      "/a/shepherd": "🐑",
      "/b/sheep": "🐑",
    });
  });

  test("a checkout without a project keeps its path forms only", () => {
    expect(translateIcons({ "/a/scratch": "🧪" }, A_REPOS, LOCAL)).toEqual({
      "/a/scratch": "🧪",
    });
  });

  test("an exact source key always wins over an alias; aliases are first-wins", () => {
    const repos: RemoteRepo[] = [
      ...A_REPOS,
      { name: "fork", path: "/a/fork", realPath: "/a/fork", remoteSlug: "erwins-enkel/shepherd" },
    ];
    const out = translateIcons(
      { "/a/shepherd": "🐑", "/a/fork": "🍴", "/b/sheep": "🌲", "project:acme/app": "📦" },
      repos,
      LOCAL,
    );
    expect(out["/b/sheep"]).toBe("🌲");
    expect(out["/real/b/sheep"]).toBe("🐑");
    // the project chip's key is lower case (`projectFilterKey` in the UI); the source map's first
    // checkout of the project wins it
    expect(out["project:erwins-enkel/shepherd"]).toBe("🐑");
    expect(out["project:Erwins-Enkel/Shepherd"]).toBeUndefined();
    expect(out["project:acme/app"]).toBe("📦");
  });

  test("keys the source has no checkout for pass through unchanged", () => {
    expect(translateIcons({ "/gone": "👻" }, A_REPOS, LOCAL)).toEqual({ "/gone": "👻" });
  });
});

describe("sourceIconKeys", () => {
  const keys = (path: string, emoji: string, map: Record<string, string> = {}, repos = A_REPOS) =>
    sourceIconKeys(path, emoji, map, repos, LOCAL);

  test("a source path or realpath names that checkout; its shown key is kept", () => {
    expect(keys("/a/shepherd", "🐐")).toEqual(["/a/shepherd"]);
    expect(keys("/real/a/shepherd", "🐐")).toEqual(["/a/shepherd"]);
    expect(keys("/a/shepherd", "🐐", { "/real/a/shepherd": "🐑" })).toEqual(["/real/a/shepherd"]);
  });

  test("a project key or a local checkout maps by slug, case-insensitively", () => {
    expect(keys("project:erwins-enkel/SHEPHERD", "🐐")).toEqual(["/a/shepherd"]);
    expect(keys("/b/sheep", "🐐")).toEqual(["/a/shepherd"]);
    expect(keys("/real/b/sheep", "🐐")).toEqual(["/a/shepherd"]);
  });

  test("no checkout of the project there, or no project at all, is null", () => {
    expect(keys("/b/other", "🐐")).toBeNull();
    expect(keys("/b/loose", "🐐")).toBeNull();
    expect(keys("/nowhere", "🐐")).toBeNull();
    expect(keys("project:", "🐐")).toBeNull();
  });

  test("two checkouts of one project: a pick replaces the shown emoji, a clear removes them all", () => {
    const repos: RemoteRepo[] = [
      ...A_REPOS,
      { name: "dup", path: "/a/dup", realPath: "/a/dup", remoteSlug: "erwins-enkel/shepherd" },
    ];
    // The source lists /a/shepherd first, but /a/dup's emoji is the one shown here.
    const map = { "/a/dup": "🌲", "/a/shepherd": "🐑" };
    expect(translateIcons(map, repos, LOCAL)["/b/sheep"]).toBe("🌲");
    expect(keys("/b/sheep", "🐐", map, repos)).toEqual(["/a/dup"]);
    expect(keys("project:erwins-enkel/shepherd", "🐐", map, repos)).toEqual(["/a/dup"]);
    expect(keys("/b/sheep", "", map, repos)).toEqual(["/a/dup", "/a/shepherd"]);
    // none shown yet: the first checkout; a clear of nothing is a harmless clear of it
    expect(keys("/b/sheep", "🐐", {}, repos)).toEqual(["/a/shepherd"]);
    expect(keys("/b/sheep", "", {}, repos)).toEqual(["/a/shepherd"]);
  });
});

describe("parseSettingsSourceBody", () => {
  test("exactly an instance ID or null", () => {
    expect(parseSettingsSourceBody({ instanceId: A })).toBe(A);
    expect(parseSettingsSourceBody({ instanceId: null })).toBeNull();
    for (const body of [
      {},
      { instanceId: "nope" },
      { instanceId: A, extra: 1 },
      { instanceId: 3 },
      null,
      [A],
    ]) {
      expect(parseSettingsSourceBody(body)).toBeUndefined();
    }
  });
});

// ── the service ──

interface FakeMachine {
  name: string;
  status: string;
  steers: unknown;
  icons: unknown;
  /** Status override per path ("GET /api/steers", "PUT /api/project-icons", …). */
  fail: Record<string, number>;
}

function setup(opts: { store?: SessionStore; insert?: boolean } = {}) {
  const store = opts.store ?? new SessionStore(":memory:");
  for (const [id, url] of opts.insert === false
    ? []
    : ([
        [A, "http://a.test"],
        [C, "http://c.test"],
      ] as const)) {
    if (!store.getRemoteInstance(id)) {
      store.insertRemoteInstance({
        instanceId: id,
        url,
        token: `token-${id.slice(0, 4)}`,
        label: null,
        reportedName: id === A ? "Studio" : "Laptop",
        createdAt: 1,
      });
    }
  }
  const machines = new Map<string, FakeMachine>([
    [
      A,
      {
        name: "Studio",
        status: "connected",
        steers: [steer("rebase")],
        icons: { "/a/shepherd": "🐑" },
        fail: {},
      },
    ],
    [C, { name: "Laptop", status: "connected", steers: [steer("c")], icons: {}, fail: {} }],
  ]);
  const repoIndex = new Map<string, RemoteRepo[]>([[A, A_REPOS]]);
  const listeners = new Set<(id: string) => void>();
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const id = u.host === "a.test" ? A : C;
    const machine = machines.get(id)!;
    const method = init.method ?? "GET";
    const fail = machine.fail[`${method} ${u.pathname}`];
    if (fail) return Response.json({ error: "nope" }, { status: fail });
    const field = u.pathname === "/api/steers" ? "steers" : "icons";
    if (method === "PUT") {
      const body = JSON.parse(init.body as string);
      if (field === "steers") machine.steers = body;
      else if (typeof machine.icons === "object") {
        const icons: Record<string, string> = { ...machine.icons, [body.path]: body.emoji };
        if (body.emoji === "") delete icons[body.path];
        machine.icons = icons;
      }
    }
    return Response.json(machine[field]);
  };
  const events: [string, unknown][] = [];
  const instances = {
    get: (id: string) => {
      const m = machines.get(id);
      return m && store.getRemoteInstance(id)
        ? ({ instanceId: id, name: m.name, status: m.status } as RemoteInstanceSummary)
        : null;
    },
    repoIndex: (id: string) => repoIndex.get(id) ?? [],
    onChange: (listener: (id: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const local = { steers: [steer("mine")], icons: { "/b/sheep": "🏠" } };
  const svc = new SettingsSourceService({
    store,
    instances,
    emit: (event, data) => events.push([event, data]),
    localRepos: () => LOCAL,
    localSteers: () => local.steers,
    localIcons: () => local.icons,
    fetch,
  });
  return {
    store,
    svc,
    machines,
    repoIndex,
    calls,
    events,
    local,
    change: (id: string) => {
      for (const listener of listeners) listener(id);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastOf = (events: [string, unknown][], name: string) =>
  events.filter(([e]) => e === name).at(-1)?.[1];

describe("SettingsSourceService", () => {
  test("no source: inactive, no view, local steers and emojis", async () => {
    const t = setup();
    expect(t.svc.active()).toBe(false);
    expect(t.svc.view()).toBeNull();
    expect(await t.svc.steers()).toEqual(t.local.steers);
    expect(await t.svc.icons()).toEqual(t.local.icons);
    expect(t.calls).toEqual([]);
  });

  test("an unknown machine cannot be the source", () => {
    const t = setup();
    expect(t.svc.set("22222222-2222-4222-8222-222222222222")).toEqual({ ok: false });
    expect(t.store.getSetting("settingsSource")).toBeNull();
  });

  test("setting a source persists it, announces it and reads it in the background", async () => {
    const t = setup();
    const result = t.svc.set(A);
    expect(result).toEqual({
      ok: true,
      view: { instanceId: A, name: "Studio", reachable: true, repos: A_REPOS },
    });
    expect(JSON.parse(t.store.getSetting("settingsSource")!)).toEqual({ instanceId: A });
    // At once: the source and an empty effective list — never this Shepherd's own.
    expect(t.events.slice(0, 3)).toEqual([
      ["settings-source:update", result.ok && result.view],
      ["steers:update", []],
      ["project-icons:update", {}],
    ]);
    await flush();
    expect(lastOf(t.events, "steers:update")).toEqual([steer("rebase")]);
    expect(lastOf(t.events, "project-icons:update")).toMatchObject({ "/b/sheep": "🐑" });
    for (const { init } of t.calls) {
      expect((init.headers as Record<string, string>)[SETTINGS_RELAY_HEADER]).toBe("1");
    }
  });

  test("reads go through to the source and are cached; out of reach the cache is served", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    t.machines.get(A)!.steers = [steer("fresh")];
    expect(await t.svc.steers()).toEqual([steer("fresh")]);
    expect(await t.svc.icons()).toEqual({
      "/a/shepherd": "🐑",
      "/real/a/shepherd": "🐑",
      "project:erwins-enkel/shepherd": "🐑",
      "/b/sheep": "🐑",
      "/real/b/sheep": "🐑",
    });
    t.machines.get(A)!.status = "unreachable";
    const before = t.calls.length;
    expect(await t.svc.steers()).toEqual([steer("fresh")]);
    expect((await t.svc.icons())["/b/sheep"]).toBe("🐑");
    expect(t.calls.length).toBe(before);
    // …and after a restart, from the persisted cache.
    const restarted = setup({ store: t.store });
    restarted.machines.get(A)!.status = "unreachable";
    expect(await restarted.svc.steers()).toEqual([steer("fresh")]);
    expect((await restarted.svc.icons())["/b/sheep"]).toBe("🐑");
    expect(restarted.svc.view()?.repos).toEqual(A_REPOS);
  });

  test("a failing source request falls back to the cache", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    t.machines.get(A)!.fail = { "GET /api/steers": 500 };
    expect(await t.svc.steers()).toEqual([steer("rebase")]);
  });

  test("a source that never answered serves an empty list, not this Shepherd's own", async () => {
    const t = setup();
    t.machines.get(A)!.status = "unreachable";
    t.svc.set(A);
    expect(await t.svc.steers()).toEqual([]);
    expect(await t.svc.icons()).toEqual({});
    expect(t.calls).toEqual([]);
  });

  test("invalid answers are neither returned nor cached", async () => {
    const t = setup();
    t.machines.get(A)!.steers = [{ label: "", text: "x" }];
    t.machines.get(A)!.icons = { "/a/shepherd": 7 };
    t.svc.set(A);
    await flush();
    expect(await t.svc.steers()).toEqual([]);
    expect(await t.svc.icons()).toEqual({});
    const cache = JSON.parse(t.store.getSetting("settingsSourceCache")!);
    expect(cache).toMatchObject({ instanceId: A, steers: null, icons: null });
  });

  test("writes go to the source and update the cache; out of reach they are refused unsent", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    const saved = await t.svc.putSteers([steer("new")]);
    expect(saved).toEqual({ ok: true, value: [steer("new")] });
    expect(t.machines.get(A)!.steers).toEqual([steer("new")]);
    expect(lastOf(t.events, "steers:update")).toEqual([steer("new")]);
    const put = t.calls.at(-1)!;
    expect(put.url).toBe("http://a.test/api/steers");
    expect(put.init.method).toBe("PUT");
    expect(put.init.headers).toMatchObject({
      "content-type": "application/json",
      [SETTINGS_RELAY_HEADER]: "1",
      authorization: `Bearer token-${A.slice(0, 4)}`,
    });

    t.machines.get(A)!.status = "unreachable";
    const before = t.calls.length;
    const refused = { ok: false, status: 503, code: "settings_source_unreachable" } as const;
    expect(await t.svc.putSteers([steer("x")])).toEqual(refused);
    expect(await t.svc.putIcon("/b/sheep", "🐐")).toEqual(refused);
    expect(t.calls.length).toBe(before);
  });

  test("a refused or garbled write is a failed one, and nothing is cached", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    t.machines.get(A)!.fail = { "PUT /api/steers": 400 };
    const failed = { ok: false, status: 502, code: "settings_source_failed" } as const;
    expect(await t.svc.putSteers([steer("x")])).toEqual(failed);
    t.machines.get(A)!.fail = { "PUT /api/steers": 401 };
    expect(await t.svc.putSteers([steer("x")])).toMatchObject({ status: 503 });
    t.machines.get(A)!.fail = {};
    t.machines.get(A)!.icons = "garbled";
    expect(await t.svc.putIcon("/a/shepherd", "🐐")).toEqual(failed);
    expect(await t.svc.steers()).toEqual([steer("rebase")]);
  });

  test("an emoji set for a local checkout lands under the source's path for its project", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    const result = await t.svc.putIcon("/b/sheep", "🐐");
    expect(JSON.parse(t.calls.at(-1)!.init.body as string)).toEqual({
      path: "/a/shepherd",
      emoji: "🐐",
    });
    expect(result.ok && result.value["/b/sheep"]).toBe("🐐");
    expect(lastOf(t.events, "project-icons:update")).toMatchObject({ "/b/sheep": "🐐" });
    const before = t.calls.length;
    expect(await t.svc.putIcon("/b/other", "🐐")).toEqual({
      ok: false,
      status: 409,
      code: "settings_source_no_repo",
    });
    expect(t.calls.length).toBe(before);
  });

  test("two source checkouts of one project: a pick changes the shown emoji, a clear removes it", async () => {
    const t = setup();
    t.repoIndex.set(A, [
      ...A_REPOS,
      { name: "dup", path: "/a/dup", realPath: "/a/dup", remoteSlug: "erwins-enkel/shepherd" },
    ]);
    t.machines.get(A)!.icons = { "/a/dup": "🌲", "/a/shepherd": "🐑" };
    t.svc.set(A);
    await flush();
    const puts = () =>
      t.calls
        .filter((c) => c.init.method === "PUT")
        .map((c) => JSON.parse(c.init.body as string) as { path: string; emoji: string });

    const picked = await t.svc.putIcon("/b/sheep", "🐐");
    expect(puts()).toEqual([{ path: "/a/dup", emoji: "🐐" }]);
    expect(picked.ok && picked.value["/b/sheep"]).toBe("🐐");

    const cleared = await t.svc.putIcon("project:erwins-enkel/shepherd", "");
    expect(puts().slice(1)).toEqual([
      { path: "/a/dup", emoji: "" },
      { path: "/a/shepherd", emoji: "" },
    ]);
    expect(cleared.ok && cleared.value["/b/sheep"]).toBeUndefined();
    expect(cleared.ok && cleared.value["project:erwins-enkel/shepherd"]).toBeUndefined();
  });

  test("the source's live frames re-read it (validated, cached, re-emitted); others are ignored", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    const count = t.events.length;
    const calls = t.calls.length;
    // Another machine's frames, and frames that are no settings, read nothing.
    t.svc.onMachineEvent(C, "steers:update");
    t.svc.onMachineEvent(A, "repos:update");
    await flush();
    expect(t.calls.length).toBe(calls);

    // A frame is only a signal: the source is re-read with the relay header, and an invalid
    // answer is neither cached nor emitted.
    t.machines.get(A)!.steers = [{ nope: true }];
    t.machines.get(A)!.icons = { "/a/app": "" };
    t.svc.onMachineEvent(A, "steers:update");
    t.svc.onMachineEvent(A, "project-icons:update");
    await flush();
    expect(t.calls.slice(calls).map((c) => new URL(c.url).pathname)).toEqual([
      "/api/steers",
      "/api/project-icons",
    ]);
    expect(
      t.calls
        .slice(calls)
        .every((c) => new Headers(c.init.headers).get("x-shepherd-settings-relay")),
    ).toBe(true);
    expect(t.events.length).toBe(count);

    t.machines.get(A)!.steers = [steer("live")];
    t.machines.get(A)!.icons = { "/a/app": "📦" };
    t.svc.onMachineEvent(A, "steers:update");
    t.svc.onMachineEvent(A, "project-icons:update");
    await flush();
    expect(t.events.slice(count)).toEqual([
      ["steers:update", [steer("live")]],
      ["project-icons:update", { "/a/app": "📦", "project:acme/app": "📦" }],
    ]);
    t.machines.get(A)!.status = "unreachable";
    expect(await t.svc.steers()).toEqual([steer("live")]);
  });

  test("removing the source machine clears the source and brings back this Shepherd's own", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    t.store.deleteRemoteInstance(A);
    t.change(A);
    expect(t.svc.active()).toBe(false);
    expect(t.store.getSetting("settingsSource")).toBeNull();
    expect(t.store.getSetting("settingsSourceCache")).toBeNull();
    expect(t.events.slice(-3)).toEqual([
      ["settings-source:update", null],
      ["steers:update", t.local.steers],
      ["project-icons:update", t.local.icons],
    ]);
  });

  test("a machine removed while this Shepherd was down is no source after the restart", () => {
    const t = setup();
    t.svc.set(A);
    t.store.deleteRemoteInstance(A);
    const restarted = setup({ store: t.store, insert: false });
    expect(restarted.svc.active()).toBe(false);
    expect(t.store.getSetting("settingsSource")).toBeNull();
  });

  test("clearing the source announces this Shepherd's own steers and emojis", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    expect(t.svc.set(null)).toEqual({ ok: true, view: null });
    expect(t.events.slice(-2)).toEqual([
      ["steers:update", t.local.steers],
      ["project-icons:update", t.local.icons],
    ]);
    expect(await t.svc.steers()).toEqual(t.local.steers);
  });

  test("switching to another source starts from an empty cache", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    t.machines.get(C)!.status = "unreachable";
    t.svc.set(C);
    expect(await t.svc.steers()).toEqual([]);
    expect(JSON.parse(t.store.getSetting("settingsSourceCache")!)).toEqual({
      instanceId: C,
      steers: null,
      icons: null,
      repos: null,
    });
  });

  test("a corrupt or foreign cache reads as empty", async () => {
    const t = setup();
    t.svc.set(A);
    t.store.setSetting("settingsSourceCache", "{not json");
    const corrupt = setup({ store: t.store });
    corrupt.machines.get(A)!.status = "unreachable";
    expect(await corrupt.svc.steers()).toEqual([]);
    t.store.setSetting(
      "settingsSourceCache",
      JSON.stringify({ instanceId: C, steers: [steer("c")], icons: null, repos: null }),
    );
    const foreign = setup({ store: t.store });
    foreign.machines.get(A)!.status = "unreachable";
    expect(await foreign.svc.steers()).toEqual([]);
  });

  test("the first answer after an outage refreshes; a reach change is announced once", async () => {
    const t = setup();
    t.machines.get(A)!.status = "unreachable";
    t.svc.set(A);
    t.change(A);
    const count = t.events.length;
    t.change(A);
    expect(t.events.length).toBe(count);

    t.machines.get(A)!.status = "connected";
    t.change(A);
    expect(lastOf(t.events, "settings-source:update")).toMatchObject({ reachable: true });
    await flush();
    expect(lastOf(t.events, "steers:update")).toEqual([steer("rebase")]);
    const settled = t.events.length;
    t.change(A);
    await flush();
    expect(t.events.length).toBe(settled);
  });

  test("a new repo list from the probe is cached and re-keys the emojis", async () => {
    const t = setup();
    t.svc.set(A);
    await flush();
    const moved: RemoteRepo[] = [
      { name: "shepherd", path: "/a/shepherd", realPath: "/a/shepherd", remoteSlug: "acme/other" },
    ];
    t.repoIndex.set(A, moved);
    t.change(A);
    expect(lastOf(t.events, "project-icons:update")).toEqual({
      "/a/shepherd": "🐑",
      "project:acme/other": "🐑",
      "/b/other": "🐑",
    });
    expect(lastOf(t.events, "settings-source:update")).toMatchObject({ repos: moved });
    expect(JSON.parse(t.store.getSetting("settingsSourceCache")!).repos).toEqual(moved);
  });
});
