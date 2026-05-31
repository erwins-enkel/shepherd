<script lang="ts">
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { m } from "$lib/paraglide/messages";
  import LanguageSwitcher from "$lib/components/LanguageSwitcher.svelte";

  const REPO = "erwins-enkel/shepherd";
  const REPO_URL = `https://github.com/${REPO}`;
  const sha = __GIT_SHA__;
  const commitUrl = sha === "unknown" ? REPO_URL : `https://github.com/${REPO}/commit/${sha}`;

  const THEMES: { pref: ThemePref; glyph: string; label: () => string }[] = [
    { pref: "dark", glyph: "☾", label: m.theme_dark },
    { pref: "light", glyph: "☀", label: m.theme_light },
    { pref: "system", glyph: "◐", label: m.theme_system },
  ];

  let {
    onnew,
    mode = "focus",
    onmode,
    mobile = false,
    desktopOnly = false,
  }: {
    onnew: () => void;
    mode?: "focus" | "all";
    onmode?: (m: "focus" | "all") => void;
    mobile?: boolean;
    desktopOnly?: boolean;
  } = $props();
</script>

{#if !(desktopOnly && mobile)}
  <div class="actions" class:mobile>
    <button class="btn primary" type="button" onclick={onnew}>{m.actionbar_new_task()}</button>
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
        <a class="repo" href={REPO_URL} target="_blank" rel="external noreferrer noopener">{REPO}</a
        >
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
              class:on={theme.pref === t.pref}
              aria-pressed={theme.pref === t.pref}
              title={m.actionbar_theme_option({ label: t.label() })}
              aria-label={m.actionbar_theme_option({ label: t.label() })}
              onclick={() => theme.setPref(t.pref)}>{t.glyph}</button
            >
          {/each}
        </div>
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
  .actions.mobile {
    padding: 10px;
  }
  .actions.mobile .btn.primary {
    flex: 1;
    text-align: center;
    padding: 12px;
    font-size: 12px;
  }
</style>
