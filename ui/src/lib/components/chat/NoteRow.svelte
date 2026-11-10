<script lang="ts">
  import type { ChatEntry } from "#lib/assistant-chat.js";
  import { m } from "#lib/paraglide/messages.js";
  import { steerKindLabel } from "#lib/pulse-text.js";

  // A quiet row between the messages: a background task's notice, or a steer Shepherd typed into
  // the session, folded to its kind (open it for the full text). Plain text, never Markdown: a
  // critic steer quotes the PR's untrusted content.
  let {
    entry,
    time = null,
  }: {
    entry: Extract<ChatEntry, { kind: "event" | "steer" }>;
    /** The row's clock time: a steer names it in its marker; an event's sits in the gutter. */
    time?: string | null;
  } = $props();
</script>

{#if entry.kind === "steer"}
  <details class="ac-steer">
    <summary>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg
      >
      <span>{m.session_chat_steer_by({ kind: steerKindLabel(entry.steer) })}</span>
      {#if time}<time class="ac-steer-time">{time}</time>{/if}
    </summary>
    <p class="ac-steer-text">{entry.text}</p>
  </details>
{:else}
  <p class="ac-event">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg
    >
    <span>{entry.text}</span>
  </p>
{/if}

<style>
  .ac-event {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  .ac-event svg {
    flex: none;
    width: 11px;
    height: 11px;
    align-self: center;
  }
  .ac-steer {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  /* Shepherd's steer opens a turn: a labelled marker, so the gate is seen doing its job. */
  .ac-steer summary {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-ink);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    list-style: none;
  }
  .ac-steer summary::-webkit-details-marker {
    display: none;
  }
  /* Shepherd writes to the agent, neither the operator nor the agent: its marker sits centered
     between hairlines, apart from both sides of the conversation. */
  .ac-steer summary::before,
  .ac-steer summary::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-line);
  }
  .ac-steer summary::before {
    margin-right: 6px;
  }
  .ac-steer summary::after {
    margin-left: 6px;
  }
  .ac-steer-time {
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }
  .ac-steer summary:hover {
    color: var(--color-ink-bright);
  }
  .ac-steer summary:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .ac-steer svg {
    flex: none;
    color: var(--color-blue);
    width: 11px;
    height: 11px;
    transition: transform 0.15s;
  }
  .ac-steer[open] svg {
    transform: rotate(90deg);
  }
  .ac-steer-text {
    margin: 8px 0 0 17px;
    padding-left: 10px;
    border-left: 1px solid var(--color-line);
    color: var(--color-ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
