import type { AgentProvider } from "./types";
import type { CodexResetCoordinator } from "./codex-reset";

export interface CapacityIntent {
  owner:
    | "classifier"
    | "planFindings"
    | "planRelease"
    | "reviewFindings"
    | "session"
    | "autopilot"
    | "plan"
    | "review"
    | "standalone"
    | "docsRetarget"
    | "docs"
    | "maintain"
    | "drain"
    | "automerge"
    | "buildQueue";
  key: string;
  target: string;
  provider: AgentProvider;
  model: string | null;
  fingerprint?: string;
}
export type CapacityInterruptionCheck = (
  intent: CapacityIntent,
  worktreePath: string,
  trackingId: string,
) => Promise<boolean>;
export type CapacityCheck = (intent: CapacityIntent) => Promise<boolean>;
interface PendingIntent extends CapacityIntent {
  accountId: string | null;
}
const KEY = "codexCapacityPending";

/** Durable work identities, not replayable terminal commands. Owners revalidate before resuming. */
export class CodexCapacityGate {
  private intents: PendingIntent[];
  private reconciling = false;
  constructor(
    private deps: {
      store: {
        getSetting(key: string): string | null;
        setSetting(key: string, value: string): void;
      };
      reset: Pick<
        CodexResetCoordinator,
        "ensureCapacity" | "canRun" | "currentAccountId" | "setWaitingCount"
      >;
    },
  ) {
    this.intents = JSON.parse(deps.store.getSetting(KEY) ?? "[]") as PendingIntent[];
    deps.reset.setWaitingCount(this.intents.length);
  }
  private save(): void {
    this.deps.store.setSetting(KEY, JSON.stringify(this.intents));
    this.deps.reset.setWaitingCount(this.intents.length);
  }
  pending(): readonly PendingIntent[] {
    return this.intents;
  }
  async admit(intent: CapacityIntent): Promise<boolean> {
    if (intent.provider !== "codex") return true;
    const expectedAccountId = this.intents.find((i) => i.key === intent.key)?.accountId;
    await this.deps.reset.ensureCapacity(true, expectedAccountId);
    const existing = this.intents.find((i) => i.key === intent.key);
    const accountId = this.deps.reset.currentAccountId();
    if (this.deps.reset.canRun() && (!existing?.accountId || existing.accountId === accountId)) {
      if (existing) {
        this.intents = this.intents.filter((i) => i !== existing);
        this.save();
      }
      return true;
    }
    if (existing)
      this.intents = this.intents.map((i) =>
        i === existing ? { ...intent, accountId: existing.accountId ?? accountId } : i,
      );
    else if (this.intents.length < 1024) this.intents.push({ ...intent, accountId });
    this.save();
    return false;
  }
  defer(intent: CapacityIntent): void {
    const existing = this.intents.find((i) => i.key === intent.key);
    if (existing) return;
    if (this.intents.length < 1024)
      this.intents.push({ ...intent, accountId: this.deps.reset.currentAccountId() });
    this.save();
  }
  forget(target: string): void {
    const next = this.intents.filter((i) => i.target !== target);
    if (next.length === this.intents.length) return;
    this.intents = next;
    this.save();
  }
  prune(valid: (intent: CapacityIntent) => boolean): void {
    const next = this.intents.filter(valid);
    if (next.length === this.intents.length) return;
    this.intents = next;
    this.save();
  }
  async reconcile(run: (intent: CapacityIntent) => Promise<boolean>): Promise<void> {
    if (this.reconciling || !this.intents.length) return;
    this.reconciling = true;
    try {
      await this.deps.reset.ensureCapacity(false);
      let count = 0;
      for (const intent of [...this.intents]) {
        if (!this.deps.reset.canRun() || count >= 3) break;
        const account = this.deps.reset.currentAccountId();
        if (!account || (intent.accountId && intent.accountId !== account)) continue;
        await this.deps.reset.ensureCapacity(true, intent.accountId);
        if (!this.deps.reset.canRun()) break;
        count++;
        if (await run(intent)) {
          this.intents = this.intents.filter((i) => i !== intent);
          this.save();
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
}

/** Internal deferral, never a model verdict or an execution failure. */
export class CodexCapacityWait extends Error {
  constructor() {
    super("Codex capacity unavailable");
  }
}

/** Error identity comes from Codex protocol events, never assistant prose. */
export function codexCapacityInterrupted(text: string): boolean {
  let blocked = false;
  for (const line of text.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "event_msg") continue;
    const p = event.payload;
    if (p?.type === "task_started" || p?.type === "task_complete") blocked = false;
    if (p?.type === "error")
      blocked = ["usage_limit_exceeded", "usageLimitExceeded", "UsageLimitExceeded"].includes(
        p.codex_error_info,
      );
  }
  return blocked;
}

/** Keep a held task on its original account across restarts and account switches. */
export async function heldCodexCapacity(
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void },
  reset: Pick<CodexResetCoordinator, "ensureCapacity" | "canRun" | "currentAccountId">,
  taskId?: string,
): Promise<boolean> {
  const key = taskId ? `codexHeldAccount:${taskId}` : null;
  const expected = key ? store.getSetting(key) : null;
  await reset.ensureCapacity(true, expected);
  const account = reset.currentAccountId();
  if (key && !expected && account) store.setSetting(key, account);
  return reset.canRun() && (!expected || expected === account);
}
