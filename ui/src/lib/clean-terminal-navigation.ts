import type { Terminal } from "@xterm/xterm";
import {
  CLEAN_TERMINAL_PREFIX as prefix,
  type CleanTerminalRequest,
  type CleanTerminalReply,
  type TerminalPoint,
  type TerminalScroll,
} from "../../../shared/clean-terminal";
import { trimTrailingWhitespace } from "./terminalSelection";

export const wheelLines = (delta: number, mode: number, height: number, rows: number): number =>
  -delta * (mode === 2 ? rows : mode === 1 ? 1 : 1 / height);
export const absolutePoint = (scroll: TerminalScroll, row: number, col: number): TerminalPoint => ({
  row: scroll.max_offset_from_bottom - scroll.offset_from_bottom + row,
  col,
});

type Command = CleanTerminalRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;
interface Drag {
  start: TerminalPoint;
  pointer: { clientX: number; clientY: number };
  anchor?: TerminalPoint;
  cursor?: TerminalPoint;
  revision?: number;
  moved: boolean;
  released: boolean;
}

/** Navigation for agentless socket terminals only: herdr owns their history. */
export function wireCleanTerminalNavigation(
  term: Terminal,
  el: HTMLElement,
  opts: {
    send(frame: string): void;
    onScroll(scrolledUp: boolean): void;
    onError(error: NonNullable<CleanTerminalReply["error"]>): void;
  },
) {
  let closed = false;
  let started = false;
  let enabled = false;
  let retryInit = false;
  let dirty = true;
  let scroll: TerminalScroll | undefined;
  let nextId = 0;
  let generation = 0;
  let inFlight: { id: number; command: Command; generation: number } | undefined;
  let delta = 0;
  let jump: "top" | "bottom" | undefined;
  let drag: Drag | undefined;
  let copied = "";
  let nativeArmed = false;
  let resync = false;
  let edgeTimer: ReturnType<typeof setInterval> | undefined;
  const screen = () => el.querySelector<HTMLElement>(".xterm-screen") ?? el;
  const pointAt = (p: { clientX: number; clientY: number }): TerminalPoint => {
    const rect = screen().getBoundingClientRect();
    return {
      row: Math.max(
        0,
        Math.min(term.rows - 1, Math.floor(((p.clientY - rect.top) * term.rows) / rect.height)),
      ),
      col: Math.max(
        0,
        Math.min(term.cols - 1, Math.floor(((p.clientX - rect.left) * term.cols) / rect.width)),
      ),
    };
  };
  const stopEdge = () => {
    clearInterval(edgeTimer);
    edgeTimer = undefined;
  };
  const copy = (text: string) => {
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const send = (command: Command) => {
    inFlight = { id: ++nextId, command, generation };
    opts.send(prefix + JSON.stringify({ id: nextId, ...command }));
  };
  const highlight = () => {
    if (!scroll || !drag?.anchor || !drag.cursor) return;
    const [start, end] = [drag.anchor, drag.cursor].sort((a, b) => a.row - b.row || a.col - b.col);
    const top = scroll.max_offset_from_bottom - scroll.offset_from_bottom;
    const first = Math.max(top, start.row);
    const last = Math.min(top + term.rows - 1, end.row);
    if (first > last) {
      term.clearSelection();
      return;
    }
    const col = first === start.row ? start.col : 0;
    const endCol = last === end.row ? end.col : term.cols - 1;
    term.select(
      col,
      term.buffer.active.viewportY + first - top,
      (last - first) * term.cols + endCol - col + 1,
    );
  };
  const updateCursor = () => {
    if (drag?.anchor && scroll) {
      const p = pointAt(drag.pointer);
      drag.cursor = absolutePoint(scroll, p.row, p.col);
      highlight();
    }
  };
  const cancel = () => {
    generation++;
    stopEdge();
    resync ||= !!drag?.moved;
    drag = undefined;
    delta = 0;
    jump = undefined;
    copied = "";
    nativeArmed = false;
    term.clearSelection();
  };
  const needsSnapshot = () =>
    (dirty && (Math.abs(delta) >= 1 || jump)) || (drag?.moved && !drag.anchor) || resync;
  const nextOffset = (state: TerminalScroll) => {
    if (jump === "top") return state.max_offset_from_bottom;
    if (jump === "bottom") return 0;
    return Math.max(
      0,
      Math.min(state.max_offset_from_bottom, state.offset_from_bottom + Math.trunc(delta)),
    );
  };
  const pump = () => {
    if (closed || inFlight || !enabled || !scroll) return;
    if (needsSnapshot()) {
      resync = false;
      send({ op: "snapshot" });
      return;
    }
    if (Math.abs(delta) >= 1 || jump) {
      const wanted = nextOffset(scroll);
      delta -= Math.trunc(delta);
      jump = undefined;
      if (wanted !== scroll.offset_from_bottom) {
        send({ op: "scroll", offset: wanted });
        return;
      }
    }
    if (drag?.released && drag.anchor && drag.cursor && drag.revision !== undefined) {
      send({ op: "selection", revision: drag.revision, anchor: drag.anchor, cursor: drag.cursor });
    }
  };
  const edge = () => {
    if (!drag?.moved || drag.released || !scroll) {
      stopEdge();
      return;
    }
    const rect = screen().getBoundingClientRect();
    const direction =
      drag.pointer.clientY < rect.top ? 1 : drag.pointer.clientY >= rect.bottom ? -1 : 0;
    if (!direction) {
      stopEdge();
      return;
    }
    if (inFlight) return;
    const atLimit =
      direction > 0
        ? scroll.offset_from_bottom >= scroll.max_offset_from_bottom
        : scroll.offset_from_bottom === 0;
    if (atLimit) {
      stopEdge();
      return;
    }
    delta += direction * 3;
    pump();
  };
  const trackEdge = () => {
    const rect = screen().getBoundingClientRect();
    if (drag && (drag.pointer.clientY < rect.top || drag.pointer.clientY >= rect.bottom)) {
      edgeTimer ??= setInterval(edge, 60);
    } else stopEdge();
  };
  const paint = (text: string) => {
    // Snapshots contain rows, not cursor motion. Remove their terminal line terminator
    // so painting the last screen row cannot create spurious local scrollback.
    const data = text.replace(/(?:\r?\n)+$/, "").replace(/\r?\n/g, "\r\n");
    term.write("\x1b[0m\x1b[H\x1b[2J" + data, () => {
      if (!closed) highlight();
    });
  };
  const handleFailure = (error: NonNullable<CleanTerminalReply["error"]>, command: Command) => {
    const droppedOutput = !!drag?.moved;
    cancel();
    // Recover one snapshot after discarding a selection. A failed recovery itself
    // has no drag, so it cannot create a retry loop on a busy/broken endpoint.
    resync = droppedOutput;
    if (command.op === "init") {
      enabled = false;
      retryInit = error !== "unsupported";
      if (error === "stale") return;
    }
    opts.onError(error);
    pump();
    return;
  };
  const applySnapshot = (reply: CleanTerminalReply) => {
    if (drag && drag.revision !== undefined && drag.revision !== reply.revision) {
      cancel();
      opts.onError("stale");
    } else if (drag?.moved && !drag.anchor && scroll) {
      drag.anchor = absolutePoint(scroll, drag.start.row, drag.start.col);
      drag.revision = reply.revision;
    }
    if (reply.text !== undefined) paint(reply.text);
    updateCursor();
  };
  const applyReply = (reply: CleanTerminalReply, command: Command) => {
    if (reply.scroll) {
      scroll = reply.scroll;
      dirty = false;
      opts.onScroll(scroll.offset_from_bottom > 0);
    }
    if (command.op === "init") enabled = true;
    else if (command.op === "selection") {
      copied = trimTrailingWhitespace(reply.text ?? "");
      copy(copied);
      stopEdge();
      drag = undefined;
      resync = true;
    } else {
      applySnapshot(reply);
    }
    pump();
  };
  const handleOutput = (data: string, textFrame = false): boolean => {
    if (closed) return false;
    if (!textFrame || !data.startsWith(prefix)) {
      dirty = true;
      if (!started) {
        started = true;
        send({ op: "init" });
      }
      return !!drag?.moved;
    }
    let reply: CleanTerminalReply;
    try {
      reply = JSON.parse(data.slice(prefix.length));
    } catch {
      return true;
    }
    const waiting = inFlight;
    if (!waiting || reply.id !== waiting.id) return true;
    inFlight = undefined;
    if (waiting.generation !== generation && waiting.command.op !== "init") {
      pump();
      return true;
    }
    if (reply.error) {
      handleFailure(reply.error, waiting.command);
      return true;
    }
    applyReply(reply, waiting.command);
    return true;
  };
  const scrollDelta = (dy: number, mode = 0) => {
    if (!enabled && inFlight?.command.op !== "init") {
      if (!retryInit) return;
      retryInit = false;
      send({ op: "init" });
    }
    const height = screen().getBoundingClientRect().height / term.rows || 16;
    delta += wheelLines(dy, mode, height, term.rows);
    pump();
  };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || (!enabled && !retryInit && inFlight?.command.op !== "init")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    scrollDelta(e.deltaY, e.deltaMode);
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || !screen().contains(e.target as Node)) return;
    cancel();
    if (!enabled || e.detail > 1) {
      nativeArmed = true;
      return;
    } // keep xterm's native word/line selection
    resync = false;
    e.preventDefault();
    e.stopImmediatePropagation();
    term.focus();
    drag = { start: pointAt(e), pointer: e, moved: false, released: false };
  };
  const onMove = (e: MouseEvent) => {
    if (!drag || drag.released) return;
    if (e.buttons === 0) {
      cancel();
      return;
    }
    drag.pointer = e;
    const p = pointAt(e);
    drag.moved ||= p.row !== drag.start.row || p.col !== drag.start.col;
    updateCursor();
    trackEdge();
    pump();
  };
  const onUp = (e: MouseEvent) => {
    if (!drag) {
      if (nativeArmed) {
        copied = trimTrailingWhitespace(term.getSelection());
        copy(copied);
      }
      nativeArmed = false;
      return;
    }
    stopEdge();
    drag.pointer = e;
    updateCursor();
    if (!drag.moved) {
      drag = undefined;
      return;
    }
    drag.released = true;
    pump();
  };
  const onCopy = (e: ClipboardEvent) => {
    const text = copied || (!drag ? trimTrailingWhitespace(term.getSelection()) : "");
    if (!text && !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (text) e.clipboardData?.setData("text/plain", text);
  };
  const onKey = (e: KeyboardEvent) => {
    if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && (copied || drag)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      copy(copied);
      return;
    }
    cancel();
  };
  const onHidden = () => {
    if (document.hidden) cancel();
  };
  const resize = term.onResize(cancel);
  el.addEventListener("wheel", onWheel, { capture: true, passive: false });
  el.addEventListener("mousedown", onDown, true);
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  el.addEventListener("copy", onCopy, true);
  el.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", onHidden);
  return {
    handleOutput,
    scrollDelta,
    cancel,
    reset() {
      cancel();
      started = enabled = retryInit = false;
      inFlight = undefined;
      scroll = undefined;
      opts.onScroll(false);
    },
    top() {
      if (enabled) {
        cancel();
        resync = false;
        jump = "top";
        pump();
      }
    },
    bottom() {
      if (enabled) {
        cancel();
        resync = false;
        jump = "bottom";
        pump();
      }
    },
    dispose() {
      cancel();
      closed = true;
      resize.dispose();
      el.removeEventListener("wheel", onWheel, true);
      el.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.removeEventListener("copy", onCopy, true);
      el.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onHidden);
    },
  };
}
