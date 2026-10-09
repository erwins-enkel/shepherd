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
import { makeUserCache } from "./user-cache";
import { labelColorsFrom } from "./labels";
import {
  attachAttempts,
  attemptsOf,
  classifyGhError,
  type GhFetchAttempt,
  type GhTransport,
} from "./gh-attempt";
import {
  type BucketRateLimit,
  ghCallSummary,
  graphRateLimit,
  isGraphqlBucketCall,
  isRateLimitError,
  isRestBucketCall,
  isRestReadCall,
  parseRetryAfter,
  restRateLimit,
  restWriteRateLimit,
} from "./rate-limit";
import {
  graphqlSpend,
  parseInQueryRateLimit,
  porcelainCost,
  withRateLimit,
  type GraphqlSpendLedger,
} from "./github-spend";
import { issuesFreshness } from "./repo-freshness";
import { readEpicStructureByParts } from "./epic-structure";
import { Semaphore } from "../semaphore";
import type { GithubCacheEntry, GithubReadCache, IssueRelations } from "../github-read-cache";
import {
  CRITIC_REVIEW_MARKER,
  EmptyDiffError,
  issueStateField,
  issueUpdatedAtField,
  MergeEnqueuedError,
  MergePendingError,
  StackedMergeRefusedError,
} from "./types";
import type {
  ChecksState,
  CiStatus,
  EpicStructure,
  ForgeConfig,
  ForgeRun,
  ForgeRunJob,
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
  StackInfo,
  SubIssueRef,
  WorkflowJob,
  WorkflowRun,
} from "./types";

/** Poll cadence for GitHub's async merge API (#2059). Bounded by ATTEMPTS rather than wall
 *  clock so an injected no-op sleeper makes the budget-exhaustion path testable instantly.
 *  15 × 2s = 30s, after which the merge is still in flight host-side — see MergePendingError,
 *  which is non-destructive: the host keeps merging and the PR poller reconciles. */
const MERGE_ASYNC_POLL_MS = 2_000;
const MERGE_ASYNC_POLL_ATTEMPTS = 15;

/** Worst-case time {@link GithubForge.merge} can spend WAITING on the async merge API.
 *
 *  Exported because two HTTP routes can trigger that wait inside a request handler, and Bun's
 *  10s default socket budget would sever the connection mid-merge — the browser would then see a
 *  transport error and report "merge failed" for a merge that is in flight or has already landed.
 *  Those routes size their own budget off THIS constant (see `slowRequestTimeoutSec`) rather than
 *  hardcoding a second number that could silently drift out of step with it. */
export const MERGE_ASYNC_MAX_WAIT_MS = MERGE_ASYNC_POLL_MS * MERGE_ASYNC_POLL_ATTEMPTS;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The `{ status, details }` body BOTH merge-async endpoints return (PUT and the uuid GET).
 *  Note the uuid lives at `details.uuid`, NOT at the top level. */
interface MergeAsyncBody {
  status?: string;
  details?: { uuid?: string; message?: string; sha?: string };
}

/** What the merge path needs to know about a PR before choosing a merge strategy. */
interface StackProbe {
  /** True when the PR belongs to a GitHub stack. The REST `stack` object is ABSENT (not null)
   *  on unstacked PRs, so any object at all means stacked; no field of it is load-bearing. */
  stacked: boolean;
  /** 1-based layer position and stack size, when reported. Advisory — message text only. */
  position?: number;
  size?: number;
  /** Head SHA, passed to merge-async as the optimistic-concurrency guard. */
  sha?: string;
  /** The stack's TRUNK — `stack.base.ref`, the branch the whole stack lands on. NOT the PR's
   *  own `base.ref`, which for any layer above the bottom is the layer below it. Merging any
   *  layer lands the stack on the trunk, so the trunk is what carries the rules that apply. */
  stackBase?: string;
}

/** `stackBase` is interpolated straight into a `gh api` path, so — like {@link MERGE_UUID_RE} — it
 *  is shape-checked first: a garbled or hostile ref would otherwise retarget the request at a
 *  different endpoint. Checked per SLASH-SEPARATED SEGMENT rather than against the whole string,
 *  because it is a `..` segment specifically that traverses; each segment must start with a word
 *  character, which rules out `..`, `.`, and an empty segment in one move. Deliberately narrower
 *  than git's ref grammar — a ref this rejects is treated as "we don't know the trunk", which
 *  fails open to today's behaviour. */
function isPathSafeRef(ref: string): boolean {
  return ref.length <= 255 && ref.split("/").every((seg) => /^\w[\w.-]*$/.test(seg));
}

/** `--jq` projection of one stack resource onto {@link StackInfo}'s wire shape (#2068). Narrowing
 *  host-side keeps the payload small; `// []` keeps jq from erroring on a stack the host returned
 *  without a membership list, which {@link stackInfoFrom} then rejects as unusable. */
const STACK_JQ = "{number, baseRef: .base.ref, prNumbers: [(.pull_requests // [])[].number]}";

/** Validate one {@link STACK_JQ} projection. Null for anything unusable — a missing stack number,
 *  a missing trunk, or no members — so both the fail-open read and the throwing writes have one
 *  definition of "the host did not describe a stack we can address". */
function stackInfoFrom(raw: Partial<StackInfo> | null | undefined): StackInfo | null {
  if (!raw || typeof raw.number !== "number" || !raw.baseRef) return null;
  const prNumbers = (raw.prNumbers ?? []).filter((n) => typeof n === "number");
  if (!prNumbers.length) return null;
  return { number: raw.number, baseRef: raw.baseRef, prNumbers };
}

/** A merge-request uuid is interpolated straight into the `gh api` path, so it is validated
 *  before use: a garbled or hostile value (`../..`) would otherwise retarget the request at a
 *  different endpoint. Anything that is not a plain UUID is treated as "no uuid to poll". */
const MERGE_UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Parse the JSON body `gh api` emitted, tolerating a Buffer, a non-JSON body, or nothing.
 *  `gh` writes HTTP ERROR bodies to stdout (only `gh: HTTP 409` goes to stderr) and exits 1,
 *  so on a rejection the body is read off the error's `stdout` — that is what makes
 *  "409 ⇒ adopt the in-flight uuid" reachable through the GhRunner seam. */
function parseMergeAsyncBody(raw: unknown): MergeAsyncBody | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString() : "";
  if (!text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as MergeAsyncBody) : null;
  } catch {
    return null; // not JSON (a gh usage error, an HTML error page) → nothing to adopt
  }
}

/** The body's uuid, but only when it is actually shaped like one. See {@link MERGE_UUID_RE}. */
function mergeAsyncUuid(body: MergeAsyncBody | null): string | undefined {
  const uuid = body?.details?.uuid;
  return uuid && MERGE_UUID_RE.test(uuid) ? uuid : undefined;
}

/** Cap on distinct workflows fetched per repo: each kept run costs one extra
 *  `gh run view` subprocess, so bound the fan-out. */
const MAX_WORKFLOWS = 10;
const REST_PAGE_SIZE = 100;
const REST_LIST_CAP = 200;
const REST_PAGE_CAP = 10;
const MAX_CHECK_RUN_PAGES = 2;
const REST_CHECK_CACHE_TTL_MS = 60_000;
const REST_CHECK_LOOKUP_BUDGET = 40;
/** How long {@link GithubForge.listIssues} answers from its cache (#2656). */
const ISSUES_CACHE_TTL_MS = 30_000;
/** First and longest per-repo backoff window after a failed issue listing (#2656). */
const ISSUES_FAILURE_BACKOFF_MS = 30_000;
const ISSUES_FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
/** How long {@link GithubForge.getEpicStructure} answers from its cache while no fingerprint
 *  covers the repo (#2807). A covered repo keeps it until its issue generation moves. */
const EPIC_STRUCTURE_TTL_MS = 2 * 60_000;
/** How soon {@link GithubForge.getEpicStructure} retries after a REST fallback read with a failed
 *  call in it. Doubles per consecutive failed read, up to {@link EPIC_STRUCTURE_TTL_MS}. */
const EPIC_STRUCTURE_RETRY_MS = 30_000;

/** Issue fields of the GraphQL single-issue reads ({@link GithubForge.getIssue}, the epic
 *  parent). Carries the author's authorAssociation for the autonomous-spawn author trust gate. */
const GQL_ISSUE_FIELDS =
  "number title state body url createdAt author{login} authorAssociation labels(first:50){nodes{name}} assignees(first:20){nodes{login}}";

interface GqlIssue {
  number: number;
  title: string;
  state?: string;
  body?: string;
  url: string;
  createdAt?: string;
  author?: { login?: string } | null;
  authorAssociation?: string | null;
  labels?: { nodes?: Array<{ name: string }> };
  assignees?: { nodes?: Array<{ login: string }> };
}

function mapGqlIssue(i: GqlIssue): Issue {
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
    ...issueStateField(i.state),
  };
}

/** An epic's whole structure in one query (#2807): the parent, its sub-issues and every child's
 *  blockers. GitHub caps a parent at 100 sub-issues and a relationship at 50 issues, so neither
 *  connection needs paging. A point or two, against N + 2 calls for the per-child reads. */
const EPIC_STRUCTURE_QUERY =
  "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){" +
  GQL_ISSUE_FIELDS +
  " subIssues(first:100){nodes{number title url body state labels(first:50){nodes{name}} blockedBy(first:50){nodes{number}}}}}}}";

