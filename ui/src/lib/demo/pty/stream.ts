// Per-session PTY byte pub/sub. Kept separate from `bus.ts` (which carries typed
// `WsEvent` frames): terminal bytes are raw xterm strings, not domain events, and
// are keyed by session id so a live byte push only reaches the terminal attached to
// that session. The Task 6 director calls `push(id, bytes)` to stream ambient live
// output to whichever `PtySocket` is currently subscribed for that id.

type ByteListener = (bytes: string) => void;

const listeners = new Map<string, Set<ByteListener>>();

export const ptyStream = {
  /** Fan `bytes` out to every current subscriber of `sessionId`, synchronously. */
  push(sessionId: string, bytes: string): void {
    const set = listeners.get(sessionId);
    if (!set) return;
    // snapshot so a listener that (un)subscribes during dispatch can't mutate mid-loop
    for (const fn of [...set]) fn(bytes);
  },
  /** Subscribe to `sessionId`'s live bytes; returns an unsubscribe disposer. */
  subscribe(sessionId: string, fn: ByteListener): () => void {
    let set = listeners.get(sessionId);
    if (!set) {
      set = new Set();
      listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      const s = listeners.get(sessionId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) listeners.delete(sessionId);
    };
  },
};
