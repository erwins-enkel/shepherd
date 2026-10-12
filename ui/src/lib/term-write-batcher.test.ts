import { describe, it, expect, vi, afterEach } from "vitest";
import { createWriteBatcher } from "./term-write-batcher";

afterEach(() => vi.useRealTimers());

describe("createWriteBatcher", () => {
  it("writes straight through while live", () => {
    const write = vi.fn();
    const b = createWriteBatcher(write);
    b.push("a");
    b.push("b");
    expect(write.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("coalesces into at most one write per interval while not live, in order", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const b = createWriteBatcher(write, { intervalMs: 1000 });
    b.setLive(false);
    for (const chunk of ["\x1b[2K", "⠋ Working", "\r", "⠙ Working"]) b.push(chunk);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write.mock.calls).toEqual([["\x1b[2K⠋ Working\r⠙ Working"]]);
    b.push("next");
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(write.mock.calls.at(-1)).toEqual(["next"]);
  });

  it("writes pending output at once when it goes live", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const b = createWriteBatcher(write);
    b.setLive(false);
    b.push("held");
    b.setLive(true);
    expect(write.mock.calls).toEqual([["held"]]);
    vi.advanceTimersByTime(5000);
    expect(write).toHaveBeenCalledTimes(1); // the cleared timer never fires a stray write
    b.push("live");
    expect(write.mock.calls.at(-1)).toEqual(["live"]);
  });

  it("drops its timer and pending output on dispose", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const b = createWriteBatcher(write);
    b.setLive(false);
    b.push("gone");
    b.dispose();
    vi.advanceTimersByTime(5000);
    expect(write).not.toHaveBeenCalled();
  });
});
