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
   `SHEPHERD_HOST=0.0.0.0`. Add the ts.net hostname to `SHEPHERD_ALLOWED_HOSTS`
   only if the agent is browser-based (sends `Origin`).
2. Set a shared secret: `SHEPHERD_TOKEN=<random>` and give it to Hermes. The
   server is **gated by default**, and machine clients can't use the browser
   password login — the bearer token is how they authenticate.
3. Keep `SHEPHERD_REPO_ROOT` tight so Hermes can only target intended repos.

## Request schema

`POST /api/sessions`, `Content-Type: application/json`. Validated by
`validateCreate` (`src/validate.ts`); unknown keys are rejected.

| Field        | Type                                                                             | Required | Notes                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `repoPath`   | string                                                                           | ✅       | Absolute or `~`-expanded; must resolve inside `SHEPHERD_REPO_ROOT`                                                          |
| `baseBranch` | string                                                                           | ✅       | Git branch; `^(?!-)[A-Za-z0-9._/-]{1,200}$`                                                                                 |
| `prompt`     | string                                                                           | ✅       | The task instructions; 1–8000 chars                                                                                         |
| `model`      | `"fable" \| "opus" \| "opus[1m]" \| "sonnet" \| "sonnet[1m]" \| "haiku" \| null` | —        | Omit/`null` = Claude's default; `[1m]` selects the 1M-context variant                                                       |
| `images`     | `string[]`                                                                       | —        | ≤10 paths, each confined to the upload staging dir (see `POST /api/uploads`)                                                |
| `force`      | boolean                                                                          | —        | `true` bypasses the usage-aware hold gate so the task spawns even at high usage (transport-only; not stored on the session) |

### Responses

| Status | Meaning                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | **Held** by the usage-aware hold gate — body `{ held: true, id, count }`; the task is queued, not spawned (see below)                                  |
| `201`  | Created — body is the full `Session` (`id`, `desig`, `status`, `worktreePath`, …)                                                                      |
| `400`  | Validation failed — body `{ error }`                                                                                                                   |
| `401`  | No valid session cookie **and** no valid bearer token (the server is gated by default — machine clients must set `SHEPHERD_TOKEN` and send the bearer) |
| `403`  | Origin header present and not in `SHEPHERD_ALLOWED_HOSTS`                                                                                              |
| `415`  | Missing/incorrect `Content-Type`                                                                                                                       |

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
  `/activity`, `/usage` for inspection.

All of these honor the same auth/origin rules as task creation.
