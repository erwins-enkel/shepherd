// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { syncDocs } from "./scripts/sync-docs.mjs";

// Import the curated `docs/*.md` sources into the Starlight content collection.
// Called at config-evaluation time (NOT via a package.json script) on PURPOSE:
// vercel.json pins `framework: astro`, so the deploy runs `astro build` directly
// and bypasses npm scripts. Astro loads this config on EVERY command
// (build / dev / check / preview), so running the sync here guarantees the
// generated pages exist on every path — production build included — before
// Starlight resolves the sidebar `slug:` entries below. See scripts/sync-docs.mjs.
syncDocs();

// Shepherd documentation site for docs.shepherd.run.
// - `output: "static"` (Astro's default; set explicitly) — a fully static
//   `dist/` that Vercel auto-detects (no SSR adapter needed).
// - Brand theming lives in src/styles/custom.css, which maps a curated subset
//   of the UI design tokens (ui/src/app.css) onto Starlight's --sl-* variables.
// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  // Canonical production URL (drives sitemap + canonical link tags). The site
  // goes live at docs.shepherd.run once an operator completes the steps in
  // README.md; the static build is correct regardless of whether DNS is attached.
  site: "https://docs.shepherd.run",
  output: "static",
  integrations: [
    starlight({
      title: "Shepherd",
      description: "Documentation for Shepherd — interactive mission control for Claude Code agents.",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/erwins-enkel/shepherd",
        },
      ],
      // Explicit, ordered items (not `autogenerate`) so the IA order/labels are
      // deterministic and the two build-time-generated reference pages
      // (external-task-api, security) resolve by slug.
      sidebar: [
        {
          label: "Guides",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "Operating Shepherd", slug: "operating" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Concepts & glossary", slug: "reference/glossary" },
            { label: "External Task API", slug: "reference/external-task-api" },
            { label: "Security", slug: "reference/security" },
          ],
        },
      ],
    }),
  ],
});
