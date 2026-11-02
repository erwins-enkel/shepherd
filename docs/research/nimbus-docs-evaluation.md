# Nimbus as an alternative to Starlight for docs.shepherd.run

Date: 2026-11-02. Desk research only: nothing was scaffolded or built.

## Verdict

**Viable, but don't migrate now.** Nimbus runs on the same base as our site (Astro 7, static output,
Pagefind), so a move is technically possible. It would add little we need today, and it would replace
a 3.5-year-old dependency with one under 4 months old. Its agent features are the real gain, and I didn't
check whether Starlight has equivalents. Revisit at Nimbus 1.0 or if those features become a
requirement.

## What Nimbus is

Nimbus is an MIT-licensed docs framework on Astro from the `cloudflare` GitHub org, with no paid tier
([repo](https://github.com/cloudflare/nimbus), [docs](https://nimbus-docs.com/llms.txt)). A scaffolder
copies layouts, components, routes and styles into your repo. The `@cloudflare/nimbus-docs` package
supplies the Astro integration, helpers and CLI. Sites are static by default and can be hosted
anywhere.

## Comparison

| Need                    | Current site                                  | Nimbus                                    |
| ----------------------- | --------------------------------------------- | ----------------------------------------- |
| Static build on Vercel  | Yes                                           | Yes                                       |
| Search                  | Pagefind                                      | Pagefind                                  |
| `llms.txt`              | `starlight-llms-txt`, including small variant | Built in: `llms.txt` and `llms-full.txt`  |
| Explicit, ordered nav   | `sidebar` config                              | `sidebar.items`                           |
| OG cards                | `astro-og-canvas` route                       | Optional Satori and resvg rendering       |
| TypeDoc API reference   | `starlight-typedoc`, about 1,826 pages        | No integration found; needs custom wiring |
| OpenAPI reference       | Not published                                 | Built in, OpenAPI 3.x                     |
| Markdown copy per page  | Not present                                   | Built in                                  |
| WebMCP search           | Not present                                   | Optional                                  |
| Agent Skills publishing | Not present                                   | Optional                                  |
| Remote MCP server       | Not present                                   | Optional, but needs a server adapter      |
| Customization           | `customCss` and 3 component overrides         | You own the copied files                  |

Our Markdown content should move with little change. The work is in the items below.

- **Replace Starlight wiring:** `docsLoader`, `docsSchema`, the sidebar config, 3 component overrides,
  `custom.css`, the OG route and both Starlight plugins.
- **Rebuild the TypeDoc path:** this is the largest unknown. `typedoc-plugin-markdown` could still emit
  pages, but frontmatter, navigation and build size on about 1,826 pages are untested. On Starlight,
  a sidebar that included these pages produced a 1.5 GB `dist/` (#2027), so this needs measuring.
- **Check `scripts/sync-docs.mjs`:** I did not check its generated frontmatter against Nimbus's schema.

## Why not now

- **Maturity:** the repo was created on 2026-07-09 and the first npm release was on 2026-07-16.
  `@cloudflare/nimbus-docs` is at 0.19.2 after 27 published versions, and its README warns that "the
  public API can change between minor releases". Starlight is also pre-1.0 (0.42.8), so the version
  number alone doesn't separate them. Its track record since 2023 does.
- **Concentration:** one contributor accounts for 1,176 of about 1,271 commits.
- **Upgrade work:** starter files live in your repo and only change when you take the update. Each
  release can add required manual reviews through `nimbus-docs migrate`. Starlight upgrades are mostly
  a dependency bump.
- **Little need today:** nothing establishes a need for the features Nimbus adds.
  - **OpenAPI reference:** `contracts/openapi.yaml` only describes the native client's subset of the
    API. If we did want to publish it, `starlight-openapi` 0.27.0 declares support for our Astro and
    Starlight versions (not tested here).
  - **Per-page Markdown, WebMCP search and Agent Skills:** I didn't look for Starlight equivalents, so
    treat these as real Nimbus advantages. Nothing currently requires them.
  - **Remote MCP server:** this would also add a server to a site that is deliberately static.

## In favour of Nimbus

- It has the strongest agent-facing feature set of the two: per-page Markdown, WebMCP search, Agent
  Skills and MCP. That suits a product about agents.
- Owning the layout files would allow deeper design changes than Starlight overrides.
- Development is active: the latest release and push were both on 2026-11-02.

## Not established

- Build time and output size for our page count.
- Native i18n: the docs show no locale feature. We don't need one today, as the site has no `locales`
  config.
- Any Starlight migration guide: none turned up in the repo tree, code search or `llms-full.txt`.

## If this is revisited

Run a throwaway spike that scaffolds Nimbus, imports `sync-docs` output, generates the TypeDoc pages,
then compares build time, `dist/` size and page weight with the current site. Adopt it only if the
agent features are worth more than the migration and upgrade work.
