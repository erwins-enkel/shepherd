<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { useRepoConfig, useRepoEditor } from "./repo-config-editor.svelte.js";
  const repoConfig = useRepoConfig();
  const editor = useRepoEditor();
  import { repoModeExplanation } from "#lib/tooltips/explanations.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import InfoTip from "../InfoTip.svelte";

  // The repo mode as a choice (#3443; formerly the "Lightweight" switch): GitHub — pull requests
  // and the forge — or local Git only. Native radios, so arrow keys and touch work as everywhere.
  let { repoPath, armCoachmarks = false }: { repoPath: string; armCoachmarks?: boolean } = $props();

  const name = $props.id();
  const mode = $derived(repoConfig.repoModeFor(repoPath));
  const explanation = repoModeExplanation();
  const options = [
    { value: "forge", label: m.reposettings_mode_github() },
    { value: "lightweight", label: m.reposettings_mode_local() },
  ] as const;

  function changeMode(value: "forge" | "lightweight") {
    if (editor?.saving) return;
    if (editor?.dirty) {
      if (!window.confirm(m.automation_layers_unsaved())) return;
      editor.discard();
    }
    void repoConfig.setRepoMode(repoPath, value);
  }

  // Only the window registers the coach target: coachTargets keys one node per id, and a second
  // mounted instance's teardown would delete the window's anchor.
  function coachIf(node: HTMLElement, on: boolean) {
    if (on) return coachTarget(node, "lightweight-repo");
  }
</script>

<div
  class="mode"
  role="radiogroup"
  aria-label={m.reposettings_mode_label()}
  data-field="repoMode"
  use:coachIf={armCoachmarks}
>
  <span class="mode-label">{m.reposettings_mode_label()}</span>
  {#each options as opt (opt.value)}
    <label class={["seg", { on: mode === opt.value }]}>
      <input
        type="radio"
        {name}
        value={opt.value}
        checked={mode === opt.value}
        disabled={editor?.saving}
        onchange={() => changeMode(opt.value)}
      />
      {opt.label}
    </label>
  {/each}
  <InfoTip text={explanation} label={explanation.title} />
</div>

<style>
  .mode {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0;
    min-width: 0;
  }
  .mode-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-right: 8px;
  }
  .seg {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border: 1px solid var(--color-line);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .seg + .seg {
    border-left: 0;
  }
  .seg:first-of-type {
    border-radius: 2px 0 0 2px;
  }
  .seg:last-of-type {
    border-radius: 0 2px 2px 0;
    margin-right: 6px;
  }
  .seg.on {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: color-mix(in oklab, var(--color-amber) 10%, transparent);
  }
  .seg + .seg.on {
    border-left: 1px solid var(--color-amber);
  }
  /* visually hidden; the label is the target, the radio keeps keyboard + AT semantics */
  .seg input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }
  .seg:has(input:focus-visible) {
    outline: 1px solid var(--color-amber);
    outline-offset: 1px;
  }
  @media (pointer: coarse) {
    .seg {
      min-height: 44px;
    }
  }
</style>
