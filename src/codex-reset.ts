import { randomUUID } from "node:crypto";
import type { CodexAccountSnapshot, CodexResetOutcome, CodexResetRequest } from "./codex-account";
import type { CodexResetStatus } from "./usage-limits";

const MINUTE = 60_000;
const STATE_KEY = "codexResetState";
type Reason = "capacity" | "expiry" | "manual";
interface DecisionInput {
  measurement: CodexAccountSnapshot;
  demand: boolean;
  rateHistory: CodexAccountSnapshot[];
  now: number;
}
function rateFor(i: DecisionInput, key: "session5h" | "week"): number {
  const current = i.measurement[key];
  if (!current) return 0;
  return Math.max(
    ...[5, 15].map((minutes) => {
      const samples = i.rateHistory.filter(
        (s) =>
          s.accountId === i.measurement.accountId &&
          s.checkedAt >= i.now - minutes * MINUTE &&
          s.checkedAt <= i.now - MINUTE &&
          s[key]?.resetAt === current.resetAt,
      );
      const first = samples[0];
      if (!first?.[key] || first[key].pct >= current.pct) return 0;
      // A decrease anywhere in this interval invalidates the old baseline.
      const relevant = [...samples, i.measurement];
      if (relevant.some((s, n) => n > 0 && s[key]!.pct < relevant[n - 1]![key]!.pct)) return 0;
      return (
        (current.pct - first[key].pct) / ((i.measurement.checkedAt - first.checkedAt) / MINUTE)
      );
    }),
  );
}
function pressure(i: DecisionInput): boolean {
  return (["session5h", "week"] as const).some((key) => {
    const w = i.measurement[key];
    if (!w) return false;
    if (w.pct >= 95) return true;
    const rate = rateFor(i, key);
    const left = rate > 0 ? ((100 - w.pct) / rate) * MINUTE : Infinity;
    return left <= 15 * MINUTE && i.now + left < w.resetAt;
  });
}
function creditFor(m: CodexAccountSnapshot, now: number): string | undefined | null {
  const r = m.resets;
  if (!r || r.availableCount <= 0) return null;
  if (r.credits === null) return undefined; // count-only: let the service select
  const valid = r.credits.filter((c) => c.expiresAt === null || c.expiresAt > now);
  valid.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return valid[0]?.id ?? (r.availableCount > r.credits.length ? undefined : null);
}
export function decideCodexReset(
  i: DecisionInput,
): { reason: "capacity" | "expiry"; creditId?: string } | null {
  if (!i.demand || !i.measurement.accountId || i.now - i.measurement.checkedAt > 90_000)
    return null;
  const id = creditFor(i.measurement, i.now);
  if (id === null) return null;
  const credit = id === undefined ? {} : { creditId: id };
  if (pressure(i)) return { reason: "capacity", ...credit };
  const expires = i.measurement.resets?.credits?.find((c) => c.id === id)?.expiresAt;
  if (expires == null || expires - i.now > 60 * MINUTE) return null;
  const worthwhile = (["session5h", "week"] as const).some((key) => {
    const w = i.measurement[key];
    const rate = rateFor(i, key);
    return w && w.pct >= 50 && rate > 0 && i.now + ((100 - w.pct) / rate) * MINUTE < w.resetAt;
  });
  return worthwhile ? { reason: "expiry", ...credit } : null;
}
interface Operation {
  accountId: string;
  request: CodexResetRequest;
  reason: Reason;
  before: CodexAccountSnapshot;
  phase: "uncertain" | "verify";
  retryAt: number;
  attempts: number;
  aliases: string[];
}
interface ResetState {
  operation: Operation | null;
  lastOutcome: CodexResetOutcome | null;
  lastReason: Reason | null;
  lastAttemptAt: number;
  lastSignature: string | null;
  completed: string[];
}
interface ResetDeps {
  client: {
    readLimits(): Promise<CodexAccountSnapshot>;
    consumeReset(r: CodexResetRequest): Promise<CodexResetOutcome>;
  };
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void };
  enabled(): boolean;
  now?: () => number;
}
function signature(m: CodexAccountSnapshot): string {
  return JSON.stringify([m.accountId, m.session5h, m.week, m.resets]);
}

