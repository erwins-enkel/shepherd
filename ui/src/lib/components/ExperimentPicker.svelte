<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { AgentProvider } from "$lib/types";
  import { startVariant, startComparison, relaunchSession } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import ModelCliPicker from "./new-task/ModelCliPicker.svelte";

  // Owns the comparison-action picker end to end: the parent's card-menu / Compare-button handlers
  // set `picker`; this component maps the mode to chrome, renders the anchored popover, and runs the
  // matching API call on confirm (keeping that branching out of the route). New sessions surface
  // live via session:new; the back-filled original via session:experiment.
  export type ExperimentPickerState =
    | { mode: "variant" | "replace"; id: string; x: number; y: number }
    | { mode: "compare"; experimentId: string; x: number; y: number };

  let {
    picker = $bindable(),
    fableAvailable,
    initialProvider,
    onselect,
  }: {
    picker: ExperimentPickerState | null;
    fableAvailable: boolean;
    initialProvider: AgentProvider;
    onselect: (id: string) => void;
  } = $props();

  const VIEW = {
    variant: {
      title: () => m.experiment_variant_title(),
      confirm: () => m.experiment_variant_confirm(),
    },
    replace: {
      title: () => m.experiment_replace_title(),
      confirm: () => m.experiment_replace_confirm(),
    },
    compare: {
      title: () => m.experiment_compare_title(),
      confirm: () => m.experiment_compare_confirm(),
    },
  } as const;
  const view = $derived(
    picker
      ? {
          title: VIEW[picker.mode].title(),
          confirm: VIEW[picker.mode].confirm(),
          // Compare seeds Opus (a strong reviewer) and therefore PINS the Claude provider — a
          // codex default would make ModelCliPicker reset the seed to a Codex alias. Variant /
          // replace keep the user's default provider so a fresh model can be picked freely.
          provider: picker.mode === "compare" ? ("claude" as AgentProvider) : initialProvider,
          initialModel: picker.mode === "compare" ? "opus" : "default",
        }
      : null,
  );

  async function runReplace(
    id: string,
    choice: { agentProvider: AgentProvider; model: string | null },
  ) {
    const { session, archived } = await relaunchSession(id, choice);
    if (archived) toasts.info(m.relaunch_done({ desig: session.desig }));
    else
      toasts.info(m.relaunch_archive_failed(), {
        duration: null,
        alert: true,
        key: `relaunch-fail:${id}`,
      });
    onselect(session.id);
  }

  async function onconfirm(choice: { agentProvider: AgentProvider; model: string | null }) {
    const p = picker;
    picker = null;
    if (!p) return;
    try {
      if (p.mode === "compare") onselect((await startComparison(p.experimentId, choice)).id);
      else if (p.mode === "variant") onselect((await startVariant(p.id, choice)).id);
      else await runReplace(p.id, choice);
    } catch {
      toasts.info(m.experiment_action_failed(), { alert: true });
    }
  }
</script>

{#if picker && view}
  <ModelCliPicker
    x={picker.x}
    y={picker.y}
    title={view.title}
    confirmLabel={view.confirm}
    {fableAvailable}
    initialProvider={view.provider}
    initialModel={view.initialModel}
    {onconfirm}
    onclose={() => (picker = null)}
  />
{/if}
