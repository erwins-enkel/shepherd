/**
 * #3453: what keeps an epic's children from starting unattended, and which settings changes would
 * really start them. Pure — the drain gathers the inputs (DrainService.autoBlockers) and the
 * `/api/epic/auto-fix` route applies a chosen option.
 *
 * The causes are the drain's own spawn-gate holds (#3452), listed all at once instead of first-hit,
 * so the operator sees every setting at fault. The options combine sandbox, CLI, host and git
 * remote: an option is enabled only when the state it produces passes that same gate.
 */
import { effortsForProvider } from "./default-effort";
import { modelCompatibleWithProvider } from "./default-model";
import type { AutoHoldCode, SandboxProfile } from "./sandbox";
import type { AgentProvider } from "./types";

/** A spawn-gate hold code (#3452) an epic's unattended start can hit. */
export type AutoBlockerCode = AutoHoldCode | "sandbox_provider_unconfined";

/** Where a cause lives: the repo's settings, this epic's settings, or this machine. */
export type AutoBlockerScope = "repo" | "epic" | "host";

export interface AutoBlockerCause {
  code: AutoBlockerCode;
  scope: AutoBlockerScope;
  /** As drain:status names it: the profile, or the CLI for `sandbox_provider_unconfined`. */
  detail: string;
}

export type AutoFixOptionId = "autonomous" | "autonomous_claude" | "trusted";

/** `cli`: the epic's CLI can run confined (Codex never does). `remote_https`: a sandboxed session
 *  can push to `origin` (an SSH remote can't). */
export type AutoFixCheckId = "cli" | "bwrap" | "egress" | "remote_https";

export interface AutoFixCheck {
  id: AutoFixCheckId;
  ok: boolean;
}

export interface AutoFixOption {
  id: AutoFixOptionId;
  /** The settings this option writes: the repo's sandbox profile and/or the epic's CLI. */
  changes: { sandboxProfile?: SandboxProfile; agentProvider?: AgentProvider };
  /** Every check passes — applying it starts the epic's children. */
  enabled: boolean;
  /** The first failing check, when disabled. */
  why?: AutoFixCheckId;
  checks: AutoFixCheck[];
}

export interface AutoBlockers {
  causes: AutoBlockerCause[];
  /** Empty when nothing blocks. */
  options: AutoFixOption[];
  /** The confined way when one is enabled, else `trusted`; null without options. */
  preselect: AutoFixOptionId | null;
}

/**
 * The causes and fixes for one epic.
 *   epic.agentProvider — the CLI its children spawn with (the epic's, else the global default)
 *   repo.profile       — the repo's effective sandbox profile
 *   repo.remoteHttps   — `origin` is an https remote
 *   host               — bwrap and the egress backend work here
 * Trusted needs no confinement, so it reports nothing and ignores host and remote.
 */
export function autoBlockers(
  epic: { agentProvider: AgentProvider },
  repo: { profile: SandboxProfile; remoteHttps: boolean },
  host: { bwrap: boolean; egress: boolean },
): AutoBlockers {
  const causes = blockerCauses(epic.agentProvider, repo.profile, host);
  if (causes.length === 0) return { causes, options: [], preselect: null };
  const options = fixOptions(epic.agentProvider, repo, host);
  const confined = options.find((o) => o.enabled && o.id !== "trusted");
  return { causes, options, preselect: (confined ?? options.find((o) => o.enabled))!.id };
}

function blockerCauses(
  provider: AgentProvider,
  profile: SandboxProfile,
  host: { bwrap: boolean; egress: boolean },
): AutoBlockerCause[] {
  if (profile === "trusted") return [];
  const causes: AutoBlockerCause[] = [];
  if (profile === "standard")
    causes.push({ code: "sandbox_interactive", scope: "repo", detail: profile });
  if (provider === "codex")
    causes.push({ code: "sandbox_provider_unconfined", scope: "epic", detail: provider });
  // Listed on standard too: they are why Autonomous can't help.
  if (!host.bwrap)
    causes.push({ code: "sandbox_backend_unavailable", scope: "host", detail: profile });
  if (!host.egress)
    causes.push({ code: "sandbox_egress_unavailable", scope: "host", detail: profile });
  return causes;
}

/** The ways out, confined first. With Codex, Autonomous alone can never work, so it goes last. */
function fixOptions(
  provider: AgentProvider,
  repo: { profile: SandboxProfile; remoteHttps: boolean },
  host: { bwrap: boolean; egress: boolean },
): AutoFixOption[] {
  const confinable: AutoFixCheck[] = [
    { id: "bwrap", ok: host.bwrap },
    { id: "egress", ok: host.egress },
    { id: "remote_https", ok: repo.remoteHttps },
  ];
  // Already autonomous: switching to it changes nothing, so it is no option.
  const toAutonomous: AutoFixOption["changes"] =
    repo.profile === "autonomous" ? {} : { sandboxProfile: "autonomous" };
  const autonomous =
    repo.profile === "autonomous"
      ? []
      : [
          option("autonomous", toAutonomous, [
            { id: "cli", ok: provider !== "codex" },
            ...confinable,
          ]),
        ];
  const trusted = option("trusted", { sandboxProfile: "trusted" }, []);
  if (provider !== "codex") return [...autonomous, trusted];
  const withClaude = option(
    "autonomous_claude",
    { ...toAutonomous, agentProvider: "claude" },
    confinable,
  );
  return [withClaude, trusted, ...autonomous];
}

function option(
  id: AutoFixOptionId,
  changes: AutoFixOption["changes"],
  checks: AutoFixCheck[],
): AutoFixOption {
  const failed = checks.find((c) => !c.ok);
  return failed
    ? { id, changes, enabled: false, why: failed.id, checks }
    : { id, changes, enabled: true, checks };
}

/** True for an `https://` remote; scp-style, `ssh://` and a missing remote can't push from the
 *  sandbox (see automation_sandbox_profile_caveats). */
export function remoteIsHttps(url: string | null): boolean {
  return url !== null && /^https:\/\//i.test(url.trim());
}

/** The epic's CLI settings after switching it to `agentProvider`, like EpicRunSettings.svelte's
 *  onProviderChange: a model or effort the new CLI doesn't offer falls back to its default. */
export function providerSwitchSettings(
  run: { model?: string | null; effort?: string | null },
  agentProvider: AgentProvider,
): { agentProvider: AgentProvider; model: string | null; effort: string | null } {
  const model = run.model ?? null;
  const effort = run.effort ?? null;
  return {
    agentProvider,
    model: modelCompatibleWithProvider(model, agentProvider) ? model : null,
    effort: effort !== null && effortsForProvider(agentProvider).includes(effort) ? effort : null,
  };
}
