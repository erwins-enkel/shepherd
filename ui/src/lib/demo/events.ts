import type { WsEvent } from "$lib/types";
import { bus } from "./bus";
import { FakeWebSocket } from "./fake-socket";

// Fake WebSocket for the `/events` stream. On (async) open it subscribes to the
// demo bus and forwards every `WsEvent` as a JSON `onmessage` frame — matching the
// wire format `store.svelte.ts` decodes (`JSON.parse(e.data)`). Inbound presence
// heartbeats are ignored; the subscription is torn down on close.
export class EventsSocket extends FakeWebSocket {
  #unsub: (() => void) | null = null;

  protected onOpened(): void {
    this.#unsub = bus.subscribe((ev: WsEvent) => this.emitMessage(JSON.stringify(ev)));
  }

  override send(): void {
    // The only frame the client sends here is `{type:"presence"}` — a no-op in demo.
  }

  protected onTeardown(): void {
    this.#unsub?.();
    this.#unsub = null;
  }
}
