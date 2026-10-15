/**
 * Readiness "Forge settings" (#3106): reads the repo's workflow files and host settings, runs the
 * pure checks in `readiness-forge-core.ts`, and applies one check's fix through the forge API.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitForge } from "./forge/types";
import { forgeChecks, deriveRequiredChecks, type ForgeCheckId } from "./readiness-forge-core";
import type { ForgeReadiness } from "./readiness-forge-core";

/** Bound on workflow files read per scan (a repo with more is not the common case). */
const MAX_WORKFLOWS = 50;

/** Raw text of the repo's `.github/workflows/*.y{a,}ml`; missing dir → []. */
async function readWorkflows(dir: string): Promise<string[]> {
  const base = join(dir, ".github", "workflows");
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
    .slice(0, MAX_WORKFLOWS);
  const texts = await Promise.all(
    files.map((n) => readFile(join(base, n), "utf8").catch(() => "")),
  );
  return texts.filter(Boolean);
}

type SettingsForge = GitForge & Required<Pick<GitForge, "repoForgeSettings">>;

function supportedForge(forge: GitForge | null): forge is SettingsForge {
  return !!forge && !forge.isFork && !!forge.repoForgeSettings;
}

export async function forgeReadiness(
  dir: string,
  forge: GitForge | null,
  autoLabel: string,
): Promise<ForgeReadiness> {
  if (!supportedForge(forge)) return { supported: false };
  const [settings, workflows] = await Promise.all([
    forge.repoForgeSettings(autoLabel),
    readWorkflows(dir),
  ]);
  return {
    supported: true,
    defaultBranch: settings.defaultBranch,
    autoLabel,
    checks: forgeChecks(settings, {
      mergeMethod: forge.mergeMethod,
      derivedChecks: deriveRequiredChecks(workflows, settings.defaultBranch),
    }),
  };
}

/** Thrown when the check is not in the `fix` state (nothing to apply, or no permission). */
export class ForgeCheckNotApplicableError extends Error {}

/** Apply one check's fix, then re-check. Re-reads first so Apply never acts on a stale view. */
export async function applyForgeCheck(
  dir: string,
  forge: GitForge | null,
  autoLabel: string,
  id: ForgeCheckId,
): Promise<ForgeReadiness> {
  const before = await forgeReadiness(dir, forge, autoLabel);
  const check = before.supported ? before.checks.find((c) => c.id === id) : undefined;
  if (!check || check.state !== "fix" || !forge) throw new ForgeCheckNotApplicableError(id);
  await applyFix(forge, id, check.target, autoLabel);
  return forgeReadiness(dir, forge, autoLabel);
}

async function applyFix(
  forge: GitForge,
  id: ForgeCheckId,
  target: unknown,
  autoLabel: string,
): Promise<void> {
  const need = <T>(fn: T | undefined): T => {
    if (!fn) throw new ForgeCheckNotApplicableError(id);
    return fn;
  };
  switch (id) {
    case "merge_methods": {
      const on = new Set(target as string[]);
      await need(forge.patchRepoSettings).call(forge, {
        mergeMethods: {
          merge: on.has("merge"),
          squash: on.has("squash"),
          rebase: on.has("rebase"),
        },
      });
      return;
    }
    case "auto_merge":
      await need(forge.enableRepoAutoMerge).call(forge);
      return;
    case "delete_branch_on_merge":
      await need(forge.patchRepoSettings).call(forge, { deleteBranchOnMerge: true });
      return;
    case "required_checks":
      await need(forge.createRequiredChecksRuleset).call(forge, target as string[]);
      return;
    case "auto_label":
      await need(forge.createRepoLabel).call(forge, autoLabel);
      return;
  }
}
