import { describe, it, expect, vi } from "vitest";
import { connectPty } from "./pty";

// Minimal fake matching the bits connectPty touches. Tracks every instance so a
// test can assert how many sockets were opened (i.e. how many reconnects).
class FakeWs {
  static instances: FakeWs[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType = "";
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((e?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  open() {
    this.readyState = this.OPEN;
    this.onopen?.();
  }
  drop() {
    this.readyState = this.CLOSED;
    this.onclose?.();
  }
  /** server bumped us with the superseded close code (another device took over) */
  supersede(code = 4000) {
    this.readyState = this.CLOSED;
    this.onclose?.({ code });
  }
  send(d: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(d);
  }
  close() {
    this.readyState = this.CLOSED;
  }
}

function make(onReconnect = () => {}, onParked = () => {}) {
  FakeWs.instances = [];
  const onData = vi.fn();
  const conn = connectPty(
    "abc",
    100,
    30,
    onData,
    onReconnect,
    onParked,
    (path) => new FakeWs(path) as unknown as WebSocket,
  );
  return { conn, onData, last: () => FakeWs.instances[FakeWs.instances.length - 1] };
}

describe("connectPty", () => {
  it("attaches with the fitted size on the query string", () => {
    const { last } = make();
    expect(last().url).toBe("/pty/abc?cols=100&rows=30");
  });

  it("reconnects after the socket drops, using the latest fitted size", () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const { conn, last } = make(onReconnect);
    last().open();
    conn.resize(120, 40); // resize while connected → new dims for next attach

    last().drop();
    expect(FakeWs.instances).toHaveLength(1); // retry is scheduled, not immediate
    vi.advanceTimersByTime(1000);

    expect(FakeWs.instances).toHaveLength(2);
    expect(last().url).toBe("/pty/abc?cols=120&rows=40");

    last().open(); // onReconnect fires only on a reconnect, never the first open
    expect(onReconnect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("poke reconnects immediately when the socket is gone", () => {
    const { conn, last } = make();
    last().open();
    last().close(); // simulate an OS-dropped socket with no onclose yet (frozen tab)

    conn.poke();
    expect(FakeWs.instances).toHaveLength(2);
    expect(last().readyState).toBe(FakeWs.CONNECTING);
  });

  it("poke leaves a live socket untouched", () => {
    const { conn, last } = make();
    last().open();
    conn.poke();
    expect(FakeWs.instances).toHaveLength(1);
  });

  it("parks on a superseded close and does NOT reconnect", () => {
    vi.useFakeTimers();
    const onParked = vi.fn();
    const { last } = make(() => {}, onParked);
    last().open();

    last().supersede(); // another device took over (close code 4000)
    expect(onParked).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(FakeWs.instances).toHaveLength(1); // never reconnected — no takeover war
    vi.useRealTimers();
  });

  it("poke does not steal back a parked terminal", () => {
    const { conn, last } = make();
    last().open();
    last().supersede();
    conn.poke();
    expect(FakeWs.instances).toHaveLength(1); // still parked, no new socket
  });

  it("takeover re-attaches after being parked", () => {
    const { conn, last } = make();
    last().open();
    last().supersede();
    conn.takeover();
    expect(FakeWs.instances).toHaveLength(2); // new attach → becomes owner again
    expect(last().url).toBe("/pty/abc?cols=100&rows=30");
  });

  it("close stops reconnection", () => {
    vi.useFakeTimers();
    const { conn, last } = make();
    last().open();
    conn.close();
    last().drop();
    vi.advanceTimersByTime(5000);
    expect(FakeWs.instances).toHaveLength(1);
    vi.useRealTimers();
  });
});
