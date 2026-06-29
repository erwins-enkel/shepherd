<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { modelLabel } from "$lib/model-label";
  import { AGENT_PROVIDERS, CODEX_MODELS, MODELS, type AgentProvider } from "$lib/types";

  // Small anchored, non-blocking popover for picking an agent provider + model — used to
  // start a comparison VARIANT, REPLACE a session, or spawn a COMPARISON run. Per the design
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
    opener?: HTMLElement;
    onconfirm: (choice: { agentProvider: AgentProvider; model: string | null }) => void;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let agentProvider = $state<AgentProvider>(initialProvider);
  // svelte-ignore state_referenced_locally
  let model = $state<string>(initialModel);

  const providerModels = $derived(agentProvider === "codex" ? CODEX_MODELS : MODELS);

  function modelAvailableForProvider(value: string): boolean {
    if (value === "default") return true;
    if (agentProvider === "claude" && value === "fable" && !fableAvailable) return false;
    return (providerModels as readonly string[]).includes(value);
  }

  // Keep the model valid for the selected provider (seed or a provider switch may invalidate it):
  // Claude falls back to "default" (provider default), Codex to its top curated alias.
  $effect(() => {
    if (!modelAvailableForProvider(model))
      model = agentProvider === "codex" ? CODEX_MODELS[0] : "default";
  });

  function confirm() {
    onconfirm({ agentProvider, model: model === "default" ? null : model });
  }

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
  role="dialog"
  aria-label={title}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
>
  <p class="mcp-title">{title}</p>

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

  <div class="mcp-field">
    <label class="micro" for="mcp-model">{m.newtask_model_label()}</label>
    <select id="mcp-model" bind:value={model}>
      <option value="default">{m.newtask_model_default()}</option>
      {#each providerModels as mdl (mdl)}
        {#if agentProvider !== "claude" || mdl !== "fable" || fableAvailable}
          <option value={mdl}>{modelLabel(mdl)}</option>
        {/if}
      {/each}
    </select>
  </div>

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
  .mcp-title {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .mcp-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
