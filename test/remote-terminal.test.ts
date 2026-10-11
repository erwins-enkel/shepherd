import { describe, expect, test } from "bun:test";
import {
  type OpenTerminalSocket,
  PTY_MACHINE_UNREACHABLE_CODE,
  RemoteTerminalBridge,
} from "../src/remote-instances/terminal";

// The bridge between a caller's `/pty/:id` socket on the coordinator and the same route on the
// session's machine (#2764), against a fake machine socket.

const TOKEN = "shp_remote-token-for-b-0123456789";
const TARGET = { url: "https://b.test:7777", token: TOKEN };
const ATTACH = { cols: 120, rows: 40, clientKind: "browser", clientPlatform: "linux" };

interface Upstream {
  url: string;
  headers: Record<string, string>;
  on: Parameters<OpenTerminalSocket>[2];
  sent: (string | Uint8Array)[];
  closed: boolean;
}

function setup(opts: { target?: typeof TARGET | null; connectTimeoutMs?: number } = {}) {
  const upstreams: Upstream[] = [];
  const received: (string | Uint8Array)[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  let done = 0;
  const openSocket: OpenTerminalSocket = (url, headers, on) => {
    const up: Upstream = { url, headers, on, sent: [], closed: false };
    upstreams.push(up);
    return {
      send: (data) => up.sent.push(data),
      close: () => {
        up.closed = true;
      },
    };
  };
  const bridge = new RemoteTerminalBridge(
    opts.target === undefined ? TARGET : opts.target,
    "s1",
    {
      send: (data) => received.push(data),
      close: (code, reason) => closes.push({ code, reason }),
    },
    ATTACH,
    { openSocket, connectTimeoutMs: opts.connectTimeoutMs ?? 1_000, onDone: () => done++ },
  );
  return { bridge, upstreams, received, closes, done: () => done };
}

describe("RemoteTerminalBridge", () => {
  test("attaches at the machine's /pty/:id with the caller's size and client, token in the header only", () => {
    const { bridge, upstreams } = setup();
    bridge.open();
    expect(upstreams).toHaveLength(1);
    const url = new URL(upstreams[0]!.url);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("b.test:7777");
    expect(url.pathname).toBe("/pty/s1");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cols: "120",
      rows: "40",
      clientKind: "browser",
      clientPlatform: "linux",
    });
    expect(upstreams[0]!.url).not.toContain(TOKEN);
    expect(upstreams[0]!.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    bridge.close();
  });

  test("holds frames until the machine's socket opens, then sends them in order, verbatim", () => {
    const { bridge, upstreams } = setup();
    bridge.open();
    const binary = new Uint8Array([1, 2, 3]);
    bridge.write("a");
    bridge.write("\x00resize:80:24\n");
    bridge.write(binary);
    expect(upstreams[0]!.sent).toEqual([]);
    upstreams[0]!.on.open();
    expect(upstreams[0]!.sent).toEqual(["a", "\x00resize:80:24\n", binary]);
    bridge.write("b");
    expect(upstreams[0]!.sent.at(-1)).toBe("b");
    bridge.close();
  });

  test("relays the machine's output to the caller", () => {
    const { bridge, upstreams, received } = setup();
    bridge.open();
    upstreams[0]!.on.open();
    const bytes = new Uint8Array([104, 105]);
    upstreams[0]!.on.message(bytes);
    upstreams[0]!.on.message("text");
    expect(received).toEqual([bytes, "text"]);
    bridge.close();
  });

  test("no target: the caller's socket closes as unreachable and nothing is opened", () => {
    const { bridge, upstreams, closes, done } = setup({ target: null });
    bridge.open();
    expect(upstreams).toHaveLength(0);
    expect(closes).toEqual([{ code: PTY_MACHINE_UNREACHABLE_CODE, reason: "machine unreachable" }]);
    expect(done()).toBe(1);
  });

  test.each([
    [
      "never opened (refused upgrade, network error)",
      false,
      1002,
      "",
      PTY_MACHINE_UNREACHABLE_CODE,
    ],
    ["the machine revoked this server's token", true, 1008, "authorization changed", 4002],
    ["superseded on the machine", true, 4000, "superseded", 4000],
    ["the session ended on the machine", true, 4001, "ended", 4001],
    ["a plain drop after open", true, 1006, "", undefined],
    ["a normal close after open", true, 1000, "", undefined],
  ])("machine socket closed: %s", (_, opened, code, reason, expected) => {
    const { bridge, upstreams, closes, done } = setup();
    bridge.open();
    if (opened) upstreams[0]!.on.open();
    upstreams[0]!.on.close(code, reason);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(expected);
    if (expected === code) expect(closes[0]!.reason).toBe(reason);
    if (expected === PTY_MACHINE_UNREACHABLE_CODE)
      expect(closes[0]!.reason).toBe("machine unreachable");
    expect(done()).toBe(1);
    // Nothing after the end: no frames out, no second close.
    bridge.write("late");
    upstreams[0]!.on.message("late");
    upstreams[0]!.on.close(1000, "");
    expect(upstreams[0]!.sent).not.toContain("late");
    expect(closes).toHaveLength(1);
    expect(done()).toBe(1);
  });

  test("a machine that never opens times out as unreachable and its socket is closed", async () => {
    const { bridge, upstreams, closes, done } = setup({ connectTimeoutMs: 5 });
    bridge.open();
    bridge.write("lost");
    await Bun.sleep(20);
    expect(closes).toEqual([{ code: PTY_MACHINE_UNREACHABLE_CODE, reason: "machine unreachable" }]);
    expect(upstreams[0]!.closed).toBe(true);
    expect(done()).toBe(1);
    // A late open of the abandoned socket sends nothing.
    upstreams[0]!.on.open();
    expect(upstreams[0]!.sent).toEqual([]);
  });

  test("the caller leaving closes the machine's socket and never touches the caller", async () => {
    const { bridge, upstreams, closes, done } = setup({ connectTimeoutMs: 5 });
    bridge.open();
    upstreams[0]!.on.open();
    bridge.close();
    expect(upstreams[0]!.closed).toBe(true);
    upstreams[0]!.on.close(1000, "");
    await Bun.sleep(20);
    expect(closes).toEqual([]);
    expect(done()).toBe(1);
  });

  test("abort (machine disconnected or removed) ends the caller's terminal as unreachable", () => {
    const { bridge, upstreams, closes, done } = setup();
    bridge.open();
    upstreams[0]!.on.open();
    bridge.abort();
    expect(upstreams[0]!.closed).toBe(true);
    expect(closes).toEqual([{ code: PTY_MACHINE_UNREACHABLE_CODE, reason: "machine unreachable" }]);
    bridge.abort();
    bridge.close();
    expect(closes).toHaveLength(1);
    expect(done()).toBe(1);
  });
});
