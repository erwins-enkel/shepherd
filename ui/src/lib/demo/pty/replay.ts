// The demo terminal replay engine. Given an authored transcript — an array of
// timed byte-string frames — it emits each frame's bytes after its `delayMs`,
// accumulating delays so the stream paints at a human-ish pace (the author varies
// the delays into the data; the engine never invents timing, so it stays fully
// deterministic under fake timers). `playTranscript` returns a `cancel()` that
// stops the replay mid-flight (called when the pty socket closes) so no timer
// fires after teardown.

/** One transcript step: wait `delayMs`, then emit `bytes`. Delay is BEFORE the bytes. */
export type PtyFrame = { delayMs: number; bytes: string };

/**
 * Schedule `frames` onto `emit`, one chained `setTimeout` per frame so delays
 * accumulate from the previous emit. Fires `onDone` after the last frame. Returns
 * a `cancel()` that clears the pending timer and suppresses any remaining frames
 * (and `onDone`).
 */
export function playTranscript(
  frames: PtyFrame[],
  emit: (bytes: string) => void,
  onDone?: () => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let i = 0;

  const step = (): void => {
    if (cancelled) return;
    if (i >= frames.length) {
      timer = null;
      onDone?.();
      return;
    }
    const frame = frames[i++];
    timer = setTimeout(() => {
      if (cancelled) return;
      emit(frame.bytes);
      step();
    }, frame.delayMs);
  };

  step();

  return () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
