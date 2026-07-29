<script lang="ts">
  // One hold-to-reveal keycap. Reads its whole content from the registry row —
  // never pass a key label in: that's the second list this feature exists to
  // prevent. See $lib/keymap/newTask.ts.
  //
  // Layout contract (the reason this is not an overlay): a keycap sits IN the
  // control's own flow and REPLACES a mute glyph that was already there — a ▾
  // chevron, an ON/OFF readout. Same line height, same slot, different content,
  // so nothing shifts when the reveal comes and goes. `absolute` is the
  // exception for icon-only buttons (↥, 🎙) that have no text slot to give up.

  import { chordLabel } from "$lib/keymap/chord";
  import { revealIn, revealOut } from "$lib/keymap/motion";
  import { keymapEntry } from "$lib/keymap/newTask";
  import type { NewTaskKeymapCtx } from "$lib/keymap/types";

  let {
    id,
    ctx,
    absolute = false,
    tight = false,
    flash = false,
  }: {
    /** Registry row id. */
    id: string;
    ctx: NewTaskKeymapCtx;
    /** Pin to the top-right of a `position:relative` icon button. */
    absolute?: boolean;
    /** 9px variant for the tightest rows (the mode segment). */
    tight?: boolean;
    /** Briefly lit because this control was just triggered. */
    flash?: boolean;
  } = $props();

  const entry = $derived(keymapEntry(id));
  const isMac = $derived(ctx.isMac);
  const label = $derived(
    entry.literal?.(isMac) ?? entry.chords.map((c) => chordLabel(c, isMac)).join(" "),
  );
  // A shortcut that can't fire right now is drawn muted, NOT hidden: the whole
  // point is teaching that it exists, and a keycap that comes and goes with
  // state would teach the opposite.
  const muted = $derived(!entry.enabled(ctx));
  // Word-style modifiers (Strg+Umschalt+A) need more room than glyphs (⇧⌘A).
  const wide = $derived(!isMac && entry.chords.length > 0);
</script>

<!-- aria-hidden: decorative. The semantic source is aria-keyshortcuts on the
     control itself, which is present whether or not the reveal is showing. -->
<span
  class="cap"
  class:absolute
  class:tight
  class:wide
  class:muted
  class:flash
  data-keymap={id}
  in:revealIn
  out:revealOut
  aria-hidden="true">{label}</span
>

<style>
  .cap {
    /* z-index lifts the cap over the reveal scrim (z-index 1) that dims the
       body behind it. position:relative is what makes that z-index apply. */
    position: relative;
    z-index: 2;
    display: inline-block;
    flex-shrink: 0;
    border: 1px solid var(--color-amber);
    background: var(--cap-bg);
    border-radius: 2px;
    padding: 0 4px;
    font-size: var(--fs-micro);
    line-height: 1.4;
    color: var(--color-amber);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    /* Enter/exit are owned by the in:/out: transitions (exact spec timings, see
       $lib/keymap/motion.ts). Only the trigger flash transitions in place. */
    transition: background-color 120ms cubic-bezier(0.2, 0.8, 0.3, 1);
  }

  /* Icon buttons (↥, 🎙) have no text slot to hand over, so their cap is pinned
     to the corner instead. The button itself must be position:relative, and
     needs left margin so two adjacent caps never touch — see .toolbar. */
  .cap.absolute {
    position: absolute;
    top: -9px;
    right: -12px;
  }

  .cap.tight {
    padding: 0 3px;
    font-size: calc(9px * var(--ui-scale));
  }

  .cap.wide {
    padding: 0 5px;
    font-size: calc(9px * var(--ui-scale));
  }

  .cap.muted {
    border-color: var(--color-faint);
    background: var(--color-inset);
    color: var(--color-faint);
    opacity: 0.5;
  }

  /* One 120 ms pulse when its chord fires while the reveal is up. */
  .cap.flash {
    background: color-mix(in srgb, var(--color-amber) 22%, var(--cap-bg));
  }

  /* Reduced motion: appear and disappear instantly, fully functional. */
  @media (prefers-reduced-motion: reduce) {
    .cap {
      transition: none;
    }
  }
</style>
