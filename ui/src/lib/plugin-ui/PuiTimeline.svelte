<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { toneColor } from "./tones";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});

  interface TimelineEvent {
    at: string;
    label: string;
    caption: string | null;
    tone: unknown;
    color: string;
  }

  const events = $derived.by((): TimelineEvent[] => {
    if (!Array.isArray(p.events)) return [];
    return (p.events as unknown[]).map((e): TimelineEvent => {
      const ev = e != null && typeof e === "object" ? (e as Record<string, unknown>) : {};
      return {
        at: String(ev.at ?? ""),
        label: String(ev.label ?? ""),
        caption: ev.caption != null ? String(ev.caption) : null,
        tone: ev.tone,
        color: toneColor(ev.tone),
      };
    });
  });
</script>

{#if events.length === 0}
  <p class="pui-timeline-empty">{m.plugin_ui_timeline_empty()}</p>
{:else}
  <ol class="pui-timeline">
    {#each events as ev, i (i)}
      <li class="pui-timeline-event">
        <span class="pui-timeline-dot" style:background={ev.color}></span>
        <div class="pui-timeline-content">
          <span class="pui-timeline-at">{ev.at}</span>
          <span class="pui-timeline-label">{ev.label}</span>
          {#if ev.caption != null}
            <span class="pui-timeline-caption">{ev.caption}</span>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .pui-timeline-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .pui-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .pui-timeline-event {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    position: relative;
    padding-bottom: 12px;
  }
  .pui-timeline-event:last-child {
    padding-bottom: 0;
  }
  /* Connecting vertical line between dots */
  .pui-timeline-event:not(:last-child)::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 12px;
    bottom: 0;
    width: 1px;
    background: var(--color-line);
  }
  .pui-timeline-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .pui-timeline-content {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .pui-timeline-at {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .pui-timeline-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-weight: 500;
  }
  .pui-timeline-caption {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
</style>
