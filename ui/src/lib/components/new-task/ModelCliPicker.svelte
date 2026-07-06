<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { modelOptionLabel } from "$lib/model-guidance";
  import ModelGuidance from "$lib/components/ModelGuidance.svelte";
  import { AGENT_PROVIDERS, CODEX_MODELS, type AgentProvider, type UsageLimits } from "$lib/types";
  import { providerModels, modelAvailableForProvider } from "$lib/provider-models";
  import { providerEfforts, effortLabel, effortAvailableForProvider } from "$lib/effort-guidance";
  import type { HandoffMode } from "$lib/api";
  import { codexGaugeList, codexTokenUsage, gaugeColor, gaugeList } from "../usage-gauges";
  import { formatResetIn, formatTokenLabel } from "$lib/format";

  type Choice = {
    agentProvider: AgentProvider;
    model: string | null;
    effort?: string | null;
    handoffMode?: HandoffMode;
  };

  // Small anchored, non-blocking popover for picking an agent provider + model — used to
  // start a comparison VARIANT, continue a session with another CLI, or spawn a COMPARISON run. Per the design
  // system's popover rule it gets NO scrim/blur: it dismisses on outside-click, Esc or scroll.
  // Only configured/available choices are offered (fable hidden when unavailable), mirroring
  // NewTaskRunSettings' availability logic so a spawn never fails opaquely.
  let {
    x,
    y,
    title,
    confirmLabel,
    fableAvailable,
    initialProvider,
    initialModel = "default",
    initialEffort = "default",
    handoff = false,
    usageLimits = null,
    nowMs = Date.now(),
    holdLikely = false,
    opener,
    onconfirm,
    onclose,
  }: {
    x: number;
    y: number;
    title: string;
    confirmLabel: string;
    fableAvailable: boolean;
    initialProvider: AgentProvider;
    /** Seed model alias ("default" = provider default). Reset if not available for the provider. */
    initialModel?: string;
    /** Seed effort tier ("default" = provider default). Reset if not available for the provider. */
    initialEffort?: string;
    /** Show the in-place continuation handoff mode picker. */
    handoff?: boolean;
    usageLimits?: UsageLimits | null;
    nowMs?: number;
    holdLikely?: boolean;
    opener?: HTMLElement;
    onconfirm: (choice: Choice) => void;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let agentProvider = $state<AgentProvider>(initialProvider);
  // svelte-ignore state_referenced_locally
  let model = $state<string>(initialModel);
  // svelte-ignore state_referenced_locally
  let effort = $state<string>(initialEffort);
  let handoffMode = $state<HandoffMode>("resume");

  const provModels = $derived(providerModels(agentProvider));
  const provEfforts = $derived(providerEfforts(agentProvider));
  const claudeGauges = $derived(gaugeList(usageLimits));
  const codexUsage = $derived(codexTokenUsage(usageLimits));
  const codexGauges = $derived(codexGaugeList(codexUsage));

  // Keep the model valid for the selected provider (seed or a provider switch may invalidate it):
  // Claude falls back to "default" (provider default), Codex to its top curated alias.
  $effect(() => {
    if (!modelAvailableForProvider(agentProvider, model, fableAvailable))
      model = agentProvider === "codex" ? CODEX_MODELS[0] : "default";
  });

  // Snap a now-unsupported effort tier back to "default" when the provider changes (e.g.
  // switching to Codex drops an xhigh/max selection — mirrors NewTaskRunSettings).
  $effect(() => {
    if (!effortAvailableForProvider(agentProvider, effort)) effort = "default";
  });

  function confirm() {
    onconfirm({
      agentProvider,
      model: model === "default" ? null : model,
      effort: effort === "default" ? null : effort,
      ...(handoff ? { handoffMode } : {}),
    });
  }

  const gaugeFill = (pct: number) => Math.min(Math.max(pct, 0), 100) / 100;

  let el = $state<HTMLDivElement>();

  // Clamp inside the viewport like CardMenu so it never spills off the edge.
  let pos = $state<{ left: number; top: number } | null>(null);
  $effect(() => {
    const node = el;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, window.innerWidth - r.width - margin);
    const top = Math.min(y, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
  });

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="mcp"
  class:handoff
  role="dialog"
  aria-label={title}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
>
  <p class="mcp-title">{title}</p>
  {#if handoff}
    <p class="mcp-note">{m.experiment_continue_scope()}</p>
  {/if}

  <div class="mcp-field">
    <label class="micro" for="mcp-provider">{m.newtask_agent_provider_label()}</label>
    <select id="mcp-provider" bind:value={agentProvider}>
      {#each AGENT_PROVIDERS as provider (provider)}
        <option value={provider}>
          {provider === "claude" ? m.agent_provider_claude() : m.agent_provider_codex_alpha()}
        </option>
      {/each}
    </select>
  </div>

  {#if usageLimits || holdLikely}
    <div class="mcp-usage" role="note">
      {#if holdLikely}
        <p class="mcp-hold">{m.newtask_agent_provider_codex_suggested_for_hold()}</p>
      {/if}
      <div class="mcp-provider-usage">
        <span class="micro">{m.agent_provider_claude()}</span>
        {#if claudeGauges.length > 0}
          {#each claudeGauges as g (g.label)}
            <div class="mcp-gauge">
              <span>{g.label}</span>
              <span class="mcp-bar">
                <span
                  class="mcp-fill"
                  style="transform:scaleX({gaugeFill(g.w.pct)});background:{gaugeColor(g.w.pct)}"
                ></span>
              </span>
              <span style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
              <small>{formatResetIn(g.w.resetAt, nowMs)}</small>
            </div>
          {/each}
        {:else}
          <span class="mcp-unavailable">{m.upnext_usage_unavailable()}</span>
        {/if}
      </div>
      <div class="mcp-provider-usage">
        <span class="micro">{m.agent_provider_codex()}</span>
        {#if codexGauges.length > 0}
          {#each codexGauges as g (g.label)}
            <div class="mcp-gauge">
              <span>{g.label}</span>
              <span class="mcp-bar">
                <span
                  class="mcp-fill"
                  style="transform:scaleX({gaugeFill(g.w.pct)});background:{gaugeColor(g.w.pct)}"
                ></span>
              </span>
              <span style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
              <small>{formatResetIn(g.w.resetAt, nowMs)}</small>
            </div>
          {/each}
        {:else}
          <span class="mcp-unavailable">{m.topbar_codex_limits_unavailable()}</span>
        {/if}
        {#if codexUsage}
          <div class="mcp-token">
            <span>{m.topbar_tokens_total()}</span>
            <span>{formatTokenLabel(codexUsage.totalTokens)}</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <div class="mcp-field">
    <label class="micro" for="mcp-model">{m.newtask_model_label()}</label>
    <select id="mcp-model" bind:value={model}>
      <option value="default">{m.newtask_model_default()}</option>
      {#each provModels as mdl (mdl)}
        {#if agentProvider !== "claude" || mdl !== "fable" || fableAvailable}
          <option value={mdl}>{modelOptionLabel(agentProvider, mdl)}</option>
        {/if}
      {/each}
    </select>
    <ModelGuidance provider={agentProvider} {model} context="task" compact />
  </div>

  <div class="mcp-field">
    <label class="micro" for="mcp-effort">{m.newtask_effort_label()}</label>
    <select id="mcp-effort" bind:value={effort}>
      <option value="default">{m.effort_default()}</option>
      {#each provEfforts as tier (tier)}
        <option value={tier}>{effortLabel(tier)}</option>
      {/each}
    </select>
  </div>

  {#if handoff}
    <fieldset class="mcp-field mcp-handoff">
      <legend class="micro">{m.experiment_continue_handoff_label()}</legend>
      <label class="mode">
        <input type="radio" bind:group={handoffMode} value="resume" />
        <span>
          <strong>{m.experiment_continue_mode_resume()}</strong>
          <small>{m.experiment_continue_mode_resume_hint()}</small>
        </span>
      </label>
      <label class="mode">
        <input type="radio" bind:group={handoffMode} value="summarize" />
        <span>
          <strong>{m.experiment_continue_mode_summarize()}</strong>
          <small>{m.experiment_continue_mode_summarize_hint()}</small>
        </span>
      </label>
    </fieldset>
  {/if}

  <div class="mcp-actions">
    <button class="gbtn" type="button" onclick={onclose}>{m.common_cancel()}</button>
    <button class="gbtn primary" type="button" onclick={confirm}>{confirmLabel}</button>
  </div>
</div>

<style>
  .mcp {
    position: fixed;
    z-index: 60;
    width: 260px;
    max-width: calc(100vw - 16px);
    padding: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches CardMenu/AutomationPanel) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .mcp.handoff {
    width: 340px;
  }
  .mcp-title {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .mcp-note {
    margin: -2px 0 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  .mcp-usage {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .mcp-hold {
    margin: 0;
    color: var(--color-amber);
    font-size: var(--fs-meta);
    line-height: 1.35;
  }
  .mcp-provider-usage {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mcp-gauge,
  .mcp-token {
    display: grid;
    grid-template-columns: 24px minmax(48px, 1fr) 34px auto;
    align-items: center;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
  }
  .mcp-token {
    grid-template-columns: 1fr auto;
  }
  .mcp-gauge small,
  .mcp-token span:first-child,
  .mcp-unavailable {
    color: var(--color-faint);
  }
  .mcp-bar {
    height: 5px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-line);
    overflow: hidden;
  }
  .mcp-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
  }
  .mcp-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  fieldset.mcp-field {
    margin: 0;
    padding: 0;
    border: 0;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  select {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
    appearance: none;
    cursor: pointer;
  }
  select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .mcp-handoff {
    gap: 7px;
  }
  .mode {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: start;
    padding: 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    cursor: pointer;
  }
  .mode:hover {
    border-color: var(--color-line-bright);
  }
  .mode input {
    margin: 2px 0 0;
    accent-color: var(--color-amber);
  }
  .mode strong,
  .mode small {
    display: block;
  }
  .mode strong {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    font-weight: 600;
  }
  .mode small {
    margin-top: 3px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.35;
  }
  .mcp-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  /* Canonical .gbtn recipe (see /design-system). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 8px 14px;
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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
