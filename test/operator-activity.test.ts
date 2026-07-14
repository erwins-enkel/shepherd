import { expect, test } from "bun:test";
import {
  getLastOperatorKeystrokeAt,
  isOperatorKeystroke,
  stampOperatorKeystroke,
} from "../src/operator-activity";

test("a normal keystroke frame counts as operator input", () => {
  expect(isOperatorKeystroke("a")).toBe(true);
  expect(isOperatorKeystroke("ls -la\r")).toBe(true);
  expect(isOperatorKeystroke("\x1b[A")).toBe(true); // arrow key
});

test("a resize control frame is NOT operator input", () => {
  expect(isOperatorKeystroke("\x00resize:80:24\n")).toBe(false);
  expect(isOperatorKeystroke("\x00resize:120:40\n")).toBe(false);
});

test("a mouse report is NOT operator input", () => {
  // With mouse tracking on, xterm forwards a report for every move/click/drag/wheel
  // over the terminal — nobody typed those (issue #1022).
  expect(isOperatorKeystroke("\x1b[<35;12;5M")).toBe(false); // SGR motion
  expect(isOperatorKeystroke("\x1b[<0;12;5M")).toBe(false); // SGR press
  expect(isOperatorKeystroke("\x1b[<0;12;5m")).toBe(false); // SGR release
  expect(isOperatorKeystroke("\x1b[<64;12;5M")).toBe(false); // SGR wheel up
  expect(isOperatorKeystroke("\x1b[32;12;5M")).toBe(false); // urxvt (1015)
  expect(isOperatorKeystroke("\x1b[M\x20\x30\x40")).toBe(false); // X10/default encoding
});

test("focus reports and terminal query replies are NOT operator input", () => {
  expect(isOperatorKeystroke("\x1b[I")).toBe(false); // focus in
  expect(isOperatorKeystroke("\x1b[O")).toBe(false); // focus out
  expect(isOperatorKeystroke("\x1b[?62;1;6c")).toBe(false); // DA1
  expect(isOperatorKeystroke("\x1b[>0;10;1c")).toBe(false); // DA2
  expect(isOperatorKeystroke("\x1b[12;3R")).toBe(false); // cursor position (DSR)
  expect(isOperatorKeystroke("\x1b[?12;3R")).toBe(false); // cursor position (DECXCPR)
  expect(isOperatorKeystroke("\x1b[0n")).toBe(false); // DSR-5 status reply
  expect(isOperatorKeystroke("\x1b[?2026;2$y")).toBe(false); // DECRPM
  expect(isOperatorKeystroke("\x1b[8;40;120t")).toBe(false); // XTWINOPS
  expect(isOperatorKeystroke("\x1b]11;rgb:1e1e/1e1e/2e2e\x07")).toBe(false); // OSC, BEL-terminated
  expect(isOperatorKeystroke("\x1b]10;rgb:c0c0/c0c0/c0c0\x1b\\")).toBe(false); // OSC, ST-terminated
  expect(isOperatorKeystroke("\x1bP1+r5463=787465726d\x1b\\")).toBe(false); // DCS (XTGETTCAP)
});

test("a burst of mouse reports in one frame is NOT operator input", () => {
  expect(isOperatorKeystroke("\x1b[<35;10;5M\x1b[<35;11;5M\x1b[<35;12;5M")).toBe(false);
});

test("typed bytes batched after a reply still count as operator input", () => {
  // The non-typing patterns are anchored through their terminators (no greedy `.*`),
  // so a reply can't swallow real input that arrives in the same frame.
  expect(isOperatorKeystroke("\x1b[12;3Rx")).toBe(true);
  expect(isOperatorKeystroke("\x1b[0nx")).toBe(true);
  expect(isOperatorKeystroke("\x1b[<35;12;5Ma")).toBe(true);
  expect(isOperatorKeystroke("\x1b]11;rgb:1e1e/1e1e/2e2e\x07hi")).toBe(true);
});

test("whitespace and control bytes are operator input", () => {
  expect(isOperatorKeystroke(" ")).toBe(true); // typed space
  expect(isOperatorKeystroke("\r")).toBe(true); // Enter
  expect(isOperatorKeystroke("\t")).toBe(true); // Tab
  expect(isOperatorKeystroke("\x03")).toBe(true); // Ctrl-C
  expect(isOperatorKeystroke("\x1b")).toBe(true); // Escape
  expect(isOperatorKeystroke("\x1b[200~pasted\x1b[201~")).toBe(true); // bracketed paste
});

test("stamp writes the timestamp and getLast reads it back", () => {
  const map = new Map<string, number>();
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBeUndefined();
  expect(stampOperatorKeystroke(map, "s1", 1000)).toBe(true);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
});

test("stamp is throttled to ~1/sec per session", () => {
  const map = new Map<string, number>();
  expect(stampOperatorKeystroke(map, "s1", 1000)).toBe(true);
  // within the throttle window → no-op, value unchanged
  expect(stampOperatorKeystroke(map, "s1", 1500)).toBe(false);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
  // at/after the window → stamps again
  expect(stampOperatorKeystroke(map, "s1", 2000)).toBe(true);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(2000);
});

test("throttle is per session id", () => {
  const map = new Map<string, number>();
  expect(stampOperatorKeystroke(map, "s1", 1000)).toBe(true);
  expect(stampOperatorKeystroke(map, "s2", 1000)).toBe(true); // different session, not throttled
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
  expect(getLastOperatorKeystrokeAt(map, "s2")).toBe(1000);
});

test("a resize frame, when correctly skipped, never advances the seam", () => {
  // Mirrors the server gating: only stamp when isOperatorKeystroke(frame).
  const map = new Map<string, number>();
  const feed = (frame: string, now: number) => {
    if (isOperatorKeystroke(frame)) stampOperatorKeystroke(map, "s1", now);
  };
  feed("\x00resize:80:24\n", 1000);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBeUndefined();
  feed("x", 1000);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
});
