<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { providerModels } from "#lib/provider-models.js";
  import { providerEfforts, effortLabel } from "#lib/effort-guidance.js";
  import { schedules, weekdayNames, WORKDAYS, ALL_DAYS } from "#lib/schedules.svelte.js";
  import type { AgentProvider, SandboxProfile, Schedule, ScheduleInput } from "#lib/types.js";

  // Add/edit one operator schedule (#3469). A native <dialog> opened with showModal(): it lives in
  // the top layer — above the automation popover it is opened from — while staying a DOM
  // descendant of that popover, so the popover's click-outside dismissal never fires on a click
  // in here. Escape is kept from reaching the window listeners that would close the popover.
  let {
    repoPath,
    schedule = null,
    onclose,
  }: { repoPath: string; schedule?: Schedule | null; onclose: () => void } = $props();

  type Tri = "inherit" | "on" | "off";
  const triOf = (v: boolean | null): Tri => (v === null ? "inherit" : v ? "on" : "off");
  const boolOf = (t: Tri): boolean | null => (t === "inherit" ? null : t === "on");

  // Seeded once from the schedule being edited (the dialog is re-mounted per open).
  const init = untrack(() => schedule);
  let name = $state(init?.name ?? "");
  let prompt = $state(init?.prompt ?? "");
  let days = $state(init?.days ?? WORKDAYS);
  let times = $state<string[]>(init ? [...init.times] : ["09:00"]);
  let autopilot = $state<Tri>(triOf(init ? init.launch.autopilotEnabled : false));
  let planGate = $state<Tri>(triOf(init?.launch.planGateEnabled ?? null));
  let research = $state(init?.launch.research ?? false);
  let provider = $state<AgentProvider | "">(init?.launch.agentProvider ?? "");
  let model = $state(init?.launch.model ?? "");
  let effort = $state(init?.launch.effort ?? "");
  let sandbox = $state<SandboxProfile | "">(init?.launch.sandboxProfile ?? "");
  let baseBranch = $state(init?.launch.baseBranch ?? "");
  let saving = $state(false);

  const names = weekdayNames(getLocale());
  const effectiveProvider = $derived<AgentProvider>(provider || "claude");
  const valid = $derived(
    name.trim().length > 0 && prompt.trim().length > 0 && days !== 0 && times.length > 0,
  );

  let dlg = $state<HTMLDialogElement>();
  $effect(() => {
    if (dlg && !dlg.open) dlg.showModal();
  });

  function toggleDay(i: number) {
    days ^= 1 << i;
  }

  function setTime(i: number, v: string) {
    times[i] = v;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    saving = true;
    const input: ScheduleInput = {
      repoPath,
      name: name.trim(),
      prompt: prompt.trim(),
      days,
      times: times.filter(Boolean),
      launch: {
        agentProvider: provider || null,
        model: model || null,
        effort: effort || null,
        autopilotEnabled: boolOf(autopilot),
        planGateEnabled: boolOf(planGate),
        research,
        sandboxProfile: sandbox || null,
        baseBranch: baseBranch.trim() || null,
      },
    };
    const ok = await schedules.save(input, schedule?.id);
    saving = false;
    if (ok) onclose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") e.stopPropagation();
  }
</script>

<dialog
  bind:this={dlg}
  class="sched-dlg"
  aria-label={schedule ? m.schedules_edit_title() : m.schedules_add_title()}
  {onclose}
  onkeydown={onKeydown}
