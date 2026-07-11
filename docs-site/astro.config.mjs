// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import starlightLlmsTxt from "starlight-llms-txt";
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
      // Override the header social-icons slot to prepend a same-tab back-link to the
      // marketing site (shepherd.run); the override re-renders the default so the
      // GitHub social icon below still appears. See src/components/SiteBacklink.astro.
      components: {
        SocialIcons: "./src/components/SiteBacklink.astro",
        // Re-render the default Head + append Vercel Web Analytics. See
        // src/components/Head.astro for why an override (vs the `head` config option).
        Head: "./src/components/Head.astro",
      },
      // Generate the TypeScript API reference from the server package (../src)
      // with TypeDoc, so it CANNOT drift from source. Like syncDocs() above, this
      // runs at Starlight-init time on every astro command (check/build/dev), so
      // the generated pages exist on every path — production deploy included.
      // Output lands in src/content/docs/api/ (git-ignored — see .gitignore).
      plugins: [
        starlightTypeDoc({
          entryPoints: ["../src"],
          // Dedicated, docs-site-local tsconfig (NOT the root one): scopes the
          // TypeDoc program to ../src and resolves Bun/node globals from this
          // package's own @types/bun, so the API reference builds on Vercel where
          // only docs-site/ is installed. See typedoc.tsconfig.json for the why.
          tsconfig: "./typedoc.tsconfig.json",
          output: "api",
          sidebar: { label: "API reference", collapsed: true },
          typeDoc: {
            // `expand` documents every .ts under ../src (there is no public-API
            // barrel to use as a single entry point).
            entryPointStrategy: "expand",
            // Generate docs even if a stray type can't be resolved in the docs-site
            // install — the docs build must not gate on a type diagnostic (the root
            // `tsc`/CI is the real type gate). Belt-and-suspenders with the scoped
            // tsconfig above, which already makes ../src resolve cleanly here.
            skipErrorChecking: true,
            // Drop the lone test file and the zero-export entry script.
            exclude: ["**/*.test.ts", "**/src/index.ts"],
            readme: "none",
            // Deterministic, machine-independent "Defined in" links: no git so no
            // embedded commit SHA / absolute paths — {path} is repo-relative
            // (basePath = repo root) and pinned to main. Keeps output reproducible
            // from src/ alone.
            disableGit: true,
            basePath: "..",
            sourceLinkTemplate: "https://github.com/erwins-enkel/shepherd/blob/main/{path}",
          },
        }),
        // Publish llms.txt / llms-full.txt / llms-small.txt (https://llmstxt.org)
        // so Shepherd's own agents and other LLMs can consume the docs. The plugin
        // runs during `astro build`, emitting into the static `dist/` (git-ignored,
        // like the other generated outputs) — served at /llms.txt etc. on the live
        // site. `site` (set above) drives the absolute links it writes.
        starlightLlmsTxt({
          projectName: "Shepherd",
          description: "Interactive mission control for Claude Code agents.",
          // The TypeDoc API reference (entryPointStrategy "expand" documents every
          // .ts under ../src) would dominate the corpus. `demote` sorts those pages
          // to the END of every output; `exclude` drops them from the SMALL output
          // ONLY (llms-small.txt) — llms.txt + llms-full.txt keep them. (Per the
          // plugin's types.ts: exclude == "exclude from llms-small.txt".)
          demote: ["api/**"],
          exclude: ["api/**"],
        }),
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/erwins-enkel/shepherd",
        },
      ],
      // Explicit, ordered items (not `autogenerate`) so the IA order/labels are
      // deterministic and the three build-time-generated reference pages
      // (external-task-api, security, house-rules) resolve by slug.
      sidebar: [
        // Back-link to the marketing site. Starlight auto-detects the external
        // https:// link and renders its own external-link affordance; left same-tab
        // (no `attrs.target`) to match the header back-link.
        { label: "shepherd.run", link: "https://shepherd.run" },
        {
          label: "Guides",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "Operating Shepherd", slug: "operating" },
            { label: "Authoring an epic", slug: "authoring-epics" },
            { label: "Hands-off epics", slug: "hands-off-epics" },
            { label: "Capture extension", slug: "capture-extension" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Concepts & glossary", slug: "reference/glossary" },
            { label: "Keyboard shortcuts", slug: "reference/keyboard-shortcuts" },
            { label: "Plugins", slug: "reference/plugins" },
            { label: "External Task API", slug: "reference/external-task-api" },
            { label: "Security", slug: "reference/security" },
            // Repo-root CLAUDE.md, imported verbatim by scripts/sync-docs.mjs.
            { label: "Project house rules", slug: "reference/house-rules" },
            // CLI reference: operator-facing `herdr` commands, generated by
            // scripts/gen-cli-reference.ts from live `herdr --help` and COMMITTED
            // (herdr is absent from CI/Vercel, so unlike the TypeDoc/sync-docs
            // outputs these pages cannot be built here). Explicit ordered items
            // (not `autogenerate`) to keep IA deterministic, matching the rest of
            // this sidebar; regen already requires a human commit.
            {
              label: "CLI reference",
              items: [
                { label: "Overview", slug: "reference/cli" },
                { label: "herdr status", slug: "reference/cli/status" },
                { label: "herdr update", slug: "reference/cli/update" },
                { label: "herdr channel", slug: "reference/cli/channel" },
                { label: "herdr server", slug: "reference/cli/server" },
                { label: "herdr session", slug: "reference/cli/session" },
              ],
            },
          ],
        },
        // Autogenerated section for the TypeDoc-built API reference (see the
        // starlight-typedoc plugin above). The group + its pages are derived
        // entirely from ../src.
        typeDocSidebarGroup,
      ],
    }),
  ],
});
