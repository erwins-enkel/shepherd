import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createTypingCounter } from "./terminal-input";

// The regression this pins (issue #1022): the banner's escalation counter used to
// be bumped from term.onData, which — with mouse tracking on, the mode Claude Code
// runs in — also carries a report for every mouse move/click/drag/wheel. Moving the
// mouse made the banner claim "You're typing".
//
// So each pointer case asserts BOTH halves: that the gesture really did produce an
// onData frame (i.e. the frame the old code would have counted was genuinely
// emitted — without this the test could pass against a broken mechanism), AND that
// the counter did not move. A real xterm Terminal in a real browser is what makes
// the first half meaningful; a hand-fed frame would be circular.

/** Mouse-tracking modes a TUI plausibly negotiates. agentOwnsScroll (Viewport.svelte)
 *  only tells us mouseTrackingMode !== "none", not which one — so cover all three.
 *  They differ in what they report: 1000 press/release, 1002 adds drag, 1003 adds
 *  bare motion. All with SGR (1006) encoding, which routes reports through onData. */
const MODES = [
  { name: "?1000 (press/release)", seq: "\x1b[?1000;1006h", reportsMotion: false },
  { name: "?1002 (＋drag)", seq: "\x1b[?1002;1006h", reportsMotion: false },
  { name: "?1003 (＋motion)", seq: "\x1b[?1003;1006h", reportsMotion: true },
] as const;

let host: HTMLDivElement;
let term: Terminal;
let counter: { destroy(): void };
let count = 0;
let frames: string[] = [];

/** Terminal.write is async (parser queue); flush before asserting on emitted data. */
const flush = () => new Promise<void>((r) => term.write("", r));

/** Cell-centre-ish coordinates inside the screen element, so xterm maps the event
 *  onto a real cell (a report is only emitted for an in-bounds col/row). */
function screenEl(): HTMLElement {
  const s = host.querySelector<HTMLElement>(".xterm-screen");
  if (!s) throw new Error("no .xterm-screen — term.open() did not render");
  return s;
}

function pointerEventInit(el: HTMLElement): MouseEventInit {
  const r = el.getBoundingClientRect();
  return {
    clientX: r.left + 20,
    clientY: r.top + 20,
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
  };
}

async function setup(modeSeq: string) {
  host = document.createElement("div");
  host.style.width = "640px";
  host.style.height = "320px";
  document.body.appendChild(host);

  term = new Terminal({ allowProposedApi: true });
  term.open(host);

  frames = [];
  term.onData((d) => frames.push(d));

  count = 0;
  counter = createTypingCounter(term, () => count++);

  term.write(modeSeq);
  await flush();
}

afterEach(() => {
  counter?.destroy();
  term?.dispose();
  host?.remove();
});

describe("createTypingCounter — pointer activity is not typing", () => {
  for (const mode of MODES) {
    describe(mode.name, () => {
      beforeEach(async () => await setup(mode.seq));

      it("a click reports to the app but does not count as typing", async () => {
        const el = screenEl();
        const init = pointerEventInit(el);
        el.dispatchEvent(new MouseEvent("mousedown", init));
        el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
        await flush();

        expect(frames.length, "click emitted a mouse report on onData").toBeGreaterThan(0);
        expect(count, "click is not typing").toBe(0);
      });

      it("a bare mousemove does not count as typing", async () => {
        const el = screenEl();
        el.dispatchEvent(new MouseEvent("mousemove", { ...pointerEventInit(el), buttons: 0 }));
        await flush();

        // Only motion-reporting mode (?1003) emits anything for a bare move; in the
        // others there is no frame to mis-count in the first place.
        if (mode.reportsMotion) {
          expect(frames.length, "bare move emitted a motion report on onData").toBeGreaterThan(0);
        }
        expect(count, "moving the mouse is not typing").toBe(0);
      });

      it("a drag released outside the terminal does not count as typing", async () => {
        // xterm tracks the drag on the *document* so a drag leaving the element keeps
        // reporting — the release lands on document, not on the terminal.
        const el = screenEl();
        const init = pointerEventInit(el);
        el.dispatchEvent(new MouseEvent("mousedown", init));
        document.dispatchEvent(
          new MouseEvent("mousemove", { ...init, clientX: init.clientX! + 40, buttons: 1 }),
        );
        document.dispatchEvent(
          new MouseEvent("mouseup", { ...init, clientX: 0, clientY: 0, buttons: 0 }),
        );
        await flush();

        expect(frames.length, "drag emitted mouse reports on onData").toBeGreaterThan(0);
        expect(count, "dragging is not typing").toBe(0);
      });

      it("a wheel scroll does not count as typing", async () => {
        const el = screenEl();
        el.dispatchEvent(
          new WheelEvent("wheel", { ...pointerEventInit(el), deltaY: 120, deltaMode: 0 }),
        );
        await flush();

        expect(frames.length, "wheel emitted a report on onData").toBeGreaterThan(0);
        expect(count, "scrolling is not typing").toBe(0);
      });

      it("a synthesized touch-fling wheel does not count as typing", async () => {
        // Viewport dispatches exactly this on .xterm-screen for one-finger drags and
        // for the rAF fling frames after touchend — a flick-scroll on a phone.
        const el = screenEl();
        for (const deltaY of [-90, -60, -30]) {
          el.dispatchEvent(
            new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
          );
        }
        await flush();

        expect(frames.length, "fling emitted reports on onData").toBeGreaterThan(0);
        expect(count, "touch fling is not typing").toBe(0);
      });
    });
  }
});

describe("createTypingCounter — real operator input counts", () => {
  beforeEach(async () => await setup("\x1b[?1003;1006h"));

  it("a keystroke counts", async () => {
    const ta = term.textarea!;
    expect(ta, "textarea exists after open()").toBeTruthy();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(count).toBe(1);
  });

  it("a bare modifier does not count", () => {
    const ta = term.textarea!;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
    expect(count).toBe(0);
  });

  it("a paste counts (incl. the middle-click primary-selection shape)", () => {
    const ta = term.textarea!;
    ta.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));
    expect(count).toBe(1);
  });

  it("mobile IME composition counts", () => {
    const ta = term.textarea!;
    // A soft keyboard finalizes through the composition/input path, never a keydown —
    // this is why xterm's onKey was not usable as the signal.
    ta.dispatchEvent(new CompositionEvent("compositionend", { data: "こんにちは", bubbles: true }));
    expect(count).toBe(1);
  });

  it("dropped text counts", () => {
    const ta = term.textarea!;
    ta.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
    expect(count).toBe(1);
  });

  it("stops counting after destroy()", () => {
    const ta = term.textarea!;
    counter.destroy();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(count).toBe(0);
  });
});
