import { FakeWebSocket } from "../fake-socket";

// Fake WebSocket for the `/pty/:id?cols&rows` terminal attach. For Task 2 it only
// proves the transport: on (async) open it pushes a short dim placeholder line so
// xterm isn't blank. The authored transcript replay engine is Task 5 and will take
// over the post-open stream (see the seam below).
export class PtySocket extends FakeWebSocket {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(url: string) {
    super(url);
    const u = new URL(url, "http://localhost");
    this.sessionId = decodeURIComponent(u.pathname.replace(/^\/pty\//, ""));
    this.cols = Number(u.searchParams.get("cols")) || 80;
    this.rows = Number(u.searchParams.get("rows")) || 24;
  }

  protected onOpened(): void {
    // Dim placeholder so the terminal repaints on attach instead of sitting blank.
    this.emitMessage(`\x1b[2mattaching to demo session ${this.sessionId}…\x1b[0m\r\n`);
    // Task 5: replay engine attaches here — stream the authored transcript for
    // `this.sessionId` as timed byte-string frames via `this.pushBytes(...)`.
  }

  /** Emit terminal bytes to xterm — used by the Task 5 replay engine. */
  protected pushBytes(bytes: string): void {
    this.emitMessage(bytes);
  }

  /** Track a replay timer so it's cleared on close (no orphaned loops). */
  protected track(id: ReturnType<typeof setTimeout>): void {
    this.#timers.push(id);
  }

  protected onTeardown(): void {
    for (const id of this.#timers) clearTimeout(id);
    this.#timers = [];
  }
}
