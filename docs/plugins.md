# Server-side plugins

Shepherd can load **private, out-of-repo extensions** that run **in-process** inside the
server. This lets you customize Shepherd for yourself — the motivating example is a
`claude-swap`-style credential/account switcher that points each spawned agent at a
different `CLAUDE_CONFIG_DIR` — **without** committing that code to the public repo.

The plugin **system** (this loader, the `ctx` API, the status panel, this doc) is public
and documented. Specific plugin **implementations** stay private under
`~/.shepherd/plugins/`.

> **Trust model.** Plugins are trusted, single-author, in-process code — they run with the
> same privileges as the server. There is no sandboxing, signing, or capability
> enforcement in v1. Only run plugins you wrote or fully trust.

## Location & loading

- Plugins live in **`~/.shepherd/plugins/`** (override with `SHEPHERD_PLUGINS_DIR`).
  This sits alongside the Shepherd data dir, so plugins survive `bun run update`
  redeploys and can never leak into the public repo.
- Each plugin is a **self-contained folder**: a `plugin.json` manifest + an entry module
  (+ its own `package.json` / `node_modules` if it needs dependencies; Bun resolves them
  locally).
- At boot — **after** all core services exist and **before** the HTTP server accepts
  requests — Shepherd scans the dir (alphabetically), reads each manifest, `import()`s the
  entry, and calls `register(ctx)` **once**.
- **Load-at-boot only — no hot reload.** Enabling, disabling, or reconfiguring a plugin
  means _edit the folder, restart Shepherd_ (`systemctl --user restart shepherd`), the
  same lifecycle as every other `~/.shepherd/` setting.
- A **missing or empty** plugins dir is a clean no-op: no hooks, the Settings → Plugins
  panel stays hidden, and `/api/plugins/<id>/*` returns 404 — a fresh clone behaves
  exactly as a stock Shepherd.

## Manifest (`plugin.json`)

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "apiVersion": 1,
  "capabilities": ["spawn", "events", "state", "routes", "status"],
  "enabled": true
}
```

| Field          | Required | Meaning                                                                                                                                                           |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | Stable unique id; namespaces routes (`/api/plugins/<id>/…`) and state.                                                                                            |
| `name`         | yes      | Display name in the status panel.                                                                                                                                 |
| `version`      | yes      | Your plugin's version string.                                                                                                                                     |
| `apiVersion`   | yes      | Plugin API version. Must equal the current `PLUGIN_API_VERSION` (**1**). A mismatch is skipped + surfaced as `errored` in the panel.                              |
| `capabilities` | no       | Declared intent (`spawn`, `events`, `state`, `routes`, `status`, …). **Unenforced in v1** — advisory/documentation; the hook a permission model bolts onto later. |
| `enabled`      | no       | Soft off-switch. `false` skips the plugin at load without removing the folder.                                                                                    |

## Entry contract

The entry module (`index.ts`/`index.js`, or `package.json` `main`) exports **`register`**,
called once at boot. It may return an optional **teardown** function for clean shutdown.

```ts
import type { PluginContext } from "shepherd/plugins"; // (in-repo: src/plugins/types)

