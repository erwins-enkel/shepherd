<script lang="ts">
  import type { BuildQueue, BuildStep, BuildStepStatus } from "$lib/types";
  import { getBuildQueue, putBuildQueue, approveBuildQueue } from "$lib/api";
  import { m } from "$lib/paraglide/messages";
  import { buildQueueCollapse } from "$lib/build-queue-collapse.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

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

  const contentId = $derived(`bqp-content-${sessionId}`);
  const awaitingId = $derived(`bqp-awaiting-${sessionId}`);

  // Curation state: the agent has authored steps and paused for the operator to
  // review + approve. This is a needs-you moment (Design Principle 2), so it gets
  // a distinct amber treatment the calm default states never carry.
  const awaiting = $derived(!approved && steps.length > 0);

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

  // ------------- approved-header derived state -------------

  const allResolved = $derived(
    steps.length > 0 && steps.every((s) => s.status === "done" || s.status === "skipped"),
  );
  const anyStarted = $derived(steps.some((s) => s.status === "active" || s.status === "done"));
  const runState = $derived(allResolved ? "done" : anyStarted ? "running" : "queued");

  const approvalLabel = $derived(
    queue?.approvalKind === "auto"
      ? m.buildqueue_approval_auto()
      : m.buildqueue_approval_operator(),
  );
  const runLabel = $derived(
    runState === "done"
      ? m.buildqueue_run_done()
      : runState === "running"
        ? m.buildqueue_run_running()
        : m.buildqueue_run_queued(),
  );

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
  <div
    class="bqp"
    class:is-awaiting={awaiting}
    role="region"
    aria-label={m.buildqueue_panel_title()}
  >
    <button
      type="button"
      class="bqp-head bqp-collapse-toggle"
      onclick={() => buildQueueCollapse.toggle()}
      aria-expanded={!buildQueueCollapse.collapsed}
      aria-controls={contentId}
      aria-label={buildQueueCollapse.collapsed
        ? m.buildqueue_expand_aria()
        : m.buildqueue_collapse_aria()}
      aria-describedby={awaiting ? awaitingId : undefined}
      title={buildQueueCollapse.collapsed
        ? m.buildqueue_expand_aria()
        : m.buildqueue_collapse_aria()}
      use:coachTarget={"build-queue-collapse"}
    >
      <span class="bqp-title">{m.buildqueue_panel_title()}</span>
      {#if approved && steps.length > 0}
        <span class={["bqp-approved", `bqp-run-${runState}`]}>{approvalLabel} · {runLabel}</span>
      {:else if awaiting}
        <!-- Needs-you chip: mirrors the approved chip's slot so the header always
             narrates queue status. Lives in the always-rendered header, so the
             signal (and its aria-describedby target) survives collapse. -->
        <span class="bqp-awaiting-chip" id={awaitingId}>
          <span class="bqp-awaiting-dot" aria-hidden="true"></span>{m.buildqueue_awaiting_chip()}
        </span>
      {/if}
      <span class="bqp-collapse-glyph" aria-hidden="true"
        >{buildQueueCollapse.collapsed ? "▴" : "▾"}</span
      >
    </button>

    <div class="bqp-content" id={contentId} class:collapsed={buildQueueCollapse.collapsed}>
      {#if steps.length === 0}
        <p class="bqp-empty">{m.buildqueue_empty()}</p>
      {:else if !approved}
        <!-- Curation mode: editable list -->
        <p class="bqp-hint">{m.buildqueue_awaiting_hint()}</p>
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
            <span class="bqp-approve-glyph" aria-hidden="true">▸</span>{m.buildqueue_approve()}
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

  /* Awaiting operator approval: a faint amber wash so the paused panel reads as
     distinct from calm sibling panels without shouting (Design Principle 2). */
  .is-awaiting {
    background: color-mix(in oklab, var(--color-amber) 6%, var(--color-panel));
  }

  /* The whole header is the collapse toggle (mirrors IntegratedEpicRow's
     .row-head), so a click anywhere on the bar expands/collapses — not just
     the ▴/▾ glyph. Button reset; the glyph keeps its boxed look below. */
  .bqp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .bqp-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
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
    /* Color lives on the run-state modifier classes below. */
  }

  /* Needs-you chip: amber (Shepherd's attention hue), sits in the same header
     slot as .bqp-approved. The words carry the meaning; the dot is decoration,
     so the signal never relies on hue alone. */
  .bqp-awaiting-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-amber);
  }

  .bqp-awaiting-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
  }

  /* Run-state modifier colors (design-system rule 4 — tokens only, never literals).
     running = in-progress amber; queued = faint (approved, not started);
     done = slate (finished-but-parked; NOT green — green is reserved for actionable-complete/READY). */
  .bqp-run-running {
    color: var(--color-amber);
  }

  .bqp-run-queued {
    color: var(--color-faint);
  }

  .bqp-run-done {
    color: var(--status-done);
  }

  /* The ▴/▾ glyph: pushed to the right edge, styled like the boxed toggle it
     replaced; brightens when the header is hovered/focused. */
  .bqp-collapse-glyph {
    margin-left: auto;
    flex: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    line-height: 1.4;
    padding: 1px 5px;
  }
  .bqp-head:hover .bqp-collapse-glyph,
  .bqp-head:focus-visible .bqp-collapse-glyph {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }

  .bqp-content {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .bqp-content.collapsed {
    display: none;
  }

  .bqp-empty {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  /* Explains the paused state and what to do. Full-surface amber wash + full
     border (never a side-stripe); ink-bright text keeps the copy legible. */
  .bqp-hint {
    margin: 0;
    padding: 5px 8px;
    border: 1px solid color-mix(in oklab, var(--color-amber) 30%, transparent);
    border-radius: 3px;
    background: color-mix(in oklab, var(--color-amber) 10%, transparent);
    color: var(--color-ink-bright);
    font-size: var(--fs-micro);
    line-height: 1.45;
  }

  .bqp-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* The panel lives in an overflow:hidden flex column (Viewport). Without a
       cap a long queue grows unbounded, crushes the terminal below, and offers
       no scroll target — so touch gestures get trapped. Bound it and let the
       list own its own vertical scroll. */
    max-height: 40vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
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

  /* Emphasized primary: the design system's loudest-action recipe
     (.chip-action.primary) — amber text + amber border + an inner amber glow.
     Deliberately NOT a solid fill: --color-amber flips light↔dark across themes,
     so on-amber text would drop below AA in light theme. Amber text on the panel
     stays contrast-safe in both themes and both high-contrast variants. */
  .bqp-approve {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--color-amber);
    border-color: var(--color-amber);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }

  /* :not(:disabled) keeps specificity on par with the base .bqp-btn hover so this
     later rule wins and the CTA stays amber (never the ink hover). */
  .bqp-approve:hover:not(:disabled),
  .bqp-approve:focus-visible:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 22px -8px var(--color-amber);
  }

  .bqp-approve-glyph {
    font-size: var(--fs-micro);
    line-height: 1;
  }
</style>
