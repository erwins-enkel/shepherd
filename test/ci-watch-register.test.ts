// ci-watch plugin (#2540): loads from the real bundled dir and is inert by default.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";

const BUNDLED = resolve(import.meta.dir, "../src/plugins/bundled");

test("ci-watch loads as a bundled plugin", async () => {
  const empty = mkdtempSync(join(tmpdir(), "shep-ciwatch-reg-"));
  const secretsDir = mkdtempSync(join(tmpdir(), "shep-ciwatch-sec-"));
  try {
    const reg = new PluginRegistry({
      pluginsDir: empty,
      bundledPluginsDir: BUNDLED,
      store: new SessionStore(":memory:"),
      events: new EventHub(),
      repos: () => [],
      secretsPath: join(secretsDir, "secrets.json"),
    });
    await reg.loadAll();
    const p = reg.list().find((x) => x.id === "ci-watch");
    expect(p).toMatchObject({ id: "ci-watch", bundled: true });
    expect(p?.health).not.toBe("errored");
    expect(p?.lastError).toBeFalsy();
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  }
});

async function load() {
  const empty = mkdtempSync(join(tmpdir(), "shep-ciwatch-reg-"));
  const secretsDir = mkdtempSync(join(tmpdir(), "shep-ciwatch-sec-"));
  const store = new SessionStore(":memory:");
  const reg = new PluginRegistry({
    pluginsDir: empty,
    bundledPluginsDir: BUNDLED,
    store,
    events: new EventHub(),
    repos: () => [
      { path: "/r/web", name: "web", autoLabel: "shepherd:auto", lightweight: false },
      { path: "/r/api", name: "api", autoLabel: "shepherd:auto", lightweight: false },
      { path: "/r/app", name: "app", autoLabel: "shepherd:auto", lightweight: false },
      { path: "/r/local", name: "local", autoLabel: "shepherd:auto", lightweight: true },
    ],
    secretsPath: join(secretsDir, "secrets.json"),
  });
  await reg.loadAll();
  const post = (path: string, body: unknown) =>
    reg.handleRoute(
      "POST",
      "ci-watch",
      path,
      new Request("http://x/", { method: "POST", body: JSON.stringify(body) }),
    );
  const panel = () => JSON.stringify(reg.list().find((x) => x.id === "ci-watch")?.ui);
  const cleanup = () => {
    reg.teardown();
    rmSync(empty, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  };
  return { reg, store, post, panel, cleanup };
}

test("ci-watch publishes a settings panel; settings route persists + switches locale", async () => {
  const { reg, store, post, panel, cleanup } = await load();
  try {
    expect(reg.list().find((x) => x.id === "ci-watch")?.ui?.slot).toBe("settings-panel");
    expect(panel()).toContain("Save settings");
    const res = await post("settings", {
      enabled: true,
      pollMinutes: 5000,
      probeSkipGlobs: "Eval*, nightly",
      locale: "de",
    });
    expect(res!.status).toBe(200);
    expect(JSON.parse(store.getPluginState("ci-watch", "settings")!)).toEqual({
      enabled: true,
      pollMinutes: 1440,
      probeSkipGlobs: ["Eval*", "nightly"],
      locale: "de",
    });
    expect(await res!.text()).toBe("Gespeichert.");
    expect(panel()).toContain("Einstellungen speichern");
  } finally {
    cleanup();
  }
});

test("repo routes: add refuses unknown/lightweight; save persists the repo form", async () => {
  const { store, post, panel, cleanup } = await load();
  const { repoFieldId } = await import("../src/plugins/bundled/ci-watch/panel");
  try {
    expect((await post("repo/add", { addRepos: ["/r/nope"] }))!.status).toBe(400);
    expect((await post("repo/add", { addRepos: ["/r/local"] }))!.status).toBe(400);
    expect((await post("repo/add", { addRepos: ["/r/web"] }))!.status).toBe(200);
    const repos = () => JSON.parse(store.getPluginState("ci-watch", "repos")!);
    expect(repos()["/r/web"]).toMatchObject({ enabled: true, autoDrain: false, threshold: 1 });
    expect(panel()).toContain(`thr.${repoFieldId("/r/web")}`);

    const id = repoFieldId("/r/web");
    expect((await post("repo/save", { repo: "/r/web", [`ovr.${id}`]: "junk" }))!.status).toBe(400);
    expect((await post("repo/save", { repo: "/r/local" }))!.status).toBe(400);
    const res = await post("repo/save", {
      repo: "/r/web",
      [`en.${id}`]: false,
      [`ad.${id}`]: true,
      [`thr.${id}`]: 3,
      [`ovr.${id}`]: "Eval*=5",
    });
    expect(res!.status).toBe(200);
    expect(repos()["/r/web"]).toEqual({
      enabled: false,
      autoDrain: true,
      threshold: 3,
      overrides: [{ glob: "Eval*", threshold: 5 }],
    });
  } finally {
    cleanup();
  }
});

test("repo/add takes several repos in one POST and validates all of them first", async () => {
  const { store, post, panel, cleanup } = await load();
  const { repoFieldId } = await import("../src/plugins/bundled/ci-watch/panel");
  const { STRINGS } = await import("../src/plugins/bundled/ci-watch/panel");
  const repos = () => JSON.parse(store.getPluginState("ci-watch", "repos") ?? "{}");
  try {
    for (const addRepos of [[], "/r/web", undefined]) {
      const res = await post("repo/add", { addRepos });
      expect(res!.status).toBe(400);
      expect(await res!.text()).toBe(STRINGS.en.pickRepo);
    }
    // One bad path refuses the whole body, including the good one before it.
    expect((await post("repo/add", { addRepos: ["/r/web", "/r/nope"] }))!.status).toBe(400);
    expect((await post("repo/add", { addRepos: ["/r/web", 7] }))!.status).toBe(400);
    expect(repos()).toEqual({});

    const res = await post("repo/add", { addRepos: ["/r/web", "/r/api", "/r/web"] });
    expect(res!.status).toBe(200);
    expect(Object.keys(repos()).sort()).toEqual(["/r/api", "/r/web"]);
    expect(repos()["/r/web"].enabled).toBe(true);
    // Several added: nothing opens. The added repos have left the picker.
    expect(panel()).not.toContain(`thr.${repoFieldId("/r/web")}`);
    expect(panel()).not.toContain('{"value":"/r/web","label":"web"}');
    expect(panel()).toContain('{"value":"/r/app","label":"app"}');
  } finally {
    cleanup();
  }
});

test("repo/open toggles one form silently and refuses an unconfigured repo", async () => {
  const { post, panel, cleanup } = await load();
  const { repoFieldId } = await import("../src/plugins/bundled/ci-watch/panel");
  const form = (repo: string) => `thr.${repoFieldId(repo)}`;
  try {
    await post("repo/add", { addRepos: ["/r/web", "/r/api"] });
    expect((await post("repo/open", { repo: "/r/app" }))!.status).toBe(400);
    const res = await post("repo/open", { repo: "/r/web" });
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("");
    expect(panel()).toContain(form("/r/web"));
    await post("repo/open", { repo: "/r/api" });
    expect(panel()).toContain(form("/r/api"));
    expect(panel()).not.toContain(form("/r/web"));
    await post("repo/open", { repo: "/r/api" });
    expect(panel()).not.toContain(form("/r/api"));
  } finally {
    cleanup();
  }
});
