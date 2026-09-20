import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { LimitWindow } from "./usage-limits";

export interface CodexResetCredits {
  availableCount: number;
  credits: { id: string; expiresAt: number | null }[] | null;
}
export interface CodexAccountSnapshot {
  accountId: string | null;
  checkedAt: number;
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  resets: CodexResetCredits | null;
}
export type CodexResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
export interface CodexResetRequest {
  idempotencyKey: string;
  creditId?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Codex account response");
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid Codex account number");
  return value;
}
function resetCredits(value: unknown): CodexResetCredits | null {
  if (value == null) return null;
  const r = record(value);
  const availableCount = number(r.availableCount);
  if (!Number.isInteger(availableCount)) throw new Error("Invalid Codex reset count");
  if (r.credits == null) return { availableCount, credits: null };
  if (!Array.isArray(r.credits)) throw new Error("Invalid Codex reset details");
  const credits = r.credits.flatMap((value) => {
    const credit = record(value);
    if (credit.resetType !== "codexRateLimits" || credit.status !== "available") return [];
    if (typeof credit.id !== "string" || !credit.id) throw new Error("Invalid Codex reset id");
    return [
      {
        id: credit.id,
        expiresAt: credit.expiresAt == null ? null : number(credit.expiresAt) * 1000,
      },
    ];
  });
  return { availableCount, credits };
}

/** Normalize only Codex's recognized subscription windows; never mistake another bucket for headroom. */
export function parseCodexAccount(value: unknown, checkedAt: number): CodexAccountSnapshot {
  const r = record(value);
  const result: CodexAccountSnapshot = {
    accountId: typeof r.accountId === "string" && r.accountId ? r.accountId : null,
    checkedAt,
    session5h: null,
    week: null,
    resets: resetCredits(r.rateLimitResetCredits),
  };
  const buckets = r.rateLimitsByLimitId == null ? null : record(r.rateLimitsByLimitId);
  const raw = buckets ? buckets.codex : r.rateLimits;
  if (raw == null) return result;
  const bucket = record(raw);
  if (bucket.limitId != null && bucket.limitId !== "codex") return result;
  for (const rawWindow of [bucket.primary, bucket.secondary]) {
    if (rawWindow == null) continue;
    const w = record(rawWindow);
    const key =
      w.windowDurationMins === 300 ? "session5h" : w.windowDurationMins === 10080 ? "week" : null;
    if (key)
      result[key] = {
        pct: Math.min(100, number(w.usedPercent)),
        resetAt: number(w.resetsAt) * 1000,
      };
  }
  return result;
}

/** A single local app-server connection. This client never starts threads or model turns. */
export class CodexAccountClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private deps: {
      spawn?: () => ChildProcessWithoutNullStreams;
      now?: () => number;
      timeoutMs?: number;
    } = {},
  ) {}

  private connect(): Promise<void> {
    if (this.initialized) return this.initialized;
    const child =
      this.deps.spawn?.() ?? spawn("codex", ["app-server", "--stdio"], { stdio: "pipe" });
    this.child = child;
    // Drain stderr without publishing config, account information or provider error payloads.
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.on("error", () => this.fail(new Error("Codex app-server unavailable")));
    child.stdin.on("error", () => this.fail(new Error("Codex app-server connection closed")));
    child.on("exit", () => {
      lines.close();
      if (this.child === child) this.fail(new Error("Codex app-server exited"));
    });
    this.initialized = this.request("initialize", {
      clientInfo: { name: "shepherd", version: "1" },
    }).then(() => {
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    });
    return this.initialized;
  }
  private receive(line: string): void {
    let r: Record<string, unknown>;
    try {
      r = record(JSON.parse(line));
    } catch {
      this.fail(new Error("Invalid Codex RPC response"));
      return;
    }
    if (typeof r.id !== "number") return;
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    clearTimeout(p.timer);
    if (r.error != null) p.reject(new Error("Codex account RPC failed"));
    else p.resolve(r.result);
  }
  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Codex account RPC timed out")),
        this.deps.timeoutMs ?? 10_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + "\n",
      );
    });
  }
  private fail(error: Error): void {
    const child = this.child;
    this.child = null;
    this.initialized = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    child?.kill();
  }
  async readLimits(): Promise<CodexAccountSnapshot> {
    await this.connect();
    return parseCodexAccount(
      await this.request("account/rateLimits/read"),
      this.deps.now?.() ?? Date.now(),
    );
  }
  async consumeReset(params: CodexResetRequest): Promise<CodexResetOutcome> {
    if (!params.idempotencyKey || params.creditId === "")
      throw new Error("Invalid Codex reset request");
    await this.connect();
    const r = record(await this.request("account/rateLimitResetCredit/consume", params));
    if (
      r.outcome !== "reset" &&
      r.outcome !== "alreadyRedeemed" &&
      r.outcome !== "nothingToReset" &&
      r.outcome !== "noCredit"
    )
      throw new Error("Unknown Codex reset outcome");
    return r.outcome;
  }
  close(): void {
    this.fail(new Error("Codex account client closed"));
  }
}
