# `shepherd.run` vanity installer redirect (Vercel)

This directory is **ops tooling**, not user-facing app UI — it is intentionally
**not** internationalized and carries no feature-catalog entry.

## Purpose

Serve a short, memorable install command. `shepherd.run/install.sh` issues a
**302 redirect** to the canonical raw-GitHub copy of `deploy/install.sh` on
`main`:

```
shepherd.run/install.sh
  → 302 →
https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh
```

The **repo stays the single source of truth** — the redirect target is the same
in-repo script the README already advertises. Nothing is built or copied; Vercel
only re-points the request.

`shepherd.run/` (the bare root) likewise 302-redirects to the GitHub repo.

## Why a 302 (temporary), not 301/308

The redirect is deliberately **temporary** so the destination can be re-pointed
later (e.g. a CDN, or a pinned release tag instead of `main`) without fighting
permanently-cached 301/308 redirects sitting in browsers and proxies. The
destination currently tracks `main`.

## Vercel setup (ordered)

1. In Vercel, **create a new project** from this repository.
2. Set **Root Directory = `deploy/vanity`** (this project is just the
   `vercel.json` in this directory).
3. **Framework Preset = "Other"**, with **no build command** and **no output
   directory** — it is redirect-only, there is nothing to build.
4. **Deploy.**
5. Add the custom domain **`shepherd.run`** in
   **Project → Settings → Domains**.
6. At the domain registrar, set the **DNS records Vercel prescribes** for
   `shepherd.run` (the apex/`A`/`CNAME` records shown in the Domains panel).

## Verification

Once DNS has propagated and the domain is attached:

```bash
curl -fsSL https://shepherd.run/install.sh | head
```

This should print the `deploy/install.sh` bash header
(`#!/usr/bin/env bash` … "Shepherd cold-start bootstrap").

**This curl check proves the command _works_, NOT that we own the domain.** A
third party who registered a _misspelled-but-resolving_ lookalike domain could
produce a working redirect and a false-green here. Ownership of `shepherd.run`
rests on the operator's registrar fact (the registered-domain answer), not on
this resolving.

## Phase 2 gate (deferred — separate PR)

The advertised install command in **`README.md`** and the header comment in
**`deploy/install.sh`** currently point at the canonical raw-GitHub URL and
**MUST NOT** be swapped to the `shepherd.run` URL until the verification above
passes. That cutover is a **separate, deferred PR (Phase 2)**.
