<script lang="ts">
  import { getContext, onMount, tick, untrack } from "svelte";
  import "./schedule-fields.css";
  import ScheduleIntervalFields from "./ScheduleIntervalFields.svelte";
  import ScheduleEngineFields from "./ScheduleEngineFields.svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { basename } from "#lib/basename.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { effectiveRepoProvider } from "#lib/repo-cli.js";
  import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
  import { selectedProviderCapacity } from "#lib/components/usage-gauges.js";
  import { claudeUsageHoldLikely } from "#lib/provider-capacity.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import {
    schedules,
    weekdayNames,
    upcomingSlots,
    intervalStats,
    SCHEDULE_USAGE,
    WORKDAYS,
    ALL_DAYS,
  } from "#lib/schedules.svelte.js";
  import type {
    AgentProvider,
    SandboxProfile,
    Schedule,
    ScheduleInput,
    ScheduleInterval,
    UsageLimits,
  } from "#lib/types.js";

  // Add/edit one operator schedule (#3469). A native <dialog> opened with showModal(): it lives in
  // the top layer — above the automation popover it is opened from — while staying a DOM
  // descendant of that popover, so the popover's click-outside dismissal never fires on a click
  // in here. Escape and Tab are kept from reaching the window listeners that would close the
  // popover and the Settings card's a11yDialog (#3475): its Escape would close Settings, and its
  // Tab trap would move focus to now-inert Settings controls. The modal dialog owns both.
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
  let times = $state<string[]>(init?.times.length ? [...init.times] : ["09:00"]);
  let cadenceMode = $state<"fixed" | "interval">(init?.interval ? "interval" : "fixed");
  let everyMinutes = $state<ScheduleInterval["everyMinutes"]>(init?.interval?.everyMinutes ?? 15);
  let intervalFrom = $state(init?.interval?.from ?? "08:00");
  let intervalUntil = $state(init?.interval?.until ?? "18:00");
  let allDay = $state(!!init?.interval && init.interval.from === null);
  const interval = $derived<ScheduleInterval | null>(
    cadenceMode === "interval"
      ? {
          everyMinutes,
          from: allDay ? null : intervalFrom,
          until: allDay ? null : intervalUntil,
        }
      : null,
  );
  const stats = $derived(interval ? intervalStats(days, interval) : null);
  let autopilot = $state<Tri>(triOf(init ? init.launch.autopilotEnabled : false));
  let planGate = $state<Tri>(triOf(init?.launch.planGateEnabled ?? null));
  let research = $state(init?.launch.research ?? false);
  let provider = $state<AgentProvider | "">(init?.launch.agentProvider ?? "");
  let model = $state(init?.launch.model ?? "");
  let effort = $state(init?.launch.effort ?? "");
  let sandbox = $state<SandboxProfile | "">(init?.launch.sandboxProfile ?? "");
  let baseBranch = $state(init?.launch.baseBranch ?? "");
  let saving = $state(false);

  const uid = $props.id();
  const mobile = new MediaQuery("(max-width: 768px)");
  type Tab = "what" | "when" | "with";
  const tabs: Tab[] = ["what", "when", "with"];
  let activeTab = $state<Tab>("what");
  let touched = $state({ what: false, when: false, with: false });
  let now = $state(Date.now());
  let promptInput = $state<HTMLTextAreaElement>();
  let promptWidth = $state(0);
  const readUsage = getContext<(() => UsageLimits | null) | undefined>(SCHEDULE_USAGE);
  const limits = $derived(readUsage?.() ?? null);
  const globals = $derived(repoSettingsWindow.globals());
  const defaultProvider = $derived(
    effectiveRepoProvider(
      repoConfig.agentProviderFor(repoPath),
      globals?.defaultAgentProvider ?? "claude",
    ),
  );
  const effectiveProvider = $derived<AgentProvider>(provider || defaultProvider);
  const capacity = $derived(selectedProviderCapacity(limits, effectiveProvider));
  const holdPct = $derived(effectiveProvider === "codex" ? 100 : (globals?.usageHoldPct ?? 80));
  const usagePct = $derived(
    effectiveProvider === "codex"
      ? (capacity?.usedPct ?? 0)
      : Math.max(limits?.session5h?.pct ?? 0, limits?.week?.pct ?? 0),
  );
  const held = $derived(
    effectiveProvider === "codex"
      ? !!capacity && capacity.freePct <= 0
      : !!globals && claudeUsageHoldLikely(limits, globals.usageHoldEnabled, globals.usageHoldPct),
  );
  const verdictKnown = $derived(!!capacity && (effectiveProvider === "codex" || !!globals));
  const names = $derived(weekdayNames(getLocale()));
  const slots = $derived(upcomingSlots(days, times, now, 3, interval));
  const slotLabels = $derived(
    slots.map((at) => {
      const date = new Date(at);
      return `${names[(date.getDay() + 6) % 7]} ${date.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", hour12: false })}`;
    }),
  );
  const whatValid = $derived(name.trim().length > 0 && prompt.trim().length > 0);
  const timesValid = $derived(
    times.length > 0 && times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)),
  );
  const whenValid = $derived(days !== 0 && (interval ? stats !== null : timesValid));
  const valid = $derived(whatValid && whenValid);
  const sandboxOptions = $derived([
    { value: "", label: m.sandbox_profile_inherit_unresolved() },
    { value: "trusted", label: m.sandbox_profile_trusted() },
    { value: "standard", label: m.sandbox_profile_standard() },
    { value: "autonomous", label: m.sandbox_profile_autonomous() },
  ]);
  const advancedSummary = $derived(
    m.schedules_advanced_summary({
      autopilot: triLabel(autopilot),
      planGate: triLabel(planGate),
      sandbox:
        sandbox === "trusted"
          ? m.sandbox_profile_trusted()
          : sandbox === "standard"
            ? m.sandbox_profile_standard()
            : sandbox === "autonomous"
              ? m.sandbox_profile_autonomous()
              : m.schedules_tri_inherit(),
      base: baseBranch.trim() || m.schedules_tri_inherit(),
    }),
  );

  onMount(() => {
    void repoConfig.ensure(repoPath);
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  // A single prompt element survives tab and breakpoint changes; remeasure once visible.
  $effect(() => {
    void [prompt, promptWidth, activeTab, mobile.current];
    tick().then(() => {
      if (!promptInput || !promptInput.clientWidth) return;
      const style = getComputedStyle(promptInput);
      const cap =
        parseFloat(style.lineHeight) * 12 +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        2;
      promptInput.style.height = "auto";
      promptInput.style.height = `${Math.min(promptInput.scrollHeight + 2, cap)}px`;
    });
  });

  function triLabel(value: Tri): string {
    return value === "inherit"
      ? m.schedules_tri_inherit()
      : value === "on"
        ? m.schedules_tri_on()
        : m.schedules_tri_off();
  }

  function tabLabel(tab: Tab): string {
    return tab === "what"
      ? m.schedules_tab_what()
      : tab === "when"
        ? m.schedules_tab_when()
        : m.schedules_tab_with();
  }

  function tabInvalid(tab: Tab): boolean {
    return touched[tab] && (tab === "what" ? !whatValid : tab === "when" ? !whenValid : false);
  }

  function chooseProvider(next: AgentProvider | "") {
    if (provider === next) return;
    provider = next;
    model = "";
    effort = "";
  }

  function tabKey(e: KeyboardEvent, tab: Tab) {
    const i = tabs.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(i + tabs.length - 1) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs[tabs.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    activeTab = next;
    document.getElementById(`${uid}-tab-${next}`)?.focus();
  }

  // Native validation fires before submit, including for controls in a hidden mobile tab.
  function revealInvalid(form: HTMLFormElement) {
    const invalid = (e: Event) => {
      e.preventDefault();
      const field = e.target as HTMLInputElement;
      const tab = field.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
      if (tab) {
        activeTab = tab;
        touched[tab] = true;
      }
      const details = field.closest("details");
      if (details) details.open = true;
      tick().then(() => field.focus());
    };
    form.addEventListener("invalid", invalid, true);
    return () => form.removeEventListener("invalid", invalid, true);
  }

  let dlg = $state<HTMLDialogElement>();
  $effect(() => {
    if (dlg && !dlg.open) dlg.showModal();
  });

  function toggleDay(i: number) {
    days ^= 1 << i;
    touched.when = true;
  }

  function setTime(i: number, v: string) {
    times[i] = v;
    touched.when = true;
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
      times: interval ? [] : times.filter(Boolean),
      interval,
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

  // A native listener, not `onkeydown`: Svelte delegates that to the root, so its
  // stopPropagation would run only after an ancestor's native listener had already fired.
  function keepKeysInside(node: HTMLElement) {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") e.stopPropagation();
    };
    node.addEventListener("keydown", onKeydown);
    return () => node.removeEventListener("keydown", onKeydown);
  }
</script>

<dialog
  bind:this={dlg}
  class="sched-dlg"
  aria-label={schedule ? m.schedules_edit_title() : m.schedules_add_title()}
  {onclose}
  {@attach keepKeysInside}
>
  <form class="sched-form" onsubmit={submit} {@attach revealInvalid}>
    <header class="sched-head">
      <h2 class="title">{schedule ? m.schedules_edit_title() : m.schedules_add_title()}</h2>
      <button type="button" class="repo-chip" use:statusTip={{ text: repoPath }}>
        {basename(repoPath)}
      </button>
      <button
        type="button"
        class="close gbtn"
        aria-label={m.common_close()}
        onclick={() => dlg?.close()}>×</button
      >
    </header>

    {#if mobile.current}
      <div class="section-tabs" role="tablist" aria-label={m.schedules_edit_title()}>
        {#each tabs as tab (tab)}
          <button
            type="button"
            role="tab"
            id={`${uid}-tab-${tab}`}
            aria-controls={`${uid}-panel-${tab}`}
            aria-selected={activeTab === tab}
            aria-label={tabInvalid(tab)
              ? m.schedules_tab_invalid({ tab: tabLabel(tab) })
              : tabLabel(tab)}
            tabindex={activeTab === tab ? 0 : -1}
            class:invalid={tabInvalid(tab)}
            onclick={() => (activeTab = tab)}
            onkeydown={(e) => tabKey(e, tab)}
          >
            {tabLabel(tab)}{#if tabInvalid(tab)}<span aria-hidden="true"> !</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    <div class="sched-body">
      <section
        class="what section"
        data-tab="what"
        id={`${uid}-panel-what`}
        role={mobile.current ? "tabpanel" : undefined}
        aria-labelledby={mobile.current ? `${uid}-tab-what` : undefined}
        hidden={mobile.current && activeTab !== "what"}
        onfocusout={() => (touched.what = true)}
      >
        <label class="field">
          <span>{m.schedules_field_name()}</span>
          <input
            bind:value={name}
            maxlength="80"
            required
            aria-invalid={touched.what && !name.trim()}
          />
        </label>
        <label class="field">
          <span>{m.schedules_field_prompt()}</span>
          <textarea
            bind:this={promptInput}
            bind:clientWidth={promptWidth}
            bind:value={prompt}
            rows="3"
            maxlength="8000"
            placeholder={m.schedules_field_prompt_placeholder()}
            aria-invalid={touched.what && !prompt.trim()}
            required></textarea>
        </label>
        {#if tabInvalid("what")}<p class="error">{m.schedules_required()}</p>{/if}
      </section>

      <section
        class="when section"
        data-tab="when"
        id={`${uid}-panel-when`}
        role={mobile.current ? "tabpanel" : undefined}
        aria-labelledby={mobile.current ? `${uid}-tab-when` : undefined}
        hidden={mobile.current && activeTab !== "when"}
      >
        <h3>{m.schedules_when()}</h3>
        <fieldset class="field">
          <legend>{m.schedules_field_days()}</legend>
          <div class="days">
            {#each names as label, i (i)}
              <button
                type="button"
                class:chosen={!!(days & (1 << i))}
                aria-pressed={!!(days & (1 << i))}
                onclick={() => toggleDay(i)}>{label}</button
              >
            {/each}
          </div>
          <div class="presets">
            <button
              type="button"
              class="text-link"
              onclick={() => {
                days = WORKDAYS;
                touched.when = true;
              }}>{m.schedules_preset_workdays()}</button
            >
            <button
              type="button"
              class="text-link"
              onclick={() => {
                days = ALL_DAYS;
                touched.when = true;
              }}>{m.schedules_preset_daily()}</button
            >
          </div>
          {#if touched.when && !days}<p class="error">{m.schedules_days_required()}</p>{/if}
        </fieldset>
        <div class="cadence-modes" role="group" aria-label={m.schedules_tab_when()}>
          <button
            type="button"
            class="gbtn"
            aria-pressed={cadenceMode === "fixed"}
            onclick={() => (cadenceMode = "fixed")}>{m.schedules_cadence_fixed()}</button
          >
          <button
            type="button"
            class="gbtn"
            aria-pressed={cadenceMode === "interval"}
            onclick={() => (cadenceMode = "interval")}>{m.schedules_cadence_interval()}</button
          >
        </div>
        {#if interval}
          <ScheduleIntervalFields
            bind:everyMinutes
            bind:intervalFrom
            bind:intervalUntil
            bind:allDay
            {stats}
          />
        {:else}
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
                    aria-invalid={touched.when && !t}
                    onchange={(e) => setTime(i, e.currentTarget.value)}
                  />
                  {#if times.length > 1}
                    <button
                      type="button"
                      class="gbtn"
                      aria-label={m.schedules_time_remove()}
                      onclick={() => {
                        times.splice(i, 1);
                        touched.when = true;
                      }}>×</button
                    >
                  {/if}
                </span>
              {/each}
              {#if times.length < 12}
                <button type="button" class="text-link" onclick={() => times.push("18:00")}
                  >{m.schedules_time_add()}</button
                >
              {/if}
            </div>
            {#if touched.when && !timesValid}<p class="error">
                {m.schedules_times_required()}
              </p>{/if}
            <p class="hint">{m.schedules_times_hint()}</p>
          </fieldset>
        {/if}
        <div class="preview">
          <h3>{m.schedules_upcoming()}</h3>
          <p>{slotLabels.length ? slotLabels.join(" · ") : m.schedules_upcoming_empty()}</p>
        </div>
      </section>

      <section
        class="with section"
        data-tab="with"
        id={`${uid}-panel-with`}
        role={mobile.current ? "tabpanel" : undefined}
        aria-labelledby={mobile.current ? `${uid}-tab-with` : undefined}
        hidden={mobile.current && activeTab !== "with"}
      >
        <ScheduleEngineFields
          {provider}
          {defaultProvider}
          {limits}
          onproviderchange={chooseProvider}
          bind:research
          bind:model
          bind:effort
        />
        <details class="advanced">
          <summary
            ><span>{m.schedules_advanced()}</span><span class="advanced-summary"
              >{advancedSummary}</span
            ></summary
          >
          <div class="advanced-fields">
            <label class="field"
              ><span>{m.automation_autopilot_name()}</span>
              <select bind:value={autopilot}>
                <option value="off">{m.schedules_tri_off()}</option><option value="on"
                  >{m.schedules_tri_on()}</option
                ><option value="inherit">{m.schedules_tri_inherit()}</option>
              </select>
            </label>
            <label class="field"
              ><span>{m.schedules_field_plan_gate()}</span>
              <select bind:value={planGate}>
                <option value="inherit">{m.schedules_tri_inherit()}</option><option value="on"
                  >{m.schedules_tri_on()}</option
                ><option value="off">{m.schedules_tri_off()}</option>
              </select>
            </label>
            <label class="field"
              ><span>{m.schedules_field_sandbox()}</span>
              <select bind:value={sandbox}>
                {#each sandboxOptions as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
            <label class="field"
              ><span>{m.schedules_field_base()}</span>
              <input bind:value={baseBranch} placeholder={m.schedules_field_base_placeholder()} />
            </label>
          </div>
        </details>
      </section>
    </div>

    <footer class="sched-footer">
      <p class="next-run" aria-live="polite">
        {#if slotLabels.length}
          {m.schedules_next_run({ when: slotLabels[0] })}
          {#if verdictKnown}
            · {held
              ? m.schedules_would_hold({ pct: usagePct, hold: holdPct })
              : m.schedules_would_start()}{/if}
        {:else}{m.schedules_upcoming_empty()}{/if}
      </p>
      <div class="actions">
        <button type="button" class="gbtn" onclick={() => dlg?.close()}>{m.common_cancel()}</button>
        <button type="submit" class="gbtn primary" disabled={!valid || saving}
          >{m.schedules_save()}</button
        >
      </div>
    </footer>
  </form>
</dialog>

<style>
  .cadence-modes {
    display: flex;
    gap: 8px;
  }
  .cadence-modes .gbtn {
    flex: 1;
    min-width: 0;
    min-height: 44px;
  }
  .cadence-modes [aria-pressed="true"] {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .sched-dlg {
    width: min(960px, 94vw);
    max-height: 90dvh;
    margin: auto;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    color: var(--color-ink);
    padding: 0;
    overflow: hidden;
  }
  .sched-dlg::backdrop {
    background: var(--color-scrim);
    will-change: backdrop-filter;
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }
  @media (prefers-reduced-transparency: reduce) {
    .sched-dlg::backdrop {
      will-change: auto;
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  .sched-form {
    display: flex;
    flex-direction: column;
    max-height: inherit;
    min-height: 0;
  }
  .sched-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .title {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .repo-chip {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    padding: 4px 8px;
    background: var(--color-panel-2);
    cursor: help;
  }
  .close {
    margin-left: auto;
    flex-shrink: 0;
  }
  .sched-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    grid-template-areas: "what engine" "when engine" "advanced engine";
    grid-template-rows: auto auto 1fr;
    gap: 20px 28px;
    overflow-y: auto;
    min-height: 0;
    padding: 20px;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }
  .what {
    grid-area: what;
  }
  .when {
    grid-area: when;
  }
  .with {
    display: contents;
  }
  .advanced {
    grid-area: advanced;
    min-width: 0;
    border-top: 1px solid var(--color-line);
  }
  summary {
    cursor: pointer;
    padding: 12px 0;
    font-size: var(--fs-meta);
  }
  .advanced-summary {
    display: block;
    color: var(--color-muted);
    margin-top: 6px;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .advanced-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    padding-bottom: 8px;
  }
  h3 {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  textarea {
    line-height: 1.5;
    min-height: 5.5em;
    resize: none;
    overflow-y: auto;
  }
  input[aria-invalid="true"],
  textarea[aria-invalid="true"] {
    border-color: var(--color-red);
  }
  .days {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 4px;
  }
  .days button {
    border: 1px solid var(--color-line);
    background: transparent;
    color: var(--color-muted);
    padding: 8px 0;
    cursor: pointer;
  }
  .days .chosen {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: var(--color-sel);
  }
  .presets,
  .times,
  .time {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .times {
    flex-wrap: wrap;
  }
  .time input {
    width: auto;
    font-family: var(--font-mono);
  }
  .hint,
  .preview p {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .preview p,
  .next-run {
    font-variant-numeric: tabular-nums;
  }
  .error {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-red);
  }
  .sched-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 20px;
    border-top: 1px solid var(--color-line);
    background: var(--color-head);
    flex-shrink: 0;
  }
  .next-run {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .gbtn {
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-muted);
    padding: 9px 14px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
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
      padding-top: env(safe-area-inset-top);
      padding-right: env(safe-area-inset-right);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
    }
    .sched-form {
      height: 100%;
      max-height: 100%;
    }
    .sched-head {
      padding: 8px 12px;
      gap: 8px;
    }
    .title {
      flex-shrink: 0;
    }
    .sched-body {
      display: block;
      flex: 1;
      padding: 16px 12px;
    }
    .section[hidden] {
      display: none;
    }
    .with {
      display: flex;
    }
    .advanced-fields {
      grid-template-columns: minmax(0, 1fr);
    }
    .section-tabs {
      display: flex;
      border-bottom: 1px solid var(--color-line);
      padding: 0 12px;
      flex-shrink: 0;
    }
    .section-tabs button {
      flex: 1;
      min-width: 0;
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--color-muted);
      cursor: pointer;
    }
    .section-tabs [aria-selected="true"] {
      color: var(--color-amber);
      border-bottom-color: var(--color-amber);
    }
    .section-tabs .invalid {
      color: var(--color-red);
    }
    .days {
      gap: 0;
      margin-inline: -6px;
    }
    .days button {
      min-width: 44px;
    }
    .sched-footer {
      padding: 10px 12px;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .actions {
      justify-content: flex-end;
    }
  }
</style>
