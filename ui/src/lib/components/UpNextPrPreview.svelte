<script lang="ts">
  import { getUpNextPrBody } from "#lib/api.js";
  import { basename } from "#lib/basename.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { isConflicting } from "#lib/pr-conflict.js";
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
  import MarkdownBody from "./MarkdownBody.svelte";
  import MergeConfirmHost from "./MergeConfirmHost.svelte";
  import UpNextSteerMenu from "./UpNextSteerMenu.svelte";
  import { swipeBack } from "./swipe-back";
  import { actionLabel, actionTip, ciWord, fixSummary, mergeBlockLine } from "./up-next-pr-copy";
  import { buttonAction, ciShown } from "./up-next-prs";

  // Reading view for the Up Next PR whose title was clicked, built like the issue preview: its
  // head, the one next action (split with ▾ for steers when it starts a fix session), "+ Review",
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
  const index = $derived(key ? upNextUi.prOrder.indexOf(key) : -1);
  const total = $derived(upNextUi.prOrder.length);

  const previewRepo = $derived(pr?.repoPath ?? null);
  const previewNumber = $derived(pr?.number ?? null);
  let body = $state<string | null>(null);
  let bodyError = $state(false);
  let bodyRetry = $state(0);
  $effect(() => {
    const repo = previewRepo;
    const number = previewNumber;
    void bodyRetry;
    body = null;
    bodyError = false;
    if (repo === null || number === null) return;
    let current = true;
    void getUpNextPrBody(repo, number).then(
      (result) => {
        if (current) body = result.body;
      },
      () => {
        if (current) bodyError = true;
      },
    );
    return () => {
      current = false;
    };
  });

  const action = $derived(pr ? buttonAction(pr) : null);
  const requested = $derived(
    action === "dependabot_rebase" && key !== null && upNextUi.rebaseRequested.has(key),
  );
  const locked = $derived(!pr || pr.action === null || !!actions.busy || requested);
  const why = $derived(pr ? mergeBlockLine(pr) : null);
  const base = $derived(pr?.baseRefName ?? "main");
  // Issue steers (Settings › Steers, "Show in: Backlog issues") for this repo, only beside a fix:
  // a steer leads the fix session's prompt. Merge, rebase and approve start no session.
  const fixSteers = $derived(
    pr?.action === "fix" && launchContext
      ? steers.list.filter((s) => s.onIssues && steerAppliesToRepo(s, repos.nameFor(pr.repoPath)))
      : [],
  );
  // The session working on this PR, when the store knows one (normally none: Up Next drops PRs
  // a session holds, but a fix started from here shows until the snapshot catches up).
  const session = $derived(
    pr?.headRefName
      ? (launchContext?.store.sessions ?? []).find(
          (s) =>
            basename(s.repoPath) === basename(pr.repoPath) &&
            (s.branch === pr.headRefName || s.baseBranch === pr.headRefName),
        )
      : undefined,
  );
  const mergeability = $derived(
    !pr
      ? ""
      : isConflicting(pr)
        ? m.upnext_pr_merge_conflict({ base })
        : pr.mergeStateStatus === "behind"
          ? m.upnext_pr_merge_behind({ base })
          : pr.mergeable === null
            ? m.upnext_pr_merge_checking()
            : m.upnext_pr_merge_clean(),
  );
  const review = $derived(
    pr?.latestReview?.state === "approved"
      ? m.upnext_pr_review_approved({ author: `@${pr.latestReview.author}` })
      : pr?.latestReview?.state === "commented"
        ? m.upnext_pr_review_commented({ author: `@${pr.latestReview.author}` })
        : m.upnext_pr_review_none(),
  );
  const jobs = $derived(pr?.jobs ?? []);
  let jobsOpen = $state(false);
  const jobsId = $derived(`unpr-jobs-${pr?.number ?? 0}`);

  let startGroup = $state<HTMLElement>();
  let menuOpen = $state(false);
  $effect(() => {
    if (fixSteers.length === 0) menuOpen = false;
  });

  function run(pr: UpNextPr, action: UpNextPrAction) {
    if (locked) return;
    if (action === "merge") actions.merge(pr);
    else if (action === "review") actions.review(pr);
    else if (action === "fix") void actions.fix(pr);
    else if (action === "dependabot_rebase") void actions.rebase(pr);
  }

  function step(by: number) {
    if (index < 0 || total < 2) return;
    upNextUi.previewKey = upNextUi.prOrder[(index + by + total) % total]!;
  }
  function close() {
    if (onback) onback();
    else upNextUi.previewKey = null;
  }
  // Phone (`onback` set): a rightward swipe returns to the list, as on an issue.
  let dragX = $state(0);
  const backSwipe = swipeBack({ onback: () => onback?.(), onoffset: (px) => (dragX = px) });

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented || actions.mergeFlow.ctx) return;
    if (menuOpen) {
      menuOpen = false;
      return;
    }
    e.preventDefault();
    close();
  }
