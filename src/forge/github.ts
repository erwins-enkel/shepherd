import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "../instrument";
import { mapBounded } from "../map-bounded";
import {
  jobsFromRollup,
  mapCheckState,
  mapStatusState,
  rollupChecks,
  runningCheckNames,
} from "./checks";
import { classifyPr } from "./pr-kind";
import { labelColorsFrom } from "./labels";
import {
  graphRateLimit,
  isGraphqlBucketCall,
  isRateLimitError,
  parseRetryAfter,
} from "./rate-limit";
import { CRITIC_REVIEW_MARKER, EmptyDiffError } from "./types";
import type {
  ChecksState,
  CiStatus,
  ForgeConfig,
  GitForge,
  Issue,
  IssueComment,
  LinkedPr,
  MergeInput,
  MergeMethod,
  MergeStateStatus,
  OpenPrInput,
  OpenPrSnapshot,
  PostReviewInput,
  PrComment,
  PrReviewerState,
  PrReviewMeta,
  PrStatus,
  PullRequest,
  RedeployInput,
  RepoCounts,
  RollupEntry,
  SubIssueRef,
  WorkflowJob,
  WorkflowRun,
} from "./types";

/** Cap on distinct workflows fetched per repo: each kept run costs one extra
 *  `gh run view` subprocess, so bound the fan-out. */
const MAX_WORKFLOWS = 10;
const REST_PAGE_SIZE = 100;
const REST_LIST_CAP = 200;
const REST_PAGE_CAP = 10;
const MAX_CHECK_RUN_PAGES = 2;
const REST_CHECK_CACHE_TTL_MS = 60_000;
const REST_CHECK_LOOKUP_BUDGET = 40;
const GRAPHQL_PR_REVIEW_STATES: Record<string, PrReviewMeta["state"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

/** `gh pr create` on an empty diff prints "No commits between <base> and <head>" to stderr.
 *  Match that case-insensitively to classify an openPr failure as an EmptyDiffError. */
function isNoCommitsBetween(text: string): boolean {
  return text.toLowerCase().includes("no commits between");
}

function mapGraphqlPrReviewState(state: string | null | undefined): PrReviewMeta["state"] {
  return GRAPHQL_PR_REVIEW_STATES[(state ?? "").toUpperCase()] ?? "none";
}

/** Cap on summary pages for listSubIssueSummaries: 2 pages × 100 issues = ~200 issues,
 *  mirroring the listIssues() 200-open-issue cap. */
const MAX_SUMMARY_PAGES = 2;

/** Parse one page of the sub-issue-summary GraphQL response: record every node with
 *  total > 0 into `intoSummaries` (keyed by issue number), add every node with a non-null
 *  parent to `intoSubIssues` and into `intoChildrenByParent` (keyed by parent number), and
 *  return the page's cursor info. */
function collectSubIssueSummaryPage(
  out: string,
  intoSummaries: Map<number, { total: number; completed: number }>,
  intoSubIssues: Set<number>,
  intoChildrenByParent: Map<number, number[]>,
): { hasNextPage: boolean; endCursor: string | null } {
  const json = JSON.parse(out) as {
    data?: {
      repository?: {
        issues?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            number: number;
            subIssuesSummary?: { total: number; completed: number };
            parent?: { number: number } | null;
          } | null>;
        };
      };
    };
  };
  const issues = json.data?.repository?.issues;
  for (const node of issues?.nodes ?? []) {
    if (!node) continue;
    const s = node.subIssuesSummary;
    if (s && s.total > 0) {
      intoSummaries.set(node.number, { total: s.total, completed: s.completed });
    }
    if (node.parent != null) {
      intoSubIssues.add(node.number);
      const siblings = intoChildrenByParent.get(node.parent.number) ?? [];
      siblings.push(node.number);
      intoChildrenByParent.set(node.parent.number, siblings);
    }
  }
  return {
    hasNextPage: issues?.pageInfo?.hasNextPage ?? false,
    endCursor: issues?.pageInfo?.endCursor ?? null,
  };
}

/** Parse one page of the open-PR closingIssuesReferences GraphQL response: for every open PR,
 *  push its {prNumber, author} onto each issue number it would close (keyed by that issue
 *  number in `into`), and return the page's cursor info. The numbers-only
 *  `listOpenPrClosingIssues` derives its result from `into.keys()`. */
function collectLinkedIssuesPage(
  out: string,
  into: Map<number, LinkedPr[]>,
): { hasNextPage: boolean; endCursor: string | null } {
  const json = JSON.parse(out || "{}") as {
    data?: {
      repository?: {
        pullRequests?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            number?: number;
            author?: { login?: string } | null;
            closingIssuesReferences?: { nodes?: Array<{ number?: number }> };
          }>;
        };
      };
    };
  };
  const prs = json.data?.repository?.pullRequests;
  for (const n of prs?.nodes ?? []) {
    if (typeof n.number !== "number") continue;
    const author = n.author?.login ?? "";
    for (const ref of n.closingIssuesReferences?.nodes ?? [])
      if (typeof ref.number === "number") {
        const linked = into.get(ref.number) ?? [];
        linked.push({ prNumber: n.number, author });
        into.set(ref.number, linked);
      }
  }
  return {
    hasNextPage: prs?.pageInfo?.hasNextPage ?? false,
    endCursor: prs?.pageInfo?.endCursor ?? null,
  };
}

/** Parse one page of the batched issue-dependency GraphQL response: for every OPEN issue node
 *  with >=1 still-OPEN blocker, record its open-blocker numbers into `into` (keyed by the
 *  blocked issue's number); issues with no open blockers are skipped, keeping the map small.
 *  Returns the page's cursor info. */
function collectBlockedByOpenPage(
  out: string,
  into: Map<number, number[]>,
): { hasNextPage: boolean; endCursor: string | null } {
  const json = JSON.parse(out || "{}") as {
    data?: {
      repository?: {
        issues?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            number: number;
            blockedBy?: { nodes?: Array<{ number?: number; state?: string }> };
          } | null>;
        };
      };
    };
  };
  const issues = json.data?.repository?.issues;
  for (const node of issues?.nodes ?? []) {
    if (!node) continue;
    const openBlockers = (node.blockedBy?.nodes ?? [])
      .filter((b): b is { number: number; state?: string } => typeof b.number === "number")
      .filter((b) => b.state === "OPEN")
      .map((b) => b.number);
    if (openBlockers.length > 0) into.set(node.number, openBlockers);
  }
  return {
    hasNextPage: issues?.pageInfo?.hasNextPage ?? false,
    endCursor: issues?.pageInfo?.endCursor ?? null,
  };
}

/** Runs `gh` with the given args and returns stdout. Injected in tests. */
export type GhRunner = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultRunner: GhRunner = (args) =>
  timedAsync(`gh ${args[0]}`, async () => {
    try {
      const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
      return stdout.toString();
    } catch (err) {
      // Detect GraphQL rate-limit errors and record them in the shared backoff
      // state so pollers can pause before the next request. The error is always
      // re-thrown so existing caller behaviour is unchanged.
      if (isGraphqlBucketCall(args) && isRateLimitError(err)) {
        graphRateLimit.noteLimitError(
          parseRetryAfter(String((err as Record<string, unknown>)?.stderr ?? "")),
        );
      }
      throw err;
    }
  });

export interface GhReview {
  author?: { login?: string } | null;
  state?: string | null; // APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED
  body?: string | null;
  submittedAt?: string | null;
}

const REVIEW_STATE: Record<string, "approved" | "changes_requested" | "commented"> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
};

const REVIEWER_REPLAY_STATE: Record<string, PrReviewerState["state"] | "dismissed"> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** Newest human review (critic-marked + non-terminal states excluded). */
function latestHumanReview(reviews: GhReview[] | undefined): PrStatus["latestReview"] {
  let best: PrStatus["latestReview"];
  let bestTs = -Infinity;
  for (const r of reviews ?? []) {
    const state = REVIEW_STATE[r.state ?? ""];
    if (!state) continue; // skips PENDING / DISMISSED / unknown
    if ((r.body ?? "").includes(CRITIC_REVIEW_MARKER)) continue; // the critic's own review
    const ts = Date.parse(r.submittedAt ?? "");
    if (!Number.isFinite(ts) || ts <= bestTs) continue;
    bestTs = ts;
    best = { state, author: r.author?.login ?? "", submittedAt: ts };
  }
  return best;
}

/** Latest terminal human review state per reviewer. Unlike latestHumanReview(),
 *  this replay treats DISMISSED as a clearing event and keeps COMMENTED neutral. */
