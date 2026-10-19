<script lang="ts">
  import { basename } from "#lib/basename.js";
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import { repoHue, repoMonogram } from "#lib/assistant-dock.js";
  import AssistantGlyph from "./AssistantGlyph.svelte";

  // An assistant's mark in the dock: the global one's amber sparkle, a repo assistant's project
  // icon (or the repo's initial) on that repo's data hue. The pip carries what it is doing — amber
  // while it works, red while it waits for the operator — so the hue never has to. Decorative:
  // the name beside it labels the row.
  let {
    repo,
    pip = null,
    size = 28,
  }: {
    /** The repo assistant's repo; null = the global assistant. */
    repo: string | null;
    pip?: "working" | "blocked" | null;
    /** Edge in px. */
    size?: number;
  } = $props();

  const icon = $derived(repo ? projectIcons.iconFor(repo) : null);
</script>

<span
  class="am"
  class:repo={repo !== null}
  style:--am-size="{size}px"
  style:--am-hue={repo ? repoHue(repo) : null}
  aria-hidden="true"
>
  {#if repo === null}
    <AssistantGlyph size="calc(var(--am-size) * 0.57)" />
  {:else if icon}
    <span class="am-icon">{icon}</span>
  {:else}
    {repoMonogram(basename(repo))}
  {/if}
  {#if pip}<span class="am-pip {pip}" data-pip={pip}></span>{/if}
</span>

<style>
  .am {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--am-size);
    height: var(--am-size);
    border-radius: var(--radius-chip);
    background: var(--wash-assistant-chip);
    color: var(--color-amber);
    font-size: var(--fs-base);
    font-weight: 700;
    line-height: 1;
  }
  .am.repo {
    background: color-mix(in srgb, var(--am-hue) 22%, var(--color-panel));
    color: var(--am-hue);
  }
  .am-icon {
    font-size: calc(var(--am-size) * 0.55);
  }
  /* The top-bar Assist pip's recipe, ringed in the card ground so it reads on any hue. */
  .am-pip {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 2px solid var(--color-panel);
  }
  .am-pip.working {
    background: var(--color-amber);
  }
  .am-pip.blocked {
    background: var(--color-red);
  }
</style>
