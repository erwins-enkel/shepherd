/**
 * The judge's daily spend ceiling (issue #2369).
 *
 * The judge adds a metered, billed call where Shepherd previously spent only subscription quota.
 * Per-call cost is tiny, so this ceiling is a RUNAWAY GUARD rather than a budget: its job is to
 * bound a pathological loop, not to ration normal use. On breach the judge stops being asked and
 * `classifyStop` falls back to the `claude` spawn it already had — so a breach costs quota and
 * latency, never a capability.
 *
 * Persisted per day rather than held in memory: an in-memory counter resets on every restart, which
 * makes the ceiling escapable by exactly the crash-loop it most needs to bound.
 */

import type { SessionStore } from "./store";

/** Local calendar day, `YYYY-MM-DD`. Local rather than UTC to match the operator's other daily
 *  knobs (the nightly sweep hours), so "today" means the same thing across the product. */
export function dayKey(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The day `days` before `now`, as a key — the retention cutoff for {@link SessionStore.pruneJudgeSpend}. */
export function dayKeyBefore(now: number, days: number): string {
  return dayKey(now - days * 24 * 60 * 60 * 1000);
}

export interface JudgeSpendDeps {
  store: Pick<SessionStore, "getJudgeSpend" | "addJudgeSpend" | "claimJudgeCeilingNotice">;
  /** Read live, not captured: the operator can change the ceiling from Settings mid-run. */
  ceilingUsd: () => number;
  /** Fired at most once per day, when the ceiling first blocks a call. */
  onCeilingReached: (spentUsd: number, ceilingUsd: number) => void;
  now?: () => number;
}

/** Today's spend, for the usage surface. */
export interface JudgeSpendToday {
  day: string;
  calls: number;
  usd: number;
  ceilingUsd: number;
}

export class JudgeSpendLedger {
  private readonly now: () => number;

  constructor(private readonly deps: JudgeSpendDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Whether another call is affordable. Fires the operator notice on the first refusal of the day. */
  allow(): boolean {
    const ceiling = this.deps.ceilingUsd();
    const day = dayKey(this.now());
    const spent = this.deps.store.getJudgeSpend(day)?.usd ?? 0;
    if (spent < ceiling) return true;
    // `claim` is the once-per-day latch, and it lives in the DB rather than in a field so a restart
    // inside a breached day cannot re-notify.
    if (this.deps.store.claimJudgeCeilingNotice(day, this.now())) {
      this.deps.onCeilingReached(spent, ceiling);
    }
    return false;
  }

  /** Book a completed call. Best-effort: a ledger write that throws must not lose the verdict the
   *  caller already paid for, so the caller logs and carries on. */
  record(costUsd: number): void {
    this.deps.store.addJudgeSpend(dayKey(this.now()), costUsd);
  }

  today(): JudgeSpendToday {
    const day = dayKey(this.now());
    const row = this.deps.store.getJudgeSpend(day);
    return {
      day,
      calls: row?.calls ?? 0,
      usd: row?.usd ?? 0,
      ceilingUsd: this.deps.ceilingUsd(),
    };
  }
}
