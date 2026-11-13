// Private control channel on an already-authorized PTY socket. Never shell input.
export const CLEAN_TERMINAL_PREFIX = "\x00clean-terminal:";

export interface TerminalPoint {
  row: number;
  col: number;
}
export interface TerminalScroll {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}
export type CleanTerminalRequest = { id: number } & (
  | { op: "init" | "snapshot" }
  | { op: "scroll"; offset: number }
  | { op: "selection"; revision: number; anchor: TerminalPoint; cursor: TerminalPoint }
);
export type CleanTerminalReply = {
  id: number;
  scroll?: TerminalScroll;
  revision?: number;
  text?: string;
  error?: "unsupported" | "unavailable" | "stale";
};

const uint = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
const point = (p: unknown): p is TerminalPoint => {
  if (!p || typeof p !== "object") return false;
  const v = p as TerminalPoint;
  return uint(v.row, 0xffffffff) && uint(v.col, 0xffff);
};
export function parseCleanTerminalRequest(frame: string): CleanTerminalRequest | null {
  if (!frame.startsWith(CLEAN_TERMINAL_PREFIX) || frame.length > 2048) return null;
  try {
    const r = JSON.parse(frame.slice(CLEAN_TERMINAL_PREFIX.length));
    if (!r || !uint(r.id)) return null;
    if (r.op === "init" || r.op === "snapshot") return r;
    if (r.op === "scroll" && uint(r.offset)) return r;
    if (r.op === "selection" && uint(r.revision) && point(r.anchor) && point(r.cursor)) return r;
  } catch {
    /* invalid control frames are consumed, never forwarded */
  }
  return null;
}
