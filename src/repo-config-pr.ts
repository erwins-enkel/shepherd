import type { GitForge, PrStatus } from "./forge/types";
import {
  buildRepoConfigCommit,
  fetchRepoConfigDefault,
  pushRepoConfigDefault,
  readRepoConfigAtCommit,
  repoConfigGit,
  repoConfigGitContext,
  REPO_RULE_DEFAULTS,
  type RepoConfigFile,
  type RepoRules,
} from "./repo-config-file";

export const REPO_CONFIG_PR_BRANCH = "shepherd/repo-config";
const HEAD = `refs/heads/${REPO_CONFIG_PR_BRANCH}`;
const TRACKING = `refs/remotes/origin/${REPO_CONFIG_PR_BRANCH}`;
const SUBJECT = "chore(shepherd): set repo rules";
type Rules = RepoRules & { leitrechner?: string | null };
export type RepoConfigChanges = Partial<Rules>;
export type PendingRepoConfig = { number: number; url: string; changes: RepoConfigChanges };

const rules = (file: RepoConfigFile | null): Rules => ({
  ...REPO_RULE_DEFAULTS,
  ...file?.rules,
  leitrechner: file?.leitrechner ?? null,
});
function changes(before: Rules, after: Rules): RepoConfigChanges {
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => value !== before[key as keyof Rules]),
  );
}
function sameRules(file: RepoConfigFile, desired: Rules): boolean {
  return (
    Object.keys(changes(rules(file), { ...desired, leitrechner: desired.leitrechner ?? null }))
      .length === 0
  );
}

