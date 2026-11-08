<script lang="ts" module>
  /** A row's long-form explanation, revealed inline by its ⓘ (AutomationDetail's shapes). */
  export interface RowDetail {
    id: string;
    text?: string;
    paragraphs?: string[];
    intro?: string;
    sections?: { title: string; text: string }[];
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import InfoTip from "../InfoTip.svelte";
  import AutomationInfoTip from "../automation-settings/AutomationInfoTip.svelte";
  import AutomationDetail from "../automation-settings/AutomationDetail.svelte";
  import { useOpenDetail } from "./detail-context.svelte.js";

  // THE row of every repo setting (#3443): name, explanation, description, notes, and either a
  // switch or the row's own control. Every section renders its settings through it, so a later
  // per-row addition (#3016's layer badge) lands here once. `field` names the repo-config key(s)
  // the row writes — the hook for that addition (`data-field`).
  let {
    field,
    name,
    glyph = "",
    desc = "",
    detail,
    explanation,
    warn = "",
    warnShown = true,
    task = "",
    indent = false,
    disabled = false,
    disabledTitle,
    checked,
    busy = false,
    pending = false,
    ontoggle,
    control,
    below,
    coach = "",
  }: {
    field: string;
    name: string;
    glyph?: string;
    desc?: string;
    detail?: RowDetail;
    explanation?: TooltipExplanation;
    /** An amber status line (a hold); kept in the DOM, shown while `warnShown`. */
    warn?: string;
    warnShown?: boolean;
    /** This task's own state of a repo default (the plan gate). */
    task?: string;
    /** A setting that only matters under the one above it. */
    indent?: boolean;
    /** Dims the row and locks its switch. */
    disabled?: boolean;
    disabledTitle?: string;
    /** Switch rows: the state, and the flip. */
    checked?: boolean;
    /** The switch pulses: a review this switch governs is running. */
    busy?: boolean;
    /** The switch is locked while its own write is in flight (no dim). */
    pending?: boolean;
    ontoggle?: () => void;
    /** Non-switch rows: the select / input on the right. */
    control?: Snippet;
    /** Full-width content under the description (a button, a list editor). */
    below?: Snippet;
    /** Coach-target id; only the window registers them. */
    coach?: string;
  } = $props();

  const open = useOpenDetail();
</script>

<div class={["rs-row", { disabled, indent }]} data-field={field} use:coachTarget={coach}>
  <div class="rs-meta">
    <div class="rs-name">
      {#if glyph}<span class="rs-glyph" aria-hidden="true">{glyph}</span>{/if}{name}
      {#if detail}
        <AutomationInfoTip
          id={detail.id}
          {name}
          open={open.id === detail.id}
          ontoggle={() => open.toggle(detail.id)}
        />
      {/if}
      {#if explanation}<InfoTip text={explanation} label={explanation.title} />{/if}
    </div>
    {#if desc}<div class="rs-desc">{desc}</div>{/if}
    {#if warn}<div class="rs-warn" role="status" hidden={!warnShown}>{warn}</div>{/if}
    {#if task}<div class="rs-task">{task}</div>{/if}
    {#if detail}
      <AutomationDetail
        id={detail.id}
        open={open.id === detail.id}
        text={detail.text}
        paragraphs={detail.paragraphs}
        intro={detail.intro}
        sections={detail.sections}
      />
    {/if}
    {@render below?.()}
  </div>
  {#if control}
    <div class="rs-control">{@render control()}</div>
  {:else if ontoggle}
    <button
      class={["sw", { on: checked, reviewing: busy }]}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || pending}
      aria-label={name}
      disabled={disabled || pending}
      title={disabled ? disabledTitle : undefined}
      onclick={() => !disabled && ontoggle()}
    >
      <span class="knob"></span>
    </button>
  {/if}
</div>

<style>
  .rs-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .rs-row.indent {
    padding-left: 26px;
  }
  .rs-row.disabled {
    opacity: 0.45;
  }
  .rs-meta {
    flex: 1 1 auto;
    min-width: 0;
  }
  .rs-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .rs-glyph {
    flex: 0 0 auto;
  }
  .rs-desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin-top: 2px;
  }
  .rs-warn {
    font-size: var(--fs-meta);
    color: var(--color-amber);
    margin-top: 2px;
  }
  /* per-task plan-gate reality: amber, shown only when this task is actually gated
     — so a New Task tick reads as active even when the repo default is off */
  .rs-task {
    font-size: var(--fs-micro);
    color: var(--color-amber);
    margin-top: 3px;
  }
  .rs-control {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 55%;
    display: flex;
    justify-content: flex-end;
  }
  /* switch: track + knob, amber when on (active mode, not a completion —
     Four-Light Rule), pulsing while actively reviewing */
  .sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    /* squared track + knob (2px, instrument hardware) — never pill-shaped */
    border-radius: 2px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .sw:disabled {
    cursor: not-allowed;
  }
  .sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 2px;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .sw.on {
    background: var(--color-amber);
  }
  .sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
  .sw.reviewing {
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: sw-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes sw-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
  @media (pointer: coarse) {
    /* a ≥44px hit area around the 30×17 switch without changing its look */
    .sw::after {
      content: "";
      position: absolute;
      inset: -14px -8px;
    }
  }
</style>
