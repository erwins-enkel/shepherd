<script lang="ts">
  import type {
    IssueFilterForks,
    IssueFilterScope,
    IssueFilterSettings,
    UpNextFilterStats,
  } from "#lib/types.js";
  import { anchorPopover } from "#lib/floating-anchor.js";
  import { m } from "#lib/paraglide/messages.js";
  import { isHiddenLabel, toggledLabels } from "./up-next-filter";

  // The Up Next default-filter flyout (#3018). Non-modal anchored dialog: no aria-modal, no
  // scrim (exempt per .claude/rules/ui-design-system.md), so the list stays visible and live
  // while the operator toggles. Every change writes immediately through `onchange`.
  // reference: what it anchors to — the panel (desktop, opens to its right) or the header
  // (`flow`, the phone: full width under it). A desktop panel without room on its right (a
  // full-width lens) drops it under `trigger` instead. `inside`: elements whose pointerdown is
  // not an outside click (the trigger and chips row, which toggle/open it themselves).
  let {
    reference,
    trigger,
    inside = [],
    flow = false,
    filter,
    stats,
    labels,
    forkRepos,
    onchange,
    onreset,
    onclose,
    onsettings,
  }: {
    reference: HTMLElement;
    trigger: HTMLElement | undefined;
    inside?: (HTMLElement | undefined)[];
    flow?: boolean;
    filter: IssueFilterSettings;
    stats: UpNextFilterStats | undefined;
    labels: string[];
    forkRepos: string[];
    onchange: (patch: Partial<IssueFilterSettings>) => void;
    onreset: () => void;
    onclose: () => void;
    /** Open Settings › Workspace, where the whole default filter lives (#3019); with
     *  "repo-overrides", at its per-repo exceptions (#3020). */
    onsettings?: (focus?: "repo-overrides") => void;
  } = $props();

  const id = $props.id();
  let popEl = $state<HTMLDivElement>();
  let width = $state<number | null>(null);

  const SCOPES: { value: IssueFilterScope; label: () => string; desc: () => string }[] = [
    { value: "all", label: m.upnext_filter_scope_all, desc: m.upnext_filter_scope_all_desc },
    {
      value: "mine_unassigned",
      label: m.upnext_filter_scope_mine_unassigned,
      desc: m.upnext_filter_scope_mine_unassigned_desc,
    },
    { value: "mine", label: m.upnext_filter_scope_mine, desc: m.upnext_filter_scope_mine_desc },
  ];
  const FORKS: { value: IssueFilterForks; label: () => string; desc: () => string }[] = [
    { value: "all", label: m.upnext_filter_forks_all, desc: m.upnext_filter_forks_all_desc },
    { value: "own", label: m.upnext_filter_forks_own, desc: m.upnext_filter_forks_own_desc },
    { value: "hide", label: m.upnext_filter_forks_hide, desc: m.upnext_filter_forks_hide_desc },
  ];

  $effect(() => {
    if (!popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return;
    }
    if (flow) {
      width = reference.getBoundingClientRect().width;
      return anchorPopover(reference, popEl, 0, "bottom-start");
    }
    const roomRight = window.innerWidth - reference.getBoundingClientRect().right;
    if (roomRight >= popEl.offsetWidth + 12 || !trigger)
      return anchorPopover(reference, popEl, 6, "right-start");
    return anchorPopover(trigger, popEl, 6, "bottom-end");
  });

  // Land on the checked assignment radio; arrow keys then move within the group natively.
  $effect(() => {
    const checked = popEl?.querySelector<HTMLInputElement>("input[type=radio]:checked");
    const t = setTimeout(() => checked?.focus(), 0);
    return () => clearTimeout(t);
  });

  // Esc + outside pointerdown dismiss; attached a tick late so the opening click doesn't.
  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointerdown(e: PointerEvent) {
      const t = e.target as Node;
      if (popEl?.contains(t) || inside.some((el) => el?.contains(t))) return;
      onclose();
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
    };
  });
</script>

<div
  bind:this={popEl}
  class={["unf", { flow }]}
  style:width={width != null ? `${width}px` : undefined}
  role="dialog"
  aria-labelledby="{id}-title"
  popover="manual"
