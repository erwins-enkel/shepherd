<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { theme } from "$lib/theme.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "wireframe" }> } = $props();

  const DOMPURIFY_CONFIG = {
    ALLOWED_TAGS: [
      "div",
      "span",
      "p",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "footer",
      "nav",
      "section",
      "article",
      "main",
      "aside",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "button",
      "label",
      "strong",
      "em",
      "b",
      "i",
      "small",
      "br",
      "hr",
      "img",
      "svg",
      "path",
      "rect",
      "circle",
      "line",
      "g",
    ],
    ALLOWED_ATTR: [
      "class",
      "style",
      "data-icon",
      "data-primary",
      "width",
      "height",
      "viewBox",
      "d",
      "x",
      "y",
      "cx",
      "cy",
      "r",
      "x1",
      "y1",
      "x2",
      "y2",
      "fill",
      "stroke",
      "aria-hidden",
      "role",
      "alt",
    ],
    FORBID_TAGS: ["script", "style", "a", "form", "input", "iframe", "object", "embed", "link"],
    FORBID_ATTR: ["href", "src", "target", "formaction"],
    ALLOW_DATA_ATTR: false,
  };

  const SURFACE_WIDTHS: Record<Extract<VisualBlock, { type: "wireframe" }>["surface"], string> = {
    browser: "100%",
    desktop: "100%",
    mobile: "390px",
    popover: "320px",
    panel: "320px",
  };

  const surfaceLabel = $derived(
    {
      browser: m.vblock_wireframe_surface_browser(),
      desktop: m.vblock_wireframe_surface_desktop(),
      mobile: m.vblock_wireframe_surface_mobile(),
      popover: m.vblock_wireframe_surface_popover(),
      panel: m.vblock_wireframe_surface_panel(),
    }[block.surface],
  );

  const surfaceWidth = $derived(SURFACE_WIDTHS[block.surface]);

  let srcdoc = $state<string>("");
  let frameHeight = $state<number>(320);
  let iframeEl = $state<HTMLIFrameElement | null>(null);

  const HELPER_CSS = `
.wf-card{ background:var(--wf-card); border:1px solid var(--wf-line); border-radius:var(--wf-radius); padding:12px; }
.wf-box{ border:1px solid var(--wf-line); border-radius:var(--wf-radius); padding:8px; }
.wf-pill{ display:inline-block; padding:2px 8px; border:1px solid var(--wf-line); border-radius:999px; }
.wf-chip{ display:inline-block; padding:1px 6px; background:var(--wf-accent-soft); border-radius:var(--wf-radius); }
.wf-muted{ color:var(--wf-muted); }
button,[data-primary]{ background:var(--wf-card); color:var(--wf-ink); border:1px solid var(--wf-line); border-radius:var(--wf-radius); padding:4px 10px; }
button.primary,[data-primary]{ background:var(--wf-accent); color:var(--wf-accent-fg); border-color:var(--wf-accent); }
[data-icon]{ display:inline-block; width:1em; height:1em; background:var(--wf-line); border-radius:2px; vertical-align:middle; }
`;

  $effect(() => {
    // Read reactive deps at top so the effect re-runs on theme/contrast change.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reactive dep
    const resolved = theme.resolved;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    theme.contrast;
    const html = block.html;

    let alive = true;

    (async () => {
      try {
        const DOMPurify = (await import("dompurify")).default;
        const clean = DOMPurify.sanitize(html, DOMPURIFY_CONFIG);

        const cs = getComputedStyle(document.documentElement);
        const get = (prop: string) => cs.getPropertyValue(prop).trim();

        const tokens: Record<string, string> = {};
        for (const name of [
          "--wf-ink",
          "--wf-muted",
          "--wf-line",
          "--wf-paper",
          "--wf-card",
          "--wf-radius",
          "--wf-accent",
          "--wf-accent-fg",
          "--wf-accent-soft",
          "--wf-warn",
          "--wf-ok",
        ]) {
          const val = get(name);
          if (val) tokens[name] = val;
        }

        const tokenCss = Object.entries(tokens)
          .map(([k, v]) => `${k}:${v};`)
          .join(" ");

        const doc = [
          "<!doctype html><html><head>",
          "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">",
          `<style>:root{ ${tokenCss} } html,body{ margin:0; background:var(--wf-paper); color:var(--wf-ink); font-family: system-ui, sans-serif; font-size:13px; } ${HELPER_CSS}</style>`,
          `</head><body>${clean}</body></html>`,
        ].join("");

        if (alive) {
          srcdoc = doc;
        }
      } catch {
        // fail silently — iframe stays blank rather than crashing
      }
    })();

    return () => {
      alive = false;
    };
  });

  function onFrameLoad() {
    if (!iframeEl) return;
    try {
      const h = iframeEl.contentDocument?.body?.scrollHeight;
      if (h && h > 0) {
        frameHeight = Math.min(h, 640);
      }
    } catch {
      // cross-origin or other access error — keep default height
    }
  }
</script>

<div class="wf-block">
  <div class="wf-header">
    <span class="wf-surface-label">{surfaceLabel}</span>
    <span class="wf-honesty-badge">{m.vblock_wireframe_mockup_label()}</span>
  </div>
  <div class="wf-frame-wrap" style="--surface-width: {surfaceWidth}">
    <iframe
      class="wf-frame"
      sandbox="allow-same-origin"
      {srcdoc}
      title={surfaceLabel}
      style="height: {frameHeight}px"
      bind:this={iframeEl}
      onload={onFrameLoad}
    ></iframe>
  </div>
  {#if block.caption}
    <p class="wf-caption">{block.caption}</p>
  {/if}
</div>

<style>
  .wf-block {
    display: flex;
    flex-direction: column;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }

  .wf-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-line);
  }

  .wf-surface-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-weight: 500;
  }

  /* Honesty badge — mirrors InferredBadge.svelte dashed-amber recipe */
  .wf-honesty-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border: 1px dashed var(--color-amber);
    border-radius: 3px;
    font-size: var(--fs-micro);
    color: var(--color-amber);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .wf-frame-wrap {
    padding: 10px;
    display: flex;
    justify-content: center;
  }

  .wf-frame {
    display: block;
    border: 1px solid var(--color-line);
    border-radius: 3px;
    background: var(--color-inset);
    width: var(--surface-width);
    max-width: 100%;
    overflow: auto;
  }

  .wf-caption {
    padding: 4px 10px 8px;
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    border-top: 1px solid var(--color-line);
  }
</style>
