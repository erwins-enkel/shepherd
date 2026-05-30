import { wsUrl } from "./store.svelte";

export interface PtyConn {
  send(data: string): void;
  resize(c: number, r: number): void;
  close(): void;
}

export function connectPty(
  id: string,
  onData: (bytes: string) => void,
  onClose: () => void,
): PtyConn {
  const ws = new WebSocket(wsUrl(`/pty/${id}`));
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
