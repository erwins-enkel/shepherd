<script lang="ts">
  import { untrack } from "svelte";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { SessionArtifact } from "#lib/types.js";
  import { isArtifactUrl, shortArtifactUrl } from "../../../../../shared/artifact-url";
  import ArtifactMenu from "./ArtifactMenu.svelte";

  // The artifact row (#3875): where the merge row sits, for a session without a PR whose agent
  // published an artifact. The newest one, its facts, Copy link and the one amber action, Open ↗.
  // With more than one, "All N" opens the menu of every artifact; with one, ⋯ holds "Show in Chat"
  // and "Hide for this session" (#3877).
  // Title and url are agent data — text only; the link takes the url only as a claude.ai artifact.
  let {
    sessionId,
    artifacts,
    mobile = false,
    touch = false,
    onshowinchat,
    onhide,
  }: {
    /** The session the row shows; a copy still pending when it changes confirms nothing. */
    sessionId: string;
    /** What the row shows, newest first (`rowArtifacts`); never empty. */
    artifacts: SessionArtifact[];
    /** Phone: stacked layout (label + title, facts, action row). */
    mobile?: boolean;
    /** Any touch device: 44px targets. */
    touch?: boolean;
    /** Show a publish in the Chat; absent leaves the item out of the menu. */
    onshowinchat?: (toolUseId: string | null) => void;
    /** Hide the row for this session; absent leaves the item out of the menu. */
    onhide?: () => void;
  } = $props();

  const artifact = $derived(artifacts[0]!);
  const count = $derived(artifacts.length);
  // One artifact: ⋯ only when it would hold something.
  const menuMode = $derived<"all" | "single" | null>(
    count > 1 ? "all" : onshowinchat || onhide ? "single" : null,
  );
  let menuBtn = $state<HTMLButtonElement>();
  let menuAnchor = $state<DOMRect | null>(null);
  function toggleMenu() {
    menuAnchor = menuAnchor || !menuBtn ? null : menuBtn.getBoundingClientRect();
  }
  // The Viewport is reused across sessions: an open menu never carries over to another one. Nor
  // does the ⋯ menu stay open once a second artifact turns its trigger into "All N".
  $effect(() => {
    void sessionId;
    void menuMode;
    untrack(() => (menuAnchor = null));
  });

  const updated = $derived(relativeTimeAgo(artifact.updatedAt, clock.current, getLocale()));

  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  // Bumped whenever the row shows another session or url: a copy that settles after that (even
  // back on the same url) belongs to what the row showed before and confirms nothing.
  let shown = 0;
  async function copyLink() {
    const copying = shown;
    try {
      await navigator.clipboard.writeText(artifact.url);
    } catch {
      return; // clipboard blocked (insecure context / denied) — fail quietly, like TaskIdButton.
    }
    if (copying !== shown) return;
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }

  // The Viewport is reused across sessions: a "Link copied" must not carry over to another one.
  $effect(() => {
    void sessionId;
    void artifact.url;
    untrack(() => {
      shown++;
      clearTimeout(copiedTimer);
      copied = false;
    });
    return () => clearTimeout(copiedTimer);
  });
</script>