export function register(ctx: PluginContext): void | (() => void) {
  ctx.log.log("hello");
  return () => ctx.log.log("goodbye"); // optional teardown
}
```

> **Types.** Out-of-repo plugins can author untyped (the entry runs fine without type
> imports) or vendor the type definitions from `src/plugins/types.ts`. The `import type`
> line is erased at runtime, so it never affects loading.

**Two examples ship with the repo:**

- **`examples/plugins/spawn-labeler/`** — the **recommended copy-me reference**: a fuller,
  documented plugin that returns a real `SpawnPatch`, has routes that read/write `state`,
  and publishes a non-trivial status payload. Start here. See the walkthrough below.
- **`test/fixtures/example-plugin/`** — the **minimal skeleton**: the bare-minimum wiring
  as a pure observer (its `onSpawn` returns nothing). It exists mainly to back the loader
  tests — reach for it only when you want the smallest possible starting point.

Neither auto-loads from the repo (the loader only ever scans `~/.shepherd/plugins/`).

## The `ctx` capability seam

`ctx` is the **sole** seam between your plugin and core. **Never import core modules** —
everything goes through `ctx`, so a future Shepherd can swap the implementation (curated /
permission-scoped / out-of-process) without changing your call sites.

| Capability                         | What it does                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.onSpawn(fn)`                  | Mutate how an agent launches (see below). The load-bearing capability.                                                                                         |
| `ctx.events.subscribe(fn)`         | Observe the **read-only** core event stream (`session:hold`, `session:status`, …). Returns an unsubscribe fn. Plugins cannot _emit_ core events.               |
| `ctx.publishStatus(json)`          | Push a small free-form JSON blob to the status panel (rendered verbatim).                                                                                      |
| `ctx.state`                        | Durable, **per-plugin-scoped** key/value: `get`/`set`/`delete`/`keys`. Values are JSON. Backed by a `plugin_state` table — you never touch the session schema. |
| `ctx.route(method, path, handler)` | Register an HTTP route under `/api/plugins/<id>/<path>`. Sits behind operator auth.                                                                            |
| `ctx.log`                          | Namespaced logger into `shepherd.log` (`ctx.log.log` / `ctx.log.warn`).                                                                                        |
| `ctx.config`                       | Your plugin's own `config.json` (parsed; `{}` when absent).                                                                                                    |
| `ctx.abortSpawn(reason)`           | Hard-block the in-flight spawn from inside an `onSpawn` hook (throws).                                                                                         |

## The `onSpawn` hook

`onSpawn` fires **just before each agent launches**, on **both** initial create **and**
resume (autopilot/automerge/manual). It receives a **read-only descriptor** and may return
a **bounded patch**.

```ts
ctx.onSpawn((d) => {
  // d: { sessionId, repoRoot, model, agentProvider, argv, env, isolated }
  return { env: { CLAUDE_CONFIG_DIR: pickAccountDir(d.sessionId) } };
});
```

**Descriptor** (`SpawnDescriptor`) is a copy — mutating it does nothing.

- `d.env` is **advisory**: it's the explicit env overlay Shepherd will set _on top of_ the
  inherited process environment, not the full environment the agent ends up seeing. Under
  the `trusted` profile the agent additionally inherits the parent env.

**Patch** (`SpawnPatch`) — return one (or nothing):

| Field           | Effect                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env`           | Shallow-merged into the spawn env, **last** — so it wins over Shepherd's defaults, including api-key mode's credential-less-mirror `CLAUDE_CONFIG_DIR`. Reaches the agent under every sandbox profile. |
| `extraArgs`     | Appended to the inner agent argv. **Cannot rewrite core argv** (the structural flags that make Shepherd's spawn work).                                                                                 |
| `credentialDir` | Convenience for `env.CLAUDE_CONFIG_DIR`; overrides it when both are set.                                                                                                                               |

> **`model` is deliberately not patchable in v1.** Overriding the spawn model would diverge
> the stored `session.model` from the actually-spawned model and break cost replay. It is a
> documented future field, not yet implemented.

**Multiple plugins** run in registration order (load order, then within-plugin order);
patches merge sequentially, last-write-wins on conflicting keys (logged).

### Failure behavior

- **Fail-open by default.** If a hook throws or exceeds its **5-second timeout**, that
  patch is dropped, the plugin is marked `errored`/`timed-out` in the panel, and **the
  spawn proceeds** — Shepherd stays resilient.
- **Opt into hard-blocking** with `ctx.abortSpawn(reason)`: the spawn is refused. On
  **create** the request fails (and the worktree is rolled back); on a non-forced
  **resume** it resolves to "can't resume" (the session's existing state is preserved).
  Use this when running under the wrong footing is worse than not running — e.g. "if I
  can't set the right credentials, do **not** spawn under the default account."
- **Caveat — forced resume.** A _forced_ resume tears down the live agent before hooks run,
  so an `abortSpawn` there leaves the session **stopped** (there's no live agent left to
  preserve). That's intended: a forced resume is an explicit "replace the live agent", and
  aborting it honors "don't run under the wrong footing" by not spawning a replacement.

## The single-loop discipline (important)

The server is **one Bun event loop** that also pumps the web terminal. A synchronous,
blocking call (heavy `execFileSync`/`readFileSync`, a tight CPU loop) **freezes typing for
every connected operator**. Your plugin runs on that same loop, so follow the same rule
core services do:

- **Do async I/O.** Use `await`/promises, not synchronous `exec`/`fs` on the hot path.
- `onSpawn` is async and **5-second-bounded** — do credential prep (copying token files,
  etc.) with async I/O inside that budget.
- Shepherd guards against a slow/throwing hook (timeout + try/catch), but it **cannot**
  protect against a plugin's own synchronous infinite loop — that's a bug you'd fix.

## Status panel

Loaded plugins appear under **Settings → Plugins** (hidden entirely when none are loaded):
one row per plugin with its name, version, a **health badge** (`ok` / `errored` /
`timed-out`, derived by core and unspoofable — a plugin cannot report its own health), the
last error, and the expandable JSON from your last `ctx.publishStatus(...)`.

`publishStatus` emits a `plugin:status` event over the existing `/events` WebSocket, so the
panel updates live.

## HTTP routes

`ctx.route("GET", "status", handler)` serves at `GET /api/plugins/<id>/status`. All plugin
routes sit **behind operator auth** (the same cookie/token gate as the rest of `/api`). An
unknown plugin or sub-route returns 404.

## A fuller example: `spawn-labeler`

The skeleton fixture shows the wiring; **`examples/plugins/spawn-labeler/`** shows the seam
doing real work. It stamps every spawned agent with a per-repo label env var (e.g.
`SHEPHERD_SPAWN_LABEL=shepherd#3` — "the 3rd agent spawned in the `shepherd` repo"). It's a
deliberately benign, public-safe analog of the private `claude-swap` env-injection seam —
same `onSpawn → { env }` mechanic, no credential logic. Read it end to end; the highlights:

