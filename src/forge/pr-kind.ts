/** The three kinds of open PR the backlog differentiates. A plain code PR
 *  (`regular`), an automated dependency bump (`dependabot`), or a release-please
 *  release PR (`release`). */
export type PrKind = "regular" | "dependabot" | "release";

/** True when `author`'s login is Dependabot. `gh` reports the bot login as
 *  `app/dependabot` (the `--json author` form) or `dependabot[bot]`. Match those
 *  exact forms after stripping a leading `app/` rather than a substring —
 *  `includes("dependabot")` would also catch vanity logins like `dependabot-fan`. */
function isDependabotAuthor(author: string): boolean {
  const login = author.toLowerCase().replace(/^app\//, "");
  return login === "dependabot" || login === "dependabot[bot]";
}

/** release-please marks its PRs three interchangeable ways; any one suffices.
 *  The label and `release-please--` branch are the reliable signals; the title is
 *  a lower-recall fallback, so it must carry a `major.minor` version token to
 *  avoid false-positiving on human chores like `chore: release the docs`. A
 *  release PR with a versionless title (e.g. a manifest release) is still caught
 *  by its label/branch. */
const AUTORELEASE_LABEL = "autorelease: pending";
const RELEASE_BRANCH_PREFIX = "release-please--";
const RELEASE_TITLE_RE = /^chore(\(.+\))?: release\b.*\d+\.\d+/i;

/** Classify an open PR into a {@link PrKind}, the single source of truth shared
 *  by the forge code and the backlog counts. Rules are evaluated in order:
 *  Dependabot author wins first (so a release-ish title on a bump still reads as
 *  a bump), then release-please (autorelease label / `release-please--` head
 *  branch / `chore: release <version>` title), else a regular code PR. `headRefName` and
 *  `labels` are optional. */
export function classifyPr(pr: {
  author: string;
  title: string;
  headRefName?: string;
  labels?: string[];
}): PrKind {
  if (isDependabotAuthor(pr.author)) return "dependabot";

  const hasLabel = (pr.labels ?? []).some((l) => l.toLowerCase() === AUTORELEASE_LABEL);
  const fromBranch = (pr.headRefName ?? "").startsWith(RELEASE_BRANCH_PREFIX);
  const fromTitle = RELEASE_TITLE_RE.test(pr.title);
  if (hasLabel || fromBranch || fromTitle) return "release";

  return "regular";
}
