// Up Next PRs — pure classification of the open PRs that wait on the operator into one band and
// exactly one next action per row. NO I/O: the service (src/up-next.ts) feeds in each repo's open
// PRs from the shared open-PR snapshot (the Backlog PRs tab's query). The ONE source of this
// decision for every client — the web UI and the iOS app render `band`/`action` as given.
//
// Classification, first match wins (excluded rows return null):
//   1. workflow run awaiting approval        → blocked    / approve_on_forge  (workflow_approval)
//   2. Dependabot with conflicts or behind   → dependabot / dependabot_rebase (conflict | behind)
//   3. conflicts                             → blocked    / fix               (conflict)
//   4. red CI                                → blocked    / fix               (ci_failed)
//   5. behind its base                       → blocked    / fix               (behind)
//   6. Dependabot                            → dependabot / merge
//   7. foreign author, approved              → ready      / merge
//   8. foreign author, no review / commented → review     / review
//   9. the operator's own PR                 → ready      / merge
// A merge/review action is null while CI runs or mergeability is still computing: the row keeps
// its band, sorts to the band's end and its button is disabled.
import type {
  ChecksState,
  MergeMethod,
  MergeStateStatus,
  PrReview,
  PullRequest,
  WorkflowJob,
} from "./forge/types";
import type { PrKind } from "./forge/pr-kind";
import type { Session } from "./types";
import { checksCleared } from "./checks-gate";
import { isConflicting } from "./pr-conflict";
import { hiddenByRule, type IssueFilterSettings, type IssueFilterSubject } from "./issue-filter";

export type UpNextPrBand = "ready" | "review" | "blocked" | "dependabot";
export type UpNextPrAction = "merge" | "review" | "fix" | "dependabot_rebase" | "approve_on_forge";
export type UpNextPrBlockReason = "conflict" | "behind" | "ci_failed" | "workflow_approval";

/** One open PR waiting on the operator. Field names are a contract with the iOS client. */
export interface UpNextPr {
  repoPath: string;
  repoSlug: string | null;
  repoLabel: string;
  number: number;
  title: string;
  url: string;
  author: string;
  kind: PrKind;
  createdAt: number;
  checks: ChecksState;
  mergeable: boolean | null;
  mergeStateStatus?: MergeStateStatus;
  latestReview?: PrReview;
  awaitingWorkflowApproval?: boolean;
  baseRefName?: string;
  mergeMethod?: MergeMethod;
  /** The lowest-numbered issue this PR would close. */
  closesIssue?: number;
  band: UpNextPrBand;
  /** null = CI still running or mergeability still computing: the button is disabled. */
  action: UpNextPrAction | null;
  blockReason?: UpNextPrBlockReason;
  /** Head branch — a fix session cuts its scratch branch from it and pushes back to it. */
  headRefName?: string;
  /** Head commit the merge confirmation binds to. */
  headSha?: string;
  /** Per-check breakdown of the head commit (the preview's CI expander). */
  jobs?: WorkflowJob[];
}

export type UpNextPrClass = Pick<UpNextPr, "band" | "action" | "blockReason">;

/** The facts about the operator and the repo that classification reads. */
export interface UpNextPrContext {
  /** The operator's forge login; null = unknown, every PR then reads as their own. */
  viewer: string | null;
  /** The repo runs no CI on PRs, so `checks: "none"` is terminal (src/checks-gate.ts). */
  noCi: boolean;
}

export function classifyUpNextPr(pr: PullRequest, ctx: UpNextPrContext): UpNextPrClass | null {
  if (pr.isDraft || pr.kind === "release") return null;
  const blocked = blockedClass(pr);
  return blocked === undefined ? waitingClass(pr, ctx) : blocked;
}

/** Rules 1–5: what keeps the PR from merging, and the action that clears it; undefined when
 *  nothing blocks it, null when the block isn't the operator's to clear. A fix pushes to the
 *  head, so it is offered only for a head known to be pushable (PullRequest.headPushable): a
 *  fork's branch or the default branch leaves the list, an unknown one keeps the fix locked. */
