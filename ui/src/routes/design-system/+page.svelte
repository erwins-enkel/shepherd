<script lang="ts">
  // Design-system reference (issue #352). A live, single-page catalog of the
  // token layer (app.css) + the canonical component recipes the rest of the UI
  // follows, each with a when-to-use note and copy-paste markup. Its purpose is
  // to stop "design drift" — unattended agents re-inventing buttons/spacing/
  // colors every session. The CLAUDE.md "Design system" directive points agents
  // here before they author any UI.
  //
  // This is a developer/agent-facing INTERNAL reference, not end-user chrome, so
  // it is deliberately exempt from i18n (it is unlinked from the app and only
  // reached by navigating to /design-system directly) — see CLAUDE.md, which
  // marks a dev-only styleguide as exempt. Swatches/type rows render straight
  // off the live `var(--color-*)` / `var(--fs-*)` tokens, so this page can never
  // drift from the real theme: change app.css and this updates with it.
  // +layout.svelte already inits the theme globally for every route; the toggles
  // below just read/drive the shared controller.
  import { theme } from "$lib/theme.svelte";

  type Token = { name: string; note: string };

  // Surfaces, lines and text colors — the structural palette. Names map 1:1 to
  // the `--color-*` theme tokens in app.css (single source of truth).
  const surfaces: Token[] = [
    { name: "bg", note: "App background (under the radial glow)" },
    { name: "glow", note: "Top-center radial glow toward bg" },
    { name: "panel", note: "Primary raised surface (cards, sheets)" },
    { name: "panel-2", note: "Secondary panel, slightly recessed" },
    { name: "head", note: "Header / chrome bars" },
    { name: "inset", note: "Sunken surface (inputs, terminals)" },
    { name: "hover", note: "Row/control hover fill" },
    { name: "sel", note: "Selected / active fill" },
    { name: "line", note: "Default hairline border" },
    { name: "line-bright", note: "Emphasized border / divider" },
  ];

  const textTokens: Token[] = [
    { name: "ink", note: "Body text (~12:1 on bg, AA+)" },
    { name: "ink-bright", note: "Headings / emphasized text" },
    { name: "muted", note: "Secondary text, labels (~5.5:1)" },
    { name: "faint", note: "Tertiary / disabled-ish text" },
  ];

  // Accents carry meaning — never pick a hue for looks; pick it for what it
  // signals. See the status tokens below for the running/done/blocked mapping.
  const accents: Token[] = [
    { name: "amber", note: "Running / armed / primary action" },
    { name: "green", note: "READY / actionable-complete only" },
    { name: "red", note: "Blocked / destructive / error" },
    { name: "blue", note: "Informational accent" },
    { name: "slate", note: "Idle / parked (neutral, not 'done')" },
  ];

  // Type scale — the six deliberate rungs in app.css. Never hardcode a px size;
  // reach for the nearest rung.
  const typeScale: { name: string; px: string; note: string }[] = [
    { name: "fs-micro", px: "10px", note: "Dense chrome floor (badges)" },
    { name: "fs-meta", px: "11px", note: "Labels, numerics, buttons" },
    { name: "fs-base", px: "13px", note: "Body / titles (default)" },
    { name: "fs-lg", px: "16px", note: "Section heading" },
    { name: "fs-xl", px: "20px", note: "Page heading" },
    { name: "fs-2xl", px: "22px", note: "Hero / largest" },
  ];

  // Status tokens encode session state. The hue choices are load-bearing — the
  // notes spell out the non-obvious ones (done ≠ green; green is reserved).
  const statuses: { name: string; note: string }[] = [
    { name: "status-running", note: "Work in progress (amber)" },
    {
      name: "status-done",
      note: "WAITING / parked for the next steer — NOT actionable-complete, so it reads slate, never green",
    },
    { name: "status-blocked", note: "Blocked / needs the operator (red)" },
    { name: "status-idle", note: "Idle, no active turn (slate)" },
  ];

  // Canonical markup blocks. Rendered as escaped text inside <pre>, so agents
  // (and humans) can copy the exact convention rather than re-deriving it.
  const btnMarkup = `<button class="gbtn">Action</button>
<button class="gbtn primary">Primary</button>
<button class="gbtn" disabled>Disabled</button>

/* canonical recipe — all colors via tokens, never raw hex */
.gbtn {
  background: transparent;
  border: 1px solid var(--color-line);
  border-radius: 2px;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  letter-spacing: 0.08em;
  padding: 2px 8px;
}
.gbtn:hover:not(:disabled) { border-color: var(--color-amber); color: var(--color-amber); }
/* keyboard focus — flat inset amber ring (never an outer glow) */
.gbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--color-amber); }
.gbtn:disabled { opacity: 0.4; cursor: not-allowed; }
.gbtn.primary { border-color: var(--color-amber); color: var(--color-amber); }`;

  const fieldMarkup = `<input type="text" placeholder="…" />
<select>…</select>
<textarea></textarea>

/* one recipe for text input, select and textarea */
input, select, textarea {
  background: var(--color-inset);
  border: 1px solid var(--color-line);
  color: var(--color-ink-bright);
  font: inherit;
  font-size: var(--fs-base);
  padding: 8px 10px;
  border-radius: 2px;
}`;

  const badgeMarkup = `<span class="badge">OPEN</span>

.badge {
  font-size: var(--fs-micro);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 1px 6px;
  border: 1px solid var(--color-line);
  border-radius: 2px;
  color: var(--color-muted);
}
/* state colors come from the accent/status tokens, applied to color + border */`;

  const glossMarkup = `<!-- In a message value, wrap a term with [[id|Label]]: -->
<!-- "Shepherd groups sessions under an [[epic|epic]]." -->

<!-- GlossaryText parses the markers and renders each term as a GlossaryTerm: -->
<GlossaryText text={m.feat_epic_runner_body()} />

<!-- GlossaryTerm is the low-level trigger + tooltip (rarely used directly): -->
<GlossaryTerm id="epic" label="epic" />

/* .gloss-term — applied by GlossaryTerm to its trigger button */
.gloss-term {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: help;
  text-decoration: underline dashed;
  text-decoration-color: var(--color-line-bright);
  text-underline-offset: 3px;
}`;

  const panelMarkup = `<section class="panel">…</section>

.panel {
  background: var(--color-panel);
  border: 1px solid var(--color-line);
  border-radius: 2px;
}
/* recessed child surface (input wells, terminals): var(--color-inset) */`;

  const segCtrlMarkup = `<div class="seg-row">
  <button class="seg-btn" class:seg-active={active === "a"} aria-pressed={active === "a"}
    onclick={() => active = "a"}>A</button>
  <button class="seg-btn" class:seg-active={active === "b"} aria-pressed={active === "b"}
    onclick={() => active = "b"}>B</button>
  <button class="seg-btn" class:seg-active={active === "c"} aria-pressed={active === "c"}
    onclick={() => active = "c"}>C</button>
</div>

/* Segmented control (mobile flow mode). If placed inside a horizontally-padded
   parent, add margin-inline: calc(-1 * var(--mobile-shell-pad)) to escape that
   padding; not needed when the parent is already full-bleed (e.g. .panel.flow). */
.seg-row {
  display: flex;
  border-bottom: 1px solid var(--color-line);
}
.seg-btn {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  border: 0;
  border-right: 1px solid var(--color-line);
  background: none;
  font-family: inherit;
  font-size: var(--fs-base);
  cursor: pointer;
  padding: 0 2px;
  /* Inactive labels use --color-muted for ≥4.5:1 contrast; active uses --color-amber */
  color: var(--color-muted);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seg-btn:last-child { border-right: 0; }
.seg-btn:hover { color: var(--color-ink); }
.seg-btn.seg-active {
  color: var(--color-amber);
  background: var(--color-inset);
  box-shadow: inset 0 -2px 0 var(--color-amber);
}
.seg-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--color-amber);
}`;

  const scrimMarkup = `<div class="scrim"><!-- dialog --></div>

/* .scrim lives in app.css — one canonical backdrop for every dialog/drawer.
   Theme-aware dim (never a raw rgba()) + a soft blur so the app recedes. */
.scrim {
  position: fixed;
  inset: 0;
  background: var(--color-scrim);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}
/* Existing modal backdrops use class="overlay" and keep their own
   background/z-index; app.css adds the same blur to .overlay too. */`;
