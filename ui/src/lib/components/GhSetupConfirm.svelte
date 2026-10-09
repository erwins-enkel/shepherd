<script lang="ts">
  // The confirmation before Shepherd runs `gh auth setup-git`: exactly which lines land in
  // the global git config, who that affects, and how to undo it. Shared by the refused-clone
  // panel and the clone dialog's up-front note.
  import { setupGitViaGh, type GitHelperInfo } from "#lib/api.js";
  import { GH_SETUP_CONFIG, GH_SETUP_UNDO } from "#lib/clone-access.js";
  import { m } from "#lib/paraglide/messages.js";
  import "./clone-access.css";

  let {
    repo,
    login = null,
    onback,
    ondone,
    onghunavailable,
  }: {
    /** Repo the clone retries after setup; absent when confirming from the up-front note. */
    repo?: string;
    login?: string | null;
    onback: () => void;
    ondone: (git: GitHelperInfo) => void;
    /** gh turned out missing or signed out — the caller re-checks and shows that state. */
    onghunavailable?: () => void;
  } = $props();

  const titleId = $props.id();
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function confirm() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      ondone(await setupGitViaGh());
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (
        onghunavailable &&
        (code === "gitcreds_failed_missing" || code === "gitcreds_failed_logged_out")
      ) {
        onghunavailable();
      } else {
        error = m.cloneaccess_setup_failed();
      }
    } finally {
      busy = false;
    }
  }
</script>

<section class="ca-box" aria-labelledby={titleId}>
  <div class="ca-headtext">
    <h3 id={titleId} class="ca-title">{m.cloneaccess_confirm_title()}</h3>
    <p>
      {repo ? m.cloneaccess_confirm_body({ repo }) : m.cloneaccess_confirm_body_norepo()}
    </p>
  </div>

  <div class="ca-sec">
    <span class="ca-label">{m.cloneaccess_confirm_changes_label()}</span>
    <pre class="ca-code"><span class="ca-comment">{m.cloneaccess_confirm_changes_comment()}</span>
{GH_SETUP_CONFIG}</pre>
    <p>{m.cloneaccess_confirm_keep_note()}</p>
  </div>

  <div class="ca-sec">
    <span class="ca-label warn">{m.cloneaccess_confirm_affects_label()}</span>
    <ul>
      <li>{m.cloneaccess_confirm_affects_repos()}</li>
      <li>{m.cloneaccess_confirm_affects_sessions()}</li>
      <li>
        {login
          ? m.cloneaccess_confirm_affects_rights({ login })
          : m.cloneaccess_confirm_affects_rights_anon()}
      </li>
    </ul>
  </div>

  <div class="ca-sec">
    <span class="ca-label">{m.cloneaccess_confirm_undo_label()}</span>
    <p>{m.cloneaccess_confirm_undo_body()}</p>
    <pre class="ca-code">{GH_SETUP_UNDO}</pre>
  </div>

  {#if error}
    <p class="ca-err" role="alert">{error}</p>
  {/if}

  <div class="ca-actions end">
    <button type="button" class="ca-gbtn" onclick={onback} disabled={busy}>
      {m.cloneaccess_confirm_back()}
    </button>
    <button type="button" class="ca-gbtn primary" onclick={confirm} disabled={busy}>
      {#if busy}
        {m.cloneaccess_confirm_busy()}
      {:else}
        {repo ? m.cloneaccess_confirm_go() : m.cloneaccess_confirm_go_norepo()}
      {/if}
    </button>
  </div>
</section>
