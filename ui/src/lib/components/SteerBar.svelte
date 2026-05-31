<script lang="ts">
  import { steers } from "$lib/steers.svelte";
  import { replySession } from "$lib/api";

  let { focusedId, onbroadcast }: { focusedId: string; onbroadcast: () => void } = $props();

  let flash = $state<string | null>(null);

  // pointerdown + preventDefault: fire instantly and never blur the terminal
  // (which would dismiss the mobile soft keyboard), matching ControlBar.
  function send(e: PointerEvent, text: string) {
    e.preventDefault();
    replySession(focusedId, text).catch(() => {
      flash = "send failed";
      setTimeout(() => (flash = null), 1500);
    });
  }
  function broadcast(e: PointerEvent) {
    e.preventDefault();
    onbroadcast();
  }
</script>

<div class="steer-bar" role="toolbar" aria-label="Saved steers">
  <button
    type="button"
    class="chip bc"
    onpointerdown={broadcast}
    aria-label="Broadcast a steer to multiple sessions">📡 Broadcast</button
  >
  {#each steers.list as s (s.id)}
    <button
      type="button"
      class="chip"
      title={s.text}
      aria-label={`Send steer: ${s.label}`}
      onpointerdown={(e) => send(e, s.text)}>{s.label}</button
    >
  {/each}
  {#if flash}<span class="flash">{flash}</span>{/if}
</div>

<style>
  .steer-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    overflow-x: auto;
    white-space: nowrap;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .steer-bar::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: 0 0 auto;
    height: 32px;
    padding: 0 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12.5px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .chip:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .chip.bc {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .flash {
    align-self: center;
    color: var(--color-red);
    font-size: 11px;
    padding-left: 6px;
  }
</style>
