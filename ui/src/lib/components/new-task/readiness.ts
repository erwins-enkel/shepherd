import type { AgentProvider } from "$lib/types";

export type ReadinessBlocker =
  "empty_prompt" | "no_repo" | "base_missing" | "repairing" | "submitting";

export type ReadinessAdvisory = "checking" | "diverged" | "behind" | "hold_likely";

export interface ReadinessInput {
  promptEmpty: boolean;
  /** Repo-aware: true only while the attached issue still belongs to the selected repo
   *  (`issueRef != null && repoPath === attachedRepoPath`). */
  issueSeeded: boolean;
  repoResolved: boolean;
  baseMissing: boolean;
  repairing: boolean;
  submitting: boolean;
  upstreamLoading: boolean;
  upstream: { diverged: boolean; behind: number } | null;
  holdLikely: boolean;
  provider: AgentProvider;
}

export interface Readiness {
  canSubmit: boolean;
  blocker: ReadinessBlocker | null;
  advisories: ReadinessAdvisory[];
}

/**
 * Presentation-layer restatement of the modal's submit conditions — the footer readiness
 * line and CTA disabled-state derive from this, and submit()'s guard reads canSubmit. It
 * introduces no gating beyond what the template scattered before, with one deliberate,
 * handoff-specified extension: a seeded same-repo issue satisfies the prompt requirement
 * ("prompt non-empty OR an issue is seeded").
 */
export function deriveReadiness(i: ReadinessInput): Readiness {
  const blocker: ReadinessBlocker | null = i.submitting
    ? "submitting"
    : i.repairing
      ? "repairing"
      : !i.repoResolved
        ? "no_repo"
        : i.baseMissing
          ? "base_missing"
          : i.promptEmpty && !i.issueSeeded
            ? "empty_prompt"
            : null;

  const advisories: ReadinessAdvisory[] = [];
  if (i.upstreamLoading) advisories.push("checking");
  else if (i.upstream?.diverged) advisories.push("diverged");
  else if (i.upstream && i.upstream.behind > 0) advisories.push("behind");
  // A likely usage hold applies to the Claude quota only; Codex is the suggested
  // alternative, not a held path — so the dual-CTA advisory is Claude-scoped.
  if (i.holdLikely && i.provider === "claude") advisories.push("hold_likely");

  return { canSubmit: blocker === null, blocker, advisories };
}