export function reviewerStatesFromReviews(
  reviews: GhReview[] | undefined,
): PrStatus["reviewerStates"] {
  if (!reviews) return undefined;
  const states: NonNullable<PrStatus["reviewerStates"]> = {};
  const ordered = [...reviews]
    .map((r) => ({ review: r, ts: Date.parse(r.submittedAt ?? "") }))
    .filter(({ review, ts }) => {
      if (!Number.isFinite(ts)) return false;
      if ((review.body ?? "").includes(CRITIC_REVIEW_MARKER)) return false;
      return !!REVIEWER_REPLAY_STATE[review.state ?? ""];
    })
    .sort((a, b) => a.ts - b.ts);
  for (const { review, ts } of ordered) {
    const author = review.author?.login ?? "";
    if (!author) continue;
    const state = REVIEWER_REPLAY_STATE[review.state ?? ""];
    if (!state) continue;
    if (state === "dismissed") {
      delete states[author];
      continue;
    }
    if (state === "commented" && states[author]?.state === "changes_requested") continue;
    states[author] = { state, latestAt: ts };
  }
  return states;
}

interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  createdAt?: string;
  mergeable?: string; // MERGEABLE | CONFLICTING | UNKNOWN
  mergeStateStatus?: string; // BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE
  isDraft?: boolean;
  statusCheckRollup?: RollupEntry[];
  headRefOid?: string;
  headRefName?: string;
  baseRefName?: string;
  reviews?: GhReview[];
  reviewRequests?: { login?: string }[];
  headRepositoryOwner?: { login?: string };
}

interface RestPull {
  number: number;
  html_url?: string;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  draft?: boolean;
  created_at?: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  user?: { login?: string | null } | null;
  head?: {
    ref?: string;
    sha?: string;
    repo?: { full_name?: string | null; owner?: { login?: string | null } | null } | null;
  } | null;
  base?: { ref?: string | null; repo?: { full_name?: string | null } | null } | null;
  requested_reviewers?: Array<{ login?: string | null }> | null;
}

interface RestIssue {
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  labels?: Array<{ name?: string | null; color?: string | null }> | null;
  created_at?: string;
  author_association?: string | null;
  assignees?: Array<{ login?: string | null }> | null;
  user?: { login?: string | null } | null;
  pull_request?: unknown;
}

interface RestCheckRun {
  status?: string | null;
  conclusion?: string | null;
}

interface RestCheckRunsPage {
  total_count?: number;
  check_runs?: RestCheckRun[];
}

interface RestCombinedStatus {
  state?: string | null;
  statuses?: Array<{ state?: string | null }> | null;
}

interface RestCheckSummary {
  states: ChecksState[];
  incomplete: boolean;
}

function parseCombinedStatus(raw: string): RestCheckSummary {
  try {
    const parsed = JSON.parse(raw || "{}") as RestCombinedStatus;
    const legacyStatuses = parsed.statuses ?? [];
    if (legacyStatuses.length > 0) {
      return { states: legacyStatuses.map((s) => mapStatusState(s.state)), incomplete: false };
    }
    if (parsed.state && parsed.state.toLowerCase() !== "pending") {
      return { states: [mapStatusState(parsed.state)], incomplete: false };
    }
    return { states: [], incomplete: false };
  } catch {
    return { states: [], incomplete: true };
  }
}

function mapMergeable(v: string | undefined): boolean | null {
  if (v === "MERGEABLE") return true;
  if (v === "CONFLICTING") return false;
  return null; // UNKNOWN / undefined
}

