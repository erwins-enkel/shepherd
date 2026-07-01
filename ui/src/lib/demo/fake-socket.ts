// Base class for the demo's fake WebSockets (/events, /pty/:id). It reproduces
// exactly the slice of the WebSocket contract that the real callers touch —
// `store.svelte.ts` reads `WebSocket.OPEN` (static) and assigns on* handlers;
// `pty.ts` reads `ws.OPEN`/`ws.CLOSING` (instance), sets `ws.binaryType`, and
// assigns on* handlers. Crucially, `onopen` (and the first `onmessage`) fire on a
// LATER microtask, never synchronously in the constructor — both callers assign
// their handlers AFTER `new WebSocket(...)`, so a synchronous open would be missed.

type MessageEventLike = { data: unknown };
type CloseEventLike = { code?: number };

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  /** Writable no-op store — `pty.ts` sets it to "arraybuffer"; we ignore it. */
  binaryType = "blob";

  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEventLike) => void) | null = null;
  onclose: ((e?: CloseEventLike) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Defer the OPEN transition so callers can wire handlers first.
    queueMicrotask(() => this.#doOpen());
  }

  #doOpen(): void {
    if (this.readyState !== this.CONNECTING) return; // closed before it opened
    this.readyState = this.OPEN;
    this.onopen?.();
    this.onOpened();
  }

  /** Subclass hook — runs once, right after the socket reaches OPEN. */
  protected onOpened(): void {}

  /** Deliver a frame to the consumer; no-op unless OPEN. */
  protected emitMessage(data: unknown): void {
    if (this.readyState !== this.OPEN) return;
    this.onmessage?.({ data });
  }

  send(data?: unknown): void {
    // Demo sockets ignore client sends by default; subclasses may override.
    void data;
  }

  close(code?: number): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    this.onTeardown();
    this.readyState = this.CLOSED;
    this.onclose?.(code === undefined ? {} : { code });
  }

  /** Subclass hook — clean up timers/subscriptions on close. */
  protected onTeardown(): void {}
}
