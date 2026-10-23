/**
 * Batched PR-by-head lookups (#2743): ONE aliased GraphQL query answers `prStatus` for many
 * branches across repos. GraphQL cost follows the `first:` limits, so 20 `first:1` lookups still
 * cost 1 point (dry-run, 2026-10-23) where 20 `gh pr list --head` calls cost 20.
 *
 * The `pr` fragment selects what `gh pr list --json …` sends for `prStatus` (captured with
 * `GH_DEBUG=api`, gh 2.103.0), and the parser flattens it into the same JSON shape `gh` prints, so
 * both paths share `mapGhPr`.
 */
import type { GhPr, GhRunner } from "./github";
import type { RollupEntry } from "./types";
import { RATE_LIMIT_SELECTION } from "./github-spend";

/** One branch to look up in one repo. */
export interface HeadTarget {
  slug: string;
  head: string;
}

/** Heads per query. 20 dry-runs at 1 point; 30 at 2. */
export const HEAD_BATCH_CHUNK = 20;

const PR_FRAGMENT =
  "fragment pr on PullRequest{number url title state author{login} createdAt mergeable " +
  "mergeStateStatus isDraft commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){" +
  "nodes{__typename ...on StatusContext{context state targetUrl createdAt} ...on CheckRun{name " +
  "checkSuite{workflowRun{workflow{name}}} status conclusion startedAt completedAt detailsUrl}}}}}}} " +
  "headRefOid baseRefName reviews(first:100){nodes{author{login} submittedAt body state}} " +
  "reviewRequests(first:100){nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login}}}} " +
  "headRepositoryOwner{login}}";

const LOOKUP = "states:[OPEN,CLOSED,MERGED],first:1,orderBy:{field:CREATED_AT,direction:DESC}";

/** The map key of one target. */
export function headKey(slug: string, head: string): string {
  return `${slug}\u0000${head}`;
}

/** Targets grouped by repo, in first-seen order. */
function byRepo(targets: HeadTarget[]): Array<[string, string[]]> {
  const repos = new Map<string, string[]>();
  for (const { slug, head } of targets) {
    const heads = repos.get(slug) ?? [];
    if (!heads.includes(head)) heads.push(head);
    repos.set(slug, heads);
  }
  return [...repos];
}

/** `gh api graphql` args for one chunk. Owners, names and heads travel as `-f` string
 *  variables, never inlined. */
export function buildHeadBatchArgs(targets: HeadTarget[]): string[] {
  const vars: string[] = [];
  const fields: string[] = [];
  const args = ["api", "graphql"];
  byRepo(targets).forEach(([slug, heads], r) => {
    const [owner = "", name = ""] = slug.split("/");
    vars.push(`$o${r}:String!,$n${r}:String!`);
    args.push("-f", `o${r}=${owner}`, "-f", `n${r}=${name}`);
    const lookups = heads.map((head, h) => {
      vars.push(`$h${r}_${h}:String!`);
      args.push("-f", `h${r}_${h}=${head}`);
      return `h${h}:pullRequests(headRefName:$h${r}_${h},${LOOKUP}){nodes{...pr}}`;
    });
    fields.push(`r${r}:repository(owner:$o${r},name:$n${r}){${lookups.join(" ")}}`);
  });
  const query = `query(${vars.join(",")}){${fields.join(" ")} ${RATE_LIMIT_SELECTION}} ${PR_FRAGMENT}`;
  args.push("-f", `query=${query}`);
  return args;
}

interface RawContext extends Omit<RollupEntry, "workflowName"> {
  checkSuite?: { workflowRun?: { workflow?: { name?: string | null } | null } | null } | null;
}

interface RawPr extends Omit<GhPr, "statusCheckRollup" | "reviewRequests" | "reviews"> {
  commits?: {
    nodes?: Array<{
      commit?: { statusCheckRollup?: { contexts?: { nodes?: RawContext[] } } | null };
    } | null>;
  };
  reviews?: { nodes?: GhPr["reviews"] };
  reviewRequests?: {
    nodes?: Array<{ requestedReviewer?: { login?: string } | null } | null>;
  };
}

