import { describe, expect, it, vi } from "vitest";
import {
  installKeyboardScrollRestore,
  keyboardOccluded,
  type KeyboardScrollWindow,
} from "./keyboard-scroll.js";

const FULL = 800;
const KEYBOARD = 340;

function fakeWindow(opts: { coarse?: boolean; vv?: boolean; scrollHeight?: number } = {}) {
  const vvTarget = new EventTarget();
  const docTarget = new EventTarget();
  const vv = Object.assign(vvTarget, { height: FULL, scale: 1 });
  const win = {
    scrollY: 0,
    innerHeight: FULL,
    scrollTo: vi.fn((_x: number, y: number) => {
      win.scrollY = y;
    }),
    visualViewport: opts.vv === false ? null : vv,
    matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" && opts.coarse !== false }),
    document: Object.assign(docTarget, {
      scrollingElement: { scrollHeight: opts.scrollHeight ?? FULL },
    }),
  };
  const keyboard = (open: boolean) => {
    vv.height = open ? FULL - KEYBOARD : FULL;
    vvTarget.dispatchEvent(new Event("resize"));
  };
  const tap = () => docTarget.dispatchEvent(new Event("pointerdown"));
  const focus = () => docTarget.dispatchEvent(new Event("focusin"));
  return { win: win as unknown as KeyboardScrollWindow & typeof win, vv, keyboard, tap, focus };
}

describe("keyboardOccluded", () => {
  it("is true only when the keyboard occludes more than the threshold", () => {
    expect(keyboardOccluded(FULL, { height: FULL - KEYBOARD, scale: 1 })).toBe(true);
    expect(keyboardOccluded(FULL, { height: FULL - 60, scale: 1 })).toBe(false);
    // pure pinch zoom: vv shrinks by exactly 1/scale → no occlusion
    expect(keyboardOccluded(FULL, { height: FULL / 2, scale: 2 })).toBe(false);
  });
});

describe("installKeyboardScrollRestore", () => {
  it("scrolls back to the pre-keyboard position when the keyboard closes", () => {
    const f = fakeWindow();
    installKeyboardScrollRestore(f.win);
    f.tap();
    f.keyboard(true);
    f.win.scrollY = 300; // iOS scrolls the field into view
    f.keyboard(false);
    expect(f.win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(f.win.scrollY).toBe(0);
  });

  it("restores a document-scrolled position, clamped to the scrollable range", () => {
    const f = fakeWindow({ scrollHeight: 3000 });
    installKeyboardScrollRestore(f.win);
    f.win.scrollY = 1200;
    f.focus();
    f.keyboard(true);
    f.win.scrollY = 1500;
    f.keyboard(false);
    expect(f.win.scrollY).toBe(1200);

    f.win.scrollY = 2000;
    f.tap();
    f.keyboard(true);
    f.win.document.scrollingElement!.scrollHeight = 2400; // content shrank while typing
    f.keyboard(false);
    expect(f.win.scrollY).toBe(2400 - FULL);
  });

  it("keeps the pre-keyboard position when focus moves while the keyboard is open", () => {
    const f = fakeWindow({ scrollHeight: 3000 });
    installKeyboardScrollRestore(f.win);
    f.tap();
    f.keyboard(true);
    f.win.scrollY = 400;
    f.tap();
    f.focus();
    f.keyboard(false);
    expect(f.win.scrollY).toBe(0);
  });

  it("does not scroll when nothing moved", () => {
    const f = fakeWindow();
    installKeyboardScrollRestore(f.win);
    f.tap();
    f.keyboard(true);
    f.keyboard(false);
    expect(f.win.scrollTo).not.toHaveBeenCalled();
  });

  it("never scrolls on pinch zoom", () => {
    const f = fakeWindow({ scrollHeight: 3000 });
    installKeyboardScrollRestore(f.win);
    f.vv.scale = 2;
    f.vv.height = FULL / 2;
    f.vv.dispatchEvent(new Event("resize"));
    f.win.scrollY = 500;
    f.vv.height = FULL / 2 + 10;
    f.vv.dispatchEvent(new Event("resize"));
    expect(f.win.scrollTo).not.toHaveBeenCalled();
  });

  it("is a no-op without a coarse pointer or a visualViewport", () => {
    for (const opts of [{ coarse: false }, { vv: false }]) {
      const f = fakeWindow(opts);
      installKeyboardScrollRestore(f.win);
      if (f.win.visualViewport) {
        f.keyboard(true);
        f.win.scrollY = 300;
        f.keyboard(false);
      }
      expect(f.win.scrollTo).not.toHaveBeenCalled();
    }
  });

  it("detaches its listeners on dispose", () => {
    const f = fakeWindow();
    const dispose = installKeyboardScrollRestore(f.win);
    dispose();
    f.keyboard(true);
    f.win.scrollY = 300;
    f.keyboard(false);
    expect(f.win.scrollTo).not.toHaveBeenCalled();
  });
});
