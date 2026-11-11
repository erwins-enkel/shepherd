import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, execGitSync } from "./safe-git";
import type { RepoConfig } from "./store";
import { normalizeRepoDefaultModelSetting } from "./default-model";
import { normalizeRepoDefaultEffortSetting } from "./default-effort";

/** Only these settings may travel with a repository. All other settings stay local. */
export const REPO_RULE_FIELDS = [
  "criticEnabled",
  "criticAllPrs",
  "criticSmellLensEnabled",
  "autoAddressEnabled",
  "autopilotEnabled",
  "planGateEnabled",
  "autoDrainEnabled",
  "autoMergeEnabled",
  "buildQueueEnabled",
  "draftMode",
  "signoffAuthority",
  "manualStepsIssueEnabled",
  "preWarmEpicLandingCi",
  "epicStacksEnabled",
  "autoLabel",
  "defaultModel",
  "defaultEffort",
] as const satisfies readonly (keyof RepoConfig)[];
export type RepoRuleKey = (typeof REPO_RULE_FIELDS)[number];
export type RepoRules = Pick<RepoConfig, RepoRuleKey>;
export type RepoConfigFile = { rules: Partial<RepoRules>; commit: string };
/** Defaults are shared by the DB fallback, partial-file reads and invariant validation. */
export const REPO_RULE_DEFAULTS: Readonly<RepoRules> = Object.freeze({
  criticEnabled: true,
  criticAllPrs: false,
  criticSmellLensEnabled: false,
  autoAddressEnabled: false,
  autopilotEnabled: false,
  planGateEnabled: false,
  autoDrainEnabled: false,
  autoMergeEnabled: false,
  buildQueueEnabled: false,
  draftMode: false,
  signoffAuthority: "human",
  manualStepsIssueEnabled: false,
  preWarmEpicLandingCi: false,
  epicStacksEnabled: false,
  autoLabel: "shepherd:auto",
  defaultModel: "inherit",
  defaultEffort: "inherit",
});

/** Same cross-field rules for committed files and explicit settings edits. */
export function repoRuleValidationError(config: RepoRules): string | null {
  if (config.draftMode && config.autoMergeEnabled)
    return "draftMode and autoMergeEnabled are mutually exclusive";
  // A critic-reliant signoff with critic disabled would leave drafts stuck forever.
  if (config.draftMode && !config.criticEnabled && config.signoffAuthority !== "human")
    return `signoffAuthority "${config.signoffAuthority}" requires criticEnabled — it would never sign off (use "human")`;
  return null;
}

const CONFIG_PATH = ".shepherd/config.json";
const TTL_MS = 60_000;
const ruleKeys = new Set<string>(REPO_RULE_FIELDS);
export const isRepoRuleKey = (key: string): key is RepoRuleKey => ruleKeys.has(key);

export function repoRulesFromConfig(config: RepoConfig): RepoRules {
  return Object.fromEntries(REPO_RULE_FIELDS.map((key) => [key, config[key]])) as RepoRules;
}

/** Invalid known values invalidate the file; unknown (including machine) fields never apply. */
export function parseRepoRules(raw: string): Partial<RepoRules> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (!isRepoRuleKey(key)) continue;
      let valid: boolean;
      switch (key) {
        case "signoffAuthority":
          valid = v === "human" || v === "critic" || v === "either";
          break;
        case "autoLabel":
          valid = typeof v === "string" && v.trim().length > 0;
          break;
        case "defaultModel":
          valid = normalizeRepoDefaultModelSetting(v) !== null;
          break;
        case "defaultEffort":
          valid = normalizeRepoDefaultEffortSetting(v) !== null;
          break;
        default:
          valid = typeof v === "boolean";
      }
      if (!valid) return null;
      out[key] = v;
    }
    const rules = out as Partial<RepoRules>;
    return repoRuleValidationError({ ...REPO_RULE_DEFAULTS, ...rules }) ? null : rules;
  } catch {
    return null;
  }
}

