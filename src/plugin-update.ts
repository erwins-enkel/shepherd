import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config";
import { compareSemver } from "./herdr-update";
import { PLUGIN_API_VERSION } from "./plugins/types";
import { timedAsync } from "./instrument";
import type { PluginUpdateInfo, PluginUpdatesStatus, PluginUpdateState } from "./types";

export type { PluginUpdateInfo, PluginUpdatesStatus, PluginUpdateState };

const execFileAsync = promisify(execFile);

/** Extract a bare `major.minor.patch` from an arbitrary version/tag string
 *  (e.g. `v1.3.0`, `refs/tags/1.3.0`). Null when none is present. */
const SEMVER_RE = /(\d+\.\d+\.\d+)/;
function parseSemver(s: string | null | undefined): string | null {
  const m = s ? SEMVER_RE.exec(s) : null;
  return m ? m[1]! : null;
}

/** Minimal manifest shape the update check reads straight off `plugin.json` —
 *  independent of the loader so it also covers disabled/errored plugins. */
interface RawManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** Optional declared update source (git URL). Makes a `cp -r`-installed plugin
   *  (no local `.git`) checkable — without it such a plugin reports `no-source`. */
  repository?: string;
}

function isRawManifest(m: unknown): m is RawManifest {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.version === "string" &&
    typeof o.apiVersion === "number"
  );
}

/** Runs git and returns stdout; injectable for tests. `cwd` scopes `-C <cwd>`
 *  operations (a plugin's own folder); omit for repo-less calls like ls-remote. */
export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

export interface PluginUpdateDeps {
  /** dir holding one folder per installed plugin; defaults to config.pluginsDir */
  pluginsDir?: string;
  /** inject point for tests; defaults to real `git …` */
  git?: GitRunner;
}

/**
 * Detects whether installed Shepherd plugins have a newer version available.
 * Badge-first and READ-ONLY, modelled on {@link CodexUpdateService}: it never
 * mutates a plugin folder and exposes no `apply()` — surfacing an update is all
 * it does; picking it up stays the operator's manual (or a future opt-in) step.
 *
 * A plugin is only checkable when a source can be resolved:
 *  - a declared `repository` in its `plugin.json` (the explicit, supply-chain-
 *    conscious path — works for the primary `cp -r` install that has no `.git`),
 *    checked via `git ls-remote --tags` against that URL, or
 *  - the folder being a git work tree with an upstream (the documented symlink-
 *    to-checkout dev workflow), checked by reading the upstream `plugin.json`
 *    version — a `git fetch` that only moves remote-tracking refs, never the
 *    working tree.
 * Everything else reports `no-source`. The installed manifest `version` is the
 * source of truth for "what we're on"; a newer version is decided by a real
 * semver comparison (`>`), so an upstream on an equal/older version is never a
 * false "update-available". Fail-safe throughout: any git/parse error yields a
 * per-plugin `error`/`no-source` state, never a spurious badge.
 */
export class PluginUpdateService {
  private pluginsDir: string;
  private git: GitRunner;
  private last: PluginUpdatesStatus | null = null;

  constructor(deps: PluginUpdateDeps = {}) {
    this.pluginsDir = deps.pluginsDir ?? config.pluginsDir;
    this.git =
      deps.git ??
      (async (args, cwd) => {
        const { stdout } = await timedAsync(`git ${args[0] ?? ""}`, () =>
          execFileAsync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8" }),
        );
        return stdout as string;
      });
  }

  /** Last computed status, or null before the first check. */
  current(): PluginUpdatesStatus | null {
    return this.last;
  }

  /** Scan the plugins dir and recompute each installed plugin's update state.
   *  Fail-safe: a missing dir yields an empty list; a per-plugin failure is
   *  isolated to that plugin's `error` state. */
  async check(now: number): Promise<PluginUpdatesStatus> {
    let names: string[];
    try {
      const entries = await readdir(this.pluginsDir, { withFileTypes: true });
      names = [];
      for (const e of entries) {
        // Mirror the loader: real dirs and symlinks-to-dirs both count as installs.
        if (e.isDirectory()) names.push(e.name);
        else if (e.isSymbolicLink()) {
          try {
            if ((await stat(join(this.pluginsDir, e.name))).isDirectory()) names.push(e.name);
          } catch {
            /* dangling symlink — skip */
          }
        }
      }
      names.sort();
    } catch {
      // missing/unreadable dir → the zero-plugin case; not an error.
      this.last = { plugins: [], updateAvailable: false, checkedAt: now };
      return this.last;
    }

    const plugins: PluginUpdateInfo[] = [];
    for (const name of names) {
      const info = await this.checkOne(join(this.pluginsDir, name));
      if (info) plugins.push(info);
    }
    this.last = {
      plugins,
      updateAvailable: plugins.some((p) => p.state === "update-available"),
      checkedAt: now,
    };
    return this.last;
  }

