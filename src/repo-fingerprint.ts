import type { FingerprintResult, RepoFingerprint } from "./forge/github-fingerprint";
import type { RateLimitSnapshot } from "./forge/rate-limit";
import { countsKey, issuesKey, type GithubReadCache } from "./github-read-cache";

/** One tracked GitHub repo: its slug and every local repo path that resolves to it. */
export interface FingerprintTarget {
  slug: string;
  paths: string[];
}

/** A slug whose fingerprint moved. `issues`: the open-issue count or the newest issue's
 *  `updatedAt` changed — the cached issue list is stale. `counts`: something the backlog
 *  counts show changed (issue/PR count, newest PR, default-branch CI). `first`: the slug's first
 *  observation, which counts as a change on both. */
export interface FingerprintChange extends FingerprintTarget {
  first: boolean;
  issues: boolean;
  counts: boolean;
}

/** One fingerprint run's outcome: what moved, and what was seen unchanged. */
export interface FingerprintObservation {
  changed: FingerprintChange[];
  unchanged: FingerprintTarget[];
}

export interface RepoFingerprintDeps {
  listTargets: () => FingerprintTarget[];
  fetch: (slugs: string[]) => Promise<FingerprintResult>;
  /** The shared GraphQL tracker's snapshot (`graphRateLimit.snapshot()`). */
  rateLimit: () => RateLimitSnapshot;
  onObserved: (o: FingerprintObservation) => void | Promise<void>;
  now?: () => number;
  /** Background cadence. */
  intervalMs?: number;
  /** Background refresh pauses while the last in-query `remaining` is below this, until reset. */
  reserve?: number;
  /** Minimum spacing between demanded runs. */
  minGapMs?: number;
  cache?: GithubReadCache;
}

/** Which backlog-count entries a fingerprint run should re-fetch and which it should merely
 *  restamp: re-fetch where the counts moved — on a first sighting only when nothing is cached
 *  yet — and restamp the rest, so an unchanged repo never expires into a request-path fetch. */
export function countsPlan(
  o: FingerprintObservation,
  cached: (path: string) => boolean,
): { refresh: string[]; touch: string[] } {
  const refresh: string[] = [];
  const touch: string[] = [];
  for (const c of o.changed) {
    for (const path of c.paths) {
      if (c.counts && !(c.first && cached(path))) refresh.push(path);
      else touch.push(path);
    }
  }
  for (const t of o.unchanged) touch.push(...t.paths);
  return { refresh, touch };
}

interface SlugState {
  fp: RepoFingerprint;
  observedAt: number;
  rehydrated?: boolean;
}

/**
 * Refresh repo-level GitHub data on change or demand, not on fixed timers (#2756).
 *
 * One aliased query fingerprints every tracked repo (about one point). A repo's full issue list
 * or backlog counts are re-fetched only when its fingerprint moved — consumers read the shared
 * forge cache, which stays valid while the slug's content key ({@link issuesKey}) is unchanged.
 *
 * - Background: every `intervalMs`, unless the GraphQL bucket is in backoff or below `reserve`
 *   (until its reset) — then it waits instead of competing with agents for the last points.
 * - Demand: {@link ensureFresh} for an operator opening a view (answers at once if a run is at
 *   most `minGapMs` old), {@link refreshSoon} after an event that likely changed GitHub (a PR
 *   opened or merged). Both run under a low budget; only the backoff stops them.
 * - Coverage ({@link covered}): rehydrated slugs until their first observation, then slugs seen
 *   within three intervals or while background refresh is paused — serve the cache during backoff.
 *
 * Blind spot, accepted: a change that bumps neither an issue's `updatedAt` nor a count (e.g. a
 * repo-wide label rename) stays invisible until the next real change, an operator view, or one
 * of Shepherd's own writes, which invalidate the forge cache directly.
 */
export class RepoFingerprintService {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly reserve: number;
  private readonly minGapMs: number;
  private readonly state = new Map<string, SlugState>();
  private inflight: Promise<void> | null = null;
  /** Start time of the latest run. */
  private lastRunAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pausedLogged = false;
  private observed = false;

  constructor(private readonly deps: RepoFingerprintDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 120_000;
    this.reserve = deps.reserve ?? 1_000;
    this.minGapMs = deps.minGapMs ?? 30_000;
    for (const { slug, fp, observedAt } of deps.cache?.fingerprints() ?? []) {
      this.state.set(slug, { fp, observedAt, rehydrated: true });
    }
  }

  /** Background run: skipped while paused, or when a demanded run is fresher than half an
   *  interval. */
  async tick(): Promise<void> {
    if (this.backgroundPaused()) {
      if (!this.pausedLogged) {
        const rl = this.deps.rateLimit();
        console.log(
          `[fingerprint] background refresh paused (GraphQL ${rl.blocked ? "backoff" : `${rl.remaining} remaining < reserve ${this.reserve}`})`,
        );
        this.pausedLogged = true;
      }
      return;
    }
    if (this.pausedLogged) {
      console.log("[fingerprint] background refresh resumed");
      this.pausedLogged = false;
    }
    if (this.now() - this.lastRunAt < this.intervalMs / 2) return;
    await this.run();
  }

