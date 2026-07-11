import { config } from "./config";
import { markPtyEvent } from "./instrument";
import { createDemux } from "./pty-demux.mjs";
import type { PtySocket } from "./pty-bridge";

/** A write/flush against a helper whose pipe is already gone. Nothing to recover: the
 *  process's exit handling closes the socket, and the caller reconnects/falls back.
 *  Swallowed, never left floating (mirrors PtyBridge.write's `pipeGone`). */
const pipeGone = (): void => {};

type Proc = Bun.Subprocess<"pipe", "pipe", "pipe">;

/** Narrow an NDJSON-decoded value to a plain object before indexing into it. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Adaptive watchdog seed/margin (issue #1529 Phase-0 capture, see
// test/fixtures/terminal-control/capture-notes.md): 5 `observe` first-frame latencies on dev
// measured 18/34/44/17/19ms (control: 27ms), worst ~44ms. SEED_MS is generous headroom above
// that; MARGIN widens the effective watchdog as the module-wide running max grows, so a
// slower prod host self-adjusts instead of false-triggering the herdr → node-pty fallback.
const SEED_MS = 2000;
const MARGIN = 4;
// Ceiling on the adaptive watchdog: without it, one latency outlier permanently widens the
// watchdog for every future attach (delaying fallback if a broken subcommand hangs without
// exiting). runningMaxFirstFrameMs only ever grows, so the computed watchdog must be clamped.
const WATCHDOG_CAP_MS = 30_000;

/** Slowest confirmed first-frame latency seen so far, across every SocketPtyBridge instance in
 *  this process — feeds the adaptive watchdog computation (see SEED_MS/MARGIN above). */
let runningMaxFirstFrameMs = 0;

export interface SocketPtyBridgeHooks {
  /** Fired exactly once, on the first terminal.frame (attach confirmed). */
  onFirstFrame?: () => void;
  /** Fired at most once when the socket path fails BEFORE the first frame for a reason that is
   *  NOT "agent gone" (spawn throw, process exit with no NDJSON, watchdog timeout, or a
   *  terminal.closed whose reason does NOT contain "not found"). The caller re-attaches this same
   *  ws via node-pty. Mutually exclusive with onGone and onAbnormalExit. */
  onFallback?: () => void;
  /** Fired at most once when, BEFORE the first frame, we receive terminal.closed whose reason
   *  contains "not found" (herdr says the pane target is gone). The caller treats this exactly
   *  like node-pty agent-gone. Mutually exclusive with onFallback. */
  onGone?: () => void;
  /** Fired at most once when the process exits AFTER the first frame WITHOUT a terminal.closed
   *  and WITHOUT a deliberate close() (i.e. an unexpected mid-stream death / version skew). The
   *  caller stamps a failure memo so the browser's reconnect avoids the socket path. */
  onAbnormalExit?: () => void;
}

export interface SocketPtyBridgeDeps {
  herdrBin?: string; // default config.herdrBin
  spawn?: typeof Bun.spawn; // injectable for tests
  now?: () => number; // injectable clock (default Date.now) for watchdog + latency
  watchdogMs?: number; // override the adaptive watchdog (tests)
}

/** Bridges one browser WS to `herdr terminal session control`, streamed directly over its
 *  stdio — no node-pty. See test/fixtures/terminal-control/capture-notes.md for the pinned wire
 *  contract this class parses/emits against. */
export class SocketPtyBridge {
  private readonly herdrBin: string;
  private readonly spawnFn: typeof Bun.spawn;
  private readonly now: () => number;
  private readonly watchdogMsOverride: number | undefined;
  private readonly demux: ReturnType<typeof createDemux>;
  private readonly decoder = new TextDecoder();

  private proc: Proc | null = null;
  private stdoutBuf = "";
  private stdoutPump: Promise<void> = Promise.resolve();
  private spawnTime = 0;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private confirmed = false; // first terminal.frame seen
  private sawClose = false; // a terminal.closed line was parsed
  private closing = false; // close() was called deliberately
  private outcomeFired = false; // one of onFallback/onGone/onAbnormalExit has fired
  private wsClosed = false; // ws.close() has fired
  private handedOff = false; // onFallback took over the ws (node-pty); we must not close it

  constructor(
    private readonly target: string,
    private readonly ws: PtySocket,
    private readonly hooks: SocketPtyBridgeHooks = {},
    deps: SocketPtyBridgeDeps = {},
  ) {
    this.herdrBin = deps.herdrBin ?? config.herdrBin;
    this.spawnFn = deps.spawn ?? Bun.spawn;
    this.now = deps.now ?? Date.now;
    this.watchdogMsOverride = deps.watchdogMs;
    this.demux = createDemux({
      onInput: (text: string) => this.sendCommand({ type: "terminal.input", text }),
      onResize: (cols: number, rows: number) =>
        this.sendCommand({ type: "terminal.resize", cols, rows }),
    });
  }

  open(cols = 100, rows = 30): void {
    this.spawnTime = this.now();
    let proc: Proc;
    try {
      proc = this.spawnFn(
        [
          this.herdrBin,
          "terminal",
          "session",
          "control",
          this.target,
          "--takeover",
          "--cols",
          String(cols),
          "--rows",
          String(rows),
        ],
        {
          stdin: "pipe" as const,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          env: { ...process.env, HERDR_BIN: this.herdrBin },
        },
      ) as Proc;
    } catch {
      this.fireFallback();
      this.closeWs();
      return;
    }
    this.proc = proc;
    this.armWatchdog();
    this.pumpStdout(proc);
    this.drainStderr(proc);
    this.watchExit(proc);
  }

  write(data: string): void {
    this.demux.feed(data);
  }

  close(): void {
    this.closing = true;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.sendCommand({ type: "terminal.release" });
    this.proc?.kill();
  }