</script>

<svelte:head>
  <title>Shepherd · Design system</title>
</svelte:head>

<main id="main-content" class="ds">
  <header class="ds-head">
    <div>
      <h1>Design system</h1>
      <p class="lede">
        The token layer + canonical component recipes the Shepherd UI follows. Consult this before
        authoring any UI: use the <code>--color-*</code> / <code>--fs-*</code> tokens, reuse a
        recipe below, and never introduce raw hex or ad-hoc sizes. Swatches render live from
        <code>app.css</code>, so this page tracks the real theme.
      </p>
    </div>
    <div class="ds-toggles">
      <button class="gbtn" onclick={() => theme.cycle()}>Theme: {theme.pref}</button>
      <button class="gbtn" class:primary={theme.contrast} onclick={() => theme.toggleContrast()}>
        Contrast: {theme.contrast ? "high" : "normal"}
      </button>
    </div>
  </header>

  <!-- ── Foundations ──────────────────────────────────────────────────── -->
  <section class="panel">
    <h2>Color · surfaces &amp; lines</h2>
    <p class="when">
      Build with these for any background, border or fill — never a literal hex. Surfaces nest bg →
      panel → inset; borders use line / line-bright.
    </p>
    <div class="swatches">
      {#each surfaces as t (t.name)}
        <figure class="swatch">
          <span class="chip" style="background: var(--color-{t.name})"></span>
          <figcaption><code>--color-{t.name}</code><span>{t.note}</span></figcaption>
        </figure>
      {/each}
    </div>
  </section>

  <section class="panel">
    <h2>Color · text</h2>
    <p class="when">
      Pick by hierarchy: ink for body, ink-bright to emphasize, muted/faint to recede.
    </p>
    <div class="swatches">
      {#each textTokens as t (t.name)}
        <figure class="swatch">
          <span class="text-sample" style="color: var(--color-{t.name})">Aa</span>
          <figcaption><code>--color-{t.name}</code><span>{t.note}</span></figcaption>
        </figure>
      {/each}
    </div>
  </section>

  <section class="panel">
    <h2>Color · accents</h2>
    <p class="when">
      Hues are semantic, not decorative — choose by meaning. <strong>Green is reserved</strong> for genuinely
      actionable-complete (READY); a finished-but-parked session is slate, not green.
    </p>
    <div class="swatches">
      {#each accents as t (t.name)}
        <figure class="swatch">
          <span class="chip" style="background: var(--color-{t.name})"></span>
          <figcaption><code>--color-{t.name}</code><span>{t.note}</span></figcaption>
        </figure>
      {/each}
    </div>
  </section>

  <section class="panel">
    <h2>Type scale</h2>
    <p class="when">
      Six rungs — anchor on fs-base (13px). Reach for the nearest rung; never invent a size.
    </p>
    <ul class="type-list">
      {#each typeScale as t (t.name)}
        <li>
          <span class="type-demo" style="font-size: var(--{t.name})">Shepherd</span>
          <code>--{t.name}</code><span class="px">{t.px}</span><span class="note">{t.note}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="panel">
    <h2>Status tokens</h2>
    <p class="when">
      Session state → hue. Driven by app.css <code>--status-*</code>; read the notes — the mapping
      is load-bearing.
    </p>
    <ul class="status-list">
      {#each statuses as s (s.name)}
        <li>
          <span class="status-dot" style="background: var(--{s.name})"></span>
          <code>--{s.name}</code><span class="note">{s.note}</span>
        </li>
      {/each}
    </ul>
  </section>

  <!-- ── Component recipes ────────────────────────────────────────────── -->
  <section class="panel">
    <h2>Buttons</h2>
    <p class="when">
      <strong>When:</strong> any in-chrome action. Base <code>.gbtn</code> is the default; add
      <code>.primary</code> for the single emphasized action in a group. <strong>When not:</strong>
      destructive actions get a red treatment + confirmation, not a plain button.
    </p>
    <div class="demo">
      <button class="gbtn">Action</button>
      <button class="gbtn primary">Primary</button>
      <button class="gbtn" disabled>Disabled</button>
    </div>
    <pre><code>{btnMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Form fields</h2>
    <p class="when">
      <strong>When:</strong> text input, select (dropdown) and textarea all share one recipe — a
      sunken <code>--color-inset</code> well with a <code>--color-line</code> border.
      <strong>When not:</strong> boolean choices use a toggle/checkbox, not a select.
    </p>
    <div class="demo demo-col">
      <input type="text" placeholder="Prompt…" />
      <select><option>main</option><option>develop</option></select>
      <textarea placeholder="Longer text…"></textarea>
    </div>
    <pre><code>{fieldMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Badges &amp; pills</h2>
    <p class="when">
      <strong>When:</strong> a compact, read-only status label (PR state, CI, critic verdict). Color
      comes from the accent/status tokens. <strong>When not:</strong> if it's clickable it's a button,
      not a badge.
    </p>
    <div class="demo">
      <span class="badge">OPEN</span>
      <span class="badge" style="color: var(--color-green); border-color: var(--color-green)"
        >READY</span
      >
      <span class="badge" style="color: var(--color-red); border-color: var(--color-red)"
        >BLOCKED</span
      >
    </div>
    <pre><code>{badgeMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Glossary term</h2>
    <p class="when">
      <strong>When:</strong> a dashed underline marks a term that has a definition in the glossary
      registry. Internal terms (kind <code>"internal"</code>) show an in-app definition only.
      External terms (kind <code>"external"</code>) add a locale-aware Wikipedia link. The tooltip
      is a small anchored, <strong>non-blocking popover</strong> (no scrim) that opens on hover or
      focus (desktop) or tap (touch), and dismisses on Esc, outside pointerdown, or scroll/resize.
      <strong>When not:</strong> do not use for decorative underlines or links — every dashed-underline
      term must resolve to a glossary entry.
    </p>
    <div class="demo">
      <p class="gloss-demo-text">
        Shepherd groups sessions under an
        <span class="gloss-term">epic</span>
        and posts results to a
        <span class="gloss-term">PR</span>.
      </p>
    </div>
    <pre><code>{glossMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Panels &amp; surfaces</h2>
    <p class="when">
      <strong>When:</strong> group related content on a raised <code>--color-panel</code> surface;
      nest inputs/terminals on the recessed <code>--color-inset</code>. The app shell layers head →
      panel → inset for depth.
    </p>
    <div class="demo">
      <div class="mini-panel">
        panel
        <div class="mini-inset">inset</div>
      </div>
    </div>
    <pre><code>{panelMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Segmented control</h2>
    <p class="when">
      <strong>When:</strong> a single-select view switch with ≤5 equal options that must all be
      visible at once (e.g. the Herd status filter on mobile). Prefer scrollable chips when there
      are more than 5 options or labels vary widely in length. Equal-width segments via
      <code>flex:1; min-width:0</code>; 44 px touch target (<code>min-height:44px</code>);
      <code>--fs-base</code> (13 px) labels; no uppercase, no letter-spacing (monospace). Active
      state: <code>--color-amber</code> text + <code>--color-inset</code> fill + amber 2 px bottom
      inset. Inactive: <code>--color-faint</code>. Full-bleed on mobile via
      <code>margin-inline: calc(-1 * var(--mobile-shell-pad))</code>.
    </p>
    <div class="demo">
      <div class="seg-row-demo">
        <button class="seg-btn-demo seg-active-demo" aria-pressed="true">All</button>
        <button class="seg-btn-demo" aria-pressed="false">Ready</button>
        <button class="seg-btn-demo" aria-pressed="false">Research</button>
        <button class="seg-btn-demo" aria-pressed="false">Done</button>
        <button class="seg-btn-demo" aria-pressed="false">Rundown</button>
      </div>
    </div>
    <pre><code>{segCtrlMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Modal &amp; scrim</h2>
    <p class="when">
      <strong>When:</strong> a blocking dialog, modal or side drawer dims
      <em>and</em> blurs the app behind a <code>--color-scrim</code> backdrop (theme-aware — never a
      raw <code>rgba()</code>), so the foreground reads clearly. Use the global <code>.scrim</code>
      class for new backdrops; existing modals on <code>.overlay</code> inherit the same blur from
      <code>app.css</code>. The dialog itself is a <code>.panel</code>.
    </p>
    <div class="demo">
      <div class="scrim-demo">
        <span class="scrim-fill"></span>
        <div class="mini-panel dialog">Dialog</div>
      </div>
    </div>
    <pre><code>{scrimMarkup}</code></pre>
  </section>
</main>

<style>
  .ds {
    max-width: 880px;
    margin: 0 auto;
    padding: 28px 20px 80px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .ds-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    flex-wrap: wrap;
  }
  h1 {
    font-size: var(--fs-xl);
    color: var(--color-ink-bright);
    margin: 0 0 6px;
    letter-spacing: 0.04em;
  }
  h2 {
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    margin: 0 0 8px;
    letter-spacing: 0.04em;
  }
  .lede {
    margin: 0;
    max-width: 60ch;
    color: var(--color-muted);
    line-height: 1.6;
  }
  .ds-toggles {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  code {
    color: var(--color-ink-bright);
    background: var(--color-inset);
    padding: 0 4px;
    border-radius: 2px;
  }
  .when {
    margin: 0 0 14px;
    color: var(--color-muted);
    line-height: 1.6;
    max-width: 70ch;
  }
  .when strong {
    color: var(--color-ink);
  }

  .panel {
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 18px 20px;
  }

  /* swatches */
  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .swatch {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
  }
  .chip {
    width: 34px;
    height: 34px;
    border-radius: 2px;
    border: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .text-sample {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    font-size: var(--fs-lg);
    flex-shrink: 0;
  }
  figcaption {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-meta);
  }
  figcaption span {
    color: var(--color-faint);
  }

  /* type scale */
  .type-list,
  .status-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .type-list li,
  .status-list li {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .type-demo {
    color: var(--color-ink-bright);
    min-width: 130px;
  }
  .px {
    color: var(--color-faint);
    font-size: var(--fs-meta);
  }
  .note {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .status-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
  }

  /* component demos */
  .demo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .demo-col {
    flex-direction: column;
    align-items: stretch;
    max-width: 320px;
  }

  /* canonical recipes mirrored locally (documentation), all token-driven */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  input,
  select,
  textarea {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
  }
  textarea {
    resize: none;
    min-height: 70px;
  }
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .mini-panel {
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 14px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .mini-inset {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 10px;
    margin-top: 8px;
    color: var(--color-faint);
  }
  .scrim-demo {
    position: relative;
    width: 240px;
    height: 120px;
    /* faux app content (stripes) behind the scrim so the blur is visible */
    background: repeating-linear-gradient(
      45deg,
      var(--color-bg),
      var(--color-bg) 8px,
      var(--color-line) 8px,
      var(--color-line) 16px
    );
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
    display: grid;
    place-items: center;
  }
  .scrim-fill {
    position: absolute;
    inset: 0;
    background: var(--color-scrim);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }
  .dialog {
    position: relative;
    z-index: 1;
    background: var(--color-panel);
  }

  /* segmented control demo */
  .seg-row-demo {
    display: flex;
    width: 100%;
    max-width: 390px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }
  .seg-btn-demo {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
    padding: 0 2px;
    color: var(--color-muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg-btn-demo:last-child {
    border-right: 0;
  }
  .seg-active-demo {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }

  /* glossary term — dashed underline trigger (mirrors GlossaryTerm.svelte) */
  .gloss-term {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: help;
    text-decoration: underline dashed;
    text-decoration-color: var(--color-line-bright);
    text-underline-offset: 3px;
  }
  .gloss-demo-text {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.6;
  }

  pre {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 12px 14px;
    overflow-x: auto;
    margin: 0;
  }
  pre code {
    background: none;
    padding: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.6;
  }
</style>
