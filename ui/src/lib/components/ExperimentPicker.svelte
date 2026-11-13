<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { AgentProvider, SessionHost } from "#lib/types.js";
  import {
    ApiError,
    startVariant,
    startComparison,
    replaceSessionAgent,
    moveSession,
    type HandoffMode,
  } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { machines } from "#lib/machines.svelte.js";
  import ModelCliPicker, { type MachineOption } from "./new-task/ModelCliPicker.svelte";
  import { machineLabel, needsClone, runOnFailureMessage, runOnMachines } from "./new-task/run-on";

  // Owns the comparison-action picker end to end: the parent's card-menu / Compare-button handlers
  // set `picker`; this component maps the mode to chrome, renders the anchored popover, and runs the
  // matching API call on confirm (keeping that branching out of the route). New sessions surface
  // live via session:new; the back-filled original via session:experiment.
  // Continue with… also offers the machines the session could move to (`project`: its forge slug,
  // set only for a session with a work branch of its own; `host`: its machine, absent = here).
  export type ExperimentPickerState =
    | { mode: "variant"; id: string; x: number; y: number }
    | { mode: "replace"; id: string; x: number; y: number; host?: SessionHost; project?: string }
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
          // Both seeds above are fixed (not inherited from an original session's model), so the
          // effort seed mirrors that: always "default", never inherited.
          initialEffort: "default",
        }
      : null,
  );

  type Choice = {
    agentProvider: AgentProvider;
    model: string | null;
    effort?: string | null;
    handoffMode?: HandoffMode;
    target?: { instanceId: string };
  };

  /** Where a session can continue: its own machine first, then this Shepherd and every connected
   *  machine released for tasks. Empty — no field — without another machine, for a session that
   *  cannot move (no project slug), or while its own machine is out of reach. */
  const machineOptions = $derived.by((): MachineOption[] => {
    if (picker?.mode !== "replace" || !picker.project || !machines.self) return [];
    const { project, host } = picker;
    const others = runOnMachines(machines.list, project);
    if (others.length === 0) return [];
    const self = machines.self;
    const all: MachineOption[] = [
      { instanceId: self.instanceId, label: m.newtask_runon_here(), name: self.name },
      ...others.map((x) => ({
        instanceId: x.instanceId,
        label: machineLabel(x, needsClone(x, project)),
        name: x.name,
      })),
    ];
    const own = all.find((o) => o.instanceId === (host?.instanceId ?? self.instanceId));
    return own ? [own, ...all.filter((o) => o !== own)] : [];
  });

  async function runReplace(id: string, choice: Choice) {
    const session = await replaceSessionAgent(id, choice);
    onselect(session.id);
    if (session.providerHandoff && session.providerHandoff.phase !== "observed")
      toasts.info(m.handoff_waiting(), { alert: true });
    else if (session.providerHandoff?.gaps.length)
      toasts.info(m.handoff_partial(), { alert: true });
  }

  const MOVE_FAILURE: Record<string, () => string> = {
    move_merging: () => m.experiment_move_merging(),
    move_no_branch: () => m.experiment_move_no_branch(),
    move_unsupported_kind: () => m.experiment_move_unsupported(),
    handoff_in_progress: () => m.experiment_move_in_progress(),
    in_progress: () => m.experiment_move_in_progress(),
    move_project_missing_here: () => m.experiment_move_project_missing_here(),
  };

  /** What the toast says when a move did not go through, naming the machine where it helps. */
  function moveFailureMessage(err: unknown, machine: string): string {
    if (err instanceof ApiError && err.code) {
      if (err.code === "move_target_unknown") return m.experiment_move_unknown({ machine });
      if (err.code === "handoff_push_failed" || err.code === "handoff_commit_failed")
        return m.experiment_move_push_failed({ reason: err.message });
      const own = MOVE_FAILURE[err.code];
      if (own) return own();
    }
    return runOnFailureMessage(err, machine) ?? m.experiment_action_failed();
  }

  async function runMove(
    id: string,
    choice: Choice & { target: { instanceId: string } },
    machine: string,
  ) {
    try {
      const result = await moveSession(id, choice);
      if (result.session) onselect(result.session.id);
      if (result.held) toasts.info(m.experiment_move_held({ machine }));
      if (!result.archived)
        toasts.info(m.experiment_move_not_archived({ machine }), { alert: true });
    } catch (err) {
      toasts.info(moveFailureMessage(err, machine), { alert: true });
    }
  }

  async function onconfirm(choice: Choice) {
    const p = picker;
    // Read before closing: the options derive from the open picker.
    const options = machineOptions;
    picker = null;
    if (!p) return;
    const target = choice.target;
    if (p.mode === "replace" && target) {
      const machine = options.find((o) => o.instanceId === target.instanceId)?.name ?? "";
      return runMove(p.id, { ...choice, target }, machine);
    }
    try {
      if (p.mode === "compare") onselect((await startComparison(p.experimentId, choice)).id);
      else if (p.mode === "variant") onselect((await startVariant(p.id, choice)).id);
      else await runReplace(p.id, choice);
    } catch (error) {
      toasts.info(
        error instanceof ApiError && error.code?.startsWith("handoff_")
          ? m.handoff_failed()
          : m.experiment_action_failed(),
        { alert: true },
      );
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
    initialEffort={view.initialEffort}
    handoff={picker.mode === "replace"}
    machines={machineOptions}
    {onconfirm}
    onclose={() => (picker = null)}
  />
{/if}
