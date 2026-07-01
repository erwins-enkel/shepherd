import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { playTranscript, type PtyFrame } from "./replay";

describe("playTranscript", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits frames in order with accumulated delays", () => {
    const frames: PtyFrame[] = [
      { delayMs: 100, bytes: "a" },
      { delayMs: 50, bytes: "b" },
      { delayMs: 200, bytes: "c" },
    ];
    const got: string[] = [];
    playTranscript(frames, (b) => got.push(b));

    expect(got).toEqual([]); // delay is BEFORE the first frame
    vi.advanceTimersByTime(100);
    expect(got).toEqual(["a"]);
    vi.advanceTimersByTime(50);
    expect(got).toEqual(["a", "b"]); // accumulates from the previous emit
    vi.advanceTimersByTime(199);
    expect(got).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("cancel() prevents later frames from emitting", () => {
    const frames: PtyFrame[] = [
      { delayMs: 10, bytes: "a" },
      { delayMs: 10, bytes: "b" },
      { delayMs: 10, bytes: "c" },
    ];
    const got: string[] = [];
    const cancel = playTranscript(frames, (b) => got.push(b));

    vi.advanceTimersByTime(10);
    expect(got).toEqual(["a"]);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(got).toEqual(["a"]); // b + c never fire
  });

  it("fires onDone after the last frame", () => {
    const frames: PtyFrame[] = [
      { delayMs: 10, bytes: "a" },
      { delayMs: 10, bytes: "b" },
    ];
    const got: string[] = [];
    const onDone = vi.fn();
    playTranscript(frames, (b) => got.push(b), onDone);

    vi.advanceTimersByTime(10);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(got).toEqual(["a", "b"]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("cancel() suppresses onDone", () => {
    const onDone = vi.fn();
    const cancel = playTranscript([{ delayMs: 10, bytes: "a" }], () => {}, onDone);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("handles an empty transcript by firing onDone with no emits", () => {
    const emit = vi.fn();
    const onDone = vi.fn();
    playTranscript([], emit, onDone);
    vi.advanceTimersByTime(1);
    expect(emit).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
