<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { epicAutoFix } from "#lib/epic-auto-fix.svelte.js";
  import { DOCS_URL } from "#lib/build-info.js";
  import {
    AUTONOMY_LEVELS,
    autonomyLevelOf,
    levelNeedsForge,
    type AutonomyLevel,
  } from "#lib/autonomy.js";
  import { autonomyLevelName } from "./sections";
  import "../automation-settings/automation-fields.css";

  // The autonomy level choice (#3445): one click sets Critic, Auto-Address, Autopilot, Auto-Drain
  // and the merge mode in one patch. The checked level is derived from the config, so a switch
  // flipped anywhere moves it — or leaves none checked: a custom mix. The repo settings' Autonomy
  // section and the first-task confirm show it.
  let { repoPath }: { repoPath: string } = $props();

  $effect(() => void repoConfig.ensure(repoPath));

  const groupName = $props.id();
  const lightweight = $derived(repoConfig.repoModeFor(repoPath) === "lightweight");
  const level = $derived(autonomyLevelOf(repoConfig.flags(repoPath), lightweight));
  // Standard is interactive-only: the drain these levels turn on halts at its first start.
  const sandboxStandard = $derived(repoConfig.effectiveSandboxProfileFor(repoPath) === "standard");
  // Until the config is in, the defaults would read as a custom mix.
  const settled = $derived(repoConfig.isConfigSettled(repoPath));
  // The window's sandbox-halt note is up — the same signal that marks the rail.
  const haltNoted = $derived(epicAutoFix.repoHalts(repoPath) > 0);

  function desc(id: AutonomyLevel): string {
    if (id === "onCall") return m.reposettings_autonomy_oncall_desc();
    if (id === "review") return m.reposettings_autonomy_review_desc();
    if (id === "backlog") return m.reposettings_autonomy_backlog_desc();
    return m.reposettings_autonomy_full_desc();
  }

  const options = $derived(
    AUTONOMY_LEVELS.map((id) => {
      const locked = lightweight && levelNeedsForge(id);
      return {
        id,
        label: autonomyLevelName(id),
        desc: desc(id),
        locked: locked ? m.automation_lightweight_unavailable() : undefined,
        sandbox: !locked && sandboxStandard && levelNeedsForge(id),
      };
    }),
  );
</script>

<div class="rs-choice" role="radiogroup" aria-label={m.reposettings_autonomy_name()}>
  {#each options as opt (opt.id)}
    {@const id = `${groupName}-${opt.id}`}
    <label class={["rs-choice-opt", { on: level === opt.id, locked: !!opt.locked }]}>
      <input
        type="radio"
        name={groupName}
        value={opt.id}
        checked={level === opt.id}
        disabled={!!opt.locked}
        aria-labelledby={id}
        aria-describedby={[
          `${id}-desc`,
          opt.sandbox ? `${id}-sandbox` : "",
          opt.locked ? `${id}-lock` : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onchange={() => repoConfig.setAutonomyLevel(repoPath, opt.id)}
      />
      <span class="rs-choice-text">
        <span class="rs-choice-name" {id}>{opt.label}</span>
        <span class="rs-choice-desc" id="{id}-desc"
          >{opt.desc}
          {#if opt.id === "full"}
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external docs URL -->
            <a
              class="guide"
              href={`${DOCS_URL}hands-off-epics/`}
              target="_blank"
              rel="noopener noreferrer">{m.reposettings_autonomy_full_guide()}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          {/if}</span
        >
        {#if opt.sandbox}
          <span class="halt" id="{id}-sandbox"
            >⚠ {m.reposettings_autonomy_sandbox_halt()}
            {haltNoted
              ? m.reposettings_autonomy_sandbox_see_hint()
              : m.reposettings_autonomy_sandbox_change()}</span
          >
        {/if}
        {#if opt.locked}<span class="rs-choice-lock" id="{id}-lock">{opt.locked}</span>{/if}
      </span>
    </label>
  {/each}
</div>
{#if settled && level === "custom"}
  <p class="custom" role="status">{m.reposettings_autonomy_custom_note()}</p>
{/if}

<style>
  .guide {
    color: var(--color-blue);
    text-decoration: none;
    white-space: nowrap;
  }
  .guide:hover,
  .guide:focus-visible {
    text-decoration: underline;
  }
  .halt {
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .custom {
    margin: 6px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
