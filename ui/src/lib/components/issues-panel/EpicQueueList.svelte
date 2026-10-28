<script lang="ts">
  import { tick, untrack } from "svelte";
  import { flip } from "svelte/animate";
  import { dragHandleZone, dragHandle, SOURCES, TRIGGERS } from "svelte-dnd-action";
  import type { DndEvent } from "svelte-dnd-action";
  import { m } from "#lib/paraglide/messages.js";
  import { reorderEpicQueue } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";

  // The repo's epic queue in the repo run area (#2973): the epics waiting behind the leading one,
  // head first — the head starts once the leader completes or is stopped. Reorder by dragging the
  // grip (pointer, or keyboard: Space, arrows, Space) or with ↑ / ↓. Optimistic: the new order
  // shows at once and the server's answer (or, on failure, the live queue again) replaces it.
  let {
    repoPath,
    queued,
    titleFor,
    onselect,
  }: {
    repoPath: string;
    /** Queued epic parents, head first (runSummary.queued). */
    queued: readonly number[];
    titleFor: (parent: number) => string | null;
    /** Open an epic's detail. */
    onselect: (parent: number) => void;
  } = $props();

  type Item = { id: number };
  const flipDurationMs = 150;
  const uid = $props.id();

  // The order shown while a drag or a request is in flight (or until the next live queue
  // arrives after one); null shows the live queue.
  let local = $state<Item[] | null>(null);
  const items = $derived(local ?? queued.map((id) => ({ id })));
  let dragging = false;
  let inFlight = 0;
  // Only the latest request's outcome may touch the order — an older one is stale.
  let seq = 0;
  // The order the server last confirmed, until a live queue supersedes it — the `queued` prop
  // trails a reorder until the drain re-emits its status.
  let confirmed: readonly number[] | null = null;
  let announce = $state("");
  let listEl = $state<HTMLOListElement>();

  // A fresh live queue replaces the local order once nothing of ours is pending.
  $effect(() => {
    void queued;
    untrack(() => {
      if (!dragging && inFlight === 0) {
        local = null;
        confirmed = null;
      }
    });
  });

  const label = (id: number) => [`#${id}`, titleFor(id)].filter(Boolean).join(" ");
  const sameOrder = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((n, i) => n === b[i]);

  const confirmedItems = () => confirmed?.map((id) => ({ id })) ?? null;

  async function commit(order: number[]) {
    // Dropped in place. Not while a request is pending: its order is not live yet.
    if (inFlight === 0 && sameOrder(order, confirmed ?? queued)) {
      local = confirmedItems();
      return;
    }
    local = order.map((id) => ({ id }));
    const mine = ++seq;
    inFlight++;
    try {
      const res = await reorderEpicQueue(repoPath, order);
      if (mine === seq) {
        confirmed = res.queued;
        local = res.queued.map((id) => ({ id }));
      }
    } catch {
      // Back to the last known server order — the one before the move, unless it changed meanwhile.
      if (mine === seq) local = confirmedItems();
      toasts.info(m.epicqueue_reorder_failed(), { alert: true, key: "epic-queue-reorder-fail" });
    } finally {
      inFlight--;
    }
  }

  // Pointer drags finalize on drop; keyboard drags finalize on every arrow step and end with a
  // DRAG_STOPPED consider — commit once, on the drop.
  function onConsider(e: CustomEvent<DndEvent<Item>>) {
    local = e.detail.items;
    const { source, trigger } = e.detail.info;
    if (source === SOURCES.KEYBOARD && trigger === TRIGGERS.DRAG_STOPPED) drop(e.detail.items);
    else dragging = true;
  }
  function onFinalize(e: CustomEvent<DndEvent<Item>>) {
    local = e.detail.items;
    if (e.detail.info.source === SOURCES.POINTER) drop(e.detail.items);
  }
  function drop(next: Item[]) {
    dragging = false;
    void commit(next.map((i) => i.id));
  }

  async function move(index: number, delta: -1 | 1) {
    const order = items.map((i) => i.id);
    const target = index + delta;
    const id = order[index];
    [order[index], order[target]] = [order[target], order[index]];
    const done = commit(order);
    announce = m.epicqueue_moved({ epic: id, position: target + 1, count: order.length });
    await tick();
    // Keep focus on the moved row: the same button, or its sibling once that one is disabled.
    const row = listEl?.querySelector<HTMLElement>(`[data-epic="${id}"]`);
    const same = row?.querySelector<HTMLButtonElement>(`[data-move="${delta}"]`);
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${-delta}"]`);
    (same && !same.disabled ? same : other)?.focus();
    await done;
  }
</script>

<section class="queue" aria-labelledby="{uid}-head">
  <h4 class="queue-head" id="{uid}-head">{m.epicqueue_heading()}</h4>
  <ol
    bind:this={listEl}
    class="rows"
    aria-label={m.epicqueue_heading()}
    use:dragHandleZone={{ items, flipDurationMs, type: "epic-queue" }}
    onconsider={onConsider}
    onfinalize={onFinalize}
  >
    {#each items as item, i (item.id)}
      <li
        class="row"
        data-epic={item.id}
        aria-label={label(item.id)}
        animate:flip={{ duration: flipDurationMs }}
      >
        <span
          class="grip"
          use:dragHandle
          aria-label={m.epicqueue_drag_aria({ epic: item.id })}
          title={m.epicqueue_drag_aria({ epic: item.id })}>⠿</span
        >
        <span class="pos">{i + 1}.</span>
        <button class="name" type="button" onclick={() => onselect(item.id)}>
          <span class="num">#{item.id}</span>
          <span class="title">{titleFor(item.id) ?? ""}</span>
        </button>
        <button
          class="gbtn move"
          type="button"
          data-move="-1"
          disabled={i === 0}
          aria-label={m.epicqueue_up_aria({ epic: item.id })}
          title={m.epicqueue_up_aria({ epic: item.id })}
          onclick={() => move(i, -1)}>↑</button
        >
        <button
          class="gbtn move"
          type="button"
          data-move="1"
          disabled={i === items.length - 1}
          aria-label={m.epicqueue_down_aria({ epic: item.id })}
          title={m.epicqueue_down_aria({ epic: item.id })}
          onclick={() => move(i, 1)}>↓</button
        >
      </li>
    {/each}
  </ol>
  <p class="note">{m.epicqueue_hint()}</p>
  <p class="sr-only" aria-live="polite">{announce}</p>
</section>

<style>
  .queue {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .queue-head {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-top: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .row:last-child {
    border-bottom: 1px solid var(--color-line);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .grip {
    flex: 0 0 auto;
    color: var(--color-faint);
    cursor: grab;
    user-select: none;
    touch-action: none;
    line-height: 1;
  }
  .grip:active {
    cursor: grabbing;
  }
  .grip:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px var(--color-amber);
  }
  .pos {
    flex: none;
    min-width: 2.5ch;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-align: right;
  }

  /* The epic itself opens its detail. */
  .name {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    padding: 0;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .name:hover .title {
    color: var(--color-ink-bright);
  }
  .name:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .num {
    font-family: var(--font-mono);
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  /* visually-hidden live region (no .sr-only util in app.css) */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in RepoOverview). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 0 6px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  @media (max-width: 768px), (max-height: 600px) {
    .gbtn,
    .grip {
      min-width: 44px;
      min-height: 44px;
    }
    .grip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  }
</style>
