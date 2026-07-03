import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginUpdateService, type GitRunner } from "../src/plugin-update";

/** Build a temp plugins dir with one folder per given plugin manifest. Returns
 *  the dir path; caller rms it. A `null` manifest writes a non-plugin folder. */
function makePluginsDir(plugins: Record<string, object | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-plugins-"));
  for (const [name, manifest] of Object.entries(plugins)) {
    mkdirSync(join(dir, name));
    if (manifest) writeFileSync(join(dir, name, "plugin.json"), JSON.stringify(manifest));
    else writeFileSync(join(dir, name, "readme.txt"), "not a plugin");
  }
  return dir;
}

const okManifest = (over: object = {}) => ({
  id: "p",
  name: "P",
  version: "1.2.0",
  apiVersion: 1,
  ...over,
});

// A git runner that dispatches on the first args; unmatched calls throw.
function fakeGit(handlers: Record<string, (args: string[], cwd?: string) => string>): GitRunner {
  return async (args, cwd) => {
    const key = args.join(" ");
    for (const [prefix, fn] of Object.entries(handlers)) {
      if (key.startsWith(prefix)) return fn(args, cwd);
    }
    throw new Error(`unexpected git call: ${key}`);
  };
}

// ── declared repository (ls-remote tags) ─────────────────────────────────────
test("repository: a higher remote tag is update-available", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = fakeGit({
    "ls-remote": () => "aaa\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.3.0\nccc\trefs/tags/v1.1.0\n",
  });
  const svc = new PluginUpdateService({ pluginsDir: dir, git });
  const st = await svc.check(1);
  expect(st.updateAvailable).toBe(true);
  expect(st.plugins[0]).toMatchObject({
    state: "update-available",
    source: "repository",
    currentVersion: "1.2.0",
    latestVersion: "1.3.0",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("repository: an equal latest tag is up-to-date", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = fakeGit({ "ls-remote": () => "aaa\trefs/tags/v1.2.0\n" });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.updateAvailable).toBe(false);
  expect(st.plugins[0]!.state).toBe("up-to-date");
  rmSync(dir, { recursive: true, force: true });
});

test("repository: a LOWER remote tag is NOT reported as update-available (semver, not !=)", async () => {
  const dir = makePluginsDir({
    p: okManifest({ version: "2.0.0", repository: "https://x/p.git" }),
  });
  const git = fakeGit({ "ls-remote": () => "aaa\trefs/tags/v1.9.9\n" });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]).toMatchObject({ state: "up-to-date", latestVersion: "1.9.9" });
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("repository: no version tags on the remote is an error, not a false badge", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = fakeGit({ "ls-remote": () => "aaa\trefs/tags/latest\nbbb\trefs/tags/nightly\n" });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("error");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// ── git checkout (upstream manifest) ─────────────────────────────────────────
test("git checkout: higher upstream manifest version is update-available", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": () => "true\n",
    "rev-parse --abbrev-ref @{upstream}": () => "origin/main\n",
    fetch: () => "",
    "show @{upstream}:plugin.json": () => JSON.stringify(okManifest({ version: "1.4.0" })),
  });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]).toMatchObject({
    state: "update-available",
    source: "git",
    latestVersion: "1.4.0",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("git checkout: an upstream apiVersion bump is incompatible, not update-available", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": () => "true\n",
    "rev-parse --abbrev-ref @{upstream}": () => "origin/main\n",
    fetch: () => "",
    "show @{upstream}:plugin.json": () =>
      JSON.stringify(okManifest({ version: "2.0.0", apiVersion: 2 })),
  });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("incompatible");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("git checkout: no upstream branch is no-source, not error", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": () => "true\n",
    "rev-parse --abbrev-ref @{upstream}": () => {
      throw new Error("no upstream configured");
    },
  });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("no-source");
  rmSync(dir, { recursive: true, force: true });
});

// ── no source / edge cases ───────────────────────────────────────────────────
test("no repository and not a git checkout is no-source", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": () => {
      throw new Error("not a git repository");
    },
  });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]).toMatchObject({ state: "no-source", source: "none" });
  rmSync(dir, { recursive: true, force: true });
});

test("an installed version that is not semver is an error", async () => {
  const dir = makePluginsDir({
    p: okManifest({ version: "not-a-version", repository: "https://x/p.git" }),
  });
  const git = fakeGit({ "ls-remote": () => "aaa\trefs/tags/v1.0.0\n" });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("error");
  rmSync(dir, { recursive: true, force: true });
});

test("a per-plugin git failure is isolated, not thrown, and raises no badge", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = fakeGit({
    "ls-remote": () => {
      throw new Error("network down");
    },
  });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("error");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("non-plugin folders are skipped; folders sort deterministically", async () => {
  const dir = makePluginsDir({
    zeta: okManifest({ id: "zeta", repository: "https://x/z.git" }),
    "not-a-plugin": null,
    alpha: okManifest({ id: "alpha", repository: "https://x/a.git" }),
  });
  const git = fakeGit({ "ls-remote": () => "aaa\trefs/tags/v1.2.0\n" });
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a missing plugins dir yields an empty list, not an error", async () => {
  const st = await new PluginUpdateService({
    pluginsDir: join(tmpdir(), "shepherd-does-not-exist-xyz"),
    git: fakeGit({}),
  }).check(1);
  expect(st.plugins).toEqual([]);
  expect(st.updateAvailable).toBe(false);
});

test("current() returns the last computed status", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const svc = new PluginUpdateService({
    pluginsDir: dir,
    git: fakeGit({ "ls-remote": () => "aaa\trefs/tags/v1.2.0\n" }),
  });
  expect(svc.current()).toBeNull();
  await svc.check(42);
  expect(svc.current()!.checkedAt).toBe(42);
  rmSync(dir, { recursive: true, force: true });
});
