import { describe, it, expect, vi, afterEach } from "vitest";
import { connectPty } from "./pty";
afterEach(() => vi.unstubAllGlobals());

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
  /** server closed us because the agent is gone (session terminated) */
  gone(code = 4001) {
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

function make(onReconnect = () => {}, onParked = () => {}, onEnded = () => {}) {
  FakeWs.instances = [];
  const onData = vi.fn();
  const conn = connectPty(
    "abc",
    100,
    30,
    onData,
    onReconnect,
    onParked,
    onEnded,
    (path) => new FakeWs(path) as unknown as WebSocket,
  );
  return { conn, onData, last: () => FakeWs.instances[FakeWs.instances.length - 1]! };
}

describe("connectPty", () => {
  it("attaches with the fitted size on the query string", () => {
    const { last } = make();
    expect(last().url).toMatch(/^\/pty\/abc\?cols=100&rows=30&clientKind=\w+&clientPlatform=\w+$/);
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
    expect(last().url).toMatch(/^\/pty\/abc\?cols=120&rows=40&clientKind=\w+&clientPlatform=\w+$/);

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

  describe("pause (hidden window, #3035)", () => {
    it("closes the socket and never reconnects on its own", () => {
      vi.useFakeTimers();
      const { conn, last } = make();
      last().open();
      const paused = last();
      conn.pause();
      expect(paused.readyState).toBe(FakeWs.CLOSED);
      paused.onclose?.(); // a late close event must not read as a drop
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.instances).toHaveLength(1);
      vi.useRealTimers();
    });

    it("cancels a pending retry", () => {
      vi.useFakeTimers();
      const { conn, last } = make();
      last().open();
      last().drop(); // retry scheduled
      conn.pause();
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.instances).toHaveLength(1);
      vi.useRealTimers();
    });

    it("poke resumes with resume=1 and repaints like a reconnect", () => {
      const onReconnect = vi.fn();
      const { conn, last } = make(onReconnect);
      last().open();
      conn.pause();
      conn.poke();
      expect(FakeWs.instances).toHaveLength(2);
      expect(last().url).toMatch(/&resume=1$/);
      last().open();
      expect(onReconnect).toHaveBeenCalledTimes(1);
      // the resumed stream is an ordinary one again: a later drop reconnects without resume
      vi.useFakeTimers();
      last().drop();
      vi.advanceTimersByTime(1000);
      expect(FakeWs.instances).toHaveLength(3);
      expect(last().url).not.toContain("resume");
      vi.useRealTimers();
    });

    it("parks when another device owns the terminal by the time it resumes", () => {
      vi.useFakeTimers();
      const onParked = vi.fn();
      const { conn, last } = make(() => {}, onParked);
      last().open();
      conn.pause();
      conn.poke();
      last().supersede(); // server refused the resume: someone else owns it now
      expect(onParked).toHaveBeenCalledTimes(1);
      conn.poke();
      vi.advanceTimersByTime(5000);
      expect(FakeWs.instances).toHaveLength(2); // parked: no retry, no steal-back
      vi.useRealTimers();
    });

    it("keeps asking with resume=1 while the resume never opens (waking offline)", () => {
      vi.useFakeTimers();
      const onParked = vi.fn();
      const { conn, last } = make(() => {}, onParked);
      last().open();
      conn.pause();
      conn.poke(); // the window is back, but the network is still waking up
      last().drop(); // never opened
      vi.advanceTimersByTime(1000);
      expect(FakeWs.instances).toHaveLength(3);
      expect(last().url).toMatch(/&resume=1$/); // a backoff retry must not take over
      last().drop();
      conn.poke(); // refocus skips the backoff, still politely
      expect(last().url).toMatch(/&resume=1$/);
      last().open(); // reached the server…
      last().supersede(); // …which says the phone owns it now
      expect(onParked).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("drops the resume once an attach has opened", () => {
      vi.useFakeTimers();
      const { conn, last } = make();
      last().open();
      conn.pause();
      conn.poke();
      last().open(); // resumed: this client owns the terminal again
      last().drop(); // an ordinary drop later
      vi.advanceTimersByTime(1000);
      expect(last().url).not.toContain("resume");
      vi.useRealTimers();
    });

    it("is a no-op once parked or closed", () => {
      const { conn, last } = make();
      last().open();
      last().supersede();
      conn.pause();
      conn.poke();
      expect(FakeWs.instances).toHaveLength(1);
      const other = make();
      other.conn.close();
      other.conn.pause();
      other.conn.poke();
      expect(FakeWs.instances).toHaveLength(1);
    });

    it("takeover after a pause attaches without resume", () => {
      const { conn, last } = make();
      last().open();
      conn.pause();
      conn.takeover();
      expect(FakeWs.instances).toHaveLength(2);
      expect(last().url).not.toContain("resume");
    });
  });

  it("view() sends a view frame once per change and re-sends it on every open (#3161)", () => {
    const { conn, last } = make();
    const views = () =>
      last().sent.filter((d) => typeof d === "string" && d.startsWith("\x00view:"));
    conn.view('{"v":1}'); // not open yet: kept for the open
    expect(views()).toEqual([]);
    last().open();
    expect(views()).toEqual(['\x00view:{"v":1}\n']);
    conn.view('{"v":1}'); // unchanged → nothing new
    conn.view('{"v":1,"x":2}');
    expect(views()).toEqual(['\x00view:{"v":1}\n', '\x00view:{"v":1,"x":2}\n']);
    last().supersede();
    conn.takeover(); // a new owner socket reports the latest view again
    last().open();
    expect(views()).toEqual(['\x00view:{"v":1,"x":2}\n']);
  });

  it("takeover re-attaches after being parked", () => {
    const { conn, last } = make();
    last().open();
    last().supersede();
    conn.takeover();
    expect(FakeWs.instances).toHaveLength(2); // new attach → becomes owner again
    expect(last().url).toMatch(/^\/pty\/abc\?cols=100&rows=30&clientKind=\w+&clientPlatform=\w+$/);
  });

  it("ends on a gone close and does NOT reconnect", () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { conn, last } = make(
      () => {},
      () => {},
      onEnded,
    );
    last().open();

    last().gone(); // server says the agent is gone (close code 4001)
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("gone");

    vi.advanceTimersByTime(5000);
    expect(FakeWs.instances).toHaveLength(1); // never reconnected — no attach loop

    conn.poke(); // a refocus must not resurrect an ended session
    expect(FakeWs.instances).toHaveLength(1);
    vi.useRealTimers();
  });

  it("stops for good when the session's machine is unreachable (close 4002)", () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { conn, last } = make(
      () => {},
      () => {},
      onEnded,
    );
    last().open();

    last().gone(4002); // the coordinator can't reach the machine running the session
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("machine");

    vi.advanceTimersByTime(5000);
    expect(FakeWs.instances).toHaveLength(1); // no retry loop against a machine that is gone
    conn.poke();
    expect(FakeWs.instances).toHaveLength(1);
    vi.useRealTimers();
  });

  it("ends after repeated instant attach failures (herdr server gone)", () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { last } = make(
      () => {},
      () => {},
      onEnded,
    );
    // herdr's server was stopped (e.g. by a failed update): every attach opens
    // then dies at once. Without a cap this loops on `Os NotFound` forever.
    for (let i = 0; i < 12; i++) {
      last().open();
      last().drop(); // closes immediately — never lived past the fast-fail window
      vi.advanceTimersByTime(1000); // let the scheduled retry fire
    }
    expect(onEnded).toHaveBeenCalledTimes(1); // surfaced the affordance, once
    expect(onEnded).toHaveBeenCalledWith("unreachable"); // herdr down, not agent gone
    vi.useRealTimers();
  });

  it("keeps reconnecting when a real session drops after running a while", () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { last } = make(
      () => {},
      () => {},
      onEnded,
    );
    // a healthy session that lives past the window then drops is transient, not a
    // dead herdr — it must keep reconnecting and never surface "ended".
    for (let i = 0; i < 12; i++) {
      last().open();
      vi.advanceTimersByTime(5000); // session lives past FAST_FAIL_MS
      last().drop();
      vi.advanceTimersByTime(1000); // reconnect
    }
    expect(onEnded).not.toHaveBeenCalled();
    expect(FakeWs.instances.length).toBeGreaterThan(5);
    vi.useRealTimers();
  });

  it("keeps retrying when the socket never opens (network down, not herdr)", () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { last } = make(
      () => {},
      () => {},
      onEnded,
    );
    // PWA resume / wake: the network or Tailscale isn't back yet, so every connect
    // fails before opening. That's Shepherd being unreachable, never "herdr down".
    for (let i = 0; i < 20; i++) {
      last().drop();
      vi.advanceTimersByTime(8000); // past the backoff cap
    }
    expect(onEnded).not.toHaveBeenCalled();
    expect(FakeWs.instances).toHaveLength(21);
    vi.useRealTimers();
  });

  it("backs off never-opened retries up to 8s and resets after an open", () => {
    vi.useFakeTimers();
    const { last } = make();
    const waitFor = (ms: number) => {
      const n = FakeWs.instances.length;
      last().drop();
      vi.advanceTimersByTime(ms - 1);
      expect(FakeWs.instances).toHaveLength(n); // not yet
      vi.advanceTimersByTime(1);
      expect(FakeWs.instances).toHaveLength(n + 1);
    };
    for (const ms of [1000, 2000, 4000, 8000, 8000]) waitFor(ms);
    last().open(); // reachable again → backoff resets
    vi.advanceTimersByTime(5000);
    waitFor(1000); // an opened drop retries after 1s
    waitFor(1000); // and the next never-opened failure starts over at 1s
    vi.useRealTimers();
  });

  it("poke skips a pending backoff wait", () => {
    vi.useFakeTimers();
    const { conn, last } = make();
    for (let i = 0; i < 4; i++) {
      last().drop();
      vi.advanceTimersByTime(8000);
    }
    last().drop(); // now waiting 8s
    const n = FakeWs.instances.length;
    conn.poke(); // tab came back → reconnect at once
    expect(FakeWs.instances).toHaveLength(n + 1);
    vi.useRealTimers();
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

it("reports PWA metadata again when taking over", () => {
  vi.stubGlobal("navigator", { platform: "iPhone", userAgent: "iPhone", standalone: true });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  const { conn, last } = make();
  expect(last().url).toContain("clientKind=pwa&clientPlatform=ios");
  last().open();
  last().supersede();
  conn.takeover();
  expect(last().url).toContain("clientKind=pwa&clientPlatform=ios");
  conn.close();
});
