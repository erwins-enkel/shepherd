<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { RepoConfigEditor } from "../repo-settings/repo-config-editor.svelte.js";
  import { ruleName } from "./rule-labels.js";
  let { editor, onclose }: { editor: RepoConfigEditor; onclose: () => void } = $props();
  let dialog = $state<HTMLDialogElement>();
  let heading = $state<HTMLHeadingElement>();
  let error = $state("");
  $effect(() => {
    if (dialog && !dialog.open) {
      dialog.showModal();
      heading?.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    }
  });
  function value(v: unknown): string {
    switch (v) {
      case true:
        return m.automation_layers_on();
      case false:
        return m.automation_layers_off();
      case null:
      case undefined:
        return m.automation_layers_none();
      case "inherit":
        return m.automation_default_model_inherit();
      case "human":
        return m.signoff_authority_human();
      case "critic":
        return m.signoff_authority_critic();
      case "either":
        return m.signoff_authority_either();
      default:
        return String(v);
    }
  }
  function keepKeysInside(node: HTMLElement) {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
    };
    node.addEventListener("keydown", handler);
    return () => node.removeEventListener("keydown", handler);
  }
  async function save() {
    error = "";
    try {
      if (await editor.save()) {
        dialog?.close();
        onclose();
      } else error = m.automation_layers_changed();
    } catch {
      error = m.automation_layers_error();
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-modal="true"
  aria-label={m.automation_layers_confirm()}
  {onclose}
  oncancel={(event) => {
    if (editor.saving) event.preventDefault();
  }}
  {@attach keepKeysInside}
>
  <h2 bind:this={heading} tabindex="-1">{m.automation_layers_confirm()}</h2>
  <dl>
    <dt>{m.automation_layers_branch()}</dt>
    <dd>{editor.view?.repoConfigBranch}</dd>
    <dt>{m.automation_layers_commit()}</dt>
    <dd>chore(shepherd): set repo rules</dd>
  </dl>
  <table>
    <thead
      ><tr
        ><th></th><th>{m.automation_layers_before()}</th><th>{m.automation_layers_after()}</th></tr
      ></thead
    >
    <tbody
      >{#each editor.changes as change (change.key)}<tr
          ><th scope="row">{ruleName(change.key)}</th><td
            >{change.key === "leitrechner" && typeof change.before === "string"
              ? (editor.machineNames[change.before] ?? change.before)
              : value(change.before)}</td
          ><td
            >{change.key === "leitrechner" && typeof change.after === "string"
              ? (editor.machineNames[change.after] ?? change.after)
              : value(change.after)}</td
          ></tr
        >{/each}</tbody
    >
  </table>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <button class="gbtn" disabled={editor.saving} onclick={() => dialog?.close()}
      >{m.common_cancel()}</button
    >
    <button class="gbtn primary" disabled={editor.saving} onclick={save}
      >{m.automation_layers_save()}</button
    >
  </footer>
</dialog>

<style>
  dialog {
    color: var(--color-ink);
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    width: min(600px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    overflow: auto;
    padding: 16px;
  }
  dialog::backdrop {
    background: var(--color-scrim);
    backdrop-filter: blur(3px);
  }
  h2 {
    font-size: var(--fs-lg);
    margin: 0 0 12px;
  }
  dl {
    margin: 0 0 12px;
  }
  dt {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  dd {
    margin: 0 0 8px;
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-meta);
    table-layout: fixed;
  }
  th,
  td {
    text-align: left;
    padding: 6px;
    border-bottom: 1px solid var(--color-line);
    overflow-wrap: anywhere;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
  p {
    color: var(--color-red);
  }
</style>
