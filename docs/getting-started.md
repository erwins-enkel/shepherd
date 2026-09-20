# Getting started with Shepherd

[← Shepherd](../README.md) · [Install](getting-started.md) · [Configuration](configuration.md) · [Operations](operations.md) · [Development](development.md)

Commands use the repository root as the working directory unless noted otherwise.

[Install](#install) · [Requirements](#requirements) · [Quick start](#quick-start)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh | bash
```

Provisions prerequisites, clones to `~/.shepherd/app`, builds the UI, and on Linux installs and
enables the systemd user service. Idempotent — safe to re-run: it never clobbers an existing
`~/.shepherd/` state dir and never force-resets a dirty checkout.

### `curl|bash` trust note

This is third-party `curl|bash`: the script runs unconfined as your user _before_ any sandbox
exists. It also invokes upstream installers it does not control — specifically: [bun.sh](https://bun.sh/install),
[fnm.vercel.app](https://fnm.vercel.app) (Node via fnm) and [claude.ai](https://claude.ai/install.sh)
(the `claude` CLI), plus your distro's package manager (`apt` / `apk` / `dnf` / `pacman`) for `git`,
`unzip`, and the C/C++ build toolchain + `python3` (needed for the node-pty native build). herdr is
**not** installed through `herdr.dev/install.sh` (which is latest-only): Shepherd downloads a
**version-pinned** binary from
[github.com/herdrdev/herdr/releases](https://github.com/herdrdev/herdr/releases) — the
highest release Shepherd supports — verifies it reports that version, and installs it to
`~/.local/bin`. That release binary is still third-party code fetched and executed on your machine.

> **Shepherd supports herdr up to 0.9.1.** herdr 0.7.5 (protocol 17) reshaped `agent start`;
> Shepherd drives it through a CLI external-registration path, and 0.9.1 (protocol 22) keeps that
> path. Schema, CLI, lifecycle and terminal compatibility are checked against 0.9.1;
> the sandbox idle-status advisory still applies. Shepherd warns at startup and blocks its in-app
> herdr updater on any newer, untested version. How a new herdr release gets verified and the
> ceiling moves is a standing procedure: see
> [herdr version bumps](https://docs.shepherd.run/reference/rules-herdr-version-bump/)
> (`.claude/rules/herdr-version-bump.md`).

In keeping with Shepherd's radical-transparency posture the script echoes each third-party command
before running it. Read the script first:
[deploy/install.sh](https://github.com/erwins-enkel/shepherd/blob/main/deploy/install.sh)

### OS matrix

| OS                                        | Mode                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linux (systemd + unprivileged userns)** | Full                 | The only fully supported target. Includes the sandbox membrane, egress allowlist, auto-drain, tailscale-serve previews, and the systemd user unit. The automated install-proof gate (`install-e2e`) runs here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **macOS**                                 | Core-only / degraded | Installs prereqs, clones, and builds the UI. Prints a loud degraded banner. Dev-server **detection** and **loopback** previews work. **No** sandbox membrane, egress allowlist, or auto-drain. Stopping a preview from the UI works but is bounded — the `lsof` snapshot must be fresh enough and the process is re-checked live, otherwise the stop is refused rather than sent. Exposing one over the tailnet is unavailable — it needs the `tailscale` CLI, which the Mac App Store build does not ship. **No systemd unit** — run `bun run start` manually. No automated install proof. The `herdr`/`claude` installers drop binaries in `~/.local/bin` — make sure it's on your `PATH` (see [Requirements](#requirements)). |
| **Windows**                               | Not supported        | The installer refuses and routes you to **WSL2** (a Linux distro under Windows Subsystem for Linux).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Environment knobs

| Variable              | Default           | Purpose                                                                                       |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `SHEPHERD_DIR`        | `~/.shepherd/app` | Where the repo is cloned / found                                                              |
| `SHEPHERD_REF`        | `main`            | Git ref to clone or check out                                                                 |
| `SHEPHERD_SRC`        | _(none)_          | Install from a local tarball or directory instead of cloning (used by the onboarding harness) |
| `SHEPHERD_NO_SERVICE` | _(none)_          | Skip the systemd unit step (set automatically on macOS)                                       |

### External testers

Shepherd's GitHub repo is public, so the `curl|bash` one-liner above works for an external tester
directly — both the raw `install.sh` URL and the `git clone` it performs are anonymous, needing no
token and no collaborator grant. Point testers at that one-liner; the rest of this section covers two
special cases where it doesn't fit.

**Air-gapped tarball (no GitHub access at all).** For a fully offline machine, the installer can land
the source from a local tarball via `SHEPHERD_SRC` instead of cloning — nothing to reach GitHub for:

```bash
# maintainer — build a source tarball from the current checkout:
git archive --format=tar.gz -o shepherd.tar.gz HEAD
# send shepherd.tar.gz to the tester (install.sh lives inside it at deploy/install.sh)

# tester — extract just the installer, then run it against the tarball:
tar -xzf ~/shepherd.tar.gz deploy/install.sh
SHEPHERD_SRC=~/shepherd.tar.gz bash deploy/install.sh
```

`git archive` ships tracked files only; that's sufficient, since the installer runs `bun install`
and builds from source. Trade-off: no in-place updates — each new build is a fresh tarball.

**Pinned version (self-serve, versioned).** Every merge of the release-please PR cuts a tagged
GitHub release, and GitHub auto-generates a source tarball for each tag. Since the repo is public,
the source archive downloads anonymously — no token — and the tester feeds it to `SHEPHERD_SRC`:

```bash
# tester — anonymous, no auth: fetch the source archive for a tag straight from codeload:
curl -fL https://github.com/erwins-enkel/shepherd/archive/refs/tags/v1.41.0.tar.gz \
  -o shepherd-1.41.0.tar.gz

# …or, if you already have `gh auth login` done, the gh CLI is a convenience:
gh release download v1.41.0 --archive=tar.gz -R erwins-enkel/shepherd   # → shepherd-1.41.0.tar.gz

# GitHub archives nest everything under a top-level dir — strip it and install from
# the extracted directory (SHEPHERD_SRC accepts a directory as well as a tarball):
mkdir -p ~/shepherd-src && tar -xzf shepherd-1.41.0.tar.gz --strip-components=1 -C ~/shepherd-src
SHEPHERD_SRC=~/shepherd-src bash ~/shepherd-src/deploy/install.sh
```

Testers self-serve any tagged version and re-download to update. For ongoing updates on `main`
instead, the anonymous `curl|bash` one-liner above installs a clone that `update.sh` / `git pull`
keeps current. Either way, full support is Linux + systemd (see the [OS matrix](#os-matrix) above) —
put testers on Linux to exercise the real sandbox membrane.

### Finish setup

The installer never runs commands that need a human secret. After it completes, log in:

```bash
claude              # sign in with your Max/Pro subscription (or configure API-key auth in Settings → Session)
gh auth login       # GitHub integration (PR list, merge, redeploy)

# remote access via Tailscale
tailscale serve --bg 7330
# then add the tailnet hostname to SHEPHERD_ALLOWED_HOSTS (in ~/.shepherd/env or deploy/shepherd.service)
```

The HUD is gated by a **single-operator password**. Set it with `SHEPHERD_PASSWORD`
in `~/.shepherd/env`, or use the strong password Shepherd auto-generates on first
boot and prints to the server log **once** (`systemctl --user status shepherd` /
`journalctl --user -u shepherd`). Browser sessions use this password login;
machine clients can use `SHEPHERD_TOKEN` instead.

Settings → DIAGNOSE surfaces any remaining gaps with one-click fixes.

For the from-clone / development path, see [Quick start](#quick-start) below.

## Requirements

- [Bun](https://bun.sh) — backend runtime + package manager
- `herdr` on `PATH` — manages the interactive `claude` panes (owns the PTYs)
  - Shepherd installs a **version-pinned** herdr (the highest release it supports) into
    `~/.local/bin`. On macOS that directory is not on `PATH` by default — add it to your shell
    profile before `bun run start`: `export PATH="$HOME/.local/bin:$PATH"`
- The `claude` CLI, logged in with your Max/Pro subscription
- Node.js — for the PTY helper subprocess

## Quick start

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

Open <http://localhost:7330>. The first load shows the single-operator password
screen; set `SHEPHERD_PASSWORD`, or use the auto-generated password printed once
in the server log. To expose it (e.g. via Tailscale), set
`SHEPHERD_ALLOWED_HOSTS` to include the public hostname (see [Configuration](configuration.md#configuration)).
