<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import AutomationSettings from "./AutomationSettings.svelte";
  import type { Session, DrainStatus } from "$lib/types";

  let {
    repoPath,
    sessionId = undefined,
    planPhase = null,
    drain = null,
    onClose,
  }: {
    repoPath: string;
    /** Optional on repo-wide entry points that are not attached to a live task. */
    sessionId?: string;
    planPhase?: Session["planPhase"];
    /** Live drain status for this repo; passed from GitRail via the store.
     *  When drain.epicParent is set, label-drain is suspended by the active epic. */
    drain?: DrainStatus | null;
    /** Closes the panel (flips GitRail's showAutomation flag). Desktop still
     *  dismisses via click-outside/Escape, like every other non-modal popover
     *  here; the touch full-screen sheet has no "outside" left to tap, so it
     *  needs this explicit close button wired to the same state. */
    onClose: () => void;
  } = $props();

  // The popover is anchored to its trigger (top: 100% on the rail wrapper), so a
  // viewport-relative max-height alone can't keep the bottom on screen — how much
  // room exists depends on where the anchor sits. Measure the anchor and cap the
  // popover's height to the space actually available, so the internal scrollbar
  // engages and the last sections (e.g. Zuständigkeiten) stay reachable. When the
  // anchor sits so low that less than MIN_HEIGHT remains below, flip the popover
  // above the anchor instead of letting a sliver poke past the viewport edge.
  const MIN_HEIGHT = 160; // px — below this a scrollable popover stops being usable
  const EDGE_GAP = 12; // px breathing room to the viewport edge
  const ANCHOR_GAP = 4; // px offset from the anchor (matches the CSS margin)
  let popEl = $state<HTMLDivElement | null>(null);
  let flipUp = $state(false);
  $effect(() => {
    const el = popEl;
    if (!el) return;
    const clamp = () => {
      // Touch layouts render the panel as a full-screen fixed sheet (see the
      // pointer:coarse block in the stylesheet), where the anchor-relative height math
      // below is meaningless and the inline max-height would override the CSS.
      // Hand max-height back to the stylesheet and never flip on touch.
      if (window.matchMedia("(pointer: coarse)").matches) {
        el.style.maxHeight = "";
        flipUp = false;
        return;
      }
      // Measure the anchor (the positioning wrapper), not the popover itself —
      // the popover's own rect moves when we flip it, the anchor's doesn't.
      const anchor = el.offsetParent;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - ANCHOR_GAP - EDGE_GAP;
      const above = rect.top - ANCHOR_GAP - EDGE_GAP;
      flipUp = below < MIN_HEIGHT && above > below;
      el.style.maxHeight = `${Math.max(MIN_HEIGHT, flipUp ? above : below)}px`;
    };
    // rAF-throttle: the scroll listener is capture-phase on window, so it fires
    // for every scroll anywhere — coalesce to one layout read+write per frame.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clamp();
      });
    };
    clamp();
    window.addEventListener("resize", schedule);
    // capture-phase scroll: the anchor may live inside a scrollable container,
    // and scroll events don't bubble — recompute whenever anything scrolls.
    window.addEventListener("scroll", schedule, true);
    // The anchor can also shift without any scroll/resize — e.g. content above
    // it loading in and growing the wrapper. Watch the wrapper's size directly.
    const ro = new ResizeObserver(schedule);
    if (el.offsetParent) ro.observe(el.offsetParent);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      ro.disconnect();
    };
  });

  // On touch the panel becomes a full-screen fixed sheet over a dimming scrim
  // (see the pointer:coarse block in the stylesheet). Give it the same dialog
  // semantics as the sibling findings sheet (.review-pop) so keyboard/AT users get
  // parity: aria-modal, initial focus, a Tab focus-trap, and focus restoration.
  // On desktop it stays a non-modal anchored popover (no scrim), so none apply.
  let touch = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    touch = mq.matches;
    const onChange = () => (touch = mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  // Move focus into the sheet on open and restore it to the opener (the pill) when
  // the panel unmounts — touch only; on desktop the popover is non-modal.
  $effect(() => {
    if (!touch || !popEl) return;
    const opener = document.activeElement as HTMLElement | null;
    popEl.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  });

  // Minimal Tab focus-trap, mirroring GitRail's .review-pop trap. Focusables are
  // enumerated at trap time so dynamically-rendered rows are included; the panel
  // container itself (tabindex="-1") is excluded by the selector. The settings body
  // is a child component but renders in this same subtree, so its rows are found.
  function trapTab(e: KeyboardEvent) {
    if (!touch || e.key !== "Tab" || !popEl) return;
    const nodes = popEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === popEl) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || active === popEl) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<div
  class={["auto-pop", { "flip-up": flipUp }]}
  role="dialog"
  aria-modal={touch ? "true" : undefined}
  aria-label={m.automation_panel_title()}
  tabindex="-1"
  bind:this={popEl}
  onkeydown={trapTab}
