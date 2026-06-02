<script lang="ts">
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { m } from "$lib/paraglide/messages";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";
  import { REPO, REPO_URL, sha, version, commitUrl } from "$lib/build-info";

  // Two explicit theme choices; "system" stays the implicit default (followed on
  // first load + on OS changes until the operator picks one). The old third slot
  // (◐ system) is repurposed as the standalone high-contrast / WCAG toggle below.
  const THEMES: { pref: Exclude<ThemePref, "system">; glyph: string; label: () => string }[] = [
    { pref: "dark", glyph: "☾", label: m.theme_dark },
    { pref: "light", glyph: "☀", label: m.theme_light },
  ];

  let {
    onnew,
    onbacklog,
    mode = "focus",
    onmode,
    mobile = false,
    desktopOnly = false,
  }: {
    onnew: () => void;
    onbacklog?: () => void;
    mode?: "focus" | "all";
    onmode?: (m: "focus" | "all") => void;
    mobile?: boolean;
    desktopOnly?: boolean;
  } = $props();
</script>

{#if !(desktopOnly && mobile)}
  <div class="actions" class:mobile>
    <button class="btn primary" type="button" onclick={onnew}>{m.actionbar_new_task()}</button>
    {#if onbacklog}
      <button class="btn backlog" type="button" onclick={onbacklog}>{m.actionbar_backlog()}</button>
    {/if}
    {#if !mobile}
      <button
        class="btn"
        class:active={mode === "all"}
        aria-pressed={mode === "all"}
        type="button"
        onclick={() => onmode?.("all")}>{m.actionbar_all_mode()}</button
      >
      <button
        class="btn"
        class:active={mode === "focus"}
        aria-pressed={mode === "focus"}
        type="button"
        onclick={() => onmode?.("focus")}>{m.actionbar_focus_mode()}</button
      >
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
              onclick={() => theme.setPref(t.pref)}>{t.glyph}</button
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
          onclick={() => theme.toggleContrast()}>◐</button
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
    border: 1px solid var(--color-line);
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
    font-size: 11px;
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
  .btn.active {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
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
    font-size: 13px;
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
    font-size: 13px;
    line-height: 1;
    padding: 4px 8px;
    cursor: pointer;
  }
  .contrast-toggle:hover {
    color: var(--color-ink-bright);
  }
  .contrast-toggle.on {
    color: var(--color-amber);
    background: var(--color-inset);
    border-color: var(--color-amber);
  }
  .actions.mobile {
    padding: 10px;
  }
  .actions.mobile .btn.primary {
    flex: 1;
    text-align: center;
    padding: 12px;
    font-size: 12px;
  }
  .actions.mobile .btn.backlog {
    padding: 12px 16px;
    font-size: 12px;
  }
</style>
