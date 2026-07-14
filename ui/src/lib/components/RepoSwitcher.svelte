<script lang="ts">
  import { tick } from "svelte";
  import type { RepoChip } from "./queue-strip";
  import { getRepoWeb } from "$lib/api";
  import type { ForgeKind } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { basename } from "./learnings-drawer";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { chipRailVisible, chipHasTelemetry, pausedText } from "./queue-strip";
  import RepoChipTelemetry from "./repo-switcher/RepoChipTelemetry.svelte";
  import { longPress } from "./longpress";
  import AutomationPanel from "./AutomationPanel.svelte";

  let {
    chips,
    repoFilter,
    pinnedRepo = null,
    onrepofilter,
    onpinrepo = () => {},
    mobile = false,
  }: {
    chips: RepoChip[];
    // selected repo full paths; empty = showing every repo. Shift+click combines several.
    repoFilter: ReadonlySet<string>;
    // locally pinned repo, shown first when its live chip exists
    pinnedRepo?: string | null;
    // apply the herd filter for a repo; `additive` (Shift held) toggles it into the selection,
    // a plain click resets to just this repo (or clears it when already the sole selection)
    onrepofilter: (repoPath: string, additive: boolean) => void;
    // pin or unpin a repo in the switcher; null clears the pin
    onpinrepo?: (repoPath: string | null) => void;
    // true when rendered on a phone-sized viewport — suppresses the lone-repo
    // telemetry band (collapses into the selected-state subline instead)
    mobile?: boolean;
  } = $props();

  // ── render branch selection ────────────────────────────────────────────────
  const railVisible = $derived(chipRailVisible(chips, repoFilter));
  const shownChips = $derived.by(() => {
    if (!pinnedRepo) return chips;
    return [...chips].sort((a, b) => {
      const ap = a.repoPath === pinnedRepo;
      const bp = b.repoPath === pinnedRepo;
      if (ap !== bp) return ap ? -1 : 1;
      return 0;
    });
  });
  // Lone-repo telemetry: one repo with no active filter, carrying drain telemetry.
  // (When that lone repo IS the active filter, the rail shows instead — see railVisible.)
  const loneChip = $derived(chips.length === 1 && chipHasTelemetry(chips[0]) ? chips[0] : null);
  // The active chip whose detail line shows below the rail — only when exactly one repo is
  // selected and it has telemetry. A multi-selection shows no single-repo detail band.
  const activeChip = $derived(
    railVisible && repoFilter.size === 1
      ? (chips.find((c) => repoFilter.has(c.repoPath) && chipHasTelemetry(c)) ?? null)
      : null,
  );

  // ── paused-repo live announcements (derived from chips) ─────────────────────
  const pausedAnnounce = $derived(
    chips
      .filter((c) => c.drain?.paused)
      .map((c) =>
        m.repo_drain_paused_announce({
          repo: basename(c.repoPath),
          text: pausedText(c.drain!),
        }),
      )
      .join(" "),
  );

  // ── edge-fade scroll affordance ─────────────────────────────────────────────
  let scroller = $state<HTMLElement | null>(null);
  // inner track: width == scroll content width; observing it catches content-width
  // changes (rename/glyph/count digit) at a fixed chip count that the scroller's
  // own resize misses.
  let track = $state<HTMLElement | null>(null);
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function recomputeScroll() {
    const el = scroller;
    if (!el) {
      canScrollLeft = false;
      canScrollRight = false;
      return;
    }
    canScrollLeft = el.scrollLeft > 1;
    canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }

  // Recompute whenever the chip set changes (and on mount).
  $effect(() => {
    // referencing chips makes this effect re-run when the rail content changes
    void chips.length;
    recomputeScroll();
  });

  // Keep the fades honest as either the scroller (viewport / container width) OR
  // the inner track (content width — label/icon/count change at a fixed chip count)
  // resizes. One observer, both elements, disconnected on cleanup.
  $effect(() => {
    const el = scroller;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeScroll());
    ro.observe(el);
    if (track) ro.observe(track);
    return () => ro.disconnect();
  });

  // Translate a vertical wheel delta to horizontal scroll so a fine pointer can
  // pan the rail without a trackpad gesture.
  function onWheel(e: WheelEvent) {
    const el = scroller;
    if (!el || e.deltaY === 0) return;
    // only hijack when there is hidden horizontal content to reveal
    if (el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
    recomputeScroll();
  }

  function scrollRailToStart() {
    const el = scroller;
    if (!el) return;
    el.scrollLeft = 0;
    recomputeScroll();
  }

  // Pinning is a secondary action: click keeps filtering, while right-click,
  // touch long-press, or mouse/stylus hold opens this anchored menu.
  let menu = $state<{ chip: RepoChip; x: number; y: number; opener: HTMLElement } | null>(null);
  let menuRepoWeb = $state<{
    repoPath: string;
    slug: string | null;
    webUrl: string | null;
    kind: ForgeKind | null;
  } | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let menuPos = $state<{ left: number; top: number } | null>(null);
  // Automation stays in the shared panel, while this component owns the
  // chip-context-menu entry point and the selected repo's anchoring state.
  let automation = $state<{
    chip: RepoChip;
    left: number;
    top: number;
    opener: HTMLElement;
  } | null>(null);
  let automationAnchor = $state<HTMLDivElement | null>(null);

  function repoLabel(chip: RepoChip): string {
    return basename(chip.repoPath);
  }

  function chipAria(chip: RepoChip, active: boolean, pinned: boolean): string {
    const repo = repoLabel(chip);
    // With a multi-repo selection every selected chip is active, and a plain click collapses to
    // just this repo (not "show all") — so it needs a distinct label from the sole-selection one.
    const activeLabel =
      repoFilter.size > 1
        ? m.repo_filter_active_multi_aria({ repo })
        : m.repo_filter_active_aria({ repo });
    return [
      active ? activeLabel : m.repo_filter_apply_aria({ repo }),
      chip.insights > 0 || chip.curate > 0
        ? m.repo_chip_learnings_aria({ count: chip.insights > 0 ? chip.insights : chip.curate })
        : "",
      pinned ? m.repo_chip_pinned_aria() : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function openPinMenu(chip: RepoChip, x: number, y: number, opener: HTMLElement): boolean {
    menu = { chip, x, y, opener };
    menuRepoWeb = { repoPath: chip.repoPath, slug: null, webUrl: null, kind: null };
    menuPos = null;
    getRepoWeb(chip.repoPath)
      .then((r) => {
        if (menu?.chip.repoPath !== chip.repoPath) return;
        menuRepoWeb = { repoPath: chip.repoPath, ...r };
      })
      .catch(() => {
        if (menu?.chip.repoPath !== chip.repoPath) return;
        menuRepoWeb = { repoPath: chip.repoPath, slug: null, webUrl: null, kind: null };
      });
    return true;
  }

  function onContextMenu(e: MouseEvent, chip: RepoChip) {
    e.preventDefault();
    const opener = e.currentTarget as HTMLElement;
    const r = opener.getBoundingClientRect();
    const x = e.clientX === 0 && e.clientY === 0 ? r.left : e.clientX;
    const y = e.clientX === 0 && e.clientY === 0 ? r.bottom : e.clientY;
    openPinMenu(chip, x, y, opener);
  }

  const HOLD_MS = 500;
  const HOLD_SLOP = 10;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let holdPointerId: number | null = null;
  let holdStart: { x: number; y: number } | null = null;
  let holdFired = false;

  function clearHold() {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    holdPointerId = null;
    holdStart = null;
  }

  function onPointerDown(e: PointerEvent, chip: RepoChip) {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const opener = e.currentTarget as HTMLElement;
    holdFired = false;
    holdPointerId = e.pointerId;
    holdStart = { x: e.clientX, y: e.clientY };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!holdStart) return;
      const { x, y } = holdStart;
      holdFired = openPinMenu(chip, x, y, opener);
      clearHold();
    }, HOLD_MS);
  }

  function onPointerMove(e: PointerEvent) {
    if (holdPointerId !== e.pointerId || !holdStart) return;
    if (Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > HOLD_SLOP) clearHold();
  }

  function onPointerEnd(e: PointerEvent) {
    if (holdPointerId === e.pointerId) clearHold();
    if (holdFired) e.preventDefault();
  }

  function onChipClick(e: MouseEvent, chip: RepoChip) {
    if (holdFired) {
      holdFired = false;
      return;
    }
    // Shift (mouse or keyboard Enter/Space) → additively toggle this repo into the selection;
    // a plain click resets to just this repo (the page's nextRepoFilter handles the details).
    onrepofilter(chip.repoPath, e.shiftKey);
  }

  function closeMenu() {
    menu = null;
    menuRepoWeb = null;
    menuPos = null;
    holdFired = false;
  }

  async function commitPin() {
    if (!menu) return;
    onpinrepo(pinnedRepo === menu.chip.repoPath ? null : menu.chip.repoPath);
    closeMenu();
    scrollRailToStart();
    await tick();
    scrollRailToStart();
  }

  // Menu twin of Shift+click: additively toggle this repo in/out of the herd filter (same
  // onrepofilter path as onChipClick), then close. Reaches touch users who lack the Shift gesture.
  function commitFilter() {
    if (!menu) return;
    onrepofilter(menu.chip.repoPath, true);
    closeMenu();
  }

  function openAutomation() {
    if (!menu) return;
    // AutomationPanel is right-aligned to its positioned parent. Put that parent
    // on the click's right edge when there is room, otherwise let the panel open
    // back toward the viewport instead of overflowing past the right edge.
    const panelWidth = 320;
    const gap = 8;
    const opensRight = menu.x + panelWidth + gap <= window.innerWidth - gap;
    automation = {
      chip: menu.chip,
      left: opensRight ? menu.x + panelWidth + gap : menu.x,
      top: menu.y,
      opener: menu.opener,
    };
    closeMenu();
  }

  function closeAutomation() {
    const opener = automation?.opener;
    automation = null;
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
    });
  }

  $effect(() => () => clearHold());

  $effect(() => {
    const node = menuEl;
    const current = menu;
    if (!node || !current) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(current.x, window.innerWidth - r.width - margin);
    const top = Math.min(current.y, window.innerHeight - r.height - margin);
    menuPos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    node.querySelector<HTMLElement>(".rs-menu-item")?.focus();
  });

  $effect(() => {
    const current = menu;
    if (!current) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeMenu();
        return;
      }
      // Roving focus across the menu items (they are tabindex="-1", so Arrow/Home/End — not Tab —
      // move between them). preventDefault so these keys don't scroll the page instead.
      if (!menuEl) return;
      const items = [...menuEl.querySelectorAll<HTMLElement>(".rs-menu-item")];
      if (items.length === 0) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
      else if (e.key === "ArrowUp")
        next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      if (next >= 0) {
        e.preventDefault();
        items[next]?.focus();
      }
    }
    function onPointer(e: Event) {
      if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      const opener = current.opener;
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", closeMenu, true);
      queueMicrotask(() => {
        if (opener?.isConnected && document.activeElement === document.body) opener.focus();
      });
    };
  });

  $effect(() => {
    const current = automation;
    if (!current) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") closeAutomation();
    }
    function onPointer(e: Event) {
      if (automationAnchor && !automationAnchor.contains(e.target as Node)) closeAutomation();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", closeAutomation, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", closeAutomation, true);
    };
  });
