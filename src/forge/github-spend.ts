/**
 * Who spends the GitHub GraphQL budget (#2840).
 *
 * GitHub counts every token of the account against one 5,000 points/h bucket: PATs, `gh`'s OAuth
 * token on any machine, and user-to-server tokens of apps acting as the user (cloud agents, IDE
 * integrations, review bots). The bucket's `used` alone can't tell Shepherd's spend from theirs.
 *
 * The shared `gh` runner charges every GraphQL-bucket call it makes to a {@link GraphqlSpendLedger}:
 * the in-query `rateLimit.cost` for Shepherd's own `gh api graphql` queries, and the measured
 * per-page table in {@link porcelainCost} for porcelain `gh pr|issue …`. Between two in-query
 * readings of the same window, everything else = Δ`used` − own spend.
 */
import { sameWindow } from "./rate-limit";

/** A top-level `rateLimit` selection as it came back in a query's output. `cost` and `used` are
 *  null when the query didn't select them. `resetAt` is epoch ms. */
export interface InQueryRateLimit {
  cost: number | null;
  used: number | null;
  remaining: number;
  resetAt: number;
}

/** The selection every own query carries (#2840). Free: `rateLimit` costs no points. */
export const RATE_LIMIT_SELECTION = "rateLimit{cost used remaining resetAt}";

/** `query` with {@link RATE_LIMIT_SELECTION} added at its top level, before the operation's
 *  closing brace. */
export function withRateLimit(query: string): string {
  const end = query.lastIndexOf("}");
  return `${query.slice(0, end)} ${RATE_LIMIT_SELECTION}${query.slice(end)}`;
}

/** The flat `"rateLimit":{…}` object. A lookalike inside string content can't match: `gh` prints
 *  JSON, so a quote inside a string is escaped (`\"rateLimit\"`). */
const RATE_LIMIT_RE = /"rateLimit"\s*:\s*(\{[^{}]*\})/;

/** Read the `rateLimit` selection out of `gh api graphql` stdout without parsing the whole
 *  response. Null when there is none, or it lacks `remaining` or a valid `resetAt`. */
