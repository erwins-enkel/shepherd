import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "../instrument";
import { jobsFromRollup, mapCheckState, rollupChecks } from "./checks";
import { classifyPr } from "./pr-kind";
import {
  graphRateLimit,
  isGraphqlBucketCall,
  isRateLimitError,
  parseRetryAfter,
} from "./rate-limit";
import { CRITIC_REVIEW_MARKER, EmptyDiffError } from "./types";
import type {
  CiStatus,
  ForgeConfig,
  GitForge,
  Issue,
  IssueComment,
  MergeInput,
  MergeMethod,
  MergeStateStatus,
  OpenPrInput,
  PostReviewInput,
  PrComment,
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

/** `gh pr create` on an empty diff prints "No commits between <base> and <head>" to stderr.
 *  Match that case-insensitively to classify an openPr failure as an EmptyDiffError. */
function isNoCommitsBetween(text: string): boolean {
  return text.toLowerCase().includes("no commits between");
}

/** Cap on summary pages for listSubIssueSummaries: 2 pages × 100 issues = ~200 issues,
 *  mirroring the listIssues() 200-open-issue cap. */
const MAX_SUMMARY_PAGES = 2;

/** Parse one page of the sub-issue-summary GraphQL response: record every node with
 *  total > 0 into `intoSummaries` (keyed by issue number), add every node with a non-null
 *  parent to `intoSubIssues`, and return the page's cursor info. */
function collectSubIssueSummaryPage(
  out: string,
  intoSummaries: Map<number, { total: number; completed: number }>,
  intoSubIssues: Set<number>,
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
    }
  }
  return {
    hasNextPage: issues?.pageInfo?.hasNextPage ?? false,
    endCursor: issues?.pageInfo?.endCursor ?? null,
  };
}

/** Parse one page of the open-PR closingIssuesReferences GraphQL response: add every closed
 *  issue number into `into`, and return the page's cursor info. */