  /** Resolve one plugin folder's update state. Returns null when the folder is
   *  not a plugin (no valid `plugin.json`) so it drops out of the list. */
  private async checkOne(dir: string): Promise<PluginUpdateInfo | null> {
    let manifest: RawManifest;
    try {
      const parsed = JSON.parse(await readFile(join(dir, "plugin.json"), "utf8"));
      if (!isRawManifest(parsed)) return null;
      manifest = parsed;
    } catch {
      return null; // not a plugin folder
    }
    const base = { id: manifest.id, name: manifest.name, currentVersion: manifest.version };
    const errorInfo = (source: PluginUpdateInfo["source"], detail: string): PluginUpdateInfo => ({
      ...base,
      latestVersion: null,
      source,
      state: "error",
      detail,
    });

    try {
      // 1) Explicit declared source wins — the supply-chain-conscious path that
      //    also covers `cp -r` installs (no local `.git`). Latest release = the
      //    highest semver tag on the remote; apiVersion is not knowable via
      //    ls-remote, so no incompatibility pre-flight on this path.
      if (manifest.repository) {
        const latest = await this.latestRemoteTag(manifest.repository);
        if (!latest) return errorInfo("repository", "no version tags on the declared repository");
        return this.classify(base, "repository", latest, null);
      }

      // 2) Otherwise, a git work tree with an upstream (the symlink-to-checkout
      //    dev workflow). `fetch` only moves remote-tracking refs — never the
      //    working tree — so this is safe even on the operator's own checkout.
      if (!(await this.isGitWorkTree(dir))) {
        return { ...base, latestVersion: null, source: "none", state: "no-source" };
      }
      // A checkout with no upstream tracking branch (detached HEAD, unpushed
      // local branch) has nothing to compare against — that is a "no source" for
      // update purposes, not a failure. `@{upstream}` exits non-zero when absent.
      if (!(await this.hasUpstream(dir))) {
        return {
          ...base,
          latestVersion: null,
          source: "git",
          state: "no-source",
          detail: "git checkout has no upstream branch to compare against",
        };
      }
      await this.git(["fetch", "--quiet"], dir);
      const upstreamManifest = await this.readUpstreamManifest(dir);
      if (!upstreamManifest) return errorInfo("git", "could not read upstream plugin.json");
      // apiVersion pre-flight: an update that bumps apiVersion beyond what this
      // Shepherd supports would be SILENTLY DISABLED at load — surface it as
      // incompatible instead of a plain "update available".
      if (upstreamManifest.apiVersion !== PLUGIN_API_VERSION) {
        return {
          ...base,
          latestVersion: parseSemver(upstreamManifest.version),
          source: "git",
          state: "incompatible",
          detail: `upstream apiVersion ${upstreamManifest.apiVersion} != supported ${PLUGIN_API_VERSION}`,
        };
      }
      const latest = parseSemver(upstreamManifest.version);
      if (!latest) return errorInfo("git", "upstream plugin.json has no parseable version");
      return this.classify(base, "git", latest, null);
    } catch (e) {
      return errorInfo(
        manifest.repository ? "repository" : "git",
        e instanceof Error ? e.message : "update check failed",
      );
    }
  }

  /** Compare an installed version against a resolved latest one via real semver
   *  ordering — only a strictly-greater upstream is `update-available`. */
  private classify(
    base: { id: string; name: string; currentVersion: string },
    source: PluginUpdateInfo["source"],
    latest: string,
    detail: string | null,
  ): PluginUpdateInfo {
    const current = parseSemver(base.currentVersion);
    if (!current) {
      return {
        ...base,
        latestVersion: latest,
        source,
        state: "error",
        detail: "installed version is not valid semver",
      };
    }
    const state: PluginUpdateState =
      compareSemver(latest, current) > 0 ? "update-available" : "up-to-date";
    return { ...base, latestVersion: latest, source, state, ...(detail ? { detail } : {}) };
  }

  /** Highest semver tag published on a remote, without cloning (`ls-remote` reads
   *  only). Null when the remote is unreachable or carries no version tags. */
  private async latestRemoteTag(repository: string): Promise<string | null> {
    const out = await this.git(["ls-remote", "--tags", "--refs", repository]);
    let best: string | null = null;
    for (const line of out.split("\n")) {
      const ref = line.split("\t")[1] ?? line.split(/\s+/)[1];
      const v = parseSemver(ref);
      if (v && (best === null || compareSemver(v, best) > 0)) best = v;
    }
    return best;
  }

  private async isGitWorkTree(dir: string): Promise<boolean> {
    try {
      return (await this.git(["rev-parse", "--is-inside-work-tree"], dir)).trim() === "true";
    } catch {
      return false;
    }
  }

  /** True when the checkout has an upstream tracking branch. `@{upstream}` exits
   *  non-zero (throws) when there is none — treated as "no upstream", not error. */
  private async hasUpstream(dir: string): Promise<boolean> {
    try {
      return (await this.git(["rev-parse", "--abbrev-ref", "@{upstream}"], dir)).trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Read the plugin.json at the upstream tip (post-fetch) without touching the
   *  working tree, via `git show @{upstream}:plugin.json`. */
  private async readUpstreamManifest(dir: string): Promise<RawManifest | null> {
    try {
      const raw = await this.git(["show", "@{upstream}:plugin.json"], dir);
      const parsed = JSON.parse(raw);
      return isRawManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