function blockedClass(pr: PullRequest): UpNextPrClass | null | undefined {
  const conflict = isConflicting(pr);
  const behind = pr.mergeStateStatus === "behind";
  if (pr.awaitingWorkflowApproval)
    return { band: "blocked", action: "approve_on_forge", blockReason: "workflow_approval" };
  if (pr.kind === "dependabot" && (conflict || behind))
    return {
      band: "dependabot",
      action: "dependabot_rebase",
      blockReason: conflict ? "conflict" : "behind",
    };
  const red = pr.checks === "failure";
  if (!conflict && !red && !behind) return undefined;
  if (pr.headPushable === false) return null; // the contributor's to fix
  const action = pr.headPushable ? "fix" : null;
  if (conflict) return { band: "blocked", action, blockReason: "conflict" };
  if (red) return { band: "blocked", action, blockReason: "ci_failed" };
  return { band: "blocked", action, blockReason: "behind" };
}

/** Rules 6–9 for an unblocked PR: whose move it is — null when it waits on someone else. */
function waitingClass(pr: PullRequest, ctx: UpNextPrContext): UpNextPrClass | null {
  const ciGreen = checksCleared(pr.checks, ctx.noCi);
  const mergeReady = ciGreen && pr.mergeable === true;
  if (pr.kind === "dependabot") return { band: "dependabot", action: mergeReady ? "merge" : null };
  const review = pr.latestReview?.state;
  if (review === "changes_requested") return null; // the author owes the next move
  const mine = ctx.viewer == null || pr.author === ctx.viewer;
  if (!mine && review !== "approved") return { band: "review", action: ciGreen ? "review" : null };
  // Green and mergeable, yet the forge still blocks it: a required review from someone else.
  if (mergeReady && pr.mergeStateStatus === "blocked") return null;
  return { band: "ready", action: mergeReady ? "merge" : null };
}

/** One repo's PR input — structurally a subset of up-next-core's RepoInput. */
export interface UpNextPrRepo {
  repoPath: string;
  repoSlug: string | null;
  repoLabel: string;
  viewer: string | null;
  isFork: boolean;
  /** Open PRs (the Backlog PRs tab's rows); absent when the repo's PR listing failed. */
  openPrs?: PullRequest[];
  /** PR number → the lowest issue number it would close. */
  closingIssueByPr?: Record<number, number>;
  noCi?: boolean;
}

/** What the repo's non-archived sessions hold: their head branches and merge-train PR numbers. */
export interface UpNextPrsInFlight {
  heads: ReadonlySet<string>;
  numbers: ReadonlySet<number>;
}

/** What each repo's non-archived sessions hold, keyed by the sessions' `repoPath`: their own
 *  branches, the head a fix session (`landingRepair`) pushes back to, and merge-train PRs. Those
 *  PRs stand in the Herd, so Up Next leaves them out. */
export function prsHeldBySessions(
  sessions: readonly Pick<
    Session,
    "repoPath" | "branch" | "baseBranch" | "landingRepair" | "mergeTrainPrs"
  >[],
): Map<string, { heads: Set<string>; numbers: Set<number> }> {
  const held = new Map<string, { heads: Set<string>; numbers: Set<number> }>();
  for (const s of sessions) {
    let entry = held.get(s.repoPath);
    if (!entry) held.set(s.repoPath, (entry = { heads: new Set(), numbers: new Set() }));
    if (s.branch) entry.heads.add(s.branch);
    if (s.landingRepair) entry.heads.add(s.baseBranch);
    for (const n of s.mergeTrainPrs ?? []) entry.numbers.add(n);
  }
  return held;
}

type PrFilter = Pick<IssueFilterSettings, "scope" | "forks" | "hiddenLabels"> &
  Partial<Pick<IssueFilterSettings, "repoOverrides">>;

const BAND_RANK: Record<UpNextPrBand, number> = { ready: 0, review: 1, blocked: 2, dependabot: 3 };

/** The issue filter's subject for a PR. Rows carry no labels or assignees, so scope reads the
 *  author; a Dependabot PR is repo upkeep and counts as the operator's own. */
function filterSubject(pr: PullRequest, viewer: string | null): IssueFilterSubject {
  return {
    assignees: [],
    author: pr.kind === "dependabot" && viewer != null ? viewer : pr.author,
    labels: [],
  };
}

function inFlight(pr: PullRequest, held: UpNextPrsInFlight | undefined): boolean {
  if (!held) return false;
  return held.numbers.has(pr.number) || (!!pr.headRefName && held.heads.has(pr.headRefName));
}

