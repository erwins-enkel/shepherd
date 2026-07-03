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

// A git runner that dispatches on the joined args prefix; unmatched calls throw.
function fakeGit(handlers: Record<string, (args: string[], cwd?: string) => string>): GitRunner {
  return async (args, cwd) => {
    const key = args.join(" ");
    for (const [prefix, fn] of Object.entries(handlers)) {
      if (key.startsWith(prefix)) return fn(args, cwd);
    }
    throw new Error(`unexpected git call: ${key}`);
  };
}

/** Repository-path git: ls-remote returns the tag lines, and the candidate tag's
 *  plugin.json (read via the scratch init/fetch/show) is `candidate`. */
function repoGit(tagLines: string, candidate: object): GitRunner {
  return fakeGit({
    "ls-remote": () => tagLines,
    init: () => "",
    fetch: () => "",
    show: () => JSON.stringify(candidate),
  });
}

/** Git-checkout path: a work tree with an upstream whose plugin.json is `upstream`. */
function checkoutGit(upstream: object): GitRunner {
  return fakeGit({
    "rev-parse --is-inside-work-tree": () => "true\n",
    "rev-parse --abbrev-ref @{upstream}": () => "origin/main\n",
    fetch: () => "",
    "show @{upstream}:plugin.json": () => JSON.stringify(upstream),
  });
}

// ── declared repository (tag + candidate manifest) ───────────────────────────
test("repository: a higher tag whose manifest is newer is update-available", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = repoGit(
    "aaa\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.3.0\nccc\trefs/tags/v1.1.0\n",
    okManifest({ version: "1.3.0" }),
  );
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.updateAvailable).toBe(true);
  expect(st.plugins[0]).toMatchObject({
    state: "update-available",
    source: "repository",
    currentVersion: "1.2.0",
    latestVersion: "1.3.0",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("repository: an equal candidate version is up-to-date", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = repoGit("aaa\trefs/tags/v1.2.0\n", okManifest({ version: "1.2.0" }));
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.updateAvailable).toBe(false);
  expect(st.plugins[0]!.state).toBe("up-to-date");
  rmSync(dir, { recursive: true, force: true });
});

test("repository: a LOWER candidate version is NOT update-available (semver, not !=)", async () => {
  const dir = makePluginsDir({
    p: okManifest({ version: "2.0.0", repository: "https://x/p.git" }),
  });
  const git = repoGit("aaa\trefs/tags/v1.9.9\n", okManifest({ version: "1.9.9" }));
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]).toMatchObject({ state: "up-to-date", latestVersion: "1.9.9" });
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("repository: a NEWER candidate that bumps apiVersion is incompatible, not update-available", async () => {
  // Critic point 1: a repository check must not claim installability for a tag
  // whose manifest would be rejected for its apiVersion.
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = repoGit("aaa\trefs/tags/v2.0.0\n", okManifest({ version: "2.0.0", apiVersion: 2 }));
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("incompatible");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("repository: an OLDER candidate with a different apiVersion stays up-to-date (version wins)", async () => {
  const dir = makePluginsDir({
    p: okManifest({ version: "2.0.0", repository: "https://x/p.git" }),
  });
  const git = repoGit("aaa\trefs/tags/v1.5.0\n", okManifest({ version: "1.5.0", apiVersion: 2 }));
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("up-to-date");
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
  const st = await new PluginUpdateService({
    pluginsDir: dir,
    git: checkoutGit(okManifest({ version: "1.4.0" })),
  }).check(1);
  expect(st.plugins[0]).toMatchObject({
    state: "update-available",
    source: "git",
    latestVersion: "1.4.0",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("git checkout: a NEWER upstream that bumps apiVersion is incompatible", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const st = await new PluginUpdateService({
    pluginsDir: dir,
    git: checkoutGit(okManifest({ version: "2.0.0", apiVersion: 2 })),
  }).check(1);
  expect(st.plugins[0]!.state).toBe("incompatible");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("git checkout: an EQUAL upstream with a different apiVersion is up-to-date, not incompatible", async () => {
  // Critic point 2: apiVersion must not be judged before the version comparison.
  const dir = makePluginsDir({ p: okManifest() });
  const st = await new PluginUpdateService({
    pluginsDir: dir,
    git: checkoutGit(okManifest({ version: "1.2.0", apiVersion: 2 })),
  }).check(1);
  expect(st.plugins[0]!.state).toBe("up-to-date");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("git checkout: an OLDER upstream with a different apiVersion is up-to-date, not incompatible", async () => {
  const dir = makePluginsDir({ p: okManifest({ version: "1.5.0" }) });
  const st = await new PluginUpdateService({
    pluginsDir: dir,
    git: checkoutGit(okManifest({ version: "1.1.0", apiVersion: 2 })),
  }).check(1);
  expect(st.plugins[0]!.state).toBe("up-to-date");
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
  const git = repoGit("aaa\trefs/tags/v1.0.0\n", okManifest({ version: "1.0.0" }));
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
  const git = repoGit("aaa\trefs/tags/v1.2.0\n", okManifest({ version: "1.2.0" }));
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
    git: repoGit("aaa\trefs/tags/v1.2.0\n", okManifest({ version: "1.2.0" })),
  });
  expect(svc.current()).toBeNull();
  await svc.check(42);
  expect(svc.current()!.checkedAt).toBe(42);
  rmSync(dir, { recursive: true, force: true });
});
