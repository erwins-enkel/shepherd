import { gateGapScenarios } from "./report";
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
async function findOpenIssue(gh: GhRunner): Promise<{ number: number; url: string } | null> {
  const r = await gh([
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--json",
    "number,url",
    "--limit",
    "1",
  ]);
  if (r.code !== 0) throw new Error(`gh issue list failed: ${r.stderr || r.stdout}`);
  const rows = JSON.parse(r.stdout || "[]") as Array<{ number: number; url: string }>;
  return rows[0] ?? null;
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

export interface IssueOutcome {
  /** Short description of the action taken, for the run log. */
  summary: string;
  /** URL of the open regression issue, if one is now open (for the status link). */
  issueUrl: string | null;
}

/**
 * File the nightly outcome to GitHub for accountability, keeping ONE rolling
 * issue whose lifecycle mirrors the regression:
 *  - gaps + no open issue → open a labelled issue (body = the report)
 *  - gaps + open issue    → refresh the body to the latest report + add a dated
 *                           comment, so the issue is an auditable timeline
 *  - clean + open issue   → close it (the regression is resolved)
 *  - clean + no open issue → nothing
 * `stamp` is passed in so this module stays free of wall-clock for deterministic
 * tests.
 */
export async function reportToGitHub(
  results: ScenarioResult[],
  reportMarkdown: string,
  stamp: string,
  gh: GhRunner = defaultGh,
): Promise<IssueOutcome> {
  const gaps = gateGapScenarios(results);
  const existing = await findOpenIssue(gh);

  if (gaps.length === 0) {
    if (existing == null)
      return { summary: "clean run, no open issue — nothing to do", issueUrl: null };
    const r = await gh([
      "issue",
      "close",
      String(existing.number),
      "--comment",
      `All onboarding scenarios green as of ${stamp}. Closing.`,
    ]);
    if (r.code !== 0) throw new Error(`gh issue close failed: ${r.stderr || r.stdout}`);
    return { summary: `closed #${existing.number} (regression resolved)`, issueUrl: null };
  }

  const body = `${reportMarkdown}\n_Nightly run: ${stamp}_\n`;
  if (existing == null) {
    await ensureLabel(gh);
    const r = await gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body", body]);
    if (r.code !== 0) throw new Error(`gh issue create failed: ${r.stderr || r.stdout}`);
    const url = r.stdout.trim();
    return { summary: `opened issue: ${url}`, issueUrl: url };
  }

  const scenarios = gaps.map((g) => g.scenarioId).join(", ");
  const edit = await gh(["issue", "edit", String(existing.number), "--body", body]);
  if (edit.code !== 0) throw new Error(`gh issue edit failed: ${edit.stderr || edit.stdout}`);
  const comment = await gh([
    "issue",
    "comment",
    String(existing.number),
    "--body",
    `Nightly run ${stamp}: ${gaps.length} gap(s) still present — ${scenarios}.`,
  ]);
  if (comment.code !== 0)
    throw new Error(`gh issue comment failed: ${comment.stderr || comment.stdout}`);
  return { summary: `updated #${existing.number} (${gaps.length} gap(s))`, issueUrl: existing.url };
}

/**
 * Publish a GitHub commit status (`onboarding-harness` context) on the tested
 * `sha`, so every nightly run leaves a visible, linkable green/red record on the
 * commit — even a clean run that files no issue. `targetUrl` (the regression
 * issue) is attached when present so the red check links straight to the gaps.
 */
export async function publishStatus(
  sha: string,
  ok: boolean,
  description: string,
  targetUrl: string | null,
  gh: GhRunner = defaultGh,
): Promise<void> {
  const args = [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/statuses/${sha}`,
    "-f",
    `state=${ok ? "success" : "failure"}`,
    "-f",
    "context=onboarding-harness",
    "-f",
    `description=${description.slice(0, 140)}`,
  ];
  if (targetUrl) args.push("-f", `target_url=${targetUrl}`);
  const r = await gh(args);
  if (r.code !== 0) throw new Error(`gh status publish failed: ${r.stderr || r.stdout}`);
}
