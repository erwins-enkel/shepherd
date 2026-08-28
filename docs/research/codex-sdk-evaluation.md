# Would `@openai/codex-sdk` improve Shepherd's Codex integration?

**Verdict: NO — not as posed, and the question points at the wrong layer.** `@openai/codex-sdk` is a
~550-line wrapper that spawns `codex exec --experimental-json` as a child process and parses its
JSONL into typed events. It adds **no capability Shepherd cannot get today by adding two flags to
one argv builder**, while adding a second pinned `codex` binary inside `node_modules`, a new
version-coupling constraint, and an `originator` marker on every request. Meanwhile the flags
Shepherd is _not_ using (`--json`, `--output-schema`, `--thread-source`, `--ignore-user-config`,
`--ephemeral`) would retire the most fragile code in the Codex integration **this week**, and the
capability tier that would actually change Shepherd's architecture — `codex app-server`, a typed
JSON-RPC daemon with first-class thread ids, steering, status and usage — is something the SDK
**does not use at all**.

> Engineering evaluation, **2026-08-28**, against Codex CLI **0.150.1** (the version installed on
> this host) and `@openai/codex-sdk@0.150.1`. A capability map and recommendation, not a committed
> plan. Read-only research task: this document is the entire diff.

---

## 1. What Shepherd does today

Shepherd never links a provider library. Both runtimes are CLI subprocesses launched through
**herdr**, and Shepherd's job is to build the argv (`src/herdr.ts:604-630`, `buildWrappedArgv`).

| Surface                   | How it is built / read today                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive session       | `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox [-m M] [-c model_reasoning_effort=T] "<prompt>"` (`src/service.ts:3107-3143`)     |
| Resume                    | `codex resume <uuid>\|--last …` (`src/service.ts:3155-3179`)                                                                                        |
| Helper roles (13 of them) | `codex exec --sandbox workspace-write [-m M] [-c model_reasoning_effort=T] [-o <file>] "<prompt>"` (`src/codex-role-argv.ts:31-45`)                 |
| Session id                | scan `$CODEX_HOME/sessions/**/rollout-*.jsonl`, parse line 1 `session_meta`, match `cwd` + `source == "cli"` (`src/codex-session-id.ts:1-18,75-92`) |
| Token usage               | `bun:sqlite` over Codex's `state_N.sqlite` + `rate_limits.*` events tailed out of rollout JSONL (`src/codex-usage.ts:118-176,200-275`)              |
| Tool activity             | three ad-hoc regexes over JSON-embedded strings in rollout records (`src/codex-activity.ts:34-42,48-58,68-76`)                                      |
| Final answer              | `-o <file>` last-message fallback, because Codex sometimes answers in chat and never writes the result file (`src/codex-last-message.ts:6-13`)      |
| Steering                  | resume-then-steer + bracket-paste into the pane, because "Codex EXITS after its turn" (`src/resume-then-steer.ts:21-23`)                            |

Two structural facts follow. First, **every structured signal is reverse-engineered from Codex's
private on-disk state** — no documented schema, which is why `src/codex-activity.ts:34-38` has to
note that `custom_tool_call.status` was `"completed"` in 897/897 sampled rollouts and fall back to
matching `/^Exit code:\s*(\d+)/m`. Second, there is **no runtime adapter interface**: parity is held
by `AgentProvider = "claude" | "codex"` (`src/types.ts:14-15`) branching inside shared functions.

## 2. What `@openai/codex-sdk` actually is

Verified from the published artifact, not from documentation:

```
$ curl -s https://registry.npmjs.org/@openai%2Fcodex-sdk/latest
  "name": "@openai/codex-sdk", "version": "0.150.1", "license": "Apache-2.0",
  "engines": { "node": ">=18" }, "type": "module",
  "dependencies": { "@openai/codex": "0.150.1" }        ← exact pin, no range
  "unpackedSize": 79397, "fileCount": 6
```

The tarball is `LICENSE`, `README.md`, `package.json`, and `dist/index.{js,d.ts,js.map}` — 549 lines
of shipped JavaScript. Its own README states the mechanism plainly:

> "The TypeScript SDK wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges
> JSONL events over stdin/stdout."

`dist/index.js` confirms it line by line:

