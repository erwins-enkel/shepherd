# Spike #2135 — Is Codex app-server the control plane for interactive sessions?

**Phase-0 go/no-go.** Shepherd needs a first-party, structured way to identify and observe
interactive Codex sessions before more telemetry is built on the legacy rollout format. The
load-bearing question is whether a real human TUI and an independent app-server client can address
the same thread; the spike also tested whether app-server's direct steering surfaces fit Shepherd's
PTY-only control constraint.

## Decision: **GO for observation; NO-GO for direct steering** ⚠️

Yes. In Codex CLI **0.150.1**, Shepherd can create a thread through app-server, receive its UUID at
start, attach a real interactive TUI to that exact thread, and observe the human's turns through a
second JSON-RPC connection. The observer received typed status, item, command result, token usage,
rate-limit, approval, and turn-completion events. The experiment also proved that app-server can
CAS-steer an active turn and that `codex queue` creates a distinct subsequent turn.

Under [PRD.md](../../PRD.md), only the identity and observation half of that capability may ship.
Shepherd's hard design default requires steering by typing through `herdr agent send` into a real
PTY. `turn/steer`, `codex queue`, and direct `turn/start` input mutate the conversation outside that
PTY, so they cannot become Shepherd's operative steering path without an explicit PRD change.
App-server preserves the interactive-session substrate only as a read-only structured sidecar to a
genuine Codex TUI, not as a replacement input channel.

The constraints are material:

1. A newly started empty thread is not resumable until its first user message materializes history.
   The tested app-server-first bootstrap therefore required direct `turn/start` input before
   `codex resume <thread-id> --remote <address>` could attach. Shepherd cannot adopt that launch
   flow under the current PTY-only constraint. It first needs a verified PTY-first launch that
   exposes the thread ID, or an explicit change to the PRD.
2. The app-server process needs supervision. Remote clients do not reconnect automatically; after a
   crash Shepherd must restart/ensure the daemon, reconnect, initialize, and resume each known ID.
3. All production conversational input must continue through the live herdr PTY. The direct steer,
   queue, and new-turn APIs below are capability findings, not adoption recommendations.
4. The observer must remain passive for approvals. Approval requests are visible to both clients,
   and the human TUI must be the sole responder.
5. Rate-limit notifications are sparse and account/model-limit dependent. Seed from
   `account/rateLimits/read`, retain data by `limitId`, then merge updates or refetch.
6. The protocol and Unix-WebSocket transport are experimental. Pin behavior to the installed Codex
   version, generate its schema, gate compatibility, and retain the rollout path as a migration
   fallback until the adapter is proven in production.

This is a GO for app-server as the structured **identity and observation plane** for interactive
Codex sessions once a PTY-compatible bootstrap is proven. It is a NO-GO for app-server as the full
control plane or as a replacement for PTY typing. It is not authorization to delete the existing
rollout readers in this spike.

## Environment and evidence

