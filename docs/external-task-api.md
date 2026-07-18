# Submitting tasks from external agents (Hermes & friends)

Shepherd's HTTP API is the same surface the UI uses — there is **no separate
"public" API and no CORS barrier** for non-browser clients. Any agent that can
reach the core process (Hermes, a cron job, another service) can queue work by
calling one endpoint — once it authenticates (the server is gated by default;
see [What actually gates access](#what-actually-gates-access)).

## TL;DR

```bash
curl -X POST http://localhost:7330/api/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SHEPHERD_TOKEN" \   # required — the server is gated by default
  -d '{
        "repoPath": "~/Work/my-repo",
        "baseBranch": "main",
        "prompt": "Add OAuth login to the settings page",
        "model": "opus"
      }'
```

A `201` returns the full session, including its designation (`TASK-07`) and
`id` — the agent spawns immediately on an isolated git worktree. When the
default usage-aware hold gate is active and account usage is high, the
submission is instead **queued** and answered `200 { "held": true, … }`
rather than spawned — see [Usage-aware hold gate](#usage-aware-hold-gate) below.

## Why no new endpoint is needed

Creating a task **is** creating a session. `POST /api/sessions`
(`src/server.ts`) validates the body, spawns the Claude agent on a fresh
worktree, and broadcasts `session:new` to every connected HUD — so a task
submitted by Hermes shows up live in the UI exactly like one a human typed.

### CORS / CSRF does not block programmatic clients

The origin guard (`originAllowed`, `src/validate.ts`) runs **only** for
POST/PUT/DELETE **and only when an `Origin` header is present**:

```ts
if (!originHeader) return true; // no-browser client (curl, CLI, agent)
```

A server-side HTTP client sends no `Origin`, so it passes. The check exists to
stop a malicious **web page** from issuing cross-site writes from a victim's
browser (CSRF/CSWSH); it is not an authentication mechanism and not a wall for
machine clients. If you _do_ send an `Origin` (e.g. a browser-based agent), add
its hostname to `SHEPHERD_ALLOWED_HOSTS`.

## What actually gates access

| Gate                 | Default                                               | What Hermes must do                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Network bind**     | `127.0.0.1:7330` (loopback only)                      | Run on the same host, reach it over Tailscale serve, or set `SHEPHERD_HOST` to expose another NIC                                                                                                                  |
| **Auth**             | Gated by default (operator password → session cookie) | Machine clients can't use the browser login — set `SHEPHERD_TOKEN=<random>` and send `Authorization: Bearer <token>` on every request (timing-safe compare). Without a valid cookie or bearer the request is `401` |
| **Repo confinement** | `SHEPHERD_REPO_ROOT` = `~` (home)                     | `repoPath` must resolve **inside** the root, or the request is rejected `400`                                                                                                                                      |

### Recommended setup for a remote agent

1. Expose the core to the agent's network — prefer **Tailscale serve** over
   `SHEPHERD_HOST=0.0.0.0`. No allowlist step is needed for a Tailscale-served
   HUD: Shepherd folds every host `tailscale serve status` shows fronting its
   port (the node's own tailnet name and any Tailscale Service front) into
   `SHEPHERD_ALLOWED_HOSTS` at startup. Add a hostname manually only for a
   browser-based agent (one that sends `Origin`) reaching Shepherd through a
   **non-Tailscale** proxy or custom-DNS front.
2. Set a shared secret: `SHEPHERD_TOKEN=<random>` and give it to Hermes. The
   server is **gated by default**, and machine clients can't use the browser
   password login — the bearer token is how they authenticate.
3. Keep `SHEPHERD_REPO_ROOT` tight so Hermes can only target intended repos.

## Request schema

`POST /api/sessions`, `Content-Type: application/json`. Validated by
`validateCreate` (`src/validate.ts`); unknown keys are rejected.

| Field           | Type                                                                                                                                                   | Required | Notes                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repoPath`      | string                                                                                                                                                 | ✅       | Absolute or `~`-expanded; must resolve inside `SHEPHERD_REPO_ROOT`                                                                                                                                                                   |
| `baseBranch`    | string                                                                                                                                                 | ✅       | Git branch; `^(?!-)[A-Za-z0-9._/-]{1,200}$`                                                                                                                                                                                          |
| `prompt`        | string                                                                                                                                                 | ✅       | The task instructions; 1–8000 chars                                                                                                                                                                                                  |
| `agentProvider` | `"claude" \| "codex" \| null`                                                                                                                          | —        | Which agent CLI runs the task. Omit/`null` uses the server's configured default provider (`claude` out of the box)                                                                                                                   |
| `model`         | a Claude alias (`"fable" \| "opus" \| "opus[1m]" \| "sonnet" \| "sonnet[1m]" \| "haiku"`), a Codex model id (with `agentProvider: "codex"`), or `null` | —        | Validated against the selected provider. Omit/`null`/`"default"` = that provider's default model; `[1m]` selects the 1M-context Claude variant                                                                                       |
| `effort`        | `"low" \| "medium" \| "high" \| "xhigh" \| "max"`, `"default"`, or `null`                                                                              | —        | Reasoning-effort tier. Omit/`null`/`"default"` = the provider CLI's own default (no effort flag). Passed through as `--effort` for Claude; for Codex `xhigh`/`max` clamp down to `high` at spawn (Codex's domain tops out at `high`) |
| `images`        | `string[]`                                                                                                                                             | —        | ≤10 paths, each confined to the upload staging dir (see `POST /api/uploads`)                                                                                                                                                         |
| `force`         | boolean                                                                                                                                                | —        | `true` bypasses the usage-aware hold gate so the task spawns even at high usage (transport-only; not stored on the session)                                                                                                          |

### Responses

| Status | Meaning                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | **Held** by the usage-aware hold gate — body `{ held: true, id, count }`; the task is queued, not spawned (see below)                                                                                                    |
| `201`  | Created — body is the full `Session` (`id`, `desig`, `status`, `worktreePath`, …)                                                                                                                                        |
| `400`  | Validation failed — body `{ error }`                                                                                                                                                                                     |
| `401`  | No valid session cookie **and** no valid bearer token (the server is gated by default — machine clients must set `SHEPHERD_TOKEN` and send the bearer)                                                                   |
| `403`  | Origin header present and not in `SHEPHERD_ALLOWED_HOSTS`                                                                                                                                                                |
| `409`  | First-run gate pending — a fresh install whose repo root hasn't been picked yet; body `{ error: "first_run_pending" }`. Pick a workspace folder in the HUD (or start the server with `SHEPHERD_REPO_ROOT` set) and retry |
| `415`  | Missing/incorrect `Content-Type`                                                                                                                                                                                         |

## Usage-aware hold gate

Shepherd can **queue** newly submitted tasks instead of spawning them when account
usage is already high, so an automated submitter doesn't push you over a cap. The
gate is **on by default** and governed by two env vars (`SHEPHERD_USAGE_HOLD_ENABLED`,
default on; `SHEPHERD_USAGE_HOLD_PCT`, default `80`).

A submission is held only when **both** of these hold (`src/usage-hold.ts`):

- the gate is enabled, and the request did not set `force: true`; and
- the higher of the 5-hour and weekly usage windows is at or above
  `SHEPHERD_USAGE_HOLD_PCT`.

When usage can't be measured (api-key auth, or caps not yet calibrated) the windows
read `0`, so a task is **never** held — Shepherd won't freeze work it can't measure.

A held submission returns **`200 { "held": true, "id", "count" }`** (not `201`) and no
agent spawns yet. Held tasks are released **FIFO automatically** by a ~30 s sweeper once
usage drops back below the threshold; an operator can also list, release, or drop them via
`GET /api/held`, `POST /api/held/:id/spawn`, and `DELETE /api/held/:id`. To bypass the gate
for a single submission, send `"force": true` in the create body.

## Steering and ending a task

Once a task exists, an external agent can also drive it:

- `POST /api/sessions/:id/reply` — send follow-up text to the live agent
  (`{ "text": "..." }`).
- `POST /api/broadcast` — send the same text to many sessions at once.
- `DELETE /api/sessions/:id` — archive (end) the session.
- `GET /api/sessions` — list active sessions; `GET /api/sessions/:id/diff`,
  `/activity`, `/usage` for inspection. `GET /api/sessions/:id/diff/annotations`
  returns best-effort per-line Diff-tab annotations (agent reasoning anchored to
  changed lines plus routed critic findings) as `{ "notes": [...] }`; it degrades
  to an empty list on any error rather than failing.
- `GET /api/sessions/:id/scratchpad[?path=]` — browse a live session's own
  scratchpad subtree, with the session's operator attachments overlaid as a
  synthetic read-only `attachments/` folder (New Task screenshots and
  mid-session compose-box uploads, which physically live in
  `<worktree>/.shepherd-uploads`). `GET /api/sessions/:id/scratchpad/download?path=`
  streams a single file. Paths are relative to the merged root: `attachments/…`
  paths resolve against the worktree uploads dir, everything else against the
  scratchpad root, each realpath-contained to its own root (`..`, absolute, and
  symlink escapes are rejected). Because the overlay is worktree-keyed, this view
  is provider-agnostic and surfaces even for non-Claude sessions with no
  scratchpad of their own. Both `404` on a missing/archived session.
- `GET /api/sessions/:id/worktree[?path=]` — browse a live session's git
  worktree subtree (read-only); `GET /api/sessions/:id/worktree/download?path=`
  streams a single file. Paths are relative to the worktree root and
  realpath-contained to it. `.git` is hidden at any level, and symlinks that
  resolve outside the worktree are surfaced as non-navigable `linkOutside`
  entries rather than dropped. There is no worktree upload route; both `404` on
  a missing/archived session.
- `POST /api/sessions/:id/scratchpad/upload[?path=<relDir>]` — upload an
  arbitrary binary file (multipart `file` field, no MIME restriction) into the
  session's scratchpad. `?path` selects a relative subdirectory within the
  scratchpad root (default: the root); the root is created on demand but the
  subdir must already exist. The same realpath-containment rules apply. Returns
  `{ "path": "<relpath>" }` (a colliding name is given a numeric suffix rather
  than overwriting). `400` on a missing `file` field, `413` when the file
  exceeds the upload size limit (10 MiB), and `404` on a missing/archived
  session or an out-of-root `path`.

All of these honor the same auth/origin rules as task creation.
