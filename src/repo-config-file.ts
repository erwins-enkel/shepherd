import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, execGitSync } from "./safe-git";
import type { RepoConfig } from "./store";
import { normalizeRepoDefaultModelSetting } from "./default-model";
import { normalizeRepoDefaultEffortSetting } from "./default-effort";
import {
  parseReviewFeedbackBots,
  parseReviewFeedbackMode,
  REVIEW_FEEDBACK_PRESET_BOTS,
} from "./review-feedback-core";

/** Only these settings may travel with a repository. All other settings stay local. */
export const REPO_RULE_FIELDS = [
  "leitrechner",
  "criticEnabled",
  "criticAllPrs",
  "criticSmellLensEnabled",
  "claudeReviewSkipsCritic",
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
  "claudeShipStewardDefer",
  "autoLabel",
  "defaultModel",
  "defaultEffort",
  "reviewFeedbackMode",
  "reviewFeedbackBots",
  "reviewFeedbackResolve",
] as const satisfies readonly (keyof RepoConfig)[];
export type RepoRuleKey = (typeof REPO_RULE_FIELDS)[number];
export type RepoRules = Pick<RepoConfig, RepoRuleKey>;
export type RepoConfigFile = {
  rules: Partial<RepoRules>;
  commit: string;
  leitrechner?: string | null;
};

export function isLeitrechner(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
  );
}
/** Defaults are shared by the DB fallback, partial-file reads and invariant validation. */
export const REPO_RULE_DEFAULTS: Readonly<RepoRules> = Object.freeze({
  leitrechner: null,
  criticEnabled: true,
  criticAllPrs: false,
  criticSmellLensEnabled: false,
  claudeReviewSkipsCritic: false,
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
  claudeShipStewardDefer: false,
  autoLabel: "shepherd:auto",
  defaultModel: "inherit",
  defaultEffort: "inherit",
  reviewFeedbackMode: "autopilot",
  reviewFeedbackBots: Object.freeze([...REVIEW_FEEDBACK_PRESET_BOTS]) as string[],
  reviewFeedbackResolve: false,
});

/** Rule equality: `reviewFeedbackBots` is an array, so compare element-wise (ordered). */
export function sameRuleValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Same cross-field rules for committed files and explicit settings edits. */
export function repoRuleValidationError(config: RepoRules): string | null {
  if (config.draftMode && config.autoMergeEnabled)
    return "draftMode and autoMergeEnabled are mutually exclusive";
  // A critic-reliant signoff with critic disabled would leave drafts stuck forever.
  if (config.draftMode && !config.criticEnabled && config.signoffAuthority !== "human")
    return `signoffAuthority "${config.signoffAuthority}" requires criticEnabled — it would never sign off (use "human")`;
  // #4147: the same wedge — Claude Code Review replaces the critic on its heads, so a critic-only
  // sign-off never arrives there.
  if (codeReviewWedgesSignoff(config))
    return `signoffAuthority "critic" conflicts with claudeReviewSkipsCritic — the critic is skipped where Claude Code Review runs, so it would never sign off (use "human" or "either")`;
  return null;
}

function codeReviewWedgesSignoff(config: RepoRules): boolean {
  return (
    config.draftMode &&
    config.criticEnabled &&
    !!config.claudeReviewSkipsCritic &&
    config.signoffAuthority === "critic"
  );
}

const CONFIG_PATH = ".shepherd/config.json";
const TTL_MS = 60_000;
const ruleKeys = new Set<string>(REPO_RULE_FIELDS);
export const isRepoRuleKey = (key: string): key is RepoRuleKey => ruleKeys.has(key);

export function repoRulesFromConfig(config: RepoConfig): RepoRules {
  return Object.fromEntries(REPO_RULE_FIELDS.map((key) => [key, config[key]])) as RepoRules;
}

const INVALID = Symbol("invalid");
const orInvalid = <T>(parsed: T | { error: string }) =>
  typeof parsed === "object" && parsed !== null && "error" in parsed ? INVALID : parsed;
/** One committed rule value, normalized (bot logins), or INVALID. */
function parseRuleValue(key: RepoRuleKey, v: unknown): unknown {
  switch (key) {
    case "leitrechner":
      return isLeitrechner(v) ? v : INVALID;
    case "signoffAuthority":
      return v === "human" || v === "critic" || v === "either" ? v : INVALID;
    case "autoLabel":
      return typeof v === "string" && v.trim().length > 0 ? v : INVALID;
    case "defaultModel":
      return normalizeRepoDefaultModelSetting(v) !== null ? v : INVALID;
    case "defaultEffort":
      return normalizeRepoDefaultEffortSetting(v) !== null ? v : INVALID;
    case "reviewFeedbackMode":
      return orInvalid(parseReviewFeedbackMode(v));
    case "reviewFeedbackBots":
      return orInvalid(parseReviewFeedbackBots(v));
    default:
      return typeof v === "boolean" ? v : INVALID;
  }
}

/** Invalid known values invalidate the file; unknown (including machine) fields never apply. */
export function parseRepoRules(raw: string): Partial<RepoRules> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if ("leitrechner" in value && !isLeitrechner((value as Record<string, unknown>).leitrechner))
      return null;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (!isRepoRuleKey(key)) continue;
      const parsed = parseRuleValue(key, v);
      if (parsed === INVALID) return null;
      out[key] = parsed;
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
      /* best-effort: unset symref — same fallback as repo roles */
    }
    value = { key: git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), branch };
  } catch {
    /* best-effort: local-only repository or non-git path → no context */
  }
  contexts.set(dir, { value, at: Date.now() });
  return value;
}

