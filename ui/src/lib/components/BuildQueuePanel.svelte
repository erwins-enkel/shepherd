<script lang="ts">
  import type { BuildQueue, BuildStep, BuildStepStatus } from "$lib/types";
  import { getBuildQueue, putBuildQueue, approveBuildQueue } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    enabled,
    queue,
    onbootstrap,
  }: {
    sessionId: string;
    /** Whether the build-queue feature flag is on for this repo. */
    enabled: boolean;
    /** The current queue from the store (null = not yet loaded). */
    queue: BuildQueue | null;
    /** Called after a bootstrap GET to seed the store. */
    onbootstrap: (q: BuildQueue) => void;
  } = $props();

  // Bootstrap from the server on mount / session change.
  $effect(() => {
    const id = sessionId;
    let alive = true;
    getBuildQueue(id)
      .then((q) => {
        if (!alive) return;
        onbootstrap(q);
      })
      .catch(() => {
        /* best-effort; WS events will populate it */
      });
    return () => {
      alive = false;
    };
  });

  // Derived: show the panel when the flag is on OR there's already a queue with steps.
  const visible = $derived(enabled || (queue !== null && queue.steps.length > 0));
  const steps = $derived(queue?.steps ?? []);
  const approved = $derived(queue?.approved ?? false);

  // ------------- edit helpers -------------

  /** Commit the current steps array to the server.
   *  Passes the full array; the server preserves status by id. */
  async function commit(draft: BuildStep[]) {
    try {
      const updated = await putBuildQueue(
        sessionId,
        draft.map((s) => ({ id: s.id, title: s.title, detail: s.detail, status: s.status })),
      );
      onbootstrap(updated);
    } catch {
      /* server error: leave the optimistic draft; WS will re-sync eventually */
    }
  }

  function addStep() {
    const newStep: BuildStep = {
      id: crypto.randomUUID(),
      title: m.buildqueue_new_step(),
      detail: undefined,
      status: "pending",
      position: steps.length,
    };
    void commit([...steps, newStep]);
  }

  function removeStep(id: string) {
    void commit(steps.filter((s) => s.id !== id));
  }

  function moveStep(id: string, dir: -1 | 1) {
    const idx = steps.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    const copy = [...steps];
    [copy[idx], copy[target]] = [copy[target], copy[idx]];
    void commit(copy);
  }

  function commitTitle(step: BuildStep, newTitle: string) {
    const t = newTitle.trim();
    if (!t) return; // revert: server rejects empty titles; don't send
    if (t === step.title) return; // no change
    void commit(steps.map((s) => (s.id === step.id ? { ...s, title: t } : s)));
  }

  function commitDetail(step: BuildStep, newDetail: string) {
    if (newDetail === (step.detail ?? "")) return;
    void commit(
      steps.map((s) => (s.id === step.id ? { ...s, detail: newDetail || undefined } : s)),
    );
  }

  async function approve() {
    try {
      const updated = await approveBuildQueue(sessionId);
      onbootstrap(updated);
    } catch {
      /* toast would be nice; keep it simple for now */
    }
  }

  // ------------- status badge helpers -------------

  function statusLabel(s: BuildStepStatus): string {
    switch (s) {
      case "pending":
        return m.buildqueue_status_pending();
      case "active":
        return m.buildqueue_status_active();
      case "done":
        return m.buildqueue_status_done();
      case "skipped":
        return m.buildqueue_status_skipped();
    }
  }

  function statusClass(s: BuildStepStatus): string {
    switch (s) {
      case "active":
        return "badge-active";
      case "done":
        return "badge-done";
      case "skipped":
        return "badge-skipped";
      default:
        return "badge-pending";
    }
  }
</script>