function pending(pr: PrStatus, delta: RepoConfigChanges): PendingRepoConfig {
  if (!pr.number || !pr.url || !/^https?:\/\//.test(pr.url))
    throw new Error("Could not resolve the repository rules PR. Check forge access and retry.");
  return { number: pr.number, url: pr.url, changes: delta };
}

/** Do not turn authentication/network/non-fast-forward errors into a PR. */
function remoteRejection(error: unknown): boolean {
  const { stdout, stderr } = (error ?? {}) as { stdout?: unknown; stderr?: unknown };
  return [stdout, stderr].some(
    (value) => typeof value === "string" && value.includes("[remote rejected]"),
  );
}

/** Discover remote truth even on a clone that never opened the proposal. Caller holds the lock. */
export async function readRepoConfigProposal(dir: string, forge: GitForge) {
  if (forge.isFork) return null;
  const remote = await repoConfigGit(dir, ["ls-remote", "--heads", "origin", HEAD], {}, 20_000);
  if (!remote) return null;
  await repoConfigGit(dir, ["fetch", "origin", `+${HEAD}:${TRACKING}`], {}, 20_000);
  const commit = await repoConfigGit(dir, ["rev-parse", TRACKING]);
  const pr = await forge.prStatus(REPO_CONFIG_PR_BRANCH);
  const file = readRepoConfigAtCommit(dir, commit);
  if (!file) throw new Error("Invalid repository rules proposal. Check the PR before retrying.");
  return { commit, pr, file };
}

async function cancelProposal(dir: string, forge: GitForge, commit: string): Promise<void> {
  // A forge close call cannot protect another machine's intervening save.
  await repoConfigGit(
    dir,
    ["push", "--no-verify", `--force-with-lease=${HEAD}:${commit}`, "origin", `:${HEAD}`],
    {},
    30_000,
  );
  if ((await forge.prStatus(REPO_CONFIG_PR_BRANCH)).state === "open")
    throw new Error("Could not close the repository rules PR. Retry before saving again.");
}

async function publishProposal(forge: GitForge, base: string, body: string): Promise<PrStatus> {
  let pr = await forge.prStatus(REPO_CONFIG_PR_BRANCH);
  if (pr.state === "open") {
    await forge.editPr?.(pr.number!, { title: SUBJECT, body });
    return pr;
  }
  try {
    return await forge.openPr({ head: REPO_CONFIG_PR_BRANCH, base, title: SUBJECT, body });
  } catch (error) {
    pr = await forge.prStatus(REPO_CONFIG_PR_BRANCH);
    if (pr.state !== "open") throw error;
    return pr;
  }
}

function proposalBody(before: Rules, delta: RepoConfigChanges): string {
  return [
    "Changes repository rules in `.shepherd/config.json`.",
    "",
    "The default branch refused direct pushes. The current rules remain effective until this PR is merged.",
    "",
    ...Object.entries(delta).map(
      ([key, value]) =>
        `- ${key}: ${JSON.stringify(before[key as keyof Rules])} → ${JSON.stringify(value)}`,
    ),
  ].join("\n");
}

async function pushRulesCommit(
  dir: string,
  forge: GitForge,
  built: RepoConfigFile,
  target: { base: string; expected: string; hasDraft: boolean },
): Promise<boolean> {
  if (!target.hasDraft) {
    try {
      await pushRepoConfigDefault(dir, built, target.base);
      return true;
    } catch (error) {
      if (!remoteRejection(error) || forge.isFork) throw error;
    }
  }
  if (!target.hasDraft || built.commit !== target.expected) {
    await repoConfigGit(
      dir,
      [
        "push",
        "--no-verify",
        `--force-with-lease=${HEAD}:${target.expected}`,
        "origin",
        `${built.commit}:${HEAD}`,
      ],
      {},
      30_000,
    );
  }
  return false;
}

function updatedRules(
  update: (file: RepoConfigFile | null) => Rules,
  current: RepoConfigFile | null,
): Rules {
  const updated = update(current);
  return {
    ...updated,
    leitrechner: updated.leitrechner === undefined ? current?.leitrechner : updated.leitrechner,
  };
}

export type RepoRulesSave =
  { kind: "pushed" | "unchanged" } | { kind: "pr"; pending: PendingRepoConfig };

/** Builds only the config diff, with an explicit ref lease across independent machines.
 * The callback validates against fresh effective rules plus any existing proposal delta. */
export async function saveRepoConfigRules(
  dir: string,
  forge: GitForge,
  update: (file: RepoConfigFile | null) => Rules,
  fallback: RepoRules = REPO_RULE_DEFAULTS,
): Promise<RepoRulesSave> {
  const effective = await fetchRepoConfigDefault(dir);
  const before = effective ? rules(effective) : { ...fallback, leitrechner: null };
  const context = repoConfigGitContext(dir)!;
  const base = await repoConfigGit(dir, ["rev-parse", `refs/remotes/origin/${context.branch}`]);
  const proposal = await readRepoConfigProposal(dir, forge);
  // A pushed branch without a PR is a recoverable interrupted publication.
  const hasDraft = proposal && (proposal.pr.state === "open" || proposal.pr.state === "none");
  let current = effective;
  if (hasDraft) current = await rebaseRepoConfigProposal(dir, base, effective, proposal);
  const desired = updatedRules(update, current);
  const delta = changes(before, { ...desired, leitrechner: desired.leitrechner ?? null });
  if (!Object.keys(delta).length && (effective || hasDraft)) {
    if (hasDraft) await cancelProposal(dir, forge, proposal.commit);
    return { kind: "unchanged" };
  }
  let built: RepoConfigFile;
  if (hasDraft && sameRules(proposal.file, desired)) built = proposal.file;
  else built = await buildRepoConfigCommit(dir, base, desired);
  if (
    await pushRulesCommit(dir, forge, built, {
      base,
      expected: proposal?.commit ?? "",
      hasDraft: !!hasDraft,
    })
  )
    return { kind: "pushed" };
  const pr = await publishProposal(forge, context.branch, proposalBody(before, delta));
  return { kind: "pr", pending: pending(pr, delta) };
}

/** Replay only the proposal's intentional fields onto today's effective default. */
export async function rebaseRepoConfigProposal(
  dir: string,
  base: string,
  effective: RepoConfigFile | null,
  proposal: { commit: string; file: RepoConfigFile },
): Promise<RepoConfigFile> {
  const ancestor = await repoConfigGit(dir, ["merge-base", base, proposal.commit]);
  const delta = changes(rules(readRepoConfigAtCommit(dir, ancestor)), rules(proposal.file));
  const desired = { ...rules(effective), ...delta };
  return { rules: desired, commit: proposal.commit, leitrechner: desired.leitrechner };
}

export function pendingRepoConfig(
  pr: PrStatus,
  effective: RepoConfigFile | null,
  proposed: RepoConfigFile,
  fallback: RepoRules = REPO_RULE_DEFAULTS,
): PendingRepoConfig {
  return pending(
    pr,
    changes(effective ? rules(effective) : { ...fallback, leitrechner: null }, rules(proposed)),
  );
}
