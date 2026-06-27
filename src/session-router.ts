import { buildSnapshot, type SessionStateChange, type SnapshotAccessors } from "./session-snapshot";
import type { GitState } from "./forge/types";

/** A consumer of session changes. Implementations adapt drain / autopilot. `name` is
 *  used only for the router's error log line. */
export interface SessionConsumer {
  readonly name: string;
  handle(change: SessionStateChange): Promise<void>;
}

export interface SessionRouterHooks {
  /** Fired on a `status` change BEFORE the consumer chain is awaited — used to hoist
   *  autopilot's PR-prewarm kick so awaiting drain doesn't delay it. Best-effort/sync. */
  onStatusPrewarm?: (id: string) => void;
  /** Fired on a `status` change AFTER the consumer chain — an independent side-effect
   *  (plan-gate). Reached regardless of any consumer throwing. */
  onStatusSettled?: (change: Extract<SessionStateChange, { kind: "status" }>) => void;
}

/** The single "what happens next" seam. Builds the shared snapshot ONCE per change and
 *  dispatches `consumers` strictly in order, AWAITING each fully before the next — this
 *  is what kills the retire-vs-steer race (fire-and-forget could not). Each consumer (and
 *  each hook) is isolated in try/catch so one failure is logged and does NOT prevent the
 *  next consumer or the settled hook from running; ordering still holds on the success path. */
export class SessionRouter {
  constructor(
    private acc: SnapshotAccessors,
    /** Ordered. Pass [drainConsumer, autopilotConsumer] — drain before autopilot. */
    private consumers: SessionConsumer[],
    private hooks: SessionRouterHooks = {},
    private warn: (msg: string, err: unknown) => void = (m, e) => console.warn(m, e),
  ) {}

  async onStatus(id: string, status: string): Promise<void> {
    const change = buildSnapshot(this.acc, id, { kind: "status", status });
    if (!change) return;
    this.safeSync(() => this.hooks.onStatusPrewarm?.(id), "prewarm");
    await this.dispatch(change);
    this.safeSync(
      () => this.hooks.onStatusSettled?.(change as Extract<SessionStateChange, { kind: "status" }>),
      "settled",
    );
  }

  async onGit(id: string, git: GitState): Promise<void> {
    const change = buildSnapshot(this.acc, id, { kind: "git", git });
    if (!change) return;
    await this.dispatch(change);
  }

  private async dispatch(change: SessionStateChange): Promise<void> {
    for (const c of this.consumers) {
      try {
        await c.handle(change);
      } catch (err) {
        this.warn(`[session-router] ${c.name} ${change.kind}:`, err);
      }
    }
  }

  private safeSync(fn: () => void, label: string): void {
    try {
      fn();
    } catch (err) {
      this.warn(`[session-router] ${label}:`, err);
    }
  }
}