>
  <form class="sched-form" onsubmit={submit}>
    <h2 class="title">{schedule ? m.schedules_edit_title() : m.schedules_add_title()}</h2>

    <label class="field">
      <span>{m.schedules_field_name()}</span>
      <input bind:value={name} maxlength="80" required />
    </label>

    <label class="field">
      <span>{m.schedules_field_prompt()}</span>
      <textarea
        bind:value={prompt}
        rows="3"
        maxlength="8000"
        placeholder={m.schedules_field_prompt_placeholder()}
        required></textarea>
    </label>

    <fieldset class="field">
      <legend>{m.schedules_field_days()}</legend>
      <div class="chips">
        {#each names as label, i (i)}
          <button
            type="button"
            class={["chip", { on: days & (1 << i) }]}
            aria-pressed={!!(days & (1 << i))}
            onclick={() => toggleDay(i)}>{label}</button
          >
        {/each}
        <button type="button" class="preset" onclick={() => (days = WORKDAYS)}
          >{m.schedules_preset_workdays()}</button
        >
        <button type="button" class="preset" onclick={() => (days = ALL_DAYS)}
          >{m.schedules_preset_daily()}</button
        >
      </div>
    </fieldset>

    <fieldset class="field">
      <legend>{m.schedules_field_times()}</legend>
      <div class="times">
        {#each times as t, i (i)}
          <span class="time">
            <input
              type="time"
              value={t}
              required
              aria-label={m.schedules_field_time_n({ n: i + 1 })}
              onchange={(e) => setTime(i, e.currentTarget.value)}
            />
            {#if times.length > 1}
              <button
                type="button"
                class="x"
                aria-label={m.schedules_time_remove()}
                onclick={() => times.splice(i, 1)}>✕</button
              >
            {/if}
          </span>
        {/each}
        {#if times.length < 12}
          <button type="button" class="preset" onclick={() => times.push("18:00")}
            >{m.schedules_time_add()}</button
          >
        {/if}
      </div>
      <p class="hint">{m.schedules_times_hint()}</p>
    </fieldset>

    <fieldset class="field grid">
      <legend>{m.schedules_field_launch()}</legend>
      <label>
        <span>{m.automation_autopilot_name()}</span>
        <select bind:value={autopilot}>
          <option value="off">{m.schedules_tri_off()}</option>
          <option value="on">{m.schedules_tri_on()}</option>
          <option value="inherit">{m.schedules_tri_inherit()}</option>
        </select>
      </label>
      <label>
        <span>{m.schedules_field_plan_gate()}</span>
        <select bind:value={planGate}>
          <option value="inherit">{m.schedules_tri_inherit()}</option>
          <option value="on">{m.schedules_tri_on()}</option>
          <option value="off">{m.schedules_tri_off()}</option>
        </select>
      </label>
      <label>
        <span>{m.schedules_field_provider()}</span>
        <select
          bind:value={provider}
          onchange={() => {
            model = "";
            effort = "";
          }}
        >
          <option value="">{m.schedules_default()}</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label>
        <span>{m.schedules_field_model()}</span>
        <select bind:value={model}>
          <option value="">{m.schedules_default()}</option>
          {#each providerModels(effectiveProvider) as id (id)}
            <option value={id}>{id}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{m.schedules_field_effort()}</span>
        <select bind:value={effort}>
          <option value="">{m.schedules_default()}</option>
          {#each providerEfforts(effectiveProvider, model || null) as id (id)}
            <option value={id}>{effortLabel(id)}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{m.schedules_field_sandbox()}</span>
        <select bind:value={sandbox}>
          <option value="">{m.sandbox_profile_inherit_unresolved()}</option>
          <option value="trusted">{m.sandbox_profile_trusted()}</option>
          <option value="standard">{m.sandbox_profile_standard()}</option>
          <option value="autonomous">{m.sandbox_profile_autonomous()}</option>
        </select>
      </label>
      <label>
        <span>{m.schedules_field_base()}</span>
        <input bind:value={baseBranch} placeholder={m.schedules_field_base_placeholder()} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={research} />
        <span>{m.schedules_field_research()}</span>
      </label>
    </fieldset>

    <div class="actions">
      <button type="button" class="ghost" onclick={() => dlg?.close()}>{m.common_cancel()}</button>
      <button type="submit" class="run" disabled={!valid || saving}>{m.schedules_save()}</button>
    </div>
  </form>
</dialog>

<style>
  .sched-dlg {
    width: min(520px, 92vw);
    max-height: 90dvh;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    color: var(--color-ink);
    padding: 16px;
    overflow-y: auto;
  }
  .sched-dlg::backdrop {
    background: var(--color-scrim);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }
  @media (prefers-reduced-transparency: reduce) {
    .sched-dlg::backdrop {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  .sched-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .title {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 0;
    margin: 0;
    padding: 0;
    font-size: var(--fs-meta);
  }
  .field > span,
  legend,
  .grid label > span {
    color: var(--color-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: var(--fs-meta);
    padding: 0;
    margin-bottom: 4px;
  }
  input,
  textarea,
  select {
    font: inherit;
    font-size: var(--fs-meta);
    background: var(--color-inset);
    color: var(--color-ink);
    border: 1px solid var(--color-line);
    padding: 5px 7px;
  }
  textarea {
    font-family: var(--font-mono, monospace);
    resize: vertical;
  }
  .chips,
  .times {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip,
  .preset,
  .x {
    font: inherit;
    font-size: var(--fs-meta);
    border: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-muted);
    padding: 3px 8px;
    cursor: pointer;
  }
  .chip.on {
    border-color: var(--color-blue);
    color: var(--color-blue);
  }
  .preset {
    border-style: dashed;
  }
  .time {
    display: inline-flex;
    gap: 2px;
  }
  .hint {
    margin: 0;
    color: var(--color-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .grid legend {
    grid-column: 1 / -1;
  }
  .grid label {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .grid label.check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    grid-column: 1 / -1;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
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
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .run:disabled {
    opacity: 0.45;
    cursor: default;
  }
  @media (max-width: 768px) {
    .sched-dlg {
      width: 100%;
      max-width: 100%;
      height: 100dvh;
      max-height: 100dvh;
      border: 0;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
