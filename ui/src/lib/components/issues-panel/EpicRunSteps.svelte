<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { agentSlotExplanation } from "#lib/tooltips/explanations.js";
  import type { EpicRunSteps, SlotHolder } from "../epic-panel";
  import EpicRoleBadge from "./EpicRoleBadge.svelte";
  import SlotStepper, { slotCap } from "./SlotStepper.svelte";

  // The run area's three steps side by side (#2620). Leading epic: Now (slot holders) → Next
  // (runSummary.next[0]) → After (its direct successors). Winding-down epic: Now (its own
  // in-flight child) → After (complete / tasks left behind) → Then (who gets the slot next).
  let {
    repoPath,
    steps,
    titleFor,
    onapprove = undefined,
    onopensession = undefined,
  }: {
    /** The repo whose agent-slot cap the Now step's −/+ steps. */
    repoPath: string;
    steps: EpicRunSteps;
    /** Issue title when known (loaded epic children, open issues); null → show the desig. */
    titleFor: (issue: number) => string | null;
    /** Approve the next child — offered inline while the run waits for approval. */
    onapprove?: () => void;
    onopensession?: (sessionId: string) => void;
  } = $props();

  // A holder of the leading epic "leads"; any other epic in flight is, by construction of
  // runSummary, winding down. Label-mode sessions (no epic) get no badge.
  function holderRole(h: SlotHolder) {
    if (h.epicParent == null) return null;
    return h.epicParent === steps.leader ? "leading" : "winding";
  }

  function name(h: SlotHolder): string {
    return h.issueNumber == null ? h.desig : `#${h.issueNumber}`;
  }

  function issueLabel(n: number): string {
    const t = titleFor(n);
    return t ? `#${n} ${t}` : `#${n}`;
  }

  const nextNote = $derived.by(() => {
    if (steps.kind !== "leading" || steps.next == null) return "";
    switch (steps.nextNote) {
      case "after_slot":
        return m.epic_run_next_after_slot({ holder: steps.freedBy ? name(steps.freedBy) : "…" });
      case "approval":
        return m.epic_run_next_approval();
      case "resume":
        return m.epic_run_next_resume();
      default:
        return m.epic_run_next_soon();
    }
  });
</script>

<ol class="steps">
  <li class="step step-now">
    <span class="now-head">
      <span class="step-head" use:statusTip={{ text: agentSlotExplanation(), placement: "bottom" }}
        >{m.epic_run_step_now({
          used: steps.slots.used,
          max: slotCap(repoPath, steps.slots.max),
        })}</span
      >
      <SlotStepper {repoPath} max={steps.slots.max} />
    </span>
    {#if steps.now.length === 0}
      <span class="quiet">{m.epic_run_now_empty()}</span>
    {:else}
      <ul class="holders">
        {#each steps.now as h (h.sessionId)}
          {@const role = holderRole(h)}
          {@const title = h.issueNumber == null ? null : titleFor(h.issueNumber)}
          <li class="holder">
            <span class="line">
              <span class="num">{name(h)}</span>
              {#if h.epicParent != null}
                <span class="faint">{m.epic_run_holder_epic({ parent: h.epicParent })}</span>
              {/if}
              {#if role}<EpicRoleBadge {role} />{/if}
            </span>
            <span class="item-title">{title ?? h.desig}</span>
            {#if onopensession}
              <button class="link" type="button" onclick={() => onopensession(h.sessionId)}
                >{m.epic_run_open_session()}</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </li>

  {#if steps.kind === "leading"}
    <li class="step step-next">
      <span class="step-head">{m.epic_run_step_next()}</span>
      {#if steps.next == null}
        <span class="quiet">{m.epic_run_next_none()}</span>
      {:else}
        <span class="item-title">{issueLabel(steps.next)}</span>
        <span class="note">{nextNote}</span>
        {#if steps.nextNote === "approval" && onapprove}
          <button class="link" type="button" onclick={onapprove}
            >{m.epic_run_approve_inline()}</button
          >
        {/if}
      {/if}
    </li>
    <li class="step">
      <span class="step-head">{m.epic_run_step_after()}</span>
      {#if steps.after.length === 0}
        <span class="quiet">{m.epic_run_after_none()}</span>
      {:else}
        <span class="item-title">{steps.after.map((n) => `#${n}`).join(", ")}</span>
        {#if steps.parallel > 0}
          <span class="note">{m.epic_run_after_parallel({ count: steps.parallel })}</span>
        {/if}
      {/if}
    </li>
  {:else}
    <li class="step">
      <span class="step-head">{m.epic_run_step_after()}</span>
      {#if steps.leftBehind === 0}
        <span class="done">{m.epic_run_winding_complete()}</span>
      {:else}
        <span class="item-title">{m.epic_run_winding_left({ count: steps.leftBehind })}</span>
      {/if}
    </li>
    <li class="step">
      <span class="step-head">{m.epic_run_step_then()}</span>
      {#if steps.handover == null}
        <span class="quiet">{m.epic_run_handover_free()}</span>
      {:else if steps.handover.epic == null}
        <span class="item-title">{m.epic_run_handover_issue({ issue: steps.handover.issue })}</span>
      {:else}
        <span class="item-title"
          >{m.epic_run_handover({ issue: steps.handover.issue, epic: steps.handover.epic })}</span
        >
      {/if}
    </li>
  {/if}
</ol>

<style>
  /* Three step cards side by side; they wrap to a column on a narrow detail. Accents are
     semantic (ui-design-system rule 4): amber = running / holding the slot, green = the ready
     next task, slate = merged / complete. */
  .steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-left-width: 2px;
    border-radius: 2px;
    background: var(--color-panel);
  }
  .step-now {
    border-left-color: var(--status-running);
  }
  .step-next {
    border-left-color: var(--color-green);
  }

  /* The Now head with its −/+ beside the slot count. */
  .now-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .step-head {
    align-self: flex-start;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .step-now .step-head {
    color: var(--status-running);
  }
  .step-next .step-head {
    color: var(--color-green);
  }

  .holders {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .holder {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 5px;
  }

  .num {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
  }

  .item-title {
    overflow: hidden;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note,
  .faint {
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  .quiet {
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }

  .done {
    color: var(--status-done);
    font-size: var(--fs-meta);
  }

  /* Text-link recipe (as IssuesPanel's .retry-link): a real button, styled as inline text. */
  .link {
    align-self: flex-start;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover,
  .link:focus-visible {
    color: var(--color-amber);
    outline: none;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .link {
      min-height: 32px;
    }
  }
</style>
