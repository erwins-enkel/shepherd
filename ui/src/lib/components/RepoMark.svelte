<script lang="ts">
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import { dataSlot } from "#lib/data-slot.js";

  // A repo's 20px identity mark: the operator's project emoji when set, else a
  // monogram (the name's first letter) on a `--data-N` tint picked by a stable hash
  // of the name, so a repo keeps its colour everywhere it appears. Decorative —
  // the name next to it carries the meaning.
  let { path, name }: { path: string; name: string } = $props();

  const emoji = $derived(projectIcons.iconFor(path));
  const letter = $derived((name.match(/[\p{L}\p{N}]/u)?.[0] ?? name.charAt(0)).toUpperCase());
  const tint = $derived(`var(--data-${dataSlot(name)})`);
</script>

<span class="repo-mark" class:emoji={!!emoji} style:--mark={tint} aria-hidden="true"
  >{emoji ?? letter}</span
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

  .repo-mark.emoji {
    background: transparent;
    font-size: var(--fs-base);
    font-weight: 400;
  }
</style>
