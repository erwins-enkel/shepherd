<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // The session console's keyboard-affordance footer, shared by the Viewport and the detail of a
  // session on a connected machine. The caller decides when it shows (true desktop only).
  let {
    showEnter,
  }: {
    /** Enter only hands focus back on the terminal tab, so it is advertised only there. */
    showEnter: boolean;
  } = $props();

  // platform-correct modifier for the "force local selection" hint: xterm uses
  // Shift on Linux/Windows, Option (⌥) on macOS while the agent holds the mouse.
  // Guarded for SSR (no navigator) → renders the Shift glyph, corrects on hydrate.
  const isMac = $derived(
    typeof navigator !== "undefined" &&
      /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent),
  );
</script>

<div class="vp-foot">
  <span>{m.viewport_type_steer_hint()}</span>
  <span class="sep">·</span>
  <span>{m.viewport_detach_hint()}</span>
  <span class="sep">·</span>
  <span
    class="hint-help"
    title={m.viewport_select_hint_title({ key: isMac ? "Option (⌥)" : "Shift (⇧)" })}
  >
    {m.viewport_select_hint({ key: isMac ? "⌥" : "⇧" })}
  </span>
  <span class="sep">·</span>
  <span>{m.viewport_keynav_hint()}</span>
  <span class="sep">·</span>
  <span>{m.viewport_commandbar_hint({ key: isMac ? "⌘K" : "Ctrl+K" })}</span>
  {#if showEnter}
    <span class="sep">·</span>
    <span>{m.viewport_keynav_enter_hint()}</span>
  {/if}
</div>

<style>
  .vp-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .sep {
    color: var(--color-faint);
  }
  .hint-help {
    cursor: help;
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
  }
</style>
