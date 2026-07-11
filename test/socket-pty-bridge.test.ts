import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";
import { SocketPtyBridge } from "../src/socket-pty-bridge";
import type { PtySocket } from "../src/pty-bridge";

const roundtripPath = new URL(
  "./fixtures/terminal-control/control-roundtrip.ndjson",
  import.meta.url,
).pathname;
const badTargetPath = new URL("./fixtures/terminal-control/bad-target.ndjson", import.meta.url)
  .pathname;

const roundtripLines = readFileSync(roundtripPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");
const badTargetLines = readFileSync(badTargetPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "");

const frameLines = roundtripLines.filter((l) => JSON.parse(l).type === "terminal.frame");
const detachedClosedLine = roundtripLines.find((l) => JSON.parse(l).type === "terminal.closed")!;
const notFoundClosedLine = badTargetLines[0]!;

/** A fake Bun.Subprocess<"pipe","pipe","pipe"> whose stdout/stdin/kill/exited are fully
 *  test-driven, matching the shape socket-pty-bridge.ts reads. */
function makeFakeProc() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let stdoutClosed = false;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  // A real subprocess's stdout reaches EOF when it exits, so kill()/resolveExit() close it too
  // (idempotently). This lets the bridge's watchExit drain the pump before classifying.
  const closeStdout = (): void => {
    if (stdoutClosed) return;
    stdoutClosed = true;
    controller.close();
  };
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  const stdinWrites: string[] = [];
  let killed = false;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const encoder = new TextEncoder();
  const stdin = {
    write: (data: string | Uint8Array): number => {
      stdinWrites.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      return typeof data === "string" ? data.length : data.byteLength;
    },
    flush: (): number => 0,
  };
  const proc = {
    stdout,
    stderr,
    stdin,
    kill: (): void => {
      killed = true;
      resolveExited(0);
      closeStdout();
    },
    exited,
  };
  return {
    proc,
    stdinWrites,
    isKilled: () => killed,
    push(line: string): void {
      if (stdoutClosed) return;
      controller.enqueue(encoder.encode(line.endsWith("\n") ? line : `${line}\n`));
    },
    pushRaw(text: string): void {
      if (stdoutClosed) return;
      controller.enqueue(encoder.encode(text));
    },
    endStdout(): void {
      closeStdout();
    },
    resolveExit(code = 0): void {
      resolveExited(code);
      closeStdout();
    },
  };
}

/** Cast a fake proc factory into `typeof Bun.spawn`, capturing the argv/opts it was called with. */
function fakeSpawn(
  fake: ReturnType<typeof makeFakeProc>,
  onCall?: (cmd: string[], opts: unknown) => void,
): typeof Bun.spawn {
  return ((cmd: string[], opts: unknown) => {
    onCall?.(cmd, opts);
    return fake.proc;
  }) as unknown as typeof Bun.spawn;
}

function fakeWs(): PtySocket & { sends: (string | Uint8Array)[]; closed: boolean } {
  const sends: (string | Uint8Array)[] = [];
  return {
    sends,
    closed: false,
    send(data: string | Uint8Array): void {
      sends.push(data);
    },
    close(): void {
      this.closed = true;
    },
  };
}

