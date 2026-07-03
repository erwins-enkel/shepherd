<script lang="ts">
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { ciBannerState } from "$lib/ci-banner";

  // Non-blocking "CI is running" signal: a bottom strip over the terminal, above
  // the steer bar — the SAME spot as ReviewInFlightBanner, so status/automation
  // info always lands in one consistent place. Leads with the rotating gear ("CI
  // is running — hold off on merge/actions") and names the in-flight checks, with
  // the PR number linking to the PR's checks on the forge. Suppresses itself while
  // the review banner claims the strip (reviewActive) so only one ever shows.
  let {
    git,
    tab,
    reviewActive,
    height = $bindable(0),
  }: {
    git: GitState | null | undefined;
    tab: string;
    reviewActive: boolean;
    height?: number;
  } = $props();

  const view = $derived(ciBannerState({ git, reviewActive }));

  // Join the running checks with ", " (a comma, not " · ", so it doesn't clash
  // with the "/" inside a qualified "<workflow> / <job>" name).
  const namesText = $derived(view.show ? view.names.join(", ") : "");

  // Publish occupied height so the floating jump-to-latest button lifts clear of
  // this strip, mirroring ReviewInFlightBanner. Seeded pre-paint via the bound
  // element; bind:offsetHeight below keeps it current across reflows.
  let bannerEl = $state<HTMLDivElement>();
  $effect(() => {
    const shown = view.show && tab === "term";
    if (!shown) {
      height = 0;
      return;
    }
    if (bannerEl) height = bannerEl.offsetHeight;
  });
</script>

{#if view.show && tab === "term"}
  <div
    class="ci-banner"
    role="status"
    aria-live="polite"
    bind:this={bannerEl}
    bind:offsetHeight={height}
  >
    <!-- Rotating cog: inline SVG (not the ⚙ glyph, which renders as a color emoji
         ignoring currentColor and turns off-center) so it tints to the accent and
         spins cleanly about its center. Mirrors ReviewInFlightBanner's .rb-cog. -->
    <svg
      class="cb-cog"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      />
    </svg>
    <span class="cb-text">
      {namesText ? m.cibanner_running_named({ checks: namesText }) : m.cibanner_running_bare()}
      {#if view.number != null}
        <span class="cb-sep" aria-hidden="true"> · </span>
        {#if view.url}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
          <a class="cb-link" href={view.url} target="_blank" rel="noopener"
            >{m.cibanner_pr({ number: view.number })}</a
          >
        {:else}
          <span class="cb-link-plain">{m.cibanner_pr({ number: view.number })}</span>
        {/if}
      {/if}
    </span>
  </div>
{/if}

<style>
  /* Bottom overlay strip pinned to the terminal body, directly above the steer
     bar — mirrors ReviewInFlightBanner. Absolutely positioned so it never triggers
     an xterm refit. Non-blocking: no scrim/blur (it does not seize interaction). */
  .ci-banner {
    --accent: var(
      --color-amber
    ); /* amber = "CI running" (matches the herd CI head + pending dot) */
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    font-size: var(--fs-base);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--color-head));
    border-top: 1px solid color-mix(in srgb, var(--accent) 55%, var(--color-line));
    animation: cb-in 0.14s ease;
  }
  /* Rotating gear — the "CI is still running" cue. Reuses the shared icon-btn-spin
     keyframe (app.css), NOT the .spin class, whose reduced-motion rule
     (animation:none) would drop this status signal. */
  .cb-cog {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: var(--accent);
    animation: icon-btn-spin 2.4s linear infinite;
  }
  /* Functional indicator: under reduced-motion keep the rotation (it's what reads
     as "still running") but slow it right down. Needs the full shorthand +
     !important to beat app.css's global `* { animation: none !important }`. */
  @media (prefers-reduced-motion: reduce) {
    .cb-cog {
      animation: icon-btn-spin 6s linear infinite !important;
    }
  }
  .cb-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink-bright);
  }
  .cb-sep {
    color: var(--color-faint);
  }
  .cb-link,
  .cb-link-plain {
    color: var(--accent);
  }
  .cb-link {
    text-decoration: underline;
  }
  .cb-link:hover {
    color: var(--color-ink-bright);
  }
  @keyframes cb-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
