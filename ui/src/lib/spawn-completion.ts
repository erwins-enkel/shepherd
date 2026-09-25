import type { SpawnProgress } from "./types";

/** Matches the dialog's own 250ms counter tick — a completion is noticed within one beat. */
const POLL_MS = 250;

/**
 * Settle a create on whichever arrives first: its HTTP answer, or the final `spawn:progress` frame
 * naming the created session. The server emits that frame right after `session:new` on the same
 * WS stream, so on a slow link (a phone over a relayed tailnet) the dialog completes when the
 * session exists rather than when the 201 finally lands, tens of seconds later.
 *
 * `read` returns the latest frame (e.g. `() => store.spawnProgress`). Once the frame wins, a late
 * HTTP rejection is swallowed — the session exists, so it is not a failure worth surfacing.
 */
export function raceSpawnCompletion<T>(
  request: Promise<T>,
  spawnId: string,
  read: () => SpawnProgress | null,
): Promise<T | { id: string }> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn();
    };
    const check = () => {
      const p = read();
      if (p?.spawnId === spawnId && p.sessionId) {
        const id = p.sessionId;
        settle(() => resolve({ id }));
      }
    };
    request.then(
      (r) => settle(() => resolve(r)),
      (e) => settle(() => reject(e)),
    );
    check();
    if (!settled) timer = setInterval(check, POLL_MS);
  });
}
