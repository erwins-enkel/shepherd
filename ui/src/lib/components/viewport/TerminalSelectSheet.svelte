<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // Touch has no xterm selection (one-finger drags scroll the terminal), so this
  // sheet lays a plain-text snapshot of the buffer over it in a native-selectable
  // <pre>: the OS's own handles, magnifier and Copy menu do the rest. A snapshot,
  // not live — output keeps streaming into the terminal behind it.
  let {
    text,
    fontSize,
    onclose,
  }: {
    text: string;
    fontSize: number;
    onclose: () => void;
  } = $props();

  let pre: HTMLPreElement | undefined = $state();

  // open on the latest output, where the terminal was showing
  $effect(() => {
    if (pre) pre.scrollTop = pre.scrollHeight;
  });

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onclose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="select-sheet" role="dialog" aria-label={m.viewport_select_text()}>
  <div class="head">
    <span class="hint">{m.viewport_select_text_hint()}</span>
    <button type="button" class="done" onclick={onclose}>{m.viewport_select_text_done()}</button>
  </div>
  <pre bind:this={pre} style:font-size={`${fontSize}px`}>{text}</pre>
</div>

<style>
  .select-sheet {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
  }
  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }
  .hint {
    flex: 1;
    min-width: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .done {
    min-height: 36px;
    padding: 4px 12px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    background: transparent;
    color: var(--color-amber);
    font-size: var(--fs-base);
    cursor: pointer;
    touch-action: manipulation;
  }
  pre {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 6px 10px;
    overflow: auto;
    color: var(--color-ink);
    font-family: var(--font-mono);
    line-height: 1.2;
    white-space: pre;
    /* the terminal mount sets touch-action:none and its ancestors may disable
       selection; this is the one surface where both must be native */
    touch-action: auto;
    -webkit-user-select: text;
    user-select: text;
    -webkit-touch-callout: default;
  }
</style>
