<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { repoConfig } from "$lib/reviews.svelte";
  import { checkBrowserHost } from "$lib/browser-hosts";
  import { browserAllowedHostsExplanation } from "$lib/tooltips/explanations";
  import InfoTip from "../InfoTip.svelte";
  import "./automation-fields.css";

  let { repoPath }: { repoPath: string } = $props();
  const uid = $props.id();
  const errorId = `${uid}-error`;

  const hosts = $derived(repoConfig.browserAllowedHostsFor(repoPath));
  let draft = $state("");
  let error = $state<string | null>(null);

  const ERRORS = {
    empty: () => m.automation_browser_hosts_err_empty(),
    invalid: () => m.automation_browser_hosts_err_invalid(),
    ip: () => m.automation_browser_hosts_err_ip(),
    duplicate: () => m.automation_browser_hosts_err_duplicate(),
  };

  function add() {
    const r = checkBrowserHost(draft, hosts);
    if (!r.ok) {
      error = ERRORS[r.reason]();
      return;
    }
    error = null;
    draft = "";
    void repoConfig.setBrowserAllowedHosts(repoPath, [...hosts, r.host]);
  }

  function remove(host: string) {
    void repoConfig.setBrowserAllowedHosts(
      repoPath,
      hosts.filter((h) => h !== host),
    );
  }
</script>

<!-- Only meaningful while the Shared browser is on: the allowlist governs its autonomous attaches. -->
{#if repoConfig.sharedBrowserOn(repoPath)}
  <div class="drain-fields browser-hosts">
    <div class="drain-label hosts-label">
      {m.automation_browser_hosts_label()}
      <InfoTip text={browserAllowedHostsExplanation()} label={m.tooltip_browser_hosts_title()} />
    </div>
    {#if hosts.length}
      <ul class="hosts">
        {#each hosts as host (host)}
          <li class="host">
            <span class="host-name">{host}</span>
            <button
              class="host-remove"
              type="button"
              aria-label={m.automation_browser_hosts_remove({ host })}
              onclick={() => remove(host)}>×</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <div class="hosts-note">{m.automation_browser_hosts_empty()}</div>
    {/if}
    <form
      class="drain-field"
      onsubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input
        class="afield-num txt"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder={m.automation_browser_hosts_placeholder()}
        aria-label={m.automation_browser_hosts_label()}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        bind:value={draft}
        oninput={() => (error = null)}
      />
      <button class="gbtn" type="submit">{m.automation_browser_hosts_add()}</button>
    </form>
    {#if error}
      <div class="hosts-error" id={errorId} role="alert">{error}</div>
    {/if}
    <div class="hosts-note">{m.automation_browser_hosts_hint()}</div>
  </div>
{/if}

<style>
  .hosts-label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hosts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .host {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 2px 1px 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .host-name {
    overflow-wrap: anywhere;
  }
  .host-remove {
    background: transparent;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
    line-height: 1;
    padding: 0 4px;
  }
  .host-remove:hover,
  .host-remove:focus-visible {
    color: var(--color-red);
    outline: none;
  }
  .afield-num[aria-invalid="true"] {
    border-color: var(--color-red);
  }
  .hosts-error {
    font-size: var(--fs-meta);
    color: var(--color-red);
  }
  .hosts-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  /* Canonical action-button recipe from /design-system (no global .gbtn in app.css). */
  .gbtn {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
