<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { UpdateStatus, DiagnosticState } from "$lib/types";
  import GearRow from "./GearRow.svelte";

  // Attention rows (diagnostics / updates / What's-New), shared by the mobile sheet and
  // the desktop gear popover — the latter shows them only when a narrow fold folds the
  // top-bar badges away. Each row closes the menu, then fires its action.
  let {
    mobile = false,
    diagnosticsOverall,
    updateAvailable,
    update,
    herdrUpdateAvailable,
    codexUpdateAvailable,
    whatsNew,
    closeMenu,
    ondiagnose,
    onupdate,
    onherdrupdate,
    oncodexupdate,
    onwhatsnew,
  }: {
    mobile?: boolean;
    diagnosticsOverall: DiagnosticState;
    updateAvailable: boolean;
    update: UpdateStatus | null;
    herdrUpdateAvailable: boolean;
    codexUpdateAvailable: boolean;
    whatsNew: boolean;
    closeMenu: () => void;
    ondiagnose: (() => void) | undefined;
    onupdate: (() => void) | undefined;
    onherdrupdate: (() => void) | undefined;
    oncodexupdate: (() => void) | undefined;
    onwhatsnew: (() => void) | undefined;
  } = $props();

  function closeAnd(action: (() => void) | undefined): () => void {
    return () => {
      closeMenu();
      action?.();
    };
  }
</script>

<!-- Conditional: the rows keep their amber-alert accents, grouped between the gauge
     and the workspace rows. -->
{#if diagnosticsOverall !== "ok" || updateAvailable || herdrUpdateAvailable || codexUpdateAvailable || whatsNew}
  <div class="grp" class:mobile>
    {#if diagnosticsOverall !== "ok"}
      <GearRow
        {mobile}
        warm={diagnosticsOverall === "error"}
        glyph={diagnosticsOverall === "error" ? "✕" : "⚠"}
        label={m.diagnostics_pip_label()}
        onclick={closeAnd(ondiagnose)}
      />
    {/if}
    {#if updateAvailable}
      <GearRow
        {mobile}
        warm
        label={`${m.topbar_update_badge()} · ${update!.behind}`}
        onclick={closeAnd(onupdate)}
      >
        {#snippet glyphIcon()}
          <svg
            class="glyph-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
          </svg>
        {/snippet}
      </GearRow>
    {/if}
    {#if herdrUpdateAvailable}
      <GearRow
        {mobile}
        warm
        label={m.topbar_herdr_update_badge()}
        onclick={closeAnd(onherdrupdate)}
      >
        {#snippet glyphIcon()}
          <svg
            class="glyph-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        {/snippet}
      </GearRow>
    {/if}
    {#if codexUpdateAvailable}
      <GearRow
        {mobile}
        warm
        label={m.topbar_codex_update_badge()}
        onclick={closeAnd(oncodexupdate)}
      >
        {#snippet glyphIcon()}
          <svg
            class="glyph-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 15 6-6 6 6" />
            <path d="m6 9 6-6 6 6" />
          </svg>
        {/snippet}
      </GearRow>
    {/if}
    {#if whatsNew}
      <GearRow
        {mobile}
        glyph="●"
        label={m.whatsnew_open()}
        ariaLabel={m.whatsnew_topbar_aria()}
        onclick={closeAnd(onwhatsnew)}
      />
    {/if}
  </div>
{/if}

<style>
  .grp {
    padding: 4px 0;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  /* SVG glyphs: sized here (snippet content carries this component's scope, not
     GearRow's), aligned to the 20px glyph column. */
  .glyph-svg {
    width: 20px;
    height: var(--fs-lg);
    flex-shrink: 0;
    display: block;
  }
  /* Desktop popover: 16px glyph column, base type. */
  .grp:not(.mobile) .glyph-svg {
    width: 16px;
    height: var(--fs-base);
  }
</style>
