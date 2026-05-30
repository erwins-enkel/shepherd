import { wsUrl } from "./store.svelte";

export interface PtyConn {
  send(data: string): void;
  resize(c: number, r: number): void;
  close(): void;
  /**
   * Reconnect now if the socket isn't already open — call on tab refocus.
   * Mobile suspends backgrounded tabs and drops the WS; the herdr agent keeps
   * running, so a fresh attach (`--takeover`) repaints the live session.
   */
  poke(): void;
}

export function connectPty(
  id: string,
  cols: number,
  rows: number,
  onData: (bytes: string) => void,
  // fired on every reconnect (not the first connect) — caller refits + resizes
  // so a fresh attach repaints at the current size
  onReconnect: () => void = () => {},
  makeWs: (path: string) => WebSocket = (p) => new WebSocket(wsUrl(p)),
): PtyConn {
  let ws: WebSocket;
  let stopped = false;
  let everOpened = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  // track the latest fitted size so a reconnect attaches at the right dimensions
  // (the viewport may have changed — rotation, keyboard — while backgrounded)
  let lastCols = cols;
  let lastRows = rows;

  const open = () => {
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    ws = makeWs(`/pty/${id}?cols=${lastCols}&rows=${lastRows}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) =>
      onData(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
    ws.onopen = () => {
      if (everOpened) onReconnect();
      everOpened = true;
    };
    ws.onclose = () => {
      if (!stopped && !retry) retry = setTimeout(open, 1000);
    };
    ws.onerror = () => ws.close();
  };
  open();

  return {
    send: (d) => ws.readyState === ws.OPEN && ws.send(d),
    resize: (c, r) => {
      lastCols = c;
      lastRows = r;
      if (ws.readyState === ws.OPEN) ws.send(`\x00resize:${c}:${r}\n`);
    },
    close: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws.close();
    },
    poke: () => {
      if (stopped) return;
      // a scheduled retry → run it immediately; otherwise reconnect only if the
      // socket is actually gone (CLOSING/CLOSED), never disturb a live one
      if (retry || ws.readyState >= ws.CLOSING) open();
    },
  };
}
