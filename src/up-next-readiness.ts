/**
 * Up Next readiness scorer (#2535) — the I/O half of the rerank. `up-next-readiness-core.ts` owns
 * WHAT is asked; this owns WHEN, HOW OFTEN and at what cost, and `applyReadiness` in
 * `up-next-core.ts` owns what the answer does to the order.
 *
 * TWO PATHS, and only one of them may block. {@link ReadinessScorer.scoreLookup} is a synchronous
 * cache read that Up Next's compute uses to publish immediately. {@link ReadinessScorer.scoreMissing}
 * is the only thing that talks to the judge, and the service fires it and forgets it: Up Next never
 * waits on a network call it did not need before this feature existed.
 *
 * FAIL-OPEN EVERYWHERE, like `house-rules-relevance.ts`: judge unarmed, ceiling refused, transport
 * error, locked DB — each ends the run quietly and the item keeps its unscored (`maybe`) position,
 * i.e. today's order. Nothing here throws to the caller.
 */

import type { Judge } from "./judge";
import type { JudgeSpendLedger } from "./judge-spend";
import type { ReadinessRow } from "./store";
import type { UpNextItem } from "./up-next-core";
import { mapBounded } from "./map-bounded";
import {
  READINESS_QUESTION,
  interpretReadiness,
  readinessHash,
  readinessState,
  type ReadinessInput,
} from "./up-next-readiness-core";

export interface ReadinessScorerDeps {
  /** Read per run, not captured: the judge toggle takes effect on the next refresh. */
  judge: () => Judge | null;
  /** The pinned judge model — part of the cache key, so a re-pin rescores everything. */
  model: () => string;
  /** Shared with every other judge caller — one daily ceiling. */
  spend?: Pick<JudgeSpendLedger, "allow" | "record"> | null;
  store: {
    getReadiness(hashes: readonly string[]): Map<string, number>;
    putReadiness(row: ReadinessRow): void;
  };
  now?: () => number;
  warn?: (message: string, err?: unknown) => void;
  /** Parallel judge calls per run. */
  concurrency?: number;
  /** Judge calls per run. Bounds the burst when the feature is first enabled on a large backlog;
   *  the rest converge over subsequent refreshes. */
  maxPerRefresh?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_PER_REFRESH = 60;
/** Judge throws tolerated per run before it stops. One is not enough — a single poison item that
 *  always fails would otherwise block every item queued behind it, every refresh — but a systemic
 *  failure (401, rate limit) must not be retried 60 times. */
const MAX_FAILURES_PER_RUN = 3;

/** What gets scored for a row. For an epic unit `issueRef` is the next-actionable CHILD — what Start
 *  launches — while `labels` are the parent's, which is the context that child inherits. */
function readinessInputOf(item: UpNextItem): ReadinessInput {
  return { title: item.issueRef.title, body: item.issueRef.body, labels: item.labels };
}

/** Mutable per-run state, so the per-item worker stays small. */
interface RunState {
  judge: Judge;
  model: string;
  stopped: boolean;
  failures: number;
  warned: boolean;
  scored: number;
}

export class ReadinessScorer {
  private readonly now: () => number;
  private readonly warnFn: (message: string, err?: unknown) => void;
  private readonly concurrency: number;
  private readonly maxPerRefresh: number;
  /** Hashes a run is currently asking about. Overlapping refreshes (a GET-triggered one landing
   *  while the previous run is still scoring) skip these rather than pay for the same answer twice. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ReadinessScorerDeps) {
    this.now = deps.now ?? Date.now;
    this.warnFn = deps.warn ?? ((message, err) => console.warn(message, err));
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxPerRefresh = Math.max(0, deps.maxPerRefresh ?? DEFAULT_MAX_PER_REFRESH);
  }

  hashOf(item: UpNextItem, model: string = this.deps.model()): string {
    return readinessHash(model, readinessInputOf(item));
  }

  /** Cached scores by hash. A store failure reads as "nothing cached" — today's order. */
  scoresFor(items: readonly UpNextItem[]): Map<string, number> {
    const model = this.deps.model();
    try {
      return this.deps.store.getReadiness([...new Set(items.map((i) => this.hashOf(i, model)))]);
    } catch (err) {
      this.warnFn("[up-next] readiness cache read failed (keeping today's order):", err);
      return new Map();
    }
  }

