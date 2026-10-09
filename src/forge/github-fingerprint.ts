/**
 * Repo fingerprints (#2756): ONE aliased GraphQL query answers "did anything change?" for every
 * tracked GitHub repo at once, for about one point (GraphQL cost follows the `first:` limits, not
 * the repo count — dozens of `first:1` connections still round to 1–2 points).
 *
 * Per repo it reads the open issue and PR counts, the `updatedAt` of the most recently updated
 * issue and PR in ANY state (so opening, closing, labelling or editing one moves it), and the
 * default branch's CI rollup. A consumer re-fetches the full issue list or counts only when one
 * of those moved — see `RepoFingerprintService`.
 */
import type { GhRunner } from "./github";
import { RATE_LIMIT_SELECTION } from "./github-spend";

/** What one repo looked like at the last fingerprint. Empty strings mean "none" (a repo with no
 *  issues, no PRs, or no CI rollup on its default branch). */
export interface RepoFingerprint {
  openIssues: number;
  issuesUpdatedAt: string;
  openPrs: number;
  prsUpdatedAt: string;
  ciState: string;
}

/** The in-query `rateLimit` reading. `resetAt` is epoch ms; `cost` is summed across chunks. */
export interface FingerprintRateLimit {
  cost: number;
  remaining: number;
  used: number;
  resetAt: number;
}

export interface FingerprintResult {
  /** slug → fingerprint, or null when GitHub couldn't resolve the repo (renamed, deleted, no
   *  access). Slugs of a chunk whose call failed outright are absent. */
  fingerprints: Map<string, RepoFingerprint | null>;
  /** The latest reading, or null when no chunk returned one. */
  rateLimit: FingerprintRateLimit | null;
}

/** Repos per query. Keeps one query well under GitHub's node and complexity limits. */
export const FINGERPRINT_CHUNK = 50;

const LATEST = "first:1,orderBy:{field:UPDATED_AT,direction:DESC}";
const REPO_SELECTION =
  "openIssues:issues(states:OPEN){totalCount} " +
  `lastIssue:issues(${LATEST}){nodes{updatedAt}} ` +
  "openPrs:pullRequests(states:OPEN){totalCount} " +
  `lastPr:pullRequests(${LATEST}){nodes{updatedAt}} ` +
  "defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}";

/** `gh api graphql` args for one chunk. Owner and name travel as `-f` string variables, never
 *  inlined and never `-F` (which would type a numeric repo name as an Int). */
export function buildFingerprintArgs(slugs: string[]): string[] {
  const vars: string[] = [];
  const fields: string[] = [];
  const args = ["api", "graphql"];
  slugs.forEach((slug, i) => {
    const [owner = "", name = ""] = slug.split("/");
    vars.push(`$o${i}:String!,$n${i}:String!`);
    fields.push(`r${i}:repository(owner:$o${i},name:$n${i}){${REPO_SELECTION}}`);
    args.push("-f", `o${i}=${owner}`, "-f", `n${i}=${name}`);
  });
  const query = `query(${vars.join(",")}){${fields.join(" ")} ${RATE_LIMIT_SELECTION}}`;
  args.push("-f", `query=${query}`);
  return args;
}

interface RawRepo {
  openIssues?: { totalCount?: number };
  lastIssue?: { nodes?: Array<{ updatedAt?: string } | null> };
  openPrs?: { totalCount?: number };
  lastPr?: { nodes?: Array<{ updatedAt?: string } | null> };
  defaultBranchRef?: { target?: { statusCheckRollup?: { state?: string } | null } | null } | null;
}

function toFingerprint(raw: RawRepo | null | undefined): RepoFingerprint | null {
  if (!raw || typeof raw.openIssues?.totalCount !== "number") return null;
  return {
    openIssues: raw.openIssues.totalCount,
    issuesUpdatedAt: raw.lastIssue?.nodes?.[0]?.updatedAt ?? "",
    openPrs: raw.openPrs?.totalCount ?? 0,
    prsUpdatedAt: raw.lastPr?.nodes?.[0]?.updatedAt ?? "",
    ciState: raw.defaultBranchRef?.target?.statusCheckRollup?.state ?? "",
  };
}

/** Parse one chunk's stdout. Throws on output without a `data` object. */
export function parseFingerprintResponse(out: string, slugs: string[]): FingerprintResult {
  const json = JSON.parse(out) as {
    data?: Record<string, unknown> | null;
  };
  const data = json.data;
  if (!data || typeof data !== "object") throw new Error("fingerprint: response has no data");
  const fingerprints = new Map<string, RepoFingerprint | null>();
  slugs.forEach((slug, i) => fingerprints.set(slug, toFingerprint(data[`r${i}`] as RawRepo)));
  const rl = data.rateLimit as Partial<Record<keyof FingerprintRateLimit, unknown>> | undefined;
  const resetAt = typeof rl?.resetAt === "string" ? Date.parse(rl.resetAt) : NaN;
  const rateLimit =
    typeof rl?.remaining === "number" && Number.isFinite(resetAt)
      ? {
          cost: typeof rl.cost === "number" ? rl.cost : 0,
          remaining: rl.remaining,
          used: typeof rl.used === "number" ? rl.used : 0,
          resetAt,
        }
      : null;
  return { fingerprints, rateLimit };
}

/** One chunk: `gh` exits non-zero when ANY alias errors (e.g. one NOT_FOUND repo), but still
 *  prints the partial `data` on stdout — parse that rather than losing the whole chunk. */
async function fetchChunk(run: GhRunner, slugs: string[]): Promise<FingerprintResult> {
  try {
    return parseFingerprintResponse(await run(buildFingerprintArgs(slugs)), slugs);
  } catch (err) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    if (typeof stdout === "string" && stdout.trim()) {
      try {
        return parseFingerprintResponse(stdout, slugs);
      } catch {
        // no usable partial data — fall through to the original error
      }
    }
    throw err;
  }
}

/**
 * Fingerprint `slugs` in chunks of {@link FINGERPRINT_CHUNK}. The shared runner feeds each chunk's
 * `rateLimit` reading to the GraphQL tracker. A failed chunk omits its slugs; if every chunk
 * fails, the first error is rethrown.
 */
export async function fetchRepoFingerprints(
  run: GhRunner,
  slugs: string[],
): Promise<FingerprintResult> {
  const fingerprints = new Map<string, RepoFingerprint | null>();
  let rateLimit: FingerprintRateLimit | null = null;
  let cost = 0;
  let firstErr: unknown;
  let failed = 0;
  const chunks: string[][] = [];
  for (let i = 0; i < slugs.length; i += FINGERPRINT_CHUNK) {
    chunks.push(slugs.slice(i, i + FINGERPRINT_CHUNK));
  }
  for (const chunk of chunks) {
    let res: FingerprintResult;
    try {
      res = await fetchChunk(run, chunk);
    } catch (err) {
      failed++;
      firstErr ??= err;
      continue;
    }
    for (const [slug, fp] of res.fingerprints) fingerprints.set(slug, fp);
    if (res.rateLimit) {
      cost += res.rateLimit.cost;
      rateLimit = { ...res.rateLimit, cost };
    }
  }
  if (chunks.length > 0 && failed === chunks.length) throw firstErr;
  return { fingerprints, rateLimit };
}