- `import { spawn } from "child_process"` (line 140), and the argv it builds is
  `["exec", "--experimental-json", …]` (line 177) plus `--config`, `--model`, `--thread-source`,
  `--sandbox`, `--cd`, `--add-dir`, `--skip-git-repo-check`, `--output-schema`, `--image`, and
  `resume <threadId>` (lines 180-241) — i.e. **exactly the public `codex exec` flag surface**.
- The binary is resolved out of the `@openai/codex` npm package via
  `moduleRequire.resolve("@openai/codex/package.json")` plus a per-platform optional dependency
  (`@openai/codex-linux-x64`, …; lines 148-155, 446-459). `codexPathOverride` can point it elsewhere.
- Every spawn sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts` unless already set (lines
  145-146, 254-256) — SDK traffic is **server-side attributable** as SDK traffic.
- Auth is inherited: it passes `process.env` through by default (so an existing
  `~/.codex/auth.json` ChatGPT login works), and only sets `CODEX_API_KEY` when an `apiKey` option
  is given (lines 245-259).

Its public API is small and closed: `new Codex(options)`, `codex.startThread(opts)`,
`codex.resumeThread(id, opts)`, `thread.run(input, {outputSchema, signal})`,
`thread.runStreamed(...)`, `thread.id`. Events are
`thread.started | turn.started | turn.completed | turn.failed | item.started | item.updated |
item.completed | error`, with items
`agent_message | reasoning | command_execution | file_change | mcp_tool_call | web_search |
todo_list | error`, and a per-turn `Usage {input_tokens, cached_input_tokens,
cache_write_input_tokens, output_tokens, reasoning_output_tokens}` (`dist/index.d.ts`).

**There is no thread-id pinning** — `startThread()` takes no id; `thread.id` is populated only after
the first turn starts. There is no steering of a running turn, no approval callback, no interrupt
beyond an `AbortSignal`, no rate-limit surface, and no interactive mode.

## 3. Why it is the wrong lever for Shepherd

### 3.1 It is blocked outright for user sessions

`PRD.md:48-52` names it a non-goal: _"No Agent SDK, no `claude -p` on a sub **by default**… Agent SDK
credit remains out of scope; it reopens the interactive-substrate thesis."_ `README.md:73-81` states
the same for Codex: _"driven the same way — a genuine interactive terminal session, never a headless
or scripted invocation."_ The SDK is precisely a headless, scripted invocation, and it stamps its own
originator id on the request so the distinction is not even ambiguous to the provider. For the herd's
interactive sessions this is a product-constraint no, before it is a technical one.

### 3.2 For helper roles, it buys flags Shepherd can pass itself

Roles are already headless `codex exec`, so the compliance argument does not bite there — but the SDK
still adds nothing, because it is a _thin_ wrapper. Everything it offers is a flag on the CLI
Shepherd already spawns. Verified on the installed 0.150.1 (`codex exec --help`, and
`--experimental-json` confirmed accepted as a hidden alias of `--json`):

| SDK feature              | The CLI flag behind it                | Shepherd today                                |
| ------------------------ | ------------------------------------- | --------------------------------------------- |
| typed event stream       | `--json` / `--experimental-json`      | not used — panes + rollout scraping           |
| structured final output  | `--output-schema <FILE>`              | not used — the `-o` last-message hack         |
| per-turn token usage     | `turn.completed.usage` in that stream | scraped from `state_N.sqlite` + rollout tails |
| thread classification    | `--thread-source <SOURCE>`            | not used — `source == "cli"` heuristic        |
| config overrides         | `-c key=value`                        | used (effort only)                            |
| working dir / extra dirs | `-C`, `--add-dir`                     | not used                                      |
| no session files on disk | `--ephemeral`                         | not used                                      |
| cancellation             | kill the child                        | herdr pane teardown                           |

Adopting the SDK to get these means: a second `codex` binary in `node_modules` pinned to an exact
version (`"@openai/codex": "0.150.1"`), diverging from the operator's on-PATH install that
`src/codex-update.ts` exists to keep correct across `codex update` / npm / mise (`src/codex-update.ts:146-158`);
role spawns leaving herdr, so they lose their pane and `terminalId` (`src/herd-digest.ts:384-397`)
and with it the observability of a running critic; and Node-18 semantics inside a Bun server. The
payoff is a flag string Shepherd can write in one line.

### 3.3 The stream it parses is available to Shepherd directly

The event union in `dist/index.d.ts` is documented there as _"Top-level JSONL events emitted by
`codex exec`"_ — the SDK's types **are** the CLI's `--json` schema. Shepherd already owns a JSONL
reader (`src/jsonl.ts`, `eachJsonlObject`, used by `src/codex-activity.ts:3`). Consuming
`codex exec --json` directly gives the identical events with zero new dependencies, and the SDK's
`.d.ts` can be read as free schema documentation for them.

## 4. Where the real upgrade is: `codex app-server`

Codex 0.150.1 ships a subcommand set Shepherd's integration predates. From `codex --help` on this
host: `app-server` (`[experimental] Run the app server or related tooling`), `remote-control`,
`agents` (`Browse all agent sessions on the shared local app-server daemon`), `queue`
(`Queue a message for an existing session`), `fork`, `archive`/`unarchive`/`delete`, and
`migrate-rollouts` (`Inspect or migrate legacy local sessions to paginated thread history`).

`codex app-server --listen` accepts `stdio://`, `unix://PATH` or `ws://IP:PORT`, and — decisively —
**ships its own typed contract**: `codex app-server generate-ts --out <DIR>` emits the protocol as
TypeScript, and `generate-json-schema` as JSON Schema. Running it on this host produced **94 top-level
types plus 595 in `v2/`**. The ones that map onto Shepherd's hand-rolled scrapers:

