<script lang="ts">
  // The clone dialog's up-front note: the repo list comes from gh, but git clones with its
  // own credential helper — say so before a private repo fails, and offer to align them
  // (`gh auth setup-git`, confirmed via GhSetupConfirm). Dismissal is per device.
  import type { GitHelperInfo } from "$lib/api";
  import { helperLabel } from "$lib/clone-access";
  import { m } from "$lib/paraglide/messages";
  import GhSetupConfirm from "./GhSetupConfirm.svelte";
  import "./clone-access.css";

  let { git, login = null }: { git: GitHelperInfo; login?: string | null } = $props();

  const KEY = "shepherd:clone-git-note-dismissed";
  let dismissed = $state(readDismissed());
  let confirming = $state(false);
  let aligned = $state(false);

  function readDismissed(): boolean {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  }

  function dismiss() {
    dismissed = true;
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* private mode — the note just comes back next time */
    }
  }
</script>

{#if aligned}
  <div class="ca-box ok" role="status">
    <p>{m.cloneaccess_done_title()} · {m.cloneaccess_done_body_norepo()}</p>
  </div>
{:else if git.usesGh || dismissed}
  <!-- git already clones through gh, or the operator waved the note off -->
{:else if confirming}
  <GhSetupConfirm
    {login}
    onback={() => (confirming = false)}
    ondone={() => {
      confirming = false;
      aligned = true;
    }}
  />
{:else}
  <div class="ca-box note" role="note">
    <div class="ca-head warn">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
        ><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.5h.01" /></svg
      >
      <div class="ca-headtext">
        <span class="ca-title">{m.cloneaccess_note_title()}</span>
        <p>{m.cloneaccess_note_body({ helper: helperLabel(git.kind) })}</p>
      </div>
    </div>
    <div class="ca-actions">
      <button type="button" class="ca-gbtn primary" onclick={() => (confirming = true)}>
        {m.cloneaccess_note_align()}
      </button>
      <button type="button" class="ca-gbtn quiet" onclick={dismiss}>
        {m.cloneaccess_note_dismiss()}
      </button>
    </div>
  </div>
{/if}
