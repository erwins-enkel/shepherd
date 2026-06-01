<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { controlKeys, type ControlKey } from "$lib/controlKeys";

  let { onkey }: { onkey: (seq: string) => void } = $props();

  // Chunk the flat, group-ordered key list into runs of the same group so each
  // run can render inside its own "well" (Gestalt common-region). Derived so it
  // re-chunks if the locale (and thus the labels) changes.
  const groups = $derived.by(() => {
    const out: ControlKey[][] = [];
    for (const k of controlKeys()) {
      const last = out.at(-1);
      if (last && last[0].group === k.group) last.push(k);
      else out.push([k]);
    }
    return out;
  });

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
  {#each groups as group (group[0].group)}
    <div class="group" role="group">
      {#each group as k (k.seq)}
        <button
          type="button"
          class="key"
          class:escape={k.tone === "escape"}
          class:danger={k.tone === "danger"}
          aria-label={k.aria}
          onpointerdown={down}
          onpointermove={move}
          onpointercancel={cancel}
          onpointerup={(e) => tap(e, k.seq)}>{k.label}</button
        >
      {/each}
    </div>
  {/each}
</div>

<style>
  .ctrl-bar {
    display: flex;
    /* wide gap between groups; keys *within* a group sit tight (see .group) so
       proximity tells which keys belong together */
    gap: 10px;
    padding: 6px 0 6px 10px;
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

  /* one "well" per group — faint common-region backing so the eye chunks
     Esc/Tab · arrows · ^-signals into three units instead of one long row */
  .group {
    display: flex;
    gap: 4px;
    flex: 0 0 auto;
    padding: 3px;
    background: color-mix(in srgb, var(--color-ink) 5%, transparent);
    border-radius: 7px;
  }

  .key {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 4px;
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

  /* Esc — the odd-one-out cancel key, marked with a calm distinct accent so it
     reads as "special" without screaming for attention */
  .key.escape {
    color: var(--color-blue);
    border-color: color-mix(in srgb, var(--color-blue) 55%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-blue) 12%, var(--color-inset));
  }
  .key.escape:active {
    background: color-mix(in srgb, var(--color-blue) 28%, var(--color-inset));
    border-color: var(--color-blue);
  }

  /* ^C — interrupts the running process; a caution tint so it isn't hit blind */
  .key.danger {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 50%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-red) 11%, var(--color-inset));
  }
  .key.danger:active {
    background: color-mix(in srgb, var(--color-red) 26%, var(--color-inset));
    border-color: var(--color-red);
  }
</style>
