<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { portal } from "$lib/portal";

  let {
    anchor,
    opener,
    busy = false,
    autoFocus = true,
    draftText,
    onopenplan,
    onsendchanges,
    onreview,
    onclose,
  }: {
    anchor: DOMRect;
    opener?: HTMLElement;
    busy?: boolean;
    autoFocus?: boolean;
    draftText: string;
    onopenplan: () => void;
    onsendchanges: (text: string) => void;
    onreview: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();
  let draftEl = $state<HTMLTextAreaElement>();
  let pos = $state<{ left: number; top: number } | null>(null);
  let editing = $state(false);
  let draft = $state("");
  const canSend = $derived(draft.trim().length > 0 && !busy);

  $effect(() => {
    const node = el;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const below = anchor.bottom + 4;
    const above = anchor.top - r.height - 4;
    const top = below + r.height + margin > window.innerHeight && above > margin ? above : below;
    const left = Math.min(anchor.left, window.innerWidth - r.width - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    if (editing) draftEl?.focus();
    else if (autoFocus) items()[0]?.focus();
  });

  $effect(() => {
    if (!editing) draft = draftText;
  });

  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".pgm-item")) : [];
  }

  function onNav(e: KeyboardEvent) {
    if (editing) return;
    const list = items().filter((item) => !item.disabled);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const fwd = (i + 1) % list.length;
    const back = (i - 1 + list.length) % list.length;
    let next: number;
    if (e.key === "ArrowDown") next = fwd;
    else if (e.key === "ArrowUp") next = back;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") next = e.shiftKey ? back : fwd;
    else return;
    e.preventDefault();
    list[next]!.focus();
  }

  function openEditor() {
    draft = draftText;
    editing = true;
  }

  function cancelEditor() {
    editing = false;
  }

  function resetDraft() {
    draft = draftText;
    draftEl?.focus();
  }

  function sendDraft() {
    if (!canSend) return;
    onsendchanges(draft);
  }

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointer(e: Event) {
      const target = e.target as Node;
      if (el && !el.contains(target) && !opener?.contains(target)) onclose();
    }
    function onScroll() {
      if (!editing) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  use:portal
  class="pg-menu"
  class:editing
  role={editing ? "dialog" : "menu"}
  tabindex="-1"
  aria-label={m.plangate_menu_label()}
  style="left:{pos?.left ?? anchor.left}px;top:{pos?.top ?? anchor.bottom + 4}px"
  onkeydown={onNav}
>
  {#if editing}
    <div class="pgm-editor">
      <label class="pgm-label" for="plan-repair-draft">{m.plangate_menu_editor_label()}</label>
      <textarea
        bind:this={draftEl}
        id="plan-repair-draft"
        bind:value={draft}
        rows="10"
        disabled={busy}></textarea>
      <div class="pgm-actions">
        <button class="pgm-small primary" type="button" disabled={!canSend} onclick={sendDraft}>
          {busy ? m.common_loading() : m.plangate_menu_editor_send()}
        </button>
        <button class="pgm-small" type="button" disabled={busy} onclick={resetDraft}>
          {m.plangate_menu_editor_reset()}
        </button>
        <button class="pgm-small" type="button" disabled={busy} onclick={cancelEditor}>
          {m.common_cancel()}
        </button>
      </div>
    </div>
  {:else}
    <button class="pgm-item" type="button" role="menuitem" tabindex="-1" onclick={onopenplan}>
      <span class="pgm-icon" aria-hidden="true">▣</span>{m.plangate_menu_open_plan()}
    </button>
    <button
      class="pgm-item primary"
      type="button"
      role="menuitem"
      tabindex="-1"
      disabled={busy}
      aria-busy={busy}
      onclick={openEditor}
    >
      <span class="pgm-icon" aria-hidden="true">↵</span>{m.plangate_menu_send_changes()}
    </button>
    <button
      class="pgm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      disabled={busy}
      aria-busy={busy}
      onclick={onreview}
    >
      <span class="pgm-icon" aria-hidden="true">↻</span>{m.plangate_menu_rereview()}
    </button>
    <div class="pgm-note">
      <strong>{m.plangate_menu_why()}</strong>
      <span>{m.plangate_menu_why_body()}</span>
    </div>
  {/if}
</div>

<style>
  .pg-menu {
    position: fixed;
    z-index: 60;
    width: min(340px, calc(100vw - 16px));
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--color-bg) 70%, transparent);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pg-menu.editing {
    width: min(520px, calc(100vw - 16px));
  }
  .pg-menu:focus {
    outline: none;
  }
  .pgm-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 9px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .pgm-item:hover:not(:disabled),
  .pgm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .pgm-item.primary {
    color: var(--color-amber);
  }
  .pgm-item:disabled {
    cursor: progress;
    color: var(--color-faint);
  }
  .pgm-icon {
    width: 1em;
    flex-shrink: 0;
    color: currentColor;
    font-size: var(--fs-meta);
    text-align: center;
  }
  .pgm-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
  }
  .pgm-label {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  textarea {
    width: 100%;
    min-height: 190px;
    resize: vertical;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    line-height: 1.4;
    padding: 9px 10px;
  }
  textarea:focus {
    border-color: var(--color-line-bright);
    outline: none;
  }
  textarea:disabled {
    color: var(--color-faint);
  }
  .pgm-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pgm-small {
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .pgm-small:hover:not(:disabled),
  .pgm-small:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .pgm-small.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .pgm-small:disabled {
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
  }
  .pgm-note {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 3px 2px;
    padding: 9px 8px 8px;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.35;
  }
  .pgm-note strong {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  /* 44px touch targets on coarse pointers (matches SlashCommandMenu/AddRepoMenu). */
  @media (max-width: 768px) {
    .pgm-item,
    .pgm-small {
      min-height: 44px;
    }
  }
</style>