</script>

<!-- Esc closes the preview while focus is inside it (the handler only listens). -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="unp"
  class:swiping={dragX > 0}
  aria-label={m.upnext_pr_preview_aria()}
  {onkeydown}
  {@attach onback ? backSwipe : undefined}
  style:transform={dragX > 0 ? `translateX(${dragX}px)` : undefined}
>
  <div class="unp-bar">
    {#if onback}
      <button type="button" class="unp-back" onclick={onback}>← {m.issuedetail_back()}</button>
    {:else}
      <span class="unp-label">{m.upnext_preview_title()}</span>
    {/if}
    {#if index >= 0}
      <span class="unp-pos">{m.upnext_preview_position({ index: index + 1, total })}</span>
    {/if}
    <span class="unp-spacer"></span>
    {#if pr}
      <button
        type="button"
        class="icon-btn unp-icon"
        disabled={total < 2}
        title={m.upnext_pr_prev()}
        aria-label={m.upnext_pr_prev()}
        onclick={() => step(-1)}>‹</button
      >
      <button
        type="button"
        class="icon-btn unp-icon"
        disabled={total < 2}
        title={m.upnext_pr_next()}
        aria-label={m.upnext_pr_next()}
        onclick={() => step(1)}>›</button
      >
    {/if}
    {#if pr && !onback}
      <button
        type="button"
        class="icon-btn unp-icon"
        title={m.common_close()}
        aria-label={m.common_close()}
        onclick={close}>×</button
      >
    {/if}
  </div>

  {#if pr && key && action}
    <div class="unp-body">
      <IssueDetailHead
        tag={m.upnext_pr_tag({ repo: pr.repoLabel || basename(pr.repoPath) })}
        number={pr.number}
        title={pr.title}
        url={pr.url}
        author={pr.author}
        createdAt={pr.createdAt}
      />
      <div class="unp-actions">
        <span class="unp-start" bind:this={startGroup}>
          {#if action === "approve_on_forge"}
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
            <a
              class="gbtn primary"
              href={firstSafeHttpUrl(pr.url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              use:statusTip={{ text: actionTip(pr), navigates: true }}>{actionLabel(action)}</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          {:else}
            <button
              type="button"
              class="gbtn primary"
              class:split={fixSteers.length > 0}
              aria-disabled={locked ? "true" : undefined}
              use:statusTip={{
                text: actionTip(pr),
                stopClickPropagation: false,
                pinOnClick: false,
              }}
              onclick={() => run(pr, action)}
              >{requested ? m.prspanel_rebase_requested() : actionLabel(action)}</button
            >
            {#if fixSteers.length > 0}
              <button
                type="button"
                class="gbtn primary unp-more"
                class:open={menuOpen}
                aria-label={m.upnext_preview_more()}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={!!actions.busy}
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
        <label class="unp-pick">
          <input
            type="checkbox"
            checked={upNextUi.selected.has(key)}
            onchange={() => upNextUi.toggle(key)}
          />
          <span>{m.upnext_pr_select_train()}</span>
        </label>
      </div>
      {#if why}
        <p class="unpr-why">{why}{pr.action === "fix" ? ` ${fixSummary(pr)}` : ""}</p>
      {/if}
      <dl class="unpr-facts">
        <div class="unpr-fact">
          <dt>{m.upnext_pr_fact_mergeability()}</dt>
          <dd class:unpr-bad={isConflicting(pr)}>{mergeability}</dd>
        </div>
        <div class="unpr-fact">
          <dt>{m.upnext_pr_fact_ci()}</dt>
          <dd>
            <span class="unpr-ci unpr-ci-{ciShown(pr)}"
              ><span class="unpr-dot" aria-hidden="true"></span>{ciWord(pr)}</span
            >
            {#if jobs.length > 0}
              <button
                type="button"
                class="unpr-jobs-toggle"
                aria-expanded={jobsOpen}
                aria-controls={jobsId}
                onclick={() => (jobsOpen = !jobsOpen)}
                >{jobsOpen ? m.prspanel_jobs_hide() : m.prspanel_jobs_show()}
                {jobsOpen ? "▾" : "▸"}</button
              >
            {/if}
            {#if jobsOpen && jobs.length > 0}
              <!-- key includes the index: a matrix build can repeat a check name. -->
              <ul class="unpr-jobs" id={jobsId}>
                {#each jobs as job, i (job.name + " " + i)}
                  <li>
                    <span class="unpr-ci unpr-job-{job.state}"
                      ><span
                        class="unpr-dot"
                        role="img"
                        aria-label={m.gitrail_ci_status({ status: job.state })}
                      ></span></span
                    >
                    {#if job.url}
                      <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
                      <a
                        href={firstSafeHttpUrl(job.url) ?? undefined}
                        target="_blank"
                        rel="noopener">{job.name}</a
                      >
                      <!-- eslint-enable svelte/no-navigation-without-resolve -->
                    {:else}
                      <span>{job.name}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </dd>
        </div>
        <div class="unpr-fact">
          <dt>{m.upnext_pr_fact_review()}</dt>
          <dd>{review}</dd>
        </div>
        <div class="unpr-fact">
          <dt>{m.upnext_pr_fact_target()}</dt>
          <dd>{base}{pr.mergeMethod ? ` · ${pr.mergeMethod}` : ""}</dd>
        </div>
        <div class="unpr-fact">
          <dt>{m.upnext_pr_fact_closes()}</dt>
          <dd>{pr.closesIssue ? `#${pr.closesIssue}` : "—"}</dd>
        </div>
        <div class="unpr-fact">
          <dt>{m.upnext_pr_fact_session()}</dt>
          <dd>{session ? session.desig : m.upnext_pr_session_none()}</dd>
        </div>
      </dl>
      <h3 class="unpr-h">{m.upnext_pr_description()}</h3>
      {#if bodyError}
        <div role="alert">
          <p>{m.upnext_pr_body_unavailable()}</p>
          <button type="button" class="gbtn" onclick={() => bodyRetry++}>{m.common_retry()}</button>
        </div>
      {:else if body === null}
        <p role="status">{m.common_loading()}</p>
      {:else}
        <MarkdownBody source={body} />
      {/if}
    </div>
  {:else}
    <p class="unp-empty">{m.upnext_preview_empty()}</p>
  {/if}
</section>

<MergeConfirmHost flow={actions.mergeFlow} />
{#if menuOpen && pr && startGroup}
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
  /* Shell, bar and action row mirror UpNextPreview (scoped styles, so a deliberate copy). */
  .unp {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    min-width: 0;
    flex: 1;
    transition: transform 0.18s ease-out;
  }
  .unp.swiping {
    transition: none;
    box-shadow: var(--shadow-popover);
  }
  .unp-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .unp-label {
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  .unp-pos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .unp-spacer {
    flex: 1;
  }
  .unp-back {
    padding: 4px 2px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .unp-back:hover {
    color: var(--color-ink);
  }
  .unp-icon {
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    color: var(--color-muted);
  }
  .unp-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px 32px;
  }
  .unp-body > :global(*) {
    max-width: 80ch;
  }
  .unp-body > .unp-actions {
    max-width: none;
  }
  .unp-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-block: 10px;
    border-block: 1px solid var(--color-line);
  }
  .unp-start {
    flex: none;
    display: inline-flex;
  }
  .gbtn.split {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .gbtn.primary.unp-more {
    padding-inline: 8px;
    border-left-color: var(--color-line-bright);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .gbtn.primary.unp-more.open {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .unp-pick {
    flex: none;
    margin-left: auto;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    cursor: pointer;
  }
  .unp-pick input {
    margin: 0;
    accent-color: var(--color-amber);
    cursor: pointer;
  }
  /* Canonical .gbtn recipe (/design-system) — scoped copy, as in UpNextPreview. */
  .gbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-decoration: none;
    cursor: pointer;
  }
  .gbtn:not(.primary) {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn.primary:hover:not(:disabled):not([aria-disabled="true"]) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled,
  .gbtn[aria-disabled="true"] {
    color: var(--color-muted);
    border-style: dashed;
    cursor: not-allowed;
  }
  .unp-empty {
    flex: 1;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  /* Why Merge is locked, and what the primary action does about it. */
  .unpr-why {
    margin: -6px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .unpr-facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0;
    border: 1px solid var(--color-line);
  }
  .unpr-fact {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .unpr-fact:nth-child(odd) {
    border-right: 1px solid var(--color-line);
  }
  .unpr-fact:nth-last-child(-n + 2) {
    border-bottom: 0;
  }
  .unpr-fact dt {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .unpr-fact dd {
    margin: 0;
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
  .unpr-bad {
    color: var(--color-red);
  }
  .unpr-ci {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .unpr-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .unpr-ci-green,
  .unpr-job-success {
    color: var(--color-green);
  }
  .unpr-ci-red,
  .unpr-job-failure {
    color: var(--color-red);
  }
  .unpr-ci-running,
  .unpr-job-pending {
    color: var(--color-amber);
  }
  .unpr-job-none {
    color: var(--color-muted);
  }
  .unpr-jobs-toggle {
    margin-left: 6px;
    padding: 0;
    background: none;
    border: 0;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .unpr-jobs-toggle:hover {
    color: var(--color-amber);
  }
  .unpr-jobs {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: var(--fs-meta);
  }
  .unpr-jobs li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .unpr-jobs a {
    color: var(--color-ink);
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
    .unp-icon,
    .unp-more {
      min-width: var(--mobile-actionbar-hit);
    }
    .unp-icon {
      width: var(--mobile-actionbar-hit);
      height: var(--mobile-actionbar-hit);
    }
    .unp-back,
    .gbtn,
    .unp-pick,
    .unpr-jobs-toggle {
      min-height: var(--mobile-actionbar-hit);
    }
    .unp-body {
      padding: 14px;
    }
    /* Phone: the actions stack, full width, the primary first. */
    .unp-actions {
      flex-direction: column;
      align-items: stretch;
    }
    .unp-start > :first-child {
      flex: 1;
      justify-content: center;
    }
    .unp-actions > .gbtn {
      justify-content: center;
    }
    .unp-pick {
      margin-left: 0;
    }
    .unpr-facts {
      grid-template-columns: minmax(0, 1fr);
    }
    .unpr-fact:nth-child(odd) {
      border-right: 0;
    }
    .unpr-fact:nth-last-child(2) {
      border-bottom: 1px solid var(--color-line);
    }
  }
</style>
