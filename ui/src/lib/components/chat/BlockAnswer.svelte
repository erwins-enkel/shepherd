<script lang="ts">
  import type { BlockReason } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { blockContext, type BlockCard } from "#lib/chat-timeline.js";

  // A blocked prompt answered from the Chat. Answers are raw keys on the terminal socket, never the
  // reply route (a reply would also release an approved plan). Measured on a live Claude Code
  // permission menu: the option's digit alone selects it, so no Enter follows (an Enter would
  // confirm whatever comes next). A (y/n) prompt reads a line: its letter, then Enter.
  let {
    block,
    card,
    sessionId,
    onkeys,
    onterminal,
  }: {
    block: BlockReason;
    card: BlockCard;
    sessionId: string;
    onkeys?: (seq: string) => boolean;
    onterminal: () => void;
  } = $props();

  // One answer per prompt: a new prompt (another session, or new terminal lines) re-arms.
  const promptKey = $derived(JSON.stringify([sessionId, block.shape, block.tail]));
  let sent = $state<{ key: string; ok: boolean } | null>(null);
  const answered = $derived(sent?.key === promptKey ? sent : null);
  let planOpenFor = $state<string | null>(null);
  const planOpen = $derived(!!block.plan && planOpenFor === block.plan.toolUseId);

  const context = $derived(blockContext(block.tail));
  const choices = $derived(
    card === "menu"
      ? block.options.map((o) => ({ label: o.label, keys: o.send }))
      : [
          { label: m.assistant_chat_yes(), keys: "y\r" },
          { label: m.assistant_chat_no(), keys: "n\r" },
        ],
  );
  const QUOTA = {
    rework: m.hold_quota_rework,
    review: m.hold_quota_review,
    error: m.hold_quota_error,
    plan: m.hold_quota_plan,
  };

  function answer(keys: string) {
    if (answered?.ok) return;
    sent = { key: promptKey, ok: onkeys?.(keys) ?? false };
  }
</script>

{#if card === "quota"}
  <div class="ac-notice" role="status">
    <p>{block.quotaKind ? QUOTA[block.quotaKind]() : m.chat_block_quota()}</p>
    <button type="button" class="gbtn primary" onclick={onterminal}
      >{m.assistant_chat_open_terminal()}</button
    >
  </div>
{:else}
  <div class="ba" role="group" aria-label={m.chat_block_aria()}>
    {#if context.length > 0}
      <pre class="ba-context">{context.join("\n")}</pre>
    {/if}
    {#if block.plan}
      <button
        type="button"
        class="ba-plan-toggle"
        aria-expanded={planOpen}
        onclick={() => (planOpenFor = planOpen ? null : block.plan!.toolUseId)}
        >{planOpen ? m.plan_banner_hide() : m.plan_banner_show()}</button
      >
      {#if planOpen}
        <pre class="ba-plan">{block.plan.plan}</pre>
        {#if block.plan.truncated}<p class="ba-note">{m.plan_banner_truncated()}</p>{/if}
      {/if}
    {/if}
    <div class="ba-options">
      {#each choices as c (c.keys)}
        <button type="button" class="gbtn" disabled={answered?.ok} onclick={() => answer(c.keys)}
          >{c.label}</button
        >
      {/each}
    </div>
    {#if answered && !answered.ok}
      <div class="ac-notice" role="alert">
        <p>{m.chat_block_keys_failed()}</p>
        <button type="button" class="gbtn primary" onclick={onterminal}
          >{m.assistant_chat_open_terminal()}</button
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .ba {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--wash-assistant-edge);
    border-radius: var(--radius-chip);
    min-width: 0;
  }
  /* Terminal lines are untrusted text with box-drawing chrome: shown verbatim, never as markup. */
  .ba-context,
  .ba-plan {
    margin: 0;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ba-plan {
    max-height: 45vh;
    overflow: auto;
    padding: 8px 10px;
    background: var(--color-inset);
    font-size: var(--fs-base);
  }
  .ba-plan-toggle {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .ba-note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .ba-options {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* Option labels can be long ("Yes, and don't ask again for: …"): let them wrap. */
  .ba-options .gbtn {
    max-width: 100%;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
  }
</style>
