<script lang="ts">
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import { dataSlot } from "#lib/data-slot.js";

  // A repo's 20px identity mark: the operator's project emoji when set, else the
  // forge favicon (owner avatar) when it loads, else a monogram (the name's first
  // letter) on a `--data-N` tint picked by a stable hash of the name, so a repo
  // keeps its colour everywhere it appears. Decorative — the name next to it
  // carries the meaning.
  let {
    path,
    name,
    favicon = null,
  }: { path: string; name: string; favicon?: string | null } = $props();

  const emoji = $derived(projectIcons.iconFor(path));
  // The URL that failed to load; a new favicon URL gets a fresh attempt.
  let failedSrc = $state<string | null>(null);
  const img = $derived(!emoji && favicon && favicon !== failedSrc ? favicon : null);
  const letter = $derived((name.match(/[\p{L}\p{N}]/u)?.[0] ?? name.charAt(0)).toUpperCase());
  const tint = $derived(`var(--data-${dataSlot(name)})`);
</script>

<span
  class="repo-mark"
  class:emoji={!!emoji}
  class:img={!!img}
  style:--mark={tint}
  aria-hidden="true"
  >{#if img}<img
      src={img}
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror={() => (failedSrc = img)}
    />{:else}{emoji ?? letter}{/if}</span
>

<style>
  .repo-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--mark) 22%, transparent);
    color: var(--mark);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }

  .repo-mark.img {
    overflow: hidden;
    background: transparent;
  }

  .repo-mark img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .repo-mark.emoji {
    background: transparent;
    font-size: var(--fs-base);
    font-weight: 400;
  }
</style>
