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
  import { setContext } from "svelte";
  import { theme } from "$lib/theme.svelte";
  import { INFO_TIPS_FORCE } from "$lib/info-tips.svelte";
  import IssueFilterPopover from "$lib/components/IssueFilterPopover.svelte";
  import GlossaryText from "$lib/components/GlossaryText.svelte";
  import { labelChipStyle } from "$lib/label-color";
  // Graphical plugin-UI widgets (issue #1189). Unlike the static meter demo, these
  // widgets compute SVG geometry from props — a static copy would drift. Import the
  // real components via PluginUIRenderer so the showcase exercises the actual dispatch path.
  import PluginUIRenderer from "$lib/plugin-ui/PluginUIRenderer.svelte";
  import type { PluginUINode } from "$lib/types";

  // Force the (i) / glossary affordances to render here regardless of the operator's
  // "hide info tooltips" preference (Settings → Device). This page is the canonical
  // component catalogue, so a specimen that silently vanished based on the viewer's
  // personal pref would make the reference lie about what the component looks like.
  setContext(INFO_TIPS_FORCE, true);

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
    { name: "warn", note: "Caution / heads-up — not running, not error" },
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
    {
      name: "status-warn",
      note: "Caution / heads-up — distinct from running (amber) and blocked (red)",
    },
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

  // Real forge label colors (GitHub's default "bug"/"good first issue"/"enhancement"
  // palette) run through the same labelChipStyle() every issue label chip uses — see
  // the "Sanctioned exception" note below.
  const demoLabelStyle = labelChipStyle("#d73a4a");
  const demoLabelStyle2 = labelChipStyle("#7057ff");
  const demoLabelStyle3 = labelChipStyle("#a2eeef");

  const labelChipMarkup = `import { labelChipStyle } from "$lib/label-color";

<span class="label-chip" class:hued={style !== null} style={style}>bug</span>

/* dark default; light theme overrides via the ancestor selector */
.label-chip.hued {
  color: var(--lc-text-d);
  border-color: var(--lc-border-d);
  background: var(--lc-fill-d);
}
:global([data-theme="light"]) .label-chip.hued {
  color: var(--lc-text-l);
  border-color: var(--lc-border-l);
  background: var(--lc-fill-l);
}`;

  const statusChipMarkup = `<span class="status-chip info"><span class="dot"></span>PR #42</span>
<span class="status-chip ready"><span class="dot"></span>CI passing</span>
<span class="status-chip fail"><span class="dot"></span>CI failed</span>

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 9px;
  border: 1px solid var(--color-line);
  border-radius: 6px;          /* softer chip rung — not a 2px control, not a 999px pill */
  background: var(--color-panel-2);
  color: var(--color-muted);
}
.status-chip .dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: currentColor;    /* dot follows the chip's hue */
}
/* semantic accent on border + text + dot, chosen by meaning */
.status-chip.info  { color: var(--color-blue);  border-color: var(--color-blue); }
.status-chip.ready { color: var(--color-green); border-color: var(--color-green); }
/* subordinate red — failure only; never a halo/pulse/wash (Four-Light Rule) */
.status-chip.fail  { color: var(--color-red);   border-color: var(--color-red); }`;

  const chipRowMarkup = `<!-- status/action chip row — read-only chips + interactive controls, one cohesive 6px set -->
<span class="status-chip info"><span class="dot"></span>PR #42</span>
<span class="status-chip ready"><span class="dot"></span>CI passing</span>
<button class="chip-action primary">Merge</button>
<button class="chip-action">Ready</button>
<button class="chip-action">⚙ Auto</button>

/* interactive control sharing the chip's 6px radius for row cohesion (a standalone button stays 2px) */
.chip-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: var(--fs-meta);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 9px;
  border: 1px solid var(--color-line-bright);
  border-radius: 6px;          /* the chip rung — NOT the forbidden 999px pill */
  background: transparent;
  color: var(--color-ink);
  cursor: pointer;
}
.chip-action:hover { background: var(--color-hover); border-color: var(--color-ink); }  /* hover-lift: action, not a resting chip */
.chip-action.primary {         /* amber primary — the loudest action in the row */
  color: var(--color-amber);
  border-color: var(--color-amber);
  box-shadow: inset 0 0 18px -10px var(--color-amber);
}`;

  const meterMarkup = `<!-- PuiMeter — plugin UI primitive (issue #1185); rendered via PluginUIRenderer -->
<div class="pui-meter">
  <div class="pui-meter-header">
    <span class="pui-meter-label">Tokens used</span>
    <span class="pui-meter-value" style:color="var(--color-blue)">42/100</span>
  </div>
  <div class="pui-meter-track" role="meter" aria-valuenow={42} aria-valuemin={0} aria-valuemax={100}>
    <div class="pui-meter-fill" style:width="42%" style:background="var(--color-blue)"></div>
  </div>
  <span class="pui-meter-caption">Monthly budget</span>
</div>

/* All sizing via tokens; tone color applied to value text + fill bar via style: */
.pui-meter-track  { height:6px; background:var(--color-inset); border:1px solid var(--color-line); border-radius:3px; overflow:hidden; }
.pui-meter-fill   { height:100%; border-radius:3px; transition:width .2s ease; }
.pui-meter-label  { font-size:var(--fs-meta); color:var(--color-ink); font-weight:600; }
.pui-meter-value  { font-size:var(--fs-micro); font-variant-numeric:tabular-nums; }
.pui-meter-caption{ font-size:var(--fs-micro); color:var(--color-muted); }`;

  // Sample nodes for the graphical plugin-UI widget demos below.
  const gaugeNode = {
    type: "gauge",
    props: { label: "5h quota", value: 72, max: 100, tone: "warn", caption: "resets 14:30" },
  } satisfies PluginUINode;

  const sparklineNode = {
    type: "sparkline",
    props: { label: "tokens/min", points: [4, 9, 7, 12, 10, 15, 11, 18, 14, 20], tone: "info" },
  } satisfies PluginUINode;

  const timeSeriesNode = {
    type: "time-series",
    props: {
      kind: "area",
      caption: "5h vs 7d usage",
      series: [
        { label: "5h", tone: "info", points: [10, 18, 14, 22, 19, 26, 30] },
        { label: "7d", tone: "warn", points: [40, 42, 38, 45, 50, 48, 55] },
      ],
    },
  } satisfies PluginUINode;

  const barChartNode = {
    type: "bar-chart",
    props: {
      bars: [
        { label: "acct-a", value: 82, tone: "error" },
        { label: "acct-b", value: 47, tone: "ok" },
        { label: "acct-c", value: 63, tone: "warn" },
      ],
    },
  } satisfies PluginUINode;

  const timelineNode = {
    type: "timeline",
    props: {
      events: [
        { at: "14:02", label: "spawned session", tone: "ok" },
        { at: "14:05", label: "quota check", caption: "5h at 72%", tone: "warn" },
        { at: "14:11", label: "refused spawn", caption: "capacity", tone: "error" },
      ],
    },
  } satisfies PluginUINode;

  // Descriptor strings — the node JSON a plugin would pass to ctx.publishUI().
  const gaugeDescriptor = `// Plugin publishUI() descriptor — gauge
{
  "schemaVersion": 1,
  "slot": "settings-panel",
  "title": "Quota",
  "root": {
    "type": "gauge",
    "props": { "label": "5h quota", "value": 72, "max": 100, "tone": "warn", "caption": "resets 14:30" }
  }
}`;

  const sparklineDescriptor = `// Plugin publishUI() descriptor — sparkline
{
  "schemaVersion": 1,
  "slot": "settings-panel",
  "title": "Throughput",
  "root": {
    "type": "sparkline",
    "props": { "label": "tokens/min", "points": [4, 9, 7, 12, 10, 15, 11, 18, 14, 20], "tone": "info" }
  }
}`;

  const timeSeriesDescriptor = `// Plugin publishUI() descriptor — time-series
{
  "schemaVersion": 1,
  "slot": "settings-panel",
  "title": "Usage",
  "root": {
    "type": "time-series",
    "props": {
      "kind": "area",
      "caption": "5h vs 7d usage",
      "series": [
        { "label": "5h", "tone": "info", "points": [10, 18, 14, 22, 19, 26, 30] },
        { "label": "7d", "tone": "warn", "points": [40, 42, 38, 45, 50, 48, 55] }
      ]
    }
  }
}`;

  const barChartDescriptor = `// Plugin publishUI() descriptor — bar-chart
{
  "schemaVersion": 1,
  "slot": "settings-panel",
  "title": "Per-account usage",
  "root": {
    "type": "bar-chart",
    "props": {
      "bars": [
        { "label": "acct-a", "value": 82, "tone": "error" },
        { "label": "acct-b", "value": 47, "tone": "ok" },
        { "label": "acct-c", "value": 63, "tone": "warn" }
      ]
    }
  }
}`;

  const timelineDescriptor = `// Plugin publishUI() descriptor — timeline
{
  "schemaVersion": 1,
  "slot": "settings-panel",
  "title": "Activity",
  "root": {
    "type": "timeline",
    "props": {
      "events": [
        { "at": "14:02", "label": "spawned session", "tone": "ok" },
        { "at": "14:05", "label": "quota check", "caption": "5h at 72%", "tone": "warn" },
        { "at": "14:11", "label": "refused spawn", "caption": "capacity", "tone": "error" }
      ]
    }
  }
}`;

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

  const iconBtnMarkup = `<!-- Default (28px hit area) -->
<button type="button" class="icon-btn" aria-label="Refresh">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
    <path d="M21 3v5h-5"/>
  </svg>
</button>

<!-- Busy/loading: .spin on the glyph (reduced-motion safe) -->
<button type="button" class="icon-btn" aria-label="Loading">
  <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
    <path d="M21 3v5h-5"/>
  </svg>
</button>

<!-- Compact (44px touch target) -->
<button type="button" class="icon-btn compact" aria-label="Close">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 6 6 18"/><path d="M6 6l12 12"/>
  </svg>
</button>

<!-- Unicode-glyph child (e.g. a standalone fold chevron): the recipe only sizes
     SVG glyphs, so a text glyph needs its own font-size (matches .vp-fold) -->
<button type="button" class="icon-btn" style="font-size: var(--fs-base)" aria-label="Fold">
  <span aria-hidden="true">▾</span>
</button>

/* canonical recipe — all sizes/colors via tokens, never raw px/hex */
.icon-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn-hit);    /* 28px — desktop square hit area */
  height: var(--icon-btn-hit);
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 2px;
  color: var(--color-faint);     /* quiet resting default */
  cursor: pointer;
  transition: color .12s, border-color .12s, background .12s;
}
.icon-btn:hover { color: var(--color-ink-bright); border-color: var(--color-line-bright); }
.icon-btn:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--color-amber); }
.icon-btn:disabled { cursor: default; opacity: .6; }
.icon-btn.compact { width: var(--mobile-actionbar-hit); height: var(--mobile-actionbar-hit); } /* 44px touch target */
.icon-btn svg { width: var(--icon-btn-glyph); height: var(--icon-btn-glyph); display: block; } /* 18px glyph */
/* the recipe sizes SVG glyphs only — a Unicode text-glyph child needs its own
   font-size on the button (e.g. .vp-fold sets font-size: var(--fs-base)) */

/* .spin marks a busy/loading glyph (reduced-motion guarded) */
.spin { animation: icon-btn-spin 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }`;

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
    <h2>Icon buttons</h2>
    <p class="when">
      <strong>When:</strong> an icon-only chrome control that needs a clear square hit target and a
      glyph recognisable at a distance — e.g. the Viewport header's resume, decommission, redraw
      (wrench), and fold controls. Desktop hit area is <code>--icon-btn-hit</code> (28px); add
      <code>.compact</code> for the <code>--mobile-actionbar-hit</code> (44px) touch target. Use a
      <code>.spin</code> class on the glyph for a busy/loading state (reduced-motion safe). The
      recipe sizes <code>svg</code> glyphs (18px) — a Unicode text-glyph child (e.g. a standalone
      fold chevron) needs its own <code>font-size</code> on the button, as <code>.vp-fold</code>
      does.
      <strong>When not:</strong> a control with a visible text label uses <code>.gbtn</code>
      (icon + word), not <code>.icon-btn</code>; a decorative disclosure caret inside an
      already-clickable labeled pill (e.g. the git-actions caret) is just a Unicode
      <code>▾</code>/<code>▴</code> and gets no hit area of its own; destructive actions still need their
      red treatment + confirm.
    </p>
    <div class="demo">
      <button type="button" class="icon-btn" aria-label="Refresh">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
        </svg>
      </button>
      <button type="button" class="icon-btn" aria-label="Loading (spinning)">
        <svg
          class="spin"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
        </svg>
      </button>
      <button type="button" class="icon-btn" aria-label="Close">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        aria-label="Decommission (confirm)"
        style="background: var(--color-red); border-color: var(--color-red); color: var(--color-bg)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
      <button type="button" class="icon-btn" aria-label="Upload">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path
            d="M12 3v12"
          />
        </svg>
      </button>
      <button type="button" class="icon-btn" aria-label="Alert">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          /><path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
      </button>
      <button type="button" class="icon-btn" aria-label="Disabled example" disabled>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
      <button type="button" class="icon-btn compact" aria-label="Compact (44px touch target)">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        style="font-size: var(--fs-base)"
        aria-label="Fold (Unicode chevron — standalone fold control, not a labeled-pill caret)"
        ><span aria-hidden="true">▾</span></button
      >
    </div>
    <pre><code>{iconBtnMarkup}</code></pre>
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
    <h2>Badges &amp; chips</h2>
    <p class="when">
      Two status primitives, split by size and context.
      <strong>Badge</strong> — the smallest inline, read-only micro-label (2px radius, 10px, no dot)
      embedded in running text, a table cell, or beside a title for a single state token.
      <strong>Status chip</strong> — the 6px chip-row control (11px, optional leading dot,
      thumb-reachable) for a row of functional-status values (git / CI / PR / ready). Both may carry
      a semantic hue on border + text; only the chip adds the dot and the softer radius.
      <strong>When not:</strong> a badge stays read-only — a clickable control is a button. But
      <em>inside a status/action chip row</em> a button may adopt the chip's 6px radius so the row reads
      as one cohesive chip set (a standalone button stays 2px); hue is reserved for genuine state, never
      decoration.
    </p>

    <p class="when"><strong>Badge</strong> — inline micro-label:</p>
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

    <p class="when"><strong>Status chip</strong> — functional-status row (radius 6px):</p>
    <div class="demo">
      <span class="status-chip"><span class="dot"></span>PR #42</span>
      <span class="status-chip info"><span class="dot"></span>PR #42</span>
      <span class="status-chip ready"><span class="dot"></span>CI passing</span>
      <span class="status-chip ready"><span class="dot"></span>READY</span>
      <span class="status-chip fail"><span class="dot"></span>CI failed</span>
    </div>
    <p class="when">
      The <code>fail</code> chip's red is <strong>subordinate</strong> — text + border + dot only, never
      a halo, pulse, or wash — so the blocked-agent pip stays the loudest red on screen (Four-Light Rule).
    </p>
    <pre><code>{statusChipMarkup}</code></pre>

    <p class="when">
      <strong>Chip-row cohesion</strong> — inside a status/action row, interactive controls (MERGE, READY,
      ⚙ AUTO) may share the chip's 6px radius so the whole row reads as one cohesive chip set, not a 6px-chip
      + 2px-button mix. The action still separates itself with its hover-lift (a resting status chip never
      lifts) and, for the primary, the amber treatment — a deliberate relaxation of shape-encodes-interactivity,
      scoped to the chip row; a standalone button stays 2px:
    </p>
    <div class="demo">
      <span class="status-chip info"><span class="dot"></span>PR #42</span>
      <span class="status-chip ready"><span class="dot"></span>CI passing</span>
      <button type="button" class="chip-action primary">Merge</button>
      <button type="button" class="chip-action">Ready</button>
      <button type="button" class="chip-action">⚙ Auto</button>
    </div>
    <pre><code>{chipRowMarkup}</code></pre>

    <p class="when">
      <strong>Two scoped allowances beyond a literal chip row</strong> — used by the Viewport
      identity row (task bar), where a control relates to the git chip strip it sits with but is not
      physically <em>in</em>
      a chip row. Each is justified on its own footing, not by treating the identity row as one cohesive
      cluster:
    </p>
    <ul class="when">
      <li>
        <strong>Standalone ghost chip</strong> — a read-only <em>identity label</em> (the
        <code>TASK-XX</code>
        designation) may take the 6px radius as a <strong>hue-less, dot-less</strong> boxed label. Distinct
        from the inline 2px badge (status tokens) and the semantic status chip (hue + dot): the ghost
        chip is shape-only and never borrows a status color.
      </li>
      <li>
        <strong>Chip-radius disclosure control</strong> — the control that <em>discloses</em> a chip
        strip (the git-rail foldout) may take the 6px radius to rhyme with what it opens, and may
        keep a subordinate inset glow (<code>inset 0 0 18px -10px</code>) on its semantic states as
        the disclosure's emphasis — a tight −10px inner tint, never a broadcast halo, so the
        blocked-agent pip stays the loudest red (Four-Light Rule).
      </li>
      <li>
        <strong>What stays a badge</strong> — read-only status pips that live among other 2px badges (the
        ready pip, the plan-gate / autopilot status badges in the identity row) remain the 2px badge primitive,
        so a lone 6px chip is never stranded between 2px siblings.
      </li>
    </ul>

    <p class="when">
      <strong>Sanctioned exception — issue label chips render the real forge color.</strong> Rule 4
      above ("accent hues are semantic, not decorative") governs Shepherd's OWN chrome — states
      Shepherd itself defines (READY, running, blocked). Issue labels are the opposite: they are
      <em>data</em>, not chrome — a label's color is whatever the forge (GitHub, etc.) assigned it,
      the same way an avatar's color is whoever the person is. This is the ONLY place raw
      data-driven color is allowed into chip chrome; nowhere else may a hex/rgba literal stand in
      for a semantic token.
    </p>
    <p class="when">
      The raw forge hex is never used verbatim (a fully-saturated yellow or navy label is unreadable
      against a near-black or near-white row). Instead it is normalized through OKLCH (<code
        >label-color.ts</code
      >): the source hue and chroma are preserved, but lightness is substituted for a fixed
      per-theme constant (<code>LABEL_CHIP_THEME</code>), so every label — regardless of hue —
      clears WCAG AA (4.5:1) text contrast in both themes (verified by a gamut-aware worst-case test
      over every hue/chroma the browser can actually paint). The tunable knobs (text/border
      lightness, fill lightness + alpha, per theme) live in that one constant, not scattered across
      components.
    </p>
    <div class="demo">
      <span class="label-chip-demo" style={demoLabelStyle}>bug</span>
      <span class="label-chip-demo" style={demoLabelStyle2}>good first issue</span>
      <span class="label-chip-demo" style={demoLabelStyle3}>enhancement</span>
    </div>
    <pre><code>{labelChipMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Plugin UI · meter</h2>
    <p class="when">
      <strong>When:</strong> a plugin publishes a <code>meter</code> node via
      <code>ctx.publishUI</code>
      to display a numeric progress value relative to a maximum (e.g. token budget, rate-limit usage,
      task completion). The filled bar and value text share the same tone color; ratio is clamped to [0,
      1]. <strong>When not:</strong> for determinate process progress inside Shepherd's own chrome,
      prefer a loading indicator; <code>PuiMeter</code> is plugin-data only.
    </p>
    <div class="demo">
      <div class="pui-meter-demo">
        <div class="pui-meter-header-demo">
          <span class="pui-meter-label-demo">Tokens used</span>
          <span class="pui-meter-value-demo" style:color="var(--color-blue)">42/100</span>
        </div>
        <div
          class="pui-meter-track-demo"
          role="meter"
          aria-valuenow={42}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            class="pui-meter-fill-demo"
            style:width="42%"
            style:background="var(--color-blue)"
          ></div>
        </div>
        <span class="pui-meter-caption-demo">Monthly budget</span>
      </div>
    </div>
    <pre><code>{meterMarkup}</code></pre>
  </section>

  <section class="panel">
    <h2>Plugin UI · gauge</h2>
    <p class="when">
      <strong>When:</strong> a plugin publishes a <code>gauge</code> node via
      <code>ctx.publishUI</code>
      to display a single numeric value as a radial arc — e.g. quota consumption, capacity, or rate. The
      arc and percentage text share the tone color; the ratio is clamped to [0, 1]. Rendered from the
      whitelisted SVG registry; theme-aware.
      <strong>When not:</strong> use <code>meter</code> for a linear bar;
      <code>gauge</code> is for circular, at-a-glance readouts.
    </p>
    <div class="demo" style="max-width: 280px">
      <PluginUIRenderer node={gaugeNode} />
    </div>
    <pre><code>{gaugeDescriptor}</code></pre>
  </section>

  <section class="panel">
    <h2>Plugin UI · sparkline</h2>
    <p class="when">
      <strong>When:</strong> a plugin publishes a <code>sparkline</code> node via
      <code>ctx.publishUI</code>
      to surface a compact inline trend from a short numeric history — e.g. tokens/min, error rate, or
      latency over the last N samples. Single-series only; no axis labels (for those, use
      <code>time-series</code>). Theme-aware SVG polyline.
    </p>
    <div class="demo" style="max-width: 280px">
      <PluginUIRenderer node={sparklineNode} />
    </div>
    <pre><code>{sparklineDescriptor}</code></pre>
  </section>

  <section class="panel">
    <h2>Plugin UI · time-series</h2>
    <p class="when">
      <strong>When:</strong> a plugin publishes a <code>time-series</code> node via
      <code>ctx.publishUI</code>
      to compare one or more numeric series over time — e.g. 5 h vs. 7-day usage. Supports
      <code>kind: "line"</code> (default) or <code>"area"</code> fills. Each series carries an independent
      tone color from the design-token vocabulary. Theme-aware SVG.
    </p>
    <div class="demo" style="max-width: 320px">
      <PluginUIRenderer node={timeSeriesNode} />
    </div>
    <pre><code>{timeSeriesDescriptor}</code></pre>
  </section>

  <section class="panel">
    <h2>Plugin UI · bar-chart</h2>
    <p class="when">
      <strong>When:</strong> a plugin publishes a <code>bar-chart</code> node via
      <code>ctx.publishUI</code>
      to show a categorical distribution — e.g. per-account quota usage. Each bar carries an independent
      tone color. Default orientation is <code>"horizontal"</code>; pass
      <code>"vertical"</code> for a column chart. Theme-aware, token-driven layout.
    </p>
    <div class="demo" style="max-width: 280px">
      <PluginUIRenderer node={barChartNode} />
    </div>
    <pre><code>{barChartDescriptor}</code></pre>
  </section>

  <section class="panel">
    <h2>Plugin UI · timeline</h2>
    <p class="when">
      <strong>When:</strong> a plugin publishes a <code>timeline</code> node via
      <code>ctx.publishUI</code>
      to surface a chronological list of discrete events — e.g. session lifecycle, quota checks, or spawn
      refusals. Each event carries a timestamp (<code>at</code>), a label, an optional
      <code>caption</code>, and a tone dot. Theme-aware; no SVG — pure token-driven layout.
    </p>
    <div class="demo">
      <PluginUIRenderer node={timelineNode} />
    </div>
    <pre><code>{timelineDescriptor}</code></pre>
  </section>

  <section class="panel">
    <h2>Glossary term</h2>
    <p class="when">
      <strong>When:</strong> a dashed underline marks a term that has a definition in the glossary
      registry. Internal terms (kind <code>"internal"</code>) show an in-app definition only.
      External terms (kind <code>"external"</code>) add a locale-aware Wikipedia link. The
      presentation is chosen <strong>per interaction</strong>: hover or focus (fine pointer) opens a
      small anchored,
      <strong>non-blocking popover</strong> (no scrim) that dismisses on Esc, outside pointerdown,
      or scroll/resize; tap (coarse pointer) opens an <strong>in-flow inline disclosure</strong>
      that pushes content down and dismisses on Esc or outside pointerdown — but not on scroll.
      <strong>When not:</strong> do not use for decorative underlines or links — every dashed-underline
      term must resolve to a glossary entry.
    </p>
    <div class="demo">
      <p class="gloss-demo-text">
        <GlossaryText
          text="Shepherd groups sessions under an [[epic|epic]] and posts results to a [[pr|PR]]."
        />
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
      inset. Inactive: <code>--color-muted</code> (≥4.5:1 contrast — not the lower-contrast
      <code>--color-faint</code>). Full-bleed on mobile via
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

  <section class="panel">
    <h2>Filter popover</h2>
    <p class="when">
      <strong>When:</strong> collapsing a set of related list filters into a compact
      <em>Filters · N</em> control — e.g. the issue lists in the Repos pane and New Task. Uses the
      native <code>popover="manual"</code> top-layer together with the <code>anchorPopover</code>
      recipe from <code>$lib/floating-anchor</code> (same pattern as InfoTip). Non-modal, small,
      anchored: no scrim, dismiss on Esc or outside pointerdown.
      <strong>When not:</strong> don't use for a single toggle (prefer an inline chip or checkbox) or
      for a modal dialog (use the scrim recipe above).
    </p>
    <div class="demo">
      <IssueFilterPopover showMine={true} />
    </div>
    <pre><code>{"<IssueFilterPopover showMine={viewer != null} coachTargets />"}</code></pre>
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
  /* Issue label chip demo — mirrors IssueRow's .label-chip.hued recipe: --lc-* vars
     (from labelChipStyle()) drive dark-default color/border/fill, overridden per theme
     via the ancestor [data-theme="light"] selector. See the "Sanctioned exception" note
     in the Badges & chips section above. */
  .label-chip-demo {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border-radius: 2px;
    padding: 1px 5px;
    color: var(--lc-text-d);
    border: 1px solid var(--lc-border-d);
    background: var(--lc-fill-d);
  }
  :global([data-theme="light"]) .label-chip-demo {
    color: var(--lc-text-l);
    border-color: var(--lc-border-l);
    background: var(--lc-fill-l);
  }
  /* Status chip — 6px chip-row control; distinct from the 2px .chip color swatch above */
  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-panel-2);
    color: var(--color-muted);
  }
  .status-chip .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .status-chip.info {
    color: var(--color-blue);
    border-color: var(--color-blue);
  }
  .status-chip.ready {
    color: var(--color-green);
    border-color: var(--color-green);
  }
  /* subordinate red — failure only; never a halo/pulse/wash (Four-Light Rule) */
  .status-chip.fail {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  /* interactive control sharing the chip's 6px radius for row cohesion (a standalone button stays 2px) */
  .chip-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    background: transparent;
    color: var(--color-ink);
    cursor: pointer;
  }
  /* hover-lift marks the action — a resting status chip never lifts */
  .chip-action:hover {
    background: var(--color-hover);
    border-color: var(--color-ink);
  }
  /* amber primary — the loudest action in the row */
  .chip-action.primary {
    color: var(--color-amber);
    border-color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  /* PuiMeter demo styles (mirrors PuiMeter.svelte) */
  .pui-meter-demo {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 280px;
  }
  .pui-meter-header-demo {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .pui-meter-label-demo {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-weight: 600;
  }
  .pui-meter-value-demo {
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
  }
  .pui-meter-track-demo {
    height: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .pui-meter-fill-demo {
    height: 100%;
    border-radius: 3px;
  }
  .pui-meter-caption-demo {
    font-size: var(--fs-micro);
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
