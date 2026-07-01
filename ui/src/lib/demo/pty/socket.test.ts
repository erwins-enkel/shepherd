import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PtySocket } from "./socket";
import { ptyStream } from "./stream";

// queueMicrotask is NOT faked by vitest fake timers, so `await Promise.resolve()`
// flushes the socket's deferred open; `vi.advanceTimersByTime` then drives replay.
const flushOpen = () => Promise.resolve();

describe("PtySocket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("parses id/cols/rows from the url", () => {
    const ws = new PtySocket("ws://localhost/pty/coupon?cols=120&rows=40");
    expect(ws.sessionId).toBe("coupon");
    expect(ws.cols).toBe(120);
    expect(ws.rows).toBe(40);
  });

  it("replays the coupon transcript after open", async () => {
    const ws = new PtySocket("ws://localhost/pty/coupon?cols=80&rows=24");
    const msgs: string[] = [];
    ws.onmessage = (e) => msgs.push(e.data as string);

    await flushOpen(); // onOpened → playTranscript schedules the first frame
    expect(msgs).toEqual([]); // nothing before the first delay elapses

    vi.advanceTimersByTime(120_000); // drive the whole transcript
    expect(msgs.length).toBeGreaterThan(10);
    expect(msgs[0]).toContain("Add coupon-code field to checkout");
    expect(msgs.join("")).toContain("4 pass");
    ws.close();
  });

  it("forwards a live ptyStream.push to onmessage after open", async () => {
    const ws = new PtySocket("ws://localhost/pty/coupon?cols=80&rows=24");
    const msgs: string[] = [];
    ws.onmessage = (e) => msgs.push(e.data as string);
    await flushOpen();

    ptyStream.push("coupon", "LIVE-BYTES");
    expect(msgs).toContain("LIVE-BYTES");

    ptyStream.push("neon", "OTHER"); // different id — must not reach this socket
    expect(msgs).not.toContain("OTHER");
    ws.close();
  });

  it("cancels pending frames and unsubscribes on close", async () => {
    const ws = new PtySocket("ws://localhost/pty/coupon?cols=80&rows=24");
    const msgs: string[] = [];
    ws.onmessage = (e) => msgs.push(e.data as string);
    await flushOpen();

    vi.advanceTimersByTime(500); // a few frames land
    const beforeClose = msgs.length;
    ws.close();

    vi.advanceTimersByTime(120_000); // remaining replay frames must NOT fire
    expect(msgs.length).toBe(beforeClose);

    ptyStream.push("coupon", "AFTER-CLOSE"); // unsubscribed — must not emit
    expect(msgs).not.toContain("AFTER-CLOSE");
  });
});
