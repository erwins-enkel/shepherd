# Submitting tasks from external agents (Hermes & friends)

Shepherd's HTTP API is the same surface the UI uses — there is **no separate
"public" API and no CORS barrier** for non-browser clients. Any agent that can
reach the core process (Hermes, a cron job, another service) can queue work by
calling one endpoint — once it authenticates (the server is gated by default;
see [What actually gates access](#what-actually-gates-access)).

## TL;DR

```bash
shepherd login --token shp_…     # once — a token minted in Settings → Access
shepherd new --repo ~/Work/my-repo --base main --model opus \
  "Add OAuth login to the settings page"
```

The [`shepherd` CLI](cli.md) is a thin client over `POST /api/sessions` (schema
[below](#request-schema)); any HTTP client can call the route directly with
`Authorization: Bearer <token>` — the server is gated by default.

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

The origin guard (`checkOrigin`, `src/server.ts`, over `classifyOrigin` /
`originAllowed` in `src/validate.ts`) runs **only** for POST/PUT/PATCH/DELETE
**and only when an `Origin` header is present**:

```ts
if (!originHeader) return "allow"; // no-browser client (curl, CLI)
```

A server-side HTTP client sends no `Origin`, so it passes. The check exists to
stop a malicious **web page** from issuing cross-site writes from a victim's
browser (CSRF/CSWSH); it is not an authentication mechanism and not a wall for
machine clients. If you _do_ send an `Origin` (e.g. a browser-based agent), add
its hostname to `SHEPHERD_ALLOWED_HOSTS`.

## What actually gates access

| Gate                 | Default                                               | What Hermes must do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network bind**     | `127.0.0.1:7330` (loopback only)                      | Run on the same host, reach it over Tailscale serve, or set `SHEPHERD_HOST` to expose another NIC                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Auth**             | Gated by default (operator password → session cookie) | Machine clients can't use the browser login, so they authenticate with a bearer: `Authorization: Bearer <token>` on every request. Two sources, both accepted at once — mint a **named token** in the HUD under Settings → Access (recommended; revocable per client, no restart, and carries a **scope and repository grant** — see below), or set `SHEPHERD_TOKEN=<random>` in the server's environment (the deployment-provisioned option; no scope, always full reach). Without a valid cookie or bearer the request is `401` |
| **Repo confinement** | `SHEPHERD_REPO_ROOT` = `~` (home)                     | `repoPath` must resolve **inside** the root, or the request is rejected `400`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Recommended setup for a remote agent

1. Expose the core to the agent's network — prefer **Tailscale serve** over
   `SHEPHERD_HOST=0.0.0.0`. No allowlist step is needed for a Tailscale-served
   HUD: Shepherd folds every host `tailscale serve status` shows fronting its
   port (the node's own tailnet name and any Tailscale Service front) into
   `SHEPHERD_ALLOWED_HOSTS` at startup. Add a hostname manually only for a
   browser-based agent (one that sends `Origin`) reaching Shepherd through a
   **non-Tailscale** proxy or custom-DNS front.
2. Give the agent a bearer token. The server is **gated by default**, and machine
   clients can't use the browser password login, so a bearer is how they
   authenticate. Two ways, both accepted simultaneously:
   - **Mint one in the HUD** — Settings → **Access** → _Create a token_. Name it
     after the client (`"Hermes — prod"`), copy the value while it is shown (it
     is shown **once**; only a hash is stored), and paste it into that client.
     Revoking it later is one click and takes effect on the client's next
     request — no restart, and no other client is disturbed. This is the
     recommended route for anything you _install_.

     Pick the token's **scope** in the same dialog; it is fixed for the token's
     lifetime. **Read** covers `GET /api/repos`, `/api/branches`, `/api/sessions`, `/api/holds`, `/api/git`,
     `/api/me`, `POST /api/ping`, the `/events` stream, and the two in-flight
     review probes `GET /api/reviews/inflight` and
     `GET /api/plan-gates/inflight` — each returns one row per run currently in
     flight: the session id plus that run's reviewer env (`provider`, `model`,
     `effort`). A dashboard that loads mid-review therefore doesn't read an idle
     session with a green PR as the operator's turn
     ([#2421](https://github.com/erwins-enkel/shepherd/issues/2421)). Nothing
     new is disclosed by granting them: `/events` already pushes the same fact,
     reviewer env included, to a read token as `session:reviewing` and
     `session:plangate-reviewing` — the two probes are the bootstrap snapshot of
     that stream.
     Their **verdict parents** `GET /api/reviews` and `GET /api/plan-gates`,
     which return findings, summaries, plan questions and round counts, stay
     **Full**-only; matching is exact, so reaching the `/inflight` child grants
     nothing at the parent. **Submit** adds
     handing work in — `POST /api/sessions`, `GET /api/held`,
     `POST /api/held/:id/spawn`, `PATCH`/`DELETE /api/held/:id`,
     `GET`/`DELETE /api/dispatches/:id` (the outcome of a keyed submission, see
     [Idempotent submission](#idempotent-submission-idempotency-key)),
     `POST /api/uploads`, `POST /api/issues`. Everything else — steering a live
     session (`/reply`, `/interrupt`, `/relaunch`), archiving, the `/pty/:id`
     terminal, and every per-session read — needs **Full**. The policy is an
     allowlist (`src/token-scopes.ts`), matched exactly on method and path, so a
     route it doesn't name requires `full`. A driver like Hermes that both
     submits and steers wants **Full**; a dashboard that only watches wants
     **Read**.

     One route every scope reaches: `DELETE /api/access-tokens/<id>` where
     `<id>` is the id of **the token making the request** — a client that holds
     only a bearer (no operator cookie) can hand its own credential back on
     logout instead of waiting for an operator to revoke it in the HUD
     ([#2358](https://github.com/erwins-enkel/shepherd/pull/2358)). It is
     deliberately scope-blind: self-destruction reaches nothing. Listing,
     minting, changing repository grants, and revoking **any other** id still require the operator session
     cookie, and a bearer naming an id that isn't its own is answered `403`
     whether or not that id exists, so the route is not an existence oracle.

   - **`SHEPHERD_TOKEN=<random>`** in the server's environment — the right
     mechanism when the deployment platform provisions the secret (systemd unit,
     container env). One shared value for every client; changing it is a deploy.

   Either way the request looks the same: `Authorization: Bearer <token>`.

3. Select the permitted repositories in **Settings → Access**. New UI tokens require
   a selection or an explicit **All repositories (including future ones)**. Use
   **Edit repositories** on an existing token to change its grant without changing
   its secret, scope or expiry. Removing every selection grants no repository access.

### Copy instructions for another agent

After creating a token, choose **Copy agent instructions** in the one-time reveal.
Enter the Shepherd server's reachable HTTP(S) address, typically its HTTPS Tailnet
address. A localhost address points at the receiving computer and is not accepted.
The application does not send a request or the token to an address you enter.

Paste the instructions into the agent working on your project. Its HTTP tool runtime
must itself reach the server through the Tailnet; a desktop or cloud product name
alone does not guarantee that network access. The instructions include the secret,
current permissions and scope-appropriate requests. A selectable preview is available
if clipboard access fails. The secret and instructions remain only in component
memory; after dismissing the reveal or reloading, create a new token if you need
another complete copy. Do not commit the instructions or include the secret in logs.

Start with `GET /api/me`, then discover permitted repositories and sessions. A
**Full** token can coordinate multiple existing and newly created sessions in its
granted repositories: read individual status, send `/reply` with `{ "text": "…" }`,
interrupt, relaunch, and use the session's plan, queue, review and Git/PR actions.
Follow the plan and review gates before `/go`. Do not submit the example task merely
because the connection instructions were pasted. After an ambiguous create timeout,
inspect sessions and held tasks before retrying to avoid duplicate work.

### Repository grants and changes

`POST /api/access-tokens` accepts `repoPaths`, an array of exact server repository
roots, or `null` for all repositories including future ones. Omission preserves the
legacy all-repository behavior. Existing tokens also remain unrestricted until edited.
Paths are checked against repository discovery, canonicalized and deduplicated; grants
are not path prefixes. An empty array grants nothing.

An operator cookie can call `PATCH /api/access-tokens/:id` with only
`{ "repoPaths": ["/server/projects/my-repo"] }`. The response is
`{ "entry": <updated token summary> }`, with no plaintext. Scope and expiry stay
fixed. A bearer cannot edit its own grant or manage other tokens.

For minted bearer tokens, `GET /api/me` returns
`{ "authenticated": true, "access": { "tokenId": "…", "scope": "full", "repoPaths": ["/server/projects/my-repo"], "expiresAt": null } }`.
This live value takes precedence over an old copied instruction. Cookie and environment
credentials keep their existing behavior.

Both scope and repository grant must permit each request. Lists, status snapshots and
live events contain only permitted sessions. Unknown or foreign session/task/held IDs
return `404`; explicit foreign repository targets and disallowed actions return `403`.
Repository-limited **Full** tokens cannot administer global settings, tokens, plugins,
new repositories or global bulk operations. Unclassified endpoints are denied.
Staged attachments from a limited token can be reused only by that token; session
uploads also require access to the destination repository.

Grant changes and revocation close existing event and terminal WebSockets; clients
must reconnect with current rights. Idle sockets close at expiry, too. New HTTP
requests use current grants; already authorized in-flight HTTP operations are not
retroactively canceled. Invalid, expired or revoked tokens return `401`.

Below **Full** scope, a token can only tighten the sandbox profile a task runs under,
never loosen the repository's own (`trusted` < `standard` < `autonomous`). A create,
held-task edit or held-task spawn is refused with `403`
`{ "error": "sandbox_override_not_allowed" }` when its `sandboxProfile`, an explicit
`agentProvider: "codex"` (which always runs `trusted`), or a `research`,
`epicAuthoring` or `bootstrap` task on an `autonomous` repository (those run
`standard`) would leave it weaker. A task sent to another machine cannot be compared
with that machine's setting, so there it may only omit `sandboxProfile` or ask for
`autonomous`, and may not use Codex or those task kinds. Full tokens and the operator
may still loosen a single task.

Repository grants limit the Shepherd API. They do not sandbox a running agent's OS
permissions or remove host/Git credentials it already possesses. Keep
`SHEPHERD_REPO_ROOT` and the agent environment appropriate for the work.

## Request schema

`POST /api/sessions`, `Content-Type: application/json`. Validated by
`validateCreate` (`src/validate.ts`); unknown keys are rejected.

| Field           | Type                                                                                                                                                                                                                                                                                                                                          | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoPath`      | string                                                                                                                                                                                                                                                                                                                                        | ✅       | Absolute or `~`-expanded; must resolve inside `SHEPHERD_REPO_ROOT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `baseBranch`    | string                                                                                                                                                                                                                                                                                                                                        | ✅       | Git branch; `^(?!-)[A-Za-z0-9._/-]{1,200}$`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `baseCommit`    | string \| `null`                                                                                                                                                                                                                                                                                                                              | —        | Create the worktree at exactly this commit — a full lowercase hex id (`^(?:[0-9a-f]{40}\|[0-9a-f]{64})$`). It is used as-is and **never** freshened to `baseBranch`'s upstream tip; a commit the repo doesn't have is fetched from `origin`, and one that still can't be used answers `422`. `baseBranch` stays the PR target. Omit/`null` = resolve the base from `baseBranch` as usual                                                                                                                                                                                                                                                                                                                                                                       |
| `prompt`        | string                                                                                                                                                                                                                                                                                                                                        | ✅       | The task instructions; 1–8000 chars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `agentProvider` | `"claude" \| "codex" \| null`                                                                                                                                                                                                                                                                                                                 | —        | Which agent CLI runs the task. Omit/`null` uses the server's configured default provider (`claude` out of the box)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `model`         | a Claude alias (`"claude-mythos-5-1" \| "fable" \| "claude-fable-5-1" \| "opus" \| "opus[1m]" \| "claude-opus-5-5" \| "claude-opus-5-5[1m]" \| "claude-opus-5" \| "claude-opus-5[1m]" \| "sonnet" \| "sonnet[1m]" \| "claude-sonnet-5-5" \| "claude-sonnet-5-5[1m]" \| "haiku"`), a Codex model id (with `agentProvider: "codex"`), or `null` | —        | Validated against the selected provider. Omit/`null`/`"default"` = that provider's default model; `[1m]` selects the 1M-context Claude variant. Bare aliases (`"opus"`, `"fable"`) track the latest model of that tier; the full model name (`"claude-opus-5-5"`, `"claude-fable-5-1"`) pins an exact version. A pinned name only spawns on a Claude Code new enough to carry it — `claude-opus-5-5` needs 2.1.280 or newer, and an older CLI rejects it with a `400`; `claude-sonnet-5-5` needs 2.1.284, and an older CLI runs it with the context capped at 200k tokens. `claude-mythos-5-1` is account-gated: it starts only when the Claude account the server is logged in to has access to it, and otherwise answers `422 { code: "model_unavailable" }` |
| `effort`        | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"`, `"default"`, or `null`                                                                                                                                                                                                                                                          | —        | Reasoning-effort tier. Omit/`null`/`"default"` = the provider CLI's own default (no effort flag). Explicit tiers pass through unchanged as `--effort <tier>` for Claude or `-c model_reasoning_effort=<tier>` for Codex. The CLI decides whether the selected model supports the tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `images`        | `string[]`                                                                                                                                                                                                                                                                                                                                    | —        | ≤10 paths, each confined to the upload staging dir (see `POST /api/uploads`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `force`         | boolean                                                                                                                                                                                                                                                                                                                                       | —        | `true` bypasses the usage-aware hold gate so the task spawns even at high usage (transport-only; not stored on the session)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `requirements`  | `string[]`                                                                                                                                                                                                                                                                                                                                    | —        | Capabilities this Shepherd must have, from its fixed vocabulary (`platform:linux`, `platform:macos`, `platform:windows`, `xcode`, `sdk:macos`, `sdk:ios`, `ios-simulator`, `android-sdk`, `agent:claude`, `agent:codex`, `sandbox:trusted`, `sandbox:standard`, `sandbox:autonomous`; an unknown one is a `400`). They are what the machine that runs the task must have: with machines connected, the automatic choice only picks one whose report has them all (see below). The machine that runs it checks them against a **fresh** probe when it accepts the request — never against an older report — and a missing one answers `422` with nothing started. `GET /api/instance` shows the current report. Omit/`[]` = no check                            |
| `terminal`      | `true`                                                                                                                                                                                                                                                                                                                                        | —        | Selects the **clean-terminal** arm of the create union (see below). Present-but-not-`true` is a `400`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The body is a **discriminated union** on `terminal`. Omitting it (or the whole
field) creates an ordinary agent task, exactly as documented above. Sending
`{"repoPath": "…", "terminal": true}` instead creates a **clean terminal** — a
bare operator shell opened directly in the repo's **main checkout** (no agent, no
worktree, no prompt), which the HUD attaches to like any other session terminal.
The terminal arm has no other members: a stray `prompt`, `baseBranch`, `model`,
… is an unknown-key `400` rather than a silently ignored field. Because it spawns
no agent it is never held by the usage gate, and a held task can't be edited into
one (`PATCH /api/held/:id` refuses it `400`). There is at most **one** terminal per
repo — a second create is refused `409 { "error": "terminal_exists", "existingId": … }`
so the caller can focus the one already open.

A clean terminal is fenced out of every agent-input flow: `reply`, `interrupt`,
`resume`, `relaunch`, `replace`, `restore`, and `preview` all answer
`409 { "error": "terminal_session" }` for one, and `POST /api/broadcast` skips
terminals — its result counts them in an additive `skipped` field
(`{ delivered, queued, offline, skipped, total }`). Archiving
(`DELETE /api/sessions/:id`) works normally and closes the underlying herdr tab;
Shepherd also archives the session on its own once the shell has exited.

### Responses

| Status | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | **Held** by the usage-aware hold gate — body `{ held: true, id, count }`; the task is queued, not spawned (see below)                                                                                                                                                                                                                                                                                                                                                            |
| `201`  | Created — body is the full `Session` (`id`, `desig`, `status`, `worktreePath`, …), including `baseCommit`: the commit its worktree was actually created from                                                                                                                                                                                                                                                                                                                     |
| `400`  | Validation failed — body `{ error }`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `401`  | No valid session cookie **and** no valid bearer token — the server is gated by default. Also what a **revoked or expired** minted token gets, on its very next request                                                                                                                                                                                                                                                                                                           |
| `403`  | Origin header present and not in `SHEPHERD_ALLOWED_HOSTS`. Also `{ "error": "insufficient_scope" }` when the bearer is a valid minted token whose scope doesn't reach this route — the credential is fine, so retrying won't help; mint one with a wider scope                                                                                                                                                                                                                   |
| `409`  | First-run gate pending — a fresh install whose repo root hasn't been picked yet; body `{ error: "first_run_pending" }`. Pick a workspace folder in the HUD (or start the server with `SHEPHERD_REPO_ROOT` set) and retry                                                                                                                                                                                                                                                         |
| `409`  | Clean-terminal conflict — `{ error: "terminal_exists", existingId }` (that repo already has a terminal), `{ error: "terminal_unsupported" }` (the installed herdr has no `terminal session control`), or `{ error: "terminal_session" }` (an agent-only verb aimed at a terminal session)                                                                                                                                                                                        |
| `409`  | The installed herdr and the running herdr daemon disagree on the socket protocol — `{ error: "herdr_restart_required", code: "herdr_restart_required" }`. A herdr update was installed but its server was never restarted, so no task can spawn until the daemon is restarted (the HUD offers the recovery from Settings → Diagnose)                                                                                                                                             |
| `409`  | The spawn was cancelled while in flight — `{ error: "spawn canceled", code: "spawn_canceled" }`. Reachable only for a caller that supplied `X-Shepherd-Spawn-Id` and then called the cancel route below; the worktree is already rolled back, so this is a cancellation, not a failure                                                                                                                                                                                           |
| `409`  | The worktree path this task's name resolves to is already checked out by another session — `{ error: "worktree path <path> is already checked out by another session" }`. Name selection normally steps around an occupied path, so this is the backstop for a race between choosing the name and adding the worktree; Shepherd refuses rather than reclaiming (the reclaim is an `rm -rf` of a live checkout). **Retry** — a retry re-runs name selection and picks a free path |
| `409`  | A keyed submission that will not start — `dispatch_payload_mismatch`, `dispatch_canceled` or `dispatch_interrupted`; see [Idempotent submission](#idempotent-submission-idempotency-key)                                                                                                                                                                                                                                                                                         |
| `422`  | The base branch (or `baseCommit`) does not resolve to a commit — or a `requirements` entry is not met: `{ error, code: "missing_capabilities", missing: [{ capability, reason }] }`, e.g. `reason: "not_logged_in"` for `agent:codex`. Nothing is held or started; with an `Idempotency-Key` the refusal is final for that key like any failed start, and its replay carries `error` (which still names each capability and reason) and `code`, but no `missing`                 |
| `422`  | The requested `model` is account-gated and the server's logged-in Claude account doesn't have it — `{ error, code: "model_unavailable" }` (today only `claude-mythos-5-1`). Nothing is started; pick another model                                                                                                                                                                                                                                                               |
| `415`  | Missing/incorrect `Content-Type`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Watching and cancelling a slow start

`POST /api/sessions` only answers once the agent is running, and most of that wait
is herdr auto-detecting a trusted agent. A caller can name its own spawn with an
`X-Shepherd-Spawn-Id` **header** (a client-chosen id matching
`^[A-Za-z0-9-]{8,64}$` — the HUD sends a `crypto.randomUUID()`). It is a header,
not a body field, because the create body is what a usage hold persists as a held
task and a replayed id would be stale; an unknown key in the body is a `400`.

With that header the server broadcasts a `spawn:progress` event per create phase
on the existing `/events` stream, and `POST /api/spawns/:spawnId/cancel` aborts
the create — it answers `200 { "canceled": true }` when the signal landed and
`{ "canceled": false }` when the agent came up first (the spawn then runs to
completion). A cancelled create unwinds the worktree and answers the `409`
`spawn_canceled` above. Without the header the spawn is still measured and still
logs its phase line; it just can't be watched or cancelled
(`src/spawn-progress.ts`, `src/server.ts`).

### Idempotent submission (`Idempotency-Key`)

A lost answer to `POST /api/sessions` leaves a client unsure whether the task
started. Sending it again blindly can start the same task twice. To make retries
safe, name the submission with an **`Idempotency-Key`** header — a client-chosen id
matching `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (a `crypto.randomUUID()` is ideal),
bare or double-quoted as an HTTP structured-field string; anything else is a `400`.
Without the header nothing changes.

Shepherd reserves the key in its database **before** the hold gate or the spawn
(after the body is validated and the repository grant checked), and keeps it across
restarts. What a later request with the same key gets:

| Situation                                      | Answer                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Same body, the first request is still starting | Waits for it, then the same outcome                                                                                 |
| Same body, it started                          | `201` with the session (its current state) — no second spawn                                                        |
| Same body, it was held                         | `200 { held: true, id, count }` with the same held id; once that hold is released, `201` with the session it became |
| Same body, it failed                           | The same failure, with the original status — a failure is **final** for its key; use a new key to try again         |
| A **different** body                           | `409 { code: "dispatch_payload_mismatch" }` — nothing runs                                                          |

"The same body" means the same JSON after sorting object keys; the
`X-Shepherd-Spawn-Id` header is not part of it. A replayed answer carries the
response header `Idempotent-Replayed: true`.

`GET /api/dispatches/:id` (the key as `:id`) reports the outcome:
`{ id, state, sessionId?, heldId?, reason?, code?, createdAt, updatedAt }` with
`state` one of `pending` (still starting), `started` (`sessionId`), `held`
(`heldId`; it turns `started` when the hold is released, or `failed` with
`held_discarded` when it is discarded) and `failed` (`reason`, `code`). **`404`
means the key never arrived** — the one case where sending it again is how to
recover. If Shepherd restarts while a start is still running, that key reads as
`failed` with `code: "dispatch_interrupted"` and is never started again: an
interrupted spawn may have left an agent behind, and a second one is exactly what
the key exists to prevent.

`DELETE /api/dispatches/:id` withdraws a key that has not arrived. An unknown key
is reserved as cancelled (`failed`, `dispatch_canceled`), so if the submission does
show up later it is refused `409` instead of started; an already-failed key stays as
it is. Either way the answer is `200` with the dispatch. Once the key has arrived (`pending`,
`started` or `held`) the answer is `409 { code: "dispatch_arrived", dispatch }` —
archive the session or discard the held task instead. Both routes need the
**Submit** scope, and a repository-limited token sees a dispatch only in its
granted repositories (`src/dispatch.ts`, `src/server.ts`).

### Running on a connected machine (`target`)

A Shepherd with connected machines (**Settings → Machines**) can start a task on
one of them instead of here. Without `target` it **chooses the machine itself**
(see [Automatic choice](#automatic-choice)); to name one, add
`"target": { "instanceId": "<machine id>" }` to the body (the ID from
`GET /api/remote-instances`). The **whole** session then runs on that machine —
worktree, agent, builds and tests — and nothing starts here; it shows up in this
Shepherd's `GET /api/sessions` with `host` set, through the machine's mirror.
Naming this instance's own ID runs the task here. Without any connected machine
nothing changes: no `target` means here, as it always did.

- `repoPath` still names **this** Shepherd's checkout, but only to identify the
  project by its forge slug (`owner/repo`). The machine must be connected and have
  that project checked out; it runs the task in its own checkout, from the base
  branch as pushed to origin — unpushed local changes are not there.
- Every other field travels unchanged (prompt, mode, plan gate, autopilot,
  sandbox, issue, base branch and commit, `force`). The machine checks paths, its
  own usage hold and its sandbox; a missing sandbox there shows on the session as
  `sandboxDegraded`.
- Attachments (`images`, staged here through `POST /api/uploads`) travel with the
  task: see below. A clean terminal (`terminal: true`) cannot take a target.
- It needs the same scope and repository grant as starting the task here.

Shepherd stores the task **before** it sends it and sends it under a dispatch ID
of its own as the machine's `Idempotency-Key`, so the machine starts it at most
once. Name your submission with an `Idempotency-Key` as above: a retry with the same
key and body goes out again to the **same** machine — never to another one — and
a different body under that key is `409 dispatch_payload_mismatch`.

| Outcome                                   | Answer                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Started there                             | `201` with the machine's session, plus `host` and `connection`                                         |
| Held there (its usage hold)               | `200 { held: true, id, count, host }` — `id` and `count` are the machine's                             |
| The machine refused it                    | `422 { code: "remote_rejected", error: <its reason>, remoteStatus, remoteCode?, host }`                |
| Sent, but no answer came back             | `504 { code: "remote_dispatch_unknown", dispatchId, host }` — start status unknown, see below          |
| Canceled before the machine confirmed it  | `409 { code: "remote_dispatch_canceled", host }` — it never starts under that key                      |
| Canceled, cancel not yet confirmed        | `409 { code: "remote_dispatch_cancel_pending", host }` — not sent again, but may run there             |
| An attachment did not reach the machine   | `502 { code: "remote_upload_failed", error: <which and why>, host }` — nothing was sent                |
| Not connected right now (nothing sent)    | `409 { code: "remote_target_unavailable", reason }`                                                    |
| No such machine / no checkout of the repo | `422` with `remote_target_unknown` / `remote_project_missing` (`remote_project_unknown`: no slug)      |
| Platform not released (Windows)           | `422 { code: "remote_target_unreleased", reason: <platform> }` — listed in Settings, never sent a task |
| Its report lacks a requirement            | `422 { code: "missing_capabilities", missing: [{ capability, reason }], host }` — nothing was sent     |

A named machine must fit the task before anything is sent: connected, released,
the project checked out, and every `requirement` verified by its last capability
report (`reason` `not_verified` when no fresh report confirms one). The machine
still checks the requirements against a fresh probe when the task arrives.

`504` means the task **may be running** on the machine: its start status is
_unknown_, not failed. This Shepherd follows it up by itself. After every check
that finds the machine connected — when it reconnects, after either Shepherd
restarts, and about once a minute — it asks the machine
`GET /api/dispatches/{dispatch ID}`: started, held or failed there settles it here,
and "never arrived" (`404`) sends the same task again, under the same dispatch ID,
to the same machine. Still starting there, or no answer, leaves it unknown for the
next check. It never starts twice and never moves to another machine
(`src/remote-instances/dispatch.ts`). Sending it again yourself with the same key
is safe too: the machine replays what became of it.

`GET /api/remote-dispatches` lists the tasks for machines that are not settled —
`{ dispatches: [{ id, state, host, summary, … }] }` with `state` `unknown`,
`canceling` for a cancel on its way, `waiting` for a task waiting here for its
machine, or `held` for one the machine holds ([Waiting for a machine](#waiting-for-a-machine))
— and the `remote:dispatch` event announces each change of one, including the one
that resolves it (`started` with `sessionId`, `rejected` with `reason`/`code`,
`canceled`, `redirected`). The herd shows them at its top, labelled with the machine.
`DELETE /api/remote-dispatches/{id}` cancels one: the machine's
`DELETE /api/dispatches/{id}` makes sure it never starts there, even if it arrives
late (`200`). A machine out of reach gets the cancel as soon as it answers (`202`,
`canceling`), and nothing sends the task again meanwhile. Once the machine has it
(or while it is being sent), the answer is `409 remote_dispatch_not_cancelable`
with the current `dispatch`. The routes need `full` scope.

Attachments are uploaded to the machine's own `POST /api/uploads` **right before**
the task is sent, and the task then names the machine's staged copies — never a
path of this Shepherd. The machine puts them into the session's worktree
(`.shepherd-uploads/`) and lists them in the prompt, exactly as for a task started
there; `attachmentNames` travel unchanged. The machine's paths are stored with the
dispatch, so a retry with the same key uploads nothing again and sends the very
same body. If an attachment does not get there — the machine refuses it, does not
answer, or it is no longer staged here — the task is not sent at all (`502
remote_upload_failed`), and it is never sent under that key; submit it again under
a new key to upload afresh.

### Automatic choice

While a machine is connected, a create **without** `target` is placed by this
Shepherd. The rules are the same for the web UI, the native apps and the API, and
give the same result from either Shepherd when preferences and fresh load observations agree:

1. **Candidates** are this Shepherd and every connected machine whose platform is
   released (Linux, macOS), that has the project checked out (by forge slug) and
   whose capability report — not older than 15 minutes — has every `requirement`.
2. **Ranking:** by platform, Linux before macOS by default (Linux has the full
   sandbox and runs all the time), then by instance ID. Each Shepherd keeps its own
   order (`machinePlatformOrder` in `PATCH /api/settings`, **Settings → Machines**); a
   task lands on the same machine wherever it is submitted only while every
   connected Shepherd uses the same order.
3. **High host load:** the preferred connected machine is kept while its one-minute load per
   logical CPU core is below 1.0. At 1.0 or above, the first fitting connected alternative in the
   same preference order with load at or below 0.75 takes the new task. Measurements must be no
   older than 15 seconds. Unknown/stale load never counts as spare capacity. Running session counts
   are informational only. Without a proven spare alternative, the preferred machine still starts
   the task and the UI warns about high load. Explicit targets remain binding.
4. **The selected machine** gets the task: here (a local create, as ever) or sent there
   exactly as with `target`. It then runs there and is never placed again.

| Outcome                                     | Answer                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Placed here or on a machine                 | as without machines, or as with `target` (above)                                                |
| No machine fits                             | `422 { code: "no_suitable_machine", missing, together, elsewhere }` — nothing starts            |
| The machine it is meant for is out of reach | `200 { held: true, waiting: true, id, count, host, dispatch }` — it waits here for that machine |

`missing` lists the capabilities no connected machine with the project has
(all of them, with `together: true`, when each is on some machine but none has
them together); `elsewhere` the connected machines that would fit but have no
checkout of the project. A machine out of reach is judged on what it last
reported, so a task meant for it waits for it rather than silently starting on the
next machine ([Waiting for a machine](#waiting-for-a-machine)).

The decision is recorded on the session as `launchMetadata.placement`
(`{ mode, target, requirements, basis, preferred, by, decidedAt }`) — on the
machine that runs it as well, so every Shepherd shows why it runs where it runs.
`basis` is `requirements` (only one platform fits), `preference` (the order
decided, `preferred` names the platform), `only_candidate` or `manual` (named in
`target`), or `load` (high load overrode the preference, `preferred` is null).
An optional `load` record carries `state` (`normal`, `diverted`, `busy`, `unknown`),
`preferredHost`, `preferredReport` and `selectedReport`. These are immutable observations at the
selection time, not current telemetry. Reports include `sampledAt`, `ageMs`, `stale`, `load1`,
`cpuCount` and `runningSessions`. Load is a system activity indicator, not CPU utilization percent;
it is not a RAM, battery or cgroup capacity check. A keyed retry (same `Idempotency-Key`) goes where its first submission
went, whatever the choice would say now.

`POST /api/placement` with `{ repoPath, requirements?, target? }` answers what a
create with that body would do, without storing or sending anything:
`{ active: false }` while no connected machine could take a task, else
`{ active: true, placement }` or `{ active: true, refusal: { code, error, … } }`
with the refusal's fields as above. `{ active: true, placement, wait: { status,
alternatives } }` means the machine in `placement` is out of reach and the task
would wait for it; `alternatives` are the connected machines that fit too. New Task
shows it before you submit. Load is checked again on create, so changed load may change the
first submission's destination; the preview does not reserve capacity. Concurrent starts may
choose the same host. Missing telemetry does not prevent a start, and there is no load queue.

`GET /api/instance` includes a nullable `load` report. Placement refreshes stale remote load through
that route with parallel, deduplicated reads bounded to 1.5 seconds each; it does not repeat the
full connection probe. Federation API level **3** carries the new placement basis: connected
servers need this level on both sides. Mixed levels are incompatible until both servers are
updated; existing stored placement records without load remain readable.

Every `active` answer also lists `machines`: what `target`
may name for this repo right now — this Shepherd first, then each connected machine
whose platform is released and that has the project checked out. The native apps
offer these under **Run on**, since `GET /api/remote-instances` needs a signed-in
operator and their token is not one.

### Waiting for a machine

A create the automatic choice meant for a machine that is out of reach is not
refused and not started elsewhere: it is stored here and answered
`200 { held: true, waiting: true, id, count, host, dispatch }` — `id` is its
dispatch ID, `host` the machine it waits for, `count` the tasks waiting here, and
`dispatch` the waiting task as `GET /api/remote-dispatches` lists it. A client that
does not know `waiting` reads it as a hold: queued, not started. Nothing is sent and
no attachment is uploaded yet. A retry under the same `Idempotency-Key` answers the
same wait. A machine named in `target` is never waited for: out of reach, it is
`409 remote_target_unavailable` as above.

A waiting dispatch carries `placement` (why it is meant for that machine),
`readiness` and `alternatives`:

| `readiness.state`      | Meaning                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `offline`              | Not connected; `status` says why (`timeout`, `network`, `unauthorized`, …)                                   |
| `missing_capabilities` | Connected, but its report lacks a requirement: `missing: [{ capability, reason }]` (`not_verified` if stale) |
| `project_missing`      | Connected, but no checkout of the project                                                                    |
| `unreleased`           | Its platform is not released for tasks                                                                       |
| `ready`                | It fits: the task goes out with the next check                                                               |

After every check that finds the machine connected — on reconnect, after this
Shepherd restarts, and about once a minute — a ready waiting task is sent: for a
task with requirements the machine first runs a fresh capability check
(`POST /api/instance/capabilities`), then its checkout is looked up, the
attachments are uploaded and the task goes out under its dispatch ID like any task
for a machine. A check that lacks a requirement leaves it waiting. The staged
attachments of a waiting task are kept until it is sent. Waiting tasks are stored,
so they survive restarts; removing the machine cancels them
(`canceled`, `code: "machine_removed"`).

`DELETE /api/remote-dispatches/{id}` cancels a waiting task at once (`200`) — it
was never sent. `POST /api/remote-dispatches/{id}/redirect` with
`{ target: { instanceId } }` runs it on another machine now, or on this Shepherd
(its own instance ID). The machine must fit as a named `target` must; otherwise the
refusal is answered (`422 missing_capabilities` with `host`, `remote_target_*`,
`remote_project_missing`; `409 remote_target_unavailable`) and the task keeps
waiting. On another machine it goes out under the same dispatch ID and is answered
like a create with `target` (`201`, `200` held, `502`, `504`, or `200` with
`waiting` if that machine cannot take it yet). On this Shepherd it starts under the
task's own `Idempotency-Key`, so retrying the original create replays this start.
A task that is not waiting is `409 remote_dispatch_not_redirectable` with the
current `dispatch`; an unknown one `404`. The choice is recorded as `manual`.

A task the machine holds (its usage hold or capacity) is listed as `held` until the
machine starts it or drops it there; this Shepherd asks the machine after every
check. `DELETE /api/remote-dispatches/{id}` discards it there
(`DELETE /api/held/{heldId}` on the machine) and settles once the machine's
dispatch record confirms it — `canceling` (`202`) while the machine is out of
reach, `409 remote_dispatch_not_cancelable` if it started first. A held task is not
redirected: cancel it and submit it again.

### Requirements from the task

A create never reads its own requirements: what `requirements` says (or its
absence) is what the choice uses. To read them from the task, as New Task does,
ask `POST /api/requirements/derive` first with
`{ repoPath, prompt, issue?: { title, body? }, images? }` (the prompt ≤ 8000
chars; it, the issue title or `images` not empty; `images` are staged paths from
`POST /api/upload`, and only the images among them are looked at). The decision
model (judge), when armed, answers a task without screenshots in one request;
otherwise, and on any judge failure, a helper on the autopilot classifier's CLI
and model reads the prompt, the issue and the screenshots — never the repository
— within 30 seconds. The placement preview says `deriveRequirements: true` when
the answer can change where the task runs (no `target`, and the machines that
could take it differ in Xcode, the iOS SDK, the iOS simulator or the Android
SDK); then wait for it before creating. The answer is data, never prose:

| `status`  | Meaning                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skipped` | No machine is connected, so reading them cannot change where the task runs; nothing ran                                                                      |
| `derived` | `requirements` (possibly `[]`) from `xcode`, `sdk:ios`, `ios-simulator`, `android-sdk`, with what each implies — send them as the create's `requirements`    |
| `unclear` | The description could mean different things or contradicts itself: `options` holds 2–3 requirement sets (`[]` = nothing special) — ask, then send the choice |
| `failed`  | Nothing was read — `cause` is `timeout`, `error` (also an answer outside the vocabulary) or `unavailable`; nothing is guessed                                |

`400` for a malformed body, `403 repository_not_allowed` for a token restricted
to other repositories.

## Usage-aware hold gate

Shepherd can **queue** newly submitted tasks instead of spawning them when account
usage is already high, so an automated submitter doesn't push you over a cap. The
gate is **on by default** and governed by two env vars (`SHEPHERD_USAGE_HOLD_ENABLED`,
default on; `SHEPHERD_USAGE_HOLD_PCT`, default `80`).

A submission is held only when **all** of these hold (`src/usage-hold.ts`,
`src/server.ts`):

- the resolved coding CLI is **Claude** — the request's `agentProvider` if it set
  one, else the operator's default provider. A Codex submission is never held,
  because the hold gate reads Claude's usage windows; and
- the gate is enabled, and the request did not set `force: true`; and
- the higher of the 5-hour and weekly usage windows is at or above
  `SHEPHERD_USAGE_HOLD_PCT`.

That first condition interacts with **capacity failover**
(`src/provider-failover.ts`): when the default CLI's weekly window runs low the
operator can switch the default to the other CLI from the usage popover, and
Shepherd switches back on its own once capacity returns. While the default is
Codex, submissions that don't name a provider are spawned rather than held.

When usage can't be measured (api-key auth, or caps not yet calibrated) the windows
read `0`, so a task is **never** held — Shepherd won't freeze work it can't measure.

A held submission returns **`200 { "held": true, "id", "count" }`** (not `201`) and no
agent spawns yet. Held tasks are released **FIFO automatically** by a ~30 s sweeper once
usage drops back below the threshold; an operator can also list, release, or drop them via
`GET /api/held`, `POST /api/held/:id/spawn`, and `DELETE /api/held/:id`. To bypass the gate
for a single submission, send `"force": true` in the create body.

## Steering and ending a task

Once a task exists, an external agent can also drive it. The CLI covers the
common verbs — `shepherd steer`, `shepherd interrupt`, `shepherd archive` and
`shepherd resume` (see [the CLI reference](cli.md#session-control)); the routes
underneath are:

- `POST /api/sessions/:id/reply` — send follow-up text to the live agent
  (`{ "text": "..." }`).
- `POST /api/sessions/:id/interrupt` — interrupt that one session: a lone ESC to
  its pane and nothing else (no body). The per-session counterpart to the
  fleet-wide `POST /api/halt`, and composable with `/reply`, so cancel-then-re-prompt
  is interrupt → reply. Unlike `/api/halt` it does not skip sessions that aren't
  currently working (the caller named its target) and it is serialized against
  other steers, so an interrupt issued before a reply always lands first; a
  wedged send can therefore delay it, and `/api/halt` stays the un-queued escape
  hatch. `200 {"ok":true}` when the ESC landed, `404 {"error":"not found"}` for an
  unknown id, a dead pane, or an undeliverable send.
- `POST /api/broadcast` — send the same text to many sessions at once.
- `DELETE /api/sessions/:id` — archive (end) the session. This route owns that
  exact path and nothing below it; a `DELETE` on a sub-resource (an amendment,
  say) hits its own handler and never archives the session.
- `POST /api/sessions/:id/amendments` — record an **operator task amendment**
  (`{ "text": "...", "steer": false }`): text that ranks alongside the original
  task in the prompts that treat the task as ground truth (session critic, plan
  reviewer, autopilot classifier, recap). `201 { "amendment", "steered" }`. The
  amendment is persisted **first** and steering is best-effort, so `steered` is
  `false` — not an error — when `steer` was omitted or the text could not reach
  the session's agent. `400` on a missing/empty `text` or one over 2000
  characters (`AMENDMENT_MAX_CHARS` in `src/task-amendments.ts`), `404` on an
  unknown session.
- `DELETE /api/sessions/:id/amendments/:amendmentId` — retract one amendment: it
  stops reaching every prompt but stays in the record. `200 { "amendment" }`,
  `404` when that id does not exist on that session. Amendments are append-only;
  no route rewrites an amendment's text.
- `GET /api/amendments` — bootstrap snapshot of every non-archived session's
  amendments, keyed by session id.

  The two amendment mutations are **operator-only**: they sit behind the usual
  cookie/bearer gate and are deliberately absent from the loopback agent-ingress
  allowlist, so an agent can never amend its own task.

- `GET /api/sessions` — list active sessions; `GET /api/sessions/:id/diff`,
  `/activity`, `/usage` for inspection. The diff is committed-only
  (`<base>...HEAD`) by default; `?worktree=1` (or `true`) diffs the merge-base
  against the working tree instead, so uncommitted tracked edits are included
  (untracked files are not). `GET /api/sessions/:id/diff/annotations`
  returns best-effort per-line Diff-tab annotations (agent reasoning anchored to
  changed lines plus routed critic findings) as `{ "notes": [...] }`; it degrades
  to an empty list on any error rather than failing.
- `GET /api/sessions/:id/steer-log` — every message typed into the session since it
  started, oldest first, as `[{ "ts", "kind" }]`: time and channel only, never the
  text. `kind` is read off Shepherd's fixed steer wording — `go`, `plan_review`,
  `ci_fix`, `rebase`, `open_pr`, `nudge`, `review`, `queue`, `api_retry` — and anything else is
  `operator`. Powers the session status panel's history and loop check.
- `GET /api/sessions/:id/prompt-budget` — what that spawn's assembled system
  prompt cost, block by block: `delivery` (`append-system-prompt` for Claude,
  `inline-prompt` for Codex), `totalChars` / `totalBytes` / `totalTokens`, and a
  `blocks` array of `{ name, chars, bytes, tokens }` in emission order. Token
  figures are an **estimate** (characters ÷ 4), not a tokenizer's count.
  `404 {"error":"not found"}` for a session that predates the instrument or whose
  spawn recorded nothing. `GET /api/prompt-budget[?limit=]` returns
  `{ "records": [...] }` — the same records for recent spawns, newest first,
  across attended and drain, Claude and Codex (default 50, capped at 200; a
  missing, non-numeric or out-of-range `limit` falls back rather than `400`ing).
- `GET /api/sessions/:id/scratchpad[?path=]` — browse a live session's own
  scratchpad subtree, with the session's operator attachments overlaid as a
  synthetic read-only `attachments/` folder (New Task and mid-session
  compose-box uploads, which physically live in
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
- `GET /api/sessions/:id/worktree/status` — live git state of the session's
  worktree against its base (resolved the same way as `/diff`): `base`,
  `baseRef`, `fetchFailed`, `head`, `headSha`, `mergeBase`, `baseSha`,
  `behindBase`, `aheadOfBase`, `upstream` (`null` = never pushed),
  `unpushedCount`, `unpushed` (`[{ sha, subject, authoredAt }]`, newest first,
  capped) and `dirty`. Git fields are `null` for a non-isolated session. `404` on
  a missing/archived session; a git failure answers `500`.
- `POST /api/sessions/:id/scratchpad/upload[?path=<relDir>]` — upload an
  arbitrary binary file (multipart `file` field, no MIME restriction) into the
  session's scratchpad. `?path` selects a relative subdirectory within the
  scratchpad root (default: the root); the root is created on demand but the
  subdir must already exist. The same realpath-containment rules apply. Returns
  `{ "path": "<relpath>" }` (a colliding name is given a numeric suffix rather
  than overwriting). `400` on a missing `file` field, `413` when the file
  exceeds the upload size limit (250 MiB — `MAX_UPLOAD_BYTES` in
  `src/uploads.ts`, uniform across every upload endpoint), and `404` on a missing/archived
  session or an out-of-root `path`.

All of these honor the same auth/origin rules as task creation.

## Exporting a whole session by Task-ID

The inspection routes above are keyed on the internal session UUID and split
across several calls. For **analysing a finished session** or **re-launching it
in another CLI/model**, one endpoint returns everything at once, keyed on the
designation an operator actually sees:

```bash
curl -H "Authorization: Bearer $SHEPHERD_TOKEN" \
  http://localhost:7330/api/tasks/TASK-435/export
```

- `GET /api/tasks/:key/export` — metadata (incl. token usage), the full
  transcript (raw JSONL **and** parsed), and the diff.
- `GET /api/tasks/:key/transcript` — the untruncated raw JSONL as an
  `application/x-ndjson` download.

The raw transcript is the provider's own format: Claude Code's session JSONL, or
for Codex the rollout JSONL under `$CODEX_HOME/sessions`, located by the
session's native id (`meta.agentSessionId`). `entries` is the same parsed
activity shape for both.

`:key` is whichever identifier you hold: `TASK-435`, the bare number `435`, or
the session UUID. **Archived sessions are included** — post-hoc analysis is the
point. The bare-number form matches on the numeric suffix, so `5` resolves the
zero-padded `TASK-05`; `TASK-…` is the unambiguous form.

```jsonc
{
  "meta": {
    "desig": "TASK-435",
    "id": "<uuid>",
    "name": "...",
    "prompt": "...",
    "agentProvider": "claude",
    "agentSessionId": "<claude session / codex rollout id>",
    "model": "opus",
    "effort": null,
    "status": "archived",
    "lastState": "done",
    "repoPath": "...",
    "branch": "...",
    "baseBranch": "main",
    "worktreePath": "...",
    "isolated": true,
    "issueNumber": 1268,
    "createdAt": 0,
    "updatedAt": 0,
    "archivedAt": 0,
    "archiveReason": null,
    "usage": {/* same shape as GET /api/sessions/:id/usage */},
  },
  "transcript": {
    "format": "jsonl",
    "path": "/home/…/<agentSessionId>.jsonl",
    "raw": "…", // capped at 8 MiB — always cut on a line boundary
    "rawBytes": 551321, // FULL size on disk, not the length of `raw`
    "truncated": false,
    "unavailable": null,
    "entries": [/* the COMPLETE parsed activity, not the 30-entry live tail */],
  },
  "diff": {/* same shape as GET /api/sessions/:id/diff */},
  "diffUnavailable": null,
}
```

### Gaps are marked, never silent

A field is only empty when there is genuinely nothing there; anything Shepherd
could not resolve says so:

| Field                    | Value              | Meaning                                                                     |
| ------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `transcript.unavailable` | `no-transcript-id` | No agent session id: predates the pinned id, or the Codex id never captured |
|                          | `file-missing`     | The id is known, but its JSONL / Codex rollout is gone from disk            |
| `transcript.truncated`   | `true`             | Inline `raw` hit the 8 MiB cap — fetch `/transcript` for the full stream    |
| `diffUnavailable`        | `worktree-removed` | Archived isolated session: the transcript survives, the worktree does not   |
|                          | `no-branch`        | Non-isolated session — there is no branch to diff                           |
|                          | _an error message_ | `git` failed; the rest of the bundle is still served                        |

A truncated `raw` is still **valid JSONL** — it is cut back to the last complete
line, never mid-record — so it can be parsed as-is. (If a single record exceeds
the cap, `raw` is `""` and `rawBytes` tells you to stream instead.)

Both routes sit behind the same operator cookie/bearer gate as every other read.
They are deliberately **not** reachable through the loopback agent ingress: that
listener is auth-exempt by design, and a full transcript is the most sensitive
read in the API.
