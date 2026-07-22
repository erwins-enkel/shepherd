<script lang="ts">
  import { onMount } from "svelte";
  import {
    pushState,
    enablePush,
    disablePush,
    getPushCategories,
    setPushCategories,
    type PushStatus,
    type PushCategories,
  } from "$lib/push";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { tabTicker } from "$lib/tab-ticker.svelte";
  import { infoTips } from "$lib/info-tips.svelte";
  import { REPO, REPO_URL, sha, version, commitUrl, CAPTURE_EXTENSION_URL } from "$lib/build-info";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import HighlightText from "./HighlightText.svelte";
  import { m } from "$lib/paraglide/messages";
  import type { FeedbackKind } from "$lib/feedback-link";

  let {
    onwhatsnew,
    reducedPushMode = false,
    reducedPushBusy = false,
    onToggleReducedPush,
    onfeedback,
    query = "",
  }: {
    onwhatsnew?: () => void;
    reducedPushMode?: boolean;
    reducedPushBusy?: boolean;
    onToggleReducedPush?: () => void;
    onfeedback?: (kind: FeedbackKind) => void;
    /** Active settings-search query — highlights this panel's indexed labels
     *  (the texts sectionSearchRows lists for "device") so the rail badge and
     *  the in-pane highlights can't disagree. */
    query?: string;
  } = $props();

  // Theme picker — mobile only: the desktop switcher lives in the ActionBar,
  // but on phones the ActionBar hides it and it was dropped from the top bar,
  // so Settings (reachable via the gear from any mobile screen) is its home.
  const THEMES: { pref: ThemePref; icon: "moon" | "sun" | "auto"; label: () => string }[] = [
    { pref: "dark", icon: "moon", label: m.theme_dark },
    { pref: "light", icon: "sun", label: m.theme_light },
    { pref: "system", icon: "auto", label: m.theme_system },
  ];

  let push = $state<PushStatus>({ supported: false, permission: "unsupported", subscribed: false });
  let pushBusy = $state(false);
  let categories = $state<PushCategories>({ agent: true, reviews: true, ci: true });

  // Category metadata drives the checkbox list; keys index into `categories`.
  const categoryRows: { key: keyof PushCategories; label: () => string }[] = [
    { key: "agent", label: () => m.settings_push_cat_agent() },
    { key: "reviews", label: () => m.settings_push_cat_reviews() },
    { key: "ci", label: () => m.settings_push_cat_ci() },
  ];

  async function refreshPush() {
    push = await pushState();
    if (push.subscribed) categories = await getPushCategories();
  }

  async function toggleCategory(key: keyof PushCategories) {
    const prev = categories;
    const next = { ...categories, [key]: !categories[key] };
    categories = next; // optimistic; server is authoritative at send time
    if (!(await setPushCategories(next))) categories = prev; // persist failed → revert
  }

  async function togglePush() {
    if (pushBusy) return;
    pushBusy = true;
    try {
      if (push.subscribed) await disablePush();
      else await enablePush();
      await refreshPush();
    } finally {
      pushBusy = false;
    }
  }

  onMount(async () => {
    await refreshPush();
  });
</script>

