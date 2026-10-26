import type { AgentProvider, AutoMergeStatus, DrainStatus, Session } from "../types";
import { m } from "#lib/paraglide/messages.js";
import { sortBlocked, type BlockState } from "../triage";
import { displayStatus } from "../display-status";
import { bootstrapMissingLabel } from "./readiness-greenfield-view";
import { providerLabel } from "#lib/reviewer-env.js";

/** Enabled drains only, sorted by repo path — the per-repo drain lookup feeding repoChipRows. */
export function enabledDrains(drain: Record<string, DrainStatus>): DrainStatus[] {
  return Object.values(drain)
    .filter((d) => d.enabled)
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** One chip in the horizontal repo-filter rail: one entry per repo with ≥1 live
 *  (non-archived) session. */
export interface RepoChip {
  repoPath: string;
  /** Count of this repo's live (non-archived) sessions. */
  count: number;
  /** Enabled drain for this repo, or null. */
  drain: DrainStatus | null;
}

/**
 * One chip per repo that currently has ≥1 live session (any status EXCEPT "archived").
 * Sourced from the unfiltered herd `sessions` so the repo filter can scope to
 * idle/blocked/done repos too. Enriched with the repo's enabled drain. Sorted by repoPath.
 */
export function repoChipRows(sessions: Session[], drain: Record<string, DrainStatus>): RepoChip[] {
  const countByRepo = new Map<string, number>();
  for (const s of sessions) {
    if (s.status === "archived") continue;
    countByRepo.set(s.repoPath, (countByRepo.get(s.repoPath) ?? 0) + 1);
  }
  if (countByRepo.size === 0) return [];

  const drains = new Map(enabledDrains(drain).map((d) => [d.repoPath, d]));

  return [...countByRepo.entries()]
    .map(([repoPath, count]) => ({ repoPath, count, drain: drains.get(repoPath) ?? null }))
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Shared frozen empty repo filter — the default for every `repoFilter?: ReadonlySet<string>`
 *  prop. Frozen + read-only-typed so no consumer can mutate a shared instance. */
export const EMPTY_REPO_FILTER: ReadonlySet<string> = Object.freeze(new Set<string>());

/** Next herd repo filter after clicking a chip. `additive` (Shift held) toggles `repoPath`
 *  in/out of the current multi-selection; a plain click resets to just `repoPath`, or clears
 *  the filter when `repoPath` is already the sole selection (preserving the toggle-off gesture).
 *  Pure — returns a fresh Set; the page wraps it in a SvelteSet to assign. */
export function nextRepoFilter(
  current: ReadonlySet<string>,
  repoPath: string,
  additive: boolean,
): Set<string> {
  if (additive) {
    const next = new Set(current);
    if (next.has(repoPath)) next.delete(repoPath);
    else next.add(repoPath);
    return next;
  }
  if (current.size === 1 && current.has(repoPath)) return new Set();
  return new Set([repoPath]);
}

/** The chip rail renders when ≥2 repos have a live session (real filtering need), OR when
 *  a still-live selected repo remains — so a filter stays visible and can be toggled off,
 *  even after all other repos leave the herd. */
export function chipRailVisible(chips: RepoChip[], repoFilter: ReadonlySet<string>): boolean {
  return (
    chips.length >= 2 || (repoFilter.size > 0 && chips.some((c) => repoFilter.has(c.repoPath)))
  );
}

/** Whether a chip carries drain telemetry worth showing on its own detail line.
 *  An enabled but idle drain (nothing in flight, queued or paused) says nothing worth
 *  a band of vertical space, so it is hidden too. */
export function chipHasTelemetry(chip: RepoChip): boolean {
  const d = chip.drain;
  return (
    d !== null &&
    (d.inFlight > 0 ||
      d.queued > 0 ||
      d.paused ||
      !!d.claimDiagnostics?.length ||
      !!d.claimDiagnosticsFailed)
  );
}

/** Selected repos that no longer have any live session (no chip) — a filter on a vanished
 *  repo would strand it in the set, so the page prunes exactly these (not the whole set). */
export function staleFilterRepos(repoFilter: ReadonlySet<string>, chips: RepoChip[]): string[] {
  if (repoFilter.size === 0) return [];
  const live = new Set(chips.map((c) => c.repoPath));
  return [...repoFilter].filter((path) => !live.has(path));
}

/** Whether the herd's repo filter should follow a just-started task onto its repo.
 *  A new task lands in `repoPath`; if a filter is active but does NOT include that repo the
 *  task would be hidden behind the stale filter — so follow it (reset to that repo). An empty
 *  filter ("all repos") already shows the task, and a filter already covering `repoPath`
 *  needs no change. */
export function shouldFollowFilterToRepo(
  repoFilter: ReadonlySet<string>,
  repoPath: string,
): boolean {
  return repoFilter.size > 0 && !repoFilter.has(repoPath);
}

/** Follow the repo filter onto `repoPath` for a session jump: when an active filter would
 *  otherwise hide a session in that repo, collapse the filter to just that repo (mutating
 *  `repoFilter` IN PLACE — the live SvelteSet is reactive) and return true; otherwise a
 *  no-op returning false (empty filter = "all repos", or the repo is already covered).
 *  Shared decision behind both the new-task follow (selectNewSession) and the command-bar
 *  session select, so the two can't drift. Callers arm their follow latches on a true return. */
export function followRepoFilter(repoFilter: Set<string>, repoPath: string): boolean {
  if (!shouldFollowFilterToRepo(repoFilter, repoPath)) return false;
  for (const p of [...repoFilter]) if (p !== repoPath) repoFilter.delete(p);
  repoFilter.add(repoPath);
  return true;
}

/**
 * The session the terminal should re-target onto after the user picks a repo chip.
 * Narrowing the herd to a repo would otherwise leave the terminal on whatever session
 * was selected before — now in a *different* repo than the visible list. This chooses,
 * within the chosen repo: a session waiting on the user's answer (oldest-blocked first,
 * excluding working-while-blocked, which is actively running not waiting), else the first
 * active (running) session, else the first session in the repo. Returns null when nothing
 * should change — the user is already on a session in this repo, the repo has no session,
 * or the best target is already selected.
 */
export function pickRepoSwitchTarget(
  repoFilter: string,
  sessions: Session[],
  blocks: Record<string, BlockState>,
  workingBlocked: Record<string, boolean>,
  selected: Session | null,
  backgroundBusy: Record<string, boolean> = {},
): string | null {
  if (selected && selected.repoPath === repoFilter) return null;
  const inRepo = sessions.filter((s) => s.repoPath === repoFilter);
  if (inRepo.length === 0) return null;
  const waiting = sortBlocked(inRepo, blocks).find((e) => !workingBlocked[e.session.id])?.session;
  const active = inRepo.find((s) => displayStatus(s, workingBlocked, backgroundBusy) === "running");
  const next = waiting ?? active ?? inRepo[0];
  return next.id !== selected?.id ? next.id : null;
}

/** Whether the `queued` indicator is an interactive trigger (opens the queue
 *  popover) rather than inert text — true only when something is actually queued. */
export function queueOpenable(d: DrainStatus): boolean {
  return d.queued > 0;
}

/** Active (non-idle) merge-train statuses, sorted by repoPath. */
export function activeMergeTrain(autoMerge: Record<string, AutoMergeStatus>): AutoMergeStatus[] {
  return Object.values(autoMerge)
    .filter((s) => s.state !== null && s.state !== undefined)
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Whether the merge-train state is an attention/error state (vs active/in-progress). */
export function mergeTrainIsAttention(state: string): boolean {
  return (
    state === "merge_error" ||
    state === "rebase_cap" ||
    state === "stacked" ||
    state === "migrations"
  );
}

/**
 * Localized label for a merge-train state code.
 * Returns an empty string for null/undefined (idle) — callers should guard before rendering.
 */
export function mergeTrainLabel(state: string | null | undefined): string {
  switch (state) {
    case "merging":
      return m.automerge_state_merging();
    case "rebasing":
      return m.automerge_state_rebasing();
    case "merge_error":
      return m.automerge_state_merge_error();
    case "rebase_cap":
      return m.automerge_state_rebase_cap();
    case "stacked":
      return m.automerge_state_stacked();
    case "stack_untested":
      return m.automerge_state_stack_untested();
    case "migrations":
      return m.automerge_state_migrations();
    default:
      return "";
  }
}

/** A `bootstrap_incomplete` hold's comma-joined detail ("P2,P3,P4,ci_on_main") as a readable list —
 *  phases verbatim, greenfield must-haves (#3107) by their localized title. */
export function bootstrapMissingText(detail: string): string {
  return detail.split(",").filter(Boolean).map(bootstrapMissingLabel).join(", ");
}

/** A `sandbox_provider_unconfined` hold's detail (the CLI id, #3452) as its display name. */
export function holdCliLabel(detail: string): string {
  return providerLabel(detail as AgentProvider);
}

/** #3452: banner lines for the spawn gates — the next spawn's sandbox, CLI, host or target repo
 *  refuses unattended work. `detail` is the profile (implied by the code), the CLI or the repo. */
const SPAWN_GATE_PAUSED: Record<string, (detail: string) => string> = {
  sandbox_interactive: () => m.drain_paused_sandbox_interactive(),
  sandbox_provider_unconfined: (cli) => m.drain_paused_sandbox_provider({ cli: holdCliLabel(cli) }),
  sandbox_backend_unavailable: () => m.drain_paused_sandbox_backend(),
  sandbox_egress_unavailable: () => m.drain_paused_sandbox_egress(),
  target_repo_drain_off: (repo) => m.drain_paused_target_repo_drain_off({ repo }),
};

/** Localized banner line for a paused drain, mapped from its reason + detail. */
export function pausedText(d: DrainStatus): string {
  const desig = d.detail ?? "";
  const gate = SPAWN_GATE_PAUSED[d.reason ?? ""];
  if (gate) return gate(desig);
  switch (d.reason) {
    case "claim_check_failed":
      return m.drain_claims_load_failed();
    case "orphaned_claims":
      return m.drain_claims_status();
    case "blocked":
      return m.drain_paused_blocked({ desig });
    case "changes_requested":
      return m.drain_paused_changes({ desig });
    case "error":
      return m.drain_paused_error({ desig });
    case "usage":
      return d.usageCeilingPct != null
        ? m.drain_paused_usage_ceiling({ pct: desig, ceiling: d.usageCeilingPct })
        : m.drain_paused_usage({ pct: desig });
    case "credits":
      return m.drain_paused_credits();
    // #1757: the epic's integration branch could not be ensured on the forge — detail carries the
    // branch. Without this case the generic "paused" copy would hide an actionable, nameable cause.
    case "epic_base_unavailable":
      return m.drain_paused_epic_base({ branch: desig });
    // #3101: the epic waits on its integration branch following the default branch.
    case "epic_base_stale":
      return m.drain_paused_epic_base_stale({ branch: desig });
    case "epic_base_conflict":
      return m.drain_paused_epic_base_conflict({ branch: desig });
    case "epic_predecessor_unlanded":
      return m.drain_paused_epic_predecessor({ epics: desig });
    // The forge's open-issue listing failed (e.g. a rate limit): the epic can't be assembled, so
    // nothing spawns or completes until it loads — name it instead of a generic pause.
    case "epic_unreadable":
      return m.drain_paused_epic_unreadable();
    // #3105: the repo is still in project bootstrap — detail lists what is missing ("P2,P3,…").
    case "bootstrap_incomplete":
      return m.drain_paused_bootstrap({ missing: bootstrapMissingText(desig) });
    default:
      return m.drain_paused_generic();
  }
}
