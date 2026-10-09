<script lang="ts">
  // Both credentials behind one refused GitHub clone, side by side: what git cloned with
  // (refused), and whether gh is signed in and may read/push the repo. `access` null = the gh
  // check is still running.
  import type { GithubAccess } from "#lib/api.js";
  import { helperLabel } from "#lib/clone-access.js";
  import { m } from "#lib/paraglide/messages.js";
  import "./clone-access.css";

  let {
    repo,
    access,
    onrecheck,
  }: {
    repo: string;
    access: GithubAccess | null;
    /** Offer "check gh again" next to the heading. */
    onrecheck?: () => void;
  } = $props();

  const gh = $derived(access?.gh ?? null);
  /** The gh row's label + hint for the states without an account. */
  const ghPlain = $derived.by(() => {
    if (gh?.state === "missing") {
      return { label: m.cloneaccess_gh_missing(), hint: m.cloneaccess_gh_missing_hint() };
    }
    if (gh?.state === "logged_out") {
      return { label: m.cloneaccess_gh_logged_out(), hint: m.cloneaccess_gh_logged_out_hint() };
    }
    return { label: m.cloneaccess_gh_error(), hint: "" };
  });
</script>

{#snippet iconCheck()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
  >
{/snippet}
{#snippet iconX()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg
  >
{/snippet}

<div class="ca-sec">
  <div class="ca-sec-head">
    <span class="ca-label">{m.cloneaccess_table_label({ repo })}</span>
    {#if onrecheck}
      <button type="button" class="ca-link" onclick={onrecheck}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg
        >{m.cloneaccess_recheck()}
      </button>
    {/if}
  </div>
  <div class="ca-table">
    <code>git</code>
    <span
      >{access ? helperLabel(access.git.kind, access.protocol) : m.cloneaccess_git_generic()}<span
        class="ca-sub">{m.cloneaccess_git_hint()}</span
      ></span
    >
    <span class="ca-verdict bad"><span>{@render iconX()}{m.cloneaccess_git_refused()}</span></span>

    <code>gh</code>
    {#if !gh}
      <span class="ca-sub">{m.cloneaccess_gh_question()}</span>
      <span class="ca-verdict pending" role="status"><span>{m.cloneaccess_checking()}</span></span>
    {:else if gh.state === "ok"}
      <span
        >{m.cloneaccess_gh_account({ login: gh.login })}<span class="ca-sub"
          >{m.cloneaccess_gh_signed_in()}</span
        ></span
      >
      <span class="ca-verdict" class:good={gh.pull} class:bad={!gh.pull}>
        {#if gh.pull}
          <span>{@render iconCheck()}{m.cloneaccess_gh_read()}</span>
          <span class:ca-no={!gh.push}
            >{#if gh.push}{@render iconCheck()}{:else}{@render iconX()}{/if}{m.cloneaccess_gh_push()}</span
          >
        {:else}
          <span>{@render iconX()}{m.cloneaccess_gh_no_access()}</span>
        {/if}
      </span>
    {:else}
      <span>{ghPlain.label}<span class="ca-sub">{ghPlain.hint}</span></span>
      <span class="ca-verdict unknown"
        ><span
          ><svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            aria-hidden="true"><path d="M5 12h14" /></svg
          >{m.cloneaccess_gh_unknown()}</span
        ></span
      >
    {/if}
  </div>
</div>
