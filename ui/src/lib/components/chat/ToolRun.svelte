<script lang="ts">
  import type { ActivityEntry } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { clock, glyph } from "#lib/activity.js";

  // A run of tool calls between two messages, collapsed to its count and latest call. `live`: the
  // run the agent is still adding to, so its latest call is what it is doing now.
  let { calls, live = false }: { calls: ActivityEntry[]; live?: boolean } = $props();

  let open = $state(false);
  const latest = $derived(calls[calls.length - 1]);
  const failed = $derived(calls.filter((c) => c.status === "error").length);
</script>

<div class="tr" class:tr-live={live}>
  <button type="button" class="tr-head" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="tr-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="tr-count"
      >{calls.length === 1
        ? m.chat_tools_one()
        : m.chat_tools_many({ count: calls.length })}{#if failed > 0}&nbsp;· {m.chat_tools_failed({
          count: failed,
        })}{/if}</span
    >
    {#if !open}<span class="tr-latest">{latest.summary}</span>{/if}
  </button>
  {#if open}
    <ul class="tr-calls">
      {#each calls as c, i (i)}
        <li class:error={c.status === "error"} class:pending={c.status === "pending"}>
          {#if c.ts}<span class="tr-time">{clock(c.ts)}</span>{/if}
          <span class="tr-glyph" aria-hidden="true">{glyph(c.tool)}</span>
          <span class="tr-summary">{c.summary}</span>
          {#if c.status === "error"}<span class="tr-flag">{m.chat_tool_error()}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tr {
    min-width: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  .tr-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    min-width: 0;
    padding: 2px 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tr-head:hover,
  .tr-head:focus-visible {
    color: var(--color-ink);
    outline: none;
  }
  .tr-head:focus-visible .tr-count {
    text-decoration: underline;
  }
  .tr-caret {
    flex: none;
    width: 1em;
  }
  .tr-count {
    flex: none;
  }
  .tr-latest {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .tr-live .tr-latest {
    color: var(--color-amber);
  }
  .tr-calls {
    list-style: none;
    margin: 4px 0 0;
    padding: 0 0 0 1.5em;
  }
  .tr-calls li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 1px 0;
    color: var(--color-ink);
  }
  .tr-time {
    flex: none;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .tr-glyph {
    flex: none;
    width: 1em;
    text-align: center;
  }
  .tr-summary {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
  }
  .tr-calls li.pending {
    color: var(--color-muted);
  }
  .tr-calls li.error,
  .tr-flag {
    color: var(--color-red);
  }
  .tr-flag {
    flex: none;
  }
</style>
