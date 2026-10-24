import type { SessionActivity } from "./activity-signal";

interface Clock {
  now(): number;
  schedule(run: () => void, delayMs: number): () => void;
}
interface PendingActivity {
  sentAt: number;
  signature?: string;
  latest?: SessionActivity;
  errors: Set<number>;
  cancel?: () => void;
}

/** Limit transport callbacks, keeping the poller's detection and bootstrap snapshot immediate. */
export class SessionActivityPublisher {
  private sessions = new Map<string, PendingActivity>();
  private stopped = false;

  constructor(
    private emit: (id: string, activity: SessionActivity) => void,
    private isActive: (id: string) => boolean,
    private clock: Clock = {
      now: Date.now,
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  ) {}

  publish(id: string, activity: SessionActivity): void {
    if (this.stopped) return;
    if (!this.isActive(id)) return this.forget(id);
    let pending = this.sessions.get(id);
    if (!pending) {
      pending = { sentAt: -Infinity, errors: new Set() };
      this.sessions.set(id, pending);
    }
    // Hook success frames carry no previous errors. Keep errors from skipped frames while
    // their ticks are still in the newest full strip; never approximate or truncate ticks.
    for (const ts of activity.recentErrTs) pending.errors.add(ts);
    pending.errors = new Set(activity.recentTs.filter((ts) => pending.errors.has(ts)));
    pending.latest = { ...activity, recentErrTs: [...pending.errors] };
    const delay = pending.sentAt + 2000 - this.clock.now();
    if (delay <= 0) this.flush(id, pending);
    else if (!pending.cancel) {
      pending.cancel = this.clock.schedule(() => this.flush(id, pending), delay);
    }
  }

  private flush(id: string, pending: PendingActivity): void {
    pending.cancel?.();
    pending.cancel = undefined;
    if (!this.isActive(id)) return this.forget(id);
    const activity = pending.latest!;
    pending.latest = undefined;
    const signature = JSON.stringify(activity);
    if (pending.signature === signature) return;
    this.emit(id, activity);
    pending.signature = signature;
    pending.sentAt = this.clock.now();
  }

  forget(id: string): void {
    this.sessions.get(id)?.cancel?.();
    this.sessions.delete(id);
  }

  prune(activeIds: ReadonlySet<string>): void {
    for (const id of this.sessions.keys()) if (!activeIds.has(id)) this.forget(id);
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.sessions.keys()) this.forget(id);
  }
}
