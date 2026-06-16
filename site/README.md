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
bun run dev      # local dev server
bun run build    # static output to dist/
bun run preview  # serve the built dist/
```

## Routing (`vercel.json`)

The bare root `/` serves this landing page. The installer redirect is preserved:

```
shepherd.run/install.sh  → 302 →  https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh
```

so `curl -fsSL https://shepherd.run/install.sh | bash` keeps working. (The old
bare-`/` → GitHub redirect from the redirect-only `deploy/vanity` project is
intentionally dropped — the root now serves a page; GitHub is an on-page link.)

## ⚠️ Deployment inertness — merging does NOT make shepherd.run serve this page

The `shepherd.run` Vercel project's **Root Directory still points at
`deploy/vanity`** (the redirect-only project). Until an operator extracts this
folder to the `shepherd-site` repo **and re-points the Vercel project**,
`shepherd.run/` keeps 302-redirecting to GitHub and nothing this folder changes
is live. The work is **deployment-inert** until the manual step below.

## Go-live (manual operator steps)

1. **Create the repo (operator-gated — not done autonomously by an agent).**
   From an extracted copy of this folder (fresh `git init`), the operator runs:
   ```bash
   gh repo create erwins-enkel/shepherd-site --public --source=. --push
   ```
   (or creates `shepherd-site` in the GitHub UI and pushes). Creating a public
   org repo is an outward-facing action and is the operator's call.
2. **Re-point the existing `shepherd.run` Vercel project** (do not create a new
   one): **Settings → Git** → connect `shepherd-site`; set **Root Directory =**
   the repo root; **Framework Preset = Astro**.
3. **Redeploy**, then verify:
   ```bash
   curl -fsSL https://shepherd.run/ | head            # serves the landing page HTML
   curl -fsSI https://shepherd.run/install.sh | head  # 302 → raw-GitHub installer
   ```

Once `shepherd-site` serves both the root page and `/install.sh`, the
`deploy/vanity` redirect-only project is redundant and can be retired in a
separate follow-up.