/** Owns one durable redemption, shared by manual, timer and admission paths. */
export class CodexResetCoordinator {
  private measurement: CodexAccountSnapshot | null = null;
  private history: CodexAccountSnapshot[] = [];
  private state: ResetState;
  private reading: Promise<boolean> | null = null;
  private acting: Promise<void> | null = null;
  private unavailable = true;
  private manualIds: string[] = [];
  private actedWithResult = false;
  private waitingCount = 0;
  constructor(private deps: ResetDeps) {
    const saved = deps.store.getSetting(STATE_KEY);
    this.state = saved
      ? (JSON.parse(saved) as ResetState)
      : {
          operation: null,
          lastOutcome: null,
          lastReason: null,
          lastAttemptAt: 0,
          lastSignature: null,
          completed: [],
        };
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private save(): void {
    this.deps.store.setSetting(STATE_KEY, JSON.stringify(this.state));
  }
  setWaitingCount(count: number): void {
    this.waitingCount = count;
  }
  currentAccountId(): string | null {
    return this.measurement?.accountId ?? null;
  }
  async refresh(): Promise<boolean> {
    if (this.reading) return this.reading;
    this.reading = this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
  private async read(): Promise<boolean> {
    try {
      const m = await this.deps.client.readLimits();
      if (
        this.measurement?.accountId !== m.accountId ||
        (["session5h", "week"] as const).some((key) => {
          const before = this.measurement?.[key];
          const after = m[key];
          return before && after && (after.pct < before.pct || after.resetAt !== before.resetAt);
        })
      )
        this.history = [];
      this.measurement = m;
      this.history = this.history.filter((s) => s.checkedAt >= this.now() - 15 * MINUTE);
      if (this.history.at(-1)?.checkedAt !== m.checkedAt) this.history.push(m);
      this.unavailable = false;
      const op = this.state.operation;
      if (
        op?.phase === "verify" &&
        m.accountId === op.accountId &&
        (["session5h", "week"] as const).some(
          (key) => m[key] && op.before[key] && m[key]!.pct < op.before[key]!.pct,
        ) &&
        !pressure({ measurement: m, demand: true, rateHistory: this.history, now: this.now() })
      ) {
        this.state.operation = null;
        this.save();
      }
      return true;
    } catch {
      this.unavailable = true;
      return false;
    }
  }
  private input(): DecisionInput | null {
    return this.measurement
      ? { measurement: this.measurement, demand: true, rateHistory: this.history, now: this.now() }
      : null;
  }
  canRun(): boolean {
    if (this.state.operation) return false;
    const i = this.input();
    const fresh = i && !this.unavailable && i.now - i.measurement.checkedAt <= 90_000;
    if (!fresh)
      return (
        !this.deps.enabled() &&
        ![this.measurement?.session5h, this.measurement?.week].some((w) => w && w.pct >= 100)
      );
    const windows = [i.measurement.session5h, i.measurement.week].filter((w) => w !== null);
    if (windows.some((w) => w.pct >= 100)) return false;
    if (!this.deps.enabled()) return true;
    return !!i.measurement.accountId && windows.some((w) => w.resetAt > i.now) && !pressure(i);
  }
  ensureCapacity(demand: boolean, expectedAccountId?: string | null): Promise<void> {
    return this.act(demand, undefined, expectedAccountId);
  }
  redeemManual(requestId: string): Promise<void> {
    return this.act(true, requestId);
  }
  private act(
    demand: boolean,
    manualId?: string,
    expectedAccountId?: string | null,
  ): Promise<void> {
    if (manualId && this.state.completed.includes(manualId)) return Promise.resolve();
    if (this.acting) {
      if (manualId) {
        this.manualIds.push(manualId);
        if (this.actedWithResult || this.state.operation?.phase === "verify") {
          this.state.completed = [...this.state.completed, manualId].slice(-128);
          this.save();
        }
        if (this.state.operation) {
          this.state.operation.aliases = [
            ...new Set([...(this.state.operation.aliases ?? []), manualId]),
          ];
          this.save();
        }
      }
      return this.acting;
    }
    this.manualIds = manualId ? [manualId] : [];
    this.actedWithResult = false;
    this.acting = this.actInner(demand, manualId, expectedAccountId).finally(() => {
      this.acting = null;
    });
    return this.acting;
  }
  private async actInner(
    demand: boolean,
    manualId?: string,
    expectedAccountId?: string | null,
  ): Promise<void> {
    if (manualId && this.state.completed.includes(manualId)) return;
    if (
      !this.measurement ||
      this.unavailable ||
      this.now() - this.measurement.checkedAt >= 30_000 ||
      manualId ||
      this.state.operation
    ) {
      if (!(await this.refresh())) return;
    }
    let m = this.measurement!;
    if (expectedAccountId && m.accountId !== expectedAccountId) return;
    const existing = this.state.operation;
    if (existing) {
      if (manualId) {
        existing.aliases = [...new Set([...(existing.aliases ?? []), manualId])];
        if (existing.phase === "verify")
          this.state.completed = [...this.state.completed, manualId].slice(-128);
        this.save();
      }
      if (
        m.accountId !== existing.accountId ||
        existing.phase === "verify" ||
        this.now() < existing.retryAt
      )
        return;
      await this.consume(existing);
      return;
    }
    if (!manualId && (!this.deps.enabled() || !demand)) return;
    if (!m.accountId) return;
    const i = this.input()!;
    const id = creditFor(m, this.now());
    let decision = manualId
      ? id === null
        ? null
        : { reason: "manual" as const, ...(id === undefined ? {} : { creditId: id }) }
      : decideCodexReset(i);
    if (!decision) return;
    if (
      !manualId &&
      (this.now() - this.state.lastAttemptAt < MINUTE || this.state.lastSignature === signature(m))
    )
      return;
    // Admission can reuse a recent read; spending always revalidates immediately.
    if (!(await this.refresh())) return;
    m = this.measurement!;
    const freshId = creditFor(m, this.now());
    decision = manualId
      ? freshId === null
        ? null
        : { reason: "manual" as const, ...(freshId === undefined ? {} : { creditId: freshId }) }
      : decideCodexReset(this.input()!);
    if (!decision || !m.accountId || m.accountId !== i.measurement.accountId) return;
    const op: Operation = {
      accountId: m.accountId,
      request: {
        idempotencyKey: manualId ?? randomUUID(),
        ...(decision.creditId ? { creditId: decision.creditId } : {}),
      },
      reason: decision.reason,
      before: m,
      phase: "uncertain",
      retryAt: this.now(),
      attempts: 0,
      aliases: [...this.manualIds],
    };
    this.state.operation = op;
    this.state.lastReason = op.reason;
    this.state.lastAttemptAt = this.now();
    this.state.lastSignature = signature(m);
    this.save(); // write-ahead: losing the response must never mint a second key
    await this.consume(op);
  }
  private async consume(op: Operation): Promise<void> {
    op.attempts++;
    op.retryAt = this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(op.attempts - 1, 4));
    this.save();
    try {
      const result = await this.deps.client.consumeReset(op.request);
      this.actedWithResult = true;
      this.state.lastOutcome = result;
      this.state.completed = [
        ...this.state.completed,
        op.request.idempotencyKey,
        ...(op.aliases ?? []),
      ].slice(-128);
      if (result === "reset" || result === "alreadyRedeemed") op.phase = "verify";
      else this.state.operation = null;
      this.save();
      await this.refresh();
    } catch {
      /* Keep the same durable operation and key; never assume failure means no spend. */
    }
  }
  snapshot(): { measurement: CodexAccountSnapshot | null; resetStatus: CodexResetStatus } {
    const m = this.measurement;
    const op = this.state.operation;
    const stale = !m || this.now() - m.checkedAt > 90_000 || this.unavailable;
    const expiries =
      m?.resets?.credits?.flatMap((c) =>
        c.expiresAt !== null && c.expiresAt > this.now() ? [c.expiresAt] : [],
      ) ?? [];
    let state: CodexResetStatus["state"] = this.canRun() ? "ready" : "waiting";
    if (stale) state = "unavailable";
    if (op)
      state =
        op.accountId !== m?.accountId
          ? "account_changed"
          : op.phase === "verify"
            ? "verifying"
            : "redeeming";
    return {
      measurement: m,
      resetStatus: {
        autoEnabled: this.deps.enabled(),
        state,
        checkedAt: m?.checkedAt ?? null,
        availableCount: m?.resets?.availableCount ?? null,
        nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
        reason: this.state.lastReason,
        lastOutcome: this.state.lastOutcome,
        waitingCount: this.waitingCount,
      },
    };
  }
}