interface GqlEpicIssue extends GqlIssue {
  subIssues?: {
    nodes?: Array<{
      number: number;
      title: string;
      url: string;
      body?: string;
      state?: string;
      labels?: { nodes?: Array<{ name: string }> };
      blockedBy?: { nodes?: Array<{ number: number } | null> };
    } | null>;
  };
}

/** Parse {@link EPIC_STRUCTURE_QUERY}'s output. A missing parent issue reads as an empty
 *  structure; output without a `repository` throws, so the caller falls back to REST. */
function parseEpicStructure(out: string): EpicStructure {
  const json = JSON.parse(out || "null") as {
    data?: { repository?: { issue?: GqlEpicIssue | null } | null } | null;
  } | null;
  const repo = json?.data?.repository;
  if (!repo) throw new Error("epic structure: response has no repository");
  const i = repo.issue;
  if (!i) return { parent: null, subIssues: [], blockedBy: new Map() };
  const subIssues: SubIssueRef[] = [];
  const blockedBy = new Map<number, number[]>();
  for (const s of i.subIssues?.nodes ?? []) {
    if (!s) continue;
    subIssues.push({
      number: s.number,
      title: s.title,
      url: s.url,
      body: s.body ?? "",
      closed: s.state === "CLOSED",
      labels: (s.labels?.nodes ?? []).map((l) => l.name),
    });
    blockedBy.set(
      s.number,
      (s.blockedBy?.nodes ?? []).flatMap((b) => (b ? [b.number] : [])),
    );
  }
  return { parent: mapGqlIssue(i), subIssues, blockedBy };
}

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

/** Cap on pages for the issue-relations scan and listOpenPrLinkedIssues: 2 pages × 100 = ~200,
 *  mirroring the listIssues() 200-open-issue cap. */
const MAX_SUMMARY_PAGES = 2;

/** One repo's open-issue relations, from a single combined scan (#2808): native sub-issue
 *  counts and parent links (served by `listSubIssueSummaries`) plus still-open blockers
 *  (served by `listBlockedByOpen`). */

/** Parse one page of the issue-relations GraphQL response into `into`: every node with
 *  total > 0 into `summaries`, every node with a non-null parent into `subIssueNumbers` and
 *  `childrenByParent` (keyed by parent number), and every node with >=1 still-OPEN blocker
 *  into `blockedByOpen` (issues without one are skipped, keeping the map small). Returns the
 *  page's cursor info. */
function collectIssueRelationsPage(
  out: string,
  into: IssueRelations,
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
            blockedBy?: { nodes?: Array<{ number?: number; state?: string }> };
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
      into.summaries.set(node.number, { total: s.total, completed: s.completed });
    }
    if (node.parent != null) {
      into.subIssueNumbers.add(node.number);
      const siblings = into.childrenByParent.get(node.parent.number) ?? [];
      siblings.push(node.number);
      into.childrenByParent.set(node.parent.number, siblings);
    }
    const openBlockers = (node.blockedBy?.nodes ?? [])
      .filter((b): b is { number: number; state?: string } => typeof b.number === "number")
      .filter((b) => b.state === "OPEN")
      .map((b) => b.number);
    if (openBlockers.length > 0) into.blockedByOpen.set(node.number, openBlockers);
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

/** Shallow per-issue copies, so callers of the shared listIssues cache can annotate their
 *  own view without mutating the cached entries. */
function copyIssues(issues: Issue[]): Issue[] {
  return issues.map((i) => ({ ...i }));
}

/** Runs `gh` with the given args and returns stdout. Injected in tests. */
export type GhRunner = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

/** Cap on concurrent `gh` subprocesses across every GitHub forge call (#2656). Sampled live,
 *  an uncapped server ran up to 26 at once; queued calls wait FIFO for a slot. */
const GH_MAX_CONCURRENCY = 6;

const execGh: GhRunner = async (args) => {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.toString();
};

/**
 * Build the `gh` runner every GitHub forge call goes through (#2656):
 *  - at most `maxConcurrent` subprocesses at once (FIFO queue);
 *  - rate-limit errors are recorded on the bucket the call drew on — GraphQL, REST read or
 *    REST write (#2805: GitHub limits REST writes on a counter of their own) — and a REST
 *    success clears the backoff of its own kind only;
 *  - while the REST read backoff is engaged, REST READS fail fast with a rate-limit error
 *    instead of spawning `gh` into another 403. Writes and GraphQL calls always run: an
 *    operator's write surfaces its own error, and background writers consult
 *    {@link restWriteRateLimit} themselves;
 *  - every GraphQL-bucket call is charged to the spend ledger, and each in-query `rateLimit`
 *    reading goes to the GraphQL tracker and, if it is of the tracker's window, the ledger
 *    (#2840) — the one place readings enter either.
 * Each engagement logs the call and the first stderr line that tripped it.
 * Errors are always re-thrown, so callers' fallbacks and error handling are unchanged.
 * Everything is injectable for tests; production uses {@link sharedGhRunner}.
 */
export function makeGhRunner(
  opts: {
    exec?: GhRunner;
    maxConcurrent?: number;
    graph?: BucketRateLimit;
    rest?: BucketRateLimit;
    restWrite?: BucketRateLimit;
    spend?: GraphqlSpendLedger;
  } = {},
): GhRunner {
  const exec = opts.exec ?? execGh;
  const graph = opts.graph ?? graphRateLimit;
  const rest = opts.rest ?? restRateLimit;
  const restWrite = opts.restWrite ?? restWriteRateLimit;
  const spend = opts.spend ?? graphqlSpend;
  const gate = new Semaphore(opts.maxConcurrent ?? GH_MAX_CONCURRENCY);
  return (args) =>
    timedAsync(`gh ${args[0]}`, () =>
      gate.run(async () => {
        const restRead = isRestReadCall(args);
        // Checked once a slot is ours, so a call queued before the backoff engaged
        // doesn't spawn into it either.
        if (restRead && rest.blocked()) throw restBackoffError(args, rest);
        const restBucket = restRead ? rest : isRestBucketCall(args) ? restWrite : null;
        const graphql = isGraphqlBucketCall(args);
        try {
          const out = await exec(args);
          restBucket?.noteSuccess();
          if (graphql) chargeGraphql(args, out, graph, spend);
          return out;
        } catch (err) {
          if (isRateLimitError(err)) {
            const stderr = String((err as Record<string, unknown>)?.stderr ?? "");
            const bucket = graphql ? graph : restBucket;
            bucket?.noteLimitError(parseRetryAfter(stderr), limitCause(args, stderr));
          } else if (graphql && (err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
            // GitHub answered (an error, or partial data next to one) — and charged for it.
            const stdout = (err as { stdout?: unknown } | null)?.stdout;
            chargeGraphql(args, typeof stdout === "string" ? stdout : null, graph, spend);
          }
          throw err;
        }
      }),
    );
}

/**
 * Charge a finished GraphQL-bucket call (#2840): own `gh api graphql` queries at their in-query
 * `rateLimit.cost`, porcelain calls at the measured table. Then hand the query's reading to the
 * tracker, and to the ledger only if the tracker took it as its window's. Charging first puts a
 * query's own cost inside the interval its reading closes.
 */
function chargeGraphql(
  args: string[],
  stdout: string | null,
  graph: BucketRateLimit,
  spend: GraphqlSpendLedger,
): void {
  if (args[0] !== "api") {
    spend.noteOwnSpend(porcelainCost(args, stdout));
    return;
  }
  const rl = stdout ? parseInQueryRateLimit(stdout) : null;
  spend.noteOwnSpend(rl?.cost ?? 1);
  if (!rl) return;
  if (graph.note({ remaining: rl.remaining, resetAt: rl.resetAt }) && rl.used !== null) {
    spend.noteReading({ used: rl.used, resetAt: rl.resetAt });
  }
}

/** What tripped a backoff, for its "engaged" log: the call (never its flag values) and the
 *  first stderr line. Never `err.message` — that carries the full argv, field bodies included. */
function limitCause(args: string[], stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ? `${ghCallSummary(args)}: ${line.slice(0, 200)}` : ghCallSummary(args);
}

/** The error a skipped REST read throws. Carries "rate limit" in `stderr` like a real `gh`
 *  403, so `isRateLimitError` fallbacks and the `/api/issues` attempt trail treat it the same. */
function restBackoffError(args: string[], rest: BucketRateLimit): Error {
  const until = new Date(rest.snapshot().pausedUntil ?? 0).toISOString();
  const stderr = `REST API rate limit backoff active until ${until}; skipped gh ${args.join(" ")}`;
  return Object.assign(new Error(stderr), { stderr });
}

/** Record `transports` as skipped because BOTH buckets are in backoff, each as a `rate_limit`
 *  attempt whose detail says so, and return the error that describes the skip. */
function recordSkippedTransports(transports: GhTransport[], attempts: GhFetchAttempt[]): Error {
  const until = (rl: BucketRateLimit) => new Date(rl.snapshot().pausedUntil ?? 0).toISOString();
  const stderr = `GitHub rate limit backoff active on both buckets (GraphQL until ${until(graphRateLimit)}, REST until ${until(restRateLimit)}); skipped`;
  const err = Object.assign(new Error(stderr), { stderr });
  for (const t of transports) attempts.push(classifyGhError(t, err));
  return err;
}

/** The process-wide runner: one concurrency cap and one set of bucket trackers for every
 *  GitHub call, whether from a forge or the backlog counts service. */
export const sharedGhRunner: GhRunner = makeGhRunner();

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
    if (
      state === "commented" &&
      (states[author]?.state === "changes_requested" || states[author]?.state === "approved")
    )
      continue;
    states[author] = { state, latestAt: ts };
  }
  return states;
}

