# Would `@openai/codex-sdk` improve Shepherd's Codex integration?

**Verdict: NO — not as posed, and the question points at the wrong layer.** `@openai/codex-sdk` is a
~550-line wrapper that spawns `codex exec --experimental-json` as a child process and parses its
JSONL into typed events. It adds **no capability Shepherd cannot get from the CLI it already
spawns**, while adding a second pinned `codex` binary inside `node_modules`, a new version-coupling
constraint, and an `originator` marker on every request. Meanwhile the flags Shepherd is _not_ using
(`--json`, `--output-schema`, `--thread-source`, `--ignore-user-config`, `--ephemeral`) would retire
most of the fragile parsing in the Codex integration — one of them, `--json`, needs a stdout
delivery path first (§3.2) — and the
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
todo_list | error`, and a `Usage {input_tokens, cached_input_tokens, cache_write_input_tokens,
output_tokens, reasoning_output_tokens}` on `turn.completed` (`dist/index.d.ts`).

**There is no thread-id pinning** — `startThread()` takes no id; `thread.id` is populated only after
the first turn starts. That is not an SDK omission: `codex-rs/exec/src/cli.rs` on `main` carries no
`--session-id`/`--thread-id` either, so the CLI can no more pin one today than 0.142.5 could when
#1175 reached the same conclusion. There is no steering of a running turn, no approval callback, no
interrupt beyond an `AbortSignal`, no rate-limit surface, and no interactive mode.

Two sharp edges in what it does emit. **`turn.completed.usage` is cumulative since thread start, not
the turn's delta** — despite the doc comment reading "during the turn", the JSONL writer fills it
from `last_total_token_usage.total`, while the protocol's `ThreadTokenUsage` carries both a `total`
and a `last` breakdown and the exec path reads `total`; a second `run()` on the same thread reports
both turns' cost. And **the SDK does not validate what it parses** — it casts each line as
`JSON.parse(line) as ThreadEvent`, while its TS unions are a strict subset of the Rust protocol
(Rust's `ThreadItemDetails` has a `CollabToolCall` variant the TS `ThreadItem` lacks;
`CommandExecutionStatus` has a fourth `Declined` value TS omits). An unmodelled event arrives as a
well-typed lie rather than an error — an argument for parsing the stream under Shepherd's own
validation whichever route is taken.

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
| token usage (cumulative) | `turn.completed.usage` in that stream | scraped from `state_N.sqlite` + rollout tails |
| thread classification    | `--thread-source <SOURCE>`            | not used — `source == "cli"` heuristic        |
| config overrides         | `-c key=value`                        | used (effort only)                            |
| working dir / extra dirs | `-C`, `--add-dir`                     | not used                                      |
| no session files on disk | `--ephemeral`                         | not used                                      |
| cancellation             | kill the child                        | herdr pane teardown                           |

One caveat governs that whole first column: **`--json` prints to stdout, and Shepherd never reads a
role's stdout.** Roles are launched into a herdr pane with their argv wrapped as `env … <argv>` — no
shell, so no redirection and no pipe (`src/herdr.ts:604-630`) — and the read path polls for a _file_
in the spawn's cwd (`readRoleResultText`; the rundown's launch/poll shape is
`src/herd-digest.ts:384-397`). Consuming the event stream therefore costs a delivery path, not just
a flag: either a wrapper that redirects stdout to a file the poller tails, or spawning roles directly
instead of into a pane — which is precisely how the SDK gets the stream (`child.stdout` of its own
`spawn`), and precisely what costs the pane and its `terminalId`.

One thing that stream does **not** carry: the **5h/weekly rate-limit windows**. The exec JSONL
processor maps `ThreadTokenUsageUpdated` into `Usage` and emits no rate-limit variant at all, and the
upstream request to add one (`openai/codex#14728`, "emit rate_limits in exec mode JSONL output") was
closed by a maintainer with _"This feature hasn't received any upvotes, so closing"_. So
`src/codex-usage.ts`'s rollout + SQLite scraping has **no** replacement in the SDK or in
`codex exec --json`; that signal exists only in the richer app-server protocol (§4).

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
  the operator's full user config. Every Claude role, by contrast, gets `disableAllHooks`,
  `tui:"default"`, `--disable-slash-commands`, a per-kind `--allowedTools` allowlist and
  `--permission-mode dontAsk` (`src/transient-agent-argv.ts:244-263`). `--safe-mode` is **not**
  universal on the Claude side: it is emitted only for the `mcpIsolated` presets — `reviewer` and
  `doc` — coupled to `enableAllProjectMcpServers` so the two cannot drift apart
  (`src/transient-agent-argv.ts:170-173,245,258`). 0.150.1 offers `--ignore-user-config`,
  `--ignore-rules` and `--dangerously-bypass-hook-trust` to close the Codex side of the gap.
