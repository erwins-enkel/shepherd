// Pure logic for the Backlog "Readiness" panel — kept out of the .svelte file so
// it's unit-testable without a DOM. The scorecard data itself comes from the
// server (`/api/readiness`); these helpers only shape it for display + actions.
import type { GuardrailCheck, ReadinessReport } from "$lib/types";

export type ScoreBand = "low" | "fair" | "good" | "strong";

/** Maps a 0–100 score to a qualitative band (drives label + color). */
export function scoreBand(score: number): ScoreBand {
  if (score < 40) return "low";
  if (score < 70) return "fair";
  if (score < 90) return "good";
  return "strong";
}

/** Absent guardrails, leverage-ranked — what the repo should adopt first. */
export function adoptList(report: ReadinessReport): GuardrailCheck[] {
  return report.checks.filter((c) => !c.present).sort((a, b) => b.weight - a.weight);
}

/** Guardrails already in place, leverage-ranked — the "have" column. */
export function haveList(report: ReadinessReport): GuardrailCheck[] {
  return report.checks.filter((c) => c.present).sort((a, b) => b.weight - a.weight);
}

/**
 * Seed prompt for the one-click "send to task" action: an i18n'd framing
 * sentence followed by the verbatim generated house-rules snippet (which already
 * enumerates the tooling to adopt). The agent installs the guardrails + the
 * CLAUDE.md, opening a PR — the prescription never auto-commits.
 */
export function buildAdoptPrompt(intro: string, claudeMd: string): string {
  return `${intro}\n\n${claudeMd}`;
}
