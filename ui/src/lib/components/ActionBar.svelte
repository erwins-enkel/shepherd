<script lang="ts">
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { m } from "$lib/paraglide/messages";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import { REPO, REPO_URL, sha, version, commitUrl } from "$lib/build-info";
  import HerdSegRow from "$lib/components/herd/HerdSegRow.svelte";
  import type { HerdFilter } from "$lib/components/herd-partition";

  // Two explicit theme choices; "system" stays the implicit default (followed on
  // first load + on OS changes until the operator picks one). The old third slot
  // (the "system" option) is repurposed as the standalone high-contrast / WCAG toggle below.
  const THEMES: {
    pref: Exclude<ThemePref, "system">;
    icon: "moon" | "sun";
    label: () => string;
  }[] = [
    { pref: "dark", icon: "moon", label: m.theme_dark },
    { pref: "light", icon: "sun", label: m.theme_light },
  ];

  let {
    onnew,
    onbacklog,
    mobile = false,
    desktopOnly = false,
    lens = false,
    // Read and written via `bind:filter` on <HerdSegRow> below. Prettier collapses that to the
    // shorthand, which fallow's prop analysis does not follow — hence the suppression.
    // fallow-ignore-next-line unused-component-props
    filter = $bindable<HerdFilter>("next"),
    statusFilter = null,
    onstatusfilter,
  }: {
    onnew: () => void;
    onbacklog?: () => void;
    mobile?: boolean;
    desktopOnly?: boolean;
    /** Turns on this bar's upper rank: the herd lens segments (D10, docs/design/mobile-herd),
     *  so every control the operator taps sits in the thumb zone. Set only by the phone list
     *  screen; the default keeps the segments off every other mount of this bar. */
    lens?: boolean;
    /** Bound by the phone list screen when `lens` is on. The default is inert: with `lens` false
     *  the segments never render, so nothing reads or writes it. */
    filter?: HerdFilter;
    statusFilter?: "running" | "idle" | "blocked" | null;
    onstatusfilter?: (status: "running" | "idle" | "blocked" | null) => void;
  } = $props();

  // The lens rank renders only where it belongs: the phone list screen.
  const showLens = $derived(mobile && lens);
</script>

