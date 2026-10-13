/**
 * Terminal output pacing for an unattended window (#3035). While the operator works elsewhere and
 * Shepherd only sits beside it as a HUD, a working agent's spinner still repaints the terminal
 * ~10×/s — most of the renderer's idle cost. Not live, output is collected and written at most
 * once per `intervalMs`, in arrival order; going live writes whatever is pending at once. No
 * output is ever dropped, only delayed.
 */
export interface WriteBatcher {
  push(data: string): void;
  setLive(live: boolean): void;
  dispose(): void;
}

export function createWriteBatcher(
  write: (data: string) => void,
  { intervalMs = 1000 }: { intervalMs?: number } = {},
): WriteBatcher {
  let live = true;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const data = pending;
    pending = "";
    write(data);
  };

  return {
    push(data) {
      if (live) {
        write(data);
        return;
      }
      pending += data;
      timer ??= setTimeout(flush, intervalMs);
    },
    setLive(next) {
      live = next;
      if (live) flush();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = "";
    },
  };
}