const git = (dir: string, args: string[]): string =>
  execGitSync(["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

type GitContext = { key: string; branch: string };
const contexts = new Map<string, { value: GitContext | null; at: number }>();
const files = new Map<string, { value: RepoConfigFile | null; at: number }>();

/** Local, network-free origin/default lookup. Negative results expire too. */
export function repoConfigGitContext(dir: string): GitContext | null {
  const hit = contexts.get(dir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: GitContext | null = null;
  try {
    git(dir, ["remote", "get-url", "origin"]);
    let branch = "main";
    try {
      branch = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(
        /^origin\//,
        "",
      );
    } catch {
      /* unset symref: same fallback as repo roles */
    }
    value = { key: git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), branch };
  } catch {
    /* local-only repository or non-git path */
  }
  contexts.set(dir, { value, at: Date.now() });
  return value;
}

export function invalidateRepoConfigFile(dir: string): void {
  contexts.delete(dir);
  files.delete(dir);
}

function readAtCommit(dir: string, commit: string): RepoConfigFile | null {
  try {
    const rules = parseRepoRules(git(dir, ["show", `${commit}:${CONFIG_PATH}`]));
    return rules === null ? null : { rules, commit };
  } catch {
    return null;
  }
}

/** Pin the selected ref first: a missing/bad remote file must not resurrect a stale local file. */
export function readRepoConfigFile(dir: string): RepoConfigFile | null {
  const hit = files.get(dir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const context = repoConfigGitContext(dir);
  let value: RepoConfigFile | null = null;
  if (context) {
    for (const ref of [`refs/remotes/origin/${context.branch}`, `refs/heads/${context.branch}`]) {
      let commit: string;
      try {
        commit = git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
      } catch {
        continue;
      }
      value = readAtCommit(dir, commit);
      break;
    }
  }
  files.set(dir, { value, at: Date.now() });
  return value;
}

export function effectiveRepoConfig(
  local: RepoConfig,
  defaults: RepoConfig,
  file: RepoConfigFile | null,
): RepoConfig {
  return file ? { ...local, ...repoRulesFromConfig(defaults), ...file.rules } : local;
}

// Serializes every config patch sharing Git storage, including requests from linked worktrees.
const writes = new Map<string, Promise<unknown>>();
export async function withRepoConfigLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const key = repoConfigGitContext(dir)?.key ?? dir;
  const previous = writes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  writes.set(key, current);
  try {
    return await current;
  } finally {
    if (writes.get(key) === current) writes.delete(key);
  }
}

async function gitAsync(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 10_000,
): Promise<string> {
  const { stdout } = await execGit(["-C", dir, ...args], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
  });
  return stdout.trim();
}

/** Build one commit on a freshly fetched tip, without the checkout's index or working tree.
 * Call under withRepoConfigLock; the callback merges/validates against this exact parent. */
export async function writeRepoConfigFile(
  dir: string,
  update: (file: RepoConfigFile | null) => RepoRules,
): Promise<RepoConfigFile> {
  const context = repoConfigGitContext(dir);
  if (!context) throw new Error("repository has no origin");
  const ref = `refs/remotes/origin/${context.branch}`;
  await gitAsync(dir, ["fetch", "origin", `refs/heads/${context.branch}:${ref}`], {}, 20_000);
  const base = await gitAsync(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const rules = update(readAtCommit(dir, base));
  const temp = mkdtempSync(join(tmpdir(), "shepherd-config-"));
  let commit: string;
  try {
    const content = join(temp, "config.json");
    writeFileSync(content, `${JSON.stringify(rules, null, 2)}\n`);
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    const blob = await gitAsync(dir, ["hash-object", "-w", "--no-filters", content]);
    await gitAsync(dir, ["read-tree", base], env);
    await gitAsync(
      dir,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${CONFIG_PATH}`],
      env,
    );
    const tree = await gitAsync(dir, ["write-tree"], env);
    commit = await gitAsync(dir, [
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "chore(shepherd): set repo rules",
    ]);
    // The commit contains only config JSON, independent of checkout-specific pre-push checks.
    await gitAsync(
      dir,
      ["push", "--no-verify", "origin", `${commit}:refs/heads/${context.branch}`],
      {},
      30_000,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  // Push normally updates this ref. With narrow refspecs, update only if still at our parent;
  // a concurrent fetch of a newer tip must never be rolled back by this bookkeeping.
  try {
    await gitAsync(dir, ["update-ref", ref, commit, base]);
  } catch {
    /* already updated by push, or advanced by another fetch */
  }
  const value = { rules, commit };
  files.set(dir, { value, at: Date.now() });
  return value;
}