{#if visible}
  <div class="bqp" role="region" aria-label={m.buildqueue_panel_title()}>
    <div class="bqp-head">
      <span class="bqp-title">{m.buildqueue_panel_title()}</span>
      {#if approved && steps.length > 0}
        <span class="bqp-approved">{m.buildqueue_approved_header()}</span>
      {/if}
    </div>

    {#if steps.length === 0}
      <p class="bqp-empty">{m.buildqueue_empty()}</p>
    {:else if !approved}
      <!-- Curation mode: editable list -->
      <ol class="bqp-list" aria-label={m.buildqueue_panel_title()}>
        {#each steps as step, i (step.id)}
          <li class="bqp-row">
            <span
              class={["bqp-badge", statusClass(step.status)]}
              aria-label={statusLabel(step.status)}>{statusLabel(step.status)}</span
            >

            <div class="bqp-fields">
              <input
                class="bqp-input bqp-title-input"
                type="text"
                value={step.title}
                aria-label={`${m.buildqueue_step_title_aria()} ${i + 1}`}
                placeholder={m.buildqueue_new_step()}
                onblur={(e) => {
                  commitTitle(step, (e.currentTarget as HTMLInputElement).value);
                }}
                onkeydown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.currentTarget as HTMLInputElement).value = step.title;
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
              <input
                class="bqp-input bqp-detail-input"
                type="text"
                value={step.detail ?? ""}
                aria-label={`${m.buildqueue_step_detail_aria()} ${i + 1}`}
                placeholder={m.buildqueue_step_detail_placeholder()}
                onblur={(e) => {
                  commitDetail(step, (e.currentTarget as HTMLInputElement).value);
                }}
                onkeydown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.currentTarget as HTMLInputElement).value = step.detail ?? "";
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
            </div>

            <div class="bqp-row-actions">
              <button
                type="button"
                class="bqp-btn bqp-move"
                disabled={i === 0}
                onclick={() => moveStep(step.id, -1)}
                aria-label={m.buildqueue_move_up_aria()}
                title={m.buildqueue_move_up_aria()}>▲</button
              >
              <button
                type="button"
                class="bqp-btn bqp-move"
                disabled={i === steps.length - 1}
                onclick={() => moveStep(step.id, 1)}
                aria-label={m.buildqueue_move_down_aria()}
                title={m.buildqueue_move_down_aria()}>▼</button
              >
              <button
                type="button"
                class="bqp-btn bqp-remove"
                onclick={() => removeStep(step.id)}
                aria-label={m.buildqueue_remove_aria()}
                title={m.buildqueue_remove_aria()}>✕</button
              >
            </div>
          </li>
        {/each}
      </ol>

      <div class="bqp-footer">
        <button type="button" class="bqp-btn bqp-add" onclick={addStep}>
          {m.buildqueue_add_step()}
        </button>
        <button type="button" class="bqp-btn bqp-approve" onclick={approve}>
          {m.buildqueue_approve()}
        </button>
      </div>
    {:else}
      <!-- Approved/running: read-only list -->
      <ol class="bqp-list" aria-label={m.buildqueue_panel_title()}>
        {#each steps as step (step.id)}
          <li class="bqp-row bqp-row-readonly">
            <span
              class={["bqp-badge", statusClass(step.status)]}
              aria-label={statusLabel(step.status)}>{statusLabel(step.status)}</span
            >
            <div class="bqp-fields">
              <span class="bqp-step-title">{step.title}</span>
              {#if step.detail}
                <span class="bqp-step-detail">{step.detail}</span>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}

<style>
  .bqp {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .bqp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .bqp-title {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .bqp-approved {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    /* In-progress, not complete — amber. Green is reserved by the design system for
       actionable-complete/READY, which a running queue is not. */
    color: var(--color-amber);
  }

  .bqp-empty {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  .bqp-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .bqp-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .bqp-row-readonly {
    align-items: baseline;
  }

  .bqp-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 2px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .badge-pending {
    color: var(--color-faint);
    background: color-mix(in oklab, var(--color-faint) 12%, transparent);
  }

  .badge-active {
    color: var(--color-amber);
    background: color-mix(in oklab, var(--color-amber) 15%, transparent);
  }

  .badge-done {
    color: var(--color-green);
    background: color-mix(in oklab, var(--color-green) 15%, transparent);
  }

  .badge-skipped {
    color: var(--color-muted);
    background: color-mix(in oklab, var(--color-muted) 10%, transparent);
    text-decoration: line-through;
  }

  .bqp-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .bqp-input {
    width: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    padding: 2px 6px;
    outline: none;
  }

  .bqp-input:focus {
    border-color: var(--color-amber);
  }

  .bqp-title-input {
    font-size: var(--fs-meta);
  }

  .bqp-detail-input {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  .bqp-step-title {
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }

  .bqp-step-detail {
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .bqp-row-actions {
    display: flex;
    gap: 3px;
    flex-shrink: 0;
  }

  .bqp-btn {
    background: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    padding: 1px 5px;
    cursor: pointer;
    line-height: 1.4;
  }

  .bqp-btn:hover:not(:disabled),
  .bqp-btn:focus-visible:not(:disabled) {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }

  .bqp-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .bqp-remove:hover:not(:disabled),
  .bqp-remove:focus-visible:not(:disabled) {
    color: var(--color-red);
    border-color: var(--color-red);
  }

  .bqp-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
  }

  .bqp-approve {
    color: var(--color-amber);
    border-color: var(--color-amber);
    font-weight: 500;
  }

  .bqp-approve:hover,
  .bqp-approve:focus-visible {
    background: color-mix(in oklab, var(--color-amber) 12%, transparent);
    color: var(--color-amber);
  }
</style>
