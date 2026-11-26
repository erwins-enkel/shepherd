import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { LimitWindow } from "./usage-limits";
import type { CodexFastAvailability, CodexSpeedTarget } from "./codex-speed";

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
function fastModeDisabled(config: Record<string, unknown>, policy: Record<string, unknown>) {
  const features = record(config.features ?? {});
  const requirements = record(policy.requirements ?? {});
  const managedFeatures = record(requirements.featureRequirements ?? {});
  return features.fast_mode === false || managedFeatures.fast_mode === false;
}

function catalogFastTier(model: Record<string, unknown>): CodexFastAvailability {
  if (!Array.isArray(model.serviceTiers)) return { reason: "version" };
  const tier = model.serviceTiers
    .map(record)
    .find((entry) => typeof entry.name === "string" && entry.name.toLowerCase() === "fast");
  return typeof tier?.id === "string" && /^(?:fast|priority)$/.test(tier.id)
    ? { tier: tier.id }
    : { reason: "model" };
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

function subscriptionWindow(
  value: unknown,
): Partial<Pick<CodexAccountSnapshot, "session5h" | "week">> {
  const w = record(value);
  const key =
    w.windowDurationMins === 300 ? "session5h" : w.windowDurationMins === 10080 ? "week" : null;
  return key
    ? { [key]: { pct: Math.min(100, number(w.usedPercent)), resetAt: number(w.resetsAt) * 1000 } }
    : {};
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
    Object.assign(result, subscriptionWindow(rawWindow));
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
  async readFastTier(target: CodexSpeedTarget): Promise<CodexFastAvailability> {
    try {
      await this.connect();
      const account = record(await this.request("account/read", { refreshToken: false }));
      if (!account.account) return { reason: "login" };
      const config = record(
        record(await this.request("config/read", { cwd: target.cwd, includeLayers: false })).config,
      );
      const policy = record(await this.request("configRequirements/read"));
      if (fastModeDisabled(config, policy)) return { reason: "disabled" };
      const provider = target.provider ?? config.model_provider ?? "openai";
      const model = target.model ?? config.model;
      if (typeof provider !== "string" || (model != null && typeof model !== "string"))
        return { reason: "unknown" };
      return await this.findCatalogFastTier(provider, model);
    } catch {
      return { reason: "unknown" };
    }
  }

  private async findCatalogFastTier(
    provider: string,
    model: string | null | undefined,
  ): Promise<CodexFastAvailability> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const page = record(await this.request("model/list", { modelProvider: provider, cursor }));
      if (!Array.isArray(page.data)) return { reason: "unknown" };
      const row = page.data
        .map(record)
        .find((entry) =>
          model == null ? entry.isDefault === true : entry.model === model || entry.id === model,
        );
      if (row) return catalogFastTier(row);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && visited.has(cursor)) return { reason: "unknown" };
      if (cursor) visited.add(cursor);
    } while (cursor);
    return { reason: "model" };
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
