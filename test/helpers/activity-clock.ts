/** Deterministic scheduler for publisher tests; no wall-clock sleeps. */
export function activityClock() {
  let time = 0;
  const timers = new Map<() => void, number>();
  return {
    now: () => time,
    schedule(run: () => void, delayMs: number) {
      timers.set(run, time + delayMs);
      return () => {
        timers.delete(run);
      };
    },
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0];
        if (!next || next[1] > end) break;
        time = next[1];
        timers.delete(next[0]);
        next[0]();
      }
      time = end;
    },
    size: () => timers.size,
  };
}
