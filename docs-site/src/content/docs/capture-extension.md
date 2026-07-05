---
title: Shepherd Capture (browser extension)
description: Install the Shepherd Capture browser extension and turn any page into a task or session.
---

**Shepherd Capture** is a Chromium (Chrome, Edge, Brave, …) browser extension
that turns the tab you're looking at into a Shepherd task or a live session — with
a screenshot and page context attached — in one click.

## Install from the Chrome Web Store

Published and ready to use:

**[Shepherd Capture on the Chrome Web Store](https://chromewebstore.google.com/detail/shepherd-capture/liknmighjkhplpbocaefaljokofaifgi)** → **Add to Chrome**.

The store install works with your server **out of the box** — the published
extension ID is allowlisted by default, so there is **no pairing step and no
`SHEPHERD_ALLOWED_HOSTS` configuration** required. Just point the extension at
your Shepherd core (below) and capture.

## Point it at your core

Open the extension's **options** (right-click the toolbar icon → *Options*) and set:

- **Base URL** — your Shepherd core:
  - **Local:** `http://localhost:7330`.
  - **Remote (Tailscale):** `https://<host>.ts.net` — saving a `ts.net` URL
    prompts the browser to grant access to that host; accept it once and captures
    file against your remote core.
- **Token** — only if the server runs with `SHEPHERD_TOKEN` set.
- **Repo path** — the default target repo (must resolve inside the server's
  `SHEPHERD_REPO_ROOT`).
- **Base branch** and **Model** — optional.
- **Routing rules** — optional URL→repo rules so a capture lands in the right repo
  automatically.

## What a capture includes

- A screenshot (visible area or full page).
- Page metadata (title, URL).
- Optional signals: an accessibility (axe-core) audit, console errors, and failed
  network requests.

You choose whether a capture **spawns a live session now** or is **filed as an
issue** (GitHub / Gitea) via the task API.

## Open the popup

Click the toolbar icon, or press **Alt+Shift+S** (rebindable at
`chrome://extensions/shortcuts`).

## For developers

To run an unpacked development build instead of the store version, see the
extension's [README](https://github.com/erwins-enkel/shepherd/blob/main/extension/README.md).
The server's origin allowlist and the `SHEPHERD_ALLOWED_HOSTS` knob are documented
under [Configuration](/reference/configuration/).
