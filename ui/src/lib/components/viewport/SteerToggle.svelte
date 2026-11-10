<script module lang="ts">
  /** The phone Chat's steer row: folded behind the composer's toggle until opened, remembered per
   *  device for every session view (local and on a connected machine). */
  const PHONE_STEERS_KEY = "shepherd-vp-phone-steers-open";

  export function readPhoneSteers(): boolean {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(PHONE_STEERS_KEY) === "1";
    } catch {
      return false;
    }
  }

  export function writePhoneSteers(open: boolean) {
    try {
      localStorage.setItem(PHONE_STEERS_KEY, open ? "1" : "0");
    } catch {
      /* localStorage unavailable (private mode) — the flag stays in-memory only */
    }
  }
</script>

<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // The phone Chat's steer toggle, at the composer field's leading edge.
  let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<!-- phone Chat: opens or folds the steer row under the conversation -->
<button
  type="button"
  class="vp-steer-toggle"
  aria-pressed={open}
  aria-label={open ? m.viewport_steers_hide_aria() : m.viewport_steers_show_aria()}
  title={open ? m.viewport_steers_hide_aria() : m.viewport_steers_show_aria()}
  onclick={() => (open = !open)}
>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linejoin="round"
    aria-hidden="true"><path d="M13 3 5 13h6l-1 8 8-10h-6z" /></svg
  >
</button>

<style>
  .vp-steer-toggle {
    flex: none;
    align-self: center;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-left: -6px;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    touch-action: manipulation;
  }
  .vp-steer-toggle svg {
    width: 16px;
    height: 16px;
  }
  .vp-steer-toggle[aria-pressed="true"] {
    color: var(--color-amber);
  }
  .vp-steer-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  @media (pointer: coarse) {
    .vp-steer-toggle {
      width: 44px;
      height: 44px;
    }
  }
</style>
