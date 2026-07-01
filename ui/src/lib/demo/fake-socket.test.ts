import { describe, it, expect } from "vitest";
import { FakeWebSocket } from "./fake-socket";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("FakeWebSocket", () => {
  it("exposes static readyState constants = 0/1/2/3", () => {
    expect(FakeWebSocket.CONNECTING).toBe(0);
    expect(FakeWebSocket.OPEN).toBe(1);
    expect(FakeWebSocket.CLOSING).toBe(2);
    expect(FakeWebSocket.CLOSED).toBe(3);
  });

  it("exposes instance readyState constants = 0/1/2/3", () => {
    const ws = new FakeWebSocket("ws://x/events");
    expect(ws.CONNECTING).toBe(0);
    expect(ws.OPEN).toBe(1);
    expect(ws.CLOSING).toBe(2);
    expect(ws.CLOSED).toBe(3);
    ws.close();
  });

  it("has a writable binaryType (default blob, no-op store)", () => {
    const ws = new FakeWebSocket("ws://x/events");
    expect(ws.binaryType).toBe("blob");
    ws.binaryType = "arraybuffer";
    expect(ws.binaryType).toBe("arraybuffer");
    ws.close();
  });

  it("fires onopen ASYNCHRONOUSLY, never before the constructor returns", async () => {
    let opened = false;
    const ws = new FakeWebSocket("ws://x/events");
    ws.onopen = () => {
      opened = true;
    };
    // still CONNECTING synchronously — open must be deferred to a later tick
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(opened).toBe(false);
    await tick();
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(opened).toBe(true);
    ws.close();
  });

  it("close() transitions readyState to CLOSED and fires onclose", async () => {
    const ws = new FakeWebSocket("ws://x/events");
    await tick();
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };
    ws.close();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(closed).toBe(true);
  });

  it("send() is a no-op that does not throw before or after open", async () => {
    const ws = new FakeWebSocket("ws://x/events");
    expect(() => ws.send("hi")).not.toThrow();
    await tick();
    expect(() => ws.send("hi")).not.toThrow();
    ws.close();
  });
});