/** A microtask+timer tick, so pending promise chains (exited handling, async pumps) settle. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

test("argv: spawn called with the pinned herdr terminal session control argv", () => {
  const fake = makeFakeProc();
  let capturedCmd: string[] | undefined;
  const spawn = fakeSpawn(fake, (cmd) => {
    capturedCmd = cmd;
  });
  const ws = fakeWs();
  const bridge = new SocketPtyBridge("w1:p1", ws, {}, { herdrBin: "herdr-bin", spawn });
  bridge.open(80, 24);
  expect(capturedCmd).toEqual([
    "herdr-bin",
    "terminal",
    "session",
    "control",
    "w1:p1",
    "--takeover",
    "--cols",
    "80",
    "--rows",
    "24",
  ]);
});

test("frame decode + order: ws.send receives decoded bytes in arrival order, chunk-split frame included", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  const bridge = new SocketPtyBridge("w1:p1", ws, {}, { spawn });
  bridge.open();

  // first three frames arrive whole
  fake.push(frameLines[0]!);
  fake.push(frameLines[1]!);
  fake.push(frameLines[2]!);
  // fourth frame split across two stdout chunks
  const last = frameLines[3]!;
  const mid = Math.floor(last.length / 2);
  fake.pushRaw(last.slice(0, mid));
  fake.pushRaw(`${last.slice(mid)}\n`);
  await tick();

  expect(ws.sends.length).toBe(4);
  for (let i = 0; i < 4; i++) {
    const expected = Buffer.from(JSON.parse(frameLines[i]!).bytes as string, "base64");
    expect(ws.sends[i]).toEqual(expected);
  }
});

test("onFirstFrame fires exactly once, on the first frame only", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let firstFrameCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    { onFirstFrame: () => firstFrameCalls++ },
    { spawn },
  );
  bridge.open();
  fake.push(frameLines[0]!);
  await tick();
  expect(firstFrameCalls).toBe(1);
  fake.push(frameLines[1]!);
  fake.push(frameLines[2]!);
  await tick();
  expect(firstFrameCalls).toBe(1);
});

test("write: input and resize route to distinct terminal.* stdin commands, interleaved in one write", () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  const bridge = new SocketPtyBridge("w1:p1", ws, {}, { spawn });
  bridge.open();

  bridge.write("ls\n");
  expect(fake.stdinWrites).toEqual([
    `${JSON.stringify({ type: "terminal.input", text: "ls\n" })}\n`,
  ]);

  fake.stdinWrites.length = 0;
  bridge.write("\x00resize:120:40\n");
  expect(fake.stdinWrites).toEqual([
    `${JSON.stringify({ type: "terminal.resize", cols: 120, rows: 40 })}\n`,
  ]);

  fake.stdinWrites.length = 0;
  bridge.write("abc\x00resize:50:20\ndef");
  expect(fake.stdinWrites).toEqual([
    `${JSON.stringify({ type: "terminal.input", text: "abc" })}\n`,
    `${JSON.stringify({ type: "terminal.resize", cols: 50, rows: 20 })}\n`,
    `${JSON.stringify({ type: "terminal.input", text: "def" })}\n`,
  ]);
});

test("close: writes terminal.release then kills; the resulting process-exit fires no hook", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let fallbackCalls = 0;
  let goneCalls = 0;
  let abnormalCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    {
      onFallback: () => fallbackCalls++,
      onGone: () => goneCalls++,
      onAbnormalExit: () => abnormalCalls++,
    },
    { spawn },
  );
  bridge.open();
  bridge.close();

  expect(fake.stdinWrites).toEqual([`${JSON.stringify({ type: "terminal.release" })}\n`]);
  expect(fake.isKilled()).toBe(true);

  await tick();
  expect(fallbackCalls).toBe(0);
  expect(goneCalls).toBe(0);
  expect(abnormalCalls).toBe(0);
  expect(ws.closed).toBe(true);
});

test("gone: a pre-first-frame terminal.closed{not found} fires onGone only", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let fallbackCalls = 0;
  let goneCalls = 0;
  let abnormalCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    {
      onFallback: () => fallbackCalls++,
      onGone: () => goneCalls++,
      onAbnormalExit: () => abnormalCalls++,
    },
    { spawn },
  );
  bridge.open();
  expect(JSON.parse(notFoundClosedLine).reason).toMatch(/not found/i);
  fake.push(notFoundClosedLine);
  await tick();
  fake.resolveExit(0);
  await tick();

  expect(goneCalls).toBe(1);
  expect(fallbackCalls).toBe(0);
  expect(abnormalCalls).toBe(0);
  expect(ws.closed).toBe(true);
});

test("pre-first-frame fallback: process exits with no frame and no close; ws handed off, not closed", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let fallbackCalls = 0;
  const bridge = new SocketPtyBridge("w1:p1", ws, { onFallback: () => fallbackCalls++ }, { spawn });
  bridge.open();
  fake.endStdout();
  await tick();
  fake.resolveExit(1);
  await tick();

  expect(fallbackCalls).toBe(1);
  // onFallback means the caller re-attaches this same ws via node-pty — the bridge must not
  // tear it down underneath the caller (issue #1529).
  expect(ws.closed).toBe(false);
});

test("pre-first-frame fallback: no onFallback hook — process exit with no frame still closes ws", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  const bridge = new SocketPtyBridge("w1:p1", ws, {}, { spawn });
  bridge.open();
  fake.endStdout();
  await tick();
  fake.resolveExit(1);
  await tick();

  // no hook means nobody takes over the ws — the bridge must still close it (no leak).
  expect(ws.closed).toBe(true);
});

test("pre-first-frame fallback: a synchronous spawn throw fires onFallback; ws handed off, not closed", () => {
  const ws = fakeWs();
  let fallbackCalls = 0;
  const spawn = (() => {
    throw new Error("spawn ENOENT");
  }) as unknown as typeof Bun.spawn;
  const bridge = new SocketPtyBridge("w1:p1", ws, { onFallback: () => fallbackCalls++ }, { spawn });
  bridge.open();

  expect(fallbackCalls).toBe(1);
  expect(ws.closed).toBe(false);
});

test("pre-first-frame fallback: no onFallback hook — synchronous spawn throw still closes ws", () => {
  const ws = fakeWs();
  const spawn = (() => {
    throw new Error("spawn ENOENT");
  }) as unknown as typeof Bun.spawn;
  const bridge = new SocketPtyBridge("w1:p1", ws, {}, { spawn });
  bridge.open();

  expect(ws.closed).toBe(true);
});

test("watchdog: fires onFallback and kills the process when no frame arrives in time", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let fallbackCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    { onFallback: () => fallbackCalls++ },
    { spawn, watchdogMs: 15 },
  );
  bridge.open();

  await new Promise((r) => setTimeout(r, 50));

  expect(fallbackCalls).toBe(1);
  expect(fake.isKilled()).toBe(true);
});

test("post-first-frame abnormal exit: process dies with no terminal.closed and no close()", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let fallbackCalls = 0;
  let abnormalCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    {
      onFallback: () => fallbackCalls++,
      onAbnormalExit: () => abnormalCalls++,
    },
    { spawn },
  );
  bridge.open();
  fake.push(frameLines[0]!);
  await tick();
  fake.resolveExit(1);
  await tick();

  expect(abnormalCalls).toBe(1);
  expect(fallbackCalls).toBe(0);
  expect(ws.closed).toBe(true);
});

test("gone: a pre-first-frame terminal.closed{not found} kills the proc", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  const bridge = new SocketPtyBridge("w1:p1", ws, { onGone: () => {} }, { spawn });
  bridge.open();
  fake.push(notFoundClosedLine);
  await tick();
  fake.resolveExit(0);
  await tick();

  expect(fake.isKilled()).toBe(true);
});

test("fallback: a pre-first-frame terminal.closed{other reason} kills the proc", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  const bridge = new SocketPtyBridge("w1:p1", ws, { onFallback: () => {} }, { spawn });
  bridge.open();
  fake.push(detachedClosedLine);
  await tick();
  fake.resolveExit(0);
  await tick();

  expect(fake.isKilled()).toBe(true);
});

test("stray frame after pre-first-frame fallback: no onFirstFrame, no ws.send, outcome unchanged", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let fallbackCalls = 0;
  let firstFrameCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    { onFallback: () => fallbackCalls++, onFirstFrame: () => firstFrameCalls++ },
    { spawn },
  );
  bridge.open();
  // The pre-confirm terminal.closed (→ fallback) and a stray frame arrive buffered together,
  // ahead of EOF (as they would in a real pipe). The frame must be ignored because an outcome
  // already fired.
  fake.pushRaw(`${detachedClosedLine}\n${frameLines[0]!}\n`);
  await tick();

  expect(fallbackCalls).toBe(1);
  expect(firstFrameCalls).toBe(0);
  expect(ws.sends.length).toBe(0);
});

test("watchdog cap: an enormous running max latency clamps the armed watchdog at WATCHDOG_CAP_MS", async () => {
  // Drive a confirmed attach whose first-frame latency is huge, via the injectable clock, so
  // module-global runningMaxFirstFrameMs is pushed far past what MARGIN * runningMax would allow
  // (30_000ms cap). A subsequent bridge with no override must arm at the cap, not at
  // MARGIN * runningMax. No real wall-clock waits: we spy on the global setTimeout to observe
  // the ms the watchdog is armed with, since MARGIN * runningMax here would be ~4,000,000ms.
  const hugeFake = makeFakeProc();
  const hugeSpawn = fakeSpawn(hugeFake);
  const hugeWs = fakeWs();
  let t = 0;
  const clock = (): number => t;
  const hugeBridge = new SocketPtyBridge("w1:p1", hugeWs, {}, { spawn: hugeSpawn, now: clock });
  hugeBridge.open();
  t = 1_000_000; // simulated huge first-frame latency, far beyond WATCHDOG_CAP_MS
  hugeFake.push(frameLines[0]!);
  await tick();

  const originalSetTimeout = globalThis.setTimeout;
  let capturedMs: number | undefined;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (capturedMs === undefined) capturedMs = ms;
    return originalSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;

  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  try {
    // Fresh bridge, no watchdogMs override: the watchdog must be armed at WATCHDOG_CAP_MS
    // (30_000ms), not MARGIN * runningMax (which would be ~4,000,000ms here).
    const bridge = new SocketPtyBridge("w1:p2", ws, {}, { spawn });
    bridge.open();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  expect(capturedMs).toBe(30_000);
});

test("post-first-frame normal end: frame then terminal.closed{detached} fires no hook", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let abnormalCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    { onAbnormalExit: () => abnormalCalls++ },
    { spawn },
  );
  bridge.open();
  fake.push(frameLines[0]!);
  await tick();
  expect(JSON.parse(detachedClosedLine).reason).toBe("detached");
  fake.push(detachedClosedLine);
  await tick();
  fake.resolveExit(0);
  await tick();

  expect(abnormalCalls).toBe(0);
  expect(ws.closed).toBe(true);
});

test("exit race: proc.exited resolving before a buffered terminal.closed{not found} is drained still fires onGone", async () => {
  const fake = makeFakeProc();
  const spawn = fakeSpawn(fake);
  const ws = fakeWs();
  let goneCalls = 0;
  let fallbackCalls = 0;
  const bridge = new SocketPtyBridge(
    "w1:p1",
    ws,
    { onGone: () => goneCalls++, onFallback: () => fallbackCalls++ },
    { spawn },
  );
  bridge.open();
  // The not-found closed line is enqueued but NOT yet read (no tick between push and exit), then
  // the process exits. watchExit must drain the pump before classifying, so the buffered gone
  // line wins — without the drain, the exit would be mis-mapped to a node-pty fallback.
  fake.push(notFoundClosedLine);
  fake.resolveExit(0);
  await tick();
  await tick();

  expect(goneCalls).toBe(1);
  expect(fallbackCalls).toBe(0);
  expect(ws.closed).toBe(true);
});
