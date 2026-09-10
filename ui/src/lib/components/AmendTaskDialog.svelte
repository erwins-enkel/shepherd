<script lang="ts">
  import type { LivenessState, Session, TaskAmendment } from "$lib/types";
  import { addAmendment, retractAmendment, reviewPr } from "$lib/api";
  import { amendments } from "$lib/amendments.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import GlossaryText from "./GlossaryText.svelte";

  let {
    session,
    liveness,
    onclose,
  }: {
    session: Session;
    /** The session's agent liveness (store.claudeAlive). Absent = not swept yet. */
    liveness?: LivenessState;
    onclose: () => void;
  } = $props();

  /** Mirrors the server's AMENDMENT_MAX_CHARS. The server is the authority (it 400s past this);
   *  this only stops the operator writing into a rejection. */
  const MAX_CHARS = 2000;

  let text = $state("");
  /** Deliver the amendment to the agent as well as recording it. Default ON when there is a live
   *  pane to receive it — the common case is an operator widening scope at a working agent. */
  let steer = $state(true);
  let sending = $state(false);

  const rows = $derived(amendments.forSession(session.id));
  const trimmed = $derived(text.trim());
  const canSend = $derived(trimmed.length > 0 && trimmed.length <= MAX_CHARS && !sending);
  /** The real signal the server acts on is pane liveness, not `session.status`: a WORKING agent is
   *  steerable (and is the primary case here). Absent = not swept yet → keep the option offered. */
  const paneLive = $derived(liveness !== "husk" && liveness !== "stranded");
  /** A critic verdict already stands, so this amendment does not reach it until something
   *  re-reviews — offer that explicitly rather than firing a spawn behind the operator's back. */
  const verdictStands = $derived(!!reviews.map[session.id] && !reviews.isReviewing(session.id));

  function fmt(at: number): string {
    return new Date(at).toLocaleString();
  }

  async function send() {
    if (!canSend) return;
    sending = true;
    try {
      const r = await addAmendment(session.id, trimmed, steer && paneLive);
      text = "";
      // Report what actually happened: a steer that did not land must never read as one that did.
      if (steer && paneLive && !r.steered) toasts.info(m.amend_recorded_not_steered());
      else toasts.info(r.steered ? m.amend_recorded_and_steered() : m.amend_recorded());
    } catch {
      toasts.info(m.amend_failed(), {
        key: `amend-${session.id}`,
        sticky: true,
        alert: true,
      });
    } finally {
      sending = false;
    }
  }

  async function retract(a: TaskAmendment) {
    try {
      await retractAmendment(session.id, a.id);
    } catch {
      toasts.info(m.amend_retract_failed(), {
        key: `amend-retract-${session.id}`,
        sticky: true,
        alert: true,
      });
    }
  }

  async function rereview() {
    try {
      const status = await reviewPr(session.id);
      // 202 {status}: "skipped"/"error" must not read as success.
      if (status === "started") toasts.info(m.amend_rereview_started());
      else
        toasts.info(m.amend_rereview_skipped(), {
          key: `amend-rereview-${session.id}`,
          sticky: true,
          alert: true,
        });
    } catch {
      toasts.info(m.amend_rereview_skipped(), {
        key: `amend-rereview-${session.id}`,
        sticky: true,
        alert: true,
      });
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.amend_title({ name: session.name })}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.amend_title({ name: session.name })}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <p class="lede"><GlossaryText text={m.amend_lede()} /></p>

    <div class="task">
      <span class="micro">{m.amend_original_task()}</span>
      <span class="task-text">{session.prompt}</span>
    </div>

    <textarea
      class="input"
      rows="4"
      bind:value={text}
      maxlength={MAX_CHARS}
      placeholder={m.amend_placeholder()}
      aria-label={m.amend_placeholder()}></textarea>

    <div class="row-head">
      <label class="steer">
        <input type="checkbox" bind:checked={steer} disabled={!paneLive} />
        <span>{paneLive ? m.amend_steer_label() : m.amend_steer_offline()}</span>
      </label>
      <span class="count" class:over={trimmed.length > MAX_CHARS}>
        {trimmed.length} / {MAX_CHARS}
      </span>
    </div>

    <button class="run" type="button" disabled={!canSend} onclick={send}>
      {sending ? m.amend_sending() : m.amend_submit()}
    </button>

    {#if rows.length > 0}
      <div class="row-head">
        <span class="micro">{m.amend_list_title()}</span>
      </div>
      <div class="list">
        {#each rows as a (a.id)}
          <div class="item" class:retracted={a.retractedAt != null}>
            <span class="when">{fmt(a.createdAt)}</span>
            <span class="body">
              {#if a.retractedAt != null}<s>{a.text}</s>{:else}{a.text}{/if}
            </span>
            {#if a.retractedAt == null}
              <button type="button" class="link" onclick={() => retract(a)}>
                {m.amend_retract()}
              </button>
            {:else}
              <span class="tag">{m.amend_retracted()}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if verdictStands}
      <div class="rereview">
        <span>{m.amend_rereview_hint()}</span>
        <button type="button" class="link" onclick={rereview}>{m.amend_rereview()}</button>
      </div>
    {/if}
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
    width: min(560px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .lede {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .task {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .task-text {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    max-height: 4.5em;
    overflow-y: auto;
  }
  .input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    resize: vertical;
  }
  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .steer {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .steer input:disabled {
    cursor: not-allowed;
  }
  .count {
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }
  .count.over {
    color: var(--color-red);
  }
  .run {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
  }
  .run:disabled {
    color: var(--color-faint);
    cursor: not-allowed;
  }
  .list {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
  }
  .item:last-child {
    border-bottom: 0;
  }
  .item.retracted {
    color: var(--color-faint);
  }
  .when {
    flex-shrink: 0;
    color: var(--color-faint);
  }
  .body {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .link {
    background: transparent;
    border: 0;
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    flex-shrink: 0;
  }
  .tag {
    flex-shrink: 0;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .rereview {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
</style>
