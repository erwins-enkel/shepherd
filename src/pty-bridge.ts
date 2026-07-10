import { config } from "./config";
import { isValidTerminalId } from "./validate";
import { markPtyEvent } from "./instrument";
import { compileCacheDir } from "./tmp-sweep";

export interface PtySocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

type NodeProc = Bun.Subprocess<"pipe", "pipe", "inherit">;

/** A write/flush against a helper whose pipe is already gone. Nothing to recover: the subprocess's
 *  `onExit` closes the socket, and the browser reconnects. Swallowed, never left floating. */
const pipeGone = (): void => {};

/** Bridges one browser WS to a Node subprocess that owns the real PTY. */
export class PtyBridge {
  private proc: NodeProc | null = null;
  constructor(
    private terminalId: string,
    private ws: PtySocket,
    private helperPath = new URL("./pty-attach.mjs", import.meta.url).pathname,
    private nodeBin = config.nodeBin,
  ) {}

  open(cols = 100, rows = 30): void {
    if (!isValidTerminalId(this.terminalId)) throw new Error("invalid terminalId");
    this.proc = Bun.spawn(
      [this.nodeBin, this.helperPath, this.terminalId, String(cols), String(rows)],
      {
        stdin: "pipe" as const,
        stdout: "pipe" as const,
        stderr: "inherit" as const,
        // Pin the V8 compile cache off the tmpfs (see usage-probe for the shared rationale).
        env: { ...process.env, HERDR_BIN: config.herdrBin, NODE_COMPILE_CACHE: compileCacheDir() },
        onExit: () => this.ws.close(),
      },
    ) as NodeProc;
    // Deliberately not awaited — this pump runs for the life of the bridge. A broken stream just
    // ends it; the subprocess's `onExit` above is what closes the socket.
    void (async () => {
      for await (const chunk of this.proc!.stdout as ReadableStream<Uint8Array>) {
        markPtyEvent("out");
        this.ws.send(chunk);
      }
    })().catch(() => {
      /* stream torn down — onExit closes the ws */
    });
  }

  write(data: string): void {
    const stdin = this.proc?.stdin;
    if (!stdin) return;
    // BOTH `write` and `flush` are typed `number | Promise<number>` — the promise arm is why a bare
    // call trips `no-floating-promises`. A plain `void` would silence the gate rather than handle
    // the rejection (`ignoreVoid: true` is the rule's default), and this runs on EVERY keystroke
    // into the web terminal: against a torn-down helper that is a per-keystroke unhandled rejection.
    // `Promise.resolve` normalizes the union so the `.catch` attaches either way.
    void Promise.resolve(stdin.write(data)).catch(pipeGone);
    void Promise.resolve(stdin.flush()).catch(pipeGone);
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
