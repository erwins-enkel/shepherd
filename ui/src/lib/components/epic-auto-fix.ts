import type {
  AgentProvider,
  DrainRunSummary,
  Epic,
  EpicAutoBlockerCause,
  EpicAutoBlockers,
  EpicAutoFixOption,
  SandboxProfile,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { getLocale } from "#lib/i18n.js";
import { providerLabel } from "#lib/reviewer-env.js";

// #3454: the epic auto-fix model (#3453, GET /api/epic/auto-fix) in words — the causes that keep
// an epic's children from starting unattended and the ways out, as the halt card and the
// reusable EpicAutoFixChooser show them. Pure; the copy follows the "Behebung" artboard.

export interface CauseView {
  scope: string;
  /** The scope chip: REPO / EPIC / HOST. */
  scopeLabel: string;
  /** The setting at fault, emphasized; empty for a cause this client doesn't know. */
  what: string;
  why: string;
}

export interface OptionView {
  id: string;
  enabled: boolean;
  title: string;
  /** Where it writes: the repo, this epic, or both. */
  where: string;
  body: string | null;
  /** "Changes: …" — the epic's CLI switch; null when the option keeps the CLI. */
  change: string | null;
  /** Trusted's cost, shown in the warning colour. */
  risk: string | null;
  /** Passing checks of an enabled option, failing ones of a disabled one. */
  checks: { ok: boolean; text: string }[];
  /** Why a disabled option doesn't start the children, and what would make it choosable. */
  disabledWhy: string | null;
  disabledHint: string | null;
}

const SCOPE_LABELS: Record<string, () => string> = {
  repo: () => m.epic_autofix_scope_repo(),
  epic: () => m.epic_autofix_scope_epic(),
  host: () => m.epic_autofix_scope_host(),
};

const PROFILE_NAMES: Record<SandboxProfile, () => string> = {
  trusted: () => m.epic_autofix_profile_trusted(),
  standard: () => m.epic_autofix_profile_standard(),
  autonomous: () => m.epic_autofix_profile_autonomous(),
};

const CHECK_TEXT: Record<string, (ok: boolean) => string> = {
  bwrap: (ok) => (ok ? m.epic_autofix_check_bwrap_ok() : m.epic_autofix_check_bwrap_fail()),
  egress: (ok) => (ok ? m.epic_autofix_check_egress_ok() : m.epic_autofix_check_egress_fail()),
  remote_https: (ok) =>
    ok ? m.epic_autofix_check_remote_ok() : m.epic_autofix_check_remote_fail(),
};

function cliName(provider: string): string {
  return providerLabel(provider as AgentProvider);
}

function profileName(profile: SandboxProfile): string {
  return PROFILE_NAMES[profile]?.() ?? profile;
}

/** One cause with its scope chip. */
export function causeView(cause: EpicAutoBlockerCause): CauseView {
  const scopeLabel = SCOPE_LABELS[cause.scope]?.() ?? cause.scope.toUpperCase();
  const base = { scope: cause.scope, scopeLabel };
  switch (cause.code) {
    case "sandbox_interactive":
      return {
        ...base,
        what: m.epic_autofix_cause_interactive_what(),
        why: m.epic_autofix_cause_interactive_why(),
      };
    case "sandbox_provider_unconfined":
      return {
        ...base,
        what: m.epic_autofix_cli({ cli: cliName(cause.detail) }),
        why: m.epic_autofix_cause_provider_why(),
      };
    case "sandbox_backend_unavailable":
      return {
        ...base,
        what: m.epic_autofix_cause_backend_what(),
        why: m.epic_autofix_cause_backend_why(),
      };
    case "sandbox_egress_unavailable":
      return {
        ...base,
        what: m.epic_autofix_cause_egress_what(),
        why: m.epic_autofix_cause_egress_why(),
      };
    default:
      return { ...base, what: "", why: m.epic_autofix_cause_other() };
  }
}

/** One way out. `repoName` names the repo whose sandbox it writes. */
export function optionView(
  option: EpicAutoFixOption,
  blockers: EpicAutoBlockers,
  repoName: string,
): OptionView {
  const { sandboxProfile, agentProvider } = option.changes;
  // The CLI that runs unconfined today (Codex) — what Trusted keeps and the switch replaces.
  const unconfined = blockers.causes.find((c) => c.code === "sandbox_provider_unconfined");
  const cli = unconfined ? cliName(unconfined.detail) : null;
  const trusted = sandboxProfile === "trusted";
  const onlyWay = option.enabled && blockers.options.filter((o) => o.enabled).length === 1;

  const parts = [
    sandboxProfile ? m.epic_autofix_title_sandbox({ profile: profileName(sandboxProfile) }) : "",
    agentProvider ? m.epic_autofix_cli({ cli: cliName(agentProvider) }) : "",
  ].filter(Boolean);
  const title =
    option.why === "cli" && !agentProvider
      ? m.epic_autofix_title_autonomous_only()
      : parts.join(" + ") || option.id;
  const where =
    sandboxProfile && agentProvider
      ? m.epic_autofix_where_both()
      : agentProvider
        ? m.epic_autofix_where_epic()
        : m.epic_autofix_where_repo({ repo: repoName });

  let body: string | null = null;
  if (option.enabled && trusted) {
    body = onlyWay
      ? m.epic_autofix_body_only_way()
      : cli
        ? m.epic_autofix_body_keeps_cli({ cli })
        : null;
  } else if (option.enabled) {
    body = agentProvider
      ? m.epic_autofix_body_confined()
      : `${m.epic_autofix_body_confined()} ${m.epic_autofix_body_nothing_else()}`;
  }

  // The CLI check never shows as a tick: its failure is the disabled reason itself.
  const listed = option.why === "cli" ? [] : option.checks.filter((c) => CHECK_TEXT[c.id]);
  const checks = listed
    .filter((c) => option.enabled || !c.ok)
    .map((c) => ({ ok: c.ok, text: CHECK_TEXT[c.id]!(c.ok) }));

  let disabledWhy: string | null = null;
  let disabledHint: string | null = null;
  if (!option.enabled) {
    if (option.why === "cli")
      disabledWhy = m.epic_autofix_disabled_cli({ cli: cli ?? m.agent_provider_codex() });
    else if (option.why === "bwrap" || option.why === "egress")
      disabledHint = m.epic_autofix_disabled_host();
    else if (option.why === "remote_https") disabledHint = m.epic_autofix_disabled_remote();
    else disabledWhy = m.epic_autofix_disabled_other();
  }

  return {
    id: option.id,
    enabled: option.enabled,
    title,
    where,
    body,
    change:
      option.enabled && agentProvider && cli
        ? m.epic_autofix_change_cli({ from: cli, to: cliName(agentProvider) })
        : null,
    risk: option.enabled && trusted ? m.epic_autofix_risk_trusted({ repo: repoName }) : null,
    checks,
    disabledWhy,
    disabledHint,
  };
}

/** The epic's ready children in drain order, and those a fix starts at once — as many as the
 *  repo has free agent slots. Without a run picture the slots are unknown: nothing is promised. */
export function startable(
  epic: Pick<Epic, "children">,
  summary: DrainRunSummary | null | undefined,
): { ready: number[]; starting: number[] } {
  const order = summary?.next ?? [];
  const rank = (n: number) => {
    const i = order.indexOf(n);
    return i < 0 ? order.length : i;
  };
  const ready = epic.children
    .filter((c) => c.state === "ready")
    .map((c) => c.number)
    .sort((a, b) => rank(a) - rank(b));
  if (!summary) return { ready, starting: [] };
  const free = Math.max(0, summary.slots.max - summary.slots.used);
  return { ready, starting: ready.slice(0, free) };
}

/** "#17 und #18" — issue numbers as a localized list. */
export function issueList(nums: number[]): string {
  return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(nums.map((n) => `#${n}`));
}

/** The confirmation after a fix: what it set, e.g. "Sandbox of shop: Autonomous. CLI of this
 *  epic: Claude Code." */
export function confirmText(changes: EpicAutoFixOption["changes"], repoName: string): string {
  return [
    changes.sandboxProfile
      ? m.epic_autofix_done_sandbox({
          repo: repoName,
          profile: profileName(changes.sandboxProfile),
        })
      : "",
    changes.agentProvider ? m.epic_autofix_done_cli({ cli: cliName(changes.agentProvider) }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Which footer settings hold the run: the epic's CLI (an epic-scoped cause) and the repo's
 *  sandbox (a repo-scoped one). Until the model loads, the drain's own hold reason decides.
 *  Pass null for both while the run is not held by a sandbox gate. */
export function haltedSettings(
  blockers: EpicAutoBlockers | null,
  reason: string | null,
): { cli: boolean; sandbox: boolean } {
  if (blockers) {
    return {
      cli: blockers.causes.some((c) => c.scope === "epic"),
      sandbox: blockers.causes.some((c) => c.scope === "repo"),
    };
  }
  return {
    cli: reason === "sandbox_provider_unconfined",
    sandbox: reason === "sandbox_interactive",
  };
}
