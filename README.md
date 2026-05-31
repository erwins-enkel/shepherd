# Shepherd

> Self-hosted mission control for **interactive** Claude Code. Spawn, watch, and steer a herd of
> real `claude` sessions live from your browser or phone — on your own server.

Shepherd spawns genuine interactive `claude` sessions in isolated git worktrees (via `herdr`, the
interactive-pane manager), bridges each PTY to an `xterm.js` pane in the browser, and lets one
operator run many agents in parallel — observing their status and steering them by typing, exactly
like a human at a terminal.

> The repo directory is `tank/` for historical reasons; the product is **Shepherd**.

## ToS compliance model

This is the defining constraint, not a footnote. Shepherd runs on the operator's own Claude
subscription, so it **only drives interactive terminal sessions** — it never uses the Agent SDK or
`claude -p`. It observes (reads the terminal + agent status) and steers (injects keystrokes into the
live pane). Auth is the operator's own login; no token relay, no impersonation, single operator.

If a feature can't be done by typing into a real terminal, it doesn't ship. See `PRD.md` for the
full rationale.

## Architecture

```
Browser / PWA  ──  SvelteKit 5 + Tailwind 4 SPA (ui/)
      │             task list · status lights · xterm.js pane · TODO + Issues panels
      │  REST + WebSocket (PTY bytes, live events)
Shepherd core  ──  Bun + TypeScript (src/)
      │             spawns/steers claude via herdr · bridges PTY → browser · SQLite session store
      ▼
   herdr  ──  owns the real claude PTYs (sessions survive a core restart)
```

- **Backend** (`src/`): Bun/TS HTTP + WebSocket server. Sessions persisted in SQLite
  (`~/.shepherd/shepherd.db`); `herdr` owns the PTYs so sessions reconcile on restart.
- **Frontend** (`ui/`): SvelteKit 5 SPA (static adapter), served from `ui/build` by the core.
- **PTY bridge**: `node-pty` is broken under Bun, so the PTY attaches in a Node helper subprocess
  (`src/pty-attach.mjs`) — never import `node-pty` from Bun.

## Requirements

