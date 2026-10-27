<script lang="ts">
  import type { ChatEntry } from "#lib/assistant-chat.js";
  import { m } from "#lib/paraglide/messages.js";
  import { clock } from "#lib/activity.js";
  import { steerKindLabel } from "#lib/pulse-text.js";

  // A quiet row between the messages: a background task's notice, or a steer Shepherd typed into
  // the session, folded to its kind (open it for the full text). Plain text, never Markdown: a
  // critic steer quotes the PR's untrusted content.
  let { entry }: { entry: Extract<ChatEntry, { kind: "event" | "steer" }> } = $props();
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
      {#if entry.ts}<span class="ac-steer-time">{clock(entry.ts)}</span>{/if}
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
  .ac-steer summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    list-style: none;
  }
  .ac-steer summary::-webkit-details-marker {
    display: none;
  }
  .ac-steer summary:hover {
    color: var(--color-ink);
  }
  .ac-steer summary:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .ac-steer svg {
    flex: none;
    width: 11px;
    height: 11px;
    transition: transform 0.15s;
  }
  .ac-steer[open] svg {
    transform: rotate(90deg);
  }
  .ac-steer-time {
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }
  .ac-steer-text {
    margin: 6px 0 0 17px;
    padding-left: 10px;
    border-left: 1px solid var(--color-line);
    color: var(--color-ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
