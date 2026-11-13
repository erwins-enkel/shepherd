<script lang="ts">
  import type { OriginCounts, SessionOrigin } from "#lib/session-origin.js";
  import { m } from "#lib/paraglide/messages.js";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

  // The herd's origin filter (#3999): who started a session — a repo schedule, the auto-drain
  // queue, or the operator. It only narrows the list; the lifecycle groups stay as they are.
  // The parent counts the rows the current lens and machine pick list, before the origin filter,
  // so every chip says what picking it would show.
  let {
    filter,
    counts,
    onfilter,
    touch = false,
    reveal = false,
    inPopover = false,
  }: {
    filter: SessionOrigin | null;
    counts: OriginCounts;
    onfilter: (origin: SessionOrigin | null) => void;
    /** Coarse pointer: 44px targets. */
    touch?: boolean;
    /** Phone pull-down reveal: slide in instead of popping in. */
    reveal?: boolean;
    /** Inside the top bar's origin popover: no divider under the row. */
    inPopover?: boolean;
  } = $props();

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const revealMs = $derived(reveal && !reduceMotion ? 180 : 0);

  const chips = $derived<{ id: SessionOrigin | null; label: string; count: number }[]>([
    {
      id: null,
      label: m.herd_origin_all(),
      count: counts.scheduled + counts.drain + counts.manual,
    },
    { id: "scheduled", label: m.herd_origin_scheduled(), count: counts.scheduled },
    { id: "drain", label: m.herd_origin_drain(), count: counts.drain },
    { id: "manual", label: m.herd_origin_manual(), count: counts.manual },
  ]);

  // picking the active chip again clears the filter
  const pick = (id: SessionOrigin | null) => onfilter(id === filter ? null : id);
</script>

<div
  class="origin-bar"
  class:touch-target={touch}
  class:in-popover={inPopover}
  role="group"
  aria-label={m.herd_origins_label()}
  in:slide={{ duration: revealMs, easing: cubicOut }}
>
  {#each chips as chip (chip.id ?? "all")}
    <button
      type="button"
      class="chip"
      class:on={filter === chip.id}
      aria-pressed={filter === chip.id}
      onclick={() => pick(chip.id)}
    >
      <span class="lb">{chip.label}</span>
      <span class="n">{chip.count}</span>
    </button>
  {/each}
</div>

<style>
  /* Same thin, wrapping row as the machine bar; the pressed chip takes the lens strip's active
     treatment (amber on the inset wash). */
  .origin-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .origin-bar.in-popover {
    border-bottom: none;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    padding: 3px 8px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: none;
    color: var(--color-muted);
    font-family: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .touch-target .chip {
    min-height: 44px;
  }
  .chip:hover {
    color: var(--color-ink);
  }
  .chip.on {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: var(--color-inset);
  }
  .chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .lb {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    flex: none;
    font-family: var(--font-mono);
  }
</style>
