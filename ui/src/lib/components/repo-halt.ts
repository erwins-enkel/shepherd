import type {
  AgentProvider,
  EpicAutoBlockerCause,
  EpicAutoBlockers,
  EpicAutoFixCauseCode,
  EpicAutoFixOption,
} from "#lib/types.js";
import type { RepoBootstrapView } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { providerLabel } from "#lib/reviewer-env.js";
import { causeView, confirmText, haltSummary, scopeLabel } from "./epic-auto-fix";

// #3456: the repo overview's halt in words — a cause in the repo's settings or on this host once,
// as a banner over every epic, and each epic's own cause or pre-check at its card. Pure; the
// models are the #3453 auto-fix answers per epic (GET /api/epic/auto-fix), the copy follows the
// "Repo-Überblick" artboard.

/** Causes the banner says once: the repo's settings and this host apply to every epic alike. */
function repoWide(cause: EpicAutoBlockerCause): boolean {
  return cause.scope === "repo" || cause.scope === "host";
}

export interface RepoHaltView {
  /** The repo's and host's causes, once each. */
  causes: EpicAutoBlockerCause[];
  /** The banner's chip: the first cause's scope. */
  scope: string;
  scopeLabel: string;
  /** One short sentence per cause, e.g. "Sandbox Standard is interactive only." */
  reason: string;
  /** How many of the epics those causes hold. */
  affected: number;
  /** The epic "Switch to Autonomous" applies the repo's own fix through — any epic whose model
   *  offers it enabled; null hides the button (this host or remote can't confine). */
  autonomous: number | null;
  /** The epic whose ways "Other choice …" offers: the one the drain holds, else the first held. */
  target: number;
}

/** The banner, or null while no epic's model names a repo or host cause. `order` is the overview's
 *  card order, `halted` the epic the drain holds at a sandbox gate. */
export function repoHaltView(
  models: Readonly<Record<number, EpicAutoBlockers>>,
  order: readonly number[],
  halted: number | null,
): RepoHaltView | null {
  const held = order.filter((p) => models[p]?.causes.some(repoWide));
  if (held.length === 0) return null;
  const causes: EpicAutoBlockerCause[] = [];
  for (const p of held)
    for (const c of models[p]!.causes)
      if (repoWide(c) && !causes.some((x) => x.code === c.code)) causes.push(c);
  const autonomous =
    held.find(
      (p) => models[p]!.causes.find((c) => c.code === "sandbox_interactive")?.fix?.enabled,
    ) ?? null;
  return {
    causes,
    scope: causes[0]!.scope,
    scopeLabel: scopeLabel(causes[0]!.scope),
    reason: haltSummary(causes),
    affected: held.length,
    autonomous,
    target: halted != null && held.includes(halted) ? halted : held[0]!,
  };
}

/** One cause's own fix offered at an epic card — today the CLI switch. */
export interface CauseAction {
  code: EpicAutoFixCauseCode;
  label: string;
}

export interface HaltLine {
  scope: string;
  scopeLabel: string;
  /** The setting at fault, emphasized; empty when the text says it all. */
  what: string;
  text: string;
  action: CauseAction | null;
}

/** An epic card's halt: `halted` — the drain holds it now, every cause listed (the repo's only
 *  pointing up at the banner); `precheck` — it would hold on start for a cause of its own;
 *  `waits` — only the repo or host holds it, otherwise it is ready. */
export type EpicHaltView =
  | { kind: "halted" | "precheck"; lines: HaltLine[] }
  | { kind: "waits"; scope: string; scopeLabel: string; ready: string[] | null };

/** An epic card's halt from its model, or null when nothing would hold it. `bootstrap` is the
 *  repo's project-bootstrap view, when known. */
export function epicHaltView(
  model: EpicAutoBlockers,
  opts: { halted: boolean; bootstrap: RepoBootstrapView | null },
): EpicHaltView | null {
  const causes = model.causes;
  if (causes.length === 0) return null;
  if (opts.halted) return { kind: "halted", lines: causes.map(haltedLine) };
  const own = causes.filter((c) => !repoWide(c));
  if (own.length > 0) return { kind: "precheck", lines: own.map(precheckLine) };
  return {
    kind: "waits",
    scope: causes[0]!.scope,
    scopeLabel: scopeLabel(causes[0]!.scope),
    ready: readyChecks(model.agentProvider, opts.bootstrap),
  };
}

function haltedLine(cause: EpicAutoBlockerCause): HaltLine {
  const v = causeView(cause);
  const base = { scope: v.scope, scopeLabel: v.scopeLabel };
  // The banner says the repo's and host's causes; the card only points there.
  if (repoWide(cause))
    return { ...base, what: v.what || v.why, text: m.repooverview_halt_see_above(), action: null };
  return { ...base, what: v.what, text: v.why, action: causeAction(cause) };
}

function precheckLine(cause: EpicAutoBlockerCause): HaltLine {
  const v = causeView(cause);
  return {
    scope: v.scope,
    scopeLabel: v.scopeLabel,
    what: "",
    text: m.repooverview_precheck_would_halt({ reason: haltSummary([cause]) }),
    action: causeAction(cause),
  };
}

/** The card's own way out: an enabled fix that switches the epic's CLI. */
function causeAction(cause: EpicAutoBlockerCause): CauseAction | null {
  const cli = cause.fix?.enabled ? cause.fix.changes.agentProvider : undefined;
  if (!cli) return null;
  return {
    code: cause.code as EpicAutoFixCauseCode,
    label: m.repooverview_cli_switch({ cli: providerLabel(cli) }),
  };
}

/** "✓ CLI Claude Code · ✓ Bootstrap done" — what else the epic needs and has. Null while an
 *  active bootstrap still misses something: then it isn't ready either way. */
function readyChecks(
  provider: AgentProvider | undefined,
  bootstrap: RepoBootstrapView | null,
): string[] | null {
  if (bootstrap?.state === "active" && bootstrap.missing.length > 0) return null;
  const checks = [
    ...(provider ? [m.epic_autofix_cli({ cli: providerLabel(provider) })] : []),
    ...(bootstrap?.state === "done" ? [m.repooverview_precheck_bootstrap_done()] : []),
  ];
  return checks.length > 0 ? checks : null;
}

/** The confirmation after a fix from the overview. The CLI part names the epic: "this epic" is
 *  ambiguous in a list of them. */
export function overviewConfirmText(
  changes: EpicAutoFixOption["changes"],
  repoName: string,
  parent: number,
): string {
  const { agentProvider, ...rest } = changes;
  return [
    confirmText(rest, repoName),
    agentProvider
      ? m.repooverview_done_cli({ epic: parent, cli: providerLabel(agentProvider) })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
