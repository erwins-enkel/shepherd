<script lang="ts">
  import { computePosition, flip, shift, offset, autoUpdate } from "@floating-ui/dom";
  import { coachTargets } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    targetId,
    titleKey,
    bodyKey,
    onseen,
    onclose,
  }: {
    targetId: string | null;
    titleKey: string;
    bodyKey: string;
    onseen: () => void;
    onclose: () => void;
  } = $props();

  let popEl = $state<HTMLElement | null>(null);

  // Floating UI lifecycle — runs whenever targetId or popEl changes.
  // Resolves the target from the registry, shows the popover, starts autoUpdate.
  // Cleanup tears down autoUpdate and hides the popover so session switches and
  // target changes never leak listeners or anchor against a detached node.
  $effect(() => {
    const target = targetId ? coachTargets.get(targetId) : null;

    // D5: target absent / detached — hide and bail silently.
    if (!target || !target.isConnected || !popEl) {
      try {
        popEl?.hidePopover();
      } catch {
        // InvalidStateError: popover not in DOM yet — ignore
      }
      return;
    }

    // Show the popover. Guard with try/catch: showPopover() throws InvalidStateError
    // if the element is not yet connected (can happen on the same tick as $effect run).
    try {
      popEl.showPopover();
    } catch {
      // Element not ready this tick — effect will re-run once popEl is connected.
      return;
    }

    // Start Floating UI autoUpdate. autoUpdate re-runs computePosition whenever the
    // reference or floating element moves, resizes, or the window scrolls/resizes.
    // It returns a cleanup function that removes all its internal listeners.
    const stopAutoUpdate = autoUpdate(target, popEl, () => {
      computePosition(target, popEl!, {
        placement: "bottom",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (popEl) {
          popEl.style.left = x + "px";
          popEl.style.top = y + "px";
        }
      });
    });

    // Return cleanup: tear down autoUpdate listeners AND hide the popover.
    // Called when targetId changes, popEl changes, or the component unmounts.
    return () => {
      stopAutoUpdate();
      try {
        popEl?.hidePopover();
      } catch {
        // Already hidden or detached — ignore
      }
    };
  });

  // Dismiss on Escape or pointer-down outside the popover.
  // Calls onclose() only — does NOT call onseen() (tap-outside is not a "seen" signal).
  // Listener shape mirrors GitRail.svelte:96-102.
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (popEl && !popEl.contains(e.target as Node)) onclose();
  }

  $effect(() => {
    // Defer listener attachment by one tick so the same tap that opened the
    // coachmark doesn't immediately close it (pointerdown timing race).
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onWindowKeydown);
      window.addEventListener("pointerdown", onWindowPointerdown);
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onWindowKeydown);
      window.removeEventListener("pointerdown", onWindowPointerdown);
    };
  });
</script>

<!-- popover="manual": native top-layer, escapes Viewport's swipe transform.
     position:fixed + inset:auto + margin:0 so Floating UI's left/top drive placement. -->
<div
  popover="manual"
  bind:this={popEl}
  class="coachmark"
  role="dialog"
  aria-label={(m as unknown as Record<string, () => string>)[titleKey]()}
>
  <p class="coachmark-title">{(m as unknown as Record<string, () => string>)[titleKey]()}</p>
  <p class="coachmark-body">{(m as unknown as Record<string, () => string>)[bodyKey]()}</p>
  <button class="coachmark-btn" onclick={onseen}>{m.coachmark_dismiss()}</button>
</div>

<style>
  /* Top-layer popover positioning: fixed + inset:auto + margin:0 lets
     Floating UI drive left/top without fighting browser default centering. */
  [popover].coachmark {
    position: fixed;
    inset: auto;
    margin: 0;

    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    width: min(280px, 90vw);

    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 4px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);

    /* Reset browser popover defaults */
    color: inherit;
    font: inherit;
  }

  .coachmark-title {
    margin: 0;
    font-size: var(--fs-meta);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text);
  }

  .coachmark-body {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-muted);
  }

  .coachmark-btn {
    align-self: flex-end;
    margin-top: 2px;
    padding: 3px 10px;
    font-size: var(--fs-meta);
    font-weight: 500;
    background: var(--color-accent, #5f6ad2);
    color: #fff;
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }

  .coachmark-btn:hover {
    opacity: 0.85;
  }

  /* Entrance slide-in. The global blanket in app.css already suppresses this with
     animation:none !important under prefers-reduced-motion — no extra rule needed. */
  @keyframes coachmark-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  [popover].coachmark:popover-open {
    animation: coachmark-in 140ms ease-out;
  }
</style>
