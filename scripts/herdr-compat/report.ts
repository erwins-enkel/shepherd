/**
 * Report renderer for the herdr compatibility check (SOP: .claude/rules/herdr-version-bump.md).
 *
 * Pure: takes the finished check results and renders the markdown that gets committed to
 * `docs/herdr-compat/<candidate>.md` by the bump PR. The exit-code rule lives here so it is
 * unit-testable: any FAIL fails the run (exit 1); REVIEW never does — a REVIEW item is a
 * human/agent triage step, not a machine verdict.
 */

export type Verdict = "PASS" | "REVIEW" | "FAIL";

export interface CheckResult {
  /** Stable check id from the SOP catalog (S1–S4 static, L1–L9 live). */
  id: string;
  title: string;
  verdict: Verdict;
  /** Markdown body: A/B observations, diff excerpts, or the reason a verdict was reached. */
  details: string;
}

export interface ReportInput {
  candidate: string;
  baseline: string;
  candidateProtocol: number | null;
  baselineProtocol: number | null;
  /** ISO date of the run (the caller stamps it). */
  date: string;
  /** Host platform the live probes ran on, e.g. "linux-x86_64". */
  platform: string;
  /** The exact invocation, so the report is reproducible. */
  commandLine: string;
  checks: CheckResult[];
}

export function overallExitCode(checks: readonly CheckResult[]): 0 | 1 {
  return checks.some((c) => c.verdict === "FAIL") ? 1 : 0;
}

export function overallVerdict(checks: readonly CheckResult[]): Verdict {
  if (checks.some((c) => c.verdict === "FAIL")) return "FAIL";
  if (checks.some((c) => c.verdict === "REVIEW")) return "REVIEW";
  return "PASS";
}

/** `<sanitized-version>.md`; throws when the version sanitizes to nothing (never build a path
 *  from raw input — mirrors sanitizeVersion in src/herdr-install.ts). */
export function reportFileName(candidate: string): string {
  const clean = candidate.replace(/[^0-9.]/g, "").replace(/^\.+|\.+$/g, "");
  if (!clean) throw new Error(`not a version: ${JSON.stringify(candidate)}`);
  return `${clean}.md`;
}

export function renderReport(input: ReportInput): string {
  const counts = { PASS: 0, REVIEW: 0, FAIL: 0 };
  for (const c of input.checks) counts[c.verdict]++;
  const overall = overallVerdict(input.checks);

  const lines: string[] = [
    `# herdr ${input.candidate} compatibility report`,
    "",
    `**Overall: ${overall}** — PASS: ${counts.PASS} · REVIEW: ${counts.REVIEW} · FAIL: ${counts.FAIL}`,
    "",
    "| | |",
    "| --- | --- |",
    `| Candidate | herdr ${input.candidate} (protocol ${input.candidateProtocol ?? "?"}) |`,
    `| Baseline | herdr ${input.baseline} (protocol ${input.baselineProtocol ?? "?"}) |`,
    `| Date | ${input.date} |`,
    `| Host | ${input.platform} |`,
    `| Invocation | \`${input.commandLine}\` |`,
    `| Release notes | https://github.com/herdrdev/herdr/releases/tag/v${input.candidate} |`,
    "",
    "Produced by `bun run herdr:compat`; procedure and verdict semantics:",
    "[`.claude/rules/herdr-version-bump.md`](../../.claude/rules/herdr-version-bump.md).",
    "REVIEW items need a written triage in the bump PR; any FAIL blocks the bump until code",
    "addresses it (or the version is declined, documented in the issue).",
    "",
  ];

  for (const c of input.checks) {
    lines.push(`## ${c.id} — ${c.title}`, "", `**${c.verdict}**`, "", c.details, "");
  }

  lines.push(
    "## Next steps",
    "",
    "1. Triage every REVIEW above; fix or consciously accept every FAIL (document either way).",
    "2. Regenerate the vendored protocol against the candidate binary:",
    "   `HERDR_BIN=<candidate> bun run gen:herdr-schema && bun run gen:herdr-types`",
    "   (then `bun run gen:herdr-fixtures` against a live candidate server).",
    "3. Walk the bump-PR checklist in `.claude/rules/herdr-version-bump.md` and extend its",
    "   learnings table with what this version taught us.",
    "",
  );

  return lines.join("\n");
}