- **Codex is growing its own remote control.** `codex remote-control {start,stop,pair}` with
  pairing codes, plus `codex --remote ws://…`, is first-party remote driving of local sessions. Not
  a threat to Shepherd's orchestration, but it is adjacent enough to be worth watching.

## 6. Recommendation

**Do not adopt `@openai/codex-sdk`.** Instead, in this order:

1. **Choose a delivery path for the event stream, then consume it.** `--json` on `codexRoleArgv`
   (`src/codex-role-argv.ts:31-45`) emits the typed events on stdout, which a herdr-launched pane
   does not hand back (§3.2). So this is two decisions, not one flag: pick the transport (redirect
   stdout to a file the role poller tails, or spawn roles off-pane and accept losing the pane), then
   parse `turn.completed` / `item.completed` with the existing `eachJsonlObject`. The payoff is the
   token totals and live tool-use surfacing the header comment currently concedes "degrade to null"
   (`src/codex-role-argv.ts:23`) — but the transport is the part to price.
2. **Keep `-o` as the transport; add `--output-schema` to fix what lands in it.** `-o <FILE>` is the
   only reason a role's final message reaches a file at all, so it stays until step 1 supplies
   another path — `--output-schema` constrains the _shape_ of the final response, never its
   destination, and dropping `-o` for it would leave the read path with nothing to read. What it
   does buy: the fallback stops being "whatever prose the model emitted, which then fails the
   caller's validation" and becomes schema-conforming JSON, which is the actual failure mode behind
   `src/codex-last-message.ts:6-13`. The per-spawn unguessable filename stays load-bearing exactly
   as long as `-o` does (`src/codex-last-message.ts:18-25`).
3. **Tag role spawns with `--thread-source` — and re-verify the `source == "cli"` exclusion while
   there.** `--thread-source` sets a _classification_ on newly created threads (explicitly not on
   resume), so a custom value would make the role-vs-interactive split in
   `src/codex-session-id.ts:15-16` explicit instead of incidental. Verify first: the app-server
   `SessionSource` union generated from the installed 0.150.1 still lists `"cli"`, but the
   `--thread-source` domain is a different set that defaults to `"user"`, and restore breaks
   silently the day what lands in `session_meta.source` changes.
4. **Close the role-isolation gap** with `--ignore-user-config` / `--ignore-rules` (§5).
5. **Spike `codex app-server`** (a #1175-shaped go/no-go): can Shepherd start a thread through the
   daemon, learn its id at start, attach an interactive `codex --remote` pane to that same thread,
   and receive `ThreadStatus` / `ThreadTokenUsage` / `TurnSteer` against it? A yes retires the
   rollout scrapers, unblocks non-isolated restore (#1476) and `/fork` staleness at once — and does
   so _without_ leaving the interactive-session substrate. A no costs one spike.

Steps 2-4 are small and independent. Step 1 is small only once its transport is settled, and step 5
is the one worth a plan.

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

Upstream Rust sources read on `main` for §2: `codex-rs/exec/src/cli.rs`,
`codex-rs/exec/src/exec_events.rs`, `codex-rs/exec/src/event_processor_with_jsonl_output.rs`, and
`openai/codex` issues #14728 (rate-limit emission, declined) and #14880 (`rate_limits` always null in
rollouts, open). Note when checking those: this repo reports `state_reason: "completed"` on issues
closed as duplicates and as won't-fix alike, so the API field alone does not mean a feature shipped.

**Not verified here:** whether an app-server thread and a `codex --remote` TUI pane can address the
same session (§4); whether `xhigh`/`max`/`ultra` are accepted per model (§5); and whether a
0.150.1-written `session_meta.source` still reads `"cli"` for an interactive spawn (§6, step 3). All
three are named as spike/verify items rather than treated as established.
