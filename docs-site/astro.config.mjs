// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Shepherd documentation site for docs.shepherd.run.
// - `output: "static"` (Astro's default; set explicitly) — a fully static
//   `dist/` that Vercel auto-detects (no SSR adapter needed).
// - Brand theming lives in src/styles/custom.css, which maps a curated subset
//   of the UI design tokens (ui/src/app.css) onto Starlight's --sl-* variables.
// - This is a SKELETON (#877, epic #875 Phase 1): real docs content, generated
//   references, and the llms.txt/agent surfaces land in sibling sub-issues.
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
      sidebar: [
        {
          label: "Guides",
          items: [{ label: "Getting started", slug: "getting-started" }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
