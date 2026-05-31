<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { getLocale, locales, setLocale, localeName, localeCode } from "$lib/i18n";
  import type { Locale } from "$lib/i18n";

  let open = $state(false);
  const current = getLocale();

  function pick(l: Locale) {
    open = false;
    if (l !== current) setLocale(l); // reloads; localStorage persists the choice
  }
</script>

<svelte:window
  onclick={(e) => {
    if (open && !(e.target as HTMLElement).closest(".lang")) open = false;
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") open = false;
  }}
/>

<div class="lang">
  <button
    class="lang-toggle"
    type="button"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={m.lang_switcher_aria()}
    onclick={() => (open = !open)}
  >
    <span aria-hidden="true">🌐</span>
    <span class="code">{localeCode(current)}</span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <ul class="menu" role="listbox" aria-label={m.lang_switcher_aria()}>
      {#each locales as l (l)}
        <li>
          <button
            role="option"
            aria-selected={l === current}
            type="button"
            class:active={l === current}
            onclick={() => pick(l as Locale)}
          >
            <span class="check" aria-hidden="true">{l === current ? "✓" : ""}</span>
            {localeName(l as Locale)}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .lang {
    position: relative;
    display: inline-flex;
  }
  .lang-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    font: inherit;
    color: var(--color-term-fg);
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 0.4em;
    padding: 0.15em 0.5em;
    cursor: pointer;
  }
  .lang-toggle:hover {
    border-color: var(--color-amber);
  }
  .code {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.05em;
  }
  .caret {
    opacity: 0.6;
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 0.35em);
    right: 0;
    margin: 0;
    padding: 0.25em;
    list-style: none;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 0.5em;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
    z-index: 40;
    min-width: 8em;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 0.4em;
    width: 100%;
    text-align: left;
    font: inherit;
    color: var(--color-term-fg);
    background: transparent;
    border: 0;
    border-radius: 0.35em;
    padding: 0.35em 0.5em;
    cursor: pointer;
  }
  .menu button:hover {
    background: color-mix(in oklab, var(--color-amber) 16%, transparent);
  }
  .menu button.active {
    color: var(--color-amber);
  }
  .check {
    width: 1em;
    display: inline-block;
  }
</style>
