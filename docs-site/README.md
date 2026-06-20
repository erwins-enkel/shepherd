# `docs.shepherd.run` documentation site

The documentation site for **Shepherd**, served at `docs.shepherd.run`. Static
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build) site —
no backend, no secrets.

This is the **skeleton** scaffolded in Phase 1 of the docs epic (#875 / #877):
the package, brand theming, and a green build. Real content, generated
references, an `llms.txt`, and the AI-agent surfaces land in follow-up
sub-issues.

## Why `docs-site/` (not `docs/`)

`docs/` is an **active content-source directory** with live write conventions —
`RESEARCH_DIRECTIVE` writes `docs/research/<slug>.md` and the brainstorming flow
writes `docs/superpowers/specs/` — so the Starlight package can't root there.
It lives at the sibling path `docs-site/` (parallel to `site/`), and Vercel's
**Root Directory** is set to `docs-site`.

## Relationship to the app's gates

Like `site/`, this package is **not** part of the Shepherd app and is exempt from
the app's i18n (EN/DE parity), glossary, and feature-announcement-catalog gates.
Those gates are scoped to `ui/` + `extension/` and to `feat(...)` commits touching
`ui/src/...`, so `docs-site/` never trips them. `docs-site/` is added to the root
`.prettierignore` (its `.astro`/`.md` files use Astro's own toolchain) and to the
root `tsconfig.json` `exclude` (it type-checks via `astro check`, not the server
`tsc`).

Unlike `site/`, this package **stays in the monorepo** and **is wired into CI**
(`.github/workflows/ci.yml`): `cd docs-site && bun install --frozen-lockfile &&
bun run check && bun run build`.

## Develop

```bash
cd docs-site
bun install
bun run dev      # local dev server
bun run build    # static output to dist/
bun run preview  # serve the built dist/
bun run check    # astro check (type + content diagnostics)
```

## Brand tokens

`src/styles/custom.css` maps a curated subset of the UI design tokens
(`ui/src/app.css` `--color-*` / `--fs-*`) onto Starlight's `--sl-*` variables. The
literal values live in a single `--brand-*` provenance block (mirroring
`app.css`); every `--sl-*` mapping references those via `var()`, so no hex is
scattered through the theme — the same pattern as `site/src/styles/global.css`.

## Go-live (manual operator steps — creating from scratch)

The build is **deployment-inert** until an operator creates and wires a Vercel
project. Nothing is served at `docs.shepherd.run` until these steps are done.

1. **Create the Vercel project (operator-gated — not done autonomously by an
   agent).** In Vercel: **Add New → Project**, import the `shepherd` monorepo, and
   set **Root Directory = `docs-site`**. Astro is auto-detected (build
   `astro build`, output `dist/`); the shipped `vercel.json` pins
   `"framework": "astro"`.
2. **Attach the domain:** Project → **Settings → Domains** → add
   `docs.shepherd.run`, then create the **DNS records Vercel prescribes** (a
   `CNAME` for the `docs` subdomain) at the `shepherd.run` registrar. The root
   `shepherd.run` is already live on its own (marketing) project; this adds the
   `docs` subdomain alongside it.
3. **Deploy**, then verify:
   ```bash
   curl -fsSL https://docs.shepherd.run/ | head   # serves the docs landing HTML
   ```

Until the domain is attached and DNS propagates, the site is reachable only at
the Vercel-assigned preview URL.
