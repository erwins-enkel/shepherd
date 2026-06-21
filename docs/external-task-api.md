# Submitting tasks from external agents (Hermes & friends)

Shepherd's HTTP API is the same surface the UI uses — there is **no separate
"public" API and no CORS barrier** for non-browser clients. Any agent that can
reach the core process (Hermes, a cron job, another service) can queue work by
calling one endpoint.

## TL;DR

```bash
curl -X POST http://localhost:7330/api/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SHEPHERD_TOKEN" \   # omit if SHEPHERD_TOKEN is unset
  -d '{
        "repoPath": "~/Work/my-repo",
        "baseBranch": "main",
        "prompt": "Add OAuth login to the settings page",
        "model": "opus"
      }'
```

A `201` returns the full session, including its designation (`TASK-07`) and
`id` — the agent spawns immediately on an isolated git worktree.

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

| Gate                 | Default                          | What Hermes must do                                                                               |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Network bind**     | `127.0.0.1:7330` (loopback only) | Run on the same host, reach it over Tailscale serve, or set `SHEPHERD_HOST` to expose another NIC |
| **Auth token**       | `SHEPHERD_TOKEN` unset → open    | If set, send `Authorization: Bearer <token>` on every request (timing-safe compare)               |
| **Repo confinement** | `SHEPHERD_REPO_ROOT` = `~` (home) | `repoPath` must resolve **inside** the root, or the request is rejected `400`                     |

### Recommended setup for a remote agent

1. Expose the core to the agent's network — prefer **Tailscale serve** over
   `SHEPHERD_HOST=0.0.0.0`. Add the ts.net hostname to `SHEPHERD_ALLOWED_HOSTS`
   only if the agent is browser-based (sends `Origin`).
2. Set a shared secret: `SHEPHERD_TOKEN=<random>` and give it to Hermes.
3. Keep `SHEPHERD_REPO_ROOT` tight so Hermes can only target intended repos.

## Request schema

`POST /api/sessions`, `Content-Type: application/json`. Validated by
`validateCreate` (`src/validate.ts`); unknown keys are rejected.

| Field        | Type                                    | Required | Notes                                                                        |
| ------------ | --------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `repoPath`   | string                                  | ✅       | Absolute or `~`-expanded; must resolve inside `SHEPHERD_REPO_ROOT`           |
| `baseBranch` | string                                  | ✅       | Git branch; `^(?!-)[A-Za-z0-9._/-]{1,200}$`                                  |
| `prompt`     | string                                  | ✅       | The task instructions; 1–8000 chars                                          |
| `model`      | `"fable" \| "opus" \| "opus[1m]" \| "sonnet" \| "sonnet[1m]" \| "haiku" \| null` | —        | Omit/`null`/`"default"` = Claude's default                                   |
| `images`     | `string[]`                              | —        | ≤10 paths, each confined to the upload staging dir (see `POST /api/uploads`) |

### Responses

| Status | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| `201`  | Created — body is the full `Session` (`id`, `desig`, `status`, `worktreePath`, …) |
| `400`  | Validation failed — body `{ error }`                                              |
| `401`  | `SHEPHERD_TOKEN` set and bearer missing/wrong                                     |
| `403`  | Origin header present and not in `SHEPHERD_ALLOWED_HOSTS`                         |
| `415`  | Missing/incorrect `Content-Type`                                                  |

## Steering and ending a task

Once a task exists, an external agent can also drive it:

- `POST /api/sessions/:id/reply` — send follow-up text to the live agent
  (`{ "text": "..." }`).
- `POST /api/broadcast` — send the same text to many sessions at once.
- `DELETE /api/sessions/:id` — archive (end) the session.
- `GET /api/sessions` — list active sessions; `GET /api/sessions/:id/diff`,
  `/activity`, `/usage` for inspection.

All of these honor the same auth/origin rules as task creation.