  /** `scoresFor` shaped for `applyReadiness`: item → cached `p`, or null when unscored. */
  scoreLookup(items: readonly UpNextItem[]): (item: UpNextItem) => number | null {
    const model = this.deps.model();
    const scores = this.scoresFor(items);
    return (item) => scores.get(this.hashOf(item, model)) ?? null;
  }

  /**
   * Ask the judge about every item without a cached score, bounded by `maxPerRefresh` and the
   * daily ceiling. Resolves to how many NEW scores were stored — the service re-publishes only when
   * that is non-zero. Never rejects.
   */
  async scoreMissing(items: readonly UpNextItem[]): Promise<number> {
    const judge = this.safeJudge();
    if (!judge || this.maxPerRefresh === 0) return 0;
    const run: RunState = {
      judge,
      model: this.deps.model(),
      stopped: false,
      failures: 0,
      warned: false,
      scored: 0,
    };
    let pending: [string, ReadinessInput][];
    try {
      pending = this.pendingInputs(items, run.model);
    } catch (err) {
      this.warnOnce(run, "[up-next] readiness cache read failed (scoring skipped):", err);
      return 0;
    }
    for (const [hash] of pending) this.inFlight.add(hash);
    try {
      await mapBounded(pending, this.concurrency, ([hash, input]) =>
        this.scoreOne(run, hash, input),
      );
    } finally {
      for (const [hash] of pending) this.inFlight.delete(hash);
    }
    return run.scored;
  }

  private safeJudge(): Judge | null {
    try {
      return this.deps.judge();
    } catch (err) {
      this.warnFn("[up-next] readiness judge unavailable:", err);
      return null;
    }
  }

  private warnOnce(run: RunState, message: string, err: unknown): void {
    if (run.warned) return;
    run.warned = true;
    this.warnFn(message, err);
  }

  /** Uncached, not-in-flight inputs, deduped by hash and capped. Throws on a store failure (the
   *  caller's catch turns that into a skipped run). */
  private pendingInputs(items: readonly UpNextItem[], model: string): [string, ReadinessInput][] {
    const byHash = new Map<string, ReadinessInput>();
    for (const item of items) {
      const input = readinessInputOf(item);
      const hash = readinessHash(model, input);
      if (!this.inFlight.has(hash)) byHash.set(hash, input);
    }
    const cached = this.deps.store.getReadiness([...byHash.keys()]);
    return [...byHash].filter(([hash]) => !cached.has(hash)).slice(0, this.maxPerRefresh);
  }

  private async scoreOne(run: RunState, hash: string, input: ReadinessInput): Promise<void> {
    if (run.stopped) return;
    try {
      // Inside the try: `allow` reads the DB. A refusal stops the whole run — the ceiling will not
      // un-breach before the next item.
      if (this.deps.spend && !this.deps.spend.allow()) {
        run.stopped = true;
        return;
      }
      const result = await run.judge.ask(readinessState(input), { ready: READINESS_QUESTION });
      this.recordSpend(run, result.costUsd);
      const p = interpretReadiness(result.answers.ready);
      if (p === null) return; // billed but unusable: left uncached, so the next refresh retries it
      this.deps.store.putReadiness({ hash, p, model: run.model, scoredAt: this.now() });
      run.scored++;
    } catch (err) {
      run.failures++;
      if (run.failures >= MAX_FAILURES_PER_RUN) run.stopped = true;
      this.warnOnce(run, "[up-next] readiness judge failed (keeping today's order):", err);
    }
  }

  /** Booked before the answer is inspected — an unusable answer was still billed. Best-effort: a
   *  ledger write must not lose a score already paid for. */
  private recordSpend(run: RunState, costUsd: number): void {
    try {
      this.deps.spend?.record(costUsd);
    } catch (err) {
      this.warnOnce(run, "[up-next] readiness spend record failed:", err);
    }
  }
}