interface GhPr {
  author?: { login?: string };
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
  updated_at?: string;
  state?: string | null;
  author_association?: string | null;
  assignees?: Array<{ login?: string | null }> | null;
  user?: { login?: string | null } | null;
  pull_request?: unknown;
}

interface RestCheckRun {
  status?: string | null;
  conclusion?: string | null;
}

interface RestReview {
  user?: { login?: string } | null;
  state?: string;
  body?: string | null;
  submitted_at?: string | null;
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
  /** Own-write generations guard in-flight reads; content keys validate cached data. */
  private issuesCache: GithubCacheEntry<Issue[]> | null = null;
  private issuesInflight: Promise<Issue[]> | null = null;
  private issuesGen = 0;
  /** Per-repo backoff after a failed listing: the last error is replayed until `until`. */
  private issuesFailure: { err: unknown; until: number; strikes: number } | null = null;
  /** getEpicStructure cache + in-flight share, by parent number. Tagged like `issuesCache`;
   *  `epicStructuresGen` bumps on this forge's own writes. `complete`: the structure came from a
   *  read where every call succeeded. `retryAt`: the latest read had a failed call — the entry
   *  is fresh only until then; `failures` counts such reads in a row. */
  private epicStructures = new Map<
    number,
    {
      at: number;
      structure: EpicStructure;
      contentKey: string | null;
      complete: boolean;
      retryAt?: number;
      failures?: number;
    }
  >();
  private epicStructuresInflight = new Map<number, Promise<EpicStructure>>();
  private epicStructuresGen = 0;
  /** {@link issueRelations} cache + in-flight share, validated like `issuesCache`. `relationsGen`
   *  bumps on this forge's own writes that can move relations. */
  private relationsCache: GithubCacheEntry<IssueRelations> | null = null;
  private relationsInflight: Promise<IssueRelations | null> | null = null;
  private relationsGen = 0;
  private linksInflight: Promise<Map<number, LinkedPr[]> | null> | null = null;
  private cacheRevision = 0;
  constructor(
    readonly slug: string,
    private readonly cfg: ForgeConfig,
    private readonly run: GhRunner = sharedGhRunner,
    /** Fork (origin) slug when the repo is a fork (`slug` = upstream). Drives the
     *  fork-aware PR head qualifier and the `canPush` probe target. */
    private readonly forkSlug?: string,
    /** Injected only so tests can drive the merge-async poll loop without real delays. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly readCache?: GithubReadCache,
  ) {
    this.mergeMethod = cfg.mergeMethod ?? "squash";
    this.deployWorkflow = cfg.deployWorkflow ?? null;
    this.forkOwner = forkSlug?.split("/")[0] || undefined;
  }

  private now(): number {
    return this.readCache?.now() ?? Date.now();
  }

  /** A write through another adapter also detaches this adapter's pre-write reads. */
  private syncReadCache(): void {
    const revision = this.readCache?.revision(this.slug) ?? 0;
    if (revision === this.cacheRevision) return;
    this.cacheRevision = revision;
    this.issuesGen++;
    this.epicStructuresGen++;
    this.relationsGen++;
    this.issuesInflight = null;
    this.epicStructuresInflight.clear();
    this.relationsInflight = null;
    this.linksInflight = null;
    this.issuesFailure = null;
    this.issuesCache = null;
    this.epicStructures.clear();
    this.relationsCache = null;
  }

  private issueKey(): string | null {
    return this.readCache
      ? this.readCache.contentKey("issues", this.slug)
      : issuesFreshness(this.slug);
  }

  get webUrl(): string {
    return `https://github.com/${this.slug}`;
  }

  /** The clone's `origin`: the fork in fork mode, otherwise this repository. */
  get originSlug(): string {
    return this.forkSlug ?? this.slug;
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
      ...issueUpdatedAtField(i.updated_at),
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
      baseRefName: pr.base?.ref ?? undefined,
      mergeMethod: this.mergeMethod,
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
        `query=${withRateLimit("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN, first:100){ totalCount nodes{ author{login} title headRefName } } defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}}}")}`,
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
      };
    };

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

  /** Size nested GraphQL connections from existing counts (#2845). Counts are advisory:
   *  a full result grows to the next tier, up to the existing 200-item list cap. */
  private async listOpenCli<T>(kind: "pr" | "issue", fields: string): Promise<T[]> {
    const fp = this.readCache?.get("fingerprint", this.slug)?.value;
    const counts = this.readCache?.get("counts", this.slug)?.value;
    const count =
      kind === "pr" ? (fp?.openPrs ?? counts?.openPRs) : (fp?.openIssues ?? counts?.openIssues);
    const limits = kind === "pr" ? [20, 30, 50, 100, 200] : [50, 100, 200];
    // Five spare slots avoid an extra query at the known count's boundary.
    let tier = count == null ? -1 : limits.findIndex((limit) => limit >= count + 5);
    if (tier === -1) tier = limits.length - 1;
    for (;;) {
      const limit = limits[tier]!;
      const out = await this.run([
        kind,
        "list",
        "--repo",
        this.slug,
        "--state",
        "open",
        "--json",
        fields,
        "--limit",
        String(limit),
      ]);
      const rows = JSON.parse(out || "[]") as T[];
      if (rows.length < limit || tier === limits.length - 1) return rows;
      tier++;
    }
  }

