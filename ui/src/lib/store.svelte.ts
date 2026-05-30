import type { Session, WsEvent } from "./types";

export class HerdStore {
  sessions = $state<Session[]>([]);
  connected = $state(false);

  setAll(list: Session[]) {
    this.sessions = list;
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

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