- [Bun](https://bun.sh) — backend runtime + package manager
- `herdr` on `PATH` — manages the interactive `claude` panes (owns the PTYs)
- The `claude` CLI, logged in with your Max/Pro subscription
- Node.js — for the PTY helper subprocess
- _(optional)_ A local [Ollama](https://ollama.com) for auto-naming sessions (falls back gracefully)

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

Open <http://localhost:7330>. To expose it (e.g. via Tailscale), set `SHEPHERD_ALLOWED_HOSTS` to
include the public hostname (see below).

## Configuration

All via environment variables (`src/config.ts`):

| Variable                 | Default                               | Purpose                                                                         |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| `SHEPHERD_PORT`          | `7330`                                | HTTP/WS listen port                                                             |
| `SHEPHERD_HOST`          | `127.0.0.1`                           | Bind address; loopback-only by default (set `0.0.0.0` to expose all NICs)       |
| `SHEPHERD_DB`            | `~/.shepherd/shepherd.db`             | SQLite session store path                                                       |
| `SHEPHERD_REPO_ROOT`     | `~/Work`                              | Repos must live under this root (spawn is confined to it)                       |
| `SHEPHERD_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,[::1]`       | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard)     |
| `SHEPHERD_TOKEN`         | _(none)_                              | When set, require `Authorization: Bearer <token>`                               |
| `HERDR_BIN`              | `herdr`                               | Path to the herdr binary                                                        |
| `HERDR_SESSION`          | `default`                             | herdr session name                                                              |
| `SHEPHERD_NAMER_MODEL`   | `mistral-small3.1:latest`             | Ollama model used to name sessions                                              |
| `OLLAMA_URL`             | `http://localhost:11434/api/generate` | Ollama endpoint                                                                 |
| `SHEPHERD_FORGES`        | `~/.shepherd/forges.json`             | Path to the git-host config (see [Git host integration](#git-host-integration)) |

### Git host integration

The Viewport header shows a contextual git rail — **Open PR → Merge → Redeploy** —
that works against GitHub, Gitea, and Forgejo. Actions use your **git-host**
credentials, never your Claude subscription, so they don't touch the ToS model.

- **GitHub** works out of the box via the `gh` CLI (must be installed and
  authenticated: `gh auth login`). No config entry is required for PR/merge — add
  one only to enable Redeploy or override the merge method.
- **Gitea / Forgejo** (and GitHub Enterprise) need an entry in `~/.shepherd/forges.json`,
  keyed by the remote host. The host is auto-detected from the repo's `origin` remote.

```jsonc
{
  // self-hosted Gitea/Forgejo — issues, PR, merge, redeploy
  "git.example.com": {
    "type": "gitea", // "gitea" (covers Forgejo) or "github"
    "baseUrl": "https://git.example.com", // API base (include :port if non-standard)
    "token": "<personal-access-token>", // repo + actions scopes
    "deployWorkflow": "deploy.yaml", // workflow_dispatch file for Redeploy (optional)
    "mergeMethod": "squash", // squash | merge | rebase (default: squash)
  },
  // github.com entry is OPTIONAL — only needed to enable Redeploy
  "github.com": { "deployWorkflow": "deploy.yml" },
}
```

Notes:

- The file holds a token in plaintext — `chmod 600 ~/.shepherd/forges.json`.
- A missing or malformed file is non-fatal: GitHub PR/merge still work via `gh`;
  self-hosted hosts simply show no rail.
- Merge deletes the head branch by default. Redeploy targets the session's base
  branch and requires `deployWorkflow` (the host's CI must support
  `workflow_dispatch`).

### Submitting tasks from external agents

The HTTP API the UI uses is open to any client that can reach the core — no
separate endpoint or CORS exception is required. Agents like Hermes can queue
work via `POST /api/sessions`. See [docs/external-task-api.md](docs/external-task-api.md).

## Development

```bash
# backend (Bun) — note the scoped path; never run a bare `bun test` at the root
bun run test          # bun:test, scoped to ./test
bun run lint          # eslint
bunx tsc --noEmit     # type-check (strict; checks ui/ too)

# frontend (ui/)
cd ui
bun run check         # svelte-check
bun run test          # vitest
bun run build         # production SPA build
```

Prettier + ESLint run on commit via husky + lint-staged. After UI changes, rebuild `ui/build` and
restart the core (it serves the SPA statically).

## Deployment

Shepherd runs as a **systemd user service** (as your own user, so it keeps your `claude`
subscription login, `~/Work`, herdr, and ollama). It binds to **loopback only**
(`SHEPHERD_HOST=127.0.0.1`); reach it over the network by putting it behind a trusted proxy —
e.g. Tailscale:

```bash
tailscale serve --bg 7330        # → https://<host>.<tailnet>.ts.net proxies to 127.0.0.1:7330
```

Add the public hostname to `SHEPHERD_ALLOWED_HOSTS` (the unit ships with the Tailscale name).
Access control is **tailnet membership** — there is no app-level password.

Install the unit (`deploy/shepherd.service`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/shepherd.service ~/.config/systemd/user/
loginctl enable-linger "$USER"          # start at boot without an active login
systemctl --user daemon-reload
systemctl --user enable --now shepherd
```

Operate it:

```bash
systemctl --user status shepherd
journalctl --user -u shepherd -f        # unit lifecycle; app log: ~/.shepherd/shepherd.log
```

### Shipping a code change

The unit runs straight from the working tree, so **whatever is checked out is what runs**. To
deploy local changes in one shot (install deps → build UI → restart → health check):

```bash
bun run update          # deploy the current working tree (warns if dirty / off main)
bun run update --pull   # fast-forward main from origin first (skip on a dev==prod box)
```

It's idempotent and safe to re-run — sessions survive the restart (herdr owns the PTYs). UI-only
changes don't strictly need it: a fresh `cd ui && bun run build` is served on the next request,
since the core reads `ui/build` from disk per request.

Per-deployment overrides (token, repo root, alternate hosts) go in `~/.shepherd/env`
(`KEY=value` lines), read by the unit if present.

## Project layout

```
src/                backend (Bun/TS)
  index.ts          entry: wires store, herdr, service, poller, server
  server.ts         HTTP + WebSocket routing (REST API, static SPA, /pty, /events)
  service.ts        session lifecycle (create → worktree → herdr spawn → store)
  herdr.ts          herdr CLI driver
  usage.ts          per-session token parse + account-wide JSONL index
  usage-limits.ts   /usage parsing, cap calibration, live 5h/weekly % recompute
  usage-probe.ts    drives an ephemeral interactive claude to scrape `/usage`
  pricing.ts        internal per-model weights for the limit-% math (not displayed)
  worktree.ts       per-task git worktrees
  branches.ts       local-branch listing (New Task base-branch dropdown)
  repos.ts          repo discovery + per-repo TODO.md read/write
  forge/            platform-agnostic git host layer (issues, PR, merge, redeploy)
    index.ts          detectForge factory (origin remote + forges.json → GitForge)
    github.ts         GithubForge (gh CLI) · gitea.ts  GiteaForge (Gitea/Forgejo REST)
    remote.ts         remote-URL parser · checks.ts  worst-of CI rollup
    load-config.ts    reads ~/.shepherd/forges.json
  pty-bridge.ts     PTY ↔ WebSocket bridge
  pty-attach.mjs    Node helper that owns node-pty (Bun can't)
  store.ts          SQLite session store
  poller.ts         polls herdr agent status → live events
  reconcile.ts      reattach to surviving herdr sessions on boot
  validate.ts       request validation, path confinement, auth/origin guards
ui/                 SvelteKit 5 SPA (built to ui/build)
test/               backend bun:test suites
docs/superpowers/   design specs + implementation plans (v1–v5)
PRD.md              product vision + ToS-compliance model (source of truth)
TODO.md             roadmap / status
```

## Status

Core through the v5 responsive mobile HUD is shipped: spawn → live PTY → browser, status lights,
persistence/resume, repo + branch pickers, per-repo TODO sync, issue prompt sources (GitHub +
Gitea/Forgejo), platform-agnostic git host buttons (open PR / merge / redeploy),
per-session model picker, session decommission, and real usage tracking (per-session token counts +
account-wide 5h/weekly limit gauges from `~/.claude` JSONL). See `TODO.md` for the open backlog and
`PRD.md` for the full feature set and roadmap.

### Usage tracking

Sessions are spawned with `claude --session-id <uuid>`, so each TASK maps deterministically to its
`~/.claude/projects/<cwd>/<uuid>.jsonl`; the Viewport shows live per-session token counts parsed
from it. The TopBar's 5h/weekly gauges are calibrated once a day by scraping `claude /usage` (driven
through an ephemeral interactive session — ToS-pure, no `-p`) to learn the plan ceilings, then the
`%` is recomputed live from local JSONL between calibrations. No dollar figures (you're on a
subscription); pricing is used only internally as relative weights for the limit math. Override the
JSONL location with `CLAUDE_CONFIG_DIR` or `CLAUDE_PROJECTS_DIR` if non-default.

## License

[Apache-2.0](./LICENSE) © 2026 Erwins Enkel GmbH