{#snippet menuTrigger()}
  {#if menuMode === "all"}
    <button
      bind:this={menuBtn}
      class="gbtn art-menu"
      type="button"
      aria-haspopup="menu"
      aria-expanded={!!menuAnchor}
      use:coachTarget={"artifact-menu"}
      onclick={toggleMenu}
      >{m.artifactrow_all({ n: count })}<span class="art-caret" aria-hidden="true">▴</span></button
    >
  {:else if menuMode === "single"}
    <button
      bind:this={menuBtn}
      class="gbtn more"
      type="button"
      aria-label={m.artifactrow_more_aria()}
      aria-haspopup="menu"
      aria-expanded={!!menuAnchor}
      onclick={toggleMenu}>⋯</button
    >
  {/if}
{/snippet}

<section
  class={["artifact-row", { mobile, touch: touch || mobile }]}
  aria-label={m.artifactrow_aria()}
  data-swipe-ignore
>
  <div class="art-info">
    <div class="art-head">
      <span class="art-glyph" aria-hidden="true"></span>
      <span class="art-label">{m.artifactrow_label()}</span>
      <span class="art-title" title={artifact.title}>{artifact.title}</span>
    </div>
    <p class="art-facts">
      {#if count > 1}<span>{m.artifactrow_newest_of({ n: count })}</span><span
          class="art-dot"
          aria-hidden="true">·</span
        >{/if}<span>{m.artifactrow_version({ n: artifact.versions })}</span><span
        class="art-dot"
        aria-hidden="true">·</span
      ><span>{m.artifactrow_updated({ when: updated })}</span>{#if count === 1}<span
          class="art-dot"
          aria-hidden="true">·</span
        ><span class="art-url" title={artifact.url}>{shortArtifactUrl(artifact.url)}</span>{/if}
    </p>
  </div>
  <div class="art-actions">
    <!-- the phone leads its action row with the menu trigger, as the merge row does with ⋯ -->
    {#if mobile}{@render menuTrigger()}{/if}
    <button class="gbtn" type="button" aria-live="polite" onclick={copyLink}
      >{copied ? m.artifactrow_copied() : m.artifactrow_copy()}</button
    >
    {#if !mobile}{@render menuTrigger()}{/if}
    <span class="art-sep" aria-hidden="true"></span>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external claude.ai URL, not an app route -->
    <a
      class="gbtn primary"
      href={isArtifactUrl(artifact.url) ? artifact.url : undefined}
      target="_blank"
      rel="noopener">{m.artifactrow_open()}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </div>
</section>

{#if menuAnchor && menuMode}
  <ArtifactMenu
    anchor={menuAnchor}
    opener={menuBtn}
    {artifacts}
    mode={menuMode}
    touch={touch || mobile}
    {onshowinchat}
    {onhide}
    onclose={() => (menuAnchor = null)}
  />
{/if}

<style>
  /* The merge row's flat band (PrActionRow): head ground, top hairline. Blue sits on the diamond
     and the label only — the ground stays untinted, its hues belong to the PR states. */
  .artifact-row {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 10px 8px 14px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    min-width: 0;
  }
  .art-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .art-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .art-glyph {
    align-self: center;
    flex: none;
    width: 7px;
    height: 7px;
    margin: 0 1px;
    background: var(--color-blue);
    transform: rotate(45deg);
  }
  .art-label {
    flex: none;
    color: var(--color-blue);
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .art-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink);
    font-size: var(--fs-base);
  }
  .art-facts {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    color: var(--color-muted);
  }
  .art-dot {
    margin: 0 8px;
  }
  .art-url {
    font-family: var(--font-mono);
    letter-spacing: 0;
  }

  .art-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .art-sep {
    width: 1px;
    align-self: stretch;
    background: var(--color-line);
  }

  /* .gbtn recipe (/design-system), as in PrActionRow */
  .gbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 32px;
    padding: 0 12px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    box-sizing: border-box;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: var(--color-hover);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.more {
    min-width: 32px;
    padding: 0;
    font-size: var(--fs-base);
    letter-spacing: 0;
  }
  .art-caret {
    margin-left: 6px;
    letter-spacing: 0;
  }
  /* the one amber action in the row: outline + inset glow, never a fill */
  .gbtn.primary {
    min-width: 132px;
    min-height: 36px;
    border-color: var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .gbtn.primary:focus-visible {
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 18px -10px var(--color-amber);
  }

  /* touch: every target at least 44px */
  .artifact-row.touch .gbtn {
    min-height: var(--mobile-actionbar-hit);
  }
  .artifact-row.touch .gbtn.more {
    min-width: var(--mobile-actionbar-hit);
  }

  /* phone: label + title, facts, then the action row — Open ↗ takes the rest */
  .artifact-row.mobile {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 10px 10px 12px;
  }
  .artifact-row.mobile .art-actions {
    gap: 6px;
  }
  .artifact-row.mobile .art-sep {
    display: none;
  }
  /* the facts wrap at their separators, and a fact wider than the row breaks inside — never cut */
  .artifact-row.mobile .art-facts {
    display: flex;
    flex-wrap: wrap;
    row-gap: 2px;
    overflow: visible;
    white-space: normal;
  }
  .artifact-row.mobile .art-facts > span {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .artifact-row.mobile .gbtn.primary {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
  }
</style>
