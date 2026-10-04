<script module lang="ts">
  import { repoConfig } from "$lib/reviews.svelte";

  /** The agent-slot cap to show beside a SlotStepper: the repo config's (optimistic, so a step
   *  reads at once) once known, else the server's — the drain only re-reports its own on its
   *  next tick, up to 30 s later. */
  export function slotCap(repoPath: string, serverMax: number): number {
    return repoConfig.maxAuto[repoPath] ?? serverMax;
  }
</script>

<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { clampCap } from "../git-rail-drain";

  // − / + beside an agent-slot count: steps the repo's cap (maxAuto) in place instead of a trip to
  // Repos → Automation → Cap. Same bounds as that field (clampCap); a step that would not change
  // the cap is disabled.
  let {
    repoPath,
    max,
  }: {
    repoPath: string;
    /** The server's cap (runSummary.slots.max). */
    max: number;
  } = $props();

  $effect(() => {
    void repoConfig.ensure(repoPath);
  });

  const cap = $derived(slotCap(repoPath, max));

  function step(delta: number) {
    void repoConfig.setMaxAuto(repoPath, clampCap(cap + delta));
  }
</script>

<span class="slot-stepper" role="group" aria-label={m.slotstepper_label()}>
  <button
    type="button"
    aria-label={m.slotstepper_less()}
    title={m.slotstepper_less()}
    disabled={clampCap(cap - 1) === cap}
    onclick={() => step(-1)}>−</button
  ><button
    type="button"
    aria-label={m.slotstepper_more()}
    title={m.slotstepper_more()}
    disabled={clampCap(cap + 1) === cap}
    onclick={() => step(1)}>+</button
  >
</span>

<style>
  /* Two joined .gbtn-recipe buttons (scoped copy, as in EpicRunControl), sized to sit inline
     with micro/meta text. */
  .slot-stepper {
    display: inline-flex;
    vertical-align: middle;
  }

  button {
    min-width: 20px;
    padding: 0 5px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.3;
    cursor: pointer;
  }
  button + button {
    margin-left: -1px;
  }
  button:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  button:last-child {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  button:hover:not(:disabled) {
    position: relative;
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  button:focus-visible {
    position: relative;
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (max-width: 768px), (pointer: coarse) {
    button {
      min-width: 32px;
      min-height: 32px;
    }
  }
</style>
