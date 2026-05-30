<script lang="ts">
  import type { Session } from "$lib/types";
  import { elapsed, STATUS_COLOR, statusLabel } from "$lib/format";
  import StatusPip from "./StatusPip.svelte";

  let {
    session,
    selected,
    nowMs,
    onselect
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
  } = $props();
</script>

<button
  class="unit"
  class:sel={selected}
  style="--rule:{STATUS_COLOR[session.status]}"
  onclick={() => onselect(session.id)}
  type="button"
>
  <div class="pip-col">
    <StatusPip status={session.status} />
  </div>

  <div class="u-main">
    <div class="u-top">
      <span class="desig micro">{session.desig}</span>
      <span class="name">{session.name}</span>
    </div>
    <div class="u-sub">
      {session.prompt}
      {#if session.status === "running"}
        <span class="car">▏</span>
      {/if}
    </div>
  </div>

  <div class="u-right">
    <span class="badge">{statusLabel(session.status)}</span>
    <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    <span class="meta">{session.herdrSession || "—"}</span>
  </div>
</button>

<style>
  .unit {
    position: relative;
    display: grid;
    grid-template-columns: 14px 1fr auto;
    gap: 12px;
    align-items: start;
    padding: 11px 13px 11px 14px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
  }

  :global(.unit + .unit) {
    margin-top: 2px;
  }

  .unit::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: var(--rule, var(--color-faint));
  }

  .unit:hover {
    border-color: var(--color-line);
    background: #0c1110;
  }

  .unit.sel {
    border-color: var(--color-line-bright);
    background:
      radial-gradient(
        120% 140% at 0% 50%,
        color-mix(in srgb, var(--rule) 9%, transparent),
        transparent 70%
      ),
      #0c1211;
  }

  /* bracket corners on selected */
  .unit.sel::after {
    content: "";
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
    border-left: 0;
    border-top: 0;
  }

  .pip-col {
    display: flex;
    align-items: flex-start;
    padding-top: 5px;
  }

  .u-main {
    min-width: 0;
  }

  .u-top {
    display: flex;
    align-items: baseline;
    gap: 0;
  }

  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .desig {
    margin-right: 9px;
  }

  .name {
    color: var(--color-ink-bright);
    font-weight: 500;
    letter-spacing: 0.04em;
  }

  .u-sub {
    color: var(--color-muted);
    margin-top: 3px;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 34ch;
  }

  .car {
    color: var(--color-amber);
    animation: blink 1.1s steps(1) infinite;
  }

  .u-right {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    flex-shrink: 0;
  }

  .badge {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 2px 7px;
    border: 1px solid var(--rule);
    color: var(--rule);
    border-radius: 2px;
    white-space: nowrap;
  }

  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
  }

  .meta {
    color: var(--color-muted);
    font-size: 11.5px;
  }

  @media (max-width: 768px) {
    .unit {
      min-height: 44px;
    }
  }
</style>
