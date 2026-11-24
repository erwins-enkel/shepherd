/**
 * Review-feedback steer service (#4126): fetch a session PR's review feedback when the PR moves,
 * keep what counts, and deliver it to the task agent as one batched steer — automatically when
 * the repo mode allows it and the agent is at rest with no earlier steer still unconsumed, or on
 * the operator's click. Decisions live in `review-feedback-core.ts`; this file is the I/O and
 * event plumbing around them.
 */
import type { EventHub } from "./events";
import type { GitForge, GitState, PrFeedbackItem } from "./forge/types";
import { steerable } from "./ci-steer";
import {
  AUTO_WINDOW_MS,
  MAX_STEER_ITEMS,
  REVIEW_FEEDBACK_PRESET_BOTS,
  autoSendAllowed,
  buildReviewFeedbackSteer,
  isPrimed,
  preFilter,
  primeCutoff,
  steerConsumed,
  withinAutoCap,
  type ReviewFeedbackMode,
} from "./review-feedback-core";
import type { ReviewFeedbackRow, SessionStore } from "./store";
import type { Session, SessionStatus } from "./types";

/** Least time between two feedback fetches for one session; a burst defers, never drops. */
export const FETCH_MIN_GAP_MS = 60_000;
/** Cadence of the background flush retry (it lets the quiet-window fallback fire unprompted). */
const FLUSH_INTERVAL_MS = 60_000;

/** `session:review-feedback` payload: a session's pending items and the rolling-cap cue. */
export interface ReviewFeedbackEvent {
  id: string;
  pending: ReviewFeedbackRow[];
  autoPaused: boolean;
}

export type ReviewFeedbackStore = Pick<
  SessionStore,
  | "get"
  | "getRepoConfig"
  | "insertReviewFeedbackIfAbsent"
  | "knownReviewFeedbackIds"
  | "listPendingReviewFeedback"
  | "listPendingReviewFeedbackAll"
  | "markReviewFeedbackSent"
  | "markReviewFeedbackDismissed"
  | "reviewFeedbackAutoSentSince"
  | "dropReviewFeedback"
  | "reviewFeedbackActivatedAt"
>;

export interface ReviewFeedbackTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ReviewFeedbackDeps {
  store: ReviewFeedbackStore;
  resolveForge: (repoPath: string) => GitForge | null;
  /** Steer a LIVE pane only (`service.reply(id, text, { automatic: true })`). */
  reply: (id: string, text: string) => Promise<boolean>;
  /** When the last steer of any kind set off toward the session (SessionService.lastSteerAt). */
  lastSteerAt: (id: string) => number | undefined;
  /** The session's effective autopilot. */
  autopilotOn: (s: Session) => boolean;
  /** A critic run on this head is in flight (ReviewService.ciSteerHeld). */
  criticHeld: (id: string, headSha: string) => boolean;
  emit: (payload: ReviewFeedbackEvent) => void;
  /** The persisted PR cache at attach time (PrPoller.snapshot()): no refetch of unchanged PRs. */
  seed?: Record<string, GitState>;
  now?: () => number;
  timers?: ReviewFeedbackTimers;
}

const realTimers: ReviewFeedbackTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** A new review, comment or push moves one of these. */
function triggerKey(git: GitState): string {
  return `${git.number ?? ""}:${git.updatedAt ?? ""}:${git.headSha ?? ""}`;
}

/** The agent finished its turn: herdr reports `done` for a finished turn with the pane alive. */
function atRest(status: SessionStatus | undefined): boolean {
  return status === "idle" || status === "done";
}

function busy(status: SessionStatus | undefined): boolean {
  return status === "running" || status === "blocked";
}

/** What an automatic flush would send, or why it must wait. */
type FlushPlan =
  | { kind: "hold" }
  | { kind: "capped" }
  | { kind: "send"; prNumber: number; items: ReviewFeedbackRow[] };

export class ReviewFeedbackService {
  readonly #deps: ReviewFeedbackDeps;
  readonly #now: () => number;
  readonly #timers: ReviewFeedbackTimers;
  /** Latest `session:git` per session (seeded from the poller cache). */
  readonly #git = new Map<string, GitState>();
  /** Trigger key of the last fetch scheduled per session. */
  readonly #keys = new Map<string, string>();
  readonly #fetching = new Set<string>();
  readonly #refetch = new Set<string>();
  readonly #lastFetchAt = new Map<string, number>();
  readonly #deferred = new Map<string, unknown>();
  readonly #status = new Map<string, SessionStatus>();
  readonly #idleEdgeAt = new Map<string, number>();
  readonly #flushing = new Set<string>();
  readonly #autoPaused = new Map<string, boolean>();
  #interval: unknown = null;
  #unsubscribe: (() => void) | null = null;

  constructor(deps: ReviewFeedbackDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#timers = deps.timers ?? realTimers;
    for (const [id, git] of Object.entries(deps.seed ?? {})) {
      this.#git.set(id, git);
      if (git.state === "open") this.#keys.set(id, triggerKey(git));
    }
  }

