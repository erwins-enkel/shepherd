<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import MergeHandoffNotice from "./MergeHandoffNotice.svelte";
  import { CONFIRM_ARM_MS, isMergeTakeover, type MergeConfirmContext } from "./merge-confirm";

  // The single confirmation in front of every manual merge (#2299). Before this, "confirming" a
  // merge was a second click on the same control within a few seconds — which an ordinary
  // double-click satisfies. This states WHAT is about to be merged, WHERE it lands, and (when the
  // repo's roles file puts someone else on the hook) WHOSE turn it is, and it cannot be answered
  // by the same gesture that opened it.
  let {
    ctx,
    busy = false,
    error,
    onclose,
    onconfirm,
  }: {
    ctx: MergeConfirmContext;
    /** The merge is in flight — the confirm button locks so a repeat cannot start a second one. */
    busy?: boolean;
    /** Server-authored refusal text; on a stale refusal the caller also refreshes `ctx`. */
    error?: string | null;
    onclose: () => void;
    onconfirm: () => void;
  } = $props();

  const takeover = $derived(isMergeTakeover(ctx));

  // Focus starts on Cancel: a held Enter then cancels (once) instead of merging, and the a11y
  // action leaves an already-focused in-dialog control alone.
  let cancelEl = $state<HTMLButtonElement>();
  $effect(() => {
    cancelEl?.focus({ preventScroll: true });
  });

  // Arm delay — see CONFIRM_ARM_MS. Re-armed whenever the dialog re-states itself (a stale
  // refusal replaces `ctx`), so a fresh verdict always gets a fresh deliberate answer.
  let armedAt = $state(Date.now());
  let armed = $state(false);
  $effect(() => {
    void ctx;
    armed = false;
    armedAt = Date.now();
    const t = setTimeout(() => (armed = true), CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  });

  function confirm() {
    // Belt-and-braces against a click that raced the disabled flag: the timestamp is the
    // authority, not the button's rendered state.
    if (busy || Date.now() - armedAt < CONFIRM_ARM_MS) return;
    onconfirm();
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !busy) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={takeover
      ? m.mergeconfirm_title_takeover({ number: ctx.number })
      : m.mergeconfirm_title({ number: ctx.number })}
    use:dialog={{ onclose: () => !busy && onclose() }}
  >
    <span class="micro">{m.mergeconfirm_eyebrow()}</span>
    <h2 class="title">
      {takeover
        ? m.mergeconfirm_title_takeover({ number: ctx.number })
        : m.mergeconfirm_title({ number: ctx.number })}
    </h2>

    <dl class="facts">
      {#if ctx.repoLabel}
        <dt>{m.mergeconfirm_field_repo()}</dt>
        <dd>{ctx.repoLabel}</dd>
      {/if}
      <dt>{m.mergeconfirm_field_pr()}</dt>
      <dd class="mono">#{ctx.number}{ctx.title ? ` ${ctx.title}` : ""}</dd>
      <dt>{m.mergeconfirm_field_target()}</dt>
      <dd class="mono">{ctx.baseBranch ?? m.mergeconfirm_value_unknown()}</dd>
      {#if ctx.mergeMethod}
        <dt>{m.mergeconfirm_field_method()}</dt>
        <dd class="mono">{ctx.mergeMethod}</dd>
      {/if}
      <dt>{m.mergeconfirm_field_branch()}</dt>
      <dd>{m.mergeconfirm_value_branch_deleted()}</dd>
    </dl>

    <MergeHandoffNotice
      handoff={ctx.handoff}
      handoffWho={ctx.handoffWho}
      reviewBlockBy={ctx.reviewBlockBy}
    />

    {#if error}
      <p class="err" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button bind:this={cancelEl} type="button" class="ghost" disabled={busy} onclick={onclose}>
        {m.common_cancel()}
      </button>
      <button type="button" class="run" class:takeover disabled={busy || !armed} onclick={confirm}>
        {busy
          ? m.mergeconfirm_busy()
          : takeover
            ? m.mergeconfirm_confirm_takeover()
            : m.mergeconfirm_confirm()}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    width: min(460px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .title {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
    line-height: 1.35;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: var(--fs-meta);
  }
  .facts dt {
    color: var(--color-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .facts dd {
    margin: 0;
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .err {
    margin: 0;
    color: var(--color-red);
    font-size: var(--fs-meta);
    line-height: 1.4;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  .ghost,
  .run {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  /* Amber, like every other consequential-but-positive action (GitRail's armed merge). The
     takeover variant is not red: it is permitted, it just must be deliberate. */
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* Same amber wash the armed merge items use, so the takeover reads as hot without becoming
     the red danger treatment reserved for destructive actions. */
  .run.takeover {
    background: color-mix(in srgb, var(--color-amber) 14%, var(--color-panel));
  }
  .ghost:disabled,
  .run:disabled {
    opacity: 0.45;
    cursor: default;
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
