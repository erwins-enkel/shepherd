<script lang="ts">
  import { onMount } from "svelte";
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";

  let {
    name,
    previewFile,
    coarse,
    onremove,
  }: {
    name: string;
    previewFile?: File;
    coarse: boolean;
    onremove: () => void;
  } = $props();

  const previewId = $props.id();
  let previewUrl = $state<string | null>(null);
  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let popoverEl = $state<HTMLElement | null>(null);

  onMount(() => {
    if (!previewFile) return;
    const url = URL.createObjectURL(previewFile);
    previewUrl = url;
    return () => URL.revokeObjectURL(url);
  });

  $effect(() => {
    if (!open || !triggerEl || !popoverEl) return;
    try {
      popoverEl.showPopover();
    } catch {
      return;
    }
    return anchorPopover(triggerEl, popoverEl, 6, "top");
  });

  $effect(() => {
    if (!open) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") open = false;
    }
    function onPointerdown(e: PointerEvent) {
      const target = e.target as Node;
      if (!triggerEl?.contains(target) && !popoverEl?.contains(target)) open = false;
    }
    function onScrollOrResize() {
      open = false;
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointerdown);
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
      window.removeEventListener("scroll", onScrollOrResize, { capture: true });
      window.removeEventListener("resize", onScrollOrResize);
    };
  });
</script>

<span class="chip">
  {#if previewFile}
    <button
      bind:this={triggerEl}
      type="button"
      class="chip-name preview-trigger"
      aria-label={m.newtask_preview_image_aria({ name })}
      aria-controls={previewId}
      aria-expanded={coarse ? open : undefined}
      onpointerenter={(e) => {
        if (!coarse && e.pointerType !== "touch") open = true;
      }}
      onpointerleave={(e) => {
        if (!coarse && e.pointerType !== "touch") open = false;
      }}
      onfocus={() => {
        if (!coarse) open = true;
      }}
      onblur={() => {
        if (!coarse) open = false;
      }}
      onclick={(e) => {
        if (!coarse) return;
        e.preventDefault();
        open = !open;
      }}>{name}</button
    >
  {:else}
    <span class="chip-name">{name}</span>
  {/if}
  <button type="button" class="chip-x" onclick={onremove} aria-label={m.newtask_remove_image_aria()}
    >✕</button
  >
</span>

{#if previewUrl}
  <span
    id={previewId}
    bind:this={popoverEl}
    class="attachment-preview"
    role="tooltip"
    aria-label={m.newtask_preview_image_aria({ name })}
    popover="manual"
  >
    <img src={previewUrl} alt="" />
  </span>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 7px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .preview-trigger {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: zoom-in;
  }
  .preview-trigger:hover {
    color: var(--color-ink-bright);
  }
  .preview-trigger:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  .chip-x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  [popover].attachment-preview {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 4px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
  }
  .attachment-preview img {
    display: block;
    max-width: min(280px, 80vw);
    max-height: min(200px, 35vh);
    object-fit: contain;
  }
</style>
