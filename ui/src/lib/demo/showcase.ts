// Demo-only, one-shot scripted showcase for the ⌘K command bar. The bar already
// works interactively in the demo; this drives a passive viewer through open →
// filter → close ONCE, and only if they haven't touched the keyboard/pointer yet
// (CommandBar auto-focuses its input on mount, so a recurring auto-open would
// steal focus/typing from an interacting visitor).
//
// Framework-store only — this module never imports the director and never
// touches the DOM beyond the two idle-gate window listeners. `+page.svelte`
// subscribes `commandBarShowcase` into its own local `$state` under a `__DEMO__`
// guard, so this module tree-shakes out of normal (non-demo) builds.

import { writable } from "svelte/store";

const OPEN_DELAY_MS = 3500;
const CLOSE_DELAY_MS = 2800;

/** The seeded repo is `acme/storefront`, so "store" yields a real filtered match. */
const SHOWCASE_FILTER = "store";

export const commandBarShowcase = writable<{ open: boolean; filter: string }>({
  open: false,
  filter: "",
});

let started = false;
let interacted = false;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** Idle-gate, covering BOTH phases with a single `{ once: true }` listener:
 *   - interaction BEFORE the open fires → cancel the pending open (bar never opens);
 *   - interaction DURING the open window → cancel the pending forced-close, leaving
 *     the bar OPEN and handing it to the visitor (the normal ⌘K/onclose/selection
 *     path now controls it — we must NOT yank it shut mid-interaction).
 *  Either way we drop the idle listeners: the showcase has done its one shot. */
function markInteracted(): void {
  interacted = true;
  if (openTimer !== null) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  removeIdleListeners();
}

function addIdleListeners(): void {
  window.addEventListener("keydown", markInteracted, { once: true });
  window.addEventListener("pointerdown", markInteracted, { once: true });
}

/** Explicit removal for the branch where the listeners never fired (visitor
 *  stayed idle through the whole showcase) — `{ once: true }` only self-removes
 *  a listener that actually fired. */
function removeIdleListeners(): void {
  window.removeEventListener("keydown", markInteracted);
  window.removeEventListener("pointerdown", markInteracted);
}

/** Idempotent, browser-only, one-shot: schedules the single open→close beat. */
export function startCommandBarShowcase(): void {
  if (typeof window === "undefined") return;
  if (started) return;
  started = true;

  addIdleListeners();

  openTimer = setTimeout(() => {
    openTimer = null;
    if (interacted) return; // visitor got there first — never steal focus
    commandBarShowcase.set({ open: true, filter: SHOWCASE_FILTER });

    closeTimer = setTimeout(() => {
      closeTimer = null;
      commandBarShowcase.set({ open: false, filter: "" });
      removeIdleListeners();
    }, CLOSE_DELAY_MS);
  }, OPEN_DELAY_MS);
}

/** Clears any pending timers, removes the idle listeners, resets the store, and
 *  resets internal state so the showcase could be started again (teardown/tests —
 *  the showcase is one-shot per real page-load). */
export function stopCommandBarShowcase(): void {
  if (openTimer !== null) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (typeof window !== "undefined") removeIdleListeners();
  commandBarShowcase.set({ open: false, filter: "" });
  started = false;
  interacted = false;
}