  /** `gh issue list` — the GraphQL-bucket transport for {@link listIssues}. */
  private async listIssuesCli(): Promise<Issue[]> {
    const raw = await this.listOpenCli<{
      number: number;
      title: string;
      body?: string;
      url: string;
      labels?: Array<{ name: string; color?: string }>;
      createdAt?: string;
      updatedAt?: string;
      assignees?: Array<{ login: string }>;
      author?: { login?: string } | null;
    }>("issue", "number,title,body,url,labels,createdAt,updatedAt,assignees,author");
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
        ...issueUpdatedAtField(i.updatedAt),
        assignees: (i.assignees ?? []).map((a) => a.login),
        author: i.author?.login,
      };
    });
  }

  /**
   * Open issues, served from a cache shared by every caller of this forge (#2656): the issues
   * panel, the epics routes, the completed-epics band, the drain and Up Next each list the same
   * repo independently. Concurrent calls share one in-flight fetch; a failure is not cached.
   * Each caller gets shallow copies, so one consumer annotating an issue (e.g. `blockedBy`)
   * can't leak into another's view. This forge's own issue writes clear the cache
   * ({@link invalidateIssues}).
   *
   * While the repo fingerprint covers this slug (#2756), an entry stays valid until the slug's
   * issue content key moves — no timed re-list. The entry is tagged with the key seen when
   * its fetch STARTED, so a change landing mid-fetch leaves it stale for the next read.
   * Uncovered slugs keep the {@link ISSUES_CACHE_TTL_MS} expiry.
   */
  async listIssues(): Promise<Issue[]> {
    this.syncReadCache();
    const fpKey = this.issueKey();
    const hit = this.readCache ? this.readCache.get("issues", this.slug) : this.issuesCache;
    const fresh =
      hit !== null &&
      (fpKey !== null ? hit.contentKey === fpKey : this.now() - hit.at < ISSUES_CACHE_TTL_MS);
    if (fresh) {
      if (this.readCache?.expired(hit) && this.readCache.canRefresh())
        void this.loadIssues(fpKey).catch(() => {});
      return copyIssues(hit.value);
    }
    return copyIssues(await this.loadIssues(fpKey));
  }

  private loadIssues(fpKey: string | null): Promise<Issue[]> {
    const fail = this.issuesFailure;
    if (fail && this.now() < fail.until) return Promise.reject(fail.err);
    if (!this.issuesInflight) {
      const gen = this.issuesGen;
      const revision = this.readCache?.revision(this.slug);
      const p = this.fetchIssues()
        .then(
          (issues) => {
            if (gen === this.issuesGen && revision === this.readCache?.revision(this.slug)) {
              this.issuesCache = { at: this.now(), value: issues, contentKey: fpKey };
              this.readCache?.put("issues", this.slug, fpKey, issues);
              this.issuesFailure = null;
            }
            return issues;
          },
          (err: unknown) => {
            if (gen === this.issuesGen) this.noteIssuesFailure(err);
            throw err;
          },
        )
        .finally(() => {
          if (this.issuesInflight === p) this.issuesInflight = null;
        });
      this.issuesInflight = p;
    }
    return this.issuesInflight;
  }

  private invalidateIssues(): void {
    this.issuesGen++;
    this.issuesCache = null;
    this.issuesInflight = null;
    this.issuesFailure = null;
    this.readCache?.invalidate(this.slug, ["issues", "counts"]);
    this.invalidateEpicStructures();
    this.invalidateRelations();
  }

  private invalidateEpicStructures(): void {
    this.epicStructuresGen++;
    this.epicStructures.clear();
    this.epicStructuresInflight.clear();
    this.readCache?.invalidate(this.slug, ["epic"]);
  }

  private invalidateRelations(): void {
    this.relationsGen++;
    this.relationsCache = null;
    this.relationsInflight = null;
    this.readCache?.invalidate(this.slug, ["relations"]);
  }

  private invalidatePrs(): void {
    this.linksInflight = null;
    this.readCache?.invalidate(this.slug, ["prs", "counts", "links", "session"]);
  }

  /** Open (or extend) the per-repo backoff after a failed listing (#2656): a repo that keeps
   *  failing — unresolvable, 404, auth — was re-listed on every cycle of every caller. The
   *  window doubles per consecutive failure, and each window logs one line; pure rate-limit
   *  failures stay quiet here, since the bucket trackers already log those edges. */
  private noteIssuesFailure(err: unknown): void {
    const strikes = (this.issuesFailure?.strikes ?? 0) + 1;
    const ms = Math.min(
      ISSUES_FAILURE_BACKOFF_MS * 2 ** (strikes - 1),
      ISSUES_FAILURE_BACKOFF_MAX_MS,
    );
    const until = this.now() + ms;
    this.issuesFailure = { err, until, strikes };
    const attempts = attemptsOf(err) ?? [];
    if (attempts.every((a) => a.reason === "rate_limit") && attempts.length > 0) return;
    const why = attempts.map((a) => `${a.transport}: ${a.reason}`).join(", ") || String(err);
    console.warn(
      `[github] ${this.slug} issue listing failed (${why}); next attempt after ${new Date(until).toISOString()}`,
    );
  }

  /**
   * Open issues over whichever transport answers.
   *
   * `gh issue list` (GraphQL bucket) and `gh api` (REST bucket) draw on two
   * INDEPENDENT GitHub budgets, so either can be exhausted while the other is
   * healthy. `gh api rate_limit` does not settle it either — that endpoint is
   * itself limit-exempt and happily reports a full REST budget while every real
   * REST call 403s. So a failure on the preferred transport always tries the
   * other one before giving up.
   *
   * Two deliberate widenings over the previous one-way (GraphQL→REST) fallback:
   *  - ANY error retries on the other transport, not only `isRateLimitError`.
   *    The old narrowing left a REST 403 raised *during* a GraphQL backoff with
   *    no recovery at all: the operator saw "couldn't load issues" while
   *    `gh issue list` would have answered. The cost is one extra doomed call on
   *    a genuinely broken setup (gh missing, repo unresolvable) — error path only.
   *  - The REST→CLI direction knowingly issues a GraphQL call inside an active
   *    backoff window. REST has just proved unusable, the backoff is only a
   *    heuristic, and a real GraphQL rate-limit error re-extends the window by
   *    itself (the shared runner records it on `graphRateLimit`).
   *
   * One narrowing (#2656): while BOTH buckets are in backoff, no transport runs —
   * either would only spawn `gh` into another limit error. That covers a REST 403
   * inside a GraphQL backoff too: the CLI fallback is skipped instead of doubling
   * every failing cycle.
   *
   * Both failing rethrows the PREFERRED transport's error — it describes the path
   * we expected to work, so it is the more useful diagnosis. Every transport that
   * actually ran and failed is recorded on that error ({@link attachAttempts}) so
   * `/api/issues` can name the paths instead of leaving the operator to guess at a
   * rate limit. The trail is built as we go, so it always describes what was really
   * attempted; a transport skipped for the double backoff is recorded as a
   * `rate_limit` whose detail says so.
   */
  private async fetchIssues(): Promise<Issue[]> {
    const order: GhTransport[] = graphRateLimit.blocked() ? ["rest", "cli"] : ["cli", "rest"];
    const attempts: GhFetchAttempt[] = [];
    let preferredErr: unknown;
    for (const [i, transport] of order.entries()) {
      if (graphRateLimit.blocked() && restRateLimit.blocked()) {
        preferredErr ??= recordSkippedTransports(order.slice(i), attempts);
        break;
      }
      try {
        return await (transport === "rest" ? this.listIssuesRest() : this.listIssuesCli());
      } catch (err) {
        attempts.push(classifyGhError(transport, err));
        if (i === 0) preferredErr = err;
      }
    }
    throw attachAttempts(preferredErr, attempts);
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
        `query=${withRateLimit(`query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){${GQL_ISSUE_FIELDS}}}}`)}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `num=${issueNumber}`,
      ]);
      const i = (
        JSON.parse(out || "null") as {
          data?: { repository?: { issue?: GqlIssue | null } };
        } | null
      )?.data?.repository?.issue;
      return i ? mapGqlIssue(i) : null;
    } catch (err) {
      if (isRateLimitError(err)) return this.getIssueRest(issueNumber);
      return null;
    }
  }

  private async getIssueRest(issueNumber: number): Promise<Issue | null> {
    return this.fetchIssueRest(issueNumber).catch(() => null);
  }

  /** {@link getIssueRest} without the error swallowing. */
  private async fetchIssueRest(issueNumber: number): Promise<Issue | null> {
    const out = await this.run(this.restGetArgs(`repos/${this.slug}/issues/${issueNumber}`));
    const issue = JSON.parse(out || "null") as RestIssue | null;
    if (!issue || issue.pull_request != null) return null;
    return { ...this.mapRestIssue(issue), ...issueStateField(issue.state) };
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
      baseRefName: p.baseRefName,
      mergeMethod: this.mergeMethod,
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

  async listCommitChecks(headShas: string[]): Promise<Map<string, ChecksState>> {
    const heads = [...new Set(headShas)];
    if (heads.length === 0) return new Map();
    const rest = async () =>
      new Map(
        await mapBounded(
          heads,
          6,
          async (sha) => [sha, await this.restChecksForHead(sha)] as const,
        ),
      );
    if (graphRateLimit.blocked()) return rest();

    const [owner, name] = this.slug.split("/");
    const vars = ["$owner:String!", "$name:String!"];
    const fields: string[] = [];
    const args = ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`];
    heads.forEach((sha, i) => {
      vars.push(`$h${i}:GitObjectID!`);
      fields.push(`c${i}:object(oid:$h${i}){... on Commit{statusCheckRollup{state}}}`);
      args.push("-f", `h${i}=${sha}`);
    });
    args.push(
      "-f",
      `query=${withRateLimit(`query(${vars.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`)}`,
    );
    let out: string;
    try {
      out = await this.run(args);
    } catch (err) {
      if (isRateLimitError(err)) return rest();
      throw err;
    }
    const raw = JSON.parse(out || "{}") as {
      data?: {
        repository?: Record<
          string,
          { statusCheckRollup?: { state?: string } | null } | null
        > | null;
      };
    };
    const checks = new Map<string, ChecksState>();
    heads.forEach((sha, i) => {
      const commit = raw.data?.repository?.[`c${i}`];
      if (commit) checks.set(sha, mapStatusState(commit.statusCheckRollup?.state));
    });
    return checks;
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
    await this.run(args).finally(() => this.invalidatePrs());
  }

  async cancelWorkflowRun(runId: number): Promise<void> {
    await this.run(["run", "cancel", String(runId), "--repo", this.slug]).finally(() =>
      this.invalidatePrs(),
    );
  }

  /** Default-branch runs in any status with id > `sinceId` — one REST page (100, newest-first),
   *  no status filter so an in-flight run stays visible to the caller's cursor barrier. Summary
   *  rows: `jobs` omitted (see {@link runJobs}). Default-branch lookup failure → [] (fail-quiet,
   *  like {@link listWorkflowRuns}). */
  async listDefaultBranchRuns(o: { sinceId?: number }): Promise<ForgeRun[]> {
    const branch = await this.defaultBranch().catch(() => null);
    if (!branch) return [];
    const out = await this.run([
      "api",
      `repos/${this.slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
    ]);
    const parsed = JSON.parse(out || "{}") as { workflow_runs?: GhApiRun[] };
    const sinceId = o.sinceId ?? 0;
    return (parsed.workflow_runs ?? []).filter((r) => r.id > sinceId).map((r) => mapGhApiRun(r));
  }

  /** One run with its jobs, fresh. A 404 (unknown / deleted run) → null. */
  async getRunDetail(runId: number): Promise<ForgeRun | null> {
    let out: string;
    try {
      out = await this.run(["api", `repos/${this.slug}/actions/runs/${runId}`]);
    } catch (e) {
      if (/HTTP 404|Not Found/.test(String((e as { stderr?: unknown })?.stderr ?? e))) return null;
      throw e;
    }
    const raw = JSON.parse(out || "{}") as GhApiRun;
    return mapGhApiRun(raw, await this.runJobs(runId));
  }

  async runJobs(runId: number): Promise<ForgeRunJob[]> {
    const out = await this.run([
      "api",
      `repos/${this.slug}/actions/runs/${runId}/jobs?per_page=100`,
    ]);
    const parsed = JSON.parse(out || "{}") as {
      jobs?: Array<{ id?: number; name?: string; conclusion?: string | null }>;
    };
    return (parsed.jobs ?? []).map((j) => ({
      id: j.id ?? 0,
      name: j.name ?? "",
      conclusion: j.conclusion ?? null,
    }));
  }

  /** Failed steps' log lines via `gh run view --log-failed` (lines `job\tstep\t<text>`). */
  async failedRunStepLogs(
    runId: number,
  ): Promise<{ job: string; step: string; lines: string[] }[]> {
    const out = await this.run(["run", "view", String(runId), "--repo", this.slug, "--log-failed"]);
    return parseFailedLog(out);
  }

  /** Map a raw GhPr node to a PrStatus. Shared by prStatus (single-PR path) and
   *  listOpenPrStatuses (batch path) so both produce identical field values. */
  private mapGhPr(pr: GhPr, deployConfigured: boolean): PrStatus {
    const state = pr.state.toLowerCase() as PrStatus["state"];
    const createdAt = Date.parse(pr.createdAt ?? "");
    const running = runningCheckNames(pr.statusCheckRollup ?? []);
    const jobs = jobsFromRollup(pr.statusCheckRollup ?? []);
    return {
      state: state === "open" || state === "merged" || state === "closed" ? state : "none",
      number: pr.number,
      url: pr.url,
      title: pr.title,
      authorLogin: pr.author?.login,
      isFork: this.isFork,
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      mergeable: mapMergeable(pr.mergeable),
      mergeStateStatus: mapMergeStateStatus(pr.mergeStateStatus),
      isDraft: pr.isDraft ?? false,
      checks: rollupChecks(pr.statusCheckRollup ?? []),
      runningChecks: running.length ? running : undefined,
      jobs: jobs.length ? jobs : undefined,
      headSha: pr.headRefOid,
      baseRefName: pr.baseRefName,
      latestReview: latestHumanReview(pr.reviews),
      reviewerStates: reviewerStatesFromReviews(pr.reviews),
      requestedReviewers: (pr.reviewRequests ?? [])
        .map((r) => r.login)
        .filter((l): l is string => !!l),
      deployConfigured,
      mergeMethod: this.mergeMethod,
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
      authorLogin: pr.user?.login ?? undefined,
      isFork: this.isFork,
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
      mergeMethod: this.mergeMethod,
    };
  }

  private async restReviewStatus(
    prNumber: number,
  ): Promise<Pick<PrStatus, "latestReview" | "reviewerStates">> {
    const out = await this.run([
      "api",
      "--paginate",
      "--slurp",
      `repos/${this.slug}/pulls/${prNumber}/reviews`,
    ]);
    const pages = JSON.parse(out || "[]") as RestReview[][];
    const reviews: GhReview[] = pages.flat().map((review) => ({
      author: review.user ?? undefined,
      state: review.state,
      body: review.body ?? undefined,
      submittedAt: review.submitted_at ?? undefined,
    }));
    return {
      latestReview: latestHumanReview(reviews),
      reviewerStates: reviewerStatesFromReviews(reviews),
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

    await mapBounded([...statuses.values()], 6, async (status) => {
      Object.assign(status, await this.restReviewStatus(status.number!));
    });
    return { prs: pullRequests, statuses, capped, source: "rest" };
  }

  /** REST fallback for the herd's per-session PR status when GitHub's GraphQL
   *  bucket is exhausted. It intentionally returns the same PrStatus shape but
   *  only does extra REST check/status reads for open PRs. Reviews use the same
   *  human-review mapping as GraphQL so fallback cannot erase handoff decisions. */
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
    return {
      ...this.mapRestPull(pr, deployConfigured, checks),
      ...(await this.restReviewStatus(pr.number)),
    };
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
        "number,url,title,state,author,createdAt,mergeable,mergeStateStatus,isDraft,statusCheckRollup,headRefOid,baseRefName,reviews,reviewRequests,headRepositoryOwner",
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
    let prs: Array<
      GhPr & { author?: { login?: string } | null; labels?: Array<{ name?: string }> }
    >;
    try {
      prs = await this.listOpenCli(
        "pr",
        "number,url,title,state,author,createdAt,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviews,reviewRequests,headRefName,headRefOid,baseRefName,labels,headRepositoryOwner",
      );
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
   *  branch name, fetched in a `gh pr list --state open` batch — the per-repo
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
    const fp = this.readCache?.get("fingerprint", this.slug);
    if (fp) return fp.value.openPrs;
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

  /** `gh api user` — the REST-bucket transport for {@link currentUser}. */
  private async currentUserRest(): Promise<string | null> {
    return (await this.run(["api", "user", "--jq", ".login"])).trim() || null;
  }

  /** `gh api graphql {viewer{login}}` — the GraphQL-bucket transport for
   *  {@link currentUser}. */
  private async currentUserGraphql(): Promise<string | null> {
    const out = await this.run([
      "api",
      "graphql",
      "-f",
      `query=${withRateLimit("query{viewer{login}}")}`,
    ]);
    const json = JSON.parse(out || "null") as { data?: { viewer?: { login?: string } } } | null;
    return json?.data?.viewer?.login?.trim() || null;
  }

  /**
   * The authenticated gh login, over whichever transport answers.
   *
   * REST first (`gh api user`), then GraphQL (`{viewer{login}}`) on ANY failure or on
   * an answer that carries no login. The two draw on INDEPENDENT GitHub budgets, so
   * either can be exhausted while the other is healthy — observed live on #2139, where
   * every REST call 403'd while `gh api graphql` answered normally. The order is fixed
   * rather than flipped on `graphRateLimit.blocked()` the way `listIssues` does it:
   * that signal describes the GraphQL bucket only, and there is no REST-side tracker to
   * argue for GraphQL-first. The fallback runs even inside an active GraphQL backoff —
   * REST has just proved unusable and the backoff is only a heuristic (the same
   * trade-off `listIssues`' REST→CLI direction makes).
   *
   * A resolved login is cached for the forge's lifetime; a failure only until a short
   * TTL elapses. See {@link makeUserCache} for why the failure must stay retryable.
   */
  private readonly resolveUser = makeUserCache(async () => {
    const rest = await this.currentUserRest().catch(() => null);
    return rest ?? (await this.currentUserGraphql());
  });

  async currentUser(): Promise<string | null> {
    if (!this.readCache) return this.resolveUser();
    const hit = this.readCache.get("viewer", "");
    if (hit) {
      if (this.readCache.expired(hit) && this.readCache.canRefresh()) void this.refreshUser();
      return hit.value;
    }
    return this.refreshUser();
  }

  private userInflight: Promise<string | null> | null = null;
  private userFailureUntil = 0;

  private refreshUser(): Promise<string | null> {
    if (this.now() < this.userFailureUntil) return Promise.resolve(null);
    if (!this.userInflight) {
      const p = this.currentUserRest()
        .catch(() => null)
        .then((rest) => rest ?? this.currentUserGraphql())
        .catch(() => null)
        .then((login) => {
          if (login) this.readCache?.put("viewer", "", null, login);
          else this.userFailureUntil = this.now() + ISSUES_FAILURE_BACKOFF_MS;
          return login;
        })
        .finally(() => {
          if (this.userInflight === p) this.userInflight = null;
        });
      this.userInflight = p;
    }
    return this.userInflight;
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

  async listCollaborators(): Promise<{
    logins: string[];
    unavailable: boolean;
    source?: "collaborators" | "assignees";
  }> {
    for (const source of ["collaborators", "assignees"] as const) {
      try {
        const out = await this.run([
          "api",
          "--paginate",
          `repos/${this.slug}/${source}`,
          "--jq",
          ".[].login",
        ]);
        const people = new Map<string, string>();
        for (const line of out.split("\n")) {
          const login = line.trim();
          if (login && !people.has(login.toLowerCase())) people.set(login.toLowerCase(), login);
        }
        const logins = [...people.values()].sort((a, b) =>
          a.toLowerCase().localeCompare(b.toLowerCase()),
        );
        return { logins, unavailable: false, source };
      } catch {
        // Contributors may read assignees even when GitHub refuses collaborators.
      }
    }
    return { logins: [], unavailable: true };
  }

  async requestReview(prNumber: number, reviewer: string): Promise<void> {
    try {
      await this.run([
        "api",
        "--method",
        "POST",
        `repos/${this.slug}/pulls/${prNumber}/requested_reviewers`,
        "-f",
        `reviewers[]=${reviewer}`,
      ]);
    } catch (error) {
      const { status } = classifyGhError("rest", error);
      throw new Error(
        status === 403
          ? "review_request_forbidden"
          : status === 422
            ? "review_request_invalid_reviewer"
            : "review_request_failed",
        { cause: error },
      );
    } finally {
      this.invalidatePrs();
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
    } finally {
      this.invalidatePrs();
    }
    return this.prStatus(o.head);
  }

  async markReady(prNumber: number): Promise<void> {
    await this.run(["pr", "ready", String(prNumber), "--repo", this.slug]).finally(() =>
      this.invalidatePrs(),
    );
  }

  async convertToDraft(prNumber: number): Promise<void> {
    await this.run(["pr", "ready", String(prNumber), "--repo", this.slug, "--undo"]).finally(() =>
      this.invalidatePrs(),
    );
  }

  async closePr(prNumber: number): Promise<void> {
    await this.run(["pr", "close", String(prNumber), "--repo", this.slug]).finally(() =>
      this.invalidatePrs(),
    );
  }

  async createIssue(o: { title: string; body: string }): Promise<{ number: number; url: string }> {
    // `gh issue create` echoes the new issue's URL on stdout (…/issues/<n>).
    let out: string;
    try {
      out = await this.run([
        "issue",
        "create",
        "--repo",
        this.slug,
        "--title",
        o.title,
        "--body",
        o.body,
      ]);
    } finally {
      this.invalidateIssues();
    }
    const url = out.trim();
    const n = Number(url.match(/\/(\d+)\s*$/)?.[1]);
    if (!Number.isInteger(n)) throw new Error(`could not parse issue number from URL: ${url}`);
    return { number: n, url };
  }

  /** Land a PR. Resolving means exactly one thing: it merged. Every other outcome throws —
   *  see {@link MergeNotCompletedError} for the ones that are not failures.
   *
   *  Stacked PRs (#2059) cannot go through the legacy synchronous merge at all: `PUT
   *  /pulls/{n}/merge`, the `mergePullRequest` mutation, and `gh pr merge` on top of them all
   *  refuse. They are routed to the async merge API instead, and only when the caller opted in. */
  async merge(prNumber: number, o: MergeInput): Promise<void> {
    try {
      await this.mergeAny(prNumber, o);
    } finally {
      // A merge into the default branch closes the issues it fixes — epic children among them.
      this.invalidateIssues();
      this.invalidatePrs();
    }
  }

  private async mergeAny(prNumber: number, o: MergeInput): Promise<void> {
    const probe = await this.probeStack(prNumber);
    if (probe.stacked) return this.mergeStacked(prNumber, o, probe);
    const method =
      o.method === "rebase" ? "--rebase" : o.method === "merge" ? "--merge" : "--squash";
    const args = ["pr", "merge", String(prNumber), "--repo", this.slug, method];
    if (o.deleteBranch) args.push("--delete-branch");
    // Optimistic-concurrency guard (#2299): the host refuses the merge when the head moved since
    // the operator confirmed it, so a push landing between dialog and confirm can never be merged
    // unreviewed. The stacked path below carries the same guard as merge-async's `sha`.
    if (o.expectedHeadSha) args.push("--match-head-commit", o.expectedHeadSha);
    await this.run(args);
  }

  /** The stack `prNumber` belongs to, or null when it belongs to none (#2068).
   *
   *  Reads the STACK resource (`GET /stacks?pull_request=`) rather than the `.stack` object
   *  embedded in the pull request, because only the stack resource carries `pull_requests` — the
   *  membership list is the whole point of this read. The sibling {@link probeStack} takes the
   *  other route for the opposite reason: the merge path needs the head SHA, which lives on the
   *  pull request and not on the stack.
   *
   *  FAILS OPEN to null, exactly as {@link probeStack} does — see its note. A stack whose trunk
   *  the host did not report is also null: `baseRef` is the load-bearing field, and handing a
   *  caller an empty ref to interpolate or compare against is worse than reporting nothing.
   *
   *  NEVER shells out to `gh stack`: under a PTY it opens a full-screen TUI and would wedge an
   *  unattended agent. Every stack call in this file is a `gh api` call. */
  async stackForPr(prNumber: number): Promise<StackInfo | null> {
    try {
      // Projected as an ARRAY so the unstacked case (`[]`) stays valid jq input and parses to [].
      const out = await this.run([
        "api",
        `repos/${this.slug}/stacks?pull_request=${prNumber}`,
        "--jq",
        `[.[] | ${STACK_JQ}]`,
      ]);
      const stacks = JSON.parse(out || "[]") as Partial<StackInfo>[];
      const info = stackInfoFrom(stacks[0]);
      // Membership is re-checked locally rather than taken on trust: were the `pull_request=`
      // filter ever dropped or ignored host-side, the endpoint would answer with SOME OTHER
      // stack in the repo, and reporting that one as this PR's stack is the one failure mode
      // worse than reporting nothing.
      const at = info ? info.prNumbers.indexOf(prNumber) : -1;
      if (!info || at < 0) return null;
      return { ...info, position: at + 1, size: info.prNumbers.length };
    } catch (err) {
      console.warn(`[github] stack read failed for pr#${prNumber}; assuming unstacked:`, err);
      return null;
    }
  }

  /** Link `prNumbers` (BOTTOM → TOP) into a new stack. A mutation: host errors propagate, and an
   *  unreadable response body throws rather than reporting a stack nobody can address later. */
  async createStack(prNumbers: number[]): Promise<StackInfo> {
    const out = await this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/stacks`,
      "--jq",
      STACK_JQ,
      ...prNumbers.flatMap((n) => ["-F", `pull_requests[]=${n}`]),
    ]).finally(() => this.invalidatePrs());
    const info = stackInfoFrom(JSON.parse(out || "null") as Partial<StackInfo> | null);
    if (!info) throw new Error(`create stack for #${prNumbers.join(", #")} returned no stack`);
    return { ...info, size: info.prNumbers.length };
  }

  /** Append one pull request to the TOP of an existing stack. Mutation — errors propagate. */
  async addToStack(stackNumber: number, prNumber: number): Promise<void> {
    await this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/stacks/${stackNumber}/add`,
      "-F",
      `pull_requests[]=${prNumber}`,
    ]).finally(() => this.invalidatePrs());
  }

  /** Dissolve a stack. Its unmerged pull requests are unlinked; merged or merge-queued ones stay
   *  linked host-side. The only repair primitive there is — no reorder/insert/drop-one API
   *  exists, so a stack that needs reshaping is unstacked and recreated. Mutation — errors
   *  propagate. */
  async unstack(stackNumber: number): Promise<void> {
    await this.run([
      "api",
      "--method",
      "POST",
      `repos/${this.slug}/stacks/${stackNumber}/unstack`,
    ]).finally(() => this.invalidatePrs());
  }

  /** Stack membership, head SHA and the stack's trunk in one REST call, narrowed with `--jq` so
   *  the payload stays small. The trunk rides along for free: `.stack` is taken wholesale and
   *  GitHub puts `base: { ref, sha }` on it.
   *
   *  FAILS OPEN. A probe error (rate limit, transient 5xx) reports "unstacked", which routes the
   *  merge down the legacy path — i.e. precisely today's behaviour, so a probe failure can never
   *  be a regression. The cost of the opposite choice (fail closed) would be blocking every merge
   *  in Shepherd on one flaky REST call. */
  private async probeStack(prNumber: number): Promise<StackProbe> {
    try {
      const out = await this.run([
        "api",
        `repos/${this.slug}/pulls/${prNumber}`,
        "--jq",
        "{stack: .stack, sha: .head.sha}",
      ]);
      const p = JSON.parse(out || "{}") as {
        stack?: { position?: number; size?: number; base?: { ref?: string } | null } | null;
        sha?: string | null;
      };
      return {
        stacked: !!p.stack,
        position: p.stack?.position,
        size: p.stack?.size,
        sha: p.sha ?? undefined,
        stackBase: p.stack?.base?.ref ?? undefined,
      };
    } catch (err) {
      console.warn(`[github] stack probe failed for pr#${prNumber}; assuming unstacked:`, err);
      return { stacked: false };
    }
  }

  /** Land a stacked PR through the async merge API — the only path GitHub supports for a stack.
   *
   *  Merging this layer also lands EVERY unmerged layer below it, atomically, so the caller must
   *  opt in via `allowStacked`; autonomous callers deliberately do not, and get a refusal before
   *  anything is mutated.
   *
   *  `o.deleteBranch` is deliberately IGNORED here. merge-async takes no delete-branch parameter,
   *  and deleting a merged layer's branch could pull the rug from under a layer still based on it
   *  while GitHub's auto-restack is in flight. The remote branch therefore lingers — BranchPruner
   *  only sweeps LOCAL `shepherd/*` branches, so nothing reaps it — which is harmless, and safer
   *  than the alternative. */
  private async mergeStacked(prNumber: number, o: MergeInput, probe: StackProbe): Promise<void> {
    if (!o.allowStacked) throw new StackedMergeRefusedError(prNumber, probe.position, probe.size);
    const body = await this.putMergeAsync(prNumber, o, probe);
    if (this.mergeAsyncSettled(prNumber, body)) return;
    const uuid = mergeAsyncUuid(body);
    if (!uuid) {
      throw new Error(
        `merge-async for #${prNumber} returned neither a terminal status nor a uuid to poll`,
      );
    }
    await this.pollMergeAsync(prNumber, uuid);
  }

  /** Does the stack's trunk require a merge queue? A `merge_queue` rule there makes
   *  `merge_method` illegal on the merge request (#2062), so the answer decides the PUT's shape.
   *
   *  FAILS OPEN, for the same reason {@link probeStack} does: an unknown answer keeps today's
   *  request shape, so a flaky rules call can never be worse than not asking at all. An unknown
   *  trunk is NOT substituted with the PR's own base — for a layer above the bottom that is the
   *  layer below, and asking about it would answer a different question than the one that
   *  matters. */
  private async requiresMergeQueue(stackBase: string | undefined): Promise<boolean> {
    if (!stackBase) return false;
    if (!isPathSafeRef(stackBase)) {
      console.warn(`[github] stack base ${JSON.stringify(stackBase)} is not a probeable ref`);
      return false;
    }
    try {
      const out = await this.run([
        "api",
        `repos/${this.slug}/rules/branches/${stackBase}`,
        "--jq",
        '[.[] | select(.type == "merge_queue")] | length',
      ]);
      return Number(out.trim()) > 0;
    } catch (err) {
      console.warn(`[github] merge-queue probe failed for ${stackBase}; assuming none:`, err);
      return false;
    }
  }

  /** PUT the merge request. On a 409 ("a merge request is already in flight for this PR") the
   *  body still carries that request's uuid — adopt it so a retry JOINS the in-flight merge
   *  instead of racing or erroring. Any other failure with no uuid to adopt is re-thrown.
   *
   *  Under a required merge queue the host rejects `merge_method` outright, so the queue case
   *  sends an explicit `merge_action=merge_queue` and no merge params at all — the queue's own
   *  configured method governs. Explicit rather than implicit: were the probe ever wrong about
   *  the trunk, this fails as a 422 at request time instead of merging under a method nobody
   *  chose. Both shapes keep the `sha` guard. */
  private async putMergeAsync(
    prNumber: number,
    o: MergeInput,
    probe: StackProbe,
  ): Promise<MergeAsyncBody | null> {
    const queued = await this.requiresMergeQueue(probe.stackBase);
    const args = [
      "api",
      "--method",
      "PUT",
      `repos/${this.slug}/pulls/${prNumber}/merge-async`,
      "-f",
      queued ? "merge_action=merge_queue" : `merge_method=${o.method}`,
    ];
    // Optimistic-concurrency guard: the host rejects the merge if the head moved under us. The
    // operator-confirmed revision (#2299) wins over the freshly probed one — the probe re-reads the
    // head, so on its own it would happily guard a revision nobody confirmed.
    const sha = o.expectedHeadSha ?? probe.sha;
    if (sha) args.push("-f", `sha=${sha}`);
    try {
      return parseMergeAsyncBody(await this.run(args));
    } catch (err) {
      const body = parseMergeAsyncBody((err as { stdout?: unknown }).stdout);
      if (!mergeAsyncUuid(body)) throw err;
      return body;
    }
  }

  /** Poll one merge request to a terminal state. Transport errors are swallowed and retried —
   *  a mid-poll 5xx means "we don't know yet", NOT "the merge failed"; a genuine failure arrives
   *  as `status: "failed"` in a 200 body. Exhausting the budget is non-destructive: the merge
   *  continues host-side and the PR poller reconciles. */
  private async pollMergeAsync(prNumber: number, uuid: string): Promise<void> {
    const path = `repos/${this.slug}/pulls/${prNumber}/merge-async/${uuid}`;
    for (let i = 0; i < MERGE_ASYNC_POLL_ATTEMPTS; i++) {
      await this.sleep(MERGE_ASYNC_POLL_MS);
      let body: MergeAsyncBody | null;
      try {
        body = parseMergeAsyncBody(await this.run(["api", path]));
      } catch (err) {
        console.warn(`[github] merge-async poll failed for pr#${prNumber}:`, err);
        continue;
      }
      if (this.mergeAsyncSettled(prNumber, body)) return;
    }
    throw new MergePendingError(prNumber);
  }

  /** Read one merge-async body. Returns true when the PR is merged, false when still pending;
   *  throws on the terminal non-merged outcomes. */
  private mergeAsyncSettled(prNumber: number, body: MergeAsyncBody | null): boolean {
    switch (body?.status) {
      case "merged":
        return true;
      case "enqueued":
        // Terminal for the merge REQUEST — stop polling — but the PR has NOT landed.
        throw new MergeEnqueuedError(prNumber);
      case "failed":
        throw new Error(
          `merge of #${prNumber} failed: ${body.details?.message ?? "no reason reported"}`,
        );
      default:
        return false; // "pending", or a status this preview feature added after us
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    try {
      await this.run(["issue", "close", String(issueNumber), "--repo", this.slug]);
    } finally {
      this.invalidateIssues();
    }
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    await this.run([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      this.slug,
      "--body",
      body,
    ]).finally(() => this.invalidateIssues());
  }

  async comment(prNumber: number, body: string): Promise<void> {
    await this.run([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      this.slug,
      "--body",
      body,
    ]).finally(() => this.invalidatePrs());
  }

  async editPr(prNumber: number, o: { title?: string; body?: string }): Promise<void> {
    const args = ["pr", "edit", String(prNumber), "--repo", this.slug];
    if (o.title !== undefined) args.push("--title", o.title);
    if (o.body !== undefined) args.push("--body", o.body);
    if (args.length === 5) return; // no title/body provided — nothing to edit
    await this.run(args).finally(() => this.invalidatePrs());
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
    await this.run([
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      this.slug,
      "--body",
      newBody,
    ]).finally(() => this.invalidatePrs());
  }

  async addIssueLabel(issueNumber: number, label: string): Promise<void> {
    // `gh issue edit --add-label` 422s on a label the repo hasn't defined. The
    // operator creates the opt-in label, but the claim label is ours — create it
    // first (ignoring "already exists") so the claim doesn't fail on a fresh repo.
    await this.ensureLabel(label);
    try {
      await this.run([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        this.slug,
        "--add-label",
        label,
      ]);
    } finally {
      this.invalidateIssues();
    }
  }

  async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.run([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        this.slug,
        "--remove-label",
        label,
      ]);
    } finally {
      this.invalidateIssues();
    }
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
    await this.run(["workflow", "run", o.workflow, "--repo", this.slug, "--ref", o.ref]).finally(
      () => this.invalidatePrs(),
    );
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
        ]).finally(() => this.invalidatePrs());
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
    ]).finally(() => this.invalidatePrs());
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

  /**
   * The epic's structure in ONE GraphQL query (#2807) instead of N + 2 calls. Cached per parent
   * like {@link listIssues}: while the repo fingerprint covers the slug, until its issue
   * content key moves (closing a blocker moves it); otherwise for {@link EPIC_STRUCTURE_TTL_MS}.
   * This forge's own writes (claim labels, closes, merges, sub-issue and dependency links) clear
   * it, and concurrent callers share one read.
   *
   * With GraphQL in backoff, or failing, it reads the parts over REST instead. That result is
   * cached the same way, so the fallback runs at most once per cache window. A REST read with a
   * failed call in it is not: a failed call reads as "no sub-issues" or "no blockers", which
   * would let the drain spawn a blocked child. It keeps serving the last complete structure if
   * there is one (the partial one if not) and retries after {@link EPIC_STRUCTURE_RETRY_MS},
   * backing off while the failures persist.
   */
  async getEpicStructure(parentNumber: number): Promise<EpicStructure> {
    this.syncReadCache();
    const fpKey = this.issueKey();
    const now = this.now();
    const persisted = this.readCache?.get("epic", this.slug, String(parentNumber));
    if (persisted && !this.epicStructures.has(parentNumber))
      this.epicStructures.set(parentNumber, {
        at: persisted.at,
        structure: persisted.value,
        contentKey: persisted.contentKey,
        complete: true,
      });
    const hit = this.epicStructures.get(parentNumber);
    const fresh =
      hit !== undefined &&
      (hit.retryAt !== undefined
        ? now < hit.retryAt
        : fpKey !== null
          ? hit.contentKey === fpKey
          : now - hit.at < EPIC_STRUCTURE_TTL_MS);
    if (fresh) {
      if (
        persisted &&
        this.readCache?.expired(persisted) &&
        this.readCache.canRefresh() &&
        (hit.retryAt === undefined || now >= hit.retryAt)
      )
        void this.loadEpicStructure(parentNumber, fpKey).catch(() => {});
      return hit.structure;
    }
    return this.loadEpicStructure(parentNumber, fpKey);
  }

  private loadEpicStructure(parentNumber: number, fpKey: string | null): Promise<EpicStructure> {
    const inflight = this.epicStructuresInflight.get(parentNumber);
    if (inflight) return inflight;
    const gen = this.epicStructuresGen;
    const revision = this.readCache?.revision(this.slug);
    const p = this.fetchEpicStructure(parentNumber)
      .then(({ structure, complete }) => {
        if (gen !== this.epicStructuresGen || revision !== this.readCache?.revision(this.slug))
          return structure;
        const at = this.now();
        if (complete) {
          this.epicStructures.set(parentNumber, { at, structure, contentKey: fpKey, complete });
          this.readCache?.put("epic", this.slug, fpKey, structure, String(parentNumber));
          return structure;
        }
        const prev = this.epicStructures.get(parentNumber);
        const keep = prev?.complete ? prev : { at, structure, contentKey: fpKey, complete };
        const failures = (prev?.failures ?? 0) + 1;
        const wait = Math.min(EPIC_STRUCTURE_RETRY_MS * 2 ** (failures - 1), EPIC_STRUCTURE_TTL_MS);
        this.epicStructures.set(parentNumber, { ...keep, retryAt: at + wait, failures });
        return keep.structure;
      })
      .finally(() => {
        if (this.epicStructuresInflight.get(parentNumber) === p) {
          this.epicStructuresInflight.delete(parentNumber);
        }
      });
    this.epicStructuresInflight.set(parentNumber, p);
    return p;
  }

  /** `complete` is false when a REST fallback call failed and was read as empty. */
  private async fetchEpicStructure(
    parentNumber: number,
  ): Promise<{ structure: EpicStructure; complete: boolean }> {
    if (!graphRateLimit.blocked()) {
      const [owner = "", repo = ""] = this.slug.split("/");
      try {
        const structure = parseEpicStructure(
          await this.run([
            "api",
            "graphql",
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${repo}`,
            "-F",
            `num=${parentNumber}`,
            "-f",
            `query=${withRateLimit(EPIC_STRUCTURE_QUERY)}`,
          ]),
        );
        return { structure, complete: true };
      } catch {
        // Any failure: read the parts over REST, as this path did before #2807.
      }
    }
    let complete = true;
    const settle = <T>(read: Promise<T>, empty: T): Promise<T> =>
      read.catch(() => {
        complete = false;
        return empty;
      });
    const structure = await readEpicStructureByParts(
      {
        getIssue: (n) => settle(this.fetchIssueRest(n), null),
        listSubIssues: (n) => settle(this.fetchSubIssues(n), []),
        listBlockedBy: (n) => settle(this.fetchBlockedBy(n), []),
      },
      parentNumber,
    );
    return { structure, complete };
  }

  async listSubIssues(parentNumber: number): Promise<SubIssueRef[]> {
    return this.fetchSubIssues(parentNumber).catch(() => []);
  }

  /** {@link listSubIssues} without the error swallowing. */
  private async fetchSubIssues(parentNumber: number): Promise<SubIssueRef[]> {
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
  }

  async listBlockedBy(issueNumber: number): Promise<number[]> {
    return this.fetchBlockedBy(issueNumber).catch(() => []);
  }

  /** {@link listBlockedBy} without the error swallowing. */
  private async fetchBlockedBy(issueNumber: number): Promise<number[]> {
    const out = await this.run([
      "api",
      ...this.apiVersion,
      `repos/${this.slug}/issues/${issueNumber}/dependencies/blocked_by`,
      "--paginate",
    ]);
    return (JSON.parse(out || "[]") as Array<{ number: number }>).map((i) => i.number);
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
    try {
      await this.run([
        "api",
        "-X",
        "POST",
        ...this.apiVersion,
        `repos/${this.slug}/issues/${parentNumber}/sub_issues`,
        "-F",
        `sub_issue_id=${id}`,
      ]);
    } finally {
      this.invalidateEpicStructures();
      this.invalidateRelations();
    }
  }

  async addBlockedBy(issueNumber: number, blockerNumber: number): Promise<void> {
    const id = await this.issueId(blockerNumber);
    if (id == null) throw new Error(`cannot resolve id for #${blockerNumber}`);
    try {
      await this.run([
        "api",
        "-X",
        "POST",
        ...this.apiVersion,
        `repos/${this.slug}/issues/${issueNumber}/dependencies/blocked_by`,
        "-F",
        `issue_id=${id}`,
      ]);
    } finally {
      this.invalidateEpicStructures();
      this.invalidateRelations();
    }
  }

  async listSubIssueSummaries(): Promise<{
    summaries: Map<number, { total: number; completed: number }>;
    subIssueNumbers: number[];
    childrenByParent: Map<number, number[]>;
  }> {
    // Best-effort: no relations degrades to markdown-only discovery rather than failing the route.
    const r = await this.issueRelations();
    if (!r) return { summaries: new Map(), subIssueNumbers: [], childrenByParent: new Map() };
    return {
      summaries: new Map([...r.summaries].map(([n, c]) => [n, { ...c }])),
      subIssueNumbers: [...r.subIssueNumbers],
      childrenByParent: new Map([...r.childrenByParent].map(([n, kids]) => [n, [...kids]])),
    };
  }

  /** Numbers-only view of {@link listOpenPrLinkedIssues} for Up Next (#1169), which only needs
   *  "does an open PR close this issue?". Delegates to the one linked-issues query so the two
   *  callers share a single fetch/parse path. */
  async listOpenPrClosingIssues(): Promise<number[]> {
    return [...(await this.listOpenPrLinkedIssues()).keys()];
  }

  async listOpenPrLinkedIssues(): Promise<Map<number, LinkedPr[]>> {
    this.syncReadCache();
    const hit = this.readCache?.get("links", this.slug);
    const fpKey = this.readCache?.contentKey("prs", this.slug) ?? null;
    const fresh =
      hit &&
      (fpKey !== null ? hit.contentKey === fpKey : this.now() - hit.at < ISSUES_CACHE_TTL_MS);
    let linked: Map<number, LinkedPr[]> | null;
    if (fresh || graphRateLimit.blocked()) {
      if (hit && fresh && this.readCache?.expired(hit) && this.readCache.canRefresh())
        void this.loadPrLinks(fpKey);
      linked = hit?.value ?? null;
    } else linked = await this.loadPrLinks(fpKey);
    return new Map([...(linked ?? [])].map(([n, prs]) => [n, prs.map((pr) => ({ ...pr }))]));
  }

  private loadPrLinks(fpKey: string | null): Promise<Map<number, LinkedPr[]> | null> {
    if (!this.linksInflight) {
      const revision = this.readCache?.revision(this.slug);
      const p = this.fetchPrLinks()
        .then((links) => {
          if (links && revision === this.readCache?.revision(this.slug))
            this.readCache?.put("links", this.slug, fpKey, links);
          return links;
        })
        .finally(() => {
          if (this.linksInflight === p) this.linksInflight = null;
        });
      this.linksInflight = p;
    }
    return this.linksInflight;
  }

  private async fetchPrLinks(): Promise<Map<number, LinkedPr[]> | null> {
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
          `query=${withRateLimit(query)}`,
        ];
        if (endCursor !== null) args.push("-f", `endCursor=${endCursor}`);
        const pageInfo = collectLinkedIssuesPage(await this.run(args), linked);
        if (!pageInfo.hasNextPage) break;
        endCursor = pageInfo.endCursor;
      }
    } catch (err) {
      if (isRateLimitError(err)) return null;
      return null;
    }
    return linked;
  }

  async listBlockedByOpen(): Promise<Map<number, number[]>> {
    // Fail open: no REST fallback exists for this data, so no relations yields an empty Map —
    // degraded to no exclusion.
    const r = await this.issueRelations();
    return new Map([...(r?.blockedByOpen ?? [])].map(([n, blockers]) => [n, [...blockers]]));
  }

  /**
   * The repo's open-issue relations, cached like {@link listIssues} (#2808): Up Next, the epics
   * route and the issues route each read them for every view and recompute. While the repo
   * fingerprint covers this slug an entry stays valid until the slug's issue content key moves;
   * uncovered slugs keep the {@link ISSUES_CACHE_TTL_MS} expiry. Concurrent calls share one
   * fetch; a failure is not cached. While the GraphQL bucket is in backoff the last entry is
   * served even when stale, and null when there is none. Callers copy before handing out.
   */
  private issueRelations(): Promise<IssueRelations | null> {
    this.syncReadCache();
    const fpKey = this.issueKey();
    const hit = this.readCache ? this.readCache.get("relations", this.slug) : this.relationsCache;
    const fresh =
      hit !== null &&
      (fpKey !== null ? hit.contentKey === fpKey : this.now() - hit.at < ISSUES_CACHE_TTL_MS);
    if (fresh || graphRateLimit.blocked()) {
      if (hit && fresh && this.readCache?.expired(hit) && this.readCache.canRefresh())
        void this.loadRelations(fpKey);
      return Promise.resolve(hit?.value ?? null);
    }
    return this.loadRelations(fpKey);
  }

  private loadRelations(fpKey: string | null): Promise<IssueRelations | null> {
    if (!this.relationsInflight) {
      const gen = this.relationsGen;
      const revision = this.readCache?.revision(this.slug);
      const p = this.fetchIssueRelations()
        .then((relations) => {
          if (
            relations &&
            gen === this.relationsGen &&
            revision === this.readCache?.revision(this.slug)
          ) {
            this.relationsCache = { at: this.now(), value: relations, contentKey: fpKey };
            this.readCache?.put("relations", this.slug, fpKey, relations);
          }
          return relations;
        })
        .finally(() => {
          if (this.relationsInflight === p) this.relationsInflight = null;
        });
      this.relationsInflight = p;
    }
    return this.relationsInflight;
  }

  /** One paginated GraphQL scan for every open issue's sub-issue counts, parent and still-open
   *  blockers, so callers can tell epics, sub-issues and dependency-blocked issues apart without
   *  an N+1 fan-out. Capped to ~200 open issues (MAX_SUMMARY_PAGES, matching listIssues'
   *  REST_LIST_CAP). Any failure (rate limit, malformed JSON) yields null. */
  private async fetchIssueRelations(): Promise<IssueRelations | null> {
    // No this.apiVersion header: subIssuesSummary and blockedBy are GA on GraphQL. Do NOT add
    // the X-GitHub-Api-Version header here — it is required only by the REST sub_issues and
    // dependencies endpoints above.
    const [owner, name] = this.slug.split("/");
    const query =
      "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){issues(states:OPEN,first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{number subIssuesSummary{total completed} parent{number} blockedBy(first:20){nodes{number state}}}}}}";
    const relations: IssueRelations = {
      summaries: new Map(),
      subIssueNumbers: new Set(),
      childrenByParent: new Map(),
      blockedByOpen: new Map(),
    };
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
          `query=${withRateLimit(query)}`,
        ];
        // Thread the cursor as a raw string (-f): the opaque base64 cursor must not be
        // type-coerced by gh. Page 1 omits it so $endCursor defaults to null in GraphQL.
        if (endCursor !== null) args.push("-f", `endCursor=${endCursor}`);
        const pageInfo = collectIssueRelationsPage(await this.run(args), relations);
        if (!pageInfo.hasNextPage) break;
        endCursor = pageInfo.endCursor;
      }
    } catch {
      return null;
    }
    return relations;
  }
}

