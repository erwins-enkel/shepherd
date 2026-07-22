<script lang="ts">
  import type { Snippet } from "svelte";
  import HighlightText from "./HighlightText.svelte";

  // The aligned setting row from the 5a/5b handoff: title + description on the
  // left, the control on a fixed 200px column on the right, hairline top
  // border, no boxes. On mobile the row stacks (label → description → control)
  // unless `inlineOnMobile` keeps it horizontal (toggle rows). An optional
  // `below` snippet renders full-width under the pair (model meta line,
  // API-key block). `onrowclick` makes the whole row one hit target (toggle
  // rows) — clicks on the inner control itself are left to the control.
  let {
    title,
    description = "",
    query = "",
    inlineOnMobile = false,
    onrowclick,
    control,
    below,
  }: {
    title: string;
    description?: string;
    query?: string;
    inlineOnMobile?: boolean;
    onrowclick?: () => void;
    control?: Snippet;
    below?: Snippet;
  } = $props();

  function rowClick(e: MouseEvent) {
    if (!onrowclick) return;
    // The real control (switch/select/…) handles its own clicks; forwarding
    // those too would double-toggle.
    if ((e.target as HTMLElement).closest("button, select, input, textarea, a, label")) return;
    onrowclick();
  }
</script>

<div
  class="srow"
  class:clickable={!!onrowclick}
  class:inline={inlineOnMobile}
  role="presentation"
  onclick={rowClick}
>
  <div class="main">
    <span class="title"><HighlightText text={title} {query} /></span>
    {#if description}
      <span class="desc"><HighlightText text={description} {query} /></span>
    {/if}
  </div>
  {#if control}
    <div class="ctl">{@render control()}</div>
  {/if}
  {#if below}
    <div class="extra">{@render below()}</div>
  {/if}
</div>

<style>
  .srow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 12px 0;
    border-top: 1px solid var(--color-line);
  }
  .srow.clickable {
    cursor: pointer;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .title {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .ctl {
    width: 200px;
    box-sizing: border-box;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .extra {
    flex-basis: 100%;
    min-width: 0;
  }

  @media (max-width: 768px) {
    .srow:not(.inline) {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .srow:not(.inline) .ctl {
      width: 100%;
      justify-content: flex-start;
    }
    .srow.inline {
      min-height: 44px;
      box-sizing: border-box;
      padding: 14px 0;
    }
    .srow.inline .ctl {
      width: auto;
    }
    .title {
      font-size: var(--fs-lg);
    }
    .desc {
      font-size: var(--fs-base);
    }
  }
</style>
