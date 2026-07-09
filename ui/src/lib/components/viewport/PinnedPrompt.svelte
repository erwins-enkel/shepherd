<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { PromptPin, ResolvedPin } from "$lib/promptPins";

  // Keeps the operator's own question visible above the terminal while they read
  // (or scroll back through) the agent's answer to it. Prompts are located in the
  // terminal's committed scrollback — see promptPins.ts for why that is the only
  // durable trace a prompt leaves in a raw-PTY viewport.
  //
  // The bar is in-flow above the terminal, not overlaid: .term-mount reserves its
  // height via --pinned-prompt-h so the strip can never cover agent output. The
  // expanded list, by contrast, is a small anchored, NON-modal popover (it does
  // not seize the app) so it takes no scrim — see the Modal & scrim recipe on
  // /design-system for that exemption.
  let {
    pins,
    resolved,
    onjump,
    height = $bindable(0),
  }: {
    pins: PromptPin[];
    resolved: ResolvedPin;
    /** Scroll the terminal to a prompt's echo line. */
    onjump: (line: number) => void;
    /** Occupied height, published so .term-mount can reserve it. */
    height?: number;
  } = $props();

  let barEl = $state<HTMLElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);
  let open = $state(false);

  // A prompt list with nothing in it has nothing to expand.
  $effect(() => {
    if (pins.length === 0) open = false;
  });

  // Non-modal popover: dismiss on Escape or a click outside, per the anchored-popover
  // exemption. Focus stays where the operator put it.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        open = false;
        (barEl?.querySelector("button") as HTMLElement | null)?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popEl?.contains(t) && !barEl?.contains(t)) open = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  });

  // Newest first: the question you just asked is the one you look for.
  const listed = $derived([...pins].reverse());

  function jump(line: number) {
    onjump(line);
    open = false;
  }
</script>

<!-- Only the collapsed bar reserves terminal rows (the popover floats over them), and
     its height is *observed* rather than derived: it also moves with --ui-scale and
     with a (pointer: coarse) flip, neither of which changes any prop. -->
<div class="pp-bar" bind:this={barEl} bind:offsetHeight={height}>
  <button
    type="button"
    class="pp-main"
    disabled={pins.length === 0}
    aria-expanded={open}
    aria-haspopup="dialog"
    onclick={() => (open = !open)}
  >
    <span class="pp-label" aria-hidden="true">{m.pinned_prompt_label()}</span>
    {#if resolved.uncertain}
      <span class="pp-text pp-quiet">{m.pinned_prompt_unknown()}</span>
    {:else if resolved.pin}
      <span class="pp-text">{resolved.pin.text}</span>
    {:else}
      <span class="pp-text pp-quiet">{m.pinned_prompt_none()}</span>
    {/if}
    {#if pins.length > 1}
      <span class="pp-count">{pins.length}</span>
    {/if}
    <span class="pp-chevron" class:open aria-hidden="true">⌃</span>
  </button>
</div>

{#if open}
  <div
    class="pp-pop"
    bind:this={popEl}
    role="dialog"
    aria-label={m.pinned_prompt_history_title()}
    style:top={`${height}px`}
  >
    <p class="pp-pop-head">{m.pinned_prompt_history_title()}</p>
    <ul class="pp-list">
      {#each listed as pin (pin.line)}
        <li>
          <button
            type="button"
            class="pp-item"
            class:current={resolved.pin?.line === pin.line}
            onclick={() => jump(pin.line)}
          >
            <span class="pp-item-mark" aria-hidden="true">❯</span>
            <span class="pp-item-text">{pin.text}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  /* In-flow strip: .term-mount shrinks by --pinned-prompt-h (published on .vp-body)
     so the terminal reflows BELOW this bar rather than being covered by it. */
  .pp-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }

  .pp-main {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    background: none;
    border: none;
    color: var(--color-text);
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .pp-main:disabled {
    cursor: default;
  }
  .pp-main:hover:not(:disabled) {
    background: var(--color-panel-2);
  }

  .pp-label {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .pp-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pp-quiet {
    color: var(--color-faint);
    font-style: italic;
  }

  .pp-count {
    flex: none;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--color-inset);
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }

  .pp-chevron {
    flex: none;
    color: var(--color-faint);
    transition: transform 0.12s ease;
  }
  .pp-chevron.open {
    transform: rotate(180deg);
  }

  /* Small anchored, non-modal popover (role="dialog", NOT aria-modal): it does not
     seize the app, so it carries no scrim/blur and dismisses on outside-click/Esc. */
  .pp-pop {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 3;
    max-height: min(50%, 320px);
    overflow-y: auto;
    background: var(--color-panel);
    border-bottom: 1px solid var(--color-line);
    box-shadow: var(--shadow-pop);
  }

  .pp-pop-head {
    margin: 0;
    padding: 8px 10px 4px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .pp-list {
    margin: 0;
    padding: 0 0 4px;
    list-style: none;
  }

  .pp-item {
    display: flex;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    color: var(--color-text);
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .pp-item:hover,
  .pp-item:focus-visible {
    background: var(--color-panel-2);
  }
  .pp-item.current {
    background: var(--color-inset);
  }

  .pp-item-mark {
    flex: none;
    color: var(--color-faint);
  }

  /* Two lines, then ellipsis — enough to tell two long questions apart. */
  .pp-item-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  /* Touch tap-target floor (44px) applies where fingers do; a mouse pointer has no
     such floor, and on desktop the extra rows would come straight out of the
     terminal's visible output. */
  @media (pointer: coarse) {
    .pp-main,
    .pp-item {
      min-height: 44px;
    }
  }
</style>
