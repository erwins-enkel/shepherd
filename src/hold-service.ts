import type { HoldReason, Session } from "./types";
import type { GitState } from "./forge/types";
import type { ReviewVerdict, PlanGate, Recap } from "./types";
import type { BlockReason } from "./blocked";
import type { EventHub } from "./events";
import { explainHold } from "./rundown-core";

// ── types ─────────────────────────────────────────────────────────────────────

/** Minimal session-store surface the service needs. */
export interface SessionStore {
  get(id: string): Session | null;
  list(opts?: { activeOnly?: boolean }): Session[];
}

export interface HoldServiceDeps {
  store: SessionStore;
  events: EventHub;
  gitSnapshot: () => Record<string, GitState>;
  reviewSnapshot: () => Record<string, ReviewVerdict>;
  gateSnapshot: () => Record<string, PlanGate>;
  recapSnapshot: () => Record<string, Recap>;
  /** Called when a hold changes (or clears). Wired to events.emit("session:hold", …) in Task 4. */
  onChange: (id: string, hold: HoldReason | null) => void;
  /** Inject for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

// ── service ───────────────────────────────────────────────────────────────────

/**
 * Live in-memory hold-reason service.
 *
 * Subscribes to the EventHub, maintains per-session hold state, and calls
 * `onChange` whenever a session's hold changes. All caches are in-memory; zero
 * I/O (no fs/git/transcript reads — single-loop rule).
 *
 * Seeding choice: the constructor seeds holds for all current active sessions
 * via `recompute`, which DOES emit via `onChange`. This means a reconnecting
 * client gets up-to-date holds immediately on the next broadcast cycle. Task 4
 * can alternatively use `snapshot()` for the bootstrap GET without relying on
 * seed emissions.
 */
export class HoldReasonService {
  private holds = new Map<string, HoldReason>();
  private lastSig = new Map<string, string>();
  private blockCache = new Map<string, BlockReason | null>();
  private mergeErrorSessions = new Set<string>();
  private resetAt: number | undefined;
  private nowFn: () => number;
  private unsubscribe: () => void;

  constructor(private deps: HoldServiceDeps) {
    this.nowFn = deps.now ?? (() => Date.now());

    // Single subscriber handles all events.
    this.unsubscribe = deps.events.subscribe((event, data) => {
      this.handleEvent(event, data);
    });

    // Seed: compute holds for all currently active sessions.
    for (const session of deps.store.list({ activeOnly: true })) {
      this.recompute(session.id);
    }
  }

  // ── public ──────────────────────────────────────────────────────────────────

  /** Current hold map — for the bootstrap GET (Task 4). */
  snapshot(): Record<string, HoldReason> {
    return Object.fromEntries(this.holds);
  }

  /** Unsubscribe from the EventHub; call on teardown if needed. */
  dispose(): void {
    this.unsubscribe();
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private handleEvent(event: string, data: unknown): void {
    const d = data as Record<string, unknown>;

    switch (event) {
      // ── id-bearing session events — recompute the named session ──────────
      case "session:git":
      case "session:review":
      case "session:plangate":
      case "session:status":
      case "session:halt":
      case "session:autopilot":
      case "session:merging":
      case "session:ready": {
        const id = d.id as string;
        this.recompute(id);
        break;
      }

      case "session:block": {
        const id = d.id as string;
        // Update blockCache BEFORE recomputing so the new value feeds explainHold.
        this.blockCache.set(id, (d.block as BlockReason | null) ?? null);
        this.recompute(id);
        break;
      }

      case "automerge:status": {
        const sessionId = d.sessionId as string | null;
        if (!sessionId) return;
        const state = d.state as string | null;
        if (state === "merge_error" || state === "rebase_cap") {
          this.mergeErrorSessions.add(sessionId);
        } else {
          this.mergeErrorSessions.delete(sessionId);
        }
        this.recompute(sessionId);
        break;
      }

      case "usage:limits": {
        const limits = d as { session5h?: { pct: number; resetAt: number } | null };
        this.resetAt = limits.session5h?.resetAt;
        // Recompute ALL active sessions — bounded; dedup guard suppresses no-ops.
        for (const session of this.deps.store.list({ activeOnly: true })) {
          this.recompute(session.id);
        }
        break;
      }

      case "session:archived": {
        const id = d.id as string;
        const hadHold = this.holds.has(id);
        this.holds.delete(id);
        this.lastSig.delete(id);
        this.blockCache.delete(id);
        this.mergeErrorSessions.delete(id);
        if (hadHold) {
          this.deps.onChange(id, null);
        }
        break;
      }
    }
  }

  private recompute(id: string): void {
    const session = this.deps.store.get(id);
    if (!session) {
      // Session absent → treat as cleared.
      const prev = this.lastSig.get(id);
      if (prev !== undefined && prev !== "null") {
        this.holds.delete(id);
        this.lastSig.set(id, "null");
        this.deps.onChange(id, null);
      }
      return;
    }

    const caches = {
      git: this.deps.gitSnapshot()[id],
      review: this.deps.reviewSnapshot()[id],
      gate: this.deps.gateSnapshot()[id],
      recap: this.deps.recapSnapshot()[id],
      train: this.mergeErrorSessions.has(id) ? { error: true as const } : undefined,
      block: this.blockCache.get(id) ?? null,
      resetAt: this.resetAt,
    };

    const hold = explainHold(session, caches, this.nowFn());
    const sig = JSON.stringify(hold); // null → "null"

    if (sig === this.lastSig.get(id)) return; // no change — suppress

    // Apply change.
    this.lastSig.set(id, sig);
    if (hold === null) {
      this.holds.delete(id);
    } else {
      this.holds.set(id, hold);
    }
    this.deps.onChange(id, hold);
  }
}
