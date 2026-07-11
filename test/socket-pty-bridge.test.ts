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
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
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
    },
    exited,
  };
  return {
    proc,
    stdinWrites,
    isKilled: () => killed,
    push(line: string): void {
      controller.enqueue(encoder.encode(line.endsWith("\n") ? line : `${line}\n`));
    },
    pushRaw(text: string): void {
      controller.enqueue(encoder.encode(text));
    },
    endStdout(): void {
      controller.close();
    },
    resolveExit(code = 0): void {
      resolveExited(code);
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

test("pre-first-frame fallback: process exits with no frame and no close", async () => {
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
  expect(ws.closed).toBe(true);
});

test("pre-first-frame fallback: a synchronous spawn throw fires onFallback", () => {
  const ws = fakeWs();
  let fallbackCalls = 0;
  const spawn = (() => {
    throw new Error("spawn ENOENT");
  }) as unknown as typeof Bun.spawn;
  const bridge = new SocketPtyBridge("w1:p1", ws, { onFallback: () => fallbackCalls++ }, { spawn });
  bridge.open();

  expect(fallbackCalls).toBe(1);
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
