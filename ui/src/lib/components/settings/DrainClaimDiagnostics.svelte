<script lang="ts">
  import { getDrain, resolveDrainClaim, ApiError } from "#lib/api.js";
  import type { DrainStatus, ClaimDiagnostic } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { basename } from "#lib/basename.js";
  import { m } from "#lib/paraglide/messages.js";

  let { refreshToken = 0 }: { refreshToken?: number } = $props();
  let statuses = $state<DrainStatus[]>([]);
  let error = $state("");
  let busy = $state(false);
  let confirming = $state<{
    repoPath: string;
    claim: ClaimDiagnostic;
    action: "release" | "close";
  } | null>(null);
  let readVersion = 0;
  const rows = $derived(
    statuses.flatMap((s) =>
      (s.claimDiagnostics ?? []).map((claim) => ({ repoPath: s.repoPath, claim })),
    ),
  );

  async function refresh() {
    const version = ++readVersion;
    try {
      const next = await getDrain();
      if (version === readVersion) {
        statuses = next;
        error = "";
      }
    } catch {
      if (version === readVersion) error = m.drain_claims_load_failed();
    }
  }

  $effect(() => {
    void refreshToken;
    void refresh();
    return () => {
      readVersion++;
    };
  });

  async function resolve() {
    if (!confirming || busy) return;
    const { repoPath, claim, action } = confirming;
    busy = true;
    error = "";
    try {
      await resolveDrainClaim(repoPath, claim.number, action);
      confirming = null;
      await refresh();
    } catch (e) {
      error =
        e instanceof ApiError && e.status === 409
          ? m.drain_claims_changed()
          : m.drain_claims_failed();
    } finally {
      busy = false;
    }
  }
</script>

{#if rows.length || error || statuses.some((s) => s.claimDiagnosticsFailed)}
  <section class="claims" aria-label={m.drain_claims_title()}>
    <h3>{m.drain_claims_title()}</h3>
    <p>{m.drain_claims_summary()}</p>
    {#if statuses.some((s) => s.claimDiagnosticsFailed)}<p role="alert">
        {m.drain_claims_load_failed()}
      </p>{/if}
    {#each rows as { repoPath, claim } (`${repoPath}:${claim.number}`)}
      <div class="claim">
        <span class="repo">{basename(repoPath)}</span>
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a href={firstSafeHttpUrl(claim.url) ?? undefined} target="_blank" rel="noreferrer"
          >#{claim.number} {claim.title}</a
        >
        <p>{m.drain_claims_ownership()}</p>
        {#if claim.evidence === "unknown"}
          <p>{m.drain_claims_unverified()}</p>
        {:else}
          {#if claim.mergedPrs.length}
            <div class="actions">
              <span>{m.drain_claims_merged()}:</span>
              {#each claim.mergedPrs as pr (pr.url)}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
                <a href={firstSafeHttpUrl(pr.url) ?? undefined} target="_blank" rel="noreferrer"
                  >#{pr.number}</a
                >
              {/each}
            </div>
          {/if}
          <div class="actions">
            <button
              type="button"
              class="gbtn"
              disabled={busy}
              onclick={() => {
                confirming = { repoPath, claim, action: "release" };
                error = "";
              }}>{m.drain_claims_release()}</button
            >
            {#if claim.mergedPrs.length}
              <button
                type="button"
                class="gbtn"
                disabled={busy}
                onclick={() => {
                  confirming = { repoPath, claim, action: "close" };
                  error = "";
                }}>{m.drain_claims_close()}</button
              >
            {/if}
          </div>
          {#if confirming?.repoPath === repoPath && confirming.claim.number === claim.number}
            <div class="confirmation">
              <p>
                {confirming.action === "release"
                  ? m.drain_claims_confirm_release()
                  : m.drain_claims_confirm_close()}
              </p>
              <div class="actions">
                <button type="button" class="gbtn primary" disabled={busy} onclick={resolve}
                  >{busy ? m.common_loading() : m.drain_claims_confirm()}</button
                >
                <button
                  type="button"
                  class="gbtn"
                  disabled={busy}
                  onclick={() => {
                    confirming = null;
                  }}>{m.common_cancel()}</button
                >
              </div>
            </div>
          {/if}
        {/if}
      </div>
    {/each}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .claims {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  h3 {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  p {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .claim {
    display: grid;
    gap: 8px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
    overflow-wrap: anywhere;
  }
  .repo {
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }
  a {
    color: var(--color-amber);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: var(--fs-meta);
  }
  .confirmation {
    border-left: 2px solid var(--color-amber);
    padding: 8px 12px;
    display: grid;
    gap: 8px;
  }
  .error {
    color: var(--color-red);
  }
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 6px 8px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled),
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  @media (pointer: coarse) {
    .gbtn {
      min-height: 44px;
    }
  }
</style>
