<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { upNext } from "$lib/up-next.svelte";
  import { findUpNextItem, upNextKey, upNextUi } from "$lib/up-next-ui.svelte";
  import { UpNextStarter, type UpNextLaunchContext } from "$lib/up-next-start.svelte";
  import IssueDetailHead from "./issues-panel/IssueDetailHead.svelte";
  import MarkdownBody from "./MarkdownBody.svelte";
  import UpNextStartPicker from "./UpNextStartPicker.svelte";

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

  function step(by: number) {
    if (index < 0 || total < 2) return;
    upNextUi.previewKey = upNextUi.order[(index + by + total) % total]!;
  }
  function close() {
    if (onback) onback();
    else upNextUi.previewKey = null;
  }
  // Esc closes the preview while focus is inside it; the CLI picker handles its own Esc.
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || starter.picker) return;
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
        <button
          type="button"
          class="gbtn primary"
          disabled={starter.starting}
          onclick={(e) => starter.request([item], e.currentTarget)}>{m.upnext_start()}</button
        >
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

  .unp-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-block: 10px;
    border-block: 1px solid var(--color-line);
  }
  .unp-pick {
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