function toRow(repo: UpNextPrRepo, pr: PullRequest, cls: UpNextPrClass): UpNextPr {
  return {
    repoPath: repo.repoPath,
    repoSlug: repo.repoSlug,
    repoLabel: repo.repoLabel,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    kind: pr.kind,
    createdAt: pr.createdAt,
    checks: pr.checks,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    latestReview: pr.latestReview,
    awaitingWorkflowApproval: pr.awaitingWorkflowApproval,
    baseRefName: pr.baseRefName,
    mergeMethod: pr.mergeMethod,
    closesIssue: repo.closingIssueByPr?.[pr.number],
    ...cls,
    headRefName: pr.headRefName,
    headSha: pr.headSha,
    jobs: pr.jobs,
  };
}

/** Every repo's waiting PRs: filtered (issue filter, live sessions), classified and ordered by band
 *  → actionable before CI-running → newest first. `filter.repoOverrides` must be keyed by the raw
 *  `repoPath` the repos carry. */
export function buildUpNextPrs(
  repos: UpNextPrRepo[],
  filter: PrFilter,
  heldBy: (repoPath: string) => UpNextPrsInFlight | undefined,
): UpNextPr[] {
  const rows: UpNextPr[] = [];
  for (const repo of repos) {
    const held = heldBy(repo.repoPath);
    const override = filter.repoOverrides?.[repo.repoPath];
    const ctx = { viewer: repo.viewer, isFork: repo.isFork, override };
    for (const pr of repo.openPrs ?? []) {
      if (inFlight(pr, held)) continue;
      if (hiddenByRule(filterSubject(pr, repo.viewer), ctx, filter) !== null) continue;
      const cls = classifyUpNextPr(pr, { viewer: repo.viewer, noCi: !!repo.noCi });
      if (cls) rows.push(toRow(repo, pr, cls));
    }
  }
  return rows.sort(
    (a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band] ||
      Number(a.action === null) - Number(b.action === null) ||
      b.createdAt - a.createdAt ||
      b.number - a.number,
  );
}

/** The task prompt for a fix session (POST /api/up-next/pr-fix): it works in a scratch branch cut
 *  from the PR's head and publishes by pushing back to that head, like an epic landing repair
 *  (src/drain.ts ciRepairPrompt). Names every applicable fact, not just the row's blockReason.
 *  Agent-facing text, so fixed English. */
export function prFixPrompt(pr: UpNextPr, base: string, steer?: string): string {
  const head = pr.headRefName ?? "";
  const conflict = isConflicting(pr);
  const behind = pr.mergeStateStatus === "behind";
  const rebase = conflict || behind;
  const red = (pr.jobs ?? []).filter((j) => j.state === "failure");
  const lines = [
    `Fix pull request #${pr.number} ("${pr.title}") in ${pr.repoSlug ?? pr.repoLabel} ` +
      `(${pr.url}) so it can merge again. You are working in a scratch branch cut from its ` +
      `head branch \`${head}\`, which targets \`${base}\`.`,
  ];
  if (conflict) lines.push(`- It has merge conflicts with \`${base}\`.`);
  else if (behind) lines.push(`- It is behind \`${base}\`.`);
  if (rebase)
    lines.push(
      `- Rebase onto the latest base (\`git fetch origin ${base} && git rebase origin/${base}\`) ` +
        `and resolve any conflicts.`,
    );
  if (pr.checks === "failure") {
    lines.push("- Its CI is red. Find the cause and fix it.");
    if (red.length > 0)
      lines.push(
        `Red checks:\n${red.map((j) => `- ${j.name}${j.url ? ` (${j.url})` : ""}`).join("\n")}`,
      );
  }
  lines.push(
    "Run the repo's own checks and commit. Then publish to the pull request's branch with " +
      (rebase
        ? `\`git push --force-with-lease origin HEAD:${head}\` (the rebase rewrote its history).`
        : `\`git push origin HEAD:${head}\`.`),
    "Do NOT open a new pull request — pushing to the branch updates this one.",
  );
  const task = lines.join("\n");
  const instruction = steer?.trim();
  return instruction ? `Operator instruction:\n${instruction}\n\n${task}` : task;
}