/** One GraphQL node in the shape `gh pr list --json` prints. */
function toGhPr(raw: RawPr): GhPr {
  const { commits, reviews, reviewRequests, ...rest } = raw;
  const contexts = commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    ...rest,
    statusCheckRollup: contexts.map(({ checkSuite, ...c }) =>
      c.__typename === "CheckRun"
        ? { ...c, workflowName: checkSuite?.workflowRun?.workflow?.name ?? "" }
        : c,
    ),
    reviews: reviews?.nodes ?? [],
    reviewRequests: (reviewRequests?.nodes ?? [])
      .map((n) => n?.requestedReviewer)
      .filter((r): r is { login: string } => !!r?.login)
      .map((r) => ({ login: r.login })),
  };
}

/**
 * Parse one chunk's stdout. A found repo yields every head of it: the PR, or null for "no PR".
 * A repo GitHub couldn't resolve (null alias) yields none. Throws on output without `data`.
 */
export function parseHeadBatchResponse(
  out: string,
  targets: HeadTarget[],
): Map<string, GhPr | null> {
  const json = JSON.parse(out) as { data?: Record<string, unknown> | null };
  const data = json.data;
  if (!data || typeof data !== "object") throw new Error("head batch: response has no data");
  const result = new Map<string, GhPr | null>();
  byRepo(targets).forEach(([slug, heads], r) => {
    const repo = data[`r${r}`] as Record<string, { nodes?: RawPr[] } | null> | null | undefined;
    if (!repo) return;
    heads.forEach((head, h) => {
      const conn = repo[`h${h}`];
      if (!conn) return;
      const node = conn.nodes?.[0];
      result.set(headKey(slug, head), node ? toGhPr(node) : null);
    });
  });
  return result;
}

/** One chunk. `gh` exits non-zero when an alias errors but still prints the partial `data`. */
async function fetchChunk(run: GhRunner, targets: HeadTarget[]): Promise<Map<string, GhPr | null>> {
  try {
    return parseHeadBatchResponse(await run(buildHeadBatchArgs(targets)), targets);
  } catch (err) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    if (typeof stdout === "string" && stdout.trim()) {
      try {
        return parseHeadBatchResponse(stdout, targets);
      } catch {
        // no usable partial data — fall through to the original error
      }
    }
    throw err;
  }
}

interface Waiter {
  targets: HeadTarget[];
  resolve: (prs: Map<string, GhPr | null>) => void;
}

/**
 * Coalesces lookups made in the same macrotask — one per repo when the poller fans out with
 * `Promise.all` — into one query per {@link HEAD_BATCH_CHUNK} heads. A failed chunk leaves its
 * heads out of every waiter's result (the caller falls back per head); lookups never reject.
 */
class HeadBatcher {
  private pending: Waiter[] = [];
  private scheduled = false;

  constructor(private readonly run: GhRunner) {}

  lookup(targets: HeadTarget[]): Promise<Map<string, GhPr | null>> {
    if (targets.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve) => {
      this.pending.push({ targets, resolve });
      if (this.scheduled) return;
      this.scheduled = true;
      setTimeout(() => void this.flush(), 0);
    });
  }

  private async flush(): Promise<void> {
    const waiters = this.pending;
    this.pending = [];
    this.scheduled = false;
    const all = uniqueTargets(waiters.flatMap((w) => w.targets));
    const found = new Map<string, GhPr | null>();
    for (let i = 0; i < all.length; i += HEAD_BATCH_CHUNK) {
      try {
        const res = await fetchChunk(this.run, all.slice(i, i + HEAD_BATCH_CHUNK));
        for (const [k, pr] of res) found.set(k, pr);
      } catch {
        // a failed chunk's heads stay absent → per-head fallback
      }
    }
    for (const w of waiters) w.resolve(pick(found, w.targets));
  }
}

function uniqueTargets(targets: HeadTarget[]): HeadTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const k = headKey(t.slug, t.head);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The entries of `found` that `targets` asked for. */
function pick(found: Map<string, GhPr | null>, targets: HeadTarget[]): Map<string, GhPr | null> {
  const mine = new Map<string, GhPr | null>();
  for (const t of targets) {
    const k = headKey(t.slug, t.head);
    if (found.has(k)) mine.set(k, found.get(k)!);
  }
  return mine;
}

const batchers = new WeakMap<GhRunner, HeadBatcher>();

/** The batcher shared by every forge on `run` (one per runner, so tests stay isolated). */
export function headBatcherFor(run: GhRunner): HeadBatcher {
  let b = batchers.get(run);
  if (!b) batchers.set(run, (b = new HeadBatcher(run)));
  return b;
}