<div class="theme-row">
  <span class="micro"><HighlightText text={m.actionbar_theme_group_aria()} {query} /></span>
  <div class="theme-seg" role="group" aria-label={m.actionbar_theme_group_aria()}>
    {#each THEMES as t (t.pref)}
      <button
        type="button"
        class="t-opt"
        class:on={theme.pref === t.pref}
        aria-pressed={theme.pref === t.pref}
        aria-label={m.actionbar_theme_option({ label: t.label() })}
        onclick={() => theme.setPref(t.pref)}><ThemeIcon icon={t.icon} /></button
      >
    {/each}
  </div>
</div>
<div class="contrast-row">
  <span class="micro"><HighlightText text={m.settings_contrast_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_contrast_hint()} {query} /></p>
  <button
    type="button"
    class="toggle"
    role="switch"
    aria-checked={theme.contrast}
    onclick={() => theme.toggleContrast()}
  >
    <span class="track" class:on={theme.contrast}><span class="knob"></span></span>
    <span class="state"
      >{theme.contrast ? m.settings_contrast_on() : m.settings_contrast_off()}</span
    >
  </button>
</div>
<div class="rc">
  <span class="micro"><HighlightText text={m.settings_colorblind_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_colorblind_hint()} {query} /></p>
  <button
    type="button"
    class="toggle"
    role="switch"
    aria-checked={theme.colorblind}
    onclick={() => theme.toggleColorblind()}
  >
    <span class="track" class:on={theme.colorblind}><span class="knob"></span></span>
    <span class="state"
      >{theme.colorblind ? m.settings_colorblind_on() : m.settings_colorblind_off()}</span
    >
  </button>
</div>
<div class="rc">
  <span class="micro"><HighlightText text={m.settings_tab_ticker_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_tab_ticker_hint()} {query} /></p>
  <button
    type="button"
    class="toggle"
    role="switch"
    aria-checked={tabTicker.enabled}
    onclick={() => tabTicker.toggle()}
  >
    <span class="track" class:on={tabTicker.enabled}><span class="knob"></span></span>
    <span class="state"
      >{tabTicker.enabled ? m.settings_tab_ticker_on() : m.settings_tab_ticker_off()}</span
    >
  </button>
</div>
<div class="rc">
  <span class="micro"><HighlightText text={m.settings_hide_info_tips_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_hide_info_tips_hint()} {query} /></p>
  <button
    type="button"
    class="toggle"
    role="switch"
    aria-checked={infoTips.hidden}
    onclick={() => infoTips.toggle()}
  >
    <span class="track" class:on={infoTips.hidden}><span class="knob"></span></span>
    <span class="state"
      >{infoTips.hidden ? m.settings_hide_info_tips_on() : m.settings_hide_info_tips_off()}</span
    >
  </button>
</div>
<div class="push">
  <span class="micro"><HighlightText text={m.settings_push_title()} {query} /></span>
  <div class="reduced-row">
    <span class="micro sub"><HighlightText text={m.settings_reduced_push_title()} {query} /></span>
    <p class="hint"><HighlightText text={m.settings_reduced_push_hint()} {query} /></p>
    <button
      type="button"
      class="toggle"
      role="switch"
      aria-label={m.settings_reduced_push_title()}
      aria-checked={reducedPushMode}
      disabled={reducedPushBusy}
      onclick={() => onToggleReducedPush?.()}
    >
      <span class="track" class:on={reducedPushMode}><span class="knob"></span></span>
      <span class="state"
        >{reducedPushMode ? m.settings_reduced_push_on() : m.settings_reduced_push_off()}</span
      >
    </button>
  </div>
  {#if !push.supported}
    <p class="hint">{m.settings_push_unsupported()}</p>
  {:else if push.permission === "denied"}
    <p class="hint">{m.settings_push_denied()}</p>
  {:else}
    <button type="button" class="run" disabled={pushBusy} onclick={togglePush}>
      {#if pushBusy}…{:else if push.subscribed}{m.settings_push_disable()}{:else}{m.settings_push_enable()}{/if}
    </button>
    {#if push.subscribed}
      <fieldset class="cats">
        <legend class="micro sub">{m.settings_push_cat_title()}</legend>
        {#if reducedPushMode}
          <p class="hint">{m.settings_reduced_push_disabled_note()}</p>
        {/if}
        {#each categoryRows as row (row.key)}
          <label class="cat">
            <input
              type="checkbox"
              checked={categories[row.key]}
              disabled={reducedPushMode}
              onchange={() => toggleCategory(row.key)}
            />
            <span>{row.label()}</span>
          </label>
        {/each}
      </fieldset>
    {/if}
  {/if}
</div>
<div class="feedback">
  <span class="micro"><HighlightText text={m.settings_feedback_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_feedback_blurb()} {query} /></p>
  <div class="feedback-btns">
    <button type="button" class="clone-trigger" onclick={() => onfeedback?.("bug")}
      >{m.feedback_dialog_title_bug()}</button
    >
    <button type="button" class="clone-trigger" onclick={() => onfeedback?.("feature")}
      >{m.feedback_dialog_title_feature()}</button
    >
    <button type="button" class="clone-trigger" onclick={() => onfeedback?.("feedback")}
      >{m.feedback_dialog_title_feedback()}</button
    >
  </div>
</div>
<div class="extension">
  <span class="micro"><HighlightText text={m.settings_extension_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_extension_blurb()} {query} /></p>
  <a
    class="ext-link"
    href={CAPTURE_EXTENSION_URL}
    target="_blank"
    rel="external noreferrer noopener"
    >{m.settings_extension_link()} <span aria-hidden="true">↗</span></a
  >
</div>
<div class="about">
  <span class="micro"><HighlightText text={m.settings_about_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.settings_about_blurb()} {query} /></p>
  <dl class="about-grid">
    <dt>{m.settings_about_version()}</dt>
    <dd>
      v{version}
      <button type="button" class="clone-trigger whatsnew-btn" onclick={() => onwhatsnew?.()}
        >{m.whatsnew_open()}</button
      >
    </dd>
    <dt>{m.settings_about_commit()}</dt>
    <dd>
      <a
        href={commitUrl}
        target="_blank"
        rel="external noreferrer noopener"
        title={m.actionbar_commit_title({ sha })}>{sha}</a
      >
    </dd>
    <dt>{m.settings_about_repo()}</dt>
    <dd>
      <a
        href={REPO_URL}
        target="_blank"
        rel="external noreferrer noopener"
        title={m.actionbar_repo_link({ repo: REPO })}>{REPO}</a
      >
    </dd>
  </dl>
</div>

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* Nested sub-section headings (REDUCED NOTIFICATIONS, NOTIFY ME ABOUT) sit one
     level below the PUSH NOTIFICATIONS section label. Demote via size + tracking
     only — colour stays --color-muted (the AA-safe label colour, ≥4.5:1) so the
     sub-heading reads brighter than its --color-faint hint and never regresses
     contrast. No font-weight axis (the design system defines no weight token). */
  .micro.sub {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
  }
  .run {
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }
  /* Secondary/outline button — same shape as .run but uses the panel's neutral
     line colour rather than amber, so it reads as a lower-priority action. */
  .clone-trigger {
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    background: var(--color-inset);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .clone-trigger:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
  .whatsnew-btn {
    padding: 4px 8px;
    vertical-align: middle;
    margin-left: 6px;
  }
  .reduced-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .reduced-row .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .push {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .push .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .cats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 0;
    margin: 2px 0 0;
    padding: 0;
  }
  .cats legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .cat input {
    cursor: pointer;
  }
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rc .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 4px 0;
    cursor: pointer;
    font: inherit;
    min-height: 44px;
  }
  .toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .track {
    position: relative;
    width: 38px;
    height: 20px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
    transition: background 0.12s;
  }
  .track.on {
    background: color-mix(in srgb, var(--color-ink) 22%, transparent);
    border-color: var(--color-line-bright);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-muted);
    transition:
      transform 0.12s,
      background 0.12s;
  }
  .track.on .knob {
    transform: translateX(18px);
    background: var(--color-ink-bright);
  }
  .toggle .state {
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  /* The theme switcher and high-contrast toggle live in the Settings dialog on
     every viewport so the menu reads identically on mobile and desktop — desktop
     additionally mirrors the theme switcher in the ActionBar for quick access. */
  .theme-row,
  .contrast-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .contrast-row .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .theme-seg {
    display: flex;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    overflow: hidden;
    align-self: flex-start;
  }
  .t-opt {
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 0 16px;
    min-height: 44px;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
  }
  .feedback {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
  }
  .feedback .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .feedback-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* The about block — blurb plus the version / commit / repo rows — shows on
     every viewport; desktop additionally surfaces the same metadata in the
     ActionBar footer. */
  .about {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
  }
  .about .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .about-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    margin: 0;
  }
  .about-grid dt {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .about-grid dd {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    word-break: break-all;
  }
  .about-grid a {
    color: var(--color-amber);
    text-decoration: none;
  }
  .about-grid a:hover {
    text-decoration: underline;
  }

  /* Browser-extension promo — same block shape as .feedback / .about. */
  .extension {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
  }
  .extension .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .ext-link {
    align-self: flex-start;
    color: var(--color-amber);
    text-decoration: none;
    font-size: var(--fs-base);
  }
  .ext-link:hover {
    text-decoration: underline;
  }
  /* keep a 44px tap target on touch without inflating the desktop line */
  @media (pointer: coarse) {
    .ext-link {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
    }
    /* feedback trio + the What's-New opener share the .clone-trigger recipe */
    .clone-trigger {
      min-height: 44px;
    }
  }

  @media (max-width: 768px) {
    .run {
      min-height: 44px;
    }
  }
</style>
