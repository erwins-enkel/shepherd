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
  it("flashes the fired control's keycap, then ends the revealed state", () => {
    const hold = make();
    keydown("Meta");
    vi.advanceTimersByTime(HOLD_MS);

    hold.trigger("plan-gate");
    expect(hold.flash).toBe("plan-gate");
    expect(hold.visible).toBe(false);

    vi.advanceTimersByTime(FLASH_MS);
    expect(hold.flash).toBeNull();
  });

  it("does not flash when nothing was revealed", () => {
    const hold = make();
    hold.trigger("plan-gate");
    expect(hold.flash).toBeNull();
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
