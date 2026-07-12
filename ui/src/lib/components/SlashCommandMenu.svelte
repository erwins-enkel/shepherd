<script lang="ts">
  import type { SlashCommand } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { commandInvocation, commandProviders } from "$lib/slash";

  let {
    commands,
    activeIndex,
    onpick,
    onhover,
    placement = "down",
    provider = "claude",
  }: {
    commands: SlashCommand[];
    activeIndex: number;
    onpick: (cmd: SlashCommand) => void;
    onhover: (index: number) => void;
    // "down" anchors below the field (New Task modal); "up" anchors above it,
    // for the compose bar pinned to the bottom of the viewport.
    placement?: "up" | "down";
    provider?: "claude" | "codex";
  } = $props();

  // Keep the highlighted row in view as the user arrows through the list.
  let listEl = $state<HTMLUListElement | null>(null);
  $effect(() => {
    const row = listEl?.children[activeIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  });

  function providerBadge(cmd: SlashCommand): string {
    const providers = commandProviders(cmd);
    if (providers.length > 1) return m.provider_badge_both();
    return providers[0] === "codex" ? m.provider_badge_codex() : m.provider_badge_claude();
  }
</script>

<div class="sc-panel" class:up={placement === "up"} role="presentation">
  {#if commands.length === 0}
    <div class="sc-empty">{m.slash_menu_empty()}</div>
  {:else}
    <ul class="sc-list" bind:this={listEl} role="listbox" aria-label={m.slash_menu_label()}>
      {#each commands as cmd, i (cmd.id ?? cmd.scope + ":" + cmd.name)}
        <li
          class="sc-row"
          class:active={i === activeIndex}
          role="option"
          aria-selected={i === activeIndex}
          tabindex="-1"
          onmousedown={(e) => {
            e.preventDefault(); // keep focus in the textarea
            onpick(cmd);
          }}
          onmousemove={() => onhover(i)}
        >
          <div class="sc-line">
            <span class="sc-name">{commandInvocation(cmd, provider)}</span>
            {#if cmd.argumentHint}<span class="sc-hint">{cmd.argumentHint}</span>{/if}
            <!-- raw source tag, matching the Commands-tab chip convention -->
            {#if cmd.scope !== "project"}<span class="sc-scope">{cmd.scope}</span>{/if}
            <span class="sc-provider">{providerBadge(cmd)}</span>
          </div>
          {#if cmd.description}<div class="sc-desc">{cmd.description}</div>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .sc-panel {
    position: absolute;
    z-index: 40;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
  }
  /* open upward when the field is anchored to the bottom of the viewport */
  .sc-panel.up {
    top: auto;
    bottom: calc(100% + 2px);
  }
  .sc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .sc-row {
    padding: 6px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-line);
  }
  .sc-row:last-child {
    border-bottom: 0;
  }
  .sc-row.active,
  .sc-row:hover {
    background: var(--color-hover);
  }
  .sc-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .sc-name {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: var(--fs-base);
    color: var(--color-amber);
    white-space: nowrap;
  }
  .sc-hint {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .sc-scope {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-slate);
    border: 1px solid var(--color-faint);
    border-radius: 2px;
    padding: 0 4px;
  }
  .sc-provider {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 0 4px;
  }
  .sc-desc {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 2px;
  }
  .sc-empty {
    font-family: var(--font-mono);
    padding: 10px;
    color: var(--color-faint);
    font-size: var(--fs-base);
    font-style: italic;
    text-align: center;
  }
  @media (max-width: 768px) {
    .sc-row {
      min-height: 44px;
    }
    .sc-name,
    .sc-hint {
      font-size: var(--fs-lg);
    }
  }
</style>
