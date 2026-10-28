<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { isConflicting } from "#lib/pr-conflict.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { UpNextPr, UpNextPrAction } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import type { UpNextPrActions } from "#lib/up-next-pr-actions.svelte.js";
  import { upNextPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import MergeMethodMenu from "./MergeMethodMenu.svelte";
  import { actionLabel, actionTip, ciWord } from "./up-next-pr-copy";
  import { buttonAction, ciShown, mergeMethodChoices } from "./up-next-prs";

  // A PR row's sub line in Up Next: its status words (conflicts or behind, workflow approval, CI,
  // approval, author, repo) and, pushed to the right edge, its one next action — a merge split
  // with ▾ when the repo allows other methods.
  let {
    pr,
    showRepo,
    actions = undefined,
  }: {
    pr: UpNextPr;
    /** Bands mix repos, so the row names its repo whenever more than one is on screen. */
    showRepo: boolean;
    /** Runs the action; without it the button shows locked. */
    actions?: UpNextPrActions;
  } = $props();

  const key = $derived(upNextPrKey(pr));
  const mergeFailed = $derived(upNextUi.mergeFailedAt(pr));
  const action = $derived(buttonAction(pr, mergeFailed));
  const requested = $derived(action === "dependabot_rebase" && upNextUi.rebaseRequested.has(key));
  const syncing = $derived(upNextUi.syncing.has(key));
  const locked = $derived(pr.action === null || !actions || !!actions.busy || requested || syncing);
  const repo = $derived(pr.repoLabel || (pr.repoPath.split("/").filter(Boolean).at(-1) ?? ""));

  function act(action: UpNextPrAction) {
    if (actions && !locked) actions.run(pr, action);
  }

  const methods = $derived(action === "merge" && actions ? mergeMethodChoices(pr) : null);
  let group = $state<HTMLElement>();
  let menuOpen = $state(false);
  $effect(() => {
    if (!methods || locked) menuOpen = false;
  });
</script>

<span class="unpr-sub">
  {#if isConflicting(pr)}
    <span class="unpr-flag unpr-conflict">{m.prspanel_conflicts()}</span>
  {:else if pr.mergeStateStatus === "behind"}
    <span class="unpr-flag unpr-behind"
      >{m.upnext_pr_behind({ base: pr.baseRefName ?? "main" })}</span
    >
  {/if}
  {#if pr.awaitingWorkflowApproval}
    <span class="unpr-flag unpr-approval">{m.prrow_awaiting_approval()}</span>
  {/if}
  <span class="unpr-ci unpr-ci-{ciShown(pr)}"
    ><span class="unpr-dot" aria-hidden="true"></span>{ciWord(pr)}</span
  >
  {#if pr.latestReview?.state === "approved"}
    <span class="unpr-approved">{m.upnext_pr_approved()}</span>
  {/if}
  {#if pr.band !== "dependabot"}<span>@{pr.author}</span>{/if}
  {#if showRepo}<span>{repo}</span>{/if}
  {#if action === "approve_on_forge"}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
    <a
      class="unpr-act"
      href={firstSafeHttpUrl(pr.url) ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      use:statusTip={{ text: actionTip(pr, mergeFailed), navigates: true }}>{actionLabel(action)}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {:else}
    <span class="unpr-act-group" bind:this={group}>
      <!-- aria-disabled, not disabled: a disabled button gets no hover, and its tip says what it
           waits for. -->
      <button
        type="button"
        class="unpr-act unpr-act-{action}"
        class:split={methods}
        aria-disabled={locked ? "true" : undefined}
        use:statusTip={{
          text: actionTip(pr, mergeFailed, syncing),
          stopClickPropagation: false,
          pinOnClick: false,
        }}
        onclick={() => act(action)}
        >{requested ? m.prspanel_rebase_requested() : actionLabel(action)}</button
      >
      {#if methods}
        <button
          type="button"
          class="unpr-act unpr-act-{action} unpr-more"
          class:open={menuOpen}
          aria-label={m.mergemethod_more()}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-disabled={locked ? "true" : undefined}
          onclick={() => {
            if (!locked) menuOpen = !menuOpen;
          }}>▾</button
        >
      {/if}
    </span>
  {/if}
</span>
{#if menuOpen && methods && group}
  <MergeMethodMenu
    anchor={group}
    number={pr.number}
    allowed={methods}
    defaultMethod={pr.mergeMethod ?? null}
    align="end"
    onpick={(method) => {
      menuOpen = false;
      if (actions && !locked) actions.merge(pr, method);
    }}
    onclose={() => (menuOpen = false)}
  />
{/if}

<style>
  .unpr-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .unpr-flag {
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .unpr-conflict {
    color: var(--color-red);
  }
  .unpr-behind,
  .unpr-approval {
    color: var(--color-warn);
  }
  .unpr-ci {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .unpr-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .unpr-ci-green,
  .unpr-approved {
    color: var(--color-green);
  }
  .unpr-ci-red {
    color: var(--color-red);
  }
  .unpr-ci-running {
    color: var(--color-amber);
  }
  .unpr-act {
    --act: var(--color-ink);
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: none;
    color: var(--act);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    text-decoration: none;
    cursor: pointer;
    transition:
      background 0.12s ease,
      border-color 0.12s ease;
  }
  .unpr-act-merge {
    --act: var(--color-green);
  }
  .unpr-act-fix {
    --act: var(--color-amber);
  }
  .unpr-act-review {
    --act: var(--color-data-2);
  }
  .unpr-act-merge,
  .unpr-act-fix,
  .unpr-act-review {
    border-color: color-mix(in srgb, var(--act) 55%, var(--color-panel));
  }
  .unpr-act:hover:not([aria-disabled="true"]) {
    background: color-mix(in srgb, var(--act) 12%, var(--color-panel));
  }
  .unpr-act:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--act);
  }
  .unpr-act-group {
    margin-left: auto;
    display: inline-flex;
  }
  /* Merge ▾: the two halves read as one control, split by a neutral rule. */
  .unpr-act.split {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .unpr-act.unpr-more {
    padding: 0 7px;
    border-left-color: var(--color-line-bright);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .unpr-act.unpr-more.open {
    background: var(--act);
    color: var(--color-bg);
  }
  .unpr-act[aria-disabled="true"] {
    border-style: dashed;
    border-color: var(--color-line-bright);
    color: var(--color-muted);
    cursor: not-allowed;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .unpr-act {
      min-height: var(--mobile-actionbar-hit);
    }
  }
</style>
