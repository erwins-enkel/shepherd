import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
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

test("repository: a candidate manifest for a DIFFERENT plugin id is an error, not an update", async () => {
  // A misconfigured repository must not surface another plugin's version as ours.
  const dir = makePluginsDir({ p: okManifest({ id: "mine", repository: "https://x/other.git" }) });
  const git = repoGit(
    "aaa\trefs/tags/v9.9.9\n",
    okManifest({ id: "someone-else", version: "9.9.9" }),
  );
  const st = await new PluginUpdateService({ pluginsDir: dir, git }).check(1);
  expect(st.plugins[0]!.state).toBe("error");
  expect(st.updateAvailable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("git checkout: an upstream manifest for a DIFFERENT plugin id is an error, not an update", async () => {
  const dir = makePluginsDir({ p: okManifest({ id: "mine" }) });
  const st = await new PluginUpdateService({
    pluginsDir: dir,
    git: checkoutGit(okManifest({ id: "someone-else", version: "9.9.9" })),
  }).check(1);
  expect(st.plugins[0]!.state).toBe("error");
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

// ── apply (fetch-and-swap on disk) ───────────────────────────────────────────
test("apply: git checkout fast-forwards to the upstream tip", async () => {
  const dir = makePluginsDir({ p: okManifest() }); // no repository → git-checkout path
  const calls: string[] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push(args.join(" "));
    const base = checkoutGit(okManifest({ version: "1.3.0" }));
    if (args[0] === "merge") return ""; // ff-only succeeds
    return base(args, cwd);
  };
  const res = await new PluginUpdateService({ pluginsDir: dir, git }).apply("p", 7);
  expect(res).toEqual({ ok: true, folder: "p", updatedTo: "1.3.0" });
  expect(calls).toContain("merge --ff-only @{upstream}");
  rmSync(dir, { recursive: true, force: true });
});

test("apply: a non-fast-forward merge surfaces update_failed", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const git: GitRunner = async (args, cwd) => {
    if (args[0] === "merge") throw new Error("Not possible to fast-forward, aborting.");
    return checkoutGit(okManifest({ version: "1.3.0" }))(args, cwd);
  };
  const res = await new PluginUpdateService({ pluginsDir: dir, git }).apply("p", 7);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toBe("update_failed");
    expect(res.detail).toContain("fast-forward");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("apply: declared repository clones the tag and swaps it in, preserving config.json", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  writeFileSync(join(dir, "p", "config.json"), JSON.stringify({ token: "keep-me" }));
  // clone writes the new tree into the scratch dest (last arg); everything else is repoGit.
  const base = repoGit("aaa\trefs/tags/v1.3.0\n", okManifest({ version: "1.3.0" }));
  const git: GitRunner = async (args, cwd) => {
    if (args[0] === "clone") {
      const dest = args[args.length - 1]!;
      mkdirSync(dest, { recursive: true });
      writeFileSync(
        join(dest, "plugin.json"),
        JSON.stringify(okManifest({ version: "1.3.0", repository: "https://x/p.git" })),
      );
      writeFileSync(join(dest, "index.ts"), "export const register = () => {};");
      return "";
    }
    return base(args, cwd);
  };
  const res = await new PluginUpdateService({ pluginsDir: dir, git }).apply("p", 7);
  expect(res).toEqual({ ok: true, folder: "p", updatedTo: "1.3.0" });
  // the swapped-in folder is on the new version and kept the local config.json
  const swapped = JSON.parse(readFileSync(join(dir, "p", "plugin.json"), "utf8"));
  expect(swapped.version).toBe("1.3.0");
  expect(JSON.parse(readFileSync(join(dir, "p", "config.json"), "utf8"))).toEqual({
    token: "keep-me",
  });
  // no scratch/backup siblings left behind
  expect(existsSync(join(dir, ".p.update-7"))).toBe(false);
  expect(existsSync(join(dir, ".p.bak-7"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("apply: refuses when nothing newer is available (already_up_to_date)", async () => {
  const dir = makePluginsDir({ p: okManifest({ repository: "https://x/p.git" }) });
  const git = repoGit("aaa\trefs/tags/v1.2.0\n", okManifest({ version: "1.2.0" }));
  const res = await new PluginUpdateService({ pluginsDir: dir, git }).apply("p", 7);
  expect(res).toMatchObject({ ok: false, error: "already_up_to_date" });
  rmSync(dir, { recursive: true, force: true });
});

test("apply: refuses a symlinked install (source is operator-owned)", async () => {
  const src = mkdtempSync(join(tmpdir(), "shepherd-plugin-src-"));
  writeFileSync(join(src, "plugin.json"), JSON.stringify(okManifest({ id: "s", name: "S" })));
  const dir = mkdtempSync(join(tmpdir(), "shepherd-plugins-"));
  symlinkSync(src, join(dir, "s"), "dir");
  const git = checkoutGit(okManifest({ id: "s", name: "S", version: "1.3.0" }));
  const res = await new PluginUpdateService({ pluginsDir: dir, git }).apply("s", 7);
  expect(res).toMatchObject({ ok: false, error: "symlinked_source" });
  rmSync(dir, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
});

test("apply: an unknown id is not_installed", async () => {
  const dir = makePluginsDir({ p: okManifest() });
  const res = await new PluginUpdateService({
    pluginsDir: dir,
    git: checkoutGit(okManifest()),
  }).apply("ghost", 7);
  expect(res).toMatchObject({ ok: false, error: "not_installed" });
  rmSync(dir, { recursive: true, force: true });
});