</script>

{#if railVisible}
  <div class="rs" role="group" aria-label={m.repo_switcher_label()}>
    <div
      class="rs-scroller"
      class:fade-left={canScrollLeft}
      class:fade-right={canScrollRight}
      bind:this={scroller}
      onscroll={recomputeScroll}
      onwheel={onWheel}
    >
      <!-- inner track: its width == the scroll content width, so a ResizeObserver
           on it catches label/icon/count content-width changes at a fixed chip
           count (which the scroller's own resize does not). -->
      <div class="rs-track" bind:this={track}>
        {#each shownChips as chip (chip.repoPath)}
          {@const active = repoFilter.has(chip.repoPath)}
          {@const pinned = pinnedRepo === chip.repoPath}
          <button
            type="button"
            class="rs-chip"
            class:active
            class:pinned
            aria-pressed={active}
            aria-label={chipAria(chip, active, pinned)}
            oncontextmenu={(e) => onContextMenu(e, chip)}
            onpointerdown={(e) => onPointerDown(e, chip)}
            onpointermove={onPointerMove}
            onpointerup={onPointerEnd}
            onpointercancel={onPointerEnd}
            use:longPress={{
              ms: HOLD_MS,
              onTrigger: (x, y) =>
                openPinMenu(
                  chip,
                  x,
                  y,
                  (document.elementFromPoint(x, y)?.closest(".rs-chip") as HTMLElement | null) ??
                    scroller ??
                    document.body,
                ),
            }}
            onclick={(e) => onChipClick(e, chip)}
          >
            <span class="rs-glyph" aria-hidden="true"
              >{projectIcons.iconFor(chip.repoPath) ?? "▣"}</span
            >
            <span class="rs-name">{repoLabel(chip)}</span>
            {#if pinned}
              <span class="rs-pin-mark" aria-hidden="true">⌖</span>
            {/if}
            <span class="rs-count">{chip.count}</span>
            {#if chip.drain?.paused}
              <span class="rs-paused-dot" aria-hidden="true">●</span>
            {/if}
            {#if chip.insights > 0 || chip.curate > 0}
              <!-- decorative ✦ mark: this repo has pending learnings/curate. Shown on every
                   chip including the active one — open the learnings drawer via the gear menu. -->
              <span class="rs-learn-mark" title={m.learnings_badge_tip()} aria-hidden="true"
                >✦{#if chip.insights > 0}<span class="rs-learn-n">{chip.insights}</span>{/if}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    </div>

    {#if activeChip}
      {#key activeChip.repoPath}
        <RepoChipTelemetry chip={activeChip} />
      {/key}
    {/if}
  </div>
{:else if loneChip && !mobile}
  <div class="rs">
    <RepoChipTelemetry chip={loneChip} />
  </div>
{/if}

{#if menu}
  {@const menuPinned = pinnedRepo === menu.chip.repoPath}
  {@const menuFiltered = repoFilter.has(menu.chip.repoPath)}
  <div
    bind:this={menuEl}
    class="rs-menu"
    role="menu"
    tabindex="-1"
    aria-label={m.repo_chip_menu_label({ repo: repoLabel(menu.chip) })}
    style="left:{menuPos?.left ?? menu.x}px;top:{menuPos?.top ?? menu.y}px"
  >
    <button class="rs-menu-item" type="button" role="menuitem" tabindex="-1" onclick={commitPin}>
      <span class="rs-menu-icon" aria-hidden="true">{menuPinned ? "⌫" : "⌖"}</span>{menuPinned
        ? m.repo_chip_unpin()
        : m.repo_chip_pin()}
    </button>
    <button class="rs-menu-item" type="button" role="menuitem" tabindex="-1" onclick={openAutomation}>
      <span class="rs-menu-icon" aria-hidden="true">⚙</span>{m.repo_chip_automation_settings()}
    </button>
    {#if menuRepoWeb?.repoPath === menu.chip.repoPath && menuRepoWeb.kind === "github" && menuRepoWeb.webUrl}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL, not an app route -->
      <a
        class="rs-menu-item"
        role="menuitem"
        tabindex="-1"
        href={menuRepoWeb.webUrl}
        target="_blank"
        rel="noopener"
        onclick={() => closeMenu()}
      >
        <span class="rs-menu-icon" aria-hidden="true">↗</span>{m.repo_chip_open_github()}
      </a>
    {/if}
    <button class="rs-menu-item" type="button" role="menuitem" tabindex="-1" onclick={commitFilter}>
      <span class="rs-menu-icon" aria-hidden="true">{menuFiltered ? "⊖" : "⊕"}</span>{menuFiltered
        ? m.repo_chip_remove_filter()
        : m.repo_chip_add_filter()}
    </button>
  </div>
{/if}

{#if automation}
  <!-- The shared panel becomes a blocking sheet only on coarse pointers; its
       desktop form remains the same anchored, non-modal popover as the rail. -->
  <div class="rs-auto-scrim scrim" aria-hidden="true"></div>
  <div
    class="rs-auto-anchor"
    bind:this={automationAnchor}
    style="left:{automation.left}px;top:{automation.top}px"
  >
    <AutomationPanel repoPath={automation.chip.repoPath} drain={automation.chip.drain} onClose={closeAutomation} />
  </div>
{/if}

<!-- live region: paused-repo announcements (always present, visually hidden) -->
<div class="rs-live" role="status" aria-live="polite">{pausedAnnounce}</div>

<style>
  .rs {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    font-family: var(--font-mono);
    /* don't span the parent column — shrink-wrap to the rail content */
    align-self: flex-start;
    max-width: 100%;
    min-width: 0;
  }

  /* the horizontal, single-line scroller of filter chips (overflow viewport) */
  .rs-scroller {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    /* a fixed single-line height so the rail never wraps */
    padding: 2px 0;
    scrollbar-width: none;
    /* peek cue: the visible at-rest peek comes from the .rs-track's trailing
       padding-right plus the narrow right-edge fade, which together guarantee the
       next chip's leading edge protrudes into view. scroll-padding-right keeps
       keyboard-focus scrollIntoView clear of the faded edge. */
    scroll-padding-right: 20px;
  }
  .rs-scroller::-webkit-scrollbar {
    display: none;
  }
  /* inner track: lays out the chips in one line; its width == scroll content width
     (observed for content-width edge-fade recompute). */
  .rs-track {
    display: flex;
    align-items: stretch;
    gap: 4px;
    width: fit-content;
    white-space: nowrap;
    /* trailing padding: ensures the right-most chip is never fully hidden behind
       the fade — it protrudes into the padding, giving the eye a real partial chip
       (the peek) even at scroll position 0. */
    padding-right: 20px;
  }
  /* tonal edge-fade affordance: fade whichever edge hides content. No colored
     element — a mask over the scroller's own pixels.
     Right fade is intentionally narrower (12px vs 24px left) so the partial
     chip behind it still reads as a chip — the fade is a secondary cue, the
     peeking chip shape is the primary one. */
  .rs-scroller.fade-left {
    mask-image: linear-gradient(to right, transparent 0, #000 24px);
  }
  .rs-scroller.fade-right {
    mask-image: linear-gradient(to left, transparent 0, #000 12px);
  }
  .rs-scroller.fade-left.fade-right {
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 24px,
      #000 calc(100% - 12px),
      transparent 100%
    );
  }

  /* one filter chip = one tap target */
  .rs-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    background: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .rs-chip:hover,
  .rs-chip:focus-visible {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  /* active filter: amber text + amber border carry the selection (no underline) */
  .rs-chip.active {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .rs-chip.pinned:not(.active) {
    border-color: var(--color-line-bright);
  }
  /* the repo glyph is identity, not status — keep it on the ink ramp, never a
     status hue (Four-Light Rule). */
  .rs-glyph {
    color: var(--color-ink);
    text-transform: none;
  }
  .rs-name {
    color: inherit;
  }
  .rs-count {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .rs-pin-mark {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  .rs-chip.active .rs-count {
    color: var(--color-amber);
  }
  /* small red marker that this repo's drain is paused (announced via live region) */
  .rs-paused-dot {
    color: var(--color-red);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  /* display-only ✦ marker: this repo has pending learnings/curate (the actionable
     ✦ button lives on the detail line). Decorative, on the faint/ink ramp — NOT a
     status hue (Four-Light Rule); ✦ is not amber/green/red/slate. */
  .rs-learn-mark {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  .rs-learn-n {
    font-variant-numeric: tabular-nums;
  }

  /* visually-hidden live region (no .sr-only util in app.css) */
  .rs-live {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .rs-menu {
    position: fixed;
    z-index: 60;
    min-width: 150px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--color-bg) 60%, transparent);
    display: flex;
    flex-direction: column;
  }
  .rs-menu:focus {
    outline: none;
  }
  .rs-menu-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }
  .rs-menu-item:hover,
  .rs-menu-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .rs-menu-icon {
    width: 1em;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-align: center;
    flex-shrink: 0;
  }

  /* A zero-size fixed anchor lets AutomationPanel keep its established desktop
     positioning and viewport clamp while this context menu supplies the origin. */
  .rs-auto-anchor {
    position: fixed;
    z-index: 60;
    width: 0;
    height: 0;
  }
  /* Desktop is a non-modal anchored popover. On touch, AutomationPanel becomes
     a full-screen blocking sheet and this shared scrim supplies the required
     dim + blur backdrop. */
  .rs-auto-scrim {
    display: none;
  }

  /* Coarse pointers: ≥44px tap targets on the chips (mirrors the QueueStrip /
     TopBar coarse-pointer pattern). */
  @media (pointer: coarse) {
    .rs-chip {
      min-height: 44px;
      min-width: 44px;
      justify-content: center;
    }
    /* The menu is reached via long-press on touch, so its items are tap targets too. */
    .rs-menu-item {
      min-height: 44px;
    }
    .rs-auto-scrim {
      display: block;
      z-index: 50;
    }
  }
</style>
