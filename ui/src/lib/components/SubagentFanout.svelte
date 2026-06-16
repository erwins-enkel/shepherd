<script lang="ts">
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import type { SubagentEntry } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // The full per-session roster map (store.subagents), threaded like store.activity /
  // store.workingBlocked. We derive this session's roster from it so the section stays
  // reactive to the live `session:subagents` WS event.
  let {
    sessionId,
    subagents = {},
  }: { sessionId: string; subagents?: Record<string, SubagentEntry[]> } = $props();

  const roster = $derived(subagents[sessionId] ?? []);

  // Live entries (no endedAt) first, then done — newest is fine in insertion order.
  const rows = $derived(
    [...roster].sort((a, b) => Number(a.endedAt != null) - Number(b.endedAt != null)),
  );
  const liveCount = $derived(roster.filter((e) => e.endedAt == null).length);

  // Client tick for live durations; only runs while ≥1 entry is live.
  let now = $state(Date.now());
  $effect(() => {
    if (liveCount === 0) return; // no live entries → no timer
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  /** Duration in ms → `m:ss` (or `h:mm:ss` ≥1h). Unit notation, not translated. */
  function fmtDur(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const s = total % 60;
    const min = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const ss = String(s).padStart(2, "0");
    if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${ss}`;
    return `${min}:${ss}`;
  }

  // For a live entry clamp to non-negative: startedAt is SERVER time, `now` ticks on
  // the client, so skew could otherwise yield a negative elapsed.
  function duration(e: SubagentEntry): string {
    return fmtDur(e.endedAt != null ? e.endedAt - e.startedAt : Math.max(0, now - e.startedAt));
  }
</script>

{#if roster.length}
  <!-- coachTarget id "subagent-fanout" matches the Task-5 FeatureAnnouncement.targetId -->
  <section class="fanout" use:coachTarget={"subagent-fanout"}>
    <header class="head">
      <span class="title">{m.subagents_section_title()}</span>
      <span class="count">{m.subagents_live_count({ count: liveCount })}</span>
    </header>
    <ul aria-live="polite">
      {#each rows as e (e.agentId)}
        {@const live = e.endedAt == null}
        <li>
          <span class="dot" class:live aria-hidden="true"></span>
          <span class="type">{e.agentType}</span>
          <span class="status" class:live
            >{live ? m.subagent_status_live() : m.subagent_status_done()}</span
          >
          <span class="dur">{duration(e)}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .fanout {
    flex-shrink: 0;
    max-height: 40%;
    overflow-y: auto;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding-bottom: 4px;
  }
  .title {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .count {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    color: var(--color-ink);
    white-space: nowrap;
  }
  .dot {
    align-self: center;
    width: 0.5em;
    height: 0.5em;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--status-done);
  }
  .dot.live {
    background: var(--color-blue);
  }
  .type {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .status.live {
    color: var(--color-blue);
  }
  .dur {
    margin-left: auto;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
</style>
