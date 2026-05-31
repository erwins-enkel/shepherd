import type { Session, WsEvent, UsageLimits } from "./types";
import type { BlockState } from "./triage";

export class HerdStore {
  sessions = $state<Session[]>([]);
  blocks = $state<Record<string, BlockState>>({});
  connected = $state(false);
  usageLimits = $state<UsageLimits | null>(null);

  setAll(list: Session[]) {
    this.sessions = list;
  }
  setUsageLimits(l: UsageLimits) {
    this.usageLimits = l;
  }
  byId(id: string) {
    return this.sessions.find((s) => s.id === id);
  }

  apply(ev: WsEvent) {
    if (ev.event === "session:new") {
      if (!this.byId(ev.data.id)) this.sessions = [...this.sessions, ev.data];
    } else if (ev.event === "session:status") {
      this.sessions = this.sessions.map((s) =>
        s.id === ev.data.id ? { ...s, status: ev.data.status } : s,
      );
    } else if (ev.event === "session:archived") {
      this.sessions = this.sessions.filter((s) => s.id !== ev.data.id);
      this.blocks = dropKey(this.blocks, ev.data.id);
    } else if (ev.event === "session:block") {
      if (ev.data.block) {
        const prev = this.blocks[ev.data.id];
        this.blocks = {
          ...this.blocks,
          [ev.data.id]: { reason: ev.data.block, since: prev?.since ?? Date.now() },
        };
      } else {
        this.blocks = dropKey(this.blocks, ev.data.id);
      }
    } else if (ev.event === "usage:limits") {
      this.usageLimits = ev.data;
    }
  }

  /** Connect the /events WS with auto-reconnect. Returns a disposer. */
  connect(makeWs: () => WebSocket = () => new WebSocket(wsUrl("/events"))): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    const open = () => {
      ws = makeWs();
      ws.onopen = () => (this.connected = true);
      ws.onmessage = (e) => {
        try {
          this.apply(JSON.parse(e.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        this.connected = false;
        if (!stopped) setTimeout(open, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      stopped = true;
      ws?.close();
    };
  }
}

function dropKey<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const copy = { ...rec };
  delete copy[id];
  return copy;
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
