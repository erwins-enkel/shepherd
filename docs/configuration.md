# Server configuration and integrations

[← Shepherd](../README.md) · [Install](getting-started.md) · [Configuration](configuration.md) · [Operations](operations.md) · [Development](development.md)

Commands use the repository root as the working directory unless noted otherwise.

[Configuration](#configuration)

## Configuration

All via environment variables (`src/config.ts`):

| Variable                           | Default                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SHEPHERD_PORT`                    | `7330`                          | HTTP/WS listen port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SHEPHERD_HOST`                    | `127.0.0.1`                     | Bind address; loopback-only by default (set `0.0.0.0` to expose all NICs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SHEPHERD_AGENT_INGRESS_PORT`      | `SHEPHERD_PORT + 1` (e.g. 7331) | Pinned loopback port for the auth-exempt agent-ingress listener (hook + agent control-plane callbacks: the build-queue/epic-draft routes and the per-session MCP endpoint). Stable so the URL baked into a live agent survives restarts/deploys; must not collide with the main port, served port, or preview range (validated at startup). Set `0` for an ephemeral port (pre-#1083 behavior).                                                                                                                                                                                                                                                        |
| `SHEPHERD_DB`                      | `~/.shepherd/shepherd.db`       | SQLite session store path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SHEPHERD_REPO_ROOT`               | `~` (home)                      | Repos must live under this root (spawn is confined to it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SHEPHERD_ALLOWED_HOSTS`           | `localhost,127.0.0.1,::1,[::1]` | Comma-separated origin hostnames allowed for writes + WS (CSRF/CSWSH guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SHEPHERD_PASSWORD`                | _(auto-generated)_              | Single-operator login password. When set, it is authoritative and re-seeded into the persisted password hash every boot. Unset → Shepherd reuses the persisted hash, or on first boot generates a strong password, stores its hash, and prints the password to the server log **once**. Browser operators exchange it for a signed session cookie.                                                                                                                                                                                                                                                                                                     |
| `SHEPHERD_COOKIE_SECRET`           | _(generated + persisted)_       | HMAC secret that signs the browser session cookie. Set it to keep sessions stable across DB resets; rotating it invalidates every outstanding browser session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SHEPHERD_TOKEN`                   | _(none)_                        | Optional bearer for CLI/curl/machine clients. When set, `Authorization: Bearer <token>` is accepted as an alternative to the browser session cookie; spawned agents use the loopback ingress instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `HERDR_BIN`                        | `herdr`                         | Path to the herdr binary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `HERDR_SESSION`                    | `default`                       | herdr session name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SHEPHERD_FORGES`                  | `~/.shepherd/forges.json`       | Path to the git-host config (see [Git host integration](#git-host-integration))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SHEPHERD_PREVIEW_PORT_BASE`       | `8001`                          | First port in the live-preview range (each agent's preview gets one port)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SHEPHERD_PREVIEW_PORT_COUNT`      | `16`                            | Size of the preview range and maximum concurrent previews                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SHEPHERD_PREVIEW_SWEEP_MS`        | `4000`                          | Cadence (ms) of the dev-port detection sweep across active sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SHEPHERD_PREVIEW_AUTO_SERVE`      | `true`                          | Dynamically register/unregister `tailscale serve` mappings as previews bind/tear down; set `0` to map the range manually                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SHEPHERD_PREVIEW_IDLE_STOP_MS`    | `0` (disabled)                  | When > 0, a previewed dev server with no proxy traffic for this many ms whose agent is also idle is stopped (SIGTERM→SIGKILL) to reclaim RAM; no auto-wake (restart manually); suggested value `1800000` (30 min). "No traffic" counts only requests through the preview proxy — an idle agent hitting its own `localhost:<port>` directly is not seen, but the idle/done gate keeps it from firing on a server the agent is actively using. Only the process listening on the dev port is killed (the RAM-heavy bundler/server, so most memory is freed); a lightweight parent wrapper like `npm run dev` may linger until the agent's shell reaps it |
| `SHEPHERD_TRIM_AUTO_CONTEXT`       | `true`                          | Trim the per-turn context of auto-spawned (drain) agents: every optional plugin, Claude Code's bundled skills, and your personal `~/.claude/skills` are disabled per-spawn — catalogs an unattended agent never invokes. The Skill tool and the session repo's own `.claude/skills/` stay available. Interactive sessions are untouched. Set `false`/`0`/`off` as the escape hatch if drain quality regresses                                                                                                                                                                                                                                          |
| `SHEPHERD_SANDBOX_DEFAULT_PROFILE` | `trusted`                       | Default sandbox profile applied to every spawned agent unless overridden per-repo in Settings. `trusted` = no sandbox (today's behavior); `standard` = filesystem/process membrane (see below); `autonomous` = same membrane, required for `auto=true` drain/autopilot sessions. Set to `standard` or `autonomous` to sandbox all agents by default                                                                                                                                                                                                                                                                                                    |

### Per-agent sandbox / permission profiles

Shepherd can wrap each spawned `claude` process in an OS-level filesystem/process sandbox via **bubblewrap (`bwrap`)**. Three profiles are available and selectable per-repo in the repo's Settings panel or globally via `SHEPHERD_SANDBOX_DEFAULT_PROFILE`:

| Profile      | Sandbox                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trusted`    | None                                  | Default; today's behavior. Use as an escape hatch when the membrane causes problems.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `standard`   | bwrap membrane                        | Agent confined to its worktree + git object store + read-only `~/.claude`; blocks `~/.ssh`, `~/.aws`, sibling repos, and other `$HOME` dotfiles, and clears inherited env secrets; no privilege escalation. (The `gh` and `claude` auth tokens it needs stay readable, and `standard` does **not** restrict network egress — see the egress note below.) Opt-in for interactive sessions.                                                                                                                                                                                                                                                                 |
| `autonomous` | bwrap membrane **+ egress allowlist** | Same filesystem/process membrane as `standard`, **plus** network-egress confinement — outbound is restricted to an allowlist (Anthropic + the forge host + operator extras), all other outbound blocked; this is the defining difference from `standard`. Egress is tied to the **profile**, not to `auto=true`: interactive `autonomous` sessions are confined too, degrading to unrestricted egress with an operator-visible banner if the netns backend is missing, while `auto=true` (drain/autopilot) spawns are refused outright without it. **Required for `auto=true` sessions** — Shepherd refuses to auto-spawn an agent with a weaker profile. |

**Network egress is allowlist-confined for the `autonomous` profile** — shipped in [PR #601](https://github.com/erwins-enkel/shepherd/pull/601), which closed [#551](https://github.com/erwins-enkel/shepherd/issues/551). An `autonomous` agent runs inside a rootless network namespace where dnsmasq resolves **only** allowlisted domains (pinning the resolved IPs into an nftables set) and nft rejects all other outbound. The allowlist is `api.anthropic.com` + `statsig.anthropic.com`, the GitHub well-known hosts (`github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `uploads.github.com`) when a GitHub forge is configured or none is configured at all (Shepherd's default), each configured forge's own host (a Gitea/Forgejo-only config gets its host, not GitHub's), and operator extras. This is profile-tied, not `auto=true`-tied: interactive `autonomous` sessions are confined too, degrading to unrestricted egress **with an operator-visible banner** when the netns backend is missing, while `auto=true` (drain/autopilot) spawns are _refused_ outright without it. `standard` is **not** egress-confined — it stays filesystem-confined only, outbound open. The membrane still keeps the `~/.config/gh` token and `~/.claude` OAuth credentials readable (the agent needs them to push and to talk to Anthropic), but under `autonomous` that readability is now **defence-in-depth**, not an open exfil channel: outbound can no longer reach an arbitrary host. One honest residual remains — wherever a forge host is allowlisted (GitHub by default), a hijacked `autonomous` agent could still push to an attacker-controlled repo on that host; and `standard` keeps the original unrestricted-egress exposure. See [`docs/sandbox-security.md`](sandbox-security.md) for the full residual posture — the accepted in-membrane token-readability gap (R3) and the prompt-injection posture incl. the deliberately egress-unconfined research surface (R4).

**Backend requirements:** `bwrap` must be installed and unprivileged user namespaces must be enabled on the host. Shepherd runs a self-test at startup; when no sandbox backend is available, manually spawned sessions degrade to unconfined **with an operator-visible banner**, and `auto=true` spawns are refused until a capable host is used.

**Known constraints:**

- SSH-remote repos cannot `git push` from inside the membrane (the `~/.ssh` key dir is excluded). Use an HTTPS remote with the `gh` token instead.
- MCP servers whose dependencies live outside the bound `$HOME` paths (e.g. a server installed in an arbitrary prefix) may fail to load inside the membrane.
- The membrane relies on **OAuth/subscription auth** (`~/.claude/.credentials.json`, which it binds) in the default **subscription mode**. `--clearenv` deliberately strips `ANTHROPIC_API_KEY` (and all other env), so a `claude` install that authenticates purely via that env var rather than OAuth will fail to authenticate inside `standard`/`autonomous`. In **api-key mode** (Settings → Session) this is reversed: the membrane instead masks the subscription credential with an empty overlay and injects the key via an `apiKeyHelper` script bound into the sandbox — the key is never passed as a raw env var.

The membrane bind set is **host-derived** — Shepherd probes the node/claude install locations and `gh`/gitconfig paths at startup and uses `--bind-try` for optional paths, so no hardcoded path list needs maintenance.

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

### Forking a repo to contribute upstream

To contribute to a GitHub project you don't have write access to, use **Fork a
GitHub repo** in the repo picker (next to _Clone_). Paste `owner/repo` (or a URL);
Shepherd runs `gh repo fork --clone`, which forks it under your account and sets
up the standard topology: **`origin` = your fork**, **`upstream` = the original**.

In this fork mode Shepherd is **upstream-aware**: issues, the PR list, checks, and
the backlog all read from the **upstream** repo (the issues you'd work on, your
upstream PRs), branches push to your **fork**, and a **PR you open targets the
upstream** with its head on your fork (`<you>:<branch>`).

Requires `gh auth login`. The fork is a real, persistent repo on your GitHub
account — Shepherd does not remove it.

**Keep the fork current:** fork rows in the repo picker carry a **⟲ Sync** button.
It runs `gh repo sync` to fast-forward your fork's default branch from upstream and
updates the local clone, so a fresh PR branch starts from current upstream rather
than a stale base. If your fork's default branch has diverged (commits not on
upstream), the sync is declined rather than discarding them — reconcile it on
GitHub.

v1 limitations on a fork (surfaced, not silent — they return GitHub's permission
error if attempted): maintainer-side actions you don't have rights for —
**merging** the upstream PR (the maintainer does that), re-running upstream CI,
renaming upstream branches, requesting reviewers — and **epic / multi-branch**
orchestration.

### Submitting tasks from external agents

The HTTP API the UI uses is open to any client that can reach the core — no
separate endpoint or CORS exception is required. Agents like Hermes can queue
work via `POST /api/sessions`. See [docs/external-task-api.md](external-task-api.md).

### Server-side plugins

Private, out-of-repo extensions can run **in-process** inside the server — loaded at boot
from `~/.shepherd/plugins/` (override `SHEPHERD_PLUGINS_DIR`), so they survive redeploys and
never enter the public repo. A plugin reaches core only through a versioned `ctx` seam
(`onSpawn`, read-only events, scoped state, HTTP routes, status panel), and a missing dir is
a clean no-op. See [docs/plugins.md](plugins.md) for the manifest schema, the `ctx` API,
and the `onSpawn` contract. Plugin secrets (`ctx.secrets`) live in `~/.shepherd/plugin-secrets.json` (mode 0600;
override `SHEPHERD_PLUGIN_SECRETS`).
