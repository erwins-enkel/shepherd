<script lang="ts">
  import type { Gauge, GaugeKey } from "../usage-gauges";
  import type {
    CreditWindow,
    ModelWeekWindow,
    UpdateStatus,
    DiagnosticState,
    UsageProviderSnapshot,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import LimitGaugeRow from "./LimitGaugeRow.svelte";
  import ModelWeekGauge from "../usage/ModelWeekGauge.svelte";
  import { codexGaugeList } from "../usage-gauges";
  import { formatTokenLabel } from "$lib/format";
  import { REPO_URL, DOCS_URL, version } from "$lib/build-info";
  import type { FeedbackKind } from "$lib/feedback-link";
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";

  // Quick theme controls surfaced directly in the gear menu on mobile — the desktop
  // ActionBar carries these, but on phone it hides them, leaving Settings → Device the
  // only home. Mirrors the ActionBar's compact recipe: two explicit choices (dark/light;
  // "system" stays the implicit default), keyed on the resolved value.
  const QUICK_THEMES: {
    pref: Exclude<ThemePref, "system">;
    icon: "moon" | "sun";
    label: () => string;
  }[] = [
    { pref: "dark", icon: "moon", label: m.theme_dark },
    { pref: "light", icon: "sun", label: m.theme_light },
  ];

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  let {
    gauges,
    perModel,
    credits,
    codexUsage,
    subscriptionOnly,
    stale,
    diagnosticsOverall,
    updateAvailable,
    update,
    herdrUpdateAvailable,
    codexUpdateAvailable,
    whatsNew,
    learningsPresent,
    learnings,
    learningsCurate,
    learningsLabel,
    learningsCount,
    haltable,
    armed,
    nowMs,
    creditFill,
    creditColor,
    creditAmount,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
    closeMenu,
    clickHalt,
    chooseSettings,
    chooseUsage,
    ondiagnose,
    onupdate,
    onherdrupdate,
    oncodexupdate,
    onwhatsnew,
    onlearnings,
    onFeedback,
    pluginItems = [],
    onPluginItem,
  }: {
    gauges: Gauge[];
    perModel: ModelWeekWindow[];
    credits: CreditWindow | null;
    codexUsage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
    subscriptionOnly: boolean;
    stale: boolean;
    diagnosticsOverall: DiagnosticState;
    updateAvailable: boolean;
    update: UpdateStatus | null;
    herdrUpdateAvailable: boolean;
    codexUpdateAvailable: boolean;
    whatsNew: boolean;
    learningsPresent: boolean;
    learnings: number;
    learningsCurate: number;
    learningsLabel: string;
    learningsCount: number;
    haltable: number;
    armed: boolean;
    nowMs: number;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
    closeMenu: () => void;
    clickHalt: () => void;
    chooseSettings: () => void;
    chooseUsage: () => void;
    ondiagnose: (() => void) | undefined;
    onupdate: (() => void) | undefined;
    onherdrupdate: (() => void) | undefined;
    oncodexupdate: (() => void) | undefined;
    onwhatsnew: (() => void) | undefined;
    onlearnings: (() => void) | undefined;
    onFeedback: (kind: FeedbackKind) => void;
    pluginItems?: { id: string; label: string; icon?: string }[];
    onPluginItem?: (id: string) => void;
  } = $props();

  // Codex's own 5h/weekly rate-limit windows as Claude-style gauges, so both CLIs read alike.
  // Empty when Shepherd cannot find a rate-limit event in Codex rollouts.
  const codexWindows = $derived(codexGaugeList(codexUsage));
  // Claude vs Codex are distinct providers with their own labelled sections.
  const hasClaude = $derived(gauges.length > 0 || perModel.length > 0 || !!credits);
</script>

<!-- Blur backdrop behind the opened mobile bottom sheet, so the panel reads as the focus
     and the herd recedes. Rendered outside .gear-wrap so outside-click detection fires on it.
     onclick also wires close explicitly to complement the window-level handler.
     The portal wrapper re-parents both children to <body> so position:fixed resolves
     against the viewport, not the will-change:transform chrome header. The wrapper itself
     is display:contents with no transform/filter/will-change so it establishes no
     containing block of its own. -->
<div class="gear-sheet-portal" use:portal>
  <div class="menu-scrim scrim" aria-hidden="true" onclick={() => closeMenu()}></div>
  <!-- Mobile bottom sheet: slides up from the bottom of the screen. role=dialog + use:dialog
       provides focus-trap + Esc→closeMenu + focus-restore. Children are plain buttons/links,
       NOT role="menuitem" (that role is invalid inside a dialog). -->
  <div
    class="gear-sheet"
    role="dialog"
    aria-modal="true"
    aria-label={m.topbar_sheet_title()}
    use:dialog={{ onclose: closeMenu }}
    transition:fly={{ y: 520, duration: reduceMotion ? 0 : 220, opacity: 1 }}
  >
    <!-- Grab handle + title row -->
    <div class="sheet-handle-row" aria-hidden="true">
      <div class="sheet-handle"></div>
    </div>
    <div class="sheet-title-row">
      <span class="sheet-title micro">{m.topbar_sheet_title()}</span>
      <button
        type="button"
        class="sheet-close"
        onclick={() => closeMenu()}
        aria-label={m.common_close()}>✕</button
      >
    </div>

    <!-- Quick appearance: dark/light theme + high-contrast toggle -->
    <div class="quick">
      <div class="theme-seg" role="group" aria-label={m.actionbar_theme_group_aria()}>
        {#each QUICK_THEMES as t (t.pref)}
          <button
            type="button"
            class="t-opt"
            class:on={theme.resolved === t.pref}
            aria-pressed={theme.resolved === t.pref}
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
        aria-label={m.actionbar_contrast_toggle()}
        onclick={() => theme.toggleContrast()}><ThemeIcon icon="contrast" /></button
      >
    </div>
    <div class="sheet-sep"></div>

    <!-- Usage section: full gauge breakdown (mirrors the touch popover content) -->
    {#if gauges.length || perModel.length || credits || subscriptionOnly || codexUsage}
      {#if subscriptionOnly && !codexUsage}
        <div class="sheet-section-label micro">
          {m.topbar_usage_provider_title({ provider: m.agent_provider_claude() })}
        </div>
        <div class="sheet-row-text micro">{m.usage_subscription_only()}</div>
      {:else}
        {#if hasClaude}
          <div class="sheet-section-label micro">
            {m.topbar_usage_provider_title({ provider: m.agent_provider_claude() })}
          </div>
          <div class="sheet-gauges {stale ? 'stale' : ''}">
            {#each gauges as g (g.label)}
              <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
            {/each}
            {#each perModel as entry (entry.model)}
              <div class="sheet-model-row">
                <ModelWeekGauge {entry} {nowMs} />
              </div>
            {/each}
            <CreditDetail {credits} {creditFill} {creditColor} {creditAmount} {nowMs} />
            <!-- Section-level refresh (not inside the credits block) so it survives credits being
                 hidden — a dead/absent credits panel must not take the only refresh control with it. -->
            <div class="sheet-refresh">
              <button
                type="button"
                class="usage-refresh micro"
                disabled={refreshing}
                aria-busy={refreshing}
                onclick={onRefresh}
              >
                {refreshing ? m.common_loading() : m.topbar_usage_refresh()}
              </button>
              {#if refreshError}
                <span class="usage-refresh-error micro" role="alert">{m.common_retry()}</span>
              {/if}
            </div>
          </div>
        {/if}
        {#if codexUsage}
          <div class="sheet-section-label micro">
            {m.topbar_usage_provider_title({ provider: m.agent_provider_codex() })}
          </div>
          <div class="sheet-gauges {codexUsage.stale ? 'stale' : ''}">
            {#each codexWindows as g (g.label)}
              <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
            {/each}
            {#if codexWindows.length === 0}
              <div class="limits-unavailable micro">{m.topbar_codex_limits_unavailable()}</div>
            {/if}
            <div class="token-line">
              <span>{m.topbar_tokens_window({ period: "5H" })}</span>
              <span>{formatTokenLabel(codexUsage.session5hTokens)}</span>
            </div>
            <div class="token-line">
              <span>{m.topbar_tokens_window({ period: "WK" })}</span>
              <span>{formatTokenLabel(codexUsage.weekTokens)}</span>
            </div>
            <div class="token-line">
              <span>{m.topbar_tokens_total()}</span>
              <span>{formatTokenLabel(codexUsage.totalTokens)}</span>
            </div>
          </div>
        {/if}
      {/if}
      <button
        type="button"
        class="sheet-item"
        aria-haspopup="dialog"
        onclick={() => {
          chooseUsage();
          closeMenu();
        }}
      >
        <span class="sheet-glyph" aria-hidden="true">▦</span>
        <span class="sheet-label">{m.topbar_usage_link()}</span>
      </button>
      <div class="sheet-sep"></div>
    {/if}

    <!-- Diagnose row: only when health is not ok -->
    {#if diagnosticsOverall !== "ok"}
      <button
        type="button"
        class="sheet-item"
        class:alert={diagnosticsOverall === "error"}
        onclick={() => {
          closeMenu();
          ondiagnose?.();
        }}
        aria-label={m.diagnostics_pip_label()}
      >
        <span class="sheet-glyph" aria-hidden="true"
          >{diagnosticsOverall === "error" ? "✕" : "⚠"}</span
        >
        <span class="sheet-label">{m.diagnostics_pip_label()}</span>
      </button>
    {/if}

    <!-- Update row: when shepherd update is available -->
    {#if updateAvailable}
      <button
        type="button"
        class="sheet-item sheet-update"
        onclick={() => {
          closeMenu();
          onupdate?.();
        }}
        aria-label={m.topbar_update_badge()}
      >
        <svg
          class="sheet-glyph sheet-svg"
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
        <span class="sheet-label">{m.topbar_update_badge()} · {update!.behind}</span>
      </button>
    {/if}

    <!-- Herdr update row: when herdr update is available -->
    {#if herdrUpdateAvailable}
      <button
        type="button"
        class="sheet-item sheet-update"
        onclick={() => {
          closeMenu();
          onherdrupdate?.();
        }}
        aria-label={m.topbar_herdr_update_badge()}
      >
        <svg
          class="sheet-glyph sheet-svg"
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
        <span class="sheet-label">{m.topbar_herdr_update_badge()}</span>
      </button>
    {/if}

    <!-- Codex update row: when a newer @openai/codex is published -->
    {#if codexUpdateAvailable}
      <button
        type="button"
        class="sheet-item sheet-update"
        onclick={() => {
          closeMenu();
          oncodexupdate?.();
        }}
        aria-label={m.topbar_codex_update_badge()}
      >
        <svg
          class="sheet-glyph sheet-svg"
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
        <span class="sheet-label">{m.topbar_codex_update_badge()}</span>
      </button>
    {/if}

    <!-- What's New row -->
    {#if whatsNew}
      <button
        type="button"
        class="sheet-item"
        onclick={() => {
          closeMenu();
          onwhatsnew?.();
        }}
        aria-label={m.whatsnew_topbar_aria()}
      >
        <span class="sheet-glyph" aria-hidden="true">●</span>
        <span class="sheet-label">{m.whatsnew_open()}</span>
      </button>
    {/if}

    <!-- Learnings row: review proposed house rules across all repos -->
    {#if learningsPresent}
      <button
        type="button"
        class="sheet-item"
        onclick={() => {
          closeMenu();
          onlearnings?.();
        }}
        aria-label={learnings > 0
          ? m.learnings_open_aria({ count: learnings })
          : m.learnings_open_curate_aria({ count: learningsCurate })}
      >
        <span class="sheet-glyph" aria-hidden="true">✦</span>
        <span class="sheet-label">{learningsLabel} · {learningsCount}</span>
      </button>
    {/if}

    <div class="sheet-sep"></div>

    <!-- Halt e-stop: two-step arm→confirm, same as desktop -->
    {#if haltable > 0}
      <button
        class="sheet-item halt-item"
        class:armed
        type="button"
        onclick={clickHalt}
        aria-label={armed
          ? m.halt_arm_aria({ count: haltable })
          : m.halt_all_aria({ count: haltable })}
      >
        <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 2 H16 L22 8 V16 L16 22 H8 L2 16 V8 Z" fill="currentColor" />
        </svg>
        <span class="sheet-label"
          >{armed ? m.halt_arm({ count: haltable }) : m.halt_menu_item({ count: haltable })}</span
        >
      </button>
      <div class="sheet-sep"></div>
    {/if}

    <!-- Settings -->
    <button type="button" class="sheet-item" onclick={chooseSettings}>
      <span class="sheet-glyph" aria-hidden="true">⚙</span>
      <span class="sheet-label">{m.settings_title()}</span>
    </button>
    <div class="sheet-sep"></div>

    <!-- Plugin items: verbatim plugin-authored label/icon (not i18n) -->
    {#if pluginItems.length > 0}
      {#each pluginItems as item (item.id)}
        <button
          type="button"
          class="sheet-item"
          onclick={() => {
            closeMenu();
            onPluginItem?.(item.id);
          }}
        >
          {#if item.icon}<span class="sheet-glyph" aria-hidden="true">{item.icon}</span>{/if}
          <span class="sheet-label">{item.label}</span>
        </button>
      {/each}
      <div class="sheet-sep"></div>
    {/if}

    <!-- Feedback -->
    <button type="button" class="sheet-item" onclick={() => onFeedback("bug")}>
      <span class="sheet-glyph" aria-hidden="true">🐛</span>
      <span class="sheet-label">{m.feedback_dialog_title_bug()}</span>
    </button>
    <button type="button" class="sheet-item" onclick={() => onFeedback("feature")}>
      <span class="sheet-glyph" aria-hidden="true">✨</span>
      <span class="sheet-label">{m.feedback_dialog_title_feature()}</span>
    </button>
    <button type="button" class="sheet-item" onclick={() => onFeedback("feedback")}>
      <span class="sheet-glyph" aria-hidden="true">💬</span>
      <span class="sheet-label">{m.feedback_dialog_title_feedback()}</span>
    </button>

    <!-- Docs + version footer -->
    <div class="sheet-sep"></div>
    <!-- Hosted documentation site (docs.shepherd.run) — distinct from the GitHub README below. -->
    <a
      class="sheet-item"
      href={DOCS_URL}
      target="_blank"
      rel="external noreferrer noopener"
      onclick={() => closeMenu()}
    >
      <span class="sheet-glyph" aria-hidden="true">↗</span>
      <span class="sheet-label">{m.topbar_docs()}</span>
    </a>
    <a
      class="sheet-item"
      href={REPO_URL}
      target="_blank"
      rel="external noreferrer noopener"
      onclick={() => closeMenu()}
    >
      <span class="sheet-glyph" aria-hidden="true">↗</span>
      <span class="sheet-label">{m.topbar_menu_docs()}</span>
    </a>
    <div class="sheet-foot micro">v{version}</div>
  </div>
</div>

<style>
  /* Portal wrapper: re-parents scrim + sheet to <body> so position:fixed resolves
     against the viewport, not the will-change:transform chrome header (see portal.ts).
     display:contents collapses the wrapper in the layout — it establishes NO containing
     block of its own (no transform, filter, will-change, or contain). */
  .gear-sheet-portal {
    display: contents;
  }
  /* Scrim: sits below the mobile bottom sheet (z 49) but above app content.
     Uses the canonical .scrim primitive (dim + blur) from app.css. */
  .menu-scrim {
    z-index: 49;
  }

  /* Mobile bottom sheet: slides up from the bottom. Fixed to left/right/bottom edges,
     tall enough to hold all sections without viewport overflow. The sheet itself is
     opaque panel chrome — the .scrim behind it dims+blurs the herd content. */
  .gear-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 10px 10px 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px 12px;
    /* safe-area bottom for notched phones */
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    max-height: 90dvh;
    overflow-y: auto;
  }
  .sheet-handle-row {
    display: flex;
    justify-content: center;
    padding: 10px 0 4px;
  }
  .sheet-handle {
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--color-line-bright);
  }
  .sheet-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 4px 6px;
  }
  .sheet-title {
    color: var(--color-muted);
  }
  .sheet-close {
    background: none;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    min-width: 44px;
    min-height: 44px;
    font-size: var(--fs-lg);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sheet-sep {
    height: 1px;
    margin: 5px 4px;
    background: var(--color-line);
  }
  .sheet-section-label {
    padding: 6px 8px 2px;
    color: var(--color-muted);
  }
  .sheet-row-text {
    padding: 6px 8px;
    color: var(--color-muted);
  }
  /* Full gauge breakdown in the sheet — one row per window, wider bars. */
  .sheet-gauges {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 8px 4px;
  }
  .sheet-gauges.stale {
    opacity: 0.5;
  }
  /* Section-level refresh control (see markup note). */
  .sheet-refresh {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
  }
  .usage-refresh {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-transform: none;
    letter-spacing: 0.04em;
    padding: 6px 11px;
    cursor: pointer;
  }
  .usage-refresh:hover:not(:disabled) {
    background: var(--color-inset);
  }
  .usage-refresh:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .usage-refresh-error {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-red);
  }
  .sheet-model-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
  }
  .limits-unavailable {
    padding: 6px 0;
    border-top: 1px solid var(--color-line);
    border-bottom: 1px solid var(--color-line);
    color: var(--color-faint);
    letter-spacing: 0.08em;
    line-height: 1.35;
  }
  .token-line {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }
  .token-line span:first-child {
    color: var(--color-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  /* Sheet action rows: ≥44px targets, token-driven, no role=menuitem (invalid in dialog). */
  .sheet-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-lg);
    text-align: left;
    padding: 10px 12px;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
  }
  .sheet-item:hover,
  .sheet-item:focus-visible {
    background: color-mix(in srgb, var(--color-line-bright) 40%, transparent);
    outline: none;
  }
  .sheet-item.alert {
    color: var(--color-amber);
  }
  .sheet-item.alert:hover,
  .sheet-item.alert:focus-visible {
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  /* Update rows: amber accent (same semantic hue as the inline update badge). */
  .sheet-item.sheet-update {
    color: var(--color-amber);
  }
  .sheet-item.sheet-update:hover,
  .sheet-item.sheet-update:focus-visible {
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  /* e-stop row in the sheet — same muted-then-red pattern as the desktop menu. */
  .sheet-item.halt-item {
    color: var(--color-muted);
  }
  .sheet-item.halt-item:hover,
  .sheet-item.halt-item:focus-visible {
    background: color-mix(in srgb, var(--color-red) 14%, transparent);
    color: var(--color-red);
  }
  .sheet-item.halt-item.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    border-color: var(--color-red);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-meta);
  }
  .sheet-item.halt-item.armed .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
  }
  .sheet-glyph {
    width: var(--fs-lg);
    text-align: center;
    flex-shrink: 0;
  }
  .sheet-svg {
    height: var(--fs-lg);
    display: block;
  }
  .sheet-label {
    font-variant-numeric: tabular-nums;
  }
  .sheet-foot {
    padding: 6px 12px 2px;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  /* Quick appearance row: dark/light segment + high-contrast toggle, mirroring the
     desktop ActionBar but sized up for touch (44px tap targets). */
  .quick {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 2px;
  }
  .theme-seg {
    display: flex;
    flex: 1;
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    overflow: hidden;
  }
  .t-opt {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt:hover {
    color: var(--color-ink-bright);
  }
  /* seg group clips overflow, so an inset ring would be cropped — outline instead */
  .t-opt:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
  }
  .contrast-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 56px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
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
  /* Copied from parent: octagon halt icon shared between desktop gear-menu and this sheet. */
  .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
    flex-shrink: 0;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