**A real `SpawnPatch` from `onSpawn`.** It increments this repo's spawn count, formats a
label, and returns an actual env overlay the agent then sees. The label is built **only
from `SpawnDescriptor` fields** — `{repo}` = `basename(d.repoRoot)`, `{n}` = the per-repo
count, `{session}` = `d.sessionId`:

```ts
ctx.onSpawn((d): SpawnPatch => {
  const repo = basename(d.repoRoot);
  const n = (repoCounts[repo] ?? 0) + 1; // noUncheckedIndexedAccess → guard the read
  repoCounts = { ...repoCounts, [repo]: n };
  const label = template.replaceAll("{repo}", repo).replaceAll("{n}", String(n));
  ctx.state.set("repoCounts", repoCounts); // spawns are infrequent → a write here is fine
  return { env: { [envVar]: label } };
});
```

**Routes that read _and_ write `state`.** `GET stats` returns the live counters;
`POST reset` clears them — so persisted state is both surfaced and mutated over HTTP, behind
operator auth:

```
GET  /api/plugins/spawn-labeler/stats   → { envVar, labelTemplate, totalSpawns, repos, lastSpawn }
POST /api/plugins/spawn-labeler/reset   → { ok: true, cleared: true }
```

**A non-trivial `publishStatus` payload.** Instead of a bare counter it publishes the config
in effect plus live totals, the per-repo breakdown, and the last spawn — all rendered in the
Settings → Plugins panel:

```jsonc
{
  "envVar": "SHEPHERD_SPAWN_LABEL",
  "labelTemplate": "{repo}#{n}",
  "totalSpawns": 4,
  "repos": { "shepherd": 3, "ui": 1 },
  "lastSpawn": { "sessionId": "…", "repoRoot": "…", "label": "shepherd#3", "at": "…" },
}
```

**Driven by `config.json`.** `ctx.config` (the folder's `config.json`, parsed) overrides the
env var name (`envVar`) and label template (`labelTemplate`); both default sensibly when
absent.

**Copy it to run it.** `cp -r examples/plugins/spawn-labeler ~/.shepherd/plugins/`, then —
because the example's `import type` uses a repo-relative path that won't resolve out-of-repo
— **drop the `import type` line or vendor `src/plugins/types.ts`** (the import is erased at
runtime, so loading is unaffected either way), and restart Shepherd. See
`examples/plugins/README.md`.
