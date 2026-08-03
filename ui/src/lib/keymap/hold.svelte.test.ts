import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHoldReveal, FLASH_MS, HOLD_MS } from "./hold.svelte";

// The state machine's own transitions are driven directly here — `attach` is a
// thin DOM-wiring layer and is covered by NewTask's browser test instead. That
// keeps the timing rules in the fast node project, with no DOM and no mount.
let active = true;
let mac = true;
let hold: ReturnType<typeof createHoldReveal>;

function make() {
  hold = createHoldReveal({ isMac: () => mac, active: () => active });
  return hold;
}

function keydown(key: string, init: Partial<KeyboardEvent> = {}) {
  hold.onKeydown({ key, repeat: false, ...init } as KeyboardEvent);
}
function keyup(key: string) {
  hold.onKeyup({ key } as KeyboardEvent);
}

beforeEach(() => {
  vi.useFakeTimers();
  active = true;
  mac = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("arming", () => {
  it("reveals after the modifier is held alone for 350 ms", () => {
    const hold = make();
    keydown("Meta");
    expect(hold.visible).toBe(false);

    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(hold.visible).toBe(false);

    vi.advanceTimersByTime(1);
    expect(hold.visible).toBe(true);
  });

  it("stays silent when the combination completes inside the window", () => {
    // The core promise: someone who knows ⌘V is never interrupted.
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(200);
    keydown("v", { metaKey: true });
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(hold.visible).toBe(false);
  });

  it("uses Control as the modifier off macOS, and ignores Meta there", () => {
    mac = false;
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(hold.visible).toBe(false);

    keydown("Control");
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.visible).toBe(true);
  });

  it("ignores auto-repeat, which would otherwise restart the clock forever", () => {
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(200);
    keydown("Meta", { repeat: true });
    keydown("Meta", { repeat: true });
    vi.advanceTimersByTime(150);
    expect(hold.visible).toBe(true);
  });

  it("does not arm while the dialog is inactive", () => {
    active = false;
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(hold.visible).toBe(false);
  });

  it("does not reveal if the dialog closes during the wait", () => {
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(200);
    active = false;
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.visible).toBe(false);
  });
});

describe("dismissal", () => {
  function reveal() {
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.visible).toBe(true);
    return hold;
  }

  it("hides on keyup of the modifier", () => {
    const hold = reveal();
    keyup("Meta");
    expect(hold.visible).toBe(false);
  });

  it("hides when the window loses focus", () => {
    // Without this the keyup lands in another app and the overlay is stranded.
    const hold = reveal();
    hold.onBlur();
    expect(hold.visible).toBe(false);
  });

  it("hides on any pointer press", () => {
    const hold = reveal();
    hold.onPointerdown();
    expect(hold.visible).toBe(false);
  });

  it("hides on Escape", () => {
    const hold = reveal();
    keydown("Escape", { metaKey: true });
    expect(hold.visible).toBe(false);
  });
});

describe("trigger", () => {
  it("keeps the reveal up for the whole flash, then ends it", () => {
    // Keycaps only exist while the reveal is up, so ending it at trigger time
    // would unmount the very cap that is supposed to light.
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS);

    hold.trigger("plan-gate");
    expect(hold.flash).toBe("plan-gate");
    expect(hold.visible).toBe(true);

    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(hold.visible).toBe(true);

    vi.advanceTimersByTime(1);
    expect(hold.flash).toBeNull();
    expect(hold.visible).toBe(false);
  });

  it("survives the modifier keyup that firing the shortcut always produces", () => {
    // You cannot press ⌘G without letting go of ⌘ a moment later, so treating
    // that keyup as a dismissal cut off practically every flash. The flash timer
    // owns the teardown once it is running.
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS);
    hold.trigger("plan-gate");

    keyup("Meta"); // released mid-flash — the normal case, not an interruption
    expect(hold.flash).toBe("plan-gate");
    expect(hold.visible).toBe(true);

    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(hold.visible).toBe(true);

    vi.advanceTimersByTime(1);
    expect(hold.flash).toBeNull();
    expect(hold.visible).toBe(false);
  });

  it("still ends on a hard dismissal mid-flash", () => {
    // Blur/pointer/Escape are explicit "go away" signals, not the tail of a
    // keystroke — they cut the flash short rather than waiting it out.
    for (const dismiss of [(h: typeof hold) => h.onBlur(), (h: typeof hold) => h.onPointerdown()]) {
      const h = make();
      keydown("Meta");
      vi.advanceTimersByTime(HOLD_MS);
      h.trigger("plan-gate");

      dismiss(h);
      expect(h.visible).toBe(false);
      expect(h.flash).toBeNull();

      // …and the retired flash timer cannot fire later and resurrect anything.
      vi.advanceTimersByTime(FLASH_MS * 2);
      expect(h.visible).toBe(false);
    }
  });

  it("does not flash when nothing was revealed", () => {
    const hold = make();
    hold.trigger("plan-gate");
    expect(hold.flash).toBeNull();
  });
});

describe("pointer movement", () => {
  const move = (x: number, y: number) =>
    hold.onPointermove({ clientX: x, clientY: y } as PointerEvent);

  it("cancels the pending arm when the mouse actually moves", () => {
    // Spec: the timer may only elapse if no other key was pressed AND the mouse
    // was not moved or clicked.
    const hold = make();
    move(10, 10); // seed the baseline
    keydown("Meta");
    vi.advanceTimersByTime(200);
    move(40, 25);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(hold.visible).toBe(false);
  });

  it("ignores a pointermove that reports the cursor where it already was", () => {
    // Browsers emit these for reasons other than a moving pointer; a phantom
    // event must not silently swallow the reveal.
    const hold = make();
    move(10, 10);
    keydown("Meta");
    move(10, 10);
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.visible).toBe(true);
  });

  it("does not dismiss an already-visible reveal", () => {
    // Dismissal is keyup/blur/mousedown/Escape — movement is an ARM condition
    // only. Caps that vanish under a drifting cursor would defeat reading them.
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.visible).toBe(true);

    move(10, 10);
    move(80, 60);
    expect(hold.visible).toBe(true);
  });
});

describe("hide", () => {
  it("cancels a pending arm, so a later tick cannot resurrect it", () => {
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(200);
    hold.hide();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(hold.visible).toBe(false);
  });
});
