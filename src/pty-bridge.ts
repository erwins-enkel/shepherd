import { config } from "./config";

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
  ) {}

  open(cols = 100, rows = 30): void {
    this.proc = Bun.spawn(["node", this.helperPath, this.terminalId, String(cols), String(rows)], {
      stdin: "pipe" as const,
      stdout: "pipe" as const,
      stderr: "inherit" as const,
      env: { ...process.env, HERDR_BIN: config.herdrBin },
      onExit: () => this.ws.close(),
    }) as NodeProc;
    (async () => {
      for await (const chunk of this.proc!.stdout as ReadableStream<Uint8Array>) {
        this.ws.send(chunk);
      }
    })();
  }

  write(data: string): void {
    this.proc?.stdin.write(data);
    this.proc?.stdin.flush();
  }

  resize(cols: number, rows: number): void {
    this.write(`\x00resize:${cols}:${rows}\n`);
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
