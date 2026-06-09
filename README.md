# Shepherd

> Self-hosted mission control for **interactive** Claude Code — and opinionated about how
> agent-built software should ship. Spawn, watch, and steer a herd of real `claude` sessions from
> your browser or phone, with best-practice guardrails — plan gate, adversarial review, house
> rules, merge train — built in. On your own server, on your own subscription.

Shepherd spawns genuine interactive `claude` sessions in isolated git worktrees (via `herdr`, the
interactive-pane manager), bridges each PTY to an `xterm.js` pane in the browser, and lets one
operator run many agents in parallel — observing their status and steering them by typing, exactly
like a human at a terminal. Around those sessions it builds in the engineering discipline that
parallel agent work otherwise erodes: plans are challenged before agents run, PRs are reviewed
before a human sees them, and nothing merges without a rebase and re-verification.

> The repo directory is `tank/` for historical reasons; the product is **Shepherd**.

## Opinionated by design

Running many agents is the easy half; keeping their output shippable is the actual product.
Shepherd institutionalizes the practices a careful team would otherwise have to enforce by hand,
as built-in, per-repo automation:

- **Plan gate** — before an autonomous run, the agent writes a plan and a separate read-only
  reviewer grills it adversarially; only a plan that survives the rounds is released to implement.
- **Critic** — the moment a PR's CI goes green, an isolated read-only agent reviews the full diff
  and posts a verdict; with Auto-Address on, findings flow back to the authoring agent until the
  list comes back empty.
- **Learnings** — Shepherd distills past sessions' failure signals into proposed house rules; the
  ones you approve are injected into every new agent in the repo, so lessons compound instead of
  repeating.
- **Merge train** — a finished PR lands only when it is open, CI-green, conflict-free, and up to
  date with the base branch; one that has fallen behind is rebased and fully re-verified first.
