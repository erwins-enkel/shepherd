import type {
  MergeMethod,
  UpNextPr,
  UpNextPrAction,
  UpNextPrBand,
  UpNextPrBlockReason,
} from "#lib/types.js";

/** Band order on screen, and the tone each band is tinted with. */
const PR_BANDS: readonly UpNextPrBand[] = ["ready", "review", "blocked", "dependabot"];
export const PR_BAND_TONE: Record<UpNextPrBand, string> = {
  ready: "var(--color-green)",
  review: "var(--color-data-2)",
  blocked: "var(--color-warn)",
  dependabot: "var(--color-blue)",
};

/** The non-empty bands in screen order; each keeps the server's row order. */
export function prBandGroups(prs: UpNextPr[]): { band: UpNextPrBand; items: UpNextPr[] }[] {
  return PR_BANDS.map((band) => ({ band, items: prs.filter((pr) => pr.band === band) })).filter(
    (g) => g.items.length > 0,
  );
}

/** The green lens badge: PRs that can merge right now. */
export function readyPrCount(prs: UpNextPr[] | undefined): number {
  return (prs ?? []).filter((pr) => pr.band === "ready" && pr.action === "merge").length;
}

/** The action a row's single button shows — its band's, disabled, while `action` is null. A
 *  Dependabot PR whose merge just failed (`mergeFailed`) offers a rebase instead. */
export function buttonAction(pr: UpNextPr, mergeFailed = false): UpNextPrAction {
  if (mergeFailed && pr.kind === "dependabot" && pr.action === "merge") return "dependabot_rebase";
  if (pr.action) return pr.action;
  if (pr.band === "review") return "review";
  return pr.band === "blocked" ? "fix" : "merge";
}

/** The methods a PR's Merge ▾ menu lists, or null when it offers none: the repo did not say what
 *  it allows, or allows nothing beyond the default a plain Merge already uses. */
export function mergeMethodChoices(pr: UpNextPr): MergeMethod[] | null {
  const allowed = pr.allowedMergeMethods;
  return allowed?.some((method) => method !== pr.mergeMethod) ? allowed : null;
}

/** Why a PR cannot merge right now, or null when merging is its next action. */
export type MergeBlock = UpNextPrBlockReason | "review" | "ci_running" | "mergeability";
export function mergeBlock(pr: UpNextPr): MergeBlock | null {
  if (pr.action === "merge") return null;
  if (pr.blockReason) return pr.blockReason;
  if (pr.action === "review") return "review";
  if (pr.mergeable === null && pr.checks !== "pending") return "mergeability";
  return "ci_running";
}

/** The CI word a row shows. `none` is "no CI" only once the server settled the row (a repo
 *  without CI); while the row waits it reads as running. */
export function ciShown(pr: UpNextPr): "green" | "red" | "running" | "none" {
  if (pr.checks === "success") return "green";
  if (pr.checks === "failure") return "red";
  if (pr.checks === "pending" || pr.action === null) return "running";
  return "none";
}

/** The chip-rail repo filter, applied to PR rows like the issue sections. */
export function prsInRepos(prs: UpNextPr[], repos: ReadonlySet<string>): UpNextPr[] {
  return repos.size === 0 ? prs : prs.filter((pr) => repos.has(pr.repoPath));
}
