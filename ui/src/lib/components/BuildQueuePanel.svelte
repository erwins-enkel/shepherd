<script lang="ts">
  import type { BuildQueue, BuildStep, BuildStepStatus, Session } from "$lib/types";
  import { getBuildQueue, putBuildQueue, approveBuildQueue, replySession } from "$lib/api";
  import { m } from "$lib/paraglide/messages";
  import { buildQueueCollapse } from "$lib/build-queue-collapse.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let {
    sessionId,
    enabled,
    queue,
    onbootstrap,
    sessionStatus,
    planPhase = null,
    planReview = null,
    terminalEnded = false,
    folded = false,
  }: {
    sessionId: string;
    /** Whether the build-queue feature flag is on for this repo. */
    enabled: boolean;
    /** The current queue from the store (null = not yet loaded). */
    queue: BuildQueue | null;
    /** Called after a bootstrap GET to seed the store. */
    onbootstrap: (q: BuildQueue) => void;
    sessionStatus?: Session["status"];
    planPhase?: Session["planPhase"];
    planReview?: "reviewing" | "available" | null;
    terminalEnded?: boolean;
    folded?: boolean;
  } = $props();

  // A primitive derived id keeps queue/store updates from re-triggering bootstrap.
  const currentSessionId = $derived(sessionId);
  // Bootstrap from the server on mount / session change.
  $effect(() => {
    const id = currentSessionId;
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

  /** Above this many steps the meter stops being one-segment-per-step (see `segmented`). */
  const SEGMENT_CAP = 10;

  const steps = $derived(queue?.steps ?? []);
  const approved = $derived(queue?.approved ?? false);

  const contentId = $derived(`bqp-content-${sessionId}`);
  const awaitingId = $derived(`bqp-awaiting-${sessionId}`);

  const allResolved = $derived(
    steps.length > 0 && steps.every((s) => s.status === "done" || s.status === "skipped"),
  );
  const anyStarted = $derived(steps.some((s) => s.status === "active" || s.status === "done"));
  const runState = $derived(allResolved ? "done" : anyStarted ? "running" : "queued");

  // Progress telemetry: the meter reads before a word does. "Resolved" counts a
  // skipped step (the queue is past it), but a skipped segment never paints green
  // — it completed nothing (Four-Light Rule: green is earned, not merely reached).
  const resolvedCount = $derived(
    steps.filter((s) => s.status === "done" || s.status === "skipped").length,
  );
  // One segment per step only while segments stay legible. The panel is 390px wide
  // on a phone and a queue can run to 20+ steps, so past the cap it degrades to a
  // single filled track rather than a row of 2px slivers.
  const segmented = $derived(steps.length > 0 && steps.length <= SEGMENT_CAP);
  const resolvedPct = $derived(steps.length ? (resolvedCount / steps.length) * 100 : 0);

  // Curation state: the agent has authored steps and paused for the operator to
  // review + approve. This is a needs-you moment (Design Principle 2), so it gets
  // a distinct amber treatment the calm default states never carry.
  const awaiting = $derived(!approved && steps.length > 0);
  const planning = $derived(planPhase === "planning");
  const reviewBlocked = $derived(planning && planReview !== null);
  const canApprove = $derived(
    awaiting && !reviewBlocked && !terminalEnded && sessionStatus !== "archived",
  );
  const canStart = $derived(
    approved &&
      steps.length > 0 &&
      runState === "queued" &&
      !reviewBlocked &&
      !terminalEnded &&
      (sessionStatus === "idle" || sessionStatus === "blocked" || sessionStatus === "done"),
  );
  const actionable = $derived(canApprove || canStart);
  let action = $state<{ busy: boolean; feedback: "sent" | "failed" | null } | null>(null);
  let actionSessionId: string | undefined;
  $effect(() => {
    if (actionSessionId !== sessionId) {
      actionSessionId = sessionId;
      action = null;
    }
  });
  const visible = $derived(
    action !== null || ((enabled || steps.length > 0) && (!folded || actionable)),
  );
  const actionLabel = $derived(
    canApprove
      ? planning
        ? m.buildqueue_approve_plan()
        : m.buildqueue_approve()
      : m.buildqueue_start(),
  );
  const actionHint = $derived(
    canApprove
      ? planning
        ? m.buildqueue_approve_plan_hint()
        : m.buildqueue_awaiting_hint()
      : planning
        ? m.buildqueue_start_plan_hint()
        : m.buildqueue_start_hint(),
  );

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

  async function sendAction(kind: "approve" | "start") {
    if (action?.busy || (kind === "approve" ? !canApprove : !canStart)) return;
    const id = sessionId;
    action = { busy: true, feedback: null };
    const pending = action;
    try {
      if (kind === "approve") {
        const updated = await approveBuildQueue(id);
        if (action === pending && sessionId === id) onbootstrap(updated);
      } else {
        await replySession(id, m.buildqueue_start_steer());
      }
      pending.feedback = "sent";
    } catch {
      pending.feedback = "failed";
    } finally {
      pending.busy = false;
    }
  }

  // ------------- approved-header derived state -------------

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

  /** Only the two statuses that still render a badge — see `badged`. */
  function statusClass(s: BuildStepStatus): string {
    return s === "skipped" ? "badge-skipped" : "badge-active";
  }

  /** A word-badge only where it says something the spine glyph cannot: a step
   *  that is running now, or one the agent walked past. Pending and done are
   *  already carried by the glyph, the rail position and the header's run state —
   *  repeating them put the least informative column in the most-scanned spot. */
  function badged(s: BuildStepStatus): boolean {
    return s === "active" || s === "skipped";
  }

  function meterClass(s: BuildStepStatus): string {
    switch (s) {
      case "done":
        return "seg-done";
      case "skipped":
        return "seg-skipped";
      case "active":
        return "seg-active";
      default:
        return "seg-pending";
    }
  }

  /** 1-based, zero-padded so the column holds its width as a queue passes step 9. */
  function stepNum(i: number): string {
    return String(i + 1).padStart(2, "0");
  }
</script>

<!-- The spine: a glyph per state plus a hairline rail down to the next step, so the
     list reads as a sequence instead of a stack. It replaces the old badge column,
     which repeated AUSSTEHEND down the most-scanned column of the panel. A snippet
     because both the curation and the read-only list render it — and because it keeps
     the state branch out of the panel template's own complexity budget. The glyph is
     decorative; .bqp-sr carries the status word for assistive tech. -->
{#snippet spine(step: BuildStep, i: number)}
  <span class="bqp-spine" aria-hidden="true">
    {#if step.status === "done"}
      <svg
        class="bqp-check"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg
      >
    {:else if step.status === "skipped"}
      <span class="bqp-dash"></span>
    {:else}
      <span class={["bqp-glyph", step.status === "active" && "is-active"]}></span>
    {/if}
    {#if i < steps.length - 1}<span class="bqp-rail"></span>{/if}
  </span>
  <span class="bqp-sr">{statusLabel(step.status)}</span>
{/snippet}

<!-- Progress telemetry, read before any word: one outlined segment per step while
     they stay legible, a single filled track once a long queue would shrink them to
     slivers. -->
{#snippet meter()}
  <span
    class={["bqp-meter", !segmented && "bqp-meter-bar"]}
    role="img"
    aria-label={m.buildqueue_progress_aria({ done: resolvedCount, total: steps.length })}
  >
    {#if segmented}
      {#each steps as s (s.id)}
        <i class={meterClass(s.status)}></i>
      {/each}
    {:else}
      <i class={["bqp-meter-fill", `fill-${runState}`]} style:width={`${resolvedPct}%`}></i>
    {/if}
  </span>
  <span class="bqp-count">{resolvedCount}/{steps.length}</span>
{/snippet}

<!-- The two step lists live in snippets: they are the bulk of this template and
     keeping them out of it holds the panel's own complexity inside the repo's
     Tier-1 Svelte bar. Curation renders editable field groups, the approved list
     renders them read-only — the spine and the numbering are shared. -->
{#snippet curationList()}
  <ol class="bqp-list" aria-label={m.buildqueue_panel_title()}>
    {#each steps as step, i (step.id)}
      <li class="bqp-row">
        {@render spine(step, i)}

        <div class="bqp-fields">
          <!-- Title and detail are ONE recessed group with one focus ring: the
               operator is editing a step, not two unrelated text boxes. -->
          <div class="bqp-edit">
            <div class="bqp-edit-row">
              <span class="bqp-num" aria-hidden="true">{stepNum(i)}</span>
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
            </div>
            <!-- A textarea, not an input: the detail runs to a sentence or two and
                 a single-line field clipped it mid-word exactly while the operator
                 was reading what to approve. The VALUE stays single-line — Enter
                 commits instead of inserting a newline; only the display wraps. -->
            <textarea
              class="bqp-input bqp-detail-input"
              rows="2"
              value={step.detail ?? ""}
              aria-label={`${m.buildqueue_step_detail_aria()} ${i + 1}`}
              placeholder={m.buildqueue_step_detail_placeholder()}
              onblur={(e) => {
                commitDetail(step, (e.currentTarget as HTMLTextAreaElement).value);
              }}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.currentTarget as HTMLTextAreaElement).blur();
                }
                if (e.key === "Escape") {
                  (e.currentTarget as HTMLTextAreaElement).value = step.detail ?? "";
                  (e.currentTarget as HTMLTextAreaElement).blur();
                }
              }}></textarea>
          </div>
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
{/snippet}

{#snippet readonlyList()}
  <ol class="bqp-list" aria-label={m.buildqueue_panel_title()}>
    {#each steps as step, i (step.id)}
      <li class={["bqp-row", "bqp-row-readonly", `bqp-row-${step.status}`]}>
        {@render spine(step, i)}
        <div class="bqp-fields">
          <div class="bqp-step-line">
            <span class="bqp-num" aria-hidden="true">{stepNum(i)}</span>
            <span class="bqp-step-title">{step.title}</span>
            {#if badged(step.status)}
              <span class={["bqp-badge", statusClass(step.status)]}>{statusLabel(step.status)}</span
              >
            {/if}
          </div>
          {#if step.detail}
            <span class="bqp-step-detail">{step.detail}</span>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/snippet}

{#if visible}
  <div
    class="bqp"
    class:is-awaiting={actionable}
    role="region"
    aria-label={m.buildqueue_panel_title()}
  >
    <div class="bqp-banner" class:collapsed={buildQueueCollapse.collapsed}>
      <button
        type="button"
        class="bqp-head bqp-collapse-toggle"
        onclick={() => buildQueueCollapse.toggle()}
        aria-expanded={!buildQueueCollapse.collapsed}
        aria-controls={contentId}
        aria-label={buildQueueCollapse.collapsed
          ? m.buildqueue_expand_aria()
          : m.buildqueue_collapse_aria()}
        aria-describedby={canApprove ? awaitingId : undefined}
        title={buildQueueCollapse.collapsed
          ? m.buildqueue_expand_aria()
          : m.buildqueue_collapse_aria()}
        use:coachTarget={"build-queue-collapse"}
      >
        <!-- The disclosure glyph leads the row, next to the heading it folds. It used
             to sit at the far right edge — on a wide viewport that stranded it ~1400px
             from the words it acts on. -->
        <span class="bqp-collapse-glyph" aria-hidden="true"
          >{buildQueueCollapse.collapsed ? "▴" : "▾"}</span
        >
        <span class="bqp-title">{m.buildqueue_panel_title()}</span>
        {#if steps.length > 0}{@render meter()}{/if}
        {#if approved && steps.length > 0}
          <span class="bqp-sep" aria-hidden="true">·</span>
          <span class={["bqp-approved", `bqp-run-${runState}`]}>{approvalLabel} · {runLabel}</span>
        {:else if canApprove}
          <!-- Needs-you chip: mirrors the approved chip's slot so the header always
               narrates queue status. Lives in the always-rendered header, so the
               signal (and its aria-describedby target) survives collapse. -->
          <span class="bqp-awaiting-chip" id={awaitingId}>
            <span class="bqp-awaiting-dot" aria-hidden="true"></span>{m.buildqueue_awaiting_chip()}
          </span>
        {/if}
      </button>

      {#if reviewBlocked && steps.length > 0}
        <p class="bqp-notice">
          {planReview === "reviewing"
            ? m.buildqueue_plan_reviewing()
            : m.buildqueue_plan_review_hint()}
        </p>
      {:else if actionable}
        <!-- Action first, sentence second: the button holds one position regardless of
             how long the hint runs, instead of being pushed to the far right edge of a
             multi-line block. -->
        <div class="bqp-action-row">
          <button
            type="button"
            class="bqp-btn bqp-approve"
            disabled={action?.busy}
            onclick={() => sendAction(canApprove ? "approve" : "start")}
          >
            <span class="bqp-approve-glyph" aria-hidden="true">▸</span>{actionLabel}
          </button>
          <p class="bqp-hint">{actionHint}</p>
        </div>
      {/if}
      {#if action?.busy}
        <p class="bqp-notice" role="status">{m.buildqueue_sending()}</p>
      {:else if action?.feedback === "failed"}
        <p class="bqp-notice" role="alert">{m.buildqueue_action_failed()}</p>
      {:else if action?.feedback === "sent"}
        <p class="bqp-notice" role="status">{m.buildqueue_action_sent()}</p>
      {/if}
    </div>

    <div class="bqp-content" id={contentId} class:collapsed={buildQueueCollapse.collapsed}>
      {#if steps.length === 0}
        <p class="bqp-empty">{m.buildqueue_empty()}</p>
      {:else if !approved}
        <!-- Curation mode: editable list -->
        {@render curationList()}

        <div class="bqp-footer">
          <button type="button" class="bqp-btn bqp-add" onclick={addStep}>
            {m.buildqueue_add_step()}
          </button>
        </div>
      {:else}
        <!-- Approved/running: read-only list -->
        {@render readonlyList()}
      {/if}
    </div>
  </div>
{/if}

<style>
  .bqp {
    display: flex;
    flex-direction: column;
    flex: none;
    min-width: 0;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  /* An available approval/start action carries attention in either theme — but a
     routine, auto-approved queue that simply has not started yet is not an alarm.
     A 1px amber top hairline plus a 4% wash replaces the former full amber border
     and 8% wash, so the genuinely-blocked states stay the loudest thing on screen
     (DESIGN.md: calm by default, alarm when earned). The action's own amber outline
     and inset glow do the pointing. */
  .is-awaiting {
    background: color-mix(in oklab, var(--color-amber) 4%, var(--color-panel));
    border-top: 1px solid var(--color-amber);
  }

  .bqp-banner {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px 6px;
  }

  .bqp-banner.collapsed {
    padding-bottom: 8px;
  }

  /* Extend the native toggle over the banner, including hints and padding.
     The action button sits above it; the step list is outside the banner. */
  .bqp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    flex-shrink: 0;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .bqp-head::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
  }
  .bqp-head:focus-visible {
    outline: none;
  }
  .bqp-head:focus-visible::after {
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

  /* Progress meter — telemetry the eye reads before any word. One outlined segment
     per step up to SEGMENT_CAP; past that a single filled track, so a long queue
     can't widen the header past a 390px phone. */
  .bqp-meter {
    flex: none;
    display: flex;
    gap: 2px;
    width: 64px;
    height: 6px;
  }
  .bqp-meter i {
    flex: 1 1 0;
    min-width: 0;
    display: block;
    /* muted, not the quieter line/faint steps: this is a state carrier and has to
       clear the 3:1 non-text floor against --color-panel. */
    border: 1px solid var(--color-muted);
    background: transparent;
  }
  .bqp-meter i.seg-active {
    border-color: var(--color-amber);
    background: var(--color-amber);
  }
  .bqp-meter i.seg-done {
    border-color: var(--color-green);
    background: var(--color-green);
  }
  /* Skipped is resolved, not completed — grey fill, never green (Four-Light Rule). */
  .bqp-meter i.seg-skipped {
    background: var(--color-muted);
  }
  .bqp-meter.bqp-meter-bar {
    display: block;
    border: 1px solid var(--color-muted);
  }
  .bqp-meter-fill {
    display: block;
    height: 100%;
    background: var(--color-amber);
  }
  .bqp-meter-fill.fill-done {
    background: var(--color-green);
  }

  /* Tabular so the count holds its column as the queue ticks (DESIGN.md). */
  .bqp-count {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }

  .bqp-sep {
    flex: none;
    color: var(--color-faint);
    font-size: var(--fs-micro);
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
    color: var(--color-ink-bright);
  }

  .bqp-awaiting-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
  }

  /* Run-state modifier colors (design-system rule 4 — tokens only, never literals).
     running = in-progress amber; queued = readable muted (approved, not started);
     done = slate (finished-but-parked; NOT green — green is reserved for actionable-complete/READY). */
  .bqp-run-running {
    color: var(--color-amber);
  }

  .bqp-run-queued {
    color: var(--color-muted);
  }

  /* Finished, not delivered — so NOT green (green stays reserved for
     actionable-complete/READY). It used to read --status-done (slate), which is
     only 3.0:1 on --color-panel and fails AA for this 10px label; --color-muted
     is the same "quiet" register at 5.3:1. The green check glyph and the green
     meter segments carry "done" visually. */
  .bqp-run-done {
    color: var(--color-muted);
  }

  /* The ▴/▾ glyph: leads the row beside the heading it folds, styled like the boxed
     toggle it replaced; brightens when the header is hovered/focused. */
  .bqp-collapse-glyph {
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
    padding: 0 10px 8px;
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

  .bqp-action-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  /* --color-ink, not ink-bright: the instruction must not outshine the step titles
     it is explaining. Capped to a readable measure instead of running the full
     panel width. */
  .bqp-hint {
    margin: 0;
    flex: 1 1 220px;
    max-width: 84ch;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.5;
    text-wrap: pretty;
  }

  .bqp-notice {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }

  .bqp-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
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
    align-items: stretch;
    gap: 9px;
  }

  /* Screen-reader-only status word. The visible badge now renders only for active
     and skipped steps, so this keeps every row's state announced to AT. */
  .bqp-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* ── the spine ──────────────────────────────────────────────────────────
     A glyph per state plus a 1px rail down to the next step, so the list reads
     as an ordered run rather than a stack of independent rows. */
  .bqp-spine {
    flex: none;
    width: 11px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 4px;
  }

  .bqp-glyph {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1px solid var(--color-muted);
    background: transparent;
  }

  /* Working: the design system's pip pulse — an expanding, fading halo on a
     pseudo-element (transform/opacity only, no animated box-shadow). */
  .bqp-glyph.is-active {
    position: relative;
    border-color: var(--color-amber);
    background: var(--color-amber);
  }
  .bqp-glyph.is-active::after {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: 50%;
    border: 1px solid var(--color-amber);
    animation: bqp-pip 1.5s ease-out infinite;
  }
  @keyframes bqp-pip {
    from {
      transform: scale(1);
      opacity: 0.75;
    }
    to {
      transform: scale(2.7);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bqp-glyph.is-active::after {
      animation: none;
      opacity: 0;
    }
  }

  .bqp-check {
    display: block;
    width: 11px;
    height: 11px;
    color: var(--color-green);
    margin-top: -1px;
  }

  /* Skipped: the ring opens into a bar — the queue walked past it. */
  .bqp-dash {
    flex: none;
    width: 9px;
    height: 1px;
    margin-top: 4px;
    background: var(--color-muted);
  }

  .bqp-rail {
    flex: 1;
    width: 1px;
    margin-top: 4px;
    background: var(--color-faint);
  }

  .bqp-step-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .bqp-num {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
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

  .badge-active {
    color: var(--color-amber);
    background: color-mix(in oklab, var(--color-amber) 15%, transparent);
  }

  .badge-skipped {
    color: var(--color-muted);
    background: color-mix(in oklab, var(--color-muted) 10%, transparent);
  }

  .bqp-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-bottom: 11px;
  }

  .bqp-row:last-child .bqp-fields {
    padding-bottom: 0;
  }

  /* One recessed group per step: the operator is editing a step, not two loose
     text boxes. The border and the focus ring belong to the group, the inputs
     inside it are borderless. */
  .bqp-edit {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 5px 8px 6px;
  }

  .bqp-edit:focus-within {
    border-color: var(--color-amber);
  }

  .bqp-edit-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .bqp-input {
    width: 100%;
    min-width: 0;
    background: transparent;
    border: 0;
    border-radius: 0;
    color: var(--color-ink);
    font: inherit;
    padding: 0;
    outline: none;
  }

  .bqp-title-input {
    font-size: var(--fs-base);
    font-weight: 500;
    color: var(--color-ink-bright);
  }

  .bqp-detail-input {
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
    resize: none;
    /* Progressive enhancement: where field-sizing is supported the box grows with
       the detail instead of hiding line three behind a scrollbar; the cap keeps one
       verbose step from crowding out the rest of the queue. rows="2" is the floor
       and the fallback for engines without it. */
    field-sizing: content;
    min-height: 2lh;
    max-height: 7lh;
  }

  /* The titles ARE the content: up from meta/ink to base/ink-bright. The detail
     steps up from the 10px chrome floor to 11px and takes a measure, instead of
     running ~150 characters across the full panel width. */
  .bqp-step-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 1.35;
  }

  .bqp-step-detail {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.55;
    max-width: 88ch;
    text-wrap: pretty;
  }

  /* A resolved step recedes: plain ink, no half-bold. The green check and the
     meter carry "done" — no second colour needed. */
  .bqp-row-done .bqp-step-title {
    color: var(--color-ink);
    font-weight: 400;
  }

  /* Skipped: the strike belongs on the TITLE — that is what was passed over.
     It used to sit on the badge, which struck through the word "skipped" itself
     and left the title reading as prominently as a live step. */
  .bqp-row-skipped .bqp-step-title {
    color: var(--color-muted);
    font-weight: 400;
    text-decoration: line-through;
  }
  .bqp-row-skipped .bqp-step-detail {
    color: var(--color-muted);
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

  /* Amber outline signals the action; ink text preserves AA on the light wash. */
  .bqp-approve {
    position: relative;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--color-ink-bright);
    border-color: var(--color-amber);
    font-weight: 600;
    font-size: var(--fs-meta);
    padding: 6px 10px;
    min-height: 32px;
    max-width: 100%;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }

  .bqp-approve:hover:not(:disabled),
  .bqp-approve:focus-visible:not(:disabled) {
    color: var(--color-ink-bright);
    border-color: var(--color-amber);
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 22px -8px var(--color-amber);
  }

  .bqp-approve-glyph {
    color: var(--color-amber);
    font-size: var(--fs-micro);
    line-height: 1;
  }

  @media (pointer: coarse), (max-width: 600px) {
    .bqp-approve {
      min-height: var(--mobile-actionbar-hit);
    }
  }
</style>