export function invalidateRepoConfigFile(dir: string): void {
  contexts.delete(dir);
  files.delete(dir);
}

export function readRepoConfigAtCommit(dir: string, commit: string): RepoConfigFile | null {
  try {
    const raw = git(dir, ["show", `${commit}:${CONFIG_PATH}`]);
    const rules = parseRepoRules(raw);
    const leitrechner = (JSON.parse(raw) as Record<string, unknown>).leitrechner;
    return rules === null
      ? null
      : {
          rules,
          commit,
          ...(leitrechner === undefined ? {} : { leitrechner: leitrechner as string | null }),
        };
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
      value = readRepoConfigAtCommit(dir, commit);
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
  const current = previous.catch(() => {}).then(work); // best-effort: previous writer's caller owns its error; only serialize
  writes.set(key, current);
  try {
    return await current;
  } finally {
    if (writes.get(key) === current) writes.delete(key);
  }
}

export async function repoConfigGit(
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
  update: (file: RepoConfigFile | null) => RepoRules & { leitrechner?: string | null },
): Promise<RepoConfigFile> {
  const context = repoConfigGitContext(dir);
  if (!context) throw new Error("repository has no origin");
  const ref = `refs/remotes/origin/${context.branch}`;
  await repoConfigGit(dir, ["fetch", "origin", `refs/heads/${context.branch}:${ref}`], {}, 20_000);
  const base = await repoConfigGit(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const value = await buildRepoConfigCommit(dir, base, update(readRepoConfigAtCommit(dir, base)));
  await pushRepoConfigDefault(dir, value, base);
  return value;
}

export async function buildRepoConfigCommit(
  dir: string,
  base: string,
  updated: RepoRules & { leitrechner?: string | null },
): Promise<RepoConfigFile> {
  const previous = readRepoConfigAtCommit(dir, base);
  const leitrechner =
    updated.leitrechner !== undefined ? updated.leitrechner : previous?.leitrechner;
  const rules = repoRulesFromConfig(updated as RepoConfig);
  const contentRules = { ...rules, ...(leitrechner === undefined ? {} : { leitrechner }) };
  const temp = mkdtempSync(join(tmpdir(), "shepherd-config-"));
  let commit: string;
  try {
    const content = join(temp, "config.json");
    writeFileSync(content, `${JSON.stringify(contentRules, null, 2)}\n`);
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    const blob = await repoConfigGit(dir, ["hash-object", "-w", "--no-filters", content]);
    await repoConfigGit(dir, ["read-tree", base], env);
    await repoConfigGit(
      dir,
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${CONFIG_PATH}`],
      env,
    );
    const tree = await repoConfigGit(dir, ["write-tree"], env);
    commit = await repoConfigGit(dir, [
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "chore(shepherd): set repo rules",
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return { rules, commit, ...(leitrechner === undefined ? {} : { leitrechner }) };
}

export async function pushRepoConfigDefault(
  dir: string,
  value: RepoConfigFile,
  base: string,
): Promise<void> {
  const context = repoConfigGitContext(dir)!;
  const ref = `refs/remotes/origin/${context.branch}`;
  const { commit } = value;
  // Server-built config-only commit; the checkout's hooks have nothing to check.
  await repoConfigGit(
    dir,
    ["push", "--no-verify", "origin", `${commit}:refs/heads/${context.branch}`],
    {},
    30_000,
  );
  // Push normally updates this ref. With narrow refspecs, update only if still at our parent;
  // a concurrent fetch of a newer tip must never be rolled back by this bookkeeping.
  try {
    await repoConfigGit(dir, ["update-ref", ref, commit, base]);
  } catch {
    /* best-effort: already updated by push, or advanced by another fetch */
  }
  for (const [path, hit] of contexts) {
    if (hit.value?.key === context.key) files.delete(path);
  }
  files.set(dir, { value, at: Date.now() });
}

/** Fetch only the default ref; never modifies the checkout or index. */
export async function refreshRepoConfigFile(dir: string): Promise<RepoConfigFile | null> {
  return withRepoConfigLock(dir, () => fetchRepoConfigDefault(dir));
}

/** Caller holds the config lock. Refreshes only the authoritative default ref. */
export async function fetchRepoConfigDefault(dir: string): Promise<RepoConfigFile | null> {
  const context = repoConfigGitContext(dir);
  if (!context) return null;
  await repoConfigGit(
    dir,
    ["fetch", "origin", `refs/heads/${context.branch}:refs/remotes/origin/${context.branch}`],
    {},
    20_000,
  );
  for (const [path, hit] of contexts) {
    if (hit.value?.key === context.key) files.delete(path);
  }
  files.delete(dir);
  return readRepoConfigFile(dir);
}

/** Refresh at most four repositories at once, isolating each failure from the others. */
export async function refreshRepoConfigsAtStartup(
  dirs: readonly string[],
  failed: (dir: string) => void,
  refresh: (dir: string) => Promise<unknown> = refreshRepoConfigFile,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const dir = dirs[next++]!;
      try {
        await refresh(dir);
      } catch {
        failed(dir);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, dirs.length) }, worker));
}
