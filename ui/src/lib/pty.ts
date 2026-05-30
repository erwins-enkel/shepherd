import { wsUrl } from "./store.svelte";

// Server closes a pty WS with this code when a newer client takes over the
// terminal. We park instead of reconnecting, so two devices on the same session
// don't ping-pong the attach. Keep in sync with PTY_SUPERSEDED_CODE in src/server.ts.
const PTY_SUPERSEDED_CODE = 4000;

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
  /** Re-attach after being parked (superseded) — makes this client the owner again. */
  takeover(): void;
}

export function connectPty(
  id: string,
  cols: number,
  rows: number,
  onData: (bytes: string) => void,
  // fired on every reconnect (not the first connect) — caller refits + resizes
  // so a fresh attach repaints at the current size
  onReconnect: () => void = () => {},
  // fired when the server hands this terminal to another device — caller shows a
  // "take over" affordance instead of fighting for the attach
  onParked: () => void = () => {},
  makeWs: (path: string) => WebSocket = (p) => new WebSocket(wsUrl(p)),
): PtyConn {
  let ws: WebSocket;
  let stopped = false;
  let parked = false;
  let everOpened = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  // track the latest fitted size so a reconnect attaches at the right dimensions
  // (the viewport may have changed — rotation, keyboard — while backgrounded)
  let lastCols = cols;
  let lastRows = rows;

  const open = () => {
    parked = false;
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
    ws.onclose = (e) => {
      // a newer client took the terminal → park; never auto-reconnect (that would
      // bump them right back, and they'd bump us: the takeover war)
      if (e && e.code === PTY_SUPERSEDED_CODE) {
        parked = true;
        onParked();
        return;
      }
      if (!stopped && !parked && !retry) retry = setTimeout(open, 1000);
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
      if (stopped || parked) return; // parked is deliberate — don't steal back on refocus
      // a scheduled retry → run it immediately; otherwise reconnect only if the
      // socket is actually gone (CLOSING/CLOSED), never disturb a live one
      if (retry || ws.readyState >= ws.CLOSING) open();
    },
    takeover: () => {
      if (stopped) return;
      open(); // re-attach → server makes us the owner and parks the other device
    },
  };
}
