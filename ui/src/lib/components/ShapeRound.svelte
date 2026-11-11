<script lang="ts">
  import QuestionFormBlock from "./blocks/QuestionFormBlock.svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { elapsed } from "#lib/format.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import type { RawAnswer, ShapeRound } from "#lib/types.js";
  import {
    shapeRemainingMs,
    shapeTipIndex,
    shapeWait,
    SHAPE_TIMEOUT_MS,
    SHAPE_TIP_COUNT,
    type ShapeFailure,
  } from "./new-task/shape";

  // One component, three states, because they occupy the same slot in the New Task card and the
  // operator reads them as one thing: the round is running, it failed, or here it is.
  let {
    status,
    round,
    errorKey,
    elapsedMs = 0,
    engineLabel,
    onuse,
    ondismiss,
    onshowengine,
    onretry,
    onstartplain,
  }: {
    status: "running" | "ready" | "error";
    round?: ShapeRound;
    errorKey?: ShapeFailure;
    /** How long the running round has been going; drives the clock, the copy and the hints. */
    elapsedMs?: number;
    /** The CLI and model the round was started with ("Claude Code · Opus (latest)"). */
    engineLabel: string;
    onuse: (answers: RawAnswer[]) => void;
    ondismiss: () => void;
    /** Point the operator at the engine setting the round runs on. */
    onshowengine: () => void;
    onretry: () => void;
    /** Drop the round and start the task with the rough prompt as it stands. */
    onstartplain: () => void;
  } = $props();

  const errorCopy = $derived.by(() => {
    if (errorKey === "spawn-failed") return m.shape_err_spawn_failed();
    if (errorKey === "unavailable") return m.shape_err_unavailable();
    if (errorKey === "empty-prompt") return m.shape_err_empty_prompt();
    if (errorKey === "compose") return m.shape_err_compose();
    return m.shape_err_timeout();
  });
  // Only a round that never came back is worth another go or a plain start from here; the other
  // failures name their own fix (a key, a prompt, the answers).
  const errorRecoverable = $derived(errorKey === "timeout" || errorKey === "spawn-failed");

  const wait = $derived(shapeWait(elapsedMs));
  // The live region carries the wait's phase only. The ticking time sits in the clock, which is
  // aria-hidden, so a screen reader hears a change three times per round, not once a second.
  const waitCopy = $derived(
    wait === "closing"
      ? m.shape_wait_closing()
      : wait === "long"
        ? m.shape_wait_long()
        : m.shape_running(),
  );
  const clock = $derived(
    wait === "closing"
      ? m.shape_clock_remaining({ remaining: elapsed(0, shapeRemainingMs(elapsedMs)) })
      : elapsed(0, elapsedMs),
  );

  let tipOffset = $state(0);
  const tipIndex = $derived(shapeTipIndex(elapsedMs, tipOffset));
  // Facts about the round, not filler: each one is true of every round (see src/task-shape.ts).
  // The array's length must stay SHAPE_TIP_COUNT.
  const tipCopy = $derived(
    [
      m.shape_tip_questions(),
      m.shape_tip_no_session(),
      m.shape_tip_brief(),
      m.shape_tip_deadline({ minutes: SHAPE_TIMEOUT_MS / 60_000 }),
    ][tipIndex],
  );

  const engineTip = $derived<TooltipExplanation>({
    title: m.shape_engine_tip_title(),
    summary: m.shape_engine_tip_summary({ engine: engineLabel }),
    sections: [
      { label: m.shape_engine_tip_change_label(), text: m.shape_engine_tip_change() },
      { label: m.shape_engine_tip_effect_label(), text: m.shape_engine_tip_effect() },
      { label: m.shape_engine_tip_default_label(), text: m.shape_engine_tip_default() },
      { label: m.shape_engine_tip_cost_label(), text: m.shape_engine_tip_cost() },
    ],
    footer: [m.shape_engine_tip_click()],
  });

  // The briefing's outline while it is being written: the four sections the brief will carry.
  const skeleton = $derived([
    { label: m.shape_s_problem(), bars: [62, 24] },
    { label: m.shape_s_outcome(), bars: [44, 30] },
    { label: m.shape_s_constraints(), bars: [28, 38] },
    { label: m.shape_s_nongoals(), bars: [36] },
  ]);

  const bullets = (items: string[]) => items.filter((s) => s.trim() !== "");
