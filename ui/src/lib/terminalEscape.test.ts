import { describe, it, expect } from "vitest";
import { noteTerminalFocus, ownsDriftedEscape, shouldForwardEscape } from "./terminalEscape";

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
  ownsDriftedFocus: true,
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

  it("leaves a drifted-focus Escape to the terminal that owns it", () => {
    expect(shouldForwardEscape({ ...ok, ownsDriftedFocus: false })).toBe(false);
    expect(shouldForwardEscape({ ...ok, active: null, ownsDriftedFocus: false })).toBe(false);
  });

  it("still forwards focus inside its own terminal regardless of drift ownership", () => {
    expect(shouldForwardEscape({ ...ok, active: xtermTextarea, ownsDriftedFocus: false })).toBe(
      true,
    );
  });
});

describe("ownsDriftedEscape", () => {
  // A mount stand-in: isConnected + offsetParent (null = display:none) are all it reads.
  const mount = (shown = true, connected = true) =>
    ({ isConnected: connected, offsetParent: shown ? {} : null }) as unknown as HTMLElement;

  it("gives a drifted Escape to the terminal last focused while it is on screen", () => {
    const session = mount();
    const assistant = mount();
    noteTerminalFocus(assistant);
    expect(ownsDriftedEscape(assistant, false)).toBe(true);
    expect(ownsDriftedEscape(session, true)).toBe(false);
    noteTerminalFocus(session);
    expect(ownsDriftedEscape(assistant, false)).toBe(false);
    expect(ownsDriftedEscape(session, true)).toBe(true);
  });

  it("falls back to the session terminal once the last-focused one is hidden or gone", () => {
    const session = mount();
    for (const last of [mount(false), mount(true, false)]) {
      noteTerminalFocus(last);
      expect(ownsDriftedEscape(session, true)).toBe(true);
      expect(ownsDriftedEscape(last, false)).toBe(false);
    }
  });
});
