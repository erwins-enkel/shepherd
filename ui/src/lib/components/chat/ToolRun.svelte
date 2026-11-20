<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ActivityEntry } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { clock, glyph } from "#lib/activity.js";

  // A run of tool calls between two messages, collapsed to its count and latest call. `live`: the
  // run the agent is still adding to, so its latest call is what it is doing now.
  // #3877: a call the artifact row came from carries the "◆ in the bar" chip (`marked`), and the
  // row's "Show in Chat" (`reveal`, one call's id, set for a moment) opens the run, scrolls the
  // call into view, focuses it and highlights it briefly.
  let {
    calls,
    live = false,
    marked,
    reveal = null,
  }: {
    calls: ActivityEntry[];
    live?: boolean;
    /** Tool-use ids of the publishes the artifact row shows. */
    marked?: ReadonlySet<string>;
    /** The id of a call to reveal; the Chat sets it for one update. */
    reveal?: string | null;
  } = $props();

  /** How long a revealed call stays highlighted. */
  const HIGHLIGHT_MS = 2000;

  let open = $state(false);
  const latest = $derived(calls[calls.length - 1]);
  const failed = $derived(calls.filter((c) => c.status === "error").length);
  const isMarked = (c: ActivityEntry) => !!c.toolUseId && !!marked?.has(c.toolUseId);
  const hasMarked = $derived(calls.some(isMarked));

  let list = $state<HTMLUListElement>();
  let hit = $state<string | null>(null);
  let hitTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const id = reveal;
    if (!id) return;
    untrack(() => {
      const index = calls.findIndex((c) => c.toolUseId === id);
      if (index < 0) return;
      open = true;
      hit = id;
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => (hit = null), HIGHLIGHT_MS);
      void tick().then(() => {
        const li = list?.children[index];
        if (!(li instanceof HTMLElement)) return;
        // focusable for good, so focus stays where it landed after the highlight fades
        li.tabIndex = -1;
        li.scrollIntoView({ block: "center" });
        li.focus({ preventScroll: true });
      });
    });
  });
  $effect(() => () => clearTimeout(hitTimer));
</script>

{#snippet chip()}
  <span class="tr-chip"
    ><span class="tr-chip-glyph" aria-hidden="true"></span>{m.artifactrow_chat_chip()}</span
  >
{/snippet}

<div class="tr" class:tr-live={live}>
  <button type="button" class="tr-head" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="tr-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="tr-count"
      >{calls.length === 1 ? m.chat_tools_one() : m.chat_tools_many({ count: calls.length })}</span
    >
    {#if failed > 0}<span class="tr-failed">{m.chat_tools_failed({ count: failed })}</span>{/if}
    {#if !open}<span class="tr-latest">{latest.summary}</span>{/if}
    {#if !open && hasMarked}{@render chip()}{/if}
  </button>
  {#if open}
    <ul class="tr-calls" bind:this={list}>
      {#each calls as c, i (i)}
        <li
          class:error={c.status === "error"}
          class:pending={c.status === "pending"}
          class:tr-hit={!!hit && c.toolUseId === hit}
        >
          {#if c.ts}<span class="tr-time">{clock(c.ts)}</span>{/if}
          <span class="tr-glyph" aria-hidden="true">{glyph(c.tool)}</span>
          <span class="tr-summary">{c.summary}</span>
          {#if isMarked(c)}{@render chip()}{/if}
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
  .tr-count,
  .tr-failed {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .tr-failed {
    color: var(--color-red);
  }
  .tr-latest {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink);
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
  /* the artifact row's publish (#3877): blue on the diamond and the label only */
  .tr-chip {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    border: 1px solid color-mix(in srgb, var(--color-blue) 45%, var(--color-line));
    border-radius: 2px;
    color: var(--color-blue);
    font-family: var(--font-sans);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .tr-chip-glyph {
    width: 5px;
    height: 5px;
    background: var(--color-blue);
    transform: rotate(45deg);
  }
  /* a call "Show in Chat" jumped to, for a moment */
  .tr-calls li.tr-hit {
    background: color-mix(in srgb, var(--color-blue) 14%, transparent);
    box-shadow: inset 2px 0 0 var(--color-blue);
  }
  .tr-calls li:focus-visible {
    outline: 1px solid var(--color-blue);
    outline-offset: -1px;
  }
</style>
