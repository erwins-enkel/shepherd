import { describe, it, expect } from "vitest";
import { shouldForwardEscape } from "./terminalEscape";

// Stand-ins; identity + a fake `contains` are all the predicate inspects.
const body = {} as Element;
const xtermTextarea = {} as Element; // lives inside the terminal element
const siblingControl = {} as Element; // compose/steer/dialog field — outside it
// terminalEl.contains() is true only for nodes inside the xterm mount.
const terminalEl = { contains: (n: Element | null) => n === xtermTextarea };

// The baseline: a bare Escape on the desktop hardware-keyboard layout, terminal
// tab active, live session, no overlay, focus drifted to <body>. Each case
// flips exactly one field off this baseline.
const ok = {
  key: "Escape",
  composing: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  desktopKeyboard: true,
  termTabActive: true,
  live: true,
  overlayOpen: false,
  active: body,
  body,
  terminalEl,
} as const;

describe("shouldForwardEscape", () => {
  it("forwards a stray body-focus Escape on desktop", () => {
    expect(shouldForwardEscape({ ...ok })).toBe(true);
  });

  it("forwards when nothing is focused (active === null)", () => {
    expect(shouldForwardEscape({ ...ok, active: null })).toBe(true);
  });

  it("forwards when focus is on the terminal's own textarea (swallowed-byte case)", () => {
    expect(shouldForwardEscape({ ...ok, active: xtermTextarea })).toBe(true);
  });

  it("ignores non-Escape keys", () => {
    expect(shouldForwardEscape({ ...ok, key: "a" })).toBe(false);
    expect(shouldForwardEscape({ ...ok, key: "Enter" })).toBe(false);
  });

  it("ignores Escape with a modifier (leaves browser/app chords alone)", () => {
    expect(shouldForwardEscape({ ...ok, ctrlKey: true })).toBe(false);
    expect(shouldForwardEscape({ ...ok, altKey: true })).toBe(false);
    expect(shouldForwardEscape({ ...ok, metaKey: true })).toBe(false);
  });

  it("stands down mid-IME composition (Escape cancels the candidate)", () => {
    expect(shouldForwardEscape({ ...ok, composing: true })).toBe(false);
  });

  it("defers when a sibling control owns focus (compose, steer, dialog field)", () => {
    expect(shouldForwardEscape({ ...ok, active: siblingControl })).toBe(false);
  });

  it("does not fire on touch/mobile layouts (they have the Esc button)", () => {
    expect(shouldForwardEscape({ ...ok, desktopKeyboard: false })).toBe(false);
  });

  it("only fires while the terminal tab is the active pane", () => {
    expect(shouldForwardEscape({ ...ok, termTabActive: false })).toBe(false);
  });

  it("does nothing on a dead/parked session", () => {
    expect(shouldForwardEscape({ ...ok, live: false })).toBe(false);
  });

  it("never steals Escape from an open modal/drawer overlay", () => {
    expect(shouldForwardEscape({ ...ok, overlayOpen: true })).toBe(false);
  });
});