  /** Make sure a fingerprint at most `minGapMs` old exists, running one now if needed — for an
   *  operator opening a view. Awaits a run already in flight, since its answer is about to land. */
  ensureFresh(): Promise<void> {
    if (this.deps.rateLimit().blocked) return Promise.resolve();
    if (this.now() - this.lastRunAt < this.minGapMs) return this.inflight ?? Promise.resolve();
    return this.run();
  }

  /** Guarantee a run that STARTS after this call — no sooner than `minGapMs` after the last one;
   *  calls in between share it. For events that likely just changed GitHub. */
  refreshSoon(): Promise<void> {
    if (this.deps.rateLimit().blocked) return Promise.resolve();
    if (this.pending) return this.pending;
    const wait = Math.max(0, this.lastRunAt + this.minGapMs - this.now());
    this.pending = new Promise<void>((resolve) => {
      this.pendingTimer = setTimeout(() => {
        this.pending = null;
        this.pendingTimer = null;
        void (this.inflight ?? Promise.resolve()).then(() => this.run()).then(resolve, resolve);
      }, wait);
    });
    return this.pending;
  }

  /** True when the slug's issue list may be served from cache until its content key moves. */
  covered(slug: string): boolean {
    const s = this.state.get(slug);
    if (!s) return false;
    return (
      !!s.rehydrated || this.now() - s.observedAt < 3 * this.intervalMs || this.backgroundPaused()
    );
  }

  /** The slug's content identity, or null when not {@link covered}. */
  issuesKey(slug: string): string | null {
    return this.covered(slug) ? issuesKey(this.state.get(slug)!.fp) : null;
  }

  /** Broad boot work waits for a successful fingerprint and the background reserve. */
  backgroundReady(): boolean {
    return this.observed && !this.backgroundPaused();
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.timer = null;
    this.pendingTimer = null;
    this.pending = null;
  }

  private backgroundPaused(): boolean {
    const rl = this.deps.rateLimit();
    if (rl.blocked) return true;
    return (
      rl.remaining !== null &&
      rl.remaining < this.reserve &&
      rl.resetAt !== null &&
      this.now() < rl.resetAt
    );
  }

  /** Single-flight run. */
  private run(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastRunAt = this.now();
    const p = this.observe()
      .catch((err: unknown) => {
        console.warn("[fingerprint] run failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  private async observe(): Promise<void> {
    const targets = this.deps.listTargets();
    if (targets.length === 0) {
      this.observed = true;
      await this.deps.onObserved({ changed: [], unchanged: [] });
      return;
    }
    const { fingerprints, rateLimit } = await this.deps.fetch(targets.map((t) => t.slug));
    const at = this.now();
    if (fingerprints.size > 0) this.observed = true;
    const observation: FingerprintObservation = { changed: [], unchanged: [] };
    for (const target of targets) {
      if (!fingerprints.has(target.slug)) continue; // its chunk failed — leave as it was
      this.record(target, fingerprints.get(target.slug) ?? null, at, observation);
    }
    logChanges(targets.length, observation.changed, rateLimit);
    await this.deps.onObserved(observation);
  }

  /** Diff one repo's fresh fingerprint against the last and file it as changed or unchanged. */
  private record(
    target: FingerprintTarget,
    fp: RepoFingerprint | null,
    at: number,
    into: FingerprintObservation,
  ): void {
    if (!fp) {
      const hadState = this.state.delete(target.slug); // unreadable now → consumers keep a TTL
      if (hadState || this.deps.cache?.get("fingerprint", target.slug))
        this.deps.cache?.invalidate(target.slug, ["fingerprint"]);
      return;
    }
    const prev = this.state.get(target.slug);
    const issues = !prev || issuesKey(prev.fp) !== issuesKey(fp);
    const counts = !prev || countsKey(prev.fp) !== countsKey(fp);
    this.state.set(target.slug, {
      fp,
      observedAt: at,
    });
    this.deps.cache?.put("fingerprint", target.slug, null, fp, "", at);
    if (issues || counts) into.changed.push({ ...target, first: !prev, issues, counts });
    else into.unchanged.push(target);
  }
}

/** One line per run that changed something, with the in-query budget. */
function logChanges(
  repos: number,
  changed: FingerprintChange[],
  rateLimit: FingerprintResult["rateLimit"],
): void {
  if (changed.length === 0) return;
  const what = changed
    .map((c) => (c.first ? c.slug : `${c.slug}(${c.issues ? "issues" : "counts"})`))
    .join(", ");
  const budget = rateLimit ? ` cost ${rateLimit.cost}, ${rateLimit.remaining} remaining,` : "";
  console.log(`[fingerprint] ${repos} repos,${budget} changed: ${what}`);
}
