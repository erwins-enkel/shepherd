import type { WsEvent } from "$lib/types";

// Typed, synchronous pub/sub carrying `WsEvent` frames. The demo world (Task 3+)
// emits here; the EventsSocket subscribes and forwards each frame to the live UI.
export type BusListener = (ev: WsEvent) => void;

const listeners = new Set<BusListener>();

export const bus = {
  /** Fan a frame out to every current listener, synchronously. */
  emit(ev: WsEvent): void {
    // snapshot so a listener that (un)subscribes during dispatch can't mutate the set mid-loop
    for (const fn of [...listeners]) fn(ev);
  },
  /** Register a listener; returns an unsubscribe disposer. */
  subscribe(fn: BusListener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
