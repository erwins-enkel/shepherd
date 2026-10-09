<script lang="ts">
  // Why a GitHub clone was refused, and the way out — shown in the clone dialog in place of
  // a bare "access denied" line. The repo list comes from gh, but `git clone` authenticates
  // with git's own credential helper; this panel checks gh for the one repo, names both
  // credentials side by side and offers the fix that applies (see #lib/clone-access).
  import { onMount } from "svelte";
  import { getGithubAccess, type GithubAccess } from "#lib/api.js";
  import { accessCase, ghFixApplies, TOKEN_SETTINGS_URL } from "#lib/clone-access.js";
  import { m } from "#lib/paraglide/messages.js";
  import CloneAccessTable from "./CloneAccessTable.svelte";
  import GhSetupConfirm from "./GhSetupConfirm.svelte";
  import "./clone-access.css";

  let {
    url,
    repo,
    detail,
    initial,
    cloning = false,
    onretry,
  }: {
    /** The clone URL that was refused. */
    url: string;
    /** Display name, e.g. `owner/repo`. */
    repo: string;
    /** git's redacted stderr from the failed clone. */
    detail?: string;
    /** A diagnosis the caller already has — skips the initial check. */
    initial?: GithubAccess;
    /** The caller is re-running the clone right now. */
    cloning?: boolean;
    /** Re-run the clone. */
    onretry: () => void;
  } = $props();

  let phase = $state<"checking" | "ready" | "confirm" | "done">("checking");
  let access = $state<GithubAccess | null>(null);
  let checkError = $state<string | null>(null);
  let showDetails = $state(false);

  const kase = $derived(access ? accessCase(access) : "gherror");
  const owner = $derived((access?.repo ?? repo).split("/")[0] ?? repo);
  const ghDetail = $derived(access?.gh.state === "error" ? access.gh.detail : checkError);
  /** Raw tool output, labelled by tool — `git clone` and `gh` are command names, not prose. */
  const detailText = $derived(
    [detail && `git clone: ${detail}`, ghDetail && `gh: ${ghDetail}`].filter(Boolean).join("\n"),
  );
  const hasDetails = $derived(detailText !== "");
  /** Headline + one-line summary for the diagnosed case. */
  const head = $derived.by(() => {
    switch (kase) {
      case "denied":
        return { title: m.cloneaccess_denied_title(), body: m.cloneaccess_denied_body({ repo }) };
      case "gherror":
        return { title: m.cloneaccess_gherror_title(), body: m.cloneaccess_gherror_body({ repo }) };
      case "nogh":
        return { title: m.cloneaccess_mismatch_title(), body: m.cloneaccess_nogh_body({ repo }) };
      default:
        return {
          title: m.cloneaccess_mismatch_title(),
          body: m.cloneaccess_mismatch_body({ repo }),
        };
    }
  });

  async function check() {
    phase = "checking";
    checkError = null;
    try {
      access = await getGithubAccess(url);
    } catch (err) {
      access = null;
      checkError = err instanceof Error ? err.message : String(err);
    }
    phase = "ready";
  }

  onMount(() => {
    if (initial) {
      access = initial;
      phase = "ready";
    } else {
      void check();
    }
  });
</script>

