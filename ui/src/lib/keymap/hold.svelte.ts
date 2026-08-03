// Hold-to-reveal state machine for the New Task keycaps.
//
// The whole point of the 350 ms arming delay: a user who KNOWS the shortcut
// completes the combination well inside it and is never interrupted by an
// overlay. Only a hesitation — the modifier held alone — is read as "I don't
// remember what's here", and answers it.
//
// Deliberately framework-thin: plain listeners plus $state, so the timing rules
// are unit-testable by driving DOM events without mounting a component.
// See docs/design/keymap-10a/README.md → "Interaktion & Verhalten".

/** How long the modifier must be held ALONE before the keycaps appear. */
export const HOLD_MS = 350;

/** How long a triggered control's keycap flashes before the overlay ends. */
export const FLASH_MS = 120;

export interface HoldRevealOptions {
  /** Meta on macOS, Control elsewhere — the key that arms the reveal. */
  isMac: () => boolean;
  /** Reveal is only ever armed while this is true (dialog open, desktop layout). */
  active: () => boolean;
}

export function createHoldReveal(opts: HoldRevealOptions) {
  let visible = $state(false);
  let flash = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last observed pointer position, so `onPointermove` can tell real movement
   *  from a pointermove that reports the cursor sitting exactly where it was. */
  let last: { x: number; y: number } | null = null;

  function modifierKeyName(): string {
    return opts.isMac() ? "Meta" : "Control";
  }

  function disarm() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function clearFlash() {
    if (flashTimer !== null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    flash = null;
  }

  /** Cancel the pending arm AND hide anything already shown, flash included.
   *  This is the hard dismissal (blur, pointer press, Escape); the modifier's
   *  own keyup is softer — see `onKeyup`. */
  function hide() {
    disarm();
    clearFlash();
    visible = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!opts.active()) return;

    // Auto-repeat of a held-down modifier: the browser keeps firing keydown.
    // Ignore repeats so they neither restart nor cancel the arming timer.
    if (e.repeat) return;

    if (e.key === modifierKeyName()) {
      // Modifier pressed alone → start arming. Guard against a second keydown
      // for an already-pressed modifier restarting the clock.
      if (timer === null && !visible) {
        timer = setTimeout(() => {
          timer = null;
          // Re-check: the dialog may have closed during the wait.
          if (opts.active()) visible = true;
        }, HOLD_MS);
      }
      return;
    }

    // Any other key while the modifier is down COMPLETES a combination. Whether
    // it is a real shortcut or not, the user is clearly not hesitating — drop
    // the pending reveal and let the key through untouched.
    disarm();

    // Escape closes the revealed state (the spec lists it alongside keyup/blur).
    if (e.key === "Escape") {
      hide();
      return;
    }
  }

  function onKeyup(e: KeyboardEvent) {
    if (e.key !== modifierKeyName()) return;
    // A flash in flight owns the teardown. Releasing the modifier is the NORMAL
    // end of firing a shortcut from the revealed state — you cannot press ⌘G
    // without letting go of ⌘ a moment later — so hiding here would cut off
    // essentially every flash the spec asks for. The flash timer is already
    // scheduled to end the overlay; let it.
    if (flashTimer !== null) {
      disarm();
      return;
    }
    hide();
  }

  /** Mouse movement during the arm window cancels it: the reveal answers a
   *  hesitation at the keyboard, and someone reaching for the mouse is not
   *  hesitating there. Deliberately only DISARMS — once the caps are up the
   *  spec dismisses on mousedown, not on movement, and vanishing them under a
   *  drifting cursor would fight the very reading the reveal exists for.
   *  See README → "Auslösen" (arm condition vs. dismissal list). */
  function onPointermove(e: PointerEvent) {
    // Only genuine movement counts. Browsers emit pointermove for reasons other
    // than a moving pointer (content scrolling beneath a still cursor, synthetic
    // events), and a phantom one must not silently kill the arm — so compare
    // against the last observed position and let the first sighting only seed it.
    const moved = last !== null && (e.clientX !== last.x || e.clientY !== last.y);
    last = { x: e.clientX, y: e.clientY };
    if (moved) disarm();
  }

  /** Losing the window mid-hold would otherwise strand the overlay: the keyup
   *  lands in whatever app took focus and never reaches us. */
  function onBlur() {
    hide();
  }

  /** Any pointer press means the user switched to the mouse — get out of the way. */
  function onPointerdown() {
    hide();
  }

  /** Flash the keycap of a control that was just triggered, THEN end the
   *  revealed state — the spec's "combination fired while visible" path.
   *
   *  The order matters and is easy to get wrong: keycaps only exist while the
   *  reveal is up, so dropping `visible` here would unmount the very cap that is
   *  supposed to light. `visible` therefore stays true for the whole flash and
   *  the timer ends the overlay, which is also what the spec describes —
   *  "blitzt einmal auf ... und der Overlay-Zustand endet". */
  function trigger(id: string) {
    if (!visible) return;
    flash = id;
    disarm();
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      flashTimer = null;
      visible = false;
    }, FLASH_MS);
  }

  /** Attach to the dialog root + window. Returns the teardown; callers wire it
   *  into $effect so nothing outlives the dialog. */
  function attach(root: HTMLElement): () => void {
    // keydown/keyup on the ROOT (they only matter while focus is inside the
    // dialog); blur/pointerdown on the window, because both describe events
    // that happen OUTSIDE it.
    root.addEventListener("keydown", onKeydown);
    root.addEventListener("keyup", onKeyup);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerdown, true);
    // passive: it only reads coordinates, and a move handler that can block
    // scrolling is a cost nobody should pay for a keyboard affordance.
    window.addEventListener("pointermove", onPointermove, { capture: true, passive: true });
    return () => {
      root.removeEventListener("keydown", onKeydown);
      root.removeEventListener("keyup", onKeyup);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerdown, true);
      window.removeEventListener("pointermove", onPointermove, true);
      disarm();
      clearFlash();
      visible = false;
    };
  }

  return {
    get visible() {
      return visible;
    },
    get flash() {
      return flash;
    },
    attach,
    hide,
    trigger,
    // The four raw transitions. `attach` is only the wiring that routes real DOM
    // events here, which is what lets the timing rules be unit-tested with plain
    // event objects — no DOM, no component mount.
    onKeydown,
    onKeyup,
    onBlur,
    onPointerdown,
    onPointermove,
  };
}
