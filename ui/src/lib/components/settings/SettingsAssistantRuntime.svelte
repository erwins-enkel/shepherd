<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { putAssistantRuntime, switchOperatorAssistants } from "#lib/api.js";
  import type {
    AgentProvider,
    AssistantRuntimeSettings,
    AssistantSwitchState,
    Session,
    Settings,
  } from "#lib/types.js";
  import { pickerModels, modelAvailableForProvider } from "#lib/provider-models.js";
  import { modelOptionLabel } from "#lib/model-guidance.js";
  import { effortLabel, providerEfforts } from "#lib/effort-guidance.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import "./settings-controls.css";

  let {
    payload,
    query = "",
    assistants = [],
    switches = {},
  }: {
    payload: Settings | null;
    query?: string;
    assistants?: Session[];
    switches?: Record<string, AssistantSwitchState>;
  } = $props();
  let runtime = $state<AssistantRuntimeSettings | null>(null);
  let saved: AssistantRuntimeSettings | null = null;
  let busy = $state(false);
  let switching = $state(false);
  $effect(() => {
    if (!payload?.assistantRuntime || runtime) return;
    const initial = structuredClone($state.snapshot(payload.assistantRuntime));
    untrack(() => {
      runtime = initial;
      saved = structuredClone(initial);
    });
  });
  const providers: AgentProvider[] = ["claude", "codex"];
  const name = (provider: AgentProvider) => (provider === "claude" ? "Claude" : "Codex");
  function models(provider: AgentProvider): string[] {
    const current = runtime?.[provider].model;
    const values = pickerModels(provider, current).filter((model) =>
      modelAvailableForProvider(provider, model, payload?.fableAvailable ?? true),
    );
    return current && !values.includes(current) ? [current, ...values] : [...values];
  }
  async function save() {
    if (!runtime || busy) return;
    busy = true;
    try {
      const result = await putAssistantRuntime(structuredClone($state.snapshot(runtime)));
      runtime = result.assistantRuntime;
      saved = structuredClone(result.assistantRuntime);
    } catch {
      runtime = saved ? structuredClone(saved) : null;
      toasts.info(m.settings_assistant_save_failed(), { key: "assistant-runtime", alert: true });
    } finally {
      busy = false;
    }
  }
  async function applyNow() {
    if (switching || busy) return;
    switching = true;
    try {
      await switchOperatorAssistants();
    } catch {
      toasts.info(m.settings_assistant_runtime_failed(), { key: "assistant-switch", alert: true });
    } finally {
      switching = false;
    }
  }
</script>

{#if runtime}
  <p class="runtime-intro">{m.settings_assistant_runtime_intro()}</p>
  <SettingRow
    title={m.settings_assistant_runtime_enabled()}
    description={m.settings_assistant_runtime_enabled_hint()}
    {query}
  >
    {#snippet control()}
      <SettingToggle
        label={m.settings_assistant_runtime_enabled()}
        checked={runtime!.enabled}
        disabled={busy}
        onchange={() => {
          runtime!.enabled = !runtime!.enabled;
          void save();
        }}
      />
    {/snippet}
  </SettingRow>
  <SettingRow
    title={m.settings_assistant_runtime_provider()}
    description={m.settings_assistant_runtime_provider_hint()}
    {query}
  >
    {#snippet control()}
      <span class="set-select"
        ><select
          bind:value={runtime!.preferredProvider}
          aria-label={m.settings_assistant_runtime_provider()}
          disabled={busy}
          onchange={save}
        >
          {#each providers as provider (provider)}<option value={provider}>{name(provider)}</option
            >{/each}
        </select><span class="set-chev" aria-hidden="true">▾</span></span
      >
    {/snippet}
  </SettingRow>
  {#each providers as provider (provider)}
    <SettingRow title={m.settings_assistant_runtime_model({ provider: name(provider) })} {query}>
      {#snippet control()}
        <span class="set-select"
          ><select
            bind:value={runtime![provider].model}
            aria-label={m.settings_assistant_runtime_model({ provider: name(provider) })}
            disabled={busy}
            onchange={save}
          >
            <option value={null}>{m.settings_assistant_runtime_default()}</option>
            {#each models(provider) as model (model)}<option value={model}
                >{modelOptionLabel(provider, model)}</option
              >{/each}
          </select><span class="set-chev" aria-hidden="true">▾</span></span
        >
      {/snippet}
    </SettingRow>
    <SettingRow title={m.settings_assistant_runtime_effort({ provider: name(provider) })} {query}>
      {#snippet control()}
        <span class="set-select"
          ><select
            bind:value={runtime![provider].effort}
            aria-label={m.settings_assistant_runtime_effort({ provider: name(provider) })}
            disabled={busy}
            onchange={save}
          >
            <option value={null}>{m.settings_assistant_runtime_default()}</option>
            {#each [...new Set( [...(runtime![provider].effort ? [runtime![provider].effort!] : []), ...providerEfforts(provider, runtime![provider].model)] )] as effort (effort)}<option
                value={effort}>{effortLabel(effort)}</option
              >{/each}
          </select><span class="set-chev" aria-hidden="true">▾</span></span
        >
      {/snippet}
    </SettingRow>
  {/each}
  <SettingRow
    title={m.settings_assistant_runtime_fallback()}
    description={m.settings_assistant_runtime_fallback_hint()}
    {query}
  >
    {#snippet control()}
      <SettingToggle
        label={m.settings_assistant_runtime_fallback()}
        checked={runtime!.automaticFallback}
        disabled={busy}
        onchange={() => {
          runtime!.automaticFallback = !runtime!.automaticFallback;
          void save();
        }}
      />
    {/snippet}
  </SettingRow>
  <SettingRow title={m.settings_assistant_runtime_switch()} {query}>
    {#snippet control()}<button
        class="gbtn"
        disabled={busy || switching || !runtime!.enabled}
        onclick={applyNow}>{m.settings_assistant_runtime_switch()}</button
      >{/snippet}
    {#snippet below()}
      <div class="runtime-status" aria-live="polite">
        {#each assistants as assistant (assistant.id)}
          <p>
            {m.settings_assistant_runtime_active({
              scope: assistant.assistantRepo?.split("/").pop() ?? m.settings_tab_assistant(),
              provider: name(assistant.agentProvider ?? "claude"),
              model: assistant.model ?? m.settings_assistant_runtime_default(),
              effort: assistant.effort
                ? effortLabel(assistant.effort)
                : m.settings_assistant_runtime_default(),
            })}
          </p>
          {#if switches[assistant.id]?.status === "failed"}<p role="alert">
              {m.settings_assistant_runtime_failed()}
            </p>
          {:else if switches[assistant.id]?.status === "pending"}<p>
              {m.settings_assistant_runtime_pending()}
            </p>
          {:else if switches[assistant.id]?.status === "switching"}<p>
              {m.settings_assistant_runtime_switching()}
            </p>{/if}
        {/each}
      </div>
    {/snippet}
  </SettingRow>
{/if}

<style>
  .runtime-intro,
  .runtime-status {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .runtime-intro {
    margin: 0 0 12px;
  }
  .runtime-status {
    overflow-wrap: anywhere;
  }
  .runtime-status p {
    margin: 6px 0;
  }
</style>