- **Hygiene gates** — Shepherd's own repo ships behind the same bar: CI and the pre-push hook
  enforce linear branches, locale-catalog parity, feature-catalog completeness, and a
  dead-code/complexity audit (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
- **Readiness** — scores a JS/TS repo's guardrails (typecheck, lint, tests, CI, house rules)
  before you point agents at it, and turns the gaps into an install task.

All of it obeys the same constraint as the rest of the product: it works by observing and typing
into real terminals — see the compliance model below.

## ToS compliance model

This is the defining constraint, not a footnote. Shepherd runs on the operator's own Claude
subscription, so it **only drives interactive terminal sessions** — it never uses the Agent SDK or
`claude -p`. It observes (reads the terminal + agent status) and steers (injects keystrokes into the
live pane). Auth is the operator's own login; no token relay, no impersonation, single operator.

If a feature can't be done by typing into a real terminal, it doesn't ship. See `PRD.md` for the
full rationale.

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

| Variable                      | Default                         | Purpose                                                                                                                  |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SHEPHERD_PORT`               | `7330`                          | HTTP/WS listen port                                                                                                      |
| `SHEPHERD_HOST`               | `127.0.0.1`                     | Bind address; loopback-only by default (set `0.0.0.0` to expose all NICs)                                                |
| `SHEPHERD_DB`                 | `~/.shepherd/shepherd.db`       | SQLite session store path                                                                                                |
| `SHEPHERD_REPO_ROOT`          | `~` (home)                      | Repos must live under this root (spawn is confined to it)                                                                |
| `SHEPHERD_ALLOWED_HOSTS`      | `localhost,127.0.0.1,::1,[::1]` | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard)                                              |
| `SHEPHERD_TOKEN`              | _(none)_                        | When set, require `Authorization: Bearer <token>`                                                                        |
| `HERDR_BIN`                   | `herdr`                         | Path to the herdr binary                                                                                                 |
| `HERDR_SESSION`               | `default`                       | herdr session name                                                                                                       |
| `SHEPHERD_FORGES`             | `~/.shepherd/forges.json`       | Path to the git-host config (see [Git host integration](#git-host-integration))                                          |
| `SHEPHERD_PREVIEW_PORT_BASE`  | `8001`                          | First port in the live-preview range (each agent's preview gets one port)                                                |
| `SHEPHERD_PREVIEW_PORT_COUNT` | `16`                            | Size of the preview range and maximum concurrent previews                                                                |
| `SHEPHERD_PREVIEW_SWEEP_MS`   | `4000`                          | Cadence (ms) of the dev-port detection sweep across active sessions                                                      |
| `SHEPHERD_PREVIEW_AUTO_SERVE` | `true`                          | Dynamically register/unregister `tailscale serve` mappings as previews bind/tear down; set `0` to map the range manually |

A few runtime toggles live in the SQLite `settings` table (`~/.shepherd/shepherd.db`) rather than env:

- **`branchPruneEnabled`** — hourly cleanup of local `shepherd/*` branches whose PR has merged (squash-merges defeat the at-archive ancestry prune, so they otherwise accumulate). **On by default**; disable with
  ```sh
  sqlite3 ~/.shepherd/shepherd.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('branchPruneEnabled', '0')"
  ```

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
subscription login, `~/Work`, and herdr). It binds to **loopback only**
(`SHEPHERD_HOST=127.0.0.1`); reach it over the network by putting it behind a trusted proxy —
e.g. Tailscale:

```bash
tailscale serve --bg 7330        # → https://<host>.<tailnet>.ts.net proxies to 127.0.0.1:7330
```

Add the public hostname to `SHEPHERD_ALLOWED_HOSTS` (the unit ships with the Tailscale name).
Access control is **tailnet membership** — there is no app-level password.

### Live preview

When an agent's dev server is listening in its worktree, a **Preview** badge appears on its herd
row. Clicking it opens the running app in an in-HUD Preview pane, reachable from desktop or phone
through Tailscale. Shepherd detects the port automatically (frontend servers like Vite/SvelteKit
take priority) and proxies HTTP and WebSocket (HMR) traffic through a dedicated loopback listener.
Shepherd never starts or stops the agent's dev server — it is detect-and-proxy only.

**Declaring the preview port explicitly:** A project or agent can drop a file named `.shepherd-preview`
in the repo/worktree root containing a single bare port number (e.g. `3000`). Shepherd uses it
only when that port is actually listening and answers HTTP — a stale or wrong hint self-heals by
falling back to automatic detection. Useful for multi-listener apps or apps on uncommon ports. The
file is optional; Shepherd is detect-and-proxy only regardless.

**Routing: one port per agent, distinct origin.** Each preview is served on its own port
(`SHEPHERD_PREVIEW_PORT_BASE`..+`COUNT`) via `tailscale serve`. Because each preview is a distinct
web origin (`https://host.ts.net:8001` ≠ `https://host.ts.net:8002` ≠ the HUD at `:443`), the
agent's own app fetches (reads, writes, storage, HMR) are same-origin and work without any path
rewriting. The HUD's origin check rejects preview-port origins for state-changing requests, so a
previewed app cannot forge `/api` calls.

**Tailscale exposure is automatic and dynamic** (default on — `SHEPHERD_PREVIEW_AUTO_SERVE`, set `0`
to opt out). As each preview listener binds a slot, Shepherd registers a
`tailscale serve --bg --https=<port> 127.0.0.1:<port>` mapping for it and removes it on teardown —
zero operator setup, and only in-use ports are exposed. Stale mappings are cleared at startup and on
shutdown. Prerequisites: tailnet HTTPS certificates enabled, and the service's user set as the
Tailscale operator (`tailscale set --operator=$USER`) so it can run `tailscale serve` without sudo.
When the node's tailnet host can't be resolved (tailscale absent/down), Shepherd skips registration
and logs a warning — previews still work on loopback.

To map the range manually instead, set `SHEPHERD_PREVIEW_AUTO_SERVE=0` and run the loop once:

```bash
for p in $(seq 8001 8016); do tailscale serve --bg --https=$p 127.0.0.1:$p; done
```

> **Funnel vs Serve:** the 443/8443/10000 port restriction applies to **Funnel** only. `tailscale serve`
> (tailnet-internal) accepts arbitrary HTTPS ports — the snippet above uses that.
> **Never add the preview slot range (8001–8016) to a Tailscale Service's advertised port list.**
> A Service requires every member host to advertise all listed ports; ephemeral preview ports
> would silently drop the node from rotation and take the HUD down.

**Split-front / `previewHost`:** the preview iframe URL is built from the **agent node's own
tailnet hostname** (server-reported `previewHost`), not the operator's connection host. This means
the preview works when the HUD is fronted under a different Tailscale identity than the agent node
— e.g. a Tailscale Service `svc:shepherd` at `:443` while agents run on `backontop`. The slot is
served at the node, so the iframe correctly targets `https://backontop.<tailnet>.ts.net:<port>`
rather than the Service address. On localhost dev and single-host tailnets behavior is unchanged.

**Scope / precondition:** the operator's browser must be on the tailnet, and tailnet ACLs must
permit operator→agent-node traffic on the slot ports. This does **not** help a Funnel /
public-fronted HUD — the agent node's MagicDNS hostname is unresolvable off-tailnet.

**Startup validation:** Shepherd hard-fails at startup if the configured preview range overlaps the
HUD's local listen port (`SHEPHERD_PORT`, default 7330) or its public served port (443). Choose a
range that does not conflict.

**Security:** previews run on a distinct origin, behind the same Tailscale gate. The `checkOrigin`
guard explicitly rejects any request origin whose port falls in the preview range, even when the
hostname is allowlisted — closing the blind-mutation vector. The preview `<iframe>` is sandboxed
`allow-same-origin allow-scripts …` (everything the app needs to run) but withholds every
`allow-top-navigation*` token, so untrusted agent JS can't redirect the operator's HUD tab.
Residual: cookies are host-scoped
(shared across ports on one host), which is acceptable because the HUD has no cookie auth. Full
per-origin cookie isolation is tracked in [#398](https://github.com/erwins-enkel/shepherd/issues/398).

**Caveats:**

- **Blank pane?** With auto-registration on (the default), a failed `tailscale serve` registration
  shows a degraded (amber) Preview badge and a note in the pane — the app is still reachable on
  loopback, so use the **Open in new tab** link. (With `SHEPHERD_PREVIEW_AUTO_SERVE=0`, ensure the
  port is mapped manually.)
- **App refuses to frame?** Some apps emit a `frame-ancestors` CSP via an in-HTML `<meta>` tag
  (SvelteKit can do this); response-header stripping cannot remove it. Use the **Open in new tab**
  link — safe because the preview runs on its own origin, not the HUD's.
- **HMR not updating?** Some dev servers (e.g. Vite) hardcode the HMR WebSocket port. Set
  `hmr.clientPort` in the app's Vite config to the preview port Shepherd assigned. Page-load and
  manual refresh always work regardless.

**Follow-ups:** multi-port apps (#396), idle-stop (#399), subdomain/full isolation (#398).

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

## Sharing a repo's queue across people

Several people can drive the same repo's auto-drain queue together, each on their own Claude
subscription. This is the multi-person form of the ToS model above — not one shared account but N
independent single-operator instances, each running against its own `~/.claude` login (no token
relay, no impersonation). The shared git-host repo is the only thing in common; the `shepherd:active`
label keeps two instances off the same issue.

How the work splits: each instance drains greedily up to its own `maxAuto` and `usageCeilingPct`,
claiming issues first-come by polling timing (whoever pumps first stamps `shepherd:active` first).
It is not a capacity-weighted load balancer — below the ceiling, issues split by when each instance
happens to poll, not by who has more headroom. `usageCeilingPct` is a hard per-operator stop: an
instance that hits its ceiling stops spawning and leaves the rest to the others. So "Patrick is at
80%, Kai isn't" just means Patrick's ceiling stops his instance (or he turns auto-drain off) and
Kai's keeps pulling up to Kai's own ceiling — nobody lends capacity.

Setup, per person:

1. Run your own instance logged into your own `~/.claude`.
2. Use a separate `~/.claude` login (in practice: a separate machine or `HOME`). Usage is scraped
   locally from `~/.claude` (`src/usage.ts`), so two instances sharing one login see the same usage
   and their ceilings move in lockstep — the per-person hand-off then doesn't work.
3. Register the same repo with auto-drain on and the same `autoLabel` (default `shepherd:auto`),
   pointed at the shared git host (see [Git host integration](#git-host-integration)).
4. Set your own `usageCeilingPct` and `maxAuto`.

Done for the day? Turn auto-drain off (or shut the machine down) and your instance pulls nothing.

Known edge: if two instances grab the exact same issue in the same instant — before either claim is
visible to the other — both can spawn against it (two PRs; a human closes one). A pre-spawn re-check
narrows this to the truly-simultaneous case but does not eliminate it.

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

## Status

Actively developed and run in production by its authors. Shipped: the interactive core (spawn →
live PTY → browser, status lights, persistence/resume, repo + branch + model pickers, per-repo TODO
sync, issue intake and git-host actions for GitHub and Gitea/Forgejo, usage tracking); the
automation suite (Plan gate, Critic, Autopilot, Auto-Drain, Merge train, Build queue); Learnings;
Readiness; live previews of agents' dev servers; and a browser capture extension that turns a page
into a spawned session or filed issue. See the [GitHub issues][issues] for the open backlog and
`PRD.md` for the full feature set and roadmap.

[issues]: https://github.com/erwins-enkel/shepherd/issues

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