| Shepherd's current hack                              | First-party protocol type                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| rollout-header scan for the session id               | `ThreadStartResponse.thread` — the id is returned at start (`ThreadId`, documented UUIDv7)       |
| `source == "cli"` disambiguation                     | `SessionSource = "cli" \| "vscode" \| "exec" \| "mcp" \| {custom: string} \| …`; `ThreadSource`  |
| `state_N.sqlite` + rollout tail for tokens           | `ThreadTokenUsage {total, last, modelContextWindow}`, `ThreadTokenUsageUpdatedNotification`      |
| `rate_limits.primary/.secondary` regex over rollouts | `AccountRateLimitsUpdatedNotification`, `AccountTokenUsageSummary`                               |
| pane-text stall/blocked detection                    | `ThreadStatus = notLoaded \| idle \| active \| systemError`, `ThreadStatusChangedNotification`   |
| `/^Exit code:/` regex for tool failure               | `CommandExecutionStatus`, `ItemCompletedNotification`, `CommandExecutionOutputDeltaNotification` |
| resume-then-steer + bracket paste                    | `TurnSteerParams {threadId, input, expectedTurnId}` — steer an **active** turn, with a CAS guard |
| no diff/plan surface                                 | `TurnDiffUpdatedNotification`, `TurnPlanUpdatedNotification`, `ThreadInjectItemsParams`          |
| `/fork` staleness (populate-once id)                 | `ThreadForkParams`/`ThreadForkResponse`, `ThreadStartedNotification`                             |

