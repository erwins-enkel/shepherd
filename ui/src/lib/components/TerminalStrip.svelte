<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { displayStatus } from "#lib/display-status.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import StatusPip from "./StatusPip.svelte";

  // The session column folded away by the "talk" assistant layout (assistant-layout.svelte.ts):
  // a slim strip naming the session it hides, and one click to unfold it. It renders only while
  // folded, so +page.svelte can mount it unconditionally (its <template> sits near fallow's bar).
  let {
    folded,
    session,
    workingBlocked,
    backgroundBusy,
    onunfold,
  }: {
    folded: boolean;
    /** The selected local session, or null (a lens, the backlog, a remote session). */
    session: Session | null;
    workingBlocked: Record<string, boolean>;
    backgroundBusy: Record<string, boolean>;
    onunfold: () => void;
  } = $props();

  const status = $derived(session ? displayStatus(session, workingBlocked, backgroundBusy) : null);
  const label = $derived(
    session
      ? m.assistant_layout_unfold_session({ desig: session.desig, name: session.name })
      : m.assistant_layout_unfold(),
  );
</script>

{#if folded}
  <button
    type="button"
    class="terminal-strip"
    aria-label={label}
    onclick={onunfold}
    use:statusTip={{
      text: label,
      placement: "right",
      stopClickPropagation: false,
      pinOnClick: false,
    }}
  >
    <span class="chev" aria-hidden="true">›</span>
    {#if session && status}
      <StatusPip {status} />
      <span class="name" aria-hidden="true"
        ><span class="name-desig">{session.desig}</span> · {session.name}</span
      >
    {/if}
  </button>
{/if}

<style>
  /* Same chrome as the herd's reopen tab (+page.svelte .reopen-tab): a full-height panel button. */
  .terminal-strip {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    overflow: hidden;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    color: var(--color-faint);
    font: inherit;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .terminal-strip:hover {
    color: var(--color-ink);
  }
  .terminal-strip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .chev {
    font-size: var(--fs-lg);
    line-height: 1;
  }
  /* Read bottom-to-top, like a spine on a shelf. */
  .name-desig {
    font-family: var(--font-mono);
  }
  .name {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    white-space: nowrap;
    min-height: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    color: var(--color-muted);
  }
  .terminal-strip:hover .name {
    color: var(--color-ink);
  }
</style>
