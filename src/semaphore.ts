/**
 * Minimal FIFO semaphore — bounds how many gated thunks run concurrently.
 * Strict: a releaser hands its slot directly to the next waiter (the active
 * count is unchanged across the handoff) instead of decrementing and letting
 * the woken waiter re-increment. That closes the window where a fresh arrival
 * could slip in between a decrement and a wake-up and push `active` to max+1.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve)); // woken = slot already ours
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next)
        next(); // hand the slot off — keep `active`
      else this.active--; // no waiter — free the slot
    }
  }
}
