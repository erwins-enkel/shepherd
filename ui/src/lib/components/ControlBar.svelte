<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { controlKeys } from "$lib/controlKeys";

  let { onkey }: { onkey: (seq: string) => void } = $props();

  // Tap-vs-drag: the bar scrolls horizontally (overflow-x), so a finger that
  // lands on a key and drags to scroll must NOT fire it. Arm on pointerdown,
  // disarm once the pointer moves past a small slop (it's a scroll) or when the
  // browser takes the gesture over for scrolling (pointercancel), and only act
  // on a clean tap at pointerup. preventDefault on the *up* — not the down —
  // suppresses the synthetic click so the key never blurs the terminal (which
  // would dismiss the mobile soft keyboard), while leaving native horizontal
  // scrolling intact. Mirrors SteerBar.
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
  function tap(e: PointerEvent, seq: string) {
    if (armedId !== e.pointerId) return;
    armedId = null;
    e.preventDefault();
    onkey(seq);
  }
</script>

<div class="ctrl-bar" role="toolbar" aria-label={m.controlbar_toolbar_aria()}>
  {#each controlKeys() as k (k.seq)}
    <button
      type="button"
      class="key"
      aria-label={k.aria}
      onpointerdown={down}
      onpointermove={move}
      onpointercancel={cancel}
      onpointerup={(e) => tap(e, k.seq)}>{k.label}</button
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
    min-width: 42px;
    height: 40px;
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