function collectClosingIssuesPage(
  out: string,
  into: Set<number>,
): { hasNextPage: boolean; endCursor: string | null } {
  const json = JSON.parse(out || "{}") as {
    data?: {
      repository?: {
        pullRequests?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{ closingIssuesReferences?: { nodes?: Array<{ number?: number }> } }>;
        };
      };
    };
  };
  const prs = json.data?.repository?.pullRequests;
  for (const n of prs?.nodes ?? [])
    for (const ref of n.closingIssuesReferences?.nodes ?? [])
      if (typeof ref.number === "number") into.add(ref.number);
  return {
    hasNextPage: prs?.pageInfo?.hasNextPage ?? false,
    endCursor: prs?.pageInfo?.endCursor ?? null,
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

interface GhReview {
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

  async listBacklogCounts(): Promise<RepoCounts> {
    const [owner, name] = this.slug.split("/");
    const out = await this.run([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN, first:100){ totalCount nodes{ author{login} title headRefName } } defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}} rateLimit{ remaining resetAt }}",
    ]);
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
    const out = await this.run([
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
    const raw = JSON.parse(out || "[]") as Array<{
      number: number;
      title: string;
      body?: string;
      url: string;
      labels?: Array<{ name: string }>;
      createdAt?: string;
      assignees?: Array<{ login: string }>;
      author?: { login?: string } | null;
    }>;
    return raw.map((i) => {
      const ts = Date.parse(i.createdAt ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.url,
        labels: (i.labels ?? []).map((l) => l.name),
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
    // COST: one `gh issue view` subprocess per spawn candidate per pump. `this.run`
    // is async (non-blocking) and the drain spawns at most maxAuto per pump, so the
    // fan-out is bounded and small; not worth caching/batching for the claim re-check.
    try {
      const out = await this.run([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        this.slug,
        "--json",
        "number,title,body,url,labels,createdAt,assignees",
      ]);
      const i = JSON.parse(out || "null") as {
        number: number;
        title: string;
        body?: string;
        url: string;
        labels?: Array<{ name: string }>;
        createdAt?: string;
        assignees?: Array<{ login: string }>;
      } | null;
      if (!i) return null;
      const ts = Date.parse(i.createdAt ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.url,
        labels: (i.labels ?? []).map((l) => l.name),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        assignees: (i.assignees ?? []).map((a) => a.login),
      };
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

  async listPullRequests(): Promise<PullRequest[]> {
    const [out, def] = await Promise.all([
      this.run([
        "pr",
        "list",
        "--repo",
        this.slug,
        "--state",
        "open",
        "--json",
        "number,title,url,author,createdAt,isDraft,mergeable,statusCheckRollup,reviews,headRefName,headRefOid,baseRefName,labels",
        // See listIssues: 200 cap vs unbounded PR count (pullRequests.totalCount).
        "--limit",
        "200",
      ]),
      this.defaultBranch().catch(() => null),
    ]);
    const raw = JSON.parse(out || "[]") as Array<
      GhPr & {
        author?: { login?: string } | null;
        createdAt?: string;
        isDraft?: boolean;
        headRefName?: string;
        headRefOid?: string;
        baseRefName?: string;
        labels?: Array<{ name?: string }>;
      }
    >;
    return raw.map((p) => {
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
        checks: rollupChecks(p.statusCheckRollup ?? []),
        jobs: jobsFromRollup(p.statusCheckRollup ?? []),
        latestReview: latestHumanReview(p.reviews),
        nonDefaultBase: def && p.baseRefName && p.baseRefName !== def ? p.baseRefName : undefined,
        headSha: p.headRefOid,
        headRefName: p.headRefName,
      };
    });
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
      headSha: pr.headRefOid,
      baseRefName: pr.baseRefName,
      latestReview: latestHumanReview(pr.reviews),
      requestedReviewers: (pr.reviewRequests ?? [])
        .map((r) => r.login)
        .filter((l): l is string => !!l),
      deployConfigured,
    };
  }

  async prStatus(headBranch: string): Promise<PrStatus> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
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
    const out = await this.run([
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
    const prs = JSON.parse(out || "[]") as GhPr[];
    const pr = this.forkOwner
      ? prs.find((p) => p.headRepositoryOwner?.login === this.forkOwner)
      : prs[0];
    if (!pr) return { state: "none", checks: "none", deployConfigured };
    return this.mapGhPr(pr, deployConfigured);
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
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    const out = await this.run([
      "pr",
      "list",
      "--repo",
      this.slug,
      "--state",
      "open",
      "--json",
      "number,url,title,state,createdAt,mergeable,mergeStateStatus,isDraft,statusCheckRollup,headRefOid,headRefName,baseRefName,reviews,reviewRequests,headRepositoryOwner",
      "--limit",
      "200",
    ]);
    const prs = JSON.parse(out || "[]") as GhPr[];

    if (prs.length >= 200 && !this.openPrCapLogged) {
      this.openPrCapLogged = true;
      console.warn(
        `[github] ${this.slug} has ≥200 open PRs; batch truncated — tail branches fall back to per-session`,
      );
    }

    // Deterministic dedup when two open PRs share a headRefName (e.g. an internal
    // branch PR and a fork PR for the same name). The expectedOwner-owned entry
    // always wins regardless of array order; if no entry matches, first-seen wins
    // (mirrors prStatus's prs[0] no-match fallback).
    const expectedOwner = this.forkOwner ?? this.slug.split("/")[0];
    const result = new Map<string, PrStatus>();

    for (const pr of prs) {
      if (!pr.headRefName) continue;
      const key = pr.headRefName;
      const existing = result.get(key);
      if (!existing) {
        result.set(key, this.mapGhPr(pr, deployConfigured));
      } else if (pr.headRepositoryOwner?.login === expectedOwner) {
        // Current entry's owner matches: overwrite whatever was first-seen
        result.set(key, this.mapGhPr(pr, deployConfigured));
      }
      // else: existing is already the right entry — keep it
    }

    return result;
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

  /** Best-effort create-if-missing for a repo label. No `--force`, so an existing
   *  label the operator may have recolored is left untouched; the throw on "already
   *  exists" is swallowed and a real failure surfaces on the subsequent --add-label. */
  private async ensureLabel(label: string): Promise<void> {
    try {
      await this.run([
        "label",
        "create",
        label,
        "--repo",
        this.slug,
        "--color",
        "5319e7",
        "--description",
        "Claimed by a Shepherd session (auto-drain or linked issue)",
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
      const rawState = (parsed.state ?? "").toUpperCase();
      const state: PrReviewMeta["state"] =
        rawState === "OPEN"
          ? "open"
          : rawState === "MERGED"
            ? "merged"
            : rawState === "CLOSED"
              ? "closed"
              : "none";
      return {
        body: parsed.body ?? "",
        baseRefName: parsed.baseRefName ?? "",
        isCrossRepository: parsed.isCrossRepository ?? false,
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
  }> {
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
        const pageInfo = collectSubIssueSummaryPage(await this.run(args), summaries, subIssueSet);
        if (!pageInfo.hasNextPage) break;
        endCursor = pageInfo.endCursor;
      }
    } catch {
      // Best-effort; degrade to markdown-only discovery rather than failing the route.
      return { summaries: new Map(), subIssueNumbers: [] };
    }
    return { summaries, subIssueNumbers: [...subIssueSet] };
  }

  async listOpenPrClosingIssues(): Promise<number[]> {
    // Issues an open PR would close (UI-linked + `Closes #N` bodies). Paginated like
    // listSubIssueSummaries; capped to ~200 open PRs. Best-effort — any failure yields []
    // and Up Next falls back to the shepherd:active exclusion alone.
    const [owner, name] = this.slug.split("/");
    const query =
      "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{closingIssuesReferences(first:20){nodes{number}}}}}}";
    const closed = new Set<number>();
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
        const pageInfo = collectClosingIssuesPage(await this.run(args), closed);
        if (!pageInfo.hasNextPage) break;
        endCursor = pageInfo.endCursor;
      }
    } catch {
      return [];
    }
    return [...closed];
  }
}
