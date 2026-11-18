<script lang="ts">
  import { untrack } from "svelte";
  import { relativeTimeAgo } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { SessionArtifact } from "#lib/types.js";
  import { shortArtifactUrl } from "../../../../../shared/artifact-url";

  // The artifact row (#3875): where the merge row sits, for a session without a PR whose agent
  // published an artifact. The newest one, its facts, Copy link and the one amber action, Open ↗.
  // Title and url are agent data — text only; the caller passes only a validated url.
  let {
    artifact,
    mobile = false,
    touch = false,
  }: {
    artifact: SessionArtifact;
    /** Phone: stacked layout (label + title, facts, action row). */
    mobile?: boolean;
    /** Any touch device: 44px targets. */
    touch?: boolean;
  } = $props();

  const updated = $derived(relativeTimeAgo(artifact.updatedAt, clock.current, getLocale()));

  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(artifact.url);
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard blocked (insecure context / denied) — fail quietly, like TaskIdButton.
    }
  }

  // The Viewport is reused across sessions: a "Link copied" must not carry over to another artifact.
  $effect(() => {
    void artifact.url;
    untrack(() => {
      clearTimeout(copiedTimer);
      copied = false;
    });
    return () => clearTimeout(copiedTimer);
  });
</script>

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
      <span>{m.artifactrow_version({ n: artifact.versions })}</span><span
        class="art-dot"
        aria-hidden="true">·</span
      ><span>{m.artifactrow_updated({ when: updated })}</span><span
        class="art-dot"
        aria-hidden="true">·</span
      ><span class="art-url" title={artifact.url}>{shortArtifactUrl(artifact.url)}</span>
    </p>
  </div>
  <div class="art-actions">
    <button class="gbtn" type="button" aria-live="polite" onclick={copyLink}
      >{copied ? m.artifactrow_copied() : m.artifactrow_copy()}</button
    >
    <span class="art-sep" aria-hidden="true"></span>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external claude.ai URL, not an app route -->
    <a class="gbtn primary" href={artifact.url} target="_blank" rel="noopener"
      >{m.artifactrow_open()}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </div>
</section>

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
  .artifact-row.mobile .gbtn.primary {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
  }
</style>
