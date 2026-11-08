import { EFFORTS, type AgentProvider, type RepoAgentProviderSetting } from "#lib/types.js";
import { providerEfforts } from "#lib/effort-guidance.js";
import { effectiveRepoProvider, repoModelFitsProvider } from "#lib/repo-cli.js";

// The repo settings' "Next start" line (#3443): the CLI, model and effort a new task in this repo
// starts with, each with where it comes from, and the effort a plan-gated session switches to at
// Go. Display only. Mirrors resolveProviderDefaultModelSetting (src/default-model.ts),
// resolveProviderDefaultEffortSetting and the drain's execution-effort resolution
// (src/default-effort.ts, src/drain.ts) — keep them aligned.

export type SettingOrigin = "repo" | "global";

export interface NextStart {
  cli: AgentProvider;
  cliFrom: SettingOrigin;
  /** "auto" | "default" | a model alias. */
  model: string;
  modelFrom: SettingOrigin;
  /** "default" (no effort flag) | a tier. */
  effort: string;
  effortFrom: SettingOrigin;
  /** The tier a plan-gated session switches to at Go; null when it keeps its planning effort. */
  goEffort: string | null;
  goFrom: SettingOrigin;
}

/** The repo's own settings, as the repo-config store holds them ("inherit" = follow global). */
export interface NextStartRepo {
  agentProvider: RepoAgentProviderSetting;
  defaultModel: string;
  defaultEffort: string;
  defaultExecutionEffort: string;
}

/** The global settings an "inherit" falls back to (GET /api/settings). */
export interface NextStartGlobals {
  defaultAgentProvider?: AgentProvider;
  defaultModel: string;
  defaultCodexModel: string;
  defaultEffort: string;
  defaultClaudeEffort: string;
  defaultCodexEffort: string;
  defaultExecutionEffort?: string;
}

const EFFORT_SETTINGS = new Set<string>(["default", ...EFFORTS]);

/** A repo setting that overrides the global one: set and recognised. */
const overrides = (setting: string): boolean =>
  setting !== "inherit" && EFFORT_SETTINGS.has(setting);

export function nextStart(repo: NextStartRepo, g: NextStartGlobals): NextStart {
  const cli = effectiveRepoProvider(repo.agentProvider, g.defaultAgentProvider ?? "claude");
  const cliFrom: SettingOrigin = repo.agentProvider === "inherit" ? "global" : "repo";

  const repoModel =
    repo.defaultModel !== "inherit" && repoModelFitsProvider(repo.defaultModel, cli);
  const model = repoModel
    ? repo.defaultModel
    : cli === "codex"
      ? g.defaultCodexModel
      : g.defaultModel;

  const own = cli === "codex" ? g.defaultCodexEffort : g.defaultClaudeEffort;
  const engine = overrides(own) ? own : g.defaultEffort;
  const repoEffort =
    overrides(repo.defaultEffort) &&
    (repo.defaultEffort === "default" || providerEfforts(cli).includes(repo.defaultEffort));
  const effort = repoEffort ? repo.defaultEffort : engine;

  const repoGo = overrides(repo.defaultExecutionEffort);
  const go = repoGo ? repo.defaultExecutionEffort : (g.defaultExecutionEffort ?? "default");

  return {
    cli,
    cliFrom,
    model,
    modelFrom: repoModel ? "repo" : "global",
    effort,
    effortFrom: repoEffort ? "repo" : "global",
    goEffort: go === "default" ? null : go,
    goFrom: repoGo ? "repo" : "global",
  };
}
