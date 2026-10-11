/**
 * The terminal of a session mirrored from a connected machine (issue #2764). The coordinator has
 * already authenticated and authorized the caller at its own `/pty/:id`; this bridges that socket to
 * the same route on the machine that runs the session, with the machine's stored token. The machine
 * stays the authority on its terminal: it attaches, enforces the single owner and decides when the
 * session is gone — its close codes reach the caller unchanged.
 *
 * Frames pass through verbatim in both directions: keystrokes and the `\x00resize:c:r\n` control
 * frames the machine's demux reads, text and binary alike. The size the caller attached with and
 * its client kind/platform go into the machine's URL, so the first paint fits and the machine's
 * owner map names the real client rather than this server.
 *
 * When the machine cannot be reached the caller's socket closes with PTY_MACHINE_UNREACHABLE_CODE —
 * never a local terminal in its place. A drop after the machine's socket was open closes plainly, so
 * the caller reconnects as it would locally; if the machine is still gone, that reconnect ends here.
 *
 * The token goes into the `Authorization` header of the upgrade and nowhere else: not into the URL,
 * a frame or a log line.
 */
import { REMOTE_REQUEST_TIMEOUT_MS, type RemoteTarget } from "./client";

/** The caller's socket closes with this when the session's machine cannot be reached (or refuses
 *  this server's token). The client stops reconnecting and says so. Sibling of PTY_SUPERSEDED_CODE
 *  (4000) and PTY_GONE_CODE (4001) in src/server.ts; keep in sync with ui/src/lib/pty.ts. */
export const PTY_MACHINE_UNREACHABLE_CODE = 4002;

const UNREACHABLE_REASON = "machine unreachable";

/** The caller's socket, as the bridge sees it. */
export interface TerminalSink {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface TerminalAttach {
  cols: number;
  rows: number;
  clientKind: string;
  clientPlatform: string;
}

interface UpstreamHandlers {
  open(): void;
  message(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/** Opens the socket to the machine's `/pty/:id`. The default is Bun's WebSocket client. */
export type OpenTerminalSocket = (
  url: string,
  headers: Record<string, string>,
  on: UpstreamHandlers,
) => { send(data: string | Uint8Array): void; close(): void };

/** Bun's client takes `headers` (absent from the DOM typings) and sends no `Origin`, which the
 *  machine's origin check admits as a non-browser client — its auth gate applies unchanged. A
 *  refused upgrade (or a redirect, which is never followed) errors before `open`. */
const openTerminalSocket: OpenTerminalSocket = (url, headers, on) => {
  const ws = new WebSocket(url, { headers } as never);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => on.open();
  ws.onmessage = (ev) =>
    on.message(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
  ws.onclose = (ev) => on.close(ev.code, ev.reason);
  // A frame from Bun's server socket is a Buffer, whose backing store the DOM typing won't name.
  return { send: (data) => ws.send(data as string | BufferSource), close: () => ws.close() };
};

/** What the caller's socket closes with once the machine's socket closed; `null` = a plain close. */
function callerClose(opened: boolean, code: number, reason: string): [number, string] | null {
  if (!opened) return [PTY_MACHINE_UNREACHABLE_CODE, UNREACHABLE_REASON];
  // 1008 is the machine closing a socket whose credential lost its reach — this server's token.
  if (code === 1008) return [PTY_MACHINE_UNREACHABLE_CODE, UNREACHABLE_REASON];
  // The pty protocol's own codes (superseded, gone): the caller acts on them exactly as locally.
  if (code >= 4000 && code <= 4999) return [code, reason];
  return null;
}

export class RemoteTerminalBridge {
  private upstream: ReturnType<OpenTerminalSocket> | null = null;
  private opened = false;
  private ended = false;
  private pending: (string | Uint8Array)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly openSocket: OpenTerminalSocket;
  private readonly connectTimeoutMs: number;
  private readonly onDone: () => void;

  constructor(
    private readonly target: RemoteTarget | null,
    private readonly sessionId: string,
    private readonly sink: TerminalSink,
    private readonly attach: TerminalAttach,
    deps: { openSocket?: OpenTerminalSocket; connectTimeoutMs?: number; onDone?: () => void } = {},
  ) {
    this.openSocket = deps.openSocket ?? openTerminalSocket;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS;
    this.onDone = deps.onDone ?? (() => {});
  }

  open(): void {
    if (!this.target) return this.finish([PTY_MACHINE_UNREACHABLE_CODE, UNREACHABLE_REASON]);
    const query = new URLSearchParams({
      cols: String(this.attach.cols),
      rows: String(this.attach.rows),
      clientKind: this.attach.clientKind,
      clientPlatform: this.attach.clientPlatform,
    });
    const url = `${this.target.url.replace(/^http/, "ws")}/pty/${encodeURIComponent(this.sessionId)}?${query}`;
    this.timer = setTimeout(
      () => this.finish([PTY_MACHINE_UNREACHABLE_CODE, UNREACHABLE_REASON]),
      this.connectTimeoutMs,
    );
    this.timer.unref?.();
    this.upstream = this.openSocket(
      url,
      { authorization: `Bearer ${this.target.token}` },
      {
        open: () => {
          if (this.ended) return;
          this.opened = true;
          this.clearTimer();
          for (const frame of this.pending) this.upstream?.send(frame);
          this.pending = [];
        },
        message: (data) => {
          if (!this.ended) this.sink.send(data);
        },
        close: (code, reason) => this.finish(callerClose(this.opened, code, reason)),
      },
    );
  }

  /** A frame from the caller: held until the machine's socket is open, then sent in order. */
  write(frame: string | Uint8Array): void {
    if (this.ended) return;
    if (this.opened) this.upstream?.send(frame);
    else this.pending.push(frame);
  }

  /** The caller left: close the machine's socket, so the machine releases the terminal. */
  close(): void {
    this.end();
  }

  /** The machine is gone from this server (disconnected or removed): end the caller's terminal. */
  abort(): void {
    this.finish([PTY_MACHINE_UNREACHABLE_CODE, UNREACHABLE_REASON]);
  }

  private finish(close: [number, string] | null): void {
    if (this.ended) return;
    this.end();
    if (close) this.sink.close(close[0], close[1]);
    else this.sink.close();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimer();
    this.pending = [];
    const upstream = this.upstream;
    this.upstream = null;
    upstream?.close();
    this.onDone();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