| Item                  | Value                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Behavioral target     | `codex-cli 0.150.1`                                                                                                |
| Exact upstream source | [`rust-v0.150.1`, commit `9085439`](https://github.com/openai/codex/tree/90854393966b21e9ebfd21b122334eb09a20c93d) |
| Test transport        | dedicated `unix://` socket; WebSocket JSON-RPC                                                                     |
| Human client          | exact 0.150.1 `codex resume <id> --remote unix://… --no-alt-screen`                                                |
| Observer/controller   | disposable WebSocket client with `experimentalApi: true`                                                           |
| Persistence           | normal authenticated, non-ephemeral test thread under the user's Codex home                                        |

The `codex` command on PATH had advanced to 0.152.0 by execution time, so every generated artifact
and behavioral command used the cached **0.150.1 executable explicitly**. The experiment ran on
2026-09-01 against a dedicated process and socket; it did not start, stop, or reconfigure the
operator's shared managed daemon.

`codex app-server generate-ts` and `generate-json-schema` from that binary confirmed the thread,
turn, item, usage, rate-limit, approval, steering, and queue types described below. The official
[Codex App Server documentation](https://developers.openai.com/codex/app-server/) describes the
same initialize/initialized handshake, thread APIs, remote TUI, approvals, and streamed events, and
marks the app-server/WebSocket surface experimental.

The direct Unix-WebSocket client also had to disable per-message compression: 0.150.1 rejected the
default `Sec-WebSocket-Extensions` header from the `ws` package. A production client should cover
that setting in its version compatibility probe rather than assuming generic WebSocket defaults.

## Results against the issue questions

| Question                                                                 | Result                                             | Finding                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start through the daemon and learn a stable ID at start                  | **TECHNICALLY VERIFIED / NOT SHIPPABLE AS TESTED** | `thread/start` returned a Codex-generated UUIDv7 immediately, but the empty thread required direct `turn/start` input before TUI attachment. A PTY-first way to expose that ID was not tested.                                                                                                                    |
| Attach a human-usable TUI to that thread                                 | **VERIFIED**                                       | `codex resume <id> --remote unix://… --no-alt-screen` showed the prior history and a working composer. Human input produced a turn on the original ID; no fork or replacement thread was created.                                                                                                                 |
| Receive status, token, rate-limit, and tool events while the human types | **VERIFIED / PARTIAL for window population**       | The passive observer saw active/idle status, typed item lifecycle, command status and exit code, total/last token usage, turn completion, and rate-limit updates. The authenticated snapshot contained both 5-hour and weekly windows for one limit family, but only a weekly window for the main `codex` family. |
| Steer or queue the interactive session                                   | **CAPABILITY VERIFIED / NO-GO FOR ADOPTION**       | Valid `turn/steer.expectedTurnId` added input to the same active turn, and `codex queue` added pending input that became a separate next turn. Both bypass the live PTY and therefore conflict with the current PRD control constraint.                                                                           |
| Understand lifecycle and failure behavior                                | **VERIFIED with constraints**                      | One daemon hosted threads for different working directories and is scoped by Codex home, not repository. TUI exit left the thread alive. SIGINT initiated graceful drain; a hard crash disconnected both clients, required explicit reconnect/resume, and persisted the active turn as `interrupted`.             |
| Preserve human approval ownership with two clients                       | **VERIFIED with a client rule**                    | Both clients received the approval request and `waitingOnApproval` state. The observer sent no response; the TUI displayed the prompt, the human-side response approved it, and the observer then received `serverRequest/resolved`.                                                                              |

## Executed protocol

The commands below are the sanitized form of the live capability experiment, not a proposed
production input flow. `CODEX_01501` resolved to the absolute cached 0.150.1 executable, `SOCKET`
was a unique path in a disposable sibling directory, and `THREAD_ID` was copied only from
`thread/start`'s response.

```sh
"$CODEX_01501" app-server --listen "unix://$SOCKET"

"$CODEX_01501" resume "$THREAD_ID" \
  --remote "unix://$SOCKET" \
  --no-alt-screen

"$CODEX_01501" queue \
  --remote "unix://$SOCKET" \
  --thread "$THREAD_ID" \
  --message 'Reply exactly QUEUED-2135. Do not use tools.'

# Hard-crash probe only, after resolving the dedicated process's exact PID.
kill -KILL <dedicated-app-server-pid>
```

The observer connected by WebSocket directly over the Unix socket with per-message compression
disabled. It sent one request/notification pair before any thread operation:

```json
{"method":"initialize","id":1,"params":{"clientInfo":{"name":"shepherd-spike-2135","title":"Shepherd Spike #2135","version":"0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
{"method":"initialized","params":{}}
```

The creation and materialization requests were:

```json
{"method":"thread/start","id":2,"params":{"model":"gpt-5.6-luna","cwd":"<worktree>","approvalPolicy":"never","sandbox":"read-only","developerInstructions":"Disposable protocol test; do not edit files.","ephemeral":false,"threadSource":"user"}}
{"method":"turn/start","id":3,"params":{"threadId":"<thread-id>","input":[{"type":"text","text":"Reply exactly BASELINE-2135. Do not use tools."}]}}
```

The observer then called `thread/read`, `thread/resume`, and `account/rateLimits/read`; the real TUI
was launched with the command above and supplied the human-driven tool prompt and the base prompts
for steering and queueing. The controller/CLI supplied the steer, queue, and approval probes
described below. The approval probe used `turn/start` overrides
`approvalPolicy: "on-request"` and `sandboxPolicy.type: "workspaceWrite"`, then requested harmless
`pwd` with `sandbox_permissions: "require_escalated"`. The lifecycle probe closed the TUI with
`/exit`, repeated queue/approval cases without a TUI, restarted while idle, and finally used the
explicit hard-kill command only against the dedicated test PID. All IDs and transcript excerpts in
this document are placeholders or fixed test markers; generated artifacts and raw transcripts were
deleted after the run.

## Protocol findings

### Identity is first-class, but an empty thread is not yet history

`ThreadStartParams` has no caller-supplied ID. `ThreadStartResponse.thread.id` is the authoritative
Codex-generated UUIDv7, and the returned thread also carries cwd, source, status, and persistence
metadata.

The live sequence exposed one important bootstrap rule:

1. `thread/start` returned `<thread-id>` immediately with status `idle`.
2. Before any user message, `thread/read(includeTurns: true)` failed with
   `includeTurns is unavailable before first user message`.
3. `thread/resume` likewise failed with `no rollout found for thread id <thread-id>`.
4. A short `turn/start` materialized the thread. Reads, resume, remote TUI attachment, and later
   daemon restarts then preserved the same ID.

Therefore app-server can return and persist the ID at creation time, but the tested spawn handshake
cannot be adopted as-is: its materializing user message bypasses the PTY. Shepherd needs to prove
that a PTY-created thread emits a stable ID to the observer before replacing cwd-scanning, or change
the PRD deliberately. Until then this is a technical identity capability, not a shippable managed
launch flow.

The created thread reported `source: "vscode"`, not `"cli"`, even though `threadSource: "user"` was
requested. The current `source == "cli"` rollout filter is therefore not portable to this topology.
App-server's returned ID, not a source heuristic, must be the identity boundary.

### Human turns produce the structured surfaces Shepherd needs

From the attached TUI, the test prompt asked Codex to run `pwd` and emit a fixed marker. On the
observer connection, the same thread and turn produced this ordered subset:

```text
thread/status/changed               active
turn/started                        <turn-id>
item/started                        userMessage
item/started                        commandExecution status=inProgress
item/completed                      commandExecution status=completed exitCode=0
thread/tokenUsage/updated           total + last + modelContextWindow
account/rateLimits/updated          sparse snapshot for limitId=codex
item/completed                      agentMessage "HUMAN-TOOL-2135"
thread/status/changed               idle
turn/completed                      status=completed
```

`CommandExecutionStatus` is `inProgress | completed | failed | declined`, and the completed item
has a numeric `exitCode`. This directly replaces the `/^Exit code:/` inference in
`parseCodexActivity()` and avoids treating `custom_tool_call.status == "completed"` as proof of
success. `ThreadTokenUsage` supplied separate cumulative `total` and per-request `last` values plus
the context window, replacing the SQLite/rollout-tail join in `CodexUsageProvider` for live managed
threads.

Notifications are not a replay log. An adapter must seed its view with `thread/read` and
`account/rateLimits/read`, consume notifications while connected, and reconcile after reconnect.
The account snapshot returned data keyed by multiple `limitId` values: one family had primary
300-minute and secondary 10,080-minute windows, while the main `codex` family exposed only the
10,080-minute window in this account. The subsequent notification carried only that main weekly
window. Shepherd must not assume `primary == 5h` and `secondary == weekly` globally or replace a
complete cached snapshot with one sparse notification.

### Approvals are broadcast; response ownership is an adapter rule

With approval policy `on-request`, the test deliberately requested an escalated harmless `pwd`.
Both connections observed:

```text
thread/status/changed     activeFlags=[waitingOnApproval]
item/commandExecution/requestApproval
```

The independent observer remained passive. The TUI displayed the reason and command, accepted the
human-side `Yes, proceed`, and the observer received `serverRequest/resolved`; the command then
completed with exit code 0. This proves that a passive telemetry connection does not steal an
approval. It also proves why passivity is load-bearing: multiple subscribed clients can see a
server request, so Shepherd must not install a generic auto-responder on its observer connection.

### Steering and queueing have distinct semantics

During a TUI turn whose command was still active, the observer sent:

```json
{
  "method": "turn/steer",
  "params": {
    "threadId": "<thread-id>",
    "input": [{ "type": "text", "text": "Also include marker STEERED-2135" }],
    "expectedTurnId": "<active-turn-id>"
  }
}
```

The response returned the same turn ID. The observer then saw a second `userMessage` item inside
that turn, no second `turn/started`, and the final answer contained `STEERED-2135`. A previous turn
ID while another turn was active failed with JSON-RPC `-32600` and named both expected and actual
IDs. Steering after the thread became idle failed with `-32600: no active turn to steer`.

By contrast:

```sh
codex queue --remote unix://<socket> \
  --thread <thread-id> \
  --message 'Reply exactly QUEUED-2135.'
```

accepted the message while another TUI turn was active. After that turn completed, the observer saw
`thread/queue/changed`, then a **new** `turn/started` and the queued marker's response. Queueing is
pending next-turn input; it does not mutate the active turn. This experiment did not separately
test whether an unstarted queue entry survives a hard daemon crash.

This invalidates the central premise in `resumeThenSteer()` that the Codex thread necessarily dies
when its TUI exits: app-server retains the thread. It does **not** invalidate the PRD's input rule.
Shepherd must still relaunch or retain the pane and deliver active or idle input through
`herdr agent send`. CAS-steer, queue, and new-turn delivery remain tested upstream capabilities that
may be reconsidered only after an explicit change to the PTY-only constraint.

## Lifecycle and recovery

### Scope and ownership

A second `thread/start` with a different disposable cwd succeeded on the same process, proving the
daemon is not repository-scoped. The exact 0.150.1 managed-daemon source derives its control state
and socket from `CODEX_HOME`, records PID plus process start time, serializes startup, and treats
start as idempotent while that process is live. This is a shared **per-Codex-home/user** service.

The PID backend detects stale records, but it is not a crash watchdog. Production Shepherd must
ensure/start the managed daemon or supervise its own process, while avoiding competing ownership of
the shared daemon. The existing `SocketHerdrDriver` is a useful transport precedent, but app-server
uses WebSocket upgrade over the Unix socket rather than herdr's framing.

### TUI exit, graceful stop, and crash

- `/exit` closed only the TUI. The observer immediately read the same thread and complete history;
  daemon ownership continued without a pane.
- With no TUI connected, `codex queue` immediately started and completed a new turn whose fixed
  marker was visible to the observer. A queued turn therefore does not require a pane; for exactly
  that reason, Shepherd must not use it as a production input path under the current PRD.
- With no TUI connected, an escalated command entered `waitingOnApproval` and remained there with no
  further event for five seconds. Nothing auto-approved it. The observer then sent an explicit
  `cancel` response for cleanup; the command completed as `declined` and the turn as `interrupted`.
  Unattended work that might request approval therefore needs an explicit policy: attach/route to a
  human UI, cancel it, or use a policy that cannot request approval.
- An idle daemon stop closed the WebSocket without a normal close handshake. After restart, a fresh
  connection completed `initialize`/`initialized`, resumed the original ID, and recovered history,
  status, settings, and the latest token snapshot.
- `SIGINT` during an active turn initiated graceful drain in 0.150.1 rather than an immediate
  failure. A separate hard-crash probe killed only the dedicated app-server process while a bounded
  `sleep` command was active. Both observer and TUI disconnected; the TUI exited with a WebSocket
  connection-reset error and instructions to resume. It did not reconnect automatically.
- After hard-crash restart, `thread/read` returned status `notLoaded` and preserved the incomplete
  turn as `interrupted` with its user message. `thread/resume` returned the same ID, changed status
  to `idle`, and retained the interrupted history. No completion notification could be recovered
  for the disconnected interval.
- No client-initiated JSON-RPC request ID was deliberately left pending at the instant of the hard
  kill, so the exact pending-request error response was not measured live. The observer connection
  closed abnormally (`1006`) and the TUI reported connection reset; the 0.150.1 client source also
  rejects outstanding requests when its transport worker exits. An adapter must treat every
  unresolved request on disconnect as failed/indeterminate and must not wait for a response on the
  replacement connection.

Required recovery is therefore explicit:

```text
ensure/restart app-server
  → reconnect WebSocket
  → initialize + initialized
  → thread/resume for each persisted Shepherd thread ID
  → seed read/snapshot state
  → relaunch remote TUI when the user pane is required
```

Shepherd must treat in-flight turns as uncertain until the resumed history says `completed`,
`failed`, or `interrupted`; it cannot infer success from the old connection disappearing.

## Consequences for Shepherd

| Current seam                                      | App-server consequence                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findCodexRollout()` / `findCodexSessionId()`     | Replace cwd/source attribution only after a PTY-first launch is shown to expose its stable ID. The tested direct-materialization bootstrap is not yet an adoptable replacement. |
| `CodexUsageProvider`                              | Seed account limits, merge sparse per-`limitId` updates, and retain `ThreadTokenUsage.total/last`; keep the legacy provider as fallback during migration.                       |
| `parseCodexActivity()` / `CodexTranscriptLocator` | Consume typed status, turn, item, command, diff, and plan events read-only; define reconnect reconciliation before removing persisted transcript fallback.                      |
| `resumeThenSteer()`                               | Keep resume/relaunch plus `herdr agent send` as the operative input path. App-server status can inform recovery, but must not deliver the prompt directly.                      |
| Non-isolated restore (#1476)                      | The daemon ID removes cwd ambiguity only if Shepherd can learn it from a PTY-first session; that prerequisite remains unverified.                                               |
| `/fork` session-ID staleness                      | Observe the new ID from events caused by a TUI-driven `/fork`; do not invoke direct `thread/fork` as the normal control path.                                                   |
| Rate-limit windows                                | App-server is the only tested typed surface that exposes the account windows absent from `codex exec --json`; population must remain account/limit aware.                       |

The recommended adoption is staged: add a version-gated, read-only app-server observer, keep the
TUI in herdr, and keep every prompt and command delivery on `herdr agent send`. Before app-server
owns managed-session launch, prove that a PTY-first thread reports its stable ID without a direct
first turn; otherwise changing that launch flow requires an explicit PRD decision. Dual-run and
fall back to existing readers until bootstrap, reconnect, and event reconciliation have production
coverage. The rollout adapter in #1816 remains necessary for unmanaged, older, and not-yet-
attributable sessions.

## Rollout-format conclusion

`codex migrate-rollouts` calls the current local sessions **legacy**, so new long-lived telemetry
should not be coupled more deeply to `$CODEX_HOME/sessions/**/rollout-*.jsonl`. The live 0.150.1
thread still reported `historyMode: "legacy"` and a rollout path, which shows that app-server
abstracts that store; it does not magically migrate the underlying history in this release.

There is no published removal deadline. Therefore:

- build new managed-session observation features against the typed read-only plane while retaining
  PTY typing for control;
- keep rollout readers as a bounded fallback until app-server compatibility and reconnect behavior
  are shipped and measured;
- do not assume the legacy files remain stable merely because 0.150.1 app-server currently uses
  them internally; and
- do not delete or broaden the rollout adapter as part of this spike.

## Sources

- [Official Codex App Server documentation](https://developers.openai.com/codex/app-server/) —
  rich-client scope, initialization, transports, generated schema, threads, turns, approvals, and
  remote TUI behavior.
- [Codex `rust-v0.150.1` exact source](https://github.com/openai/codex/tree/90854393966b21e9ebfd21b122334eb09a20c93d) —
  app-server, protocol, client, daemon, TUI, subscriber fan-out, and lifecycle implementation.
- [Exact app-server protocol source](https://github.com/openai/codex/tree/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server-protocol) —
  v2 request/response/notification definitions used by generated TypeScript and JSON Schema.
- Local context: [`docs/research/codex-sdk-evaluation.md`](../research/codex-sdk-evaluation.md),
  [`docs/spikes/1175-codex-restore.md`](1175-codex-restore.md),
  [`src/service.ts`](../../src/service.ts),
  [`src/resume-then-steer.ts`](../../src/resume-then-steer.ts),
  [`src/codex-session-id.ts`](../../src/codex-session-id.ts),
  [`src/codex-usage.ts`](../../src/codex-usage.ts),
  [`src/codex-activity.ts`](../../src/codex-activity.ts), and
  [`src/herdr-socket-driver.ts`](../../src/herdr-socket-driver.ts).
