# Architecture and development

[← Shepherd](../README.md) · [Install](getting-started.md) · [Configuration](configuration.md) · [Operations](operations.md) · [Development](development.md)

Commands use the repository root as the working directory unless noted otherwise.

[Architecture](#architecture) · [Development](#development) · [Project layout](#project-layout) · [Opinionated by design](#opinionated-by-design) · [ToS compliance model](#tos-compliance-model) · [Your `/commands` come with you](#your-commands-come-with-you) · [Status](#status) · [Usage tracking](#usage-tracking)

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
```

## Opinionated by design

Running many agents is the easy half; keeping their output shippable is the actual product.
Shepherd institutionalizes the practices a careful team would otherwise have to enforce by hand,
as per-repo automation:

- **Readiness** — Shepherd scores a JS/TS repo's guardrails (typecheck, lint, tests, CI, house
  rules) before you point agents at it, and prescribes the gaps as setup tasks you seed with a click.
- **Plan gate** — before an autonomous run, the agent writes a plan and a separate read-only
  reviewer grills it adversarially; only a plan that survives review is released to implement.
- **Critic** — the moment a PR's CI goes green, an isolated read-only agent reviews the full diff
  and posts a verdict; with Auto-Address on, findings flow back to the authoring agent until the
  list comes back empty.
- **Learnings** — Shepherd distills past sessions' failure signals into proposed house rules; the
  ones you approve are injected into every new agent in the repo, so lessons compound instead of
  repeating.
- **Merge train** — a finished PR lands only when it is open, CI-green, conflict-free, and up to
  date with the base branch; one that has fallen behind is sent back to its agent to rebase, and
  CI and the critic re-run before it can land.
- **Hygiene gates** — CI and the pre-push hook enforce linear branches, locale-catalog parity,
  feature-catalog completeness, and a dead-code/complexity audit
  (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

Shepherd's own repo ships behind the same bar. All of it obeys the same constraint as the rest of
the product: it works by observing and typing into real terminals — see the compliance model in this guide.

## ToS compliance model

This is the defining constraint, not a footnote. Shepherd runs on the operator's own Claude
subscription, so it **only drives interactive terminal sessions** — it never uses the Agent SDK or
`claude -p`. It observes (reads the terminal + agent status) and steers (injects keystrokes into the
live pane). Auth is the operator's own login; no token relay, no impersonation, single operator.

The Codex CLI (alpha) is driven the same way — a genuine interactive terminal session, never a
headless or scripted invocation.

If a feature can't be done by typing into a real terminal, it doesn't ship. See `PRD.md` for the
full rationale.

Operators who prefer a clearly-compliant path can opt into **API-key auth** in Settings
→ Session. In this mode Shepherd still drives genuine interactive `claude` sessions (NOT `claude -p`
/ Agent SDK); only the auth changes from subscription OAuth to a metered Anthropic API key under the
Commercial Terms, which explicitly permits automated use and is no-train-by-default.

## Your `/commands` come with you

Because Shepherd attaches to a **genuine interactive `claude` session** running against your own
`~/.claude`, every slash command you already use locally is available — your project and user
commands, installed plugins, skills, and the relevant built-ins. The cloud Claude Code (web at
claude.ai/code, the mobile app) runs in a managed environment that doesn't carry your local command
setup, so this surface simply isn't there.

The New Task prompt makes it first-class: type `/` at the start and a filtered dropdown of your
actual commands appears (the same index the Commands tab uses), each row showing its
`argument-hint` and source (project · user · plugin · builtin). Arrow keys + Enter/Tab to pick, Esc
to close — so you don't switch tabs or memorize names. It's the full local Claude Code experience,
driven from your browser or phone.

## Status

Actively developed and run in production by its authors. Shipped: the interactive core (spawn →
live PTY → browser, status lights, persistence/resume, repo + branch + model pickers, per-repo TODO
sync, issue intake and git-host actions for GitHub and Gitea/Forgejo, usage tracking); the
automation suite (Plan gate, Critic, Autopilot, Auto-drain, Merge train, Build queue); Learnings;
Readiness; live previews of agents' dev servers; and a browser capture extension that turns a page
into a spawned session or filed issue — now on the [Chrome Web Store][capture]. See the
[GitHub issues][issues] for the open backlog,
[Discussions][discussions] for questions and ideas, and `PRD.md` for the full feature set and
roadmap.

[issues]: https://github.com/erwins-enkel/shepherd/issues
[discussions]: https://github.com/erwins-enkel/shepherd/discussions
[capture]: https://chromewebstore.google.com/detail/shepherd-capture/liknmighjkhplpbocaefaljokofaifgi

## Usage tracking

Sessions are spawned with `claude --session-id <uuid>`, so each TASK maps deterministically to its
`~/.claude/projects/<cwd>/<uuid>.jsonl`; the Viewport shows live per-session token counts parsed
from it. The TopBar's 5h/weekly gauges are calibrated once a day by scraping `claude /usage` (driven
through an ephemeral interactive session — ToS-pure, no `-p`) to learn the plan ceilings, then the
`%` is recomputed live from local JSONL between calibrations. No dollar figures (you're on a
subscription); pricing is used only internally as relative weights for the limit math. Override the
JSONL location with `CLAUDE_CONFIG_DIR` or `CLAUDE_PROJECTS_DIR` if non-default.