export function parseInQueryRateLimit(stdout: string): InQueryRateLimit | null {
  const m = RATE_LIMIT_RE.exec(stdout);
  if (!m) return null;
  let rl: Record<string, unknown>;
  try {
    rl = JSON.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
  const resetAt = typeof rl.resetAt === "string" ? Date.parse(rl.resetAt) : NaN;
  if (typeof rl.remaining !== "number" || !Number.isFinite(resetAt)) return null;
  return {
    cost: typeof rl.cost === "number" ? rl.cost : null,
    used: typeof rl.used === "number" ? rl.used : null,
    remaining: rl.remaining,
    resetAt,
  };
}

/** `gh` lists page in at most 100 rows. */
const PAGE = 100;
/** `gh`'s `--limit` default. */
const DEFAULT_LIMIT = 30;

function flagValue(args: string[], ...names: string[]): string | undefined {
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 ? args[i + 1] : undefined;
}

/** Points one page of a porcelain list costs, for Shepherd's field lists. Measured 2026-10-09
 *  with `rateLimit(dryRun:true)` on the queries gh 2.93.0 sends (`GH_DEBUG=api`): the open-PR
 *  snapshot's nested connections (checks, reviews, labels) make it the expensive one. */
function pageCost(args: string[], perPage: number): number {
  if (args[0] === "issue") return perPage <= 50 ? 1 : 2;
  const heavy = flagValue(args, "--json")?.includes("statusCheckRollup");
  if (args[0] !== "pr" || !heavy || flagValue(args, "--head") !== undefined) return 1;
  if (perPage <= 20) return 1;
  if (perPage <= 30) return 2;
  if (perPage <= 50) return 3;
  return 5;
}

/** Row count of a list's JSON output, or 0 when it isn't one. Parsed only when the limit allows
 *  more than one page — a single page needs no count. */
function rowCount(stdout: string | null): number {
  if (!stdout) return 0;
  try {
    const rows = JSON.parse(stdout) as unknown;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Points a porcelain GraphQL-bucket call (`gh pr|issue|repo …`) cost. A `list` pays per page it
 * fetched: `gh` pages 100 rows at a time, so above `--limit 100` the page count follows from the
 * rows returned (one page when the output is unknown). Every other call is 1. `stdout` is null
 * when the call failed.
 */
export function porcelainCost(args: string[], stdout: string | null): number {
  if (args[1] !== "list") return 1;
  const limit = Number(flagValue(args, "--limit", "-L") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const perPage = Math.min(limit, PAGE);
  const pages = limit > PAGE ? Math.max(1, Math.ceil(rowCount(stdout) / PAGE)) : 1;
  return pages * pageCost(args, perPage);
}

/** The split of the current window, as the GitHub tab shows it. Rates are null until
 *  {@link SPLIT_MIN_COVERAGE_MS} of readings exist. `otherPoints` is never negative. */
export interface GraphqlSpendSplit {
  /** The window's `resetAt`, epoch ms. */
  resetAt: number;
  /** Epoch ms of the window's first and latest accepted reading. */
  since: number;
  until: number;
  ownPoints: number;
  otherPoints: number;
  ownPerHour: number | null;
  otherPerHour: number | null;
}

/** Readings must span this long before the split shows per-hour rates. */
const SPLIT_MIN_COVERAGE_MS = 5 * 60_000;

const HOUR_MS = 3_600_000;

interface WindowTally {
  resetAt: number;
  since: number;
  until: number;
  own: number;
  other: number;
}

/**
 * Splits the GraphQL budget into the Shepherd server's own spend and everything else (#2840).
 *
 * The runner feeds it {@link noteOwnSpend} for every GraphQL-bucket call, and {@link noteReading}
 * for every in-query reading the GraphQL tracker accepted as its current window's — readings from
 * GitHub's other counters never reach it. Per window it sums, for each pair of consecutive
 * readings, own = what Shepherd charged in between and other = Δ`used` − own. A `used` that went
 * backwards restarts the tally. Calls still in flight at a reading land in the next interval, so
 * per-interval noise cancels over the window.
 */
export class GraphqlSpendLedger {
  private readonly now: () => number;
  /** Points Shepherd charged since boot — monotonic, so an interval is a difference. */
  private ownTotal = 0;
  private last: { used: number; ownTotal: number } | null = null;
  private window: WindowTally | null = null;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  noteOwnSpend(points: number): void {
    this.ownTotal += points;
  }

  /** An in-query reading of the current window (epoch-ms `resetAt`). */
  noteReading(reading: { used: number; resetAt: number }): void {
    const at = this.now();
    const w = this.window;
    if (
      !w ||
      !this.last ||
      !sameWindow(w.resetAt, reading.resetAt) ||
      reading.used < this.last.used
    ) {
      this.window = { resetAt: reading.resetAt, since: at, until: at, own: 0, other: 0 };
    } else {
      const own = this.ownTotal - this.last.ownTotal;
      w.own += own;
      w.other += reading.used - this.last.used - own;
      w.until = at;
    }
    this.last = { used: reading.used, ownTotal: this.ownTotal };
  }

  /** The current window's split, or null before a reading or once the window has passed. */
  split(): GraphqlSpendSplit | null {
    const w = this.live();
    if (!w) return null;
    const span = w.until - w.since;
    const other = Math.max(0, w.other);
    const perHour = (points: number) =>
      span >= SPLIT_MIN_COVERAGE_MS ? Math.round((points * HOUR_MS) / span) : null;
    return {
      resetAt: w.resetAt,
      since: w.since,
      until: w.until,
      ownPoints: w.own,
      otherPoints: other,
      ownPerHour: perHour(w.own),
      otherPerHour: perHour(other),
    };
  }

  /** Points/h everything else spends in the current window, once its readings span at least
   *  `minCoverageMs`; null before that. */
  foreignPerHour(minCoverageMs: number): number | null {
    const w = this.live();
    if (!w) return null;
    const span = w.until - w.since;
    if (span <= 0 || span < minCoverageMs) return null;
    return (Math.max(0, w.other) * HOUR_MS) / span;
  }

  private live(): WindowTally | null {
    const w = this.window;
    return w && this.now() < w.resetAt ? w : null;
  }
}

/** The process-wide ledger the shared `gh` runner charges. */
export const graphqlSpend: GraphqlSpendLedger = new GraphqlSpendLedger();
