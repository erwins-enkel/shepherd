/**
 * Browser View client (#2881): the socket to `/browser-view/<sessionId>` plus the pure input
 * mapping the panel uses. The server owns CDP — this side only speaks its small typed protocol
 * (see src/browser-view.ts): `targets` / `frame` / `error` in; `select`, `frameAck`, `mouse`,
 * `key`, `text`, `navigate`, `reload` out.
 */
import { wsUrl } from "./store.svelte";

export interface BrowserViewTarget {
  id: string;
  title: string;
  url: string;
}

export interface BrowserViewFrame {
  /** base64 JPEG */
  data: string;
  /** The page viewport in CSS px — the coordinate space `Input.dispatchMouseEvent` expects. */
  width: number;
  height: number;
}

export type BrowserViewMessage =
  | { type: "select"; targetId: string }
  | { type: "frameAck" }
  | {
      type: "mouse";
      action: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      button: string;
      clickCount: number;
      modifiers: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      type: "key";
      action: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      modifiers: number;
      text?: string;
    }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "reload" };

export interface BrowserViewHandlers {
  onTargets(targets: BrowserViewTarget[], selected: string | null): void;
  onFrame(frame: BrowserViewFrame): void;
  onError(message: string): void;
  /** The socket closed (any reason); the panel offers a manual reconnect. */
  onClose(code: number, reason: string): void;
}

export interface BrowserViewConn {
  send(msg: BrowserViewMessage): void;
  close(): void;
}

export function connectBrowserView(
  sessionId: string,
  handlers: BrowserViewHandlers,
  makeWs: (path: string) => WebSocket = (p) => new WebSocket(wsUrl(p)),
): BrowserViewConn {
  const ws = makeWs(`/browser-view/${encodeURIComponent(sessionId)}`);
  let closed = false;
  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(e.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "targets" && Array.isArray(msg.targets))
      handlers.onTargets(
        msg.targets as BrowserViewTarget[],
        typeof msg.selected === "string" ? msg.selected : null,
      );
    else if (msg.type === "frame" && typeof msg.data === "string")
      handlers.onFrame({
        data: msg.data,
        width: Number(msg.width) || 0,
        height: Number(msg.height) || 0,
      });
    else if (msg.type === "error" && typeof msg.message === "string") handlers.onError(msg.message);
  };
  ws.onclose = (e) => {
    if (closed) return;
    closed = true;
    handlers.onClose(e.code, e.reason);
  };
  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      ws.close();
    },
  };
}

/** Where a `w`×`h` image lands when `object-fit: contain`-ed into a `boxW`×`boxH` box. */
export function containRect(boxW: number, boxH: number, w: number, h: number) {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(boxW / w, boxH / h);
  const dw = w * scale,
    dh = h * scale;
  return { x: (boxW - dw) / 2, y: (boxH - dh) / 2, w: dw, h: dh };
}

/**
 * A pointer at (`px`, `py`) inside the image element's box → page CSS px, or null when it falls
 * in the letterbox. `natural*` is the JPEG's size; `page*` the frame's CSS viewport size.
 */
export function toPageCoords(
  px: number,
  py: number,
  box: { width: number; height: number },
  natural: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  const r = containRect(box.width, box.height, natural.width, natural.height);
  if (r.w === 0 || px < r.x || py < r.y || px > r.x + r.w || py > r.y + r.h) return null;
  return { x: ((px - r.x) / r.w) * page.width, y: ((py - r.y) / r.h) * page.height };
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const MOUSE_BUTTONS = ["left", "middle", "right", "back", "forward"];

/** DOM `MouseEvent.button` → CDP button name. */
export function mouseButton(button: number): string {
  return MOUSE_BUTTONS[button] ?? "none";
}

type KeyLike = {
  key: string;
  code: string;
  keyCode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/** True for the paste chord: left to the browser so the view's `paste` event fires instead. */
export function isPasteChord(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
}

/**
 * A DOM key event → the `key` message. Printable keys (and Enter) carry `text` on keydown so the
 * page receives the character; everything else is a raw key. Null for the paste chord.
 */
export function keyMessage(e: KeyLike, action: "down" | "up"): BrowserViewMessage | null {
  if (isPasteChord(e)) return null;
  const msg: BrowserViewMessage = {
    type: "key",
    action,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    modifiers: modifiersOf(e),
  };
  if (action === "down") {
    if (e.key === "Enter") msg.text = "\r";
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) msg.text = e.key;
  }
  return msg;
}

/** Only http(s) URLs may be opened from the view (the broker refuses everything else). */
export function navigableUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // `host:port` is not a scheme: a colon followed by a digit is a port.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw);
  // Dev servers on loopback speak plain http; anything else defaults to https.
  const loopback = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(raw);
  const withScheme = hasScheme ? raw : `${loopback ? "http" : "https"}://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
