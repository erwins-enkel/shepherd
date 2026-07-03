import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config";
import { compareSemver } from "./herdr-update";
import { PLUGIN_API_VERSION } from "./plugins/types";
import { timedAsync } from "./instrument";
import type { PluginUpdateInfo, PluginUpdatesStatus } from "./types";

const execFileAsync = promisify(execFile);

/** Internal result of resolving a plugin's candidate manifest before classification.
 *  `no-source` carries the reportable source (`git` checkout without upstream vs no
 *  git/repository at all); `error` carries a diagnostic detail. */
type Candidate =
  | { kind: "manifest"; manifest: RawManifest }
  | { kind: "no-source"; source: "git" | "none"; detail?: string }
  | { kind: "error"; detail: string };

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
 * A plugin is only checkable when a source can be resolved. Either way the check
 * reads the CANDIDATE `plugin.json` (version + apiVersion), so both paths run the
 * same classification — no path over-claims installability:
 *  - a declared `repository` in its `plugin.json` (the explicit, supply-chain-
 *    conscious path — works for the primary `cp -r` install that has no `.git`):
 *    the highest semver tag is found via `git ls-remote --tags`, then that tag's
 *    `plugin.json` is read via a shallow, checkout-less fetch into a scratch dir, or
 *  - the folder being a git work tree with an upstream (the documented symlink-
 *    to-checkout dev workflow): the upstream `plugin.json` is read after a
 *    `git fetch` that only moves remote-tracking refs, never the working tree.
 * Everything else reports `no-source`. The installed manifest `version` is the
 * source of truth for "what we're on"; a newer version is decided by a real
 * semver comparison (`>`) BEFORE anything else, so an equal/older candidate is
 * always `up-to-date` — even if its apiVersion differs. Only a genuinely newer
 * candidate is then apiVersion-gated: one that bumps apiVersion beyond what this
 * Shepherd supports (and would be silently disabled at load) is `incompatible`
 * rather than `update-available`. Fail-safe throughout: any git/parse error
 * yields a per-plugin `error`/`no-source` state, never a spurious badge.
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
    // A declared repository is the explicit path (covers `cp -r` installs); else a
    // git checkout with an upstream. Both resolve the CANDIDATE manifest so the
    // same classifier runs — no path claims installability without seeing apiVersion.
    const source: "repository" | "git" = manifest.repository ? "repository" : "git";
    try {
      const candidate = manifest.repository
        ? await this.candidateFromRepository(manifest.repository)
        : await this.candidateFromCheckout(dir);
      switch (candidate.kind) {
        case "manifest":
          return this.classifyCandidate(base, source, candidate.manifest);
        case "no-source":
          return {
            ...base,
            latestVersion: null,
            source: candidate.source,
            state: "no-source",
            ...(candidate.detail ? { detail: candidate.detail } : {}),
          };
        case "error":
          return { ...base, latestVersion: null, source, state: "error", detail: candidate.detail };
      }
    } catch (e) {
      return {
        ...base,
        latestVersion: null,
        source,
        state: "error",
        detail: e instanceof Error ? e.message : "update check failed",
      };
    }
  }

  /** Classify an installed plugin against a resolved candidate manifest. Version
   *  ordering is decided FIRST: an equal/older candidate is `up-to-date` no matter
   *  its apiVersion. Only a strictly-newer candidate is apiVersion-gated — one whose
   *  apiVersion this Shepherd wouldn't load is `incompatible`, not `update-available`. */
  private classifyCandidate(
    base: { id: string; name: string; currentVersion: string },
    source: "repository" | "git",
    candidate: RawManifest,
  ): PluginUpdateInfo {
    // The candidate must be the SAME plugin. A `repository` pointing at (or an
    // upstream diverged into) a different plugin would otherwise surface its
    // version as an update for the installed one — a wrong, potentially unsafe
    // "update available". A mismatch is an error, never a badge.
    if (candidate.id !== base.id) {
      return {
        ...base,
        latestVersion: null,
        source,
        state: "error",
        detail: `candidate plugin id "${candidate.id}" does not match installed "${base.id}"`,
      };
    }
    const current = parseSemver(base.currentVersion);
    const latest = parseSemver(candidate.version);
    if (!current) {
      return {
        ...base,
        latestVersion: latest,
        source,
        state: "error",
        detail: "installed version is not valid semver",
      };
    }
    if (!latest) {
      return {
        ...base,
        latestVersion: null,
        source,
        state: "error",
        detail: "candidate plugin.json has no parseable version",
      };
    }
    if (compareSemver(latest, current) <= 0) {
      return { ...base, latestVersion: latest, source, state: "up-to-date" };
    }
    // Genuinely newer — now the apiVersion pre-flight applies. A bump beyond what
    // this Shepherd supports would be SILENTLY DISABLED at load, so flag it.
    if (candidate.apiVersion !== PLUGIN_API_VERSION) {
      return {
        ...base,
        latestVersion: latest,
        source,
        state: "incompatible",
        detail: `candidate apiVersion ${candidate.apiVersion} != supported ${PLUGIN_API_VERSION}`,
      };
    }
    return { ...base, latestVersion: latest, source, state: "update-available" };
  }

  /** Resolve the candidate manifest from a declared repository: the highest semver
   *  tag's `plugin.json`, read via a checkout-less shallow fetch. */
  private async candidateFromRepository(repository: string): Promise<Candidate> {
    const tag = await this.latestRemoteTag(repository);
    if (!tag) return { kind: "error", detail: "no version tags on the declared repository" };
    const manifest = await this.readRemoteTagManifest(repository, tag.ref);
    if (!manifest) return { kind: "error", detail: "could not read plugin.json at the latest tag" };
    return { kind: "manifest", manifest };
  }

  /** Resolve the candidate manifest from a local git checkout's upstream tip. */
  private async candidateFromCheckout(dir: string): Promise<Candidate> {
    if (!(await this.isGitWorkTree(dir))) return { kind: "no-source", source: "none" };
    // A checkout with no upstream (detached HEAD / unpushed local branch) has
    // nothing to compare against — a "no source", not a failure.
    if (!(await this.hasUpstream(dir))) {
      return {
        kind: "no-source",
        source: "git",
        detail: "git checkout has no upstream branch to compare against",
      };
    }
    await this.git(["fetch", "--quiet"], dir);
    const manifest = await this.readUpstreamManifest(dir);
    if (!manifest) return { kind: "error", detail: "could not read upstream plugin.json" };
    return { kind: "manifest", manifest };
  }

  /** Highest semver tag on a remote (ref + parsed version), without cloning
   *  (`ls-remote` reads only). Null when unreachable or carrying no version tags. */
  private async latestRemoteTag(
    repository: string,
  ): Promise<{ ref: string; version: string } | null> {
    const out = await this.git(["ls-remote", "--tags", "--refs", repository]);
    let best: { ref: string; version: string } | null = null;
    for (const line of out.split("\n")) {
      const ref = line.split("\t")[1] ?? line.split(/\s+/)[1];
      const v = parseSemver(ref);
      if (v && ref && (best === null || compareSemver(v, best.version) > 0))
        best = { ref, version: v };
    }
    return best;
  }

  /** Read `plugin.json` at a remote tag WITHOUT a full clone or working-tree
   *  checkout: init a scratch repo, shallow-fetch just that tag ref, and read the
   *  blob from FETCH_HEAD. The scratch dir is always removed. */
  private async readRemoteTagManifest(
    repository: string,
    ref: string,
  ): Promise<RawManifest | null> {
    const scratch = await mkdtemp(join(tmpdir(), "shepherd-plugin-remote-"));
    try {
      await this.git(["init", "-q"], scratch);
      await this.git(["fetch", "--depth", "1", "--no-tags", repository, ref], scratch);
      const parsed = JSON.parse(await this.git(["show", "FETCH_HEAD:plugin.json"], scratch));
      return isRawManifest(parsed) ? parsed : null;
    } catch {
      return null;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
