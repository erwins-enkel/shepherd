<script lang="ts">
  import { getFrameworkDrift, createUpgradeStory } from "#lib/api.js";
  import type { FrameworkDrift } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { SvelteSet } from "svelte/reactivity";
  import { behindRows, hasEpicWork, lineLabel } from "./readiness-drift-view";

  let { repoPath }: { repoPath: string } = $props();

  let data = $state.raw<FrameworkDrift | null>(null);
  let loading = $state(true);
  let loadError = $state(false);
  /** Repos with a story create in flight — per repo, so a switch never disables another's. */
  const filing = new SvelteSet<string>();

  // Reload on repo change; drop a stale response that lands after a switch.
  $effect(() => {
    const rp = repoPath;
    loading = true;
    loadError = false;
    data = null;
    getFrameworkDrift(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        data = r;
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath) return;
        loadError = true;
        loading = false;
      });
  });

  let behind = $derived(data ? behindRows(data) : []);

  async function fileStory() {
    const rp = repoPath;
    if (filing.has(rp)) return;
    filing.add(rp);
    try {
      const res = await createUpgradeStory(rp);
      if (rp !== repoPath) return;
      if (data) data = { ...data, openStory: { number: res.number, url: res.url } };
      const msg =
        res.status === "created"
          ? m.readiness_drift_story_created({ number: res.number })
          : m.readiness_drift_story_exists({ number: res.number });
      toasts.info(msg, {
        key: "readiness-drift-story",
        action: {
          label: m.readiness_drift_view_story(),
          run: () => window.open(res.url, "_blank", "noopener,noreferrer"),
        },
      });
    } catch {
      if (rp !== repoPath) return;
      toasts.info(m.readiness_drift_story_error(), {
        alert: true,
        key: "readiness-drift-story-fail",
      });
    } finally {
      filing.delete(rp);
    }
  }
</script>

<div class="section" use:coachTarget={"readiness-drift"}>
  <div class="section-head">{m.readiness_drift_heading()}</div>
  {#if loading}
    <div class="note">{m.common_loading()}</div>
  {:else if loadError || !data}
    <div class="note error">{m.readiness_drift_load_error()}</div>
  {:else if data.resolver === "none"}
    <div class="note">{m.readiness_drift_none()}</div>
  {:else}
    {#if data.resolver === "offline"}
      <div class="note">{m.readiness_drift_offline()}</div>
    {:else if data.resolver === "partial"}
      <div class="note">{m.readiness_drift_partial()}</div>
    {/if}

    {#if behind.length}
      <div class="warning" role="status">
        <div class="warning-title">{m.readiness_drift_warning({ count: behind.length })}</div>
        {#if hasEpicWork(data)}
          <div class="warning-body">
            {m.readiness_drift_epic_hint()}
            {#if data.runningEpic !== null}
              {m.readiness_drift_running_epic({ number: data.runningEpic })}
            {/if}
            {#if data.epicBranches.length}
              {m.readiness_drift_epic_branches({ branches: data.epicBranches.join(", ") })}
            {/if}
          </div>
        {/if}
        <div class="warning-actions">
          {#if data.openStory}
            <a
              class="story-link"
              href={data.openStory.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {m.readiness_drift_open_story({ number: data.openStory.number })}
            </a>
          {:else if data.canCreateStory}
            <button class="cta" type="button" disabled={filing.has(repoPath)} onclick={fileStory}>
              {m.readiness_drift_create_story()}
            </button>
          {:else}
            <span class="note">{m.readiness_drift_story_unsupported()}</span>
          {/if}
        </div>
      </div>
    {/if}

    <ul class="list">
      {#each data.rows as r (`${r.ecosystem}:${r.name}`)}
        <li class="row">
          <span class="dot {r.state}" aria-hidden="true">{r.state === "ok" ? "●" : "○"}</span>
          <div class="row-body">
            <div class="row-title">{r.name}</div>
            <div class="row-values">
              <span>{lineLabel(r, m.readiness_drift_unknown())}</span>
              {#if r.state === "behind"}
                <span>{r.manifests.join(", ")}</span>
              {/if}
            </div>
            {#each r.dependabot as b (b.number)}
              <a class="row-hint" href={b.url} target="_blank" rel="noopener noreferrer">
                {m.readiness_drift_dependabot({ number: b.number, to: b.to })}
              </a>
            {/each}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .section {
    padding: 12px 0;
  }
  .section-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 8px;
  }
  .note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .note.error {
    color: var(--color-red);
  }
  .warning {
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    padding: 8px 10px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .warning-title {
    font-size: var(--fs-base);
    color: var(--color-amber);
  }
  .warning-body {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    word-break: break-word;
  }
  .warning-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .story-link {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .dot {
    line-height: 1.4;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .dot.ok {
    color: var(--color-green);
  }
  .dot.behind {
    color: var(--color-amber);
  }
  .row-body {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: var(--fs-base);
    color: var(--color-ink);
    word-break: break-word;
  }
  .row-values {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    word-break: break-word;
  }
  .row-hint {
    display: block;
    font-size: var(--fs-meta);
    color: var(--color-faint);
    line-height: 1.45;
  }
  .cta {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 9px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .cta:hover {
    background: var(--color-hover);
  }
  .cta:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
