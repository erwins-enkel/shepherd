# `shepherd.run` landing page

The marketing landing page for **Shepherd**, served at the root of the
`shepherd.run` domain. Static [Astro](https://astro.build) site — no backend,
no secrets.

This site is **not** part of the Shepherd app: it is exempt from the app's i18n
(EN/DE parity), glossary, and feature-announcement-catalog gates. It is built to
live in its **own repo (`shepherd-site`)** riding the existing `shepherd.run`
Vercel project.

## Develop

```bash
cd site
bun install
bun run dev             # local dev server
bun run build           # static output to dist/
bun run preview         # serve the built dist/
bun run check:artifacts # assert on what the build emitted (run after build)
```

## CI

The `site` job in `.github/workflows/ci.yml` runs `bun run check`, `bun run build`
and `bun run check:artifacts` on every PR.

That last step exists because **a green `astro build` does not prove the site is
correct**. The Fonts API fails *silently*: point a family's provider at a package it
cannot resolve and the build still exits 0 with only a `[WARN]`, emitting a `dist/`
where that family has degraded to system fonts. Measured against a real degraded
build, every aggregate signal survives — `@font-face` blocks are still present, the
`--font-*` variables are still declared, woff2 files and preload links are still
emitted. The one check that discriminates is per-family: does the family each
`--font-*` variable names actually have a `url()`-backed `@font-face`?

`scripts/check-build-artifacts.mjs` asserts that, plus route coverage and font-file
size floors. The expected font families are read from `astro.config.mjs`, so adding
one brings it under the gate automatically — and every configured family is required
on **every** route. That holds because `src/layouts/Base.astro` renders one `<Font>`
tag per family and all pages use that layout. A family scoped to a single page or
layout would therefore fail the gate; supporting one means teaching the check which
routes a family applies to, rather than assuming all of them.

Routes are derived from `src/pages/**`, so a new **static `.astro`** page — nested
included — is covered with no change to the script. Anything the directory-format
mapping cannot resolve to a single output path **fails the gate by design**, rather
than being silently skipped:

- a Markdown/MDX page (`about.md`) — the mapping only understands `.astro`
- a dynamic or spread route (`[slug].astro`) — its outputs come from
  `getStaticPaths` at build time, so they cannot be derived from the filename

If you add either, extend `routeForPage()` to cover it; the red is telling you the
gate would otherwise stop covering a route. Underscore- and dot-prefixed entries
(`_components/`, `.DS_Store`) are not routes and are skipped.

Its logic is unit-tested from the monorepo root in `test/check-build-artifacts.test.ts`,
alongside the repo's other gate-script tests.

## Routing (`vercel.json`)

The bare root `/` serves this landing page. The installer redirect is preserved:

```
shepherd.run/install.sh  → 302 →  https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh
```

so `curl -fsSL https://shepherd.run/install.sh | bash` keeps working. (The old
bare-`/` → GitHub redirect from the redirect-only `deploy/vanity` project is
intentionally dropped — the root now serves a page; GitHub is an on-page link.)

## Deployment status

**Update:** `shepherd.run` is now **live** on its own Vercel project — the
"no Vercel project yet / deployment-inert" caveat that previously stood here is
stale and has been removed. The from-scratch go-live steps below are retained as
a historical record of how the project was created.

## Go-live (manual operator steps — creating from scratch)

1. **Create the repo (operator-gated — not done autonomously by an agent).**
   From an extracted copy of this folder (fresh `git init`), the operator runs:
   ```bash
   gh repo create erwins-enkel/shepherd-site --public --source=. --push
   ```
   (or creates `shepherd-site` in the GitHub UI and pushes). Creating a public
   org repo is an outward-facing action and is the operator's call. (Alternative:
   import the monorepo and set Root Directory = `site` — but a dedicated repo is
   the issue's decision.)
2. **Create the Vercel project:** **Add New → Project**, import `shepherd-site`.
   Astro is auto-detected (build `astro build`, output `dist/`). The shipped
   `vercel.json` preserves the `/install.sh` 302 and intentionally has no bare-`/`
   redirect (root serves the page).
3. **Attach the domain:** Project → **Settings → Domains** → add `shepherd.run`,
   then set the **DNS records Vercel prescribes** at the registrar. Nothing is
   live — and the on-page `curl shepherd.run/install.sh` won't resolve — until the
   domain is attached and DNS propagates.
4. **Deploy**, then verify:
   ```bash
   curl -fsSL https://shepherd.run/ | head            # serves the landing page HTML
   curl -fsSI https://shepherd.run/install.sh | head  # 302 → raw-GitHub installer
   ```

If the redirect-only `deploy/vanity/` config is ever actually provisioned as its
own project, it becomes redundant once `shepherd-site` serves both the root page
and `/install.sh`, and can be retired.
