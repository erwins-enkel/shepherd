<script lang="ts">
  import type { SlashCommand } from "#lib/types.js";
  import SlashCommandMenu from "../SlashCommandMenu.svelte";

  // The Viewport's panes clip their content and can leave the Chat only a few lines, so the
  // composer's menu floats over the whole window: pinned to the field's top edge (`anchor`), as
  // tall as the screen allows.
  let {
    open,
    anchor,
    commands,
    activeIndex,
    provider,
    onpick,
    onhover,
  }: {
    open: boolean;
    anchor: { top: number; left: number; width: number };
    commands: SlashCommand[];
    activeIndex: number;
    provider: "claude" | "codex";
    onpick: (cmd: SlashCommand) => void;
    onhover: (index: number) => void;
  } = $props();
</script>

{#if open}
  <div
    class="menu"
    style:top="{anchor.top}px"
    style:left="{anchor.left}px"
    style:width="{anchor.width}px"
    style:--sc-list-max="{Math.max(0, anchor.top - 8)}px"
  >
    <SlashCommandMenu {commands} {activeIndex} {provider} placement="up" {onpick} {onhover} />
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 40;
    height: 0;
  }
</style>
