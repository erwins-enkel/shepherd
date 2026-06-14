import { gapScenarios } from "./report";
import { captureSpawn, type Captured } from "./spawn";
import type { ScenarioResult } from "./types";

/** Injectable `gh` runner: receives argv (after the `gh` binary), resolves with
 *  captured output and never throws (the caller inspects `code`). Tests inject a
 *  fake; production spawns the real CLI. */
export type GhRunner = (args: string[]) => Promise<Captured>;

const defaultGh: GhRunner = (args) => captureSpawn("gh", args);

// A single rolling accountability issue, found by this label so a persisting gap
// never spawns a duplicate night after night.
const LABEL = "onboarding-regression";
const TITLE = "Onboarding harness: nightly regression detected";

// Dedup relies on the nightly's daily cadence: GitHub's label-filtered issue list
// is eventually-consistent (a just-created issue isn't returned for a few seconds),
// so back-to-back runs within that window could double-file. Runs 24h apart never
// hit it — by the next night the issue is long-indexed.
async function findOpenIssue(gh: GhRunner): Promise<number | null> {
  const r = await gh([
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  if (r.code !== 0) throw new Error(`gh issue list failed: ${r.stderr || r.stdout}`);
  const rows = JSON.parse(r.stdout || "[]") as Array<{ number: number }>;
  return rows[0]?.number ?? null;
}

/** Create the dedup label if absent (idempotent via --force). */
async function ensureLabel(gh: GhRunner): Promise<void> {
  await gh([
    "label",
    "create",
    LABEL,
    "--color",
    "B60205",
    "--description",
    "Onboarding harness nightly regression",
    "--force",
  ]);
}

/**
 * File the nightly outcome to GitHub for accountability, keeping ONE rolling
 * issue whose lifecycle mirrors the regression:
 *  - gaps + no open issue → open a labelled issue (body = the report)
 *  - gaps + open issue    → refresh the body to the latest report + add a dated
 *                           comment, so the issue is an auditable timeline
 *  - clean + open issue   → close it (the regression is resolved)
 *  - clean + no open issue → nothing
 * Returns a short description of the action taken (for the run log). `stamp` is
 * passed in so this module stays free of wall-clock for deterministic tests.
 */
export async function reportToGitHub(
  results: ScenarioResult[],
  reportMarkdown: string,
  stamp: string,
  gh: GhRunner = defaultGh,
): Promise<string> {
  const gaps = gapScenarios(results);
  const existing = await findOpenIssue(gh);

  if (gaps.length === 0) {
    if (existing == null) return "clean run, no open issue — nothing to do";
    const r = await gh([
      "issue",
      "close",
      String(existing),
      "--comment",
      `All onboarding scenarios green as of ${stamp}. Closing.`,
    ]);
    if (r.code !== 0) throw new Error(`gh issue close failed: ${r.stderr || r.stdout}`);
    return `closed #${existing} (regression resolved)`;
  }

  const body = `${reportMarkdown}\n_Nightly run: ${stamp}_\n`;
  if (existing == null) {
    await ensureLabel(gh);
    const r = await gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body", body]);
    if (r.code !== 0) throw new Error(`gh issue create failed: ${r.stderr || r.stdout}`);
    return `opened issue: ${r.stdout.trim()}`;
  }

  const scenarios = gaps.map((g) => g.scenarioId).join(", ");
  const edit = await gh(["issue", "edit", String(existing), "--body", body]);
  if (edit.code !== 0) throw new Error(`gh issue edit failed: ${edit.stderr || edit.stdout}`);
  const comment = await gh([
    "issue",
    "comment",
    String(existing),
    "--body",
    `Nightly run ${stamp}: ${gaps.length} gap(s) still present — ${scenarios}.`,
  ]);
  if (comment.code !== 0)
    throw new Error(`gh issue comment failed: ${comment.stderr || comment.stdout}`);
  return `updated #${existing} (${gaps.length} gap(s))`;
}
