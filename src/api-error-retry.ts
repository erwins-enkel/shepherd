import { API_RETRY_STEER, transientApiError } from "./api-error-retry-core";
import type { SessionConsumer } from "./session-router";
import type { SessionStateChange } from "./session-snapshot";
import type { Session } from "./types";

/** Backoff before attempt n (1-based index n-1). Its length is the attempt cap per error streak. */
export const API_RETRY_DELAYS_MS = [20_000, 60_000, 180_000] as const;

export interface ApiErrorRetryDeps {
  getSession: (id: string) => Session | null;
  /** The session's transcript tail (JSONL), or null when unreadable. */
  readTranscript: (s: Session) => Promise<string | null>;
  /** Type the retry steer into the pane; false when it could not be delivered. */
  steer: (id: string, text: string) => Promise<boolean>;
  /** Retries exhausted: flag the session halted on an error. */
  setHalt: (id: string, haltedAt: number) => void;
  /** A pending retry ended without steering a resting session — let autopilot classify the stop
   *  it stood down from (autopilot.onDone; its own eligibility guards apply). */
  handBack: (id: string) => Promise<void>;
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  log?: (msg: string) => void;
}

interface Streak {
  /** uuid of the error record the latest attempt targets. */
  uuid: string;
  /** Attempts scheduled in this streak (incl. a pending one). */
  attempts: number;
  /** Cancel for the armed timer; null when none is pending. */
  cancel: (() => void) | null;
  exhausted: boolean;
}

/**
 * Auto-retry for a Claude turn that died on a transient API error (stream cut / 529 / 5xx). On a
 * done edge whose transcript ends on such an error, schedule a backed-off "continue" steer; after
 * {@link API_RETRY_DELAYS_MS}.length consecutive errors flag the session halted instead. A done edge
 * that ends cleanly resets the streak. Runs for every Claude session (attended + autopilot), ahead
 * of autopilot in the session router — autopilot stands down while {@link pending} is true. State
 * is in-memory: a restart drops pending retries (the session then behaves as before this existed).
 */
export class ApiErrorRetry implements SessionConsumer {
  readonly name = "api-retry";
  private streaks = new Map<string, Streak>();

  constructor(private deps: ApiErrorRetryDeps) {}

  /** A retry is armed for this session (autopilot must not classify the stop). */
  pending(id: string): boolean {
    return this.streaks.get(id)?.cancel != null;
  }

  forget(id: string): void {
    this.streaks.get(id)?.cancel?.();
    this.streaks.delete(id);
  }

  async handle(change: SessionStateChange): Promise<void> {
    if (change.kind !== "status" || change.status !== "done") return;
    const s = change.snapshot.session;
    if (!eligible(s)) return;
    const err = transientApiError((await this.deps.readTranscript(s)) ?? "");
    if (!err) {
      this.forget(s.id); // clean turn end → streak over
      return;
    }
    const streak = this.streaks.get(s.id);
    if (streak?.uuid === err.uuid && (streak.cancel || streak.exhausted)) return; // repeat edge
    const attempts = streak?.attempts ?? 0;
    if (attempts >= API_RETRY_DELAYS_MS.length) {
      this.streaks.set(s.id, { uuid: err.uuid, attempts, cancel: null, exhausted: true });
      this.log(`[api-retry] exhausted ${s.desig} after ${attempts} attempts`);
      this.deps.setHalt(s.id, this.deps.now());
      return;
    }
    const delay = API_RETRY_DELAYS_MS[attempts]!;
    const cancel = this.deps.schedule(() => void this.fire(s.id, err.uuid), delay);
    this.streaks.set(s.id, { uuid: err.uuid, attempts: attempts + 1, cancel, exhausted: false });
    this.log(
      `[api-retry] scheduled ${s.desig} attempt=${attempts + 1}/${API_RETRY_DELAYS_MS.length} in=${delay / 1000}s`,
    );
  }

  private async fire(id: string, uuid: string): Promise<void> {
    const streak = this.streaks.get(id);
    if (!streak || streak.uuid !== uuid || !streak.cancel) return; // superseded / forgotten
    streak.cancel = null;
    try {
      const s = this.deps.getSession(id);
      if (!s || s.status === "archived") return this.forget(id);
      if (s.status !== "idle" && s.status !== "done") return; // re-engaged; a fresh edge follows
      const err = transientApiError((await this.deps.readTranscript(s)) ?? "");
      if (err?.uuid === uuid && (await this.deps.steer(id, API_RETRY_STEER))) {
        this.log(`[api-retry] steered ${s.desig} attempt=${streak.attempts}`);
        return;
      }
      await this.deps.handBack(id);
    } catch (e) {
      this.log(`[api-retry] fire ${id} failed: ${String(e)}`);
      await this.deps.handBack(id).catch(() => {});
    }
  }

  private log(msg: string): void {
    (this.deps.log ?? console.log)(msg);
  }
}

function eligible(s: Session): boolean {
  return (
    s.status !== "archived" &&
    !s.terminal &&
    (s.agentProvider ?? "claude") === "claude" &&
    Boolean(s.claudeSessionId)
  );
}