/** GitHub StatusState rollup → our CiStatus. Unknown/absent → null. */
function mapRollupState(state: string | undefined | null): CiStatus {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

const MERGE_STATE_VALUES = new Set<string>([
  "behind",
  "blocked",
  "clean",
  "dirty",
  "draft",
  "has_hooks",
  "unknown",
  "unstable",
]);

function mapMergeStateStatus(v: string | undefined): MergeStateStatus | undefined {
  if (!v) return undefined;
  const lower = v.toLowerCase();
  return MERGE_STATE_VALUES.has(lower) ? (lower as MergeStateStatus) : undefined;
}

function worstChecks(states: ChecksState[]): ChecksState {
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  if (states.includes("success")) return "success";
  return "none";
}

/** GitHub forge driven through the `gh` CLI (operator's existing auth). */
export class GithubForge implements GitForge {
  readonly kind = "github" as const;
  readonly mergeMethod: MergeMethod;
  readonly deployWorkflow: string | null;
  /** In fork mode, the owner of the fork (origin) repo — the `<user>` half of
   *  {@link forkSlug}. Used to qualify `pr create --head <forkOwner>:<branch>` and
   *  to disambiguate `prStatus`'s cross-repo match. Undefined for non-fork repos. */
  private readonly forkOwner?: string;
  /** Latch: true once we've emitted the ≥200 open-PR cap warning so it fires at
   *  most once per forge instance (on transition into the capped regime). */
  private openPrCapLogged = false;
  private readonly restCheckCache = new Map<string, { at: number; state: ChecksState }>();
  constructor(
    readonly slug: string,
    private readonly cfg: ForgeConfig,
    private readonly run: GhRunner = defaultRunner,
    /** Fork (origin) slug when the repo is a fork (`slug` = upstream). Drives the
     *  fork-aware PR head qualifier and the `canPush` probe target. */
    private readonly forkSlug?: string,
  ) {
    this.mergeMethod = cfg.mergeMethod ?? "squash";
    this.deployWorkflow = cfg.deployWorkflow ?? null;
    this.forkOwner = forkSlug?.split("/")[0] || undefined;
  }

  get webUrl(): string {
    return `https://github.com/${this.slug}`;
  }

  /** Fork mode = a fork slug was supplied (`slug` is the upstream it forked from). */
  get isFork(): boolean {
    return !!this.forkSlug;
  }

  private restGetArgs(path: string, fields: string[] = []): string[] {
    return ["api", "--method", "GET", path, ...fields.flatMap((f) => ["-f", f])];
  }

  private mapRestIssue(i: RestIssue): Issue {
    const ts = Date.parse(i.created_at ?? "");
    const labelColors = labelColorsFrom(i.labels ?? []);
    return {
      number: i.number,
      title: i.title ?? "",
      body: i.body ?? "",
      url: i.html_url ?? `https://github.com/${this.slug}/issues/${i.number}`,
      labels: (i.labels ?? []).map((l) => l.name).filter((n): n is string => !!n),
      ...(labelColors ? { labelColors } : {}),
      createdAt: Number.isFinite(ts) ? ts : Date.now(),
      assignees: (i.assignees ?? [])
        .map((a) => a.login ?? undefined)
        .filter((login): login is string => !!login),
      author: i.user?.login ?? undefined,
      authorAssociation: i.author_association ?? undefined,
    };
  }

  private mapRestPullToPullRequest(pr: RestPull, checks: ChecksState): PullRequest {
    const ts = Date.parse(pr.created_at ?? "");
    const author = pr.user?.login ?? "";
    const headRefName = pr.head?.ref ?? undefined;
    return {
      number: pr.number,
      title: pr.title ?? "",
      url: pr.html_url ?? `https://github.com/${this.slug}/pull/${pr.number}`,
      author,
      kind: classifyPr({ author, title: pr.title ?? "", headRefName }),
      createdAt: Number.isFinite(ts) ? ts : Date.now(),
      isDraft: pr.draft ?? false,
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeStateStatus: mapMergeStateStatus(pr.mergeable_state ?? undefined),
      checks,
      jobs: [],
      headSha: pr.head?.sha,
      headRefName,
    };
  }

  private async listIssuesRest(): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (let page = 1; page <= REST_PAGE_CAP && issues.length < REST_LIST_CAP; page++) {
      const out = await this.run(
        this.restGetArgs(`repos/${this.slug}/issues`, [
          "state=open",
          `per_page=${REST_PAGE_SIZE}`,
          `page=${page}`,
        ]),
      );
      const rows = JSON.parse(out || "[]") as RestIssue[];
      for (const row of rows) {
        if (row.pull_request != null) continue;
        issues.push(this.mapRestIssue(row));
        if (issues.length >= REST_LIST_CAP) break;
      }
      if (rows.length < REST_PAGE_SIZE) break;
    }
    return issues;
  }

  private async listOpenPullsRest(): Promise<{ prs: RestPull[]; capped: boolean }> {
    const prs: RestPull[] = [];
    let capped = false;
    for (let page = 1; prs.length < REST_LIST_CAP; page++) {
      const out = await this.run(
        this.restGetArgs(`repos/${this.slug}/pulls`, [
          "state=open",
          `per_page=${REST_PAGE_SIZE}`,
          `page=${page}`,
        ]),
      );
      const rows = JSON.parse(out || "[]") as RestPull[];
      prs.push(...rows.slice(0, REST_LIST_CAP - prs.length));
      if (rows.length < REST_PAGE_SIZE) break;
      if (prs.length >= REST_LIST_CAP) capped = true;
    }
    return { prs, capped };
  }

  private async listBacklogCountsRest(): Promise<RepoCounts> {
    const [repoOut, openPrs] = await Promise.all([
      this.run(this.restGetArgs(`repos/${this.slug}`)),
      this.listOpenPullsRest(),
    ]);
    const repo = JSON.parse(repoOut || "{}") as { open_issues_count?: number };
    if (openPrs.capped) {
      return { openIssues: null, openPRs: null, ciStatus: null, prKinds: null };
    }
    const openPRs = openPrs.prs.length;
    const totalIssuesAndPrs = repo.open_issues_count;
    const openIssues =
      typeof totalIssuesAndPrs === "number" ? Math.max(0, totalIssuesAndPrs - openPRs) : null;
    const kinds = openPrs.prs.map((pr) =>
      classifyPr({
        author: pr.user?.login ?? "",
        title: pr.title ?? "",
        headRefName: pr.head?.ref ?? undefined,
      }),
    );
    const release = kinds.filter((k) => k === "release").length;
    const dependabot = kinds.filter((k) => k === "dependabot").length;
    return {
      openIssues,
      openPRs,
      ciStatus: null,
      prKinds: { release, dependabot, regular: Math.max(0, openPRs - release - dependabot) },
    };
  }

  async listBacklogCounts(): Promise<RepoCounts> {
    if (graphRateLimit.blocked()) return this.listBacklogCountsRest();
    const [owner, name] = this.slug.split("/");
    let out: string;
    try {
      out = await this.run([
        "api",
        "graphql",
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-f",
        "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN, first:100){ totalCount nodes{ author{login} title headRefName } } defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}} rateLimit{ remaining resetAt }}",
      ]);
    } catch (err) {
      if (isRateLimitError(err)) return this.listBacklogCountsRest();
      throw err;
    }
    const json = JSON.parse(out) as {
      data?: {
        repository?: {
          issues?: { totalCount?: number };
          pullRequests?: {
            totalCount?: number;
            nodes?: Array<{
              author?: { login?: string } | null;
              title?: string;
              headRefName?: string;
            } | null>;
          };
          defaultBranchRef?: {
            target?: { statusCheckRollup?: { state?: string } | null } | null;
          } | null;
        };
        /** Top-level `rateLimit` selection — tracks GraphQL bucket consumption. */
        rateLimit?: { remaining?: number; resetAt?: string };
      };
    };

    // Feed the rateLimit reading into the shared backoff tracker so we can
    // pause pollers before the bucket empties. Guard against malformed values.
    const rl = json.data?.rateLimit;
    if (typeof rl?.remaining === "number" && typeof rl?.resetAt === "string") {
      const resetAtMs = Date.parse(rl.resetAt);
      if (Number.isFinite(resetAtMs)) {
        graphRateLimit.note({ remaining: rl.remaining, resetAt: resetAtMs });
      }
    }

    const repo = json.data?.repository;
    const issues = repo?.issues?.totalCount;
    const prs = repo?.pullRequests?.totalCount;
    const openPRs = typeof prs === "number" ? prs : null;

    // Open-PR breakdown for the repo-list row. We fetch only the first 100 open
    // PRs (one page — no extra request); each node is classified once. `regular`
    // is derived from the authoritative `totalCount` minus the bot kinds (clamped
    // at 0), NOT by counting "regular" nodes — so a repo with >100 open PRs
    // classifies the first page and its unfetched tail safely falls into
    // `regular` rather than silently vanishing.
    let prKinds: RepoCounts["prKinds"] = null;
    if (openPRs !== null) {
      const kinds = (repo?.pullRequests?.nodes ?? [])
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map((n) =>
          classifyPr({
            author: n.author?.login ?? "",
            title: n.title ?? "",
            headRefName: n.headRefName ?? undefined,
          }),
        );
      const release = kinds.filter((k) => k === "release").length;
      const dependabot = kinds.filter((k) => k === "dependabot").length;
      prKinds = { release, dependabot, regular: Math.max(0, openPRs - release - dependabot) };
    }

    return {
      openIssues: typeof issues === "number" ? issues : null,
      openPRs,
      ciStatus: mapRollupState(repo?.defaultBranchRef?.target?.statusCheckRollup?.state),
      prKinds,
    };
  }

  async listIssues(): Promise<Issue[]> {
    if (graphRateLimit.blocked()) return this.listIssuesRest();
    let out: string;
    try {
      out = await this.run([
        "issue",
        "list",
        "--repo",
        this.slug,
        "--state",
        "open",
        "--json",
        "number,title,body,url,labels,createdAt,assignees,author",
        // Cap matches listPullRequests; the count source (GraphQL totalCount) is
        // unbounded, so a repo with >200 open issues lists a truncated set under a
        // larger count. Raise this or paginate if such repos appear.
        "--limit",
        "200",
      ]);
    } catch (err) {
      if (isRateLimitError(err)) return this.listIssuesRest();
      throw err;
    }
    const raw = JSON.parse(out || "[]") as Array<{
      number: number;
      title: string;
      body?: string;
      url: string;
      labels?: Array<{ name: string; color?: string }>;
      createdAt?: string;
      assignees?: Array<{ login: string }>;
      author?: { login?: string } | null;
    }>;
    return raw.map((i) => {
      const ts = Date.parse(i.createdAt ?? "");
      const labelColors = labelColorsFrom(i.labels ?? []);
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.url,
        labels: (i.labels ?? []).map((l) => l.name),
        ...(labelColors ? { labelColors } : {}),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        assignees: (i.assignees ?? []).map((a) => a.login),
        author: i.author?.login,
      };
    });
  }

  async getIssue(issueNumber: number): Promise<Issue | null> {
    // Fresh, uncached single-issue read for the drain's pre-spawn claim re-check
    // (see GitForge.getIssue). Best-effort: a gone/closed issue or a transient gh
    // error yields null so the caller falls back to spawning, never loses the issue.
    // COST: one `gh api graphql` subprocess per spawn candidate per pump. `this.run`
    // is async (non-blocking) and the drain spawns at most maxAuto per pump, so the
    // fan-out is bounded and small; not worth caching/batching for the claim re-check.
    // GraphQL (not `gh issue view`) so the same call also carries the author's
    // authorAssociation — the autonomous-spawn author trust gate reads it from here.
    if (graphRateLimit.blocked()) return this.getIssueRest(issueNumber);
    try {
      const [owner, repo] = this.slug.split("/");
      const out = await this.run([
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){number title body url createdAt author{login} authorAssociation labels(first:50){nodes{name}} assignees(first:20){nodes{login}}}}}",
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `num=${issueNumber}`,
      ]);
      const i = (
        JSON.parse(out || "null") as {
          data?: {
            repository?: {
              issue?: {
                number: number;
                title: string;
                body?: string;
                url: string;
                createdAt?: string;
                author?: { login?: string } | null;
                authorAssociation?: string | null;
                labels?: { nodes?: Array<{ name: string }> };
                assignees?: { nodes?: Array<{ login: string }> };
              } | null;
            };
          };
        } | null
      )?.data?.repository?.issue;
      if (!i) return null;
      const ts = Date.parse(i.createdAt ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.url,
        labels: (i.labels?.nodes ?? []).map((l) => l.name),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        assignees: (i.assignees?.nodes ?? []).map((a) => a.login),
        author: i.author?.login,
        authorAssociation: i.authorAssociation ?? undefined,
      };
    } catch (err) {
      if (isRateLimitError(err)) return this.getIssueRest(issueNumber);
      return null;
    }
  }

  private async getIssueRest(issueNumber: number): Promise<Issue | null> {
    try {
      const out = await this.run(this.restGetArgs(`repos/${this.slug}/issues/${issueNumber}`));
      const issue = JSON.parse(out || "null") as RestIssue | null;
      if (!issue || issue.pull_request != null) return null;
      return this.mapRestIssue(issue);
    } catch {
      return null;
    }
  }

  async listIssueComments(issueNumber: number): Promise<IssueComment[]> {
    // `gh issue view <n> --json comments` returns the thread oldest-first. authorAssociation
    // rides in the same payload (no extra call) so the spawn filter can scope to repo-standing
    // authors. Parse mirrors listPrComments.
    const out = await this.run([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      this.slug,
      "--json",
      "comments",
    ]);
    const parsed = JSON.parse(out || "{}") as {
      comments?: {
        author?: { login?: string } | null;
        authorAssociation?: string | null;
        body?: string | null;
        createdAt?: string | null;
      }[];
    };
    return (parsed.comments ?? []).map((c) => ({
      author: c.author?.login ?? "",
      authorAssociation: c.authorAssociation ?? "NONE",
      body: c.body ?? "",
      createdAt: c.createdAt ? Date.parse(c.createdAt) : 0,
    }));
  }

  private mapGhPrToPullRequest(
    p: GhPr & { author?: { login?: string } | null; labels?: Array<{ name?: string }> },
    defaultBranch: string | null,
    awaitingApprovalShas: ReadonlySet<string> = new Set(),
  ): PullRequest {
    const ts = Date.parse(p.createdAt ?? "");
    const author = p.author?.login ?? "";
    const labels = (p.labels ?? []).map((l) => l.name).filter((n): n is string => !!n);
    return {
      number: p.number,
      title: p.title,
      url: p.url,
      author,
      kind: classifyPr({ author, title: p.title, headRefName: p.headRefName, labels }),
      createdAt: Number.isFinite(ts) ? ts : Date.now(),
      isDraft: p.isDraft ?? false,
      mergeable: mapMergeable(p.mergeable),
      mergeStateStatus: mapMergeStateStatus(p.mergeStateStatus),
      checks: rollupChecks(p.statusCheckRollup ?? []),
      jobs: jobsFromRollup(p.statusCheckRollup ?? []),
      latestReview: latestHumanReview(p.reviews),
      nonDefaultBase:
        defaultBranch && p.baseRefName && p.baseRefName !== defaultBranch
          ? p.baseRefName
          : undefined,
      headSha: p.headRefOid,
      headRefName: p.headRefName,
      // Undefined (not false) when not awaiting, matching the "absent ⇒ false"
      // convention the field documents and keeping it out of golden equality checks.
      awaitingWorkflowApproval:
        (!!p.headRefOid && awaitingApprovalShas.has(p.headRefOid)) || undefined,
    };
  }

  /** Head SHAs of workflow runs on this repo awaiting manual approval to run
   *  (`gh run list --status action_required`). GitHub does not create the check
   *  runs for such a workflow until it is approved, so this state is invisible to a
   *  PR's `statusCheckRollup` — the run list is the only source. A run's `headSha`
   *  equals the PR's `headRefOid`, so callers flag a PR by set membership.
   *
   *  Scope: only the `action_required` flavor (fork/outside-contributor & Actions
   *  bot). Deployment-environment protection gates surface as `status=waiting` with
   *  a different representation and are intentionally NOT fetched here (a second
   *  REST call), to keep this to one extra REST-bucket request per snapshot.
   *
   *  Fail-quiet: any error or unparseable output degrades to an empty set (no flag),
   *  so the caller's snapshot never fails on this leg. */
  private async awaitingApprovalShas(): Promise<Set<string>> {
    let out: string;
    try {
      out = await this.run([
        "run",
        "list",
        "--repo",
        this.slug,
        "--status",
        "action_required",
        "--limit",
        "100",
        "--json",
        "headSha",
      ]);
    } catch {
      return new Set();
    }
    let raw: Array<{ headSha?: string | null }>;
    try {
      raw = JSON.parse(out || "[]") as Array<{ headSha?: string | null }>;
    } catch {
      return new Set();
    }
    const shas = new Set<string>();
    for (const r of raw) if (r.headSha) shas.add(r.headSha);
    return shas;
  }

  async listPullRequests(): Promise<PullRequest[]> {
    return (await this.listOpenPrSnapshot()).prs;
  }

  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    // Resolve the default branch; CI health is read from its runs, not PR branches.
    // A lookup failure degrades to [] (fail-quiet, matching the other forge readers).
    const branch = await this.defaultBranch().catch(() => null);
    if (!branch) return [];

    const listOut = await this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--limit",
      "50",
      "--json",
      "databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      workflowDatabaseId?: number;
      status?: string | null;
      conclusion?: string | null;
      headSha?: string;
      createdAt?: string;
      url?: string;
    }>;

    // `gh run list` is newest-first, so the first row per workflow is its latest run.
    const newest = new Map<string, (typeof raw)[number]>();
    for (const r of raw) {
      const wf = r.workflowName ?? "";
      if (!newest.has(wf)) newest.set(wf, r);
    }
    const selected = [...newest.values()].slice(0, MAX_WORKFLOWS);

    // Fan out the per-run job fetches in parallel now that `this.run` is async.
    // Serial was the old behaviour (execFileSync); the Promise.all here now truly
    // parallelises the `gh run view` subprocess calls across the selected runs.
    const runs = await Promise.all(
      selected.map(async (r): Promise<WorkflowRun> => {
        const jobs = await this.listRunJobs(r.databaseId);
        const ts = Date.parse(r.createdAt ?? "");
        return {
          runId: r.databaseId,
          workflowId: r.workflowDatabaseId ?? 0,
          workflowName: r.workflowName ?? "",
          runUrl: r.url ?? "",
          headSha: r.headSha ?? "",
          createdAt: Number.isFinite(ts) ? ts : Date.now(),
          state: mapCheckState(r.status, r.conclusion),
          jobs,
        };
      }),
    );

    // Newest workflow first.
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
  }

  /** Per-job breakdown for a single run (`gh run view --json jobs`), mapped to
   *  the four-light CI vocab. Shared by the latest-run listing and history-row
   *  expansion. */
  async listRunJobs(runId: number): Promise<WorkflowJob[]> {
    const jobsOut = await this.run([
      "run",
      "view",
      String(runId),
      "--repo",
      this.slug,
      "--json",
      "jobs",
    ]);
    const parsed = JSON.parse(jobsOut || "{}") as {
      jobs?: Array<{
        name?: string;
        status?: string | null;
        conclusion?: string | null;
        url?: string;
      }>;
    };
    return (parsed.jobs ?? []).map((j) => ({
      name: j.name ?? "",
      state: mapCheckState(j.status, j.conclusion),
      url: j.url || undefined,
    }));
  }

  /** Prior runs of one workflow on the default branch, newest-first, capped by
   *  `limit`. Summary rows only — `jobs` is empty; callers lazy-load per-run
   *  jobs via {@link listRunJobs}. */
  async listWorkflowRunHistory(workflowId: number, o: { limit: number }): Promise<WorkflowRun[]> {
    const branch = await this.defaultBranch().catch(() => null);
    if (!branch) return [];
    const listOut = await this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--workflow",
      String(workflowId),
      "--limit",
      String(o.limit),
      "--json",
      "databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      workflowDatabaseId?: number;
      status?: string | null;
      conclusion?: string | null;
      headSha?: string;
      createdAt?: string;
      url?: string;
    }>;
    const runs = raw.map((r): WorkflowRun => {
      const ts = Date.parse(r.createdAt ?? "");
      return {
        runId: r.databaseId,
        workflowId: r.workflowDatabaseId ?? workflowId,
        workflowName: r.workflowName ?? "",
        runUrl: r.url ?? "",
        headSha: r.headSha ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        state: mapCheckState(r.status, r.conclusion),
        jobs: [],
      };
    });
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
  }

  /** Resolve the PR head's most-recent FAILED workflow run id (for the retry-ci endpoint).
   *  Reads the PR head ref + sha, lists failed runs on that branch newest-first, and prefers the
   *  run matching the PR head sha (the branch may have advanced past the PR head), else the newest
   *  failed run on the branch. Returns null when the PR/branch can't be resolved or has no failed
   *  run. A fork-origin PR's runs live in the fork, not this branch, so it resolves to null. */
  async latestFailedRunForPr(prNumber: number): Promise<number | null> {
    const prOut = await this.run([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.slug,
      "--json",
      "headRefName,headRefOid",
    ]).catch(() => null);
    if (!prOut) return null;
    const pr = JSON.parse(prOut || "{}") as { headRefName?: string; headRefOid?: string };
    const branch = pr.headRefName;
    if (!branch) return null;
    const listOut = await this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--status",
      "failure",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,createdAt",
    ]).catch(() => null);
    if (!listOut) return null;
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      headSha?: string;
      createdAt?: string;
    }>;
    if (raw.length === 0) return null;
    const byNewest = [...raw].sort(
      (a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""),
    );
    const headSha = pr.headRefOid;
    const atHead = headSha ? byNewest.find((r) => r.headSha === headSha) : undefined;
    return (atHead ?? byNewest[0])?.databaseId ?? null;
  }

  async rerunWorkflowRun(runId: number, o: { failedOnly: boolean }): Promise<void> {
    const args = ["run", "rerun", String(runId), "--repo", this.slug];
    // `--failed` retries only the failed jobs (+ their dependents) of a failed run;
    // a fully green run has none, so the caller passes failedOnly:false there.
    if (o.failedOnly) args.push("--failed");
    await this.run(args);
  }

  async cancelWorkflowRun(runId: number): Promise<void> {
    await this.run(["run", "cancel", String(runId), "--repo", this.slug]);
  }

  /** Map a raw GhPr node to a PrStatus. Shared by prStatus (single-PR path) and
   *  listOpenPrStatuses (batch path) so both produce identical field values. */
  private mapGhPr(pr: GhPr, deployConfigured: boolean): PrStatus {
    const state = pr.state.toLowerCase() as PrStatus["state"];
    const createdAt = Date.parse(pr.createdAt ?? "");
    const running = runningCheckNames(pr.statusCheckRollup ?? []);
    return {
      state: state === "open" || state === "merged" || state === "closed" ? state : "none",
      number: pr.number,
      url: pr.url,
      title: pr.title,
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      mergeable: mapMergeable(pr.mergeable),
      mergeStateStatus: mapMergeStateStatus(pr.mergeStateStatus),
      isDraft: pr.isDraft ?? false,
      checks: rollupChecks(pr.statusCheckRollup ?? []),
      runningChecks: running.length ? running : undefined,
      headSha: pr.headRefOid,
      baseRefName: pr.baseRefName,
      latestReview: latestHumanReview(pr.reviews),
      reviewerStates: reviewerStatesFromReviews(pr.reviews),
      requestedReviewers: (pr.reviewRequests ?? [])
        .map((r) => r.login)
        .filter((l): l is string => !!l),
      deployConfigured,
    };
  }

  private async listRestCheckRuns(
    headSha: string,
  ): Promise<{ states: ChecksState[]; incomplete: boolean }> {
    const states: ChecksState[] = [];
    let fetched = 0;
    let total: number | null = null;
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page++) {
      const out = await this.run(
        this.restGetArgs(`repos/${this.slug}/commits/${headSha}/check-runs`, [
          `per_page=${REST_PAGE_SIZE}`,
          `page=${page}`,
        ]),
      );
      const parsed = JSON.parse(out || "{}") as RestCheckRunsPage;
      const runs = parsed.check_runs ?? [];
      if (typeof parsed.total_count === "number") total = parsed.total_count;
      fetched += runs.length;
      for (const run of runs) states.push(mapCheckState(run.status, run.conclusion));
      if (runs.length < REST_PAGE_SIZE) break;
      if (total != null && fetched >= total) break;
    }
    return { states, incomplete: total != null && fetched < total };
  }

  private async restCheckSummaryForHead(headSha?: string): Promise<RestCheckSummary> {
    if (!headSha) return { states: [], incomplete: false };
    const statusPath = `repos/${this.slug}/commits/${headSha}/status`;
    const [statusResult, checksResult] = await Promise.allSettled([
      this.run(["api", statusPath]),
      this.listRestCheckRuns(headSha),
    ]);

    const states: ChecksState[] = [];
    let incomplete = false;
    if (statusResult.status === "fulfilled") {
      const status = parseCombinedStatus(statusResult.value);
      states.push(...status.states);
      incomplete ||= status.incomplete;
    } else {
      incomplete = true;
    }
    if (checksResult.status === "fulfilled") {
      states.push(...checksResult.value.states);
      incomplete ||= checksResult.value.incomplete;
    } else {
      incomplete = true;
    }
    return { states, incomplete };
  }

  private async restChecksForHead(headSha?: string): Promise<ChecksState> {
    try {
      const summary = await this.restCheckSummaryForHead(headSha);
      return summary.incomplete ? "pending" : worstChecks(summary.states);
    } catch {
      return "pending";
    }
  }

  private async restChecksForHeadStrict(headSha?: string): Promise<ChecksState> {
    try {
      const summary = await this.restCheckSummaryForHead(headSha);
      return summary.incomplete ? "pending" : worstChecks(summary.states);
    } catch {
      return "pending";
    }
  }

  private mapRestPull(pr: RestPull, deployConfigured: boolean, checks: ChecksState): PrStatus {
    const state: PrStatus["state"] =
      pr.state === "open" ? "open" : pr.merged_at ? "merged" : "closed";
    const createdAt = Date.parse(pr.created_at ?? "");
    return {
      state,
      number: pr.number,
      url: pr.html_url ?? `https://github.com/${this.slug}/pull/${pr.number}`,
      title: pr.title ?? "",
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeStateStatus: mapMergeStateStatus(pr.mergeable_state ?? undefined),
      isDraft: pr.draft ?? false,
      checks,
      headSha: pr.head?.sha,
      baseRefName: pr.base?.ref ?? undefined,
      requestedReviewers: (pr.requested_reviewers ?? [])
        .map((r) => r.login ?? undefined)
        .filter((login): login is string => !!login),
      deployConfigured,
    };
  }

  private async restChecksForPulls(prs: RestPull[]): Promise<ChecksState[]> {
    const now = Date.now();
    const checks: ChecksState[] = Array.from({ length: prs.length }, () => "none");
    const lookups: Array<{ index: number; sha: string }> = [];
    for (let i = 0; i < prs.length; i++) {
      const sha = prs[i]!.head?.sha;
      if (!sha) continue;
      const cached = this.restCheckCache.get(sha);
      if (cached && now - cached.at < REST_CHECK_CACHE_TTL_MS) {
        checks[i] = cached.state;
        continue;
      }
      if (cached) this.restCheckCache.delete(sha);
      if (lookups.length < REST_CHECK_LOOKUP_BUDGET) {
        lookups.push({ index: i, sha });
      } else {
        checks[i] = "pending";
      }
    }
    const freshChecks = await mapBounded(lookups, 6, async ({ sha }) => {
      const state = await this.restChecksForHeadStrict(sha);
      this.restCheckCache.set(sha, { at: Date.now(), state });
      return state;
    });
    for (let i = 0; i < lookups.length; i++) checks[lookups[i]!.index] = freshChecks[i]!;
    return checks;
  }

  private async listOpenPrSnapshotRest(deployConfigured: boolean): Promise<OpenPrSnapshot> {
    const { prs, capped } = await this.listOpenPullsRest();
    if (capped && !this.openPrCapLogged) {
      this.openPrCapLogged = true;
      console.warn(
        `[github] ${this.slug} has ≥200 open PRs; REST batch truncated — tail branches fall back to per-session`,
      );
    }
    const checks = await this.restChecksForPulls(prs);
    const pullRequests = prs.map((pr, i) => this.mapRestPullToPullRequest(pr, checks[i]!));
    const expectedOwner = this.forkOwner ?? this.slug.split("/")[0];
    const statuses = new Map<string, PrStatus>();

    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i]!;
      const key = pr.head?.ref;
      if (!key) continue;
      const status = this.mapRestPull(pr, deployConfigured, checks[i]!);
      const existing = statuses.get(key);
      if (!existing) {
        statuses.set(key, status);
      } else if (pr.head?.repo?.owner?.login === expectedOwner) {
        statuses.set(key, status);
      }
    }

    return { prs: pullRequests, statuses, capped, source: "rest" };
  }

  /** REST fallback for the herd's per-session PR status when GitHub's GraphQL
   *  bucket is exhausted. It intentionally returns the same PrStatus shape but
   *  only does extra REST check/status reads for open PRs; terminal PRs already
   *  sort correctly from the pull state alone. */
  private async prStatusRest(headBranch: string, deployConfigured: boolean): Promise<PrStatus> {
    const owner = this.forkOwner ?? this.slug.split("/")[0];
    const out = await this.run([
      "api",
      "--method",
      "GET",
      `repos/${this.slug}/pulls`,
      "-f",
      `head=${owner}:${headBranch}`,
      "-f",
      "state=all",
      "-f",
      "sort=created",
      "-f",
      "direction=desc",
      "-f",
      `per_page=${this.forkOwner ? "30" : "1"}`,
    ]);
    const prs = JSON.parse(out || "[]") as RestPull[];
    const pr = this.forkOwner
      ? prs.find((p) => p.head?.repo?.owner?.login === this.forkOwner)
      : prs[0];
    if (!pr) return { state: "none", checks: "none", deployConfigured };
    const state: PrStatus["state"] =
      pr.state === "open" ? "open" : pr.merged_at ? "merged" : "closed";
    const checks = state === "open" ? await this.restChecksForHead(pr.head?.sha) : "none";
    return this.mapRestPull(pr, deployConfigured, checks);
  }

  async prStatus(headBranch: string): Promise<PrStatus> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    if (graphRateLimit.blocked()) {
      return this.prStatusRest(headBranch, deployConfigured);
    }
    // `gh pr list --head` matches by bare branch ref name — it does NOT accept the
    // `<owner>:<branch>` qualifier (verified, gh 2.83.2: it silently returns []).
    // A bare `--head` DOES surface cross-repo (fork) PRs (verified against a real
    // fork PR), so in fork mode we keep the bare head, widen the limit, and request
    // `headRepositoryOwner` to pick the PR whose head lives on OUR fork — otherwise a
    // same-named branch on another fork could match first.
    //
    // The 30 cap bounds the (cheap) poll while tolerating other forks opening a PR
    // for the same branch ref. The only way to miss our PR is 30+ DISTINCT forks
    // each opening an upstream PR from an identically-named branch; Shepherd branches
    // are `shepherd/<session>`, so this is effectively impossible. If it ever bites,
    // prStatus returns state:none and a duplicate PR could be opened — acceptable vs.
    // unbounded paging on a hot path.
    let out: string;
    try {
      out = await this.run([
        "pr",
        "list",
        "--repo",
        this.slug,
        "--head",
        headBranch,
        "--state",
        "all",
        "--json",
        "number,url,title,state,createdAt,mergeable,mergeStateStatus,isDraft,statusCheckRollup,headRefOid,baseRefName,reviews,reviewRequests,headRepositoryOwner",
        "--limit",
        this.forkOwner ? "30" : "1",
      ]);
    } catch (err) {
      if (isRateLimitError(err)) return this.prStatusRest(headBranch, deployConfigured);
      throw err;
    }
    const prs = JSON.parse(out || "[]") as GhPr[];
    const pr = this.forkOwner
      ? prs.find((p) => p.headRepositoryOwner?.login === this.forkOwner)
      : prs[0];
    if (!pr) return { state: "none", checks: "none", deployConfigured };
    return this.mapGhPr(pr, deployConfigured);
  }

  /** One per-repo open-PR fetch (`gh pr list --state open`) mapped into every shape its
   *  consumers need, so a single query feeds the PRs-tab rows and the pr-poller batch. */
  async listOpenPrSnapshot(): Promise<OpenPrSnapshot> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    if (graphRateLimit.blocked()) return this.listOpenPrSnapshotRest(deployConfigured);
    let out: string;
    try {
      out = await this.run([
        "pr",
        "list",
        "--repo",
        this.slug,
        "--state",
        "open",
        "--json",
        "number,url,title,state,author,createdAt,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviews,reviewRequests,headRefName,headRefOid,baseRefName,labels,headRepositoryOwner",
        "--limit",
        "200",
      ]);
    } catch (err) {
      if (isRateLimitError(err)) return this.listOpenPrSnapshotRest(deployConfigured);
      throw err;
    }

    // The awaiting-approval leg carries its own fail-quiet fallback (empty set), so a
    // run-list failure degrades to "no flag" instead of rejecting the whole snapshot
    // (which would empty the PRs tab AND break the poller's statuses batch).
    const [def, awaitingShas] = await Promise.all([
      this.defaultBranch().catch(() => null),
      this.awaitingApprovalShas(),
    ]);

    const prs = JSON.parse(out || "[]") as Array<
      GhPr & { author?: { login?: string } | null; labels?: Array<{ name?: string }> }
    >;

    if (prs.length >= 200 && !this.openPrCapLogged) {
      this.openPrCapLogged = true;
      console.warn(
        `[github] ${this.slug} has ≥200 open PRs; batch truncated — tail branches fall back to per-session`,
      );
    }

    // Build PRs-tab rows (newest-first as gh returns).
    const pullRequests = prs.map((p) => this.mapGhPrToPullRequest(p, def, awaitingShas));

    // Build headRefName-keyed statuses with deterministic fork-collision dedup.
    // The expectedOwner-owned entry always wins regardless of array order; if no
    // entry matches, first-seen wins (mirrors prStatus's prs[0] no-match fallback).
    const expectedOwner = this.forkOwner ?? this.slug.split("/")[0];
    const statuses = new Map<string, PrStatus>();

    for (const pr of prs) {
      if (!pr.headRefName) continue;
      const key = pr.headRefName;
      // All nodes come from --state open; default state to "OPEN" when the raw
      // payload omits the field (e.g. older test fixtures or minimal gh responses).
      const prForStatus: GhPr = { ...pr, state: pr.state ?? "OPEN" };
      const existing = statuses.get(key);
      if (!existing) {
        statuses.set(key, this.mapGhPr(prForStatus, deployConfigured));
      } else if (pr.headRepositoryOwner?.login === expectedOwner) {
        // Current entry's owner matches: overwrite whatever was first-seen
        statuses.set(key, this.mapGhPr(prForStatus, deployConfigured));
      }
      // else: existing is already the right entry — keep it
    }

    return { prs: pullRequests, statuses, capped: prs.length >= 200, source: "graphql" };
  }

  /** Open PRs for this repo as full poll-grade PrStatus objects keyed by head
   *  branch name, fetched in ONE `gh pr list --state open` call — the per-repo
   *  batch the PrPoller matches sessions against locally (collapsing N× per-branch
   *  prStatus to O(repos)). When two open PRs share a headRefName (e.g. an
   *  internal-branch PR and a fork PR for the same name) the entry owned by
   *  `forkOwner ?? owner(slug)` wins regardless of array order — a deterministic
   *  collision dedup, NOT a fork filter (all open PRs are returned). The poller
   *  does not call this in fork mode (`batchForRepo` skips `isFork` repos →
   *  per-session `prStatus`); the `forkOwner` arm of the dedup key is just
   *  defensive. */
  async listOpenPrStatuses(): Promise<Map<string, PrStatus>> {
    return (await this.listOpenPrSnapshot()).statuses;
  }

  /** Cheap open-PR count (`gh pr list --state open --json number --limit 200`).
   *  Returns the array length; capped at 200 (≥200 means "at least 200"). */
  async countOpenPrs(): Promise<number> {
    const out = await this.run([
      "pr",
      "list",
      "--repo",
      this.slug,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "200",
    ]);
    const prs = JSON.parse(out || "[]") as { number: number }[];
    return prs.length;
  }

  private cachedDefaultBranch?: string;
  /** The repo's default branch (`gh repo view ... defaultBranchRef`), cached for
   *  the forge's lifetime — it never changes mid-session. Cached ONLY on success:
   *  a transient failure rethrows so the next call retries rather than sticking. */
  async defaultBranch(): Promise<string> {
    if (this.cachedDefaultBranch !== undefined) return this.cachedDefaultBranch;
    const out = await this.run(["repo", "view", this.slug, "--json", "defaultBranchRef"]);
    const name = (JSON.parse(out || "{}") as { defaultBranchRef?: { name?: string } })
      .defaultBranchRef?.name;
    if (!name) throw new Error("could not resolve default branch");
    this.cachedDefaultBranch = name;
    return name;
  }

  async ensureBranch(branch: string, fromRef: string): Promise<void> {
    try {
      await this.run(["api", `repos/${this.slug}/git/ref/heads/${branch}`]);
      return; // exists → never reset its tip
    } catch {
      // not found → create below
    }
    const baseRef = await this.run(["api", `repos/${this.slug}/git/ref/heads/${fromRef}`]);
    const sha = (JSON.parse(baseRef) as { object: { sha: string } }).object.sha;
    await this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${sha}`,
    ]);
  }

  /** Short-names of all branches matching `prefix` via the matching-refs API. Strips the
   *  leading `refs/heads/`. Returns [] when none match (the endpoint 200s with an empty list). */
  async listBranches(prefix: string): Promise<string[]> {
    const out = await this.run(["api", `repos/${this.slug}/git/matching-refs/heads/${prefix}`]);
    const refs = JSON.parse(out || "[]") as { ref?: string }[];
    return refs
      .map((r) => r.ref ?? "")
      .filter((r) => r.startsWith("refs/heads/"))
      .map((r) => r.slice("refs/heads/".length));
  }

  private cachedUser: string | null | undefined;
  /** The authenticated gh login (`gh api user`), cached for the forge's lifetime —
   *  it never changes mid-session, so one call serves every handoff computation. */
  async currentUser(): Promise<string | null> {
    if (this.cachedUser !== undefined) return this.cachedUser;
    try {
      this.cachedUser = (await this.run(["api", "user", "--jq", ".login"])).trim() || null;
    } catch {
      this.cachedUser = null; // unauth / offline → treat as "unknown me"
    }
    return this.cachedUser;
  }

  /** Whether the authenticated user can push. Returns a DEFINITIVE boolean only;
   *  THROWS on a probe failure (network/auth/unrecognised output) so the caller
   *  can treat that as retryable rather than silently as "no access". */
  async canPush(): Promise<boolean> {
    // Fork mode: `this.slug` is the upstream (read-only to a contributor), but the
    // user pushes branches and opens PRs from their fork — so probe the FORK
    // (`forkSlug`). Probing upstream would report READ → false and silently disable
    // the adopt-PR flow (gitignore-adopt.ts) on every fork.
    const probeSlug = this.forkSlug ?? this.slug;
    // `this.run` throwing (offline/unauth) and JSON.parse throwing (garbled)
    // both propagate as probe failures — intentionally not caught here.
    const out = await this.run(["repo", "view", probeSlug, "--json", "viewerPermission"]);
    const { viewerPermission } = JSON.parse(out || "{}") as { viewerPermission?: string };
    switch (viewerPermission) {
      case "ADMIN":
      case "MAINTAIN":
      case "WRITE":
        return true;
      case "READ":
      case "TRIAGE":
      case "NONE":
        return false;
      default:
        // Absent/unknown permission is not a definitive deny — surface as a probe failure.
        throw new Error(`unexpected viewerPermission: ${viewerPermission ?? "(absent)"}`);
    }
  }

  /** Sync the fork's default branch from upstream on GitHub
   *  (`gh repo sync <fork> --source <upstream>`). Idempotent — a fork already level
   *  with upstream is a no-op. THROWS (with gh's stderr) when called on a non-fork,
   *  on an auth failure, or when the fork's default branch has diverged from upstream
   *  (gh refuses a non-fast-forward rather than discarding the fork's commits); the
   *  caller classifies the stderr into a `syncfork_failed_*` code. */
  async syncFork(): Promise<void> {
    if (!this.forkSlug) throw new Error("syncFork called on a non-fork repo");
    // `slug` is the upstream (source of truth); `forkSlug` is the fork (destination).
    await this.run(["repo", "sync", this.forkSlug, "--source", this.slug]);
  }

  async listCollaborators(): Promise<{ logins: string[]; unavailable: boolean }> {
    try {
      // --paginate so a repo with >30 collaborators isn't silently truncated.
      const out = await this.run([
        "api",
        "--paginate",
        `repos/${this.slug}/collaborators`,
        "--jq",
        ".[].login",
      ]);
      const logins = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return { logins, unavailable: false };
    } catch {
      // The endpoint needs push access; GitHub 403s otherwise → let the dialog
      // fall back to free-text rather than show an empty/partial list.
      return { logins: [], unavailable: true };
    }
  }

  async openPr(o: OpenPrInput): Promise<PrStatus> {
    // Fork mode: the PR is created against the upstream (`this.slug`) but its head
    // lives on the fork, so qualify it as `<forkOwner>:<branch>`. `gh pr create`
    // supports this syntax (verified, gh 2.83.2); a bare branch would resolve the
    // head against the upstream and fail.
    const head = this.forkOwner ? `${this.forkOwner}:${o.head}` : o.head;
    const args = [
      "pr",
      "create",
      "--repo",
      this.slug,
      "--head",
      head,
      "--base",
      o.base,
      "--title",
      o.title,
      "--body",
      o.body,
    ];
    if (o.draft) args.push("--draft");
    try {
      await this.run(args);
    } catch (err) {
      // An execFile rejection carries the subprocess stderr on err.stderr plus the message;
      // read both defensively (err is unknown) and classify the empty-diff signal.
      const stderr = (err as { stderr?: unknown }).stderr;
      const text = `${typeof stderr === "string" ? stderr : ""} ${err instanceof Error ? err.message : String(err)}`;
      if (isNoCommitsBetween(text)) throw new EmptyDiffError(o.head, o.base, err);
      throw err;
    }
    return this.prStatus(o.head);
  }

  async markReady(prNumber: number): Promise<void> {
    await this.run(["pr", "ready", String(prNumber), "--repo", this.slug]);
  }

  async convertToDraft(prNumber: number): Promise<void> {
    await this.run(["pr", "ready", String(prNumber), "--repo", this.slug, "--undo"]);
  }

  async createIssue(o: { title: string; body: string }): Promise<{ number: number; url: string }> {
    // `gh issue create` echoes the new issue's URL on stdout (…/issues/<n>).
    const url = (
      await this.run(["issue", "create", "--repo", this.slug, "--title", o.title, "--body", o.body])
    ).trim();
    const n = Number(url.match(/\/(\d+)\s*$/)?.[1]);
    if (!Number.isInteger(n)) throw new Error(`could not parse issue number from URL: ${url}`);
    return { number: n, url };
  }

  async renameBranch(oldBranch: string, newBranch: string): Promise<void> {
    // GitHub's rename-branch endpoint moves the ref AND retargets every open PR and
    // branch-protection rule onto the new name, so a session's open PR follows along.
    await this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/branches/${oldBranch}/rename`,
      "-f",
      `new_name=${newBranch}`,
    ]);
  }

  async merge(prNumber: number, o: MergeInput): Promise<void> {
    const method =
      o.method === "rebase" ? "--rebase" : o.method === "merge" ? "--merge" : "--squash";
    const args = ["pr", "merge", String(prNumber), "--repo", this.slug, method];
    if (o.deleteBranch) args.push("--delete-branch");
    await this.run(args);
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.run(["issue", "close", String(issueNumber), "--repo", this.slug]);
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    await this.run(["issue", "comment", String(issueNumber), "--repo", this.slug, "--body", body]);
  }

  async comment(prNumber: number, body: string): Promise<void> {
    await this.run(["pr", "comment", String(prNumber), "--repo", this.slug, "--body", body]);
  }

  async editPr(prNumber: number, o: { title?: string; body?: string }): Promise<void> {
    const args = ["pr", "edit", String(prNumber), "--repo", this.slug];
    if (o.title !== undefined) args.push("--title", o.title);
    if (o.body !== undefined) args.push("--body", o.body);
    if (args.length === 5) return; // no title/body provided — nothing to edit
    await this.run(args);
  }

  async ensureIssueLink(prNumber: number, issueNumber: number): Promise<void> {
    const body = (
      await this.run([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        this.slug,
        "--json",
        "body",
        "-q",
        ".body // empty",
      ])
    ).trim();
    const pattern = new RegExp(
      `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
      "i",
    );
    if (pattern.test(body)) return;
    const newBody = body ? `${body}\n\nCloses #${issueNumber}` : `Closes #${issueNumber}`;
    await this.run(["pr", "edit", String(prNumber), "--repo", this.slug, "--body", newBody]);
  }

  async addIssueLabel(issueNumber: number, label: string): Promise<void> {
    // `gh issue edit --add-label` 422s on a label the repo hasn't defined. The
    // operator creates the opt-in label, but the claim label is ours — create it
    // first (ignoring "already exists") so the claim doesn't fail on a fresh repo.
    await this.ensureLabel(label);
    await this.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.slug,
      "--add-label",
      label,
    ]);
  }

  async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
    await this.run([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.slug,
      "--remove-label",
      label,
    ]);
  }

  async addPrLabel(prNumber: number, label: string): Promise<void> {
    // Same shape as addIssueLabel but on the PR (`gh pr edit`): create the label first
    // (ignoring "already exists") so the add doesn't 422 on a fresh repo, then add it.
    // Idempotent — `--add-label` on an already-present label is a no-op.
    await this.ensureLabel(label, "D93F0B", "Authored by Codex — give the review extra care");
    await this.run(["pr", "edit", String(prNumber), "--repo", this.slug, "--add-label", label]);
  }

  /** Best-effort create-if-missing for a repo label. No `--force`, so an existing
   *  label the operator may have recolored is left untouched; the throw on "already
   *  exists" is swallowed and a real failure surfaces on the subsequent --add-label.
   *  color/description default to the drain claim-label values so existing callers are
   *  unchanged; addPrLabel passes its own. */
  private async ensureLabel(
    label: string,
    color = "5319e7",
    description = "Claimed by a Shepherd session (auto-drain or linked issue)",
  ): Promise<void> {
    try {
      await this.run([
        "label",
        "create",
        label,
        "--repo",
        this.slug,
        "--color",
        color,
        "--description",
        description,
      ]);
    } catch {
      // already exists (or a transient gh error) — ignore.
    }
  }

  async redeploy(o: RedeployInput): Promise<void> {
    await this.run(["workflow", "run", o.workflow, "--repo", this.slug, "--ref", o.ref]);
  }

  async postReview(prNumber: number, o: PostReviewInput): Promise<{ url?: string }> {
    if (o.event === "REQUEST_CHANGES") {
      try {
        await this.run([
          "pr",
          "review",
          String(prNumber),
          "--repo",
          this.slug,
          "--request-changes",
          "--body",
          o.body,
        ]);
        return {}; // gh pr review prints no machine-readable URL
      } catch {
        // GitHub forbids request-changes on a PR you authored, and the agent +
        // critic share one gh identity — so this 422s on self-authored PRs. Fall
        // back to a plain PR comment so the findings still land on the host.
        // `gh pr comment` echoes the new comment's URL on stdout.
        const url = (
          await this.run(["pr", "comment", String(prNumber), "--repo", this.slug, "--body", o.body])
        ).trim();
        return { url: url || undefined };
      }
    }
    await this.run([
      "pr",
      "review",
      String(prNumber),
      "--repo",
      this.slug,
      "--comment",
      "--body",
      o.body,
    ]);
    return {}; // gh pr review prints no machine-readable URL
  }

  async listPrComments(prNumber: number): Promise<PrComment[]> {
    const out = await this.run([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.slug,
      "--json",
      "comments",
    ]);
    const parsed = JSON.parse(out || "{}") as {
      comments?: {
        id?: string | null;
        url?: string | null;
        author?: { login?: string } | null;
        body?: string | null;
        createdAt?: string | null;
      }[];
    };
    return (parsed.comments ?? []).map((c) => ({
      // gh exposes a node `id`; fall back to the comment url (also unique) so the
      // per-round dedup always has a stable key even if one field is absent.
      id: c.id ?? c.url ?? "",
      author: c.author?.login ?? "",
      body: c.body ?? "",
      createdAt: c.createdAt ? Date.parse(c.createdAt) : 0,
    }));
  }

  async prChangedPaths(prNumber: number): Promise<string[]> {
    const out = await this.run([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.slug,
      "--json",
      "files",
      "--jq",
      ".files[].path",
    ]);
    return out
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  async prReviewMeta(prNumber: number): Promise<PrReviewMeta | null> {
    if (graphRateLimit.blocked()) return this.prReviewMetaRest(prNumber);
    try {
      const out = await this.run([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        this.slug,
        "--json",
        "body,baseRefName,isCrossRepository,state",
      ]);
      const parsed = JSON.parse(out || "null") as {
        body?: string | null;
        baseRefName?: string | null;
        isCrossRepository?: boolean | null;
        state?: string | null;
      } | null;
      if (!parsed) return null;
      return {
        body: parsed.body ?? "",
        baseRefName: parsed.baseRefName ?? "",
        isCrossRepository: parsed.isCrossRepository ?? false,
        state: mapGraphqlPrReviewState(parsed.state),
      };
    } catch (err) {
      if (isRateLimitError(err)) return this.prReviewMetaRest(prNumber);
      return null;
    }
  }

  private async prReviewMetaRest(prNumber: number): Promise<PrReviewMeta | null> {
    try {
      const out = await this.run(this.restGetArgs(`repos/${this.slug}/pulls/${prNumber}`));
      const parsed = JSON.parse(out || "null") as RestPull | null;
      if (!parsed) return null;
      const state: PrReviewMeta["state"] =
        parsed.state === "open" ? "open" : parsed.merged_at ? "merged" : "closed";
      const headFullName = parsed.head?.repo?.full_name ?? "";
      const baseFullName = parsed.base?.repo?.full_name ?? "";
      return {
        body: parsed.body ?? "",
        baseRefName: parsed.base?.ref ?? "",
        isCrossRepository: !!headFullName && !!baseFullName && headFullName !== baseFullName,
        state,
      };
    } catch {
      return null;
    }
  }

  private readonly apiVersion = ["-H", "X-GitHub-Api-Version: 2026-03-10"];

  async listSubIssues(parentNumber: number): Promise<SubIssueRef[]> {
    try {
      const out = await this.run([
        "api",
        ...this.apiVersion,
        `repos/${this.slug}/issues/${parentNumber}/sub_issues`,
        "--paginate",
      ]);
      return (
        JSON.parse(out || "[]") as Array<{
          number: number;
          title: string;
          html_url: string;
          body?: string;
          state: string;
          labels?: Array<{ name: string }>;
        }>
      ).map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        body: i.body ?? "",
        closed: i.state === "closed",
        labels: (i.labels ?? []).map((l) => l.name),
      }));
    } catch {
      return [];
    }
  }

  async listBlockedBy(issueNumber: number): Promise<number[]> {
    try {
      const out = await this.run([
        "api",
        ...this.apiVersion,
        `repos/${this.slug}/issues/${issueNumber}/dependencies/blocked_by`,
        "--paginate",
      ]);
      return (JSON.parse(out || "[]") as Array<{ number: number }>).map((i) => i.number);
    } catch {
      return [];
    }
  }

  async issueId(issueNumber: number): Promise<number | null> {
    try {
      const out = await this.run([
        "api",
        `repos/${this.slug}/issues/${issueNumber}`,
        "--jq",
        ".id",
      ]);
      const id = Number(out.trim());
      return Number.isFinite(id) ? id : null;
    } catch {
      return null;
    }
  }

  async addSubIssue(parentNumber: number, childNumber: number): Promise<void> {
    const id = await this.issueId(childNumber);
    if (id == null) throw new Error(`cannot resolve id for #${childNumber}`);
    await this.run([
      "api",
      "-X",
      "POST",
      ...this.apiVersion,
      `repos/${this.slug}/issues/${parentNumber}/sub_issues`,
      "-F",
      `sub_issue_id=${id}`,
    ]);
  }

  async addBlockedBy(issueNumber: number, blockerNumber: number): Promise<void> {
    const id = await this.issueId(blockerNumber);
    if (id == null) throw new Error(`cannot resolve id for #${blockerNumber}`);
    await this.run([
      "api",
      "-X",
      "POST",
      ...this.apiVersion,
      `repos/${this.slug}/issues/${issueNumber}/dependencies/blocked_by`,
      "-F",
      `issue_id=${id}`,
    ]);
  }

  async listSubIssueSummaries(): Promise<{
    summaries: Map<number, { total: number; completed: number }>;
    subIssueNumbers: number[];
    childrenByParent: Map<number, number[]>;
  }> {
    if (graphRateLimit.blocked())
      return { summaries: new Map(), subIssueNumbers: [], childrenByParent: new Map() };
    // No this.apiVersion header: subIssuesSummary is GA on GraphQL (no preview header needed).
    // Do NOT add the X-GitHub-Api-Version header here — it was required only for the
    // REST sub_issues endpoints above.
    const [owner, name] = this.slug.split("/");
    // number + counts + parent selected: backlog renders badge on visible issue row;
    // parent field identifies native sub-issues (child numbers collected here).
    const query =
      "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){issues(states:OPEN,first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{number subIssuesSummary{total completed} parent{number}}}}}";
    const summaries = new Map<number, { total: number; completed: number }>();
    const subIssueSet = new Set<number>();
    const childrenByParent = new Map<number, number[]>();
    try {
      let endCursor: string | null = null;
      for (let page = 0; page < MAX_SUMMARY_PAGES; page++) {
        const args = [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `query=${query}`,
        ];
        // Thread cursor explicitly; page 1 omits it so $endCursor defaults to null in GraphQL.
        if (endCursor !== null) args.push("-f", `endCursor=${endCursor}`);
        const pageInfo = collectSubIssueSummaryPage(
          await this.run(args),
          summaries,
          subIssueSet,
          childrenByParent,
        );
        if (!pageInfo.hasNextPage) break;
        endCursor = pageInfo.endCursor;
      }
    } catch {
      // Best-effort; degrade to markdown-only discovery rather than failing the route.
      return { summaries: new Map(), subIssueNumbers: [], childrenByParent: new Map() };
    }
    return { summaries, subIssueNumbers: [...subIssueSet], childrenByParent };
  }

  /** Numbers-only view of {@link listOpenPrLinkedIssues} for Up Next (#1169), which only needs
   *  "does an open PR close this issue?". Delegates to the one linked-issues query so the two
   *  callers share a single fetch/parse path. */
  async listOpenPrClosingIssues(): Promise<number[]> {
    return [...(await this.listOpenPrLinkedIssues()).keys()];
  }

  async listOpenPrLinkedIssues(): Promise<Map<number, LinkedPr[]>> {
    if (graphRateLimit.blocked()) return new Map();
    // Issues an open PR would close (UI-linked + `Closes #N` bodies), mapped to the PR's
    // number + author. Paginated like listSubIssueSummaries; capped to ~200 newest open PRs
    // (MAX_SUMMARY_PAGES) — a repo above that undercounts linked PRs. Best-effort — any
    // failure yields an empty map (Up Next falls back to the shepherd:active exclusion; the
    // epic pill falls back to the assignee/author signals).
    const [owner, name] = this.slug.split("/");
    const query =
      "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{number author{login} closingIssuesReferences(first:20){nodes{number}}}}}}";
    const linked = new Map<number, LinkedPr[]>();
    try {
      let endCursor: string | null = null;
      for (let page = 0; page < MAX_SUMMARY_PAGES; page++) {
        const args = [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `query=${query}`,
        ];
        if (endCursor !== null) args.push("-f", `endCursor=${endCursor}`);
        const pageInfo = collectLinkedIssuesPage(await this.run(args), linked);
        if (!pageInfo.hasNextPage) break;
        endCursor = pageInfo.endCursor;
      }
    } catch (err) {
      if (isRateLimitError(err)) return new Map();
      return new Map();
    }
    return linked;
  }

  async listBlockedByOpen(): Promise<Map<number, number[]>> {
    if (graphRateLimit.blocked()) return new Map();
    // One batched GraphQL query for every open issue's still-open blockers, so Up Next can
    // hide dependency-blocked issues without an N+1 fan-out. Paginated like
    // listSubIssueSummaries/listOpenPrClosingIssues; capped to ~200 open issues (matches
    // listIssues' REST_LIST_CAP). Fail open: no REST fallback exists for this data, so any
    // failure (rate limit, malformed JSON) yields an empty Map — degraded to no exclusion.
    const [owner, name] = this.slug.split("/");
    const query =
      "query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(states:OPEN, first:100, after:$after, orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{ hasNextPage endCursor }nodes{ number blockedBy(first:20){ nodes{ number state } } }}}}";
    const result = new Map<number, number[]>();
    try {
      let after: string | null = null;
      for (let page = 0; page < MAX_SUMMARY_PAGES; page++) {
        const args = [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `query=${query}`,
        ];
        // Thread cursor as a raw string (-f): the opaque base64 cursor must not be type-coerced
        // by gh. Page 1 omits it so $after defaults to null in GraphQL. Matches the sibling
        // paginators (listSubIssueSummaries / listOpenPrClosingIssues).
        if (after !== null) args.push("-f", `after=${after}`);
        const pageInfo = collectBlockedByOpenPage(await this.run(args), result);
        if (!pageInfo.hasNextPage) break;
        after = pageInfo.endCursor;
      }
    } catch {
      return new Map();
    }
    return result;
  }
}
