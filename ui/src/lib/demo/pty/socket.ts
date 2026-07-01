import { FakeWebSocket } from "../fake-socket";
import { playTranscript } from "./replay";
import { transcriptFor } from "./transcripts";
import { ptyStream } from "./stream";

// Fake WebSocket for the `/pty/:id?cols&rows` terminal attach. On (async) open it
// (a) replays the authored transcript for `sessionId` as timed byte-string frames
// so xterm repaints a believable session, and (b) subscribes to `ptyStream` so the
// Task 6 director's ambient live bytes for this id reach the terminal during/after
// the replay. On close it cancels the replay and unsubscribes — no leaks, no
// emit-after-close. A fresh attach (pty.ts reconnects with a new PtySocket) simply
// replays again, which is the correct "repaint on re-attach".
export class PtySocket extends FakeWebSocket {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  #cancelReplay: (() => void) | null = null;
  #unsub: (() => void) | null = null;

  constructor(url: string) {
    super(url);
    const u = new URL(url, "http://localhost");
    this.sessionId = decodeURIComponent(u.pathname.replace(/^\/pty\//, ""));
    this.cols = Number(u.searchParams.get("cols")) || 80;
    this.rows = Number(u.searchParams.get("rows")) || 24;
  }

  protected onOpened(): void {
    // (a) replay the authored scrollback / working session for this id.
    this.#cancelReplay = playTranscript(transcriptFor(this.sessionId), (b) => this.emitMessage(b));
    // (b) live director bytes (Task 6) → this terminal, during and after the replay.
    this.#unsub = ptyStream.subscribe(this.sessionId, (b) => this.emitMessage(b));
  }

  protected onTeardown(): void {
    this.#cancelReplay?.();
    this.#cancelReplay = null;
    this.#unsub?.();
    this.#unsub = null;
  }
}
