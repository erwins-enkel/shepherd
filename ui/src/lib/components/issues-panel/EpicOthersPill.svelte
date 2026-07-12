<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { EpicOthersFlag } from "../issues-panel";

  // The "someone else is working / owns this epic" pill (#1616), extracted from IssueRow so
  // that row's <template> stays under the fallow Tier-1 complexity bar (40/60). Renders nothing
  // when the epic isn't flagged. The tier→copy resolution lives in the script (a derived), so
  // the markup itself is a single element.
  let { flag = null }: { flag?: EpicOthersFlag | null } = $props();

  const who = $derived(flag ? flag.who.join(", ") : "");
  const label = $derived.by(() => {
    if (!flag) return "";
    switch (flag.tier) {
      case "inflight":
        return who
          ? m.issuerow_epic_inflight_pill({ count: flag.inFlight, who })
          : m.issuerow_epic_inflight_pill_plain({ count: flag.inFlight });
      case "assigned":
        return m.issuerow_epic_assigned_pill({ who });
      default:
        return m.issuerow_epic_authored_pill({ who });
    }
  });
</script>

{#if flag}
  <span class="others-pill" title={m.issuerow_epic_others_notice({ who })}>{label}</span>
{/if}

<style>
  /* "Someone else is already working / owns this epic" pill (#1616). Amber running/in-progress
     token so it reads as one signal with the EPIC badge, not a competing hue. */
  .others-pill {
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--status-running);
    border: 1px solid var(--status-running);
    border-radius: 2px;
    padding: 1px 5px;
    background: color-mix(in srgb, var(--status-running) 14%, transparent);
    white-space: nowrap;
  }
</style>
