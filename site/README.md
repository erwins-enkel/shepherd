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
