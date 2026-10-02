<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { Steer } from "$lib/types";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";
  import { statusTip } from "$lib/tooltips/statusTip.svelte";
  import type { TooltipExplanation } from "$lib/tooltips/content";
  import { upNext } from "$lib/up-next.svelte";
  import { findUpNextItem, upNextKey, upNextUi } from "$lib/up-next-ui.svelte";
  import { UpNextStarter, type UpNextLaunchContext } from "$lib/up-next-start.svelte";
  import IssueDetailHead from "./issues-panel/IssueDetailHead.svelte";
  import MarkdownBody from "./MarkdownBody.svelte";
  import UpNextStartPicker from "./UpNextStartPicker.svelte";
  import UpNextSteerMenu from "./UpNextSteerMenu.svelte";

  // Reading view for the Up Next row whose title was clicked: the issue's head and rendered
  // description, with Start and the batch tick beside it — so the operator reads before
  // starting instead of leaving for GitHub. Desktop renders it in the main area beside the
  // rail panel; the phone swaps it in place of the list and passes `onback`.
  let {
    launchContext = null,
    onback = undefined,
  }: {
    launchContext?: UpNextLaunchContext | null;
    onback?: () => void;
  } = $props();

  const starter = new UpNextStarter(() => launchContext);
  const item = $derived(findUpNextItem(upNext.snapshot, upNextUi.previewKey));
  const key = $derived(item ? upNextKey(item) : null);
  const index = $derived(key ? upNextUi.order.indexOf(key) : -1);
  const total = $derived(upNextUi.order.length);
  const tag = $derived(
    item?.kind !== "epic"
      ? null
      : item.epicParent
        ? m.issuedetail_epic_of({ parent: item.epicParent.number })
        : m.issuedetail_epic_tag(),
  );

  // Issue steers (Settings › Steers, "Show in: Backlog issues") for this row's repo, as on a
  // backlog issue. Not on an epic parent: a manual task there collides with the Epic Runner.
  const issueSteers = $derived(
    item && launchContext?.onquick && !(item.kind === "epic" && !item.epicParent)
      ? steers.list.filter((s) => s.onIssues && steerAppliesToRepo(s, repos.nameFor(item.repoPath)))
      : [],
  );

  // As many steers as fit sit inline after Start (in Settings order); once one doesn't, a ▾
  // joins Start and opens all of them. Clipped buttons stay laid out (visibility: hidden) so
  // every re-measure can read their widths. The ▾ only ever narrows the row, so showing it
  // can't make everything fit again — no flip-flop.
  let steerRow = $state<HTMLElement>();
  let fitCount = $state(Infinity);
  const overflow = $derived(fitCount < issueSteers.length);
  $effect(() => {
    const row = steerRow;
    void issueSteers; // re-measure when stepping to a row with other steers
    if (!row) return;
    const buttons = Array.from(row.querySelectorAll<HTMLElement>(".unp-steer"));
    const measure = () => {
      let n = 0;
      for (const b of buttons) {
        if (b.offsetLeft + b.offsetWidth > row.clientWidth) break;
        n++;
      }
      fitCount = n;
    };
    measure();
    // The buttons too: a late web font widens them without resizing the row. Measured on the
    // next frame: the ▾ a measure adds resizes the row, which inside the observer's own
    // delivery would trip "ResizeObserver loop completed with undelivered notifications".
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const el of [row, ...buttons]) ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  });

  let startGroup = $state<HTMLElement>();
  let startBtn = $state<HTMLButtonElement>();
  let menuOpen = $state(false);
  $effect(() => {
    if (!overflow || !item) menuOpen = false;
  });

  function startWith(steer: Steer) {
    menuOpen = false;
    if (item) void starter.startWithSteer(item, steer);
  }

  function steerTip(s: Steer, number: number): TooltipExplanation {
    const prompt = s.text.trim();
    return {
      title: s.label,
      summary: m.upnext_preview_steer_tip_summary({ number }),
      sections: [
        {
          label: m.upnext_preview_steer_tip_prompt(),
          text: prompt.length > 280 ? `${prompt.slice(0, 280)}…` : prompt,
        },
        { label: m.upnext_preview_steer_tip_cli(), text: m.upnext_preview_steer_tip_cli_body() },
      ],
    };
  }

  function step(by: number) {
    if (index < 0 || total < 2) return;
    upNextUi.previewKey = upNextUi.order[(index + by + total) % total]!;
  }
  function close() {
    if (onback) onback();
    else upNextUi.previewKey = null;
  }
  // Esc closes the preview while focus is inside it; the CLI picker and the steer menu
  // handle their own Esc.
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented || starter.picker) return;
    if (menuOpen) {
      menuOpen = false;
      return;
    }
    e.preventDefault();
    close();
  }
