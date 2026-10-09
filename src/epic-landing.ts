/** Pure title/body builders for the aggregate epic-landing PR (#635, Stage B).
 *  When an epic completes, Shepherd opens ONE PR `epic/<#>-<slug> → <default>` whose
 *  body is the status report and whose `Closes #…` lines close every child + the parent
 *  on a single merge. This is a forge artifact authored by Shepherd, passed verbatim to
 *  GitHub — like `epicBaseDirective` in src/autopilot.ts, Shepherd owns this text and it is
 *  NEVER i18n'd. No forge calls, no store, no I/O — deterministic string building only. */
import type { CompletedEpicChild } from "./completed-epic";

/** Conventional-commit types release-please recognizes at column 0 of a merge subject.
 *  A subject NOT starting with one of these (a bare title, or a non-type `Word:` prefix) is
 *  skipped by release-please — the bug this builder exists to avoid (#1206). Same set/spirit
 *  as the type guard in `isDocRelevantMerge` (src/doc-agent.ts). */
const RELEASE_TYPES = new Set([
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
]);

/** Type used when the parent epic title carries no recognized conventional prefix. A landed
 *  epic is almost always shipped feature work, so `feat` gives release-please a changelog
 *  entry rather than letting the merge fall through unrecognized (#1206). */
const FALLBACK_TYPE = "feat";

/** `.github/workflows/pr-title.yml` lints this title with the repo's commitlint config, whose
 *  `header-max-length` (from `@commitlint/config-conventional`) rejects anything longer — counted
 *  as JS `.length`, i.e. UTF-16 code units. An over-long landing title never goes green, and no
 *  repair agent can fix it: they push commits, not titles (#2871). */
const MAX_TITLE_LENGTH = 100;

/** Lowercase the first character of a subject. `.github/workflows/pr-title.yml` lints this very
 *  title with the repo's commitlint config, whose `subject-case` rule (never sentence-case /
 *  start-case / pascal-case / upper-case) rejects a subject starting with an uppercase letter —
 *  that single character is the whole invariant (#2021). A non-letter lead (digit, backtick,
 *  paren) already passes, and `toLowerCase` is a no-op there. */
function lowerFirst(subject: string): string {
  return subject.charAt(0).toLowerCase() + subject.slice(1);
}

/** Fit a description into `budget` code units, marking a cut with `…` (one code unit). Prefer the
 *  last word boundary unless that would throw away more than half the budget; a hard cut never
 *  leaves the high half of a surrogate pair dangling. A description that fits is returned as-is. */
function fitDescription(desc: string, budget: number): string {
  if (desc.length <= budget) return desc;
  let cut = desc.slice(0, budget - 1);
  const space = cut.lastIndexOf(" ");
  if (space >= budget / 2) cut = cut.slice(0, space);
  else if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Landing-PR title that doubles as the squash-merge **subject** release-please parses, so it
 *  MUST lead with a recognized conventional `type(scope)!?:` at column 0 (#1206 — a subject
 *  led by `Land epic #<n>:` pushes the real type mid-line and release-please skips the merge).
 *  The epic framing moves to a trailing `(epic #<n>)`; GitHub appends ` (#<PR>)` at merge.
 *
 *  - Parent title already conventional with a recognized type → keep it (type lowercased,
 *    scope/`!` verbatim), append ` (epic #<n>)`.
 *  - A bare non-type `Word:` prefix (e.g. `native: …`) → it becomes the scope of the fallback
 *    type, lowercased: `feat(native): …` rather than a doubled `feat: native: …` (#2871). A
 *    non-type word that already carries a `(scope)` or `!` falls through to the bare branch.
 *  - Bare title → prepend `feat:`.
 *  A trailing `[EPIC]`/`[epic]` tag and a leading `Epic:` — the prefix Shepherd's own epic
 *  authoring produces — are stripped either way. The description is then lowercase-initial in
 *  EVERY branch so the `pr title` gate stays green (#2021; see `lowerFirst`), and shortened with
 *  `…` so the whole title fits `MAX_TITLE_LENGTH` (#2871; see `fitDescription`) — a title that
 *  already fits is untouched. A title that is nothing but the tag leaves no description, hence
 *  the guard on the return. */
export function buildLandingPrTitle(parentNumber: number, parentTitle: string): string {
  // `epic` is not in RELEASE_TYPES, so stripping the leading tag can never clobber a real type.
  const cleaned = parentTitle
    .trim()
    .replace(/\s*\[epic\]\s*$/i, "")
    .replace(/^epic\s*:\s*/i, "");
  const epicTag = `(epic #${parentNumber})`;

  const m = /^(\w+)(\([^)]*\))?(!)?:\s*(.*)$/.exec(cleaned);
  let prefix = FALLBACK_TYPE;
  let rawDesc = cleaned;
  if (m && RELEASE_TYPES.has(m[1]!.toLowerCase())) {
    prefix = `${m[1]!.toLowerCase()}${m[2] ?? ""}${m[3] ?? ""}`;
    rawDesc = m[4]!;
  } else if (m && !m[2] && !m[3]) {
    prefix = `${FALLBACK_TYPE}(${m[1]!.toLowerCase()})`;
    rawDesc = m[4]!;
  }

  const desc = lowerFirst(rawDesc.trim());
  if (!desc) return `${prefix}: epic #${parentNumber}`;
  // Only the description gives way: the type at column 0 (#1206) and the epic tag both stay.
  const budget = MAX_TITLE_LENGTH - prefix.length - ": ".length - " ".length - epicTag.length;
  return `${prefix}: ${fitDescription(desc, budget)} ${epicTag}`;
}

/** Sanitize a child title for a single Markdown table cell: collapse newlines to spaces (a
 *  row must stay single-line), then escape backslashes BEFORE pipes so a title like `a\|b`
 *  can't defeat the pipe-escape (escaping `|` first would leave a preceding `\` unescaped,
 *  rendering as escaped-backslash + a bare delimiter and adding a spurious column). Minimal
 *  — only what breaks a table row. */
function cellSafe(title: string): string {
  return title.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
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