>
  <!-- Close affordance: only visible in the touch full-screen sheet (CSS-gated
       below) — the desktop popover has no room/need for it, since it dismisses
       via click-outside/Escape. -->
  <div class="auto-pop-head">
    <button type="button" class="auto-close" onclick={onClose} aria-label={m.common_close()}>
      ✕
    </button>
  </div>
  <div class="auto-pop-body">
    <AutomationSettings {repoPath} {sessionId} {planPhase} {drain} armCoachmarks={true} />
  </div>
</div>

<style>
  /* anchored to the nearest positioned ancestor: GitRail's .git-rail-wrap
     (position: relative) on desktop, or the wider .vp-git-strip on mobile where
     that wrapper goes position:static (see GitRail's .git-rail-wrap.mobile). The
     flip/clamp effect re-measures offsetParent, so either anchor works — but this
     component must still be mounted inside one such positioned ancestor. */
  .auto-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    width: 320px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    /* long-form details can expand a row tall; keep the popover within the
       viewport and scroll instead of overflowing off-screen. The 85vh is only
       the pre-measure fallback — an effect clamps max-height to the space
       actually available below the anchored top edge. */
    max-height: 85vh;
    overflow-y: auto;
    /* overflow-y alone leaves overflow-x computed as "auto" too (per the CSS
       overflow spec, visible + non-visible on the other axis isn't renderable),
       so a row a hair wider than the box — a fixed-width select, a long
       nowrap label — made the ENTIRE panel horizontally pannable instead of
       just clipping. Pin it shut; .auto-pop-body takes over scrolling on touch. */
    overflow-x: hidden;
  }
  /* anchor too close to the viewport bottom → open upward instead */
  .auto-pop.flip-up {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 4px;
  }
  /* Hidden on desktop: the anchored popover dismisses via click-outside/Escape,
     like every other non-modal popover here, so it doesn't need its own head.
     Shown only in the touch full-screen sheet below, where there's no
     "outside" left to tap once the sheet covers the viewport. */
  .auto-pop-head {
    display: none;
    align-items: center;
    justify-content: flex-end;
    flex-shrink: 0;
  }
  .auto-close {
    min-width: 40px;
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .auto-close:hover {
    color: var(--color-amber);
  }
  /* Touch layouts (phones + unfolded folds): the strip goes position:static, so
     this absolute popover hangs below the 44px strip and — anchored right:8px and
     narrower than the page — could be panned partly off-screen. A centered card
     still left the rest of the app visible around its edges with no way to
     dismiss it short of guessing where "outside" was, so go fully edge-to-edge
     instead — matching every other mobile modal in the app (Settings, WhatsNew)
     — with an explicit close button since there's no backdrop sliver left to
     tap. .auto-scrim (rendered by GitRail) still dims what's behind while this
     mounts. The JS height-clamp bails on coarse pointers, so height is CSS-only
     here. */
  @media (pointer: coarse) {
    .auto-pop {
      position: fixed;
      inset: 0;
      margin: 0;
      width: auto;
      max-width: none;
      height: 100dvh;
      max-height: none;
      border: 0;
      border-radius: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 51;
    }
    .auto-pop-head {
      display: flex;
      padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 0 8px;
    }
    .auto-pop-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
</style>
