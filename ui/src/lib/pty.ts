import { wsUrl } from "./store.svelte";

export interface PtyConn {
  send(data: string): void;
  resize(c: number, r: number): void;
  close(): void;
}

export function connectPty(
  id: string,
  cols: number,
  rows: number,
  onData: (bytes: string) => void,
  onClose: () => void,
): PtyConn {
  // pass the fitted size on attach so herdr sizes the pane right from the first
  // paint — without it the pane starts at the 100×30 default and stays mis-sized
  // until a resize forces a repaint (worse with many background panes)
  const ws = new WebSocket(wsUrl(`/pty/${id}?cols=${cols}&rows=${rows}`));
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) =>
    onData(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  ws.onclose = onClose;
  return {
    send: (d) => ws.readyState === ws.OPEN && ws.send(d),
    resize: (c, r) => ws.readyState === ws.OPEN && ws.send(`\x00resize:${c}:${r}\n`),
    close: () => ws.close(),
  };
}
