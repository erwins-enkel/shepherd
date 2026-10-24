/**
 * #3245: a ticket can live in repo A while its code belongs in repo B. The issue body declares
 * that with a `Target repo: owner/name` line; Shepherd then starts the session (worktree, PR,
 * critic, merge train) in B while the issue — and its claim and close — stay in A.
 *
 * A routed session keeps `issueNumber` NULL (so every consumer keyed on `repoPath`+`issueNumber`
 * no-ops instead of acting on B's tracker with A's number) and carries the link in
 * `homeIssueRepoPath`/`homeIssueNumber`. {@link sessionIssue} is the one place that reads both.
 */
import type { GitForge } from "./forge/types";
import type { Session } from "./types";
import { stripUntrustedFences } from "./untrusted";

/** Line-anchored; tolerates markdown decoration (`**Target repo:** \`org/B\``). */
const MARKER_RE =
  /^[\s>*_-]*target[ -]repo[*_]*\s*:[*_]*\s*[`*_]*([A-Za-z0-9][\w.-]*\/[\w.-]+?)[`*_]*\s*$/im;

/** The `owner/name` a ticket body targets, or null when it declares none. First marker wins.
 *  Untrusted fenced spans are stripped first: only trusted text may route a ticket (#3325). */
export function parseTargetRepo(body: string | null | undefined): string | null {
  if (!body) return null;
  return stripUntrustedFences(body).match(MARKER_RE)?.[1] ?? null;
}

export type TargetRepoResolution =
  { kind: "self" } | { kind: "routed"; repoPath: string } | { kind: "unregistered" };

export interface TargetRepoDeps {
  /** Registered repo dirs (`listRepos(config.repoRoot)` paths). */
  listRepoPaths: () => string[];
  resolveForge: (repoPath: string) => Pick<GitForge, "slug"> | null;
}

const sameSlug = (a: string | null | undefined, b: string): boolean =>
  !!a && a.toLowerCase() === b.toLowerCase();

/** Where a ticket filed in `homeRepoPath` targeting `slug` must run. `self` when the slug is the
 *  home repo's own (fork mode: its upstream slug), `routed` to the first registered repo whose
 *  forge slug matches, else `unregistered` — the caller refuses to start it. */
export function resolveTargetRepo(
  slug: string,
  homeRepoPath: string,
  deps: TargetRepoDeps,
): TargetRepoResolution {
  if (sameSlug(deps.resolveForge(homeRepoPath)?.slug, slug)) return { kind: "self" };
  for (const repoPath of deps.listRepoPaths()) {
    if (repoPath === homeRepoPath) continue;
    if (sameSlug(deps.resolveForge(repoPath)?.slug, slug)) return { kind: "routed", repoPath };
  }
  return { kind: "unregistered" };
}

/** The issue a session works on: the routed home pair when set, else its own repo's issue. */
export function sessionIssue(
  s: Pick<Session, "repoPath" | "issueNumber" | "homeIssueRepoPath" | "homeIssueNumber">,
): { repoPath: string; number: number } | null {
  if (s.homeIssueRepoPath && s.homeIssueNumber != null) {
    return { repoPath: s.homeIssueRepoPath, number: s.homeIssueNumber };
  }
  return s.issueNumber == null ? null : { repoPath: s.repoPath, number: s.issueNumber };
}

/** Prompt directive for a routed session: where its issue lives and how its PR closes it. */
export function routedIssueDirective(homeSlug: string, issueNumber: number): string {
  return [
    `This ticket's issue lives in ${homeSlug}#${issueNumber}, but its code belongs in THIS repository.`,
    `Open your one pull request here, and put \`Closes ${homeSlug}#${issueNumber}\` in its body.`,
    `Do not open a pull request in ${homeSlug} for this ticket.`,
  ].join(" ");
}

/** True when `body` declares a target repo other than `ownSlug` (null ownSlug: any marker). */
export function targetsOtherRepo(body: string | null | undefined, ownSlug: string | null): boolean {
  const slug = parseTargetRepo(body);
  return slug !== null && !sameSlug(ownSlug, slug);
}

/** The target `owner/name` when `body` names a repo other than `ownSlug`, else null. Unknown
 *  `ownSlug` (no forge identity) never counts as misrouted. */
export function misroutedTargetFor(
  body: string | null | undefined,
  ownSlug: string | null,
): string | null {
  return ownSlug && targetsOtherRepo(body, ownSlug) ? parseTargetRepo(body) : null;
}
