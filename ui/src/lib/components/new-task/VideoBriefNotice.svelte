<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { AgentProvider } from "$lib/types";

  let { provider }: { provider: AgentProvider } = $props();

  // Declared here as a literal, like CodexUpdateModal's releases link: svelte/no-navigation-without-
  // resolve only recognises an href as external when it can read the URL statically, and an imported
  // constant defeats that.
  const VIDEO_BRIEF_SKILL_URL =
    "https://github.com/erwins-enkel/skills/tree/main/skills/video-brief";

  const providerLabel = $derived(
    provider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude(),
  );
</script>

<!--
  Informational only (issue #2053): one line and one outbound link. No install action, no copied
  command, no dismiss — the operator decides, and the task submits either way. Sits in `.nt-notices`
  beside `.nt-upstream`, and wears the same muted micro-type so it reads as context, not an alert.
-->
<span class="nt-video-brief">
  <span>{m.newtask_video_brief_tip({ provider: providerLabel })}</span>
  <!-- The aria-label names the destination and the new tab, and CONTAINS the visible label
       verbatim — WCAG 2.5.3 (Label in Name): a speech-input user says what they can see. -->
  <a
    href={VIDEO_BRIEF_SKILL_URL}
    target="_blank"
    rel="noopener"
    aria-label={m.newtask_video_brief_link_aria()}
  >
    {m.newtask_video_brief_link()} ↗
  </a>
</span>

<style>
  .nt-video-brief {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  a {
    flex-shrink: 0;
    color: var(--color-amber);
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }
</style>
