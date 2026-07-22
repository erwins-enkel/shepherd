---
title: Getting started
description: Install Shepherd and sign in.
# The external "shepherd.run" sidebar back-link sits first in sidebar order, so
# Starlight's auto-pagination would otherwise make it this page's "Previous" link
# (an off-site pager). This is the first real doc page, so it has no previous page.
prev: false
---

Shepherd is interactive mission control for fleets of Claude Code agents — it runs
sessions, drains backlogs into pull requests, and keeps a human in the loop where
it matters.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh | bash
```

The installer provisions prerequisites, clones the repo to `~/.shepherd/app`,
builds the UI, and on Linux installs and enables the systemd user service. It is
**idempotent** — safe to re-run: it never clobbers an existing `~/.shepherd/`
state dir and never force-resets a dirty checkout.

### `curl|bash` trust note

This is third-party `curl|bash`: the script runs unconfined as your user _before_
any sandbox exists, and it invokes upstream installers it does not control —
[bun.sh](https://bun.sh/install), [fnm](https://fnm.vercel.app) (Node), and the
[`claude` CLI](https://claude.ai/install.sh) — plus your distro's package manager
for `git`, `unzip`, and the C/C++ build toolchain + `python3` (needed for the
node-pty native build). herdr is **not** installed via `herdr.dev/install.sh`
(latest-only); Shepherd downloads a **version-pinned** release binary from
[GitHub](https://github.com/ogulcancelik/herdr/releases), verifies the version it
reports, and installs it to `~/.local/bin` — still third-party code fetched and
executed on your machine. In keeping with
Shepherd's radical-transparency posture the script echoes each third-party command
before running it. Read it first:
[deploy/install.sh](https://github.com/erwins-enkel/shepherd/blob/main/deploy/install.sh).

### Supported platforms

| OS | Mode | Notes |
| --- | --- | --- |
| **Linux** (systemd + unprivileged userns) | Full | The only fully supported target — sandbox membrane, egress allowlist, auto-drain, Tailscale-serve previews, the systemd user unit, and the hourly DB backup timer. |
| **macOS** | Core-only / degraded | Installs prereqs, clones, builds the UI, prints a loud degraded banner. **No** sandbox, egress allowlist, auto-drain, previews, systemd unit, or automated backups — run `bun run start` manually. |
| **Windows** | Not supported | The installer refuses and routes you to **WSL2**. |

### Installer environment knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHEPHERD_DIR` | `~/.shepherd/app` | Where the repo is cloned / found |
| `SHEPHERD_REF` | `main` | Git ref to clone or check out |
| `SHEPHERD_SRC` | _(none)_ | Install from a local tarball or directory instead of cloning |
| `SHEPHERD_NO_SERVICE` | _(none)_ | Skip the systemd unit step (set automatically on macOS) |

## Finish setup

The installer never runs commands that need a human secret. After it completes,
sign in:

```bash
claude              # sign in with your Max/Pro subscription
                    # (or configure API-key auth in Settings → Session)
gh auth login       # GitHub integration (PR list, merge, redeploy)

# remote access via Tailscale
tailscale serve --bg 7330
# no allowlist step needed — Shepherd auto-trusts every Tailscale-served
# host fronting its port. Only a non-Tailscale proxy / custom-DNS front
# needs its hostname in SHEPHERD_ALLOWED_HOSTS (in ~/.shepherd/env).
```

The HUD is gated by a **single-operator password**: the first time you open it
you'll get a login screen. Set the password with `SHEPHERD_PASSWORD` (in
`~/.shepherd/env`), or use the strong one Shepherd generates and prints to the
log **once** on first boot (`systemctl --user status shepherd` / `journalctl
--user -u shepherd`). Log out from **Settings → Session**.

On a brand-new install the HUD then opens on a **blocking first-run step** that
asks you to choose a **workspace folder** before anything else runs. Shepherd
only looks for repositories inside this folder, and its background work (polling,
drain, task spawning) stays paused until you pick one — you can change it later
in **Settings**. Set `SHEPHERD_REPO_ROOT` before first boot to skip the picker.

**Settings → DIAGNOSE** surfaces any remaining gaps with one-click fixes.

## From-clone / development path

To run Shepherd from a checkout instead of the installer:

```bash
# 1. install deps (root + ui)
bun install
cd ui && bun install && cd ..

# 2. build the SPA (the core serves it statically from ui/build)
cd ui && bun run build && cd ..

# 3. run the core
bun run start
# → shepherd core on http://localhost:7330
```

Open <http://localhost:7330>. To expose it (e.g. via Tailscale), set
`SHEPHERD_ALLOWED_HOSTS` to include the public hostname — see
[Configuration](/reference/configuration/).

### Requirements

- [Bun](https://bun.sh) — backend runtime + package manager
- `herdr` on `PATH` — [Can Celik](https://github.com/ogulcancelik)'s agent
  multiplexer ([herdr.dev](https://herdr.dev)); manages the interactive `claude`
  panes (owns the PTYs). **herdr 0.7.5 is the last supported version — do not
  upgrade past 0.7.5 yet.** herdr 0.7.5 (protocol 17) reshaped `agent start`, so
  Shepherd spawns on it through a CLI external-registration path (`tab create` →
  `pane run` → `report-agent`) rather than the legacy `agent start`. Any newer,
  untested version is refused: Shepherd warns at startup, blocks the in-app
  updater, and refuses to spawn on it.
- The `claude` CLI, logged in with your Max/Pro subscription
- Node.js — for the PTY helper subprocess

## Next steps

- [Shepherd Capture](/capture-extension/) — the browser extension that turns any page into a task or session.
- [Operating Shepherd](/operating/) — run it as a service and deploy changes.
- [Configuration](/reference/configuration/) — every environment variable.
- [Concepts & glossary](/reference/glossary/) — the terms Shepherd uses.
- [Plugins](/reference/plugins/) — extend Shepherd with server-side spawn hooks, routes, and UI.
