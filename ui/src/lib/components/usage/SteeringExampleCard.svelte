<script lang="ts">
  // One steering example (#4175): the operator's own words, what followed, and a rewrite they can
  // copy into their next prompt. Quote/evidence/rewrite are helper prose — shown verbatim.
  import { m } from "#lib/paraglide/messages.js";

  const {
    example,
    repo,
  }: {
    example: { desig: string; quote: string; evidence: string; rewrite: string };
    repo: string | null;
  } = $props();

  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(example.rewrite);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard blocked (insecure context / denied): the rewrite stays selectable.
    }
  }
</script>

<article class="example">
  <header class="example-head">
    <span class="desig">{example.desig}</span>
    {#if repo}<span class="sep" aria-hidden="true">·</span><span class="repo">{repo}</span>{/if}
  </header>

  <span class="label">{m.usage_steering_example_quote()}</span>
  <blockquote class="quote">{example.quote}</blockquote>

  <span class="label">{m.usage_steering_example_evidence()}</span>
  <p class="evidence">{example.evidence}</p>

  <div class="rewrite-head">
    <span class="label">{m.usage_steering_example_rewrite()}</span>
    <button
      type="button"
      class="gbtn"
      aria-label={m.usage_steering_copy_aria({ desig: example.desig })}
      onclick={copy}
    >
      {copied ? m.usage_steering_copied() : m.usage_steering_copy()}
    </button>
  </div>
  <pre class="rewrite">{example.rewrite}</pre>
  <span class="sr-status" role="status">{copied ? m.usage_steering_copied() : ""}</span>
</article>

<style>
  .example {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 0.375rem;
    min-width: 0;
  }

  .example-head {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    font-size: var(--fs-meta);
  }

  .desig,
  .repo {
    font-family: var(--font-mono);
  }

  .desig {
    color: var(--color-ink-bright);
  }

  .repo,
  .sep {
    color: var(--color-muted);
  }

  .label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .quote {
    margin: 0;
    padding-left: 0.625rem;
    border-left: 2px solid var(--color-line-bright);
    color: var(--color-ink);
    font-size: var(--fs-meta);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .evidence {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }

  .rewrite-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .rewrite {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .sr-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    min-height: 32px;
    cursor: pointer;
  }

  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
