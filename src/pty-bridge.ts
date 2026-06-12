import { config } from "./config";
import { isValidTerminalId } from "./validate";
import { markPtyEvent } from "./instrument";
import { compileCacheDir } from "./tmp-sweep";

export interface PtySocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

type NodeProc = Bun.Subprocess<"pipe", "pipe", "inherit">;

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
    (async () => {
      for await (const chunk of this.proc!.stdout as ReadableStream<Uint8Array>) {
        markPtyEvent("out");
        this.ws.send(chunk);
      }
    })();
  }

  write(data: string): void {
    this.proc?.stdin.write(data);
    this.proc?.stdin.flush();
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