  attach(events: EventHub): void {
    this.#unsubscribe = events.subscribe((event, data) => this.#onEvent(event, data));
    this.#interval = this.#timers.setInterval(() => this.#flushAllPending(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#interval !== null) this.#timers.clearInterval(this.#interval);
    this.#interval = null;
    for (const h of this.#deferred.values()) this.#timers.clearTimeout(h);
    this.#deferred.clear();
  }

  /** Every session's pending items plus its rolling-cap cue. */
  pendingAll(): Record<string, { items: ReviewFeedbackRow[]; autoPaused: boolean }> {
    const out: Record<string, { items: ReviewFeedbackRow[]; autoPaused: boolean }> = {};
    for (const [id, items] of this.#deps.store.listPendingReviewFeedbackAll())
      out[id] = { items, autoPaused: this.#autoPaused.get(id) ?? false };
    return out;
  }

  /**
   * The operator's send: the selected pending items (all when `itemIds` is absent) as one steer.
   * Ignores mode, cap, turn state and earlier steers, but needs a live session with a known PR.
   * False when nothing was delivered; the items then stay pending.
   */
  async sendNow(id: string, itemIds?: string[]): Promise<boolean> {
    const s = this.#deps.store.get(id);
    const prNumber = this.#git.get(id)?.number;
    if (!s || s.status === "archived" || s.terminal || prNumber === undefined) return false;
    const want = itemIds ? new Set(itemIds) : null;
    const items = this.#deps.store
      .listPendingReviewFeedback(id)
      .filter((i) => !want || want.has(i.id));
    if (items.length === 0) return false;
    return this.#deliver(id, prNumber, items, "operator");
  }

  dismiss(id: string, itemIds: string[]): void {
    this.#deps.store.markReviewFeedbackDismissed(id, itemIds);
    this.#emitState(id);
  }

  #onEvent(event: string, data: unknown): void {
    if (event === "session:git") {
      const { id, git } = data as { id: string; git: GitState };
      this.#onGit(id, git);
    } else if (event === "session:status") {
      const { id, status } = data as { id: string; status: SessionStatus };
      this.#onStatus(id, status);
    } else if (event === "session:reviewing") {
      const { id, reviewing } = data as { id: string; reviewing: boolean };
      if (!reviewing) void this.tryFlush(id);
    } else if (event === "session:archived") this.#onArchived((data as { id: string }).id);
  }

  #onGit(id: string, git: GitState): void {
    this.#git.set(id, git);
    if (!this.#wantsFetch(id, git)) return;
    const key = triggerKey(git);
    if (this.#keys.get(id) === key) return;
    this.#keys.set(id, key);
    this.#scheduleFetch(id);
  }

  #onStatus(id: string, status: SessionStatus): void {
    const prev = this.#status.get(id);
    this.#status.set(id, status);
    if (busy(prev) && atRest(status)) this.#idleEdgeAt.set(id, this.#now());
    void this.tryFlush(id);
  }

  #onArchived(id: string): void {
    this.#deps.store.dropReviewFeedback(id);
    const timer = this.#deferred.get(id);
    if (timer !== undefined) this.#timers.clearTimeout(timer);
    for (const m of [this.#git, this.#keys, this.#lastFetchAt, this.#deferred, this.#status])
      m.delete(id);
    for (const m of [this.#idleEdgeAt, this.#autoPaused]) m.delete(id);
    this.#refetch.delete(id);
  }

  #mode(s: Session): ReviewFeedbackMode {
    return this.#deps.store.getRepoConfig(s.repoPath).reviewFeedbackMode ?? "autopilot";
  }

  /** An open PR on a live session in a GitHub repo whose mode is not `off`. */
  #wantsFetch(id: string, git: GitState): boolean {
    if (git.state !== "open" || git.number === undefined) return false;
    const s = this.#deps.store.get(id);
    if (!s || s.status === "archived") return false;
    if (!this.#deps.resolveForge(s.repoPath)?.listPrFeedback) return false;
    return this.#mode(s) !== "off";
  }

  /** One fetch in flight per session; a newer key mid-fetch refetches once after; fetches keep
   *  {@link FETCH_MIN_GAP_MS} apart (deferred, not dropped). */
  #scheduleFetch(id: string): void {
    if (this.#fetching.has(id)) {
      this.#refetch.add(id);
      return;
    }
    if (this.#deferred.has(id)) return;
    const last = this.#lastFetchAt.get(id);
    const wait = last === undefined ? 0 : last + FETCH_MIN_GAP_MS - this.#now();
    if (wait <= 0) {
      void this.#runFetch(id);
      return;
    }
    const handle = this.#timers.setTimeout(() => {
      this.#deferred.delete(id);
      void this.#runFetch(id);
    }, wait);
    this.#deferred.set(id, handle);
  }

  async #runFetch(id: string): Promise<void> {
    this.#fetching.add(id);
    this.#lastFetchAt.set(id, this.#now());
    try {
      await this.#ingest(id);
    } catch (err) {
      console.warn(`[review-feedback] fetch for ${id}:`, err);
      this.#keys.delete(id); // retry on the next session:git
    } finally {
      this.#fetching.delete(id);
    }
    if (this.#refetch.delete(id)) this.#scheduleFetch(id);
    await this.tryFlush(id);
  }

  async #ingest(id: string): Promise<void> {
    const s = this.#deps.store.get(id);
    const prNumber = this.#git.get(id)?.number;
    const forge = s ? this.#deps.resolveForge(s.repoPath) : null;
    if (!s || prNumber === undefined || !forge?.listPrFeedback) return;
    const feedback = await forge.listPrFeedback(prNumber);
    const known = this.#deps.store.knownReviewFeedbackIds(id);
    const fresh = feedback.items.filter((i) => !known.has(i.id));
    const ctx = {
      prAuthor: feedback.prAuthor,
      bots: this.#deps.store.getRepoConfig(s.repoPath).reviewFeedbackBots ?? [
        ...REVIEW_FEEDBACK_PRESET_BOTS,
      ],
    };
    const cutoff = primeCutoff(s.createdAt, this.#deps.store.reviewFeedbackActivatedAt());
    let added = false;
    for (const item of fresh) {
      if (await this.#eligible(item, ctx, forge)) added = this.#store(id, item, cutoff) || added;
    }
    if (added) this.#emitState(id);
  }

  /** Persist an eligible item; true when it is newly pending. Nothing lands on an archived row. */
  #store(id: string, item: PrFeedbackItem, cutoff: number): boolean {
    if (this.#deps.store.get(id)?.status === "archived") return false;
    const status = isPrimed(item, cutoff) ? "primed" : "pending";
    return this.#deps.store.insertReviewFeedbackIfAbsent(id, item, status) && status === "pending";
  }

  async #eligible(
    item: PrFeedbackItem,
    ctx: { prAuthor: string; bots: readonly string[] },
    forge: GitForge,
  ): Promise<boolean> {
    const verdict = preFilter(item, ctx);
    if (verdict !== "needs-write-check") return verdict === "bot";
    if (!forge.hasWriteAccess) return false;
    return forge.hasWriteAccess(item.author).catch(() => false); // best-effort: fail closed, no standing
  }

  #flushAllPending(): void {
    for (const id of this.#deps.store.listPendingReviewFeedbackAll().keys()) void this.tryFlush(id);
  }

  /** Send the pending items as one automatic steer when every gate is open. */
  async tryFlush(id: string): Promise<void> {
    if (this.#flushing.has(id)) return;
    const plan = this.#plan(id);
    if (plan.kind === "capped") this.#setAutoPaused(id, true);
    if (plan.kind !== "send") return;
    this.#autoPaused.delete(id); // the send below announces the cleared cue
    await this.#deliver(id, plan.prNumber, plan.items, "auto");
  }

  #plan(id: string): FlushPlan {
    const s = this.#deps.store.get(id);
    const git = this.#git.get(id);
    if (!git || git.number === undefined || !steerable(s, git) || !atRest(s.status))
      return { kind: "hold" };
    if (git.headSha && this.#deps.criticHeld(id, git.headSha)) return { kind: "hold" };
    if (!autoSendAllowed(this.#mode(s), this.#deps.autopilotOn(s))) return { kind: "hold" };
    const now = this.#now();
    if (!steerConsumed(this.#deps.lastSteerAt(id), this.#idleEdgeAt.get(id), now))
      return { kind: "hold" };
    const items = this.#deps.store.listPendingReviewFeedback(id);
    if (items.length === 0) return { kind: "hold" };
    const sentAts = this.#deps.store.reviewFeedbackAutoSentSince(id, now - AUTO_WINDOW_MS);
    if (!withinAutoCap(sentAts, now)) return { kind: "capped" };
    return { kind: "send", prNumber: git.number, items };
  }

  async #deliver(
    id: string,
    prNumber: number,
    items: ReviewFeedbackRow[],
    by: "auto" | "operator",
  ): Promise<boolean> {
    if (this.#flushing.has(id)) return false;
    this.#flushing.add(id);
    // Only what the steer shows is marked sent; overflow stays pending for the next one.
    const batch = items.slice(0, MAX_STEER_ITEMS);
    let sent = false;
    try {
      sent = await this.#deps.reply(id, buildReviewFeedbackSteer(prNumber, batch));
    } catch (err) {
      console.warn(`[review-feedback] steer for ${id}:`, err);
    } finally {
      this.#flushing.delete(id);
    }
    if (!sent) return false;
    this.#deps.store.markReviewFeedbackSent(
      id,
      batch.map((i) => i.id),
      by,
      this.#now(),
    );
    this.#emitState(id);
    return true;
  }

  #setAutoPaused(id: string, paused: boolean): void {
    if ((this.#autoPaused.get(id) ?? false) === paused) return;
    this.#autoPaused.set(id, paused);
    this.#emitState(id);
  }

  #emitState(id: string): void {
    this.#deps.emit({
      id,
      pending: this.#deps.store.listPendingReviewFeedback(id),
      autoPaused: this.#autoPaused.get(id) ?? false,
    });
  }
}
