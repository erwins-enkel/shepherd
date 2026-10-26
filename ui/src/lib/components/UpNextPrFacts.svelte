<script lang="ts">
  import { basename } from "#lib/basename.js";
  import { m } from "#lib/paraglide/messages.js";
  import { isConflicting } from "#lib/pr-conflict.js";
  import type { Session, UpNextPr } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { ciWord } from "./up-next-pr-copy";
  import { ciShown } from "./up-next-prs";

  // The PR preview's facts: mergeability, CI (expandable into the head's jobs), review, target,
  // the issue it closes, and the session working on it.
  let { pr, sessions = [] }: { pr: UpNextPr; sessions?: Session[] } = $props();

  const base = $derived(pr.baseRefName ?? "main");
  const conflict = $derived(isConflicting(pr));
  const mergeability = $derived(
    conflict
      ? m.upnext_pr_merge_conflict({ base })
      : pr.mergeStateStatus === "behind"
        ? m.upnext_pr_merge_behind({ base })
        : pr.mergeable === null
          ? m.upnext_pr_merge_checking()
          : m.upnext_pr_merge_clean(),
  );
  const review = $derived(
    pr.latestReview?.state === "approved"
      ? m.upnext_pr_review_approved({ author: `@${pr.latestReview.author}` })
      : pr.latestReview?.state === "commented"
        ? m.upnext_pr_review_commented({ author: `@${pr.latestReview.author}` })
        : m.upnext_pr_review_none(),
  );
  // Normally none: Up Next drops a PR a session holds, but a fix started from the preview shows
  // here until the snapshot catches up. Repos compare by directory name: the store keys sessions
  // by realpath, the snapshot rows by the listed path.
  const session = $derived(
    pr.headRefName
      ? sessions.find(
          (s) =>
            basename(s.repoPath) === basename(pr.repoPath) &&
            (s.branch === pr.headRefName || s.baseBranch === pr.headRefName),
        )
      : undefined,
  );
  const jobs = $derived(pr.jobs ?? []);
  let jobsOpen = $state(false);
  const jobsId = $derived(`unpr-jobs-${pr.number}`);
</script>

<dl class="unpr-facts">
  <div class="unpr-fact">
    <dt>{m.upnext_pr_fact_mergeability()}</dt>
    <dd class:unpr-bad={conflict}>{mergeability}</dd>
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
              <span
                class="unpr-dot unpr-job-{job.state}"
                role="img"
                aria-label={m.gitrail_ci_status({ status: job.state })}
              ></span>
              {#if job.url}
                <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
                <a href={firstSafeHttpUrl(job.url) ?? undefined} target="_blank" rel="noopener"
                  >{job.name}</a
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

<style>
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

  @media (max-width: 768px), (pointer: coarse) {
    .unpr-jobs-toggle {
      min-height: var(--mobile-actionbar-hit);
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