Two properties matter beyond the table. **The daemon is shared** (`codex agents` browses "all agent
sessions on the shared local app-server daemon"), and the interactive TUI can attach to it
(`codex --remote <ADDR>`, `unix://PATH` or `ws://…`). That is the shape in which structured control
and a genuinely interactive session stop being mutually exclusive — the same bet Shepherd already
made on herdr's Unix-socket JSON-RPC driver (`src/herdr-socket-driver.ts`, `config.herdrSocket`).
Whether a Shepherd-spawned TUI pane and an app-server subscription can address the _same_ thread is
the one load-bearing question this evaluation did **not** verify — it needs a spike, exactly like
#1175 did for restore.

`codex queue --thread <UUID> --message <TEXT>` is the cheap half of that: steering an existing
session by id, without a PTY write and without resume-then-steer.

## 5. Risks this evaluation surfaced (independent of any decision)

- **The rollout format is being migrated.** `codex migrate-rollouts` — _"Inspect or migrate legacy
  local sessions to paginated thread history"_ — means the `$CODEX_HOME/sessions/**/rollout-*.jsonl`
  layout that `src/codex-session-id.ts`, `src/codex-usage.ts` and `src/codex-activity.ts` all parse
  is now explicitly **legacy**. Every restore, usage figure and activity row rests on it.
- **`sqlite_home` already breaks usage** on hosts that relocate it (Codex 0.146+); `codexHome()`
  (`src/codex-usage.ts:52`) only looks under `$CODEX_HOME`. Flagged in
  `docs/research/claude-code-codex-release-parity-2026-07-29.md` §2, still open.
- **The effort clamp may be stale.** `effortForSpawn` clamps `xhigh`/`max` → `high` for Codex
  ("Codex's domain tops out at `high`", `src/default-effort.ts:88-92`), but the 0.150.1 SDK types
  `ModelReasoningEffort` as `"minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"`.
  Worth re-verifying per model before trusting either.
- **Role isolation parity.** Codex roles get only `--sandbox workspace-write` and otherwise inherit
  the operator's full user config, while Claude roles get `disableAllHooks` +
  `--disable-slash-commands` + `--safe-mode` (`src/transient-agent-argv.ts:222-260`). 0.150.1 offers
  `--ignore-user-config`, `--ignore-rules` and `--dangerously-bypass-hook-trust` to close that gap.
- **Codex is growing its own remote control.** `codex remote-control {start,stop,pair}` with
  pairing codes, plus `codex --remote ws://…`, is first-party remote driving of local sessions. Not
  a threat to Shepherd's orchestration, but it is adjacent enough to be worth watching.

## 6. Recommendation

**Do not adopt `@openai/codex-sdk`.** Instead, in this order:

1. **Consume the event stream Shepherd already pays for.** Add `--json` to `codexRoleArgv`
   (`src/codex-role-argv.ts:31-45`) and parse `turn.completed` / `item.completed` with the existing
   `eachJsonlObject`. This gives Codex roles the token totals and live tool-use surfacing that the
   header comment currently concedes "degrade to null" (`src/codex-role-argv.ts:23`).
2. **Replace the `-o` last-message hack with `--output-schema`.** The entire mechanism in
   `src/codex-last-message.ts` — including the per-spawn unguessable filename defending against a
   PR pre-seeding a verdict file — exists because Codex may answer in chat instead of writing the
   result file. A schema-constrained final response removes the failure mode rather than catching it.
3. **Tag role spawns with `--thread-source`.** `SessionSource` accepts `{custom: string}`, which
   makes the `source == "cli"` exclusion in `src/codex-session-id.ts:15-16` explicit instead of
   incidental.
4. **Close the role-isolation gap** with `--ignore-user-config` / `--ignore-rules` (§5).
5. **Spike `codex app-server`** (a #1175-shaped go/no-go): can Shepherd start a thread through the
   daemon, learn its id at start, attach an interactive `codex --remote` pane to that same thread,
   and receive `ThreadStatus` / `ThreadTokenUsage` / `TurnSteer` against it? A yes retires the
   rollout scrapers, unblocks non-isolated restore (#1476) and `/fork` staleness at once — and does
   so _without_ leaving the interactive-session substrate. A no costs one spike.

Steps 1-4 are small, independent, and each deletes code that exists only to work around a missing
flag. Step 5 is the one worth a plan.

---

## Sources

Primary artifacts, all verified on this host on 2026-08-28:

- `codex --version` → `codex-cli 0.150.1`; `codex --help`, `codex exec --help`, `codex queue --help`,
  `codex app-server --help`, `codex app-server daemon --help`, `codex remote-control --help`,
  `codex agents --help`.
- `codex app-server generate-ts --out <dir>` — 94 + 595 generated protocol types.
- npm registry manifest `https://registry.npmjs.org/@openai%2Fcodex-sdk/latest` (v0.150.1) and the
  published tarball `@openai/codex-sdk-0.150.1.tgz` (`README.md`, `dist/index.d.ts`, `dist/index.js`).
- Shepherd source and docs as cited inline, notably `PRD.md`, `README.md`,
  `src/codex-role-argv.ts`, `src/codex-last-message.ts`, `src/codex-session-id.ts`,
  `src/codex-usage.ts`, `src/codex-activity.ts`, `src/default-effort.ts`, `src/service.ts`,
  `src/transient-agent-argv.ts`, `docs/spikes/1175-codex-restore.md`,
  `docs/research/claude-code-codex-release-parity-2026-07-29.md`,
  `docs/research/mcp-parity-across-runtimes.md`.

**Not verified here:** whether an app-server thread and a `codex --remote` TUI pane can address the
same session (§4), and whether `xhigh`/`max`/`ultra` are accepted per model (§5). Both are named as
spike/verify items rather than treated as established.
