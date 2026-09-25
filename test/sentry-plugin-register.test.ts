// Sentry plugin (#2464): loads from the real bundled dir, is inert by default, publishes a
// valid panel, and its routes validate operator input.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import { applySettingsForm, normalizeHost } from "../src/plugins/bundled/sentry";
import { STRINGS } from "../src/plugins/bundled/sentry/panel";
import { DEFAULT_SETTINGS } from "../src/plugins/bundled/sentry/state";
import type { PluginRepo } from "../src/plugins/types";

const BUNDLED = resolve(import.meta.dir, "../src/plugins/bundled");

async function load() {
  const empty = mkdtempSync(join(tmpdir(), "shep-sentry-reg-"));
  const secretsDir = mkdtempSync(join(tmpdir(), "shep-sentry-sec-"));
  const repos: PluginRepo[] = [
    { path: "/r/web", name: "web", autoLabel: "shepherd:auto", lightweight: false },
    { path: "/r/local", name: "local", autoLabel: "shepherd:auto", lightweight: true },
  ];
  const store = new SessionStore(":memory:");
  const reg = new PluginRegistry({
    pluginsDir: empty,
    bundledPluginsDir: BUNDLED,
    store,
    events: new EventHub(),
    repos: () => repos,
    secretsPath: join(secretsDir, "secrets.json"),
  });
  await reg.loadAll();
  const post = (path: string, body: unknown) =>
    reg.handleRoute(
      "POST",
      "sentry",
      path,
      new Request("http://x/", { method: "POST", body: JSON.stringify(body) }),
    );
  const cleanup = () => {
    reg.teardown();
    rmSync(empty, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  };
  return { reg, store, post, cleanup };
}

test("bundled sentry plugin loads ok, disabled, with a valid settings panel", async () => {
  const { reg, store, cleanup } = await load();
  try {
    const info = reg.list().find((p) => p.id === "sentry")!;
    expect(info.health).toBe("ok");
    expect(info.ui?.slot).toBe("settings-panel");
    expect(JSON.stringify(info.ui)).toContain("Connection");
    // Nothing persisted as "enabled" — the plugin is inert until the operator turns it on.
    expect(store.getPluginState("sentry", "settings")).toBeNull();
  } finally {
    cleanup();
  }
});

test("settings route validates, stores the token as a secret, and never publishes it", async () => {
  const { reg, store, post, cleanup } = await load();
  try {
    expect((await post("settings", { host: "ftp://x" }))!.status).toBe(400);
    expect((await post("settings", { org: "Not A Slug" }))!.status).toBe(400);
    const res = await post("settings", {
      host: "https://sentry.example.com/",
      org: "acme",
      token: "sntrys_SECRET_TOKEN",
      pollMinutes: 0,
      minTimesSeen: 3,
      locale: "de",
    });
    expect(res!.status).toBe(200);
    expect(JSON.parse(store.getPluginState("sentry", "settings")!)).toMatchObject({
      enabled: false,
      host: "https://sentry.example.com",
      org: "acme",
      pollMinutes: 1,
      minTimesSeen: 3,
      locale: "de",
    });
    const info = reg.list().find((p) => p.id === "sentry")!;
    expect(JSON.stringify(info)).not.toContain("sntrys_SECRET_TOKEN");
    expect(JSON.stringify(info.ui)).toContain("Verbindung");
    expect(
      store
        .listPluginStateKeys("sentry")
        .some((k) => (store.getPluginState("sentry", k) ?? "").includes("sntrys_SECRET_TOKEN")),
    ).toBe(false);
  } finally {
    cleanup();
  }
});

test("mapping routes: add/confirm validate repo + slug; lightweight repos refused; toggle + remove", async () => {
  const { store, post, cleanup } = await load();
  try {
    expect((await post("mapping/add", { mapRepo: "/r/local", mapProject: "web" }))!.status).toBe(
      400,
    );
    expect((await post("mapping/add", { mapRepo: "/r/nope", mapProject: "web" }))!.status).toBe(
      400,
    );
    expect((await post("mapping/add", { mapRepo: "/r/web", mapProject: "Bad!" }))!.status).toBe(
      400,
    );
    expect((await post("mapping/add", { mapRepo: "/r/web", mapProject: "web" }))!.status).toBe(200);
    const mappings = () => JSON.parse(store.getPluginState("sentry", "mappings")!);
    expect(mappings()).toEqual({
      "/r/web": { project: "web", autoDrain: false, source: "manual" },
    });

    expect((await post("mapping/auto-drain", { repo: "/r/web", autoDrain: true }))!.status).toBe(
      200,
    );
    expect(mappings()["/r/web"].autoDrain).toBe(true);
    // Re-confirming keeps the operator's auto-drain choice.
    expect((await post("mapping/confirm", { repo: "/r/web", project: "web2" }))!.status).toBe(200);
    expect(mappings()["/r/web"]).toEqual({ project: "web2", autoDrain: true, source: "manual" });

    expect((await post("mapping/remove", { repo: "/r/web" }))!.status).toBe(200);
    expect(mappings()).toEqual({});
    expect((await post("mapping/remove", { repo: "/r/web" }))!.status).toBe(404);
  } finally {
    cleanup();
  }
});

test("normalizeHost / applySettingsForm", () => {
  expect(normalizeHost("https://sentry.io/")).toBe("https://sentry.io");
  expect(normalizeHost("http://sentry.local:9000/base/")).toBe("http://sentry.local:9000/base");
  expect(normalizeHost("https://u:p@sentry.io")).toBeNull();
  expect(normalizeHost("javascript:alert(1)")).toBeNull();
  const t = STRINGS.en;
  expect(applySettingsForm(DEFAULT_SETTINGS, { enabled: true, org: "" }, t)).toMatchObject({
    enabled: true,
    org: "",
  });
  expect(applySettingsForm(DEFAULT_SETTINGS, { pollMinutes: 99999 }, t)).toMatchObject({
    pollMinutes: 1440,
  });
});

test("a maximal panel (row caps hit everywhere) still passes the host UI validator", async () => {
  const { buildView } = await import("../src/plugins/bundled/sentry/panel");
  const { validatePluginUIView } = await import("../src/plugins/ui-validate");
  const repos = Array.from({ length: 200 }, (_, i) => ({
    path: `/r/repo-${i}`,
    name: `repo-${i}`,
    autoLabel: "shepherd:auto",
    lightweight: false,
  }));
  const mappings = Object.fromEntries(
    repos
      .slice(0, 50)
      .map((r) => [r.path, { project: "p", autoDrain: false, source: "manual" as const }]),
  );
  const rejected = Array.from({ length: 60 }, (_, i) => ({
    sentryId: String(i),
    shortId: `APP-${i}`,
    repo: "/r/repo-0",
    title: "Sentry APP: production error in p",
    permalink: "",
    untrusted: [],
    regressionKey: null,
    verdict: null,
    reason: "r".repeat(400),
    outcome: "rejected" as const,
    overridden: false,
    triagedAt: "2026-09-25T00:00:00Z",
  }));
  const view = buildView({
    settings: { ...DEFAULT_SETTINGS, org: "acme" },
    hasToken: true,
    status: { lastPollAt: 1, lastError: "x", backoffUntil: 0, strikes: 0, lastResult: { ok: 1 } },
    mappings,
    suggestions: repos
      .slice(50, 80)
      .map((r) => ({ repo: r.path, org: "other", project: "p", source: "sentry-config" as const })),
    repos,
    filedToday: () => 1,
    rejected,
  });
  expect(validatePluginUIView(view)).not.toBeNull();
});
