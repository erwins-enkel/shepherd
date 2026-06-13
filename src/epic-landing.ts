/** Pure title/body builders for the aggregate epic-landing PR (#635, Stage B).
 *  When an epic completes, Shepherd opens ONE PR `epic/<#>-<slug> → <default>` whose
 *  body is the status report and whose `Closes #…` lines close every child + the parent
 *  on a single merge. This is a forge artifact authored by Shepherd, passed verbatim to
 *  GitHub — like `epicBaseDirective` in src/autopilot.ts, Shepherd owns this text and it is
 *  NEVER i18n'd. No forge calls, no store, no I/O — deterministic string building only. */
import type { CompletedEpicChild } from "./completed-epic";

/** `Land epic #<n>: <title>` — concise, stable PR title. */
export function buildLandingPrTitle(parentNumber: number, parentTitle: string): string {
  return `Land epic #${parentNumber}: ${parentTitle}`;
}

/** Sanitize a child title for a single Markdown table cell: escape pipes (a raw `|` would
 *  add a spurious column and corrupt the row) and collapse any newlines to spaces (a row
 *  must stay single-line). Minimal — only the two characters that break a table row. */
function cellSafe(title: string): string {
  return title.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

export function buildLandingPrBody(input: {
  parentNumber: number;
  parentTitle: string;
  integrationBranch: string;
  defaultBranch: string;
  children: Pick<CompletedEpicChild, "number" | "title" | "prNumber" | "prUrl">[];
}): string {
  const { parentNumber, parentTitle, integrationBranch, defaultBranch, children } = input;

  // Parent first, then one Closes line per child in array order — a single merge closes all.
  const closes = [`Closes #${parentNumber}`, ...children.map((c) => `Closes #${c.number}`)].join(
    "\n",
  );

  const rows = children
    .map((c) => {
      const pr = c.prNumber != null ? `#${c.prNumber}` : "—";
      return `| #${c.number} | ${cellSafe(c.title)} | ${pr} |`;
    })
    .join("\n");

  // N derives from the array — single source of truth, never a separate count.
  // Header stays even with zero rows; `rows` is appended only when non-empty.
  const tableHeader = `### Children (${children.length})\n\n| Issue | Title | PR |\n| ----- | ----- | -- |`;
  const childrenSection = rows ? `${tableHeader}\n${rows}` : tableHeader;

  return (
    `Lands epic **#${parentNumber} — ${parentTitle}** from \`${integrationBranch}\` onto \`${defaultBranch}\`.\n\n` +
    `${closes}\n\n` +
    `${childrenSection}\n`
  );
}
