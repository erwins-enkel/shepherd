<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  let {
    session,
    runtimeSwitch,
    runtimePreference,
    fallbackReason,
  }: {
    session: Session | null;
    runtimeSwitch: "pending" | "switching" | "failed" | null;
    runtimePreference: "claude" | "codex" | null;
    fallbackReason: string | null;
  } = $props();
</script>

{#if session}<span class="oap-runtime"
    >{session.agentProvider === "codex" ? "Codex" : "Claude"} · {session.model ??
      m.settings_assistant_runtime_default()}</span
  >{/if}
{#if runtimeSwitch}<span class="oap-runtime" aria-live="polite"
    >{runtimeSwitch === "failed"
      ? m.settings_assistant_runtime_failed()
      : runtimeSwitch === "pending"
        ? m.settings_assistant_runtime_pending()
        : m.settings_assistant_runtime_switching()}</span
  >
{:else if session && runtimePreference && (session.agentProvider ?? "claude") !== runtimePreference}<span
    class="oap-runtime"
    >{m.settings_assistant_runtime_fallback_active()}{#if fallbackReason}
      · {fallbackReason === "capacity"
        ? m.settings_assistant_runtime_limit_reason()
        : m.settings_assistant_runtime_unavailable_reason()}{/if}</span
  >{/if}

<style>
  .oap-runtime {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
</style>