<!-- The two actions are snippets so the phone and the desktop can order them differently
     WITHOUT a visual order that contradicts the DOM: the phone puts "New task" last, in the
     thumb corner, and the desktop leads with it. A CSS `order` would have split focus order
     from reading order on one of the two. -->
{#snippet newTaskBtn()}
  <button
    class="btn primary"
    class:tip={!mobile}
    type="button"
    onclick={onnew}
    aria-label={mobile ? m.actionbar_new_task() : undefined}
    data-tip={!mobile ? m.actionbar_shortcut_hint({ key: "N" }) : undefined}
    aria-keyshortcuts={!mobile ? "n" : undefined}
  >
    {#if mobile}
      <!-- Drawn plus: the phone label is the bare verb, so the glyph carries the "+" the
           desktop label spells out. Decorative — the full label rides on aria-label above. -->
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="square"
        aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg
      >{m.actionbar_new_task_short()}
    {:else}
      {m.actionbar_new_task()}
    {/if}
  </button>
{/snippet}

{#snippet backlogBtn()}
  <button
    class="btn backlog"
    class:tip={!mobile}
    type="button"
    onclick={onbacklog}
    data-tip={!mobile ? m.actionbar_shortcut_hint({ key: "R" }) : undefined}
    aria-keyshortcuts={!mobile ? "r" : undefined}>{m.actionbar_backlog()}</button
  >
{/snippet}

{#if !(desktopOnly && mobile)}
  <div class="actions" class:mobile>
    <div class="rank">
      {#if showLens}
        <!-- The herd lens. Lives here rather than atop the list (D10) — it is the most-tapped
             control on the screen and belongs within thumb reach — and shares this single rank
             with REPOS and "New task". -->
        <HerdSegRow bind:filter placement="bottom" {statusFilter} {onstatusfilter} />
      {/if}
      {#if mobile}
        {#if onbacklog}{@render backlogBtn()}{/if}
        {@render newTaskBtn()}
      {:else}
        {@render newTaskBtn()}
        {#if onbacklog}{@render backlogBtn()}{/if}
      {/if}
    </div>
    {#if !mobile}
      <div class="meta">
        <a
          class="repo"
          href={REPO_URL}
          target="_blank"
          rel="external noreferrer noopener"
          title={m.actionbar_repo_link({ repo: REPO })}
          aria-label={m.actionbar_repo_link({ repo: REPO })}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
        <span class="dot">·</span>
        <span class="version">v{version}</span>
        <span class="dot">·</span>
        <a
          class="sha"
          href={commitUrl}
          target="_blank"
          rel="external noreferrer noopener"
          title={m.actionbar_commit_title({ sha })}>{sha}</a
        >
        <div class="theme-seg" role="group" aria-label={m.actionbar_theme_group_aria()}>
          {#each THEMES as t (t.pref)}
            <button
              type="button"
              class="t-opt"
              class:on={theme.resolved === t.pref}
              aria-pressed={theme.resolved === t.pref}
              title={m.actionbar_theme_option({ label: t.label() })}
              aria-label={m.actionbar_theme_option({ label: t.label() })}
              onclick={() => theme.setPref(t.pref)}><ThemeIcon icon={t.icon} /></button
            >
          {/each}
        </div>
        <button
          type="button"
          class="contrast-toggle"
          class:on={theme.contrast}
          aria-pressed={theme.contrast}
          title={m.actionbar_contrast_toggle()}
          aria-label={m.actionbar_contrast_toggle()}
          onclick={() => theme.toggleContrast()}><ThemeIcon icon="contrast" /></button
        >
        <LanguageSwitcher />
      </div>
    {/if}
  </div>
{/if}

<style>
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    border: var(--actionbar-border) solid var(--color-line);
    background: var(--color-panel);
    padding: 10px 14px;
  }
  .btn {
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    padding: 7px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    background: transparent;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .btn:hover {
    background: var(--color-hover);
  }
  .btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* primary carries a resting amber glow — keep it under the focus ring */
  .btn.primary:focus-visible {
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 18px -10px var(--color-amber);
  }
  .meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
  }
  .repo,
  .sha {
    color: var(--color-muted);
    text-decoration: none;
  }
  .repo {
    display: inline-flex;
    align-items: center;
  }
  .version {
    color: var(--color-muted);
  }
  .sha {
    color: var(--color-ink);
  }
  .repo:hover,
  .sha:hover {
    color: var(--color-amber);
  }
  .dot {
    color: var(--color-faint);
  }
  .theme-seg {
    display: flex;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    overflow: hidden;
  }
  .t-opt {
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1;
    padding: 4px 8px;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt:hover {
    color: var(--color-ink-bright);
  }
  /* seg group clips overflow, so an inset ring would be cropped — use the
     brightened-hairline outline instead */
  .t-opt:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
  }
  /* High-contrast (WCAG) toggle — standalone so screen readers don't read it as
     part of the theme radio group; styled to match the .t-opt seg buttons. */
  .contrast-toggle {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1;
    padding: 4px 8px;
    cursor: pointer;
  }
  .contrast-toggle:hover {
    color: var(--color-ink-bright);
  }
  .contrast-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .contrast-toggle.on {
    color: var(--color-amber);
    background: var(--color-inset);
    border-color: var(--color-amber);
  }
  /* Mobile list document-scrolls. position:fixed pins the bar to the viewport
     bottom unconditionally — sticky failed here because its containing block
     (.main-region) doesn't span the full overflowing herd height, so the bar
     came unstuck and scrolled away on long lists. The list reserves matching
     padding-bottom (see .shell.mobile.list) so no row hides behind the bar.
     Side + bottom insets clear the gesture-nav / landscape-notch safe areas. */
  /* ONE rank on the phone: the lens segments, REPOS and "New task" side by side.
     --mobile-actionbar-h in app.css encodes exactly this geometry (hit + top pad + the single
     top border) and the list reserves it as padding-bottom, so the two cannot drift apart.

     A TOP HAIRLINE ONLY — no side or bottom border. The bar IS the bottom edge of the screen;
     a box around it read as a slab lying over the screen, and its bottom border cut the panel
     off above the home-indicator zone instead of letting the ground run into it. */
  .actions.mobile {
    flex-direction: row;
    align-items: stretch;
    gap: 0;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    border: 0;
    border-top: var(--actionbar-border) solid var(--color-line);
    padding: var(--mobile-actionbar-pad) 0 0;
    padding-left: max(var(--mobile-actionbar-pad), env(safe-area-inset-left));
    padding-right: max(var(--mobile-actionbar-pad), env(safe-area-inset-right));
    padding-bottom: max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom));
  }
  .rank {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .actions:not(.mobile) .rank {
    display: contents;
  }
  /* The phone rank: hairlines separate its slots, nothing inside it is boxed. The lens group
     takes the free width (see HerdSegRow), the two actions stay at their intrinsic size. */
  .actions.mobile .rank {
    flex: 1;
    min-width: 0;
    gap: 0;
    align-items: stretch;
  }
  .actions.mobile .btn {
    border: 0;
    border-left: 1px solid var(--color-line);
    border-radius: 0;
    background: none;
    box-shadow: none;
    min-height: var(--mobile-actionbar-hit);
    font-size: var(--fs-meta);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }
  .actions.mobile .btn.primary {
    color: var(--color-amber);
    padding: 0 15px;
  }
  .actions.mobile .btn.backlog {
    color: var(--color-ink);
    padding: 0 13px;
  }
  /* The primary's resting glow is desktop-only; on the phone every slot is flat. That `box-shadow:
     none` above outranks .btn:focus-visible (0,3,0 vs 0,2,0), which also kills the outline — so
     the focus ring has to be restored HERE, for BOTH actions. Narrowing this to .primary left
     REPOS with no visible focus at all (WCAG 2.4.7), on a bar any keyboard user reaches by
     narrowing the window. */
  .actions.mobile .btn:focus-visible {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Below a 360px viewport the three lens labels get tight: at 320px the row has ~190px to split
     three ways once the actions take their width, and DE "Nächstes" — the longest label — needs
     ~59px of it. MEASURED, not estimated: at the shipped desktop padding each lens fell to 59.2px
     and truncated by a pixel. Buying ~15px back from the actions leaves ~64px per lens, and the
     two actions still measure ~53px wide — well clear of the 44px floor the touch sweep holds. */
  @media (max-width: 360px) {
    .actions.mobile .btn {
      gap: 6px;
    }
    .actions.mobile .btn.primary {
      padding: 0 6px;
    }
    .actions.mobile .btn.backlog {
      padding: 0 6px;
    }
  }

  /* Desktop-only hover tooltip surfacing the keyboard shortcut. Mirrors the
     TopBar .tip styling, but opens ABOVE the button since the ActionBar sits at
     the bottom edge (a tooltip below would clip off-screen). Never shown on
     touch/mobile, where the shortcut doesn't apply. */
  @media (hover: hover) and (pointer: fine) {
    .tip {
      position: relative;
    }
    .tip::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 9px);
      left: 0;
      white-space: nowrap;
      background: var(--color-panel);
      border: 1px solid var(--color-line-bright);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      color: var(--color-ink-bright);
      font-size: var(--fs-meta);
      letter-spacing: 0.06em;
      text-transform: none;
      padding: 5px 9px;
      border-radius: 2px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(3px);
      transition:
        opacity 0.12s ease,
        transform 0.12s ease;
      z-index: 50;
    }
    .tip:hover::after,
    .tip:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
