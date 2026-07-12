<script lang="ts">
  import type { Issue, Steer } from "$lib/types";
  import IssueContextMenu from "./IssueContextMenu.svelte";
  import IssueDetailsPopover from "./IssueDetailsPopover.svelte";

  // Renders an issue row's right-click context menu + details preview from the
  // parent's menu/details state. Extracted from IssueRow and PromptSources so
  // neither host template carries the two {#if} branches (which push their
  // synthetic <template> over the fallow Tier-1 complexity bar) and the menu +
  // popover wiring lives in one place instead of being duplicated per host.
  let {
    menu,
    details,
    steers,
    onopenissue,
    onshowdetails,
    onsteer,
    onclosemenu,
    onclosedetails,
  }: {
    menu: { issue: Issue; x: number; y: number; opener: HTMLElement; canSteer: boolean } | null;
    details: { issue: Issue; x: number; y: number; opener: HTMLElement } | null;
    steers: Steer[];
    onopenissue: () => void;
    onshowdetails: () => void;
    onsteer: (steer: Steer) => void;
    onclosemenu: () => void;
    onclosedetails: () => void;
  } = $props();
</script>

{#if menu}
  <IssueContextMenu
    x={menu.x}
    y={menu.y}
    number={menu.issue.number}
    {steers}
    canSteer={menu.canSteer}
    opener={menu.opener}
    {onopenissue}
    ondetails={onshowdetails}
    {onsteer}
    onclose={onclosemenu}
  />
{/if}
{#if details}
  <IssueDetailsPopover
    x={details.x}
    y={details.y}
    issue={details.issue}
    opener={details.opener}
    onclose={onclosedetails}
  />
{/if}
