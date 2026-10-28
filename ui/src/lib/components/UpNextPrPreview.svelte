<script lang="ts">
  import { untrack } from "svelte";
  import { getUpNextPrBody } from "#lib/api.js";
  import { basename } from "#lib/basename.js";
  import { LazyBody } from "#lib/lazy-body.svelte.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { repos } from "#lib/repos.svelte.js";
  import { steerAppliesToRepo } from "#lib/steer-scope.js";
  import { steers } from "#lib/steers.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { UpNextPr, UpNextPrAction } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { upNext } from "#lib/up-next.svelte.js";
  import { UpNextPrActions } from "#lib/up-next-pr-actions.svelte.js";
  import type { UpNextLaunchContext } from "#lib/up-next-start.svelte.js";
  import { findUpNextPr, upNextPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import IssueDetailHead from "./issues-panel/IssueDetailHead.svelte";
  import MergeConfirmHost from "./MergeConfirmHost.svelte";
  import MergeMethodMenu from "./MergeMethodMenu.svelte";
  import UpNextPreviewBody from "./UpNextPreviewBody.svelte";
  import UpNextPreviewFrame from "./UpNextPreviewFrame.svelte";
  import UpNextPrFacts from "./UpNextPrFacts.svelte";
  import UpNextSteerMenu from "./UpNextSteerMenu.svelte";
  import { actionLabel, actionTip, fixSummary, mergeBlockLine } from "./up-next-pr-copy";
  import { buttonAction, mergeMethodChoices } from "./up-next-prs";

  // Reading view for the Up Next PR whose title was clicked, built like the issue preview: its
  // head, the one next action (split with ▾ for steers when it starts a fix session, or for the
  // repo's other merge methods when it merges), "+ Review",
  // a locked Merge with the reason, the merge-train tick, the facts and the description.
  // Desktop renders it in the main area; the phone swaps it in place of the list (`onback`).
  let {
    launchContext = null,
    onback = undefined,
  }: {
    launchContext?: UpNextLaunchContext | null;
    onback?: () => void;
  } = $props();

  const actions = new UpNextPrActions(() => launchContext);
  // A PR just merged or handed to a fix session reads as gone, as it does in the list.
  const pr = $derived.by(() => {
    const hit = findUpNextPr(upNext.snapshot, upNextUi.previewKey);
    return hit && !upNextUi.hidesActed(upNextPrKey(hit), clock.current) ? hit : null;
  });
  const key = $derived(pr ? upNextPrKey(pr) : null);
  const loader = new LazyBody(
    () => (pr ? { repo: pr.repoPath, number: pr.number } : null),
    getUpNextPrBody,
  );

  const mergeFailed = $derived(pr ? upNextUi.mergeFailedAt(pr) : false);
  const action = $derived(pr ? buttonAction(pr, mergeFailed) : null);
  const requested = $derived(
    action === "dependabot_rebase" && key !== null && upNextUi.rebaseRequested.has(key),
  );
  const syncing = $derived(key !== null && upNextUi.syncing.has(key));
  const locked = $derived(!pr || pr.action === null || !!actions.busy || requested || syncing);
  const why = $derived(pr ? mergeBlockLine(pr) : null);
  // Opening a PR re-reads it live from the forge; the cached row shows meanwhile, its actions
  // locked until the republished snapshot lands.
  $effect(() => {
    if (key === null) return;
    const target = untrack(() => pr);
    if (target) void upNextUi.sync(target);
  });
  // Issue steers (Settings › Steers, "Show in: Backlog issues") for this repo, only beside a fix:
  // a steer leads the fix session's prompt. Merge, rebase and approve start no session.
  const fixSteers = $derived(
    pr?.action === "fix" && launchContext
      ? steers.list.filter((s) => s.onIssues && steerAppliesToRepo(s, repos.nameFor(pr.repoPath)))
      : [],
  );

  // The other merge methods the repo allows, only beside a merge.
  const methods = $derived(pr && action === "merge" ? mergeMethodChoices(pr) : null);
  const hasMenu = $derived(fixSteers.length > 0 || methods !== null);

  let startGroup = $state<HTMLElement>();
  let menuOpen = $state(false);
  $effect(() => {
    if (!hasMenu) menuOpen = false;
  });

  function run(pr: UpNextPr, action: UpNextPrAction) {
    if (!locked) actions.run(pr, action);
  }

  // Esc closes the preview (UpNextPreviewFrame) — unless the merge confirmation or the steer
  // menu has it.
  function onescape(): boolean {
    if (actions.mergeFlow.ctx) return true;
    if (!menuOpen) return false;
    menuOpen = false;
    return true;
  }
</script>

<UpNextPreviewFrame
  label={m.upnext_pr_preview_aria()}
  prevLabel={m.upnext_pr_prev()}
  nextLabel={m.upnext_pr_next()}
  order={upNextUi.prOrder}
  current={key}
  {onback}
  {onescape}
>
  {#if pr && action}
    <IssueDetailHead
      tag={m.upnext_pr_tag({ repo: pr.repoLabel || basename(pr.repoPath) })}
      number={pr.number}
      title={pr.title}
      url={pr.url}
      author={pr.author}
      createdAt={pr.createdAt}
    />
    <div class="unp-actions stack-on-phone">
      <span class="unp-start" bind:this={startGroup}>
        {#if action === "approve_on_forge"}
          <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
          <a
            class="gbtn primary"
            href={firstSafeHttpUrl(pr.url) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            use:statusTip={{ text: actionTip(pr, mergeFailed), navigates: true }}
            >{actionLabel(action)}</a
          >
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        {:else}
          <button
            type="button"
            class="gbtn primary"
            class:split={hasMenu}
            aria-disabled={locked ? "true" : undefined}
            use:statusTip={{
              text: actionTip(pr, mergeFailed, syncing),
              stopClickPropagation: false,
              pinOnClick: false,
            }}
            onclick={() => run(pr, action)}
            >{requested ? m.prspanel_rebase_requested() : actionLabel(action)}</button
          >
          {#if hasMenu}
            <button
              type="button"
              class="gbtn primary unp-more"
              class:open={menuOpen}
              aria-label={methods ? m.mergemethod_more() : m.upnext_preview_more()}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={!!actions.busy || (methods !== null && locked)}
              onclick={() => (menuOpen = !menuOpen)}>▾</button
            >
          {/if}
        {/if}
      </span>
      {#if action !== "review"}
        <button
          type="button"
          class="gbtn"
          disabled={!launchContext?.onreviewpr}
          onclick={() => actions.review(pr)}>{m.prspanel_review_button()}</button
        >
      {/if}
      {#if action !== "merge"}
        <button type="button" class="gbtn" disabled>{m.prspanel_merge_button()}</button>
      {/if}
      <label class="unp-pick unpr-pick">
        <input
          type="checkbox"
          checked={upNextUi.selected.has(upNextPrKey(pr))}
          onchange={() => upNextUi.toggle(upNextPrKey(pr))}
        />
        <span>{m.upnext_pr_select_train()}</span>
      </label>
    </div>
    {#if syncing}
      <p class="unpr-sync" role="status">{m.upnext_pr_syncing()}</p>
    {:else if why}
      <p class="unpr-why">{why}{pr.action === "fix" ? ` ${fixSummary(pr)}` : ""}</p>
    {/if}
    <UpNextPrFacts {pr} sessions={launchContext?.store.sessions} />
    <h3 class="unpr-h">{m.upnext_pr_description()}</h3>
    <UpNextPreviewBody {loader} unavailable={m.upnext_pr_body_unavailable()} />
  {/if}
</UpNextPreviewFrame>

<MergeConfirmHost flow={actions.mergeFlow} />
{#if menuOpen && pr && startGroup && methods}
  <MergeMethodMenu
    anchor={startGroup}
    number={pr.number}
    allowed={methods}
    defaultMethod={pr.mergeMethod ?? null}
    onpick={(method) => {
      menuOpen = false;
      if (!locked) actions.merge(pr, method);
    }}
    onclose={() => (menuOpen = false)}
  />
{:else if menuOpen && pr && startGroup}
  <UpNextSteerMenu
    anchor={startGroup}
    number={pr.number}
    steers={fixSteers}
    startLabel={m.upnext_pr_action_fix()}
    onstart={() => {
      menuOpen = false;
      void actions.fix(pr);
    }}
    onsteer={(s) => {
      menuOpen = false;
      void actions.fix(pr, s);
    }}
    onmanage={launchContext?.onmanagesteers
      ? () => {
          menuOpen = false;
          launchContext?.onmanagesteers?.();
        }
      : undefined}
    onclose={() => (menuOpen = false)}
  />
{/if}

<style>
  /* Beside the PR's actions the train tick sits at the row's far end. */
  .unpr-pick {
    margin-left: auto;
  }
  /* The secondary buttons read as available actions; locked ones are dashed, not faded only. */
  .unp-actions > .gbtn {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .gbtn:disabled,
  .gbtn[aria-disabled="true"] {
    color: var(--color-muted);
    border-style: dashed;
    cursor: not-allowed;
  }
  /* Why Merge is locked, and what the primary action does about it — or that the live re-read
     still runs. */
  .unpr-why,
  .unpr-sync {
    margin: -6px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .unpr-h {
    margin: 6px 0 0;
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  @media (max-width: 768px), (pointer: coarse) {
    /* Phone: the row stacks (UpNextPreviewFrame); each button spans it. */
    .unp-start > :first-child {
      flex: 1;
      justify-content: center;
    }
    .unp-actions > .gbtn {
      justify-content: center;
    }
    .unpr-pick {
      margin-left: 0;
    }
  }
</style>