/** A `GET /repos/{o}/{r}/actions/runs[/{id}]` run object (fields we read). */
interface GhApiRun {
  id: number;
  name?: string | null;
  path?: string | null;
  event?: string | null;
  status?: string | null;
  conclusion?: string | null;
  run_attempt?: number | null;
  head_sha?: string | null;
  created_at?: string | null;
  html_url?: string | null;
}

function mapGhApiRun(r: GhApiRun, jobs?: ForgeRunJob[]): ForgeRun {
  const ts = Date.parse(r.created_at ?? "");
  return {
    id: r.id,
    workflowName: r.name ?? "",
    workflowFile: r.path ?? "",
    event: r.event ?? "",
    status: r.status ?? "",
    conclusion: r.conclusion ?? null,
    attempt: r.run_attempt ?? 1,
    headSha: r.head_sha ?? "",
    createdAt: Number.isFinite(ts) ? ts : 0,
    url: r.html_url ?? "",
    ...(jobs ? { jobs } : {}),
  };
}

/** Group `gh run view --log-failed` output (`job\tstep\ttext` per line) into consecutive
 *  job+step blocks, preserving log order. Lines without two tabs are dropped. */
function parseFailedLog(out: string): { job: string; step: string; lines: string[] }[] {
  const groups: { job: string; step: string; lines: string[] }[] = [];
  for (const line of out.split("\n")) {
    const a = line.indexOf("\t");
    const b = a < 0 ? -1 : line.indexOf("\t", a + 1);
    if (b < 0) continue;
    const job = line.slice(0, a);
    const step = line.slice(a + 1, b);
    const text = line.slice(b + 1).replace(/\r$/, "");
    const last = groups.at(-1);
    if (last && last.job === job && last.step === step) last.lines.push(text);
    else groups.push({ job, step, lines: [text] });
  }
  return groups;
}
