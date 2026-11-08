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

/** The model: the repo's own when the CLI can run it, else the CLI's global default. */
function startModel(repo: NextStartRepo, cli: AgentProvider, g: NextStartGlobals) {
  const own = repo.defaultModel !== "inherit" && repoModelFitsProvider(repo.defaultModel, cli);
  if (own) return { model: repo.defaultModel, modelFrom: "repo" as const };
  return {
    model: cli === "codex" ? g.defaultCodexModel : g.defaultModel,
    modelFrom: "global" as const,
  };
}

/** The effort: the repo's own when the CLI offers it, else the engine's default, else global. */
function startEffort(repo: NextStartRepo, cli: AgentProvider, g: NextStartGlobals) {
  const own = cli === "codex" ? g.defaultCodexEffort : g.defaultClaudeEffort;
  const fits =
    repo.defaultEffort === "default" || providerEfforts(cli).includes(repo.defaultEffort);
  if (overrides(repo.defaultEffort) && fits)
    return { effort: repo.defaultEffort, effortFrom: "repo" as const };
  return { effort: overrides(own) ? own : g.defaultEffort, effortFrom: "global" as const };
}

/** The switch at Go: the repo's execution effort, else the global one; "default" = none. */
function startGo(repo: NextStartRepo, g: NextStartGlobals) {
  const own = overrides(repo.defaultExecutionEffort);
  const go = own ? repo.defaultExecutionEffort : (g.defaultExecutionEffort ?? "default");
  return {
    goEffort: go === "default" ? null : go,
    goFrom: own ? ("repo" as const) : ("global" as const),
  };
}

export function nextStart(repo: NextStartRepo, g: NextStartGlobals): NextStart {
  const cli = effectiveRepoProvider(repo.agentProvider, g.defaultAgentProvider ?? "claude");
  return {
    cli,
    cliFrom: repo.agentProvider === "inherit" ? "global" : "repo",
    ...startModel(repo, cli, g),
    ...startEffort(repo, cli, g),
    ...startGo(repo, g),
  };
}
