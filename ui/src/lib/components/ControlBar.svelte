<script lang="ts">
  import { CONTROL_KEYS } from "$lib/controlKeys";

  let { onkey }: { onkey: (seq: string) => void } = $props();

  // pointerdown + preventDefault: fire instantly and never blur the terminal
  // (which would dismiss the mobile soft keyboard).
  function tap(e: PointerEvent, seq: string) {
    e.preventDefault();
    onkey(seq);
  }
</script>

<div class="ctrl-bar" role="toolbar" aria-label="Terminal control keys">
  {#each CONTROL_KEYS as k (k.label)}
    <button type="button" class="key" aria-label={k.aria} onpointerdown={(e) => tap(e, k.seq)}
      >{k.label}</button
    >
  {/each}
</div>

<style>
  .ctrl-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    overflow-x: auto;
    white-space: nowrap;
    /* take remaining row width and allow shrink-to-fit so the internal
       overflow-x scroll engages instead of widening the whole row */
    flex: 1 1 0;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .ctrl-bar::-webkit-scrollbar {
    display: none;
  }

  .key {
    flex: 0 0 auto;
    min-width: 40px;
    height: 36px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 14px;
    letter-spacing: 0.04em;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }

  .key:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
</style>