>
  <div class="unf-head">
    <span id="{id}-title" class="unf-title">{m.upnext_filter_title()}</span>
    <button
      type="button"
      class="unf-close"
      aria-label={m.upnext_filter_close()}
      title={m.upnext_filter_close()}
      onclick={onclose}>✕</button
    >
  </div>

  <fieldset class="unf-section">
    <legend class="unf-heading">
      <span>{m.upnext_filter_scope_heading()}</span>
      {#if stats}<span class="unf-col">{m.upnext_filter_visible_column()}</span>{/if}
    </legend>
    {#each SCOPES as opt (opt.value)}
      <label class="unf-row">
        <input
          type="radio"
          name="{id}-scope"
          value={opt.value}
          aria-labelledby="{id}-scope-{opt.value}"
          aria-describedby="{id}-scope-{opt.value}-desc {id}-scope-{opt.value}-count"
          checked={filter.scope === opt.value}
          onchange={() => onchange({ scope: opt.value })}
        />
        <span class="unf-text">
          <span id="{id}-scope-{opt.value}" class="unf-label">{opt.label()}</span>
          <span id="{id}-scope-{opt.value}-desc" class="unf-desc">{opt.desc()}</span>
        </span>
        {#if stats}<span id="{id}-scope-{opt.value}-count" class="unf-count"
            >{stats.optionCounts.scope[opt.value]}</span
          >{/if}
      </label>
    {/each}
  </fieldset>

  <fieldset class="unf-section">
    <legend class="unf-heading">
      <span>{m.upnext_filter_forks_heading()}</span>
      {#if stats}<span class="unf-col">{m.upnext_filter_visible_column()}</span>{/if}
    </legend>
    {#each FORKS as opt (opt.value)}
      <label class="unf-row">
        <input
          type="radio"
          name="{id}-forks"
          value={opt.value}
          aria-labelledby="{id}-forks-{opt.value}"
          aria-describedby="{id}-forks-{opt.value}-desc {id}-forks-{opt.value}-count"
          checked={filter.forks === opt.value}
          onchange={() => onchange({ forks: opt.value })}
        />
        <span class="unf-text">
          <span id="{id}-forks-{opt.value}" class="unf-label">{opt.label()}</span>
          <span id="{id}-forks-{opt.value}-desc" class="unf-desc">{opt.desc()}</span>
        </span>
        {#if stats}<span id="{id}-forks-{opt.value}-count" class="unf-count"
            >{stats.optionCounts.forks[opt.value]}</span
          >{/if}
      </label>
    {/each}
    {#if forkRepos.length > 0}
      <p class="unf-note">{m.upnext_filter_forks_repos({ repos: forkRepos.join(", ") })}</p>
    {/if}
  </fieldset>

  <div class="unf-section" role="group" aria-labelledby="{id}-labels">
    <div id="{id}-labels" class="unf-heading">{m.upnext_filter_labels_heading()}</div>
    {#if labels.length > 0}
      <div class="unf-chips">
        {#each labels as label (label)}
          {@const on = isHiddenLabel(filter, label)}
          <button
            type="button"
            class={["label-toggle", { on }]}
            aria-pressed={on}
            aria-label={m.upnext_filter_label_toggle_aria({ label })}
            onclick={() => onchange({ hiddenLabels: toggledLabels(filter, label) })}>{label}</button
          >
        {/each}
      </div>
    {:else}
      <p class="unf-note">{m.upnext_filter_labels_none()}</p>
    {/if}
  </div>

  <div class="unf-foot">
    {#if onsettings}
      <button
        type="button"
        class="unf-settings"
        onclick={() => {
          onclose();
          onsettings();
        }}>{m.upnext_filter_all_settings()}</button
      >
      <button
        type="button"
        class="unf-settings"
        onclick={() => {
          onclose();
          onsettings("repo-overrides");
        }}>{m.upnext_filter_repo_overrides()}</button
      >
    {/if}
    <button type="button" class="unf-reset" onclick={onreset}>{m.upnext_filter_reset()}</button>
  </div>
</div>

<style>
  /* Top-layer popover (IssueFilterPopover recipe): fixed + inset:auto + margin:0 lets Floating
     UI drive left/top. */
  [popover].unf {
    position: fixed;
    inset: auto;
    margin: 0;
    width: 320px;
    max-width: calc(100vw - 16px);
    max-height: min(80vh, 560px);
    overflow-y: auto;
    padding: 0 0 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    /* established popover shadow (matches IssueFilterPopover/AutomationPanel) — no token exists */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  [popover].unf.flow {
    max-width: 100vw;
  }
  .unf-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 6px 12px;
    border-bottom: 1px solid var(--color-line);
  }
  .unf-title {
    flex: 1;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 700;
  }
  .unf-close {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    cursor: pointer;
    min-width: 28px;
    min-height: 28px;
  }
  .unf-close:hover {
    color: var(--color-ink);
  }
  .unf-section {
    margin: 0;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    padding: 8px 12px;
    min-width: 0;
  }
  .unf-heading {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 0 0 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .unf-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 12px;
    margin: 0 -12px;
    cursor: pointer;
  }
  .unf-row:hover {
    background: var(--color-hover);
  }
  .unf-row input {
    margin-top: 3px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .unf-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .unf-label {
    color: var(--color-ink);
  }
  .unf-desc,
  .unf-note {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    line-height: 1.4;
  }
  .unf-note {
    margin: 4px 0 0;
  }
  .unf-count {
    font-family: var(--font-mono);
    color: var(--color-muted);
  }
  .unf-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  /* Label toggles: the IssueFilterPopover .label-toggle recipe. */
  .label-toggle {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 6px;
    cursor: pointer;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label-toggle:hover {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .label-toggle.on {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
  }
  .label-toggle:focus-visible,
  .unf-close:focus-visible,
  .unf-settings:focus-visible,
  .unf-reset:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 1px;
  }
  .unf-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px 0;
  }
  .unf-reset {
    margin-left: auto;
  }
  .unf-settings {
    background: transparent;
    border: 0;
    padding: 2px 0;
    color: var(--color-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .unf-settings:hover {
    color: var(--color-ink);
    text-decoration: underline;
  }
  .unf-reset {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    padding: 2px 10px;
    cursor: pointer;
  }
  .unf-reset:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
</style>
