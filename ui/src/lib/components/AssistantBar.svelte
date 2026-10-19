<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { getSessionMessages } from "#lib/api.js";
  import { pollWhileVisible } from "#lib/visibility.js";
  import { clock } from "#lib/activity.js";
  import { displayStatus } from "#lib/display-status.js";
  import { chatEntries, type ChatEntry } from "#lib/assistant-chat.js";
  import { newestReply, previewLine, unreadCount } from "#lib/assistant-dock.js";
  import type { AssistantAction } from "#lib/operator-assistant.svelte.js";
  import AssistantMark from "./AssistantMark.svelte";

  // A collapsed assistant in the dock (#1446): one row that says who it is, what it is doing and
  // its newest reply, so the operator can tell which one needs them without opening it. A click
  // opens it (the dock keeps one open at a time). Replies that land while it is collapsed count
  // as new: everything it showed when it collapsed counts as read.
  let {
    repo,
    name,
    scope = null,
    session,
    pending = null,
    failed = null,
    workingBlocked = {},
    backgroundBusy = {},
    onexpand,
  }: {
    /** The repo assistant's repo; null = the global assistant. */
    repo: string | null;
    name: string;
    /** A quiet scope note beside the name (the global one's "All repos"). */
    scope?: string | null;
    session: Session | null;
    pending?: AssistantAction | null;
    failed?: AssistantAction | null;
    workingBlocked?: Record<string, boolean>;
    backgroundBusy?: Record<string, boolean>;
    onexpand: () => void;
  } = $props();

  const POLL_WORKING_MS = 8000;
  /** Enough to find the newest reply behind a few tool notices. */
  const LIMIT = 12;

  const status = $derived(session ? displayStatus(session, workingBlocked, backgroundBusy) : null);
  const pip = $derived(status === "running" ? "working" : status === "blocked" ? "blocked" : null);

  let entries = $state<ChatEntry[] | null>(null);
  /** The newest reply stamp when it collapsed; null until the first load sets it. */
  let baseline: number | null = null;

  // Reload on every status change (a turn ending is when a reply lands); poll only while it works.
  $effect(() => {
    const id = session?.id;
    const working = status === "running";
    if (!id) return;
    let alive = true;
    const load = () =>
      getSessionMessages(id, LIMIT)
        .then((r) => {
          if (!alive) return;
          const next = chatEntries(r.messages);
          baseline ??= newestReply(next);
          entries = next;
        })
        .catch(() => {});
    load();
    const stop = working ? pollWhileVisible(load, POLL_WORKING_MS) : () => {};
    return () => {
      alive = false;
      stop();
    };
  });

  const preview = $derived(entries ? previewLine(entries) : null);
  const unread = $derived(entries && baseline !== null ? unreadCount(entries, baseline) : 0);
  const last = $derived(entries ? newestReply(entries) : 0);

  const stateText = $derived.by(() => {
    if (failed) return m.assistant_bar_failed();
    if (pending === "ensure" && !session) return m.operator_assistant_spawning();
    if (pip === "working") return m.assistant_chat_working();
    if (pip === "blocked") return m.assistant_bar_blocked();
    return null;
  });
  const line = $derived(
    preview ?? (session ? m.assistant_bar_no_reply() : m.assistant_bar_not_started()),
  );
</script>

<button
  type="button"
  class="ab"
  class:starting={!session}
  aria-expanded="false"
  aria-label={m.assistant_bar_open({ name })}
  onclick={onexpand}
>
  <AssistantMark {repo} {pip} />
  <span class="ab-text">
    <span class="ab-head">
      <span class="ab-name">{name}</span>
      {#if stateText}
        <span class="ab-state" class:working={pip === "working"}>{stateText}</span>
      {:else if scope}
        <span class="ab-scope">{scope}</span>
      {/if}
    </span>
    <span class="ab-line" class:fresh={unread > 0}>{line}</span>
  </span>
  {#if unread > 0}
    <span class="ab-new">{m.assistant_bar_unread({ count: unread })}</span>
  {:else if last}
    <span class="ab-time">{clock(last)}</span>
  {/if}
  <svg
    class="ab-chev"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg
  >
</button>

<style>
  /* A quieter sibling of the open card: the same warm family, a step less wash and edge. */
  .ab {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 56px;
    padding: 8px 12px;
    box-sizing: border-box;
    background: color-mix(in srgb, var(--color-amber) 2%, var(--color-panel));
    border: 1px solid color-mix(in srgb, var(--color-amber) 12%, var(--color-line));
    border-radius: var(--radius-chip);
    color: var(--color-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ab:hover {
    background: var(--wash-assistant);
    border-color: var(--wash-assistant-edge);
  }
  .ab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .ab.starting {
    border-style: dashed;
  }
  .ab-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ab-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .ab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .ab-state,
  .ab-scope {
    flex: none;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* Waiting on the operator: the pip carries the red, the words stay bright and legible. */
  .ab-state {
    color: var(--color-ink-bright);
  }
  .ab-state.working {
    color: var(--color-amber);
  }
  .ab-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .ab-line.fresh {
    color: var(--color-ink);
  }
  .ab-time {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  /* Inline Badge recipe (/design-system), on the assistant's edge. */
  .ab-new {
    flex: none;
    padding: 1px 5px;
    border: 1px solid var(--wash-assistant-edge);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font-size: var(--fs-micro);
    white-space: nowrap;
  }
  .ab-chev {
    flex: none;
    width: 14px;
    height: 14px;
    color: var(--color-muted);
  }
  @media (pointer: coarse) {
    .ab {
      min-height: 60px;
    }
  }
</style>