</script>

<section class="shape" class:ready={status === "ready"} aria-label={m.shape_heading()}>
  <div class="shape-head">
    {#if status !== "error"}
      <svg
        class="shape-glyph"
        class:turning={status === "running"}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path
          d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"
        />
      </svg>
    {/if}
    <span class="shape-title">{m.shape_heading()}</span>
    <button
      type="button"
      class="shape-engine"
      aria-label={m.shape_engine_aria({ engine: engineLabel })}
      use:statusTip={{ text: engineTip, still: true, navigates: true }}
      onclick={onshowengine}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><path d="M4 17l6-5-6-5M12 19h8" /></svg
      >
      <span class="shape-engine-name">{engineLabel}</span>
    </button>
    {#if status === "ready" && round}
      <span class="shape-meta">
        {m.shape_questions_count({ count: round.block.questions.length })}
      </span>
    {/if}
    {#if status === "running"}
      <span class="shape-clock" class:closing={wait === "closing"} aria-hidden="true">{clock}</span>
    {/if}
    <button type="button" class="shape-dismiss" onclick={ondismiss}
      >{status === "running" ? m.common_cancel() : m.shape_discard()}</button
    >
  </div>

  {#if status === "running"}
    <div class="shape-bar" aria-hidden="true"></div>
    <p class="shape-status" class:closing={wait === "closing"} role="status">{waitCopy}</p>
    {#if wait === "closing"}
      <div class="shape-actions">
        <button type="button" class="gbtn" onclick={onstartplain}>{m.shape_start_plain()}</button>
      </div>
    {/if}
    <div class="shape-skeleton" aria-hidden="true">
      <span class="shape-kicker">{m.shape_skeleton_label()}</span>
      <div class="shape-skeleton-rows">
        {#each skeleton as row, r (row.label)}
          <span class="shape-skeleton-label">{row.label}</span>
          <span class="shape-skeleton-bars">
            {#each row.bars as width, b (b)}
              <span
                class="shape-sk"
                style:width="{width}%"
                style:animation-delay="{(r * 2 + b) * 150}ms"
              ></span>
            {/each}
          </span>
        {/each}
      </div>
    </div>
    <div class="shape-tips">
      <span class="shape-kicker">{m.shape_tips_label()}</span>
      <p class="shape-tip">{tipCopy}</p>
      <span class="shape-pager">
        <button
          type="button"
          class="shape-page"
          aria-label={m.shape_tip_prev_aria()}
          onclick={() => tipOffset--}>‹</button
        >
        <span class="shape-page-pos" aria-hidden="true">{tipIndex + 1}/{SHAPE_TIP_COUNT}</span>
        <button
          type="button"
          class="shape-page"
          aria-label={m.shape_tip_next_aria()}
          onclick={() => tipOffset++}>›</button
        >
      </span>
    </div>
  {:else if status === "error"}
    <p class="shape-status shape-status-error" role="alert">{errorCopy}</p>
    {#if errorRecoverable}
      <div class="shape-actions">
        <button type="button" class="gbtn" onclick={onretry}>{m.shape_retry()}</button>
        <button type="button" class="gbtn" onclick={onstartplain}>{m.shape_start_plain()}</button>
      </div>
    {/if}
  {:else if round}
    <dl class="shape-draft">
      {#each [[m.shape_s_problem(), round.draft.problem], [m.shape_s_outcome(), round.draft.outcome]] as [label, body] (label)}
        {#if body.trim()}
          <dt>{label}</dt>
          <dd>{body}</dd>
        {/if}
      {/each}
      {#each [[m.shape_s_constraints(), bullets(round.draft.constraints)], [m.shape_s_nongoals(), bullets(round.draft.nonGoals)]] as [label, items] (label)}
        {#if items.length}
          <dt>{label}</dt>
          <dd>
            <ul>
              {#each items as item (item)}<li>{item}</li>{/each}
            </ul>
          </dd>
        {/if}
      {/each}
    </dl>
    <!-- The plan gate's own question form, in callback mode: no session exists yet, so the answers
         come back here instead of being posted to one. -->
    <QuestionFormBlock block={round.block} onanswer={onuse} submitLabel={m.shape_use_brief()} />
  {/if}
</section>

<style>
  .shape {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  /* The questions just arrived: the border lights up twice so the eye finds them. */
  .shape.ready {
    animation: shape-arrive 1.1s ease-in-out 2;
  }
  .shape-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .shape-glyph {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-amber);
  }
  .shape-glyph.turning {
    animation: shape-turn 2.4s linear infinite;
  }
  .shape-title {
    font-size: var(--fs-base);
    color: var(--color-ink);
    font-weight: 500;
    white-space: nowrap;
  }
  /* The engine the round runs on, always in view; hover explains, a click shows the setting. */
  .shape-engine {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 22px;
    padding: 0 7px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .shape-engine svg {
    width: 11px;
    height: 11px;
    flex-shrink: 0;
  }
  .shape-engine-name {
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-bottom: 1px dashed var(--color-line-bright);
  }
  .shape-engine:hover {
    border-color: var(--color-amber);
    color: var(--color-ink);
  }
  .shape-engine:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .shape-meta {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    white-space: nowrap;
  }
  .shape-clock {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    white-space: nowrap;
  }
  .shape-clock.closing {
    color: var(--color-amber);
  }
  .shape-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    white-space: nowrap;
  }
  .shape-clock + .shape-dismiss {
    margin-left: 0;
  }
  .shape-dismiss:hover {
    color: var(--color-ink);
    text-decoration: underline;
  }
  /* Indeterminate: the server reports nothing until the round is done, so the bar says "working",
     never "how far". */
  .shape-bar {
    position: relative;
    height: 2px;
    overflow: hidden;
    background: var(--color-line);
  }
  .shape-bar::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 28%;
    background: linear-gradient(90deg, transparent, var(--color-amber), transparent);
    animation: shape-sweep 1.6s ease-in-out infinite;
  }
  .shape-status {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .shape-status.closing {
    color: var(--color-amber);
  }
  .shape-status-error {
    color: var(--color-red);
  }
  .shape-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .shape-kicker {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .shape-skeleton {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .shape-skeleton-rows {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 7px 12px;
    align-items: center;
  }
  .shape-skeleton-label {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .shape-skeleton-bars {
    display: flex;
    gap: 6px;
  }
  .shape-sk {
    height: 6px;
    border-radius: 1px;
    background: linear-gradient(
      90deg,
      var(--color-line) 25%,
      var(--color-line-bright) 50%,
      var(--color-line) 75%
    );
    background-size: 200% 100%;
    animation: shape-shimmer 1.8s linear infinite;
  }
  .shape-tips {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .shape-tips .shape-kicker {
    padding-top: 2px;
  }
  .shape-tip {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
    /* Two lines reserved, so a shorter hint does not make the panel jump. */
    min-height: 3em;
  }
  .shape-pager {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .shape-page {
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1;
    cursor: pointer;
  }
  .shape-page:hover {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
  }
  .shape-page:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .shape-page-pos {
    min-width: 2.2em;
    text-align: center;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  /* Canonical .gbtn recipe (scoped per-component; see /design-system). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .shape-draft {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .shape-draft dt {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .shape-draft dd {
    margin: 0 0 4px 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .shape-draft ul {
    margin: 0;
    padding-left: 18px;
  }
  /* All of this motion is decoration over a ticking clock: the global reduced-motion guard
     (app.css) stills it, and the clock and the copy still say the round is running. */
  @keyframes shape-turn {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes shape-sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(380%);
    }
  }
  @keyframes shape-shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }
  @keyframes shape-arrive {
    0%,
    100% {
      border-color: var(--color-line);
    }
    35% {
      border-color: var(--color-amber);
    }
  }
</style>
