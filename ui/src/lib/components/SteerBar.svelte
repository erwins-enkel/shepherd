<script lang="ts">
  import { steers } from "$lib/steers.svelte";
  import { replySession } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let { focusedId, onbroadcast }: { focusedId: string; onbroadcast: () => void } = $props();

  let flash = $state<string | null>(null);

  // Tap-vs-drag: the bar scrolls horizontally (overflow-x), so a finger that
  // lands on a chip and drags to scroll must NOT fire it. Arm on pointerdown,
  // disarm once the pointer moves past a small slop (it's a scroll) or when the
  // browser takes the gesture over for scrolling (pointercancel), and only act
  // on a clean tap at pointerup. preventDefault on the *up* — not the down —
  // suppresses the synthetic click so the chip never blurs the terminal (which
  // would dismiss the mobile soft keyboard), while leaving native horizontal
  // scrolling intact.
  const TAP_SLOP = 10;
  let armedId: number | null = null;
  let startX = 0;
  let startY = 0;

  function down(e: PointerEvent) {
    armedId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (armedId !== e.pointerId) return;
    if (Math.abs(e.clientX - startX) > TAP_SLOP || Math.abs(e.clientY - startY) > TAP_SLOP) {
      armedId = null;
    }
  }
  function cancel(e: PointerEvent) {
    if (armedId === e.pointerId) armedId = null;
  }
  function tap(e: PointerEvent, action: () => void) {
    if (armedId !== e.pointerId) return;
    armedId = null;
    e.preventDefault();
    action();
  }

  function send(text: string) {
    replySession(focusedId, text).catch(() => {
      flash = m.steerbar_send_failed();
      setTimeout(() => (flash = null), 1500);
    });
  }
</script>

<div class="steer-bar" role="toolbar" aria-label={m.steerbar_toolbar_aria()}>
  <button
    type="button"
    class="chip bc"
    onpointerdown={down}
    onpointermove={move}
    onpointercancel={cancel}
    onpointerup={(e) => tap(e, onbroadcast)}
    aria-label={m.steerbar_broadcast_aria()}
    >📡<span class="bc-label">{m.steerbar_broadcast()}</span></button
  >
  {#each steers.list as s (s.id)}
    <button
      type="button"
      class="chip"
      title={s.text}
      aria-label={m.steerbar_send_aria({ label: s.label })}
      onpointerdown={down}
      onpointermove={move}
      onpointercancel={cancel}
      onpointerup={(e) => tap(e, () => send(s.text))}>{s.label}</button
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
    height: 38px;
    padding: 0 14px;
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
  .bc-label {
    margin-left: 6px;
  }
  /* on mobile the broadcast chip collapses to just its 📡 icon to reclaim space */
  @media (max-width: 768px) {
    .chip.bc {
      padding: 0 12px;
    }
    .bc-label {
      display: none;
    }
  }
  .flash {
    align-self: center;
    color: var(--color-red);
    font-size: 11px;
    padding-left: 6px;
  }
</style>
