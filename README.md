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

| Variable                 | Default                               | Purpose                                                                     |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------- |
| `SHEPHERD_PORT`          | `7330`                                | HTTP/WS listen port                                                         |
| `SHEPHERD_DB`            | `~/.shepherd/shepherd.db`             | SQLite session store path                                                   |
| `SHEPHERD_REPO_ROOT`     | `~/Work`                              | Repos must live under this root (spawn is confined to it)                   |
| `SHEPHERD_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,[::1]`       | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard) |
| `SHEPHERD_TOKEN`         | _(none)_                              | When set, require `Authorization: Bearer <token>`                           |
| `HERDR_BIN`              | `herdr`                               | Path to the herdr binary                                                    |
| `HERDR_SESSION`          | `default`                             | herdr session name                                                          |
| `SHEPHERD_NAMER_MODEL`   | `mistral-small3.1:latest`             | Ollama model used to name sessions                                          |
| `OLLAMA_URL`             | `http://localhost:11434/api/generate` | Ollama endpoint                                                             |

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

## Project layout

```
src/                backend (Bun/TS)
  index.ts          entry: wires store, herdr, service, poller, server
  server.ts         HTTP + WebSocket routing (REST API, static SPA, /pty, /events)
  service.ts        session lifecycle (create → worktree → herdr spawn → store)
  herdr.ts          herdr CLI driver
  worktree.ts       per-task git worktrees
  branches.ts       local-branch listing (New Task base-branch dropdown)
  repos.ts          repo discovery + per-repo TODO.md read/write
  github.ts         GitHub issues as task prompt sources
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
persistence/resume, repo + branch pickers, per-repo TODO sync, GitHub-issue prompt sources,
per-session model picker, and session decommission. See `TODO.md` for the open backlog and `PRD.md`
for the full feature set and roadmap.