</script>

<!-- Esc closes the preview while focus is inside it (the handler only listens). -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="unp" aria-label={m.upnext_preview_aria()} {onkeydown}>
  <div class="unp-bar">
    {#if onback}
      <button type="button" class="unp-back" onclick={onback}>← {m.issuedetail_back()}</button>
    {:else}
      <span class="unp-label">{m.upnext_preview_title()}</span>
    {/if}
    {#if index >= 0}
      <span class="unp-pos">{m.upnext_preview_position({ index: index + 1, total })}</span>
    {/if}
    <span class="unp-spacer"></span>
    {#if item}
      <button
        type="button"
        class="icon-btn unp-icon"
        disabled={total < 2}
        title={m.upnext_preview_prev()}
        aria-label={m.upnext_preview_prev()}
        onclick={() => step(-1)}>‹</button
      >
      <button
        type="button"
        class="icon-btn unp-icon"
        disabled={total < 2}
        title={m.upnext_preview_next()}
        aria-label={m.upnext_preview_next()}
        onclick={() => step(1)}>›</button
      >
    {/if}
    {#if item && !onback}
      <button
        type="button"
        class="icon-btn unp-icon"
        title={m.common_close()}
        aria-label={m.common_close()}
        onclick={close}>×</button
      >
    {/if}
  </div>

  {#if item && key}
    <div class="unp-body">
      <IssueDetailHead
        {tag}
        number={item.number}
        title={item.title}
        url={item.url}
        labels={item.labels}
        labelColors={item.labelColors}
        createdAt={item.createdAt}
      />
      <div class="unp-actions">
        <span class="unp-start" bind:this={startGroup}>
          <button
            type="button"
            class="gbtn primary"
            class:split={overflow}
            bind:this={startBtn}
            disabled={starter.starting}
            onclick={(e) => starter.request([item], e.currentTarget)}>{m.upnext_start()}</button
          >
          {#if overflow}
            <button
              type="button"
              class="gbtn primary unp-more"
              class:open={menuOpen}
              aria-label={m.upnext_preview_more()}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={starter.starting}
              onclick={() => (menuOpen = !menuOpen)}>▾</button
            >
          {/if}
        </span>
        {#if issueSteers.length > 0}
          <div class="unp-steers" bind:this={steerRow}>
            <span class="unp-steers-label" class:clipped={fitCount === 0}
              >{m.upnext_preview_steers_label()}</span
            >
            {#each issueSteers as s, i (s.id)}
              <button
                type="button"
                class="gbtn unp-steer"
                class:clipped={i >= fitCount}
                aria-label={m.issuespanel_action_aria({ label: s.label })}
                disabled={starter.starting}
                use:statusTip={{
                  text: steerTip(s, item.number),
                  wide: true,
                  stopClickPropagation: false,
                  pinOnClick: false,
                }}
                onclick={() => startWith(s)}
                ><span class="unp-steer-icon" class:glyph={!s.emoji} aria-hidden="true"
                  >{s.emoji || "⇥"}</span
                ><span>{s.label}</span></button
              >
            {/each}
          </div>
        {/if}
        <label class="unp-pick">
          <input
            type="checkbox"
            checked={upNextUi.selected.has(key)}
            onchange={() => upNextUi.toggle(key)}
          />
          <span>{m.upnext_preview_select()}</span>
        </label>
      </div>
      <MarkdownBody source={item.issueRef.body} />
    </div>
  {:else}
    <p class="unp-empty">{m.upnext_preview_empty()}</p>
  {/if}
</section>

<UpNextStartPicker {starter} />
{#if menuOpen && item && startGroup}
  <UpNextSteerMenu
    anchor={startGroup}
    number={item.number}
    steers={issueSteers}
    onstart={() => {
      menuOpen = false;
      if (startBtn) starter.request([item], startBtn);
    }}
    onsteer={startWith}
    onmanage={launchContext?.onmanagesteers
      ? () => {
          menuOpen = false;
          launchContext?.onmanagesteers?.();
        }
      : undefined}
    onclose={() => (menuOpen = false)}
  />
{/if}

<style>
  .unp {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    /* .unp-body scrolls; the bar with ‹ › × stays put. */
    overflow: hidden;
    min-height: 0;
    min-width: 0;
    flex: 1;
  }

  .unp-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .unp-label {
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  .unp-pos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .unp-spacer {
    flex: 1;
  }
  .unp-back {
    padding: 4px 2px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .unp-back:hover {
    color: var(--color-ink);
  }
  /* Global .icon-btn recipe (app.css), with the text glyphs ‹ › × sized up. */
  .unp-icon {
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    color: var(--color-muted);
  }

  .unp-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px 32px;
  }
  .unp-body > :global(*) {
    max-width: 80ch;
  }
  /* The action row is a toolbar, not prose: it takes the pane's full width so more steers
     fit inline before the ▾ takes over. */
  .unp-body > .unp-actions {
    max-width: none;
  }

  .unp-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-block: 10px;
    border-block: 1px solid var(--color-line);
  }
  .unp-start {
    flex: none;
    display: inline-flex;
  }
  .gbtn.split {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* Compound selectors: these sit above the scoped .gbtn recipe they refine. */
  .gbtn.primary.unp-more {
    padding-inline: 8px;
    border-left-color: var(--color-line-bright);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .gbtn.primary.unp-more.open {
    background: var(--color-amber);
    color: var(--color-bg);
  }

  /* Basis 0: the row takes what Start and the tick leave, and never wraps onto its own line. */
  .unp-steers {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }
  .unp-steers-label {
    flex: none;
    padding-left: 10px;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .gbtn.unp-steer {
    flex: none;
    font-weight: normal;
    letter-spacing: 0.04em;
    white-space: nowrap;
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .gbtn.unp-steer:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .unp-steer-icon {
    line-height: 1;
  }
  .unp-steer-icon.glyph {
    color: var(--color-muted);
  }
  /* Out of view and out of the tab order, but still measured. */
  .clipped {
    visibility: hidden;
  }

  .unp-pick {
    flex: none;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    cursor: pointer;
  }
  .unp-pick input {
    margin: 0;
    accent-color: var(--color-amber);
    cursor: pointer;
  }

  /* Canonical .gbtn recipe (/design-system) — scoped copy, as in IssueTaskBox. */
  .gbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.primary:hover:not(:disabled) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .unp-empty {
    flex: 1;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .unp-icon,
    .unp-more {
      min-width: var(--mobile-actionbar-hit);
    }
    .unp-icon {
      width: var(--mobile-actionbar-hit);
      height: var(--mobile-actionbar-hit);
    }
    .unp-back,
    .gbtn {
      min-height: var(--mobile-actionbar-hit);
    }
    .unp-pick {
      min-height: var(--mobile-actionbar-hit);
    }
    .unp-body {
      padding: 14px;
    }
  }
</style>