{#snippet iconAlert()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
    ><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5h.01" /></svg
  >
{/snippet}
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
{#snippet iconRefresh()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg
  >
{/snippet}
{#snippet iconExternal()}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    ><path d="M14 5h5v5" /><path d="M19 5l-8 8" /><path
      d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"
    /></svg
  >
{/snippet}
{#snippet iconChevron(open: boolean)}
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></svg
  >
{/snippet}

{#snippet tokenSettingsLink(primary: boolean)}
  <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub settings page -->
  <a
    class="ca-gbtn"
    class:primary
    href={TOKEN_SETTINGS_URL}
    target="_blank"
    rel="noopener noreferrer"
  >
    {m.cloneaccess_fix_token_link()}{@render iconExternal()}
  </a>
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
{/snippet}

{#snippet retryButton()}
  <button type="button" class="ca-gbtn" onclick={onretry} disabled={cloning}>
    {m.common_retry()}
  </button>
{/snippet}

{#if phase === "checking"}
  <section class="ca-box" aria-busy="true" aria-label={m.cloneaccess_checking_title()}>
    <div class="ca-headtext">
      <h3 class="ca-title">{m.cloneaccess_checking_title()}</h3>
      <p>{m.cloneaccess_checking_body({ repo })}</p>
    </div>
    <CloneAccessTable {repo} access={null} />
  </section>
{:else if phase === "confirm"}
  <GhSetupConfirm
    {repo}
    login={access?.gh.state === "ok" ? access.gh.login : null}
    onback={() => (phase = "ready")}
    ondone={() => {
      phase = "done";
      onretry();
    }}
    onghunavailable={check}
  />
{:else if phase === "done"}
  <section class="ca-box ok" role="status">
    <div class="ca-head good">
      {@render iconCheck()}
      <div class="ca-headtext">
        <h3 class="ca-title">{m.cloneaccess_done_title()}</h3>
        <p>{m.cloneaccess_done_body({ repo })}</p>
      </div>
    </div>
    {#if cloning}<div class="ca-bar"></div>{/if}
  </section>
{:else}
  <section class="ca-box" aria-label={m.cloneaccess_table_label({ repo })}>
    <div class="ca-head bad">
      {@render iconAlert()}
      <div class="ca-headtext">
        <h3 class="ca-title">{head.title}</h3>
        <p>{head.body}</p>
      </div>
    </div>

    {#if access}
      {@const a = access}
      <CloneAccessTable {repo} access={a} onrecheck={kase === "nogh" ? undefined : check} />

      {#if kase === "mismatch"}
        {#if ghFixApplies(a)}
          <div class="ca-sec">
            <span class="ca-label">{m.cloneaccess_solution_label()}</span>
            <div class="ca-option primary">
              <span class="ca-option-title">
                {m.cloneaccess_fix_gh_title()}
                <span class="ca-badge">{m.cloneaccess_recommended()}</span>
              </span>
              <p>{m.cloneaccess_fix_gh_body()}</p>
              <p>
                <span class="ca-inline-label">{m.cloneaccess_consequences_label()}</span
                >{m.cloneaccess_fix_gh_consequences()}
              </p>
              {#if a.gh.state === "ok" && !a.gh.push}
                <p>{m.cloneaccess_fix_gh_nopush()}</p>
              {/if}
              <div class="ca-actions">
                <button
                  type="button"
                  class="ca-gbtn primary"
                  onclick={() => (phase = "confirm")}
                  disabled={cloning}
                >
                  {m.cloneaccess_fix_gh_action()}
                </button>
              </div>
            </div>
            <div class="ca-option">
              <span class="ca-option-title">{m.cloneaccess_fix_token_title()}</span>
              <p>{m.cloneaccess_fix_token_body({ repo })}</p>
              <div class="ca-actions">
                {@render tokenSettingsLink(false)}
                {@render retryButton()}
              </div>
            </div>
          </div>
        {:else}
          <p>{a.protocol === "ssh" ? m.cloneaccess_ssh_note() : m.cloneaccess_already_gh()}</p>
          <div class="ca-actions">{@render retryButton()}</div>
        {/if}
      {:else if kase === "denied"}
        <div class="ca-sec">
          <span class="ca-label">{m.cloneaccess_check_label()}</span>
          <ul>
            <li>{m.cloneaccess_check_url()}</li>
            <li>{m.cloneaccess_check_member({ owner })}</li>
            <li>{m.cloneaccess_check_sso({ owner })}</li>
          </ul>
        </div>
        <div class="ca-actions">{@render retryButton()}</div>
      {:else if kase === "nogh"}
        <div class="ca-sec">
          <span class="ca-label">{m.cloneaccess_solution_label()}</span>
          <div class="ca-option primary">
            <span class="ca-option-title">{m.cloneaccess_fix_token_title()}</span>
            <p>{m.cloneaccess_fix_token_body({ repo })}</p>
            <div class="ca-actions">
              {@render tokenSettingsLink(true)}
              {@render retryButton()}
            </div>
          </div>
          {#if a.protocol === "https"}
            <div class="ca-option dim">
              <span class="ca-option-title">{m.cloneaccess_fix_gh_title()}</span>
              <p>
                {a.gh.state === "missing"
                  ? m.cloneaccess_nogh_fix_missing({ repo })
                  : m.cloneaccess_nogh_fix_logged_out({ repo })}
              </p>
              <pre class="ca-code">gh auth login</pre>
              <div class="ca-actions">
                <button type="button" class="ca-gbtn primary" onclick={check}>
                  {@render iconRefresh()}{m.cloneaccess_check_gh()}
                </button>
                <span class="ca-hint">{m.cloneaccess_check_gh_hint()}</span>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="ca-actions">
          <button type="button" class="ca-gbtn primary" onclick={check}>
            {@render iconRefresh()}{m.cloneaccess_recheck()}
          </button>
          {@render retryButton()}
        </div>
      {/if}
    {:else}
      <div class="ca-actions">
        <button type="button" class="ca-gbtn primary" onclick={check}>
          {@render iconRefresh()}{m.cloneaccess_recheck()}
        </button>
        {@render retryButton()}
      </div>
    {/if}

    {#if hasDetails}
      <button
        type="button"
        class="ca-link"
        aria-expanded={showDetails}
        onclick={() => (showDetails = !showDetails)}
      >
        {@render iconChevron(showDetails)}{m.cloneaccess_details()}
      </button>
      {#if showDetails}
        <pre class="ca-code">{detailText}</pre>
      {/if}
    {/if}
  </section>
{/if}