  // ── stdout: line-buffered NDJSON reader ──────────────────────────────────

  private pumpStdout(proc: Proc): void {
    // Not awaited here — this pump runs for the life of the bridge. But its promise is stored so
    // watchExit can DRAIN it before classifying the exit: proc.stdout reaches EOF when the child
    // exits, so a fast bad-target's trailing terminal.closed{not found} may still be buffered/
    // unread when proc.exited resolves. Classifying then would mis-map a gone target to node-pty
    // fallback (see watchExit). A broken stream just ends the pump; watchExit still runs.
    this.stdoutPump = (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        this.handleChunk(chunk);
      }
    })().catch(() => {
      /* stream torn down — watchExit drives the classification + ws.close() */
    });
  }

  private drainStderr(proc: Proc): void {
    // herdr's stderr isn't surfaced on this path (version-skew usage errors etc. drive the
    // fallback via the stdout/exit discriminator instead) — drained only so a chatty child
    // never blocks on a full pipe buffer.
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })().catch(() => {
      /* discard */
    });
  }

  private watchExit(proc: Proc): void {
    void (async () => {
      try {
        await proc.exited;
      } catch {
        /* treat a rejected exited promise the same as a plain exit */
      }
      // Drain every NDJSON line the pump can still deliver before classifying. proc.stdout EOFs
      // at exit, so awaiting the pump guarantees a trailing terminal.closed is parsed first and
      // isn't lost to the exit race (which would mis-map gone → node-pty fallback). stdoutPump
      // never rejects (its catch swallows), and flushStdoutBuf handles a final unterminated line.
      await this.stdoutPump;
      this.flushStdoutBuf();
      this.onProcessExit();
    })();
  }

  /** Parse a final NDJSON record left in the buffer without a trailing newline (defensive: the
   *  pinned contract is newline-terminated, but a trailing closed line must never be dropped). */
  private flushStdoutBuf(): void {
    const rest = this.stdoutBuf;
    this.stdoutBuf = "";
    if (rest.trim() !== "") this.handleLine(rest);
  }

  private handleChunk(chunk: Uint8Array): void {
    this.stdoutBuf += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim() !== "") this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return; // malformed line — ignore defensively, not part of the pinned contract
    }
    if (!isRecord(rec)) return;
    if (rec["type"] === "terminal.frame") this.handleFrame(rec);
    else if (rec["type"] === "terminal.closed") this.handleClosed(rec);
  }

  private handleFrame(rec: Record<string, unknown>): void {
    if (this.outcomeFired) return; // stray frame from a killed proc's pipe after an outcome fired
    const bytes = rec["bytes"];
    if (typeof bytes !== "string") return;
    markPtyEvent("out");
    this.ws.send(Buffer.from(bytes, "base64"));
    if (!this.confirmed) {
      this.confirmed = true;
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
      const latency = this.now() - this.spawnTime;
      if (latency > runningMaxFirstFrameMs) runningMaxFirstFrameMs = latency;
      this.hooks.onFirstFrame?.();
    }
  }

  private handleClosed(rec: Record<string, unknown>): void {
    this.sawClose = true;
    if (this.closing) return; // a deliberate close() never fires a hook
    if (this.confirmed) return; // post-confirm: no hook, watchExit's ws.close() handles it
    const reason = typeof rec["reason"] === "string" ? rec["reason"] : "";
    if (/not found/i.test(reason)) this.fireGone();
    else this.fireFallback();
    this.proc?.kill(); // pre-confirm: onFallback/onGone hands the ws off or closes it, but nobody
    // else reaps this proc (unlike the watchdog path) — kill it defensively.
  }

  // ── stdin: NDJSON command writer ──────────────────────────────────────────

  private sendCommand(command: Record<string, unknown>): void {
    const stdin = this.proc?.stdin;
    if (!stdin) return;
    const line = JSON.stringify(command) + "\n";
    // See PtyBridge.write for why both write and flush need the Promise.resolve normalization
    // and the swallow: this runs on every keystroke/resize against a pipe that may already be
    // torn down, and a bare unhandled rejection there would fire on every such write.
    void Promise.resolve(stdin.write(line)).catch(pipeGone);
    void Promise.resolve(stdin.flush()).catch(pipeGone);
  }

  // ── adaptive watchdog ──────────────────────────────────────────────────────

  private armWatchdog(): void {
    const watchdogMs =
      this.watchdogMsOverride ??
      Math.min(WATCHDOG_CAP_MS, Math.max(SEED_MS, MARGIN * runningMaxFirstFrameMs));
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.confirmed || this.closing) return;
      this.fireFallback();
      this.proc?.kill();
    }, watchdogMs);
  }

  // ── exit classification state machine ─────────────────────────────────────

  private onProcessExit(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (!this.closing) {
      if (!this.confirmed) {
        this.fireFallback(); // no-op if onGone/onFallback already fired from a closed line/watchdog
      } else if (!this.sawClose) {
        this.fireAbnormalExit();
      }
    }
    this.closeWs();
  }

  private fireFallback(): void {
    if (this.outcomeFired) return;
    this.outcomeFired = true;
    if (this.hooks.onFallback) {
      this.handedOff = true; // caller re-attaches this ws (node-pty); we must not close it
      this.hooks.onFallback();
    }
  }

  private fireGone(): void {
    if (this.outcomeFired) return;
    this.outcomeFired = true;
    this.hooks.onGone?.();
  }

  private fireAbnormalExit(): void {
    if (this.outcomeFired) return;
    this.outcomeFired = true;
    this.hooks.onAbnormalExit?.();
  }

  private closeWs(): void {
    if (this.wsClosed || this.handedOff) return;
    this.wsClosed = true;
    this.ws.close();
  }
}
