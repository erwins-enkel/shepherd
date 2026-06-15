# Expanded use of Claude Code hooks to drive richer information into Shepherd

_Research report — 2026-06-15. Reference + design material; no code in this PR._

## TL;DR

Shepherd's knowledge of what a running agent is doing is built **100% by polling
after the fact**: `herdr` agent-list every ~1 s, a bounded transcript-tail parse every
~7 s, and regex scraping of the PTY terminal buffer to guess "blocked / awaiting input".
This works, but it is laggy (up to ~7 s to notice activity), fragile (terminal-text and
transcript-silence heuristics), and runs reads on the single Bun event loop that also
pumps the web terminal.

Claude Code's **hooks** are a push-based, structured, near-zero-latency event stream
emitted by the agent itself at well-defined lifecycle points (tool calls, notifications,
turn end, session start/end, subagent start/stop, …). Crucially, **Shepherd already owns
the two things needed to consume them**:

1. **The injection point** — `spawnSettingsOverlay()` (`src/service.ts:203`) already
   composes the per-spawn `--settings` JSON. A `hooks` block dropped here ships
   monitoring hooks to every Shepherd-spawned agent without touching the operator's
   global config.
2. **The transport** — the build-queue feature already hands every agent a `baseUrl`,
   its `sessionId`, and a bearer `token`, and has it `curl ${baseUrl}/api/sessions/${id}/queue`
   (`src/service.ts:408-456`). An HTTP-type hook (or a `curl` command hook) POSTing to a
   sibling `/api/sessions/:id/hooks` route is a near-trivial extension of plumbing that is
   **already in production and already reachable through the sandbox**.

**Recommendation:** adopt hooks as an _additive, observe-only_ signal source, starting
with the two events that retire the most fragile current heuristics — `Notification`
(authoritative "awaiting input / idle", replacing PTY scraping) and `PostToolUse`
(instant structured activity, replacing the 7 s tail parse) — behind a config flag, with
polling retained as the fallback. Then layer `SessionStart` / `Stop` / `SubagentStop` for
precise lifecycle edges. This is a multi-PR effort; see [Proposed follow-up issues](#proposed-follow-up-issues).

---

## 1. How Shepherd ingests agent information today

| Mechanism                      | Source file                                                                                            | Cadence                      | What it yields                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------- |
| `herdr list` liveness + status | `src/poller.ts` (`tick`, ~`poller.ts:206`), `src/herdr.ts` (`mapState`, `:81`)                         | 1000 ms                      | working/blocked/done/idle, pane liveness                      |
| Transcript tail parse          | `src/activity-signal.ts` (`readTranscriptSignals`, `:99`), `src/activity.ts` (`parseActivity`, `:185`) | ~7000 ms per running session | last tool summary, last-activity ts, recent/errored tool ts   |
| Stall detection                | `src/stall.ts` (`isStalled`, `:38`), `src/poller.ts` (`fireStall`, `:642`)                             | derived                      | "stalled" only when transcript silent **and** terminal frozen |
| Block classification           | `src/blocked.ts` (`classifyBlocked`)                                                                   | ~3000 ms for blocked agents  | awaiting-input / menu / … from **regex over PTY buffer text** |
| Terminal buffer read           | `src/herdr.ts` (`readAsync`, `:338`)                                                                   | per tick                     | 200-line visible buffer diff (heartbeat + freeze detection)   |

Transcript files live at `~/.claude/projects/<dashified-cwd>/<claudeSessionId>.jsonl`
(`src/usage.ts:13`) and are read **tail-only** — last 512 KB (`MAX_TAIL_BYTES`,
`activity.ts:140`) — to keep the parse off the hot path of the single Bun loop.

**Today Shepherd configures _no_ monitoring hooks.** The only hook in play is a project
`SessionStart` → `ensure-deps.sh` (`.claude/settings.json`) plus whatever the operator's
global `~/.claude/settings.json` carries. Notably `spawnSettingsOverlay` deliberately does
**not** use `disableAllHooks`, with the comment that doing so "would kill the operator's
global SessionStart hook Shepherd's status pipeline depends on" (`service.ts:228-230`) —
so the codebase already treats hooks as part of the signal substrate, just not its own.

### Limitations this creates

- **Latency.** Activity is invisible for up to one probe interval (~7 s). A burst of fast
  tool calls collapses into a single summary at the next probe.
- **Brittle block detection.** "Awaiting input" is inferred by matching strings in the
  terminal buffer — locale-, theme-, and version-sensitive, and the exact class of thing a
  first-class event would report authoritatively.
- **Heuristic stall detection.** Because a long pure-generation ("thinking") turn writes
  nothing to the transcript, stall must cross-check transcript silence against terminal
  freeze to avoid false positives (`poller.ts:586-617`). Correct, but load-bearing
  cleverness.
- **Bounded visibility.** The 512 KB tail can miss earlier-in-turn detail on very large
  transcripts; everything is re-derived from a string log rather than received as a typed
  event.
- **Single-loop pressure.** Every probe is a file read + parse on the loop that also pumps
  typing; this is exactly the class of work that memory note _single-loop-no-sync-exec_
  (PR #437) warns freezes the web terminal if it ever goes sync.

---

## 2. What Claude Code hooks provide

Hooks are commands/HTTP-callbacks/etc. that Claude Code invokes at lifecycle points,
configured under the `hooks` key of any `settings.json` (or `--settings`). Each hook
receives a JSON object on stdin (or as an HTTP POST body) and can optionally return JSON to
**observe, inject context, or gate** the action. The official reference
(<https://code.claude.com/docs/en/hooks>) documents ~30 events; the monitoring-relevant
subset:

| Event                            | Fires                     | Key input fields                                                         | Use for Shepherd                        |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| `SessionStart`                   | session begins/resumes    | `source` (startup/resume/clear/compact), `session_id`, `cwd`             | authoritative "agent booted"            |
| `UserPromptSubmit`               | a prompt is submitted     | `prompt`                                                                 | confirm a steer/queue-kick landed       |
| `PreToolUse`                     | before a tool runs        | `tool_name`, `tool_input` (parsed)                                       | early intent; optional policy gating    |
| `PostToolUse`                    | after a tool succeeds     | `tool_name`, `tool_input`, `tool_response` (`{stdout,stderr,exit_code}`) | **instant structured activity feed**    |
| `Notification`                   | CC emits a notification   | matcher `type`: `permission_prompt`, `idle_prompt`, …                    | **authoritative awaiting-input / idle** |
| `Stop`                           | Claude finishes a turn    | `stop_hook_active`                                                       | precise turn-complete edge              |
| `SubagentStart` / `SubagentStop` | subagent spawned / done   | `agent_id`, `agent_type`                                                 | live sub-agent fan-out visibility       |
| `SessionEnd`                     | session terminates        | matcher: reason                                                          | authoritative end → recap/teardown      |
| `PreCompact` / `PostCompact`     | around context compaction | —                                                                        | annotate "context was compacted here"   |

### Common stdin envelope

Every hook receives at least:

```json
{
  "session_id": "abc123",
  "transcript_path": "/…/<session>.jsonl",
  "cwd": "/…/worktree",
  "hook_event_name": "PostToolUse"
}
```

`session_id` is the linchpin: Shepherd spawns every agent with `--session-id <uuid>`
(`service.ts:994`), so the hook's `session_id` **is** the UUID Shepherd already keys
sessions by — correlation is free, no mapping table.

### Configuration shape (and the HTTP type)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7330/api/sessions/<id>/hooks",
            "headers": { "Authorization": "Bearer <token>" },
            "allowedEnvVars": ["SHEPHERD_TOKEN"]
          }
        ]
      }
    ],
    "Notification": [ { "hooks": [ { "type": "http", "url": "…", "headers": { … } } ] } ]
  }
}
```

The `http` hook type POSTs the event JSON to a URL and reads the response as the hook
result — purpose-built for an external monitor. A `command` hook running `curl` is the
fallback if a per-session URL must be templated at spawn time. `--settings` hooks **merge**
with (do not replace) the operator's global hooks.

### The delta vs. tailing the transcript

| Capability            | Hook                                              | Transcript tail                                                                 |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Latency               | synchronous at the event                          | up to one probe interval                                                        |
| Tool I/O              | parsed `tool_input` + `{stdout,stderr,exit_code}` | re-parsed from JSONL strings, bounded to 512 KB tail                            |
| Awaiting-input / idle | first-class `Notification` event                  | inferred by PTY regex                                                           |
| Turn boundary         | `Stop` event                                      | inferred from herdr "done" (ambiguous — memory _herdr-done-is-idle-not-exited_) |
| Subagent fan-out      | `SubagentStart/Stop` with `agent_type`            | not visible at all                                                              |
| Compaction marker     | `Pre/PostCompact`                                 | invisible                                                                       |
| Cost                  | observe-only POST = **0 tokens**                  | 0 tokens, but file I/O on the Bun loop                                          |

---

## 3. Proposed architecture

Push, additive, observe-only, fail-open. Polling stays as the fallback so a missed or
blocked hook never regresses today's behaviour.

```
spawnSettingsOverlay()  ──►  --settings { hooks: { PostToolUse, Notification, … → HTTP } }
   (src/service.ts:203)            │
                                   ▼  (agent emits events as it works)
            POST /api/sessions/:id/hooks   ◄── same baseUrl+token the build queue uses
   (new route, sibling of the queue route in src/server.ts)
                                   │  cheap enqueue only (no parse work on the loop)
                                   ▼
            existing signal pipeline (session:activity / session:block / …)
                                   │
                                   ▼
                       UI + autopilot/critic/recap, unchanged downstream
```

Why each piece already mostly exists:

- **Injection** — add a `hooks` fragment to the object built in `spawnSettingsOverlay`
  (`service.ts:203`). The token-trim path (`trimDecision`, `service.ts:232`) and the
  `disableAllHooks` transient spawns (reviewer/recap/namer) naturally opt out, which is
  correct — those don't need monitoring.
- **Transport + auth** — reuse `agentBaseUrl()` + `config.token` (`service.ts:611`,
  `config.ts:315`), exactly as `buildQueueDirective` does. The build queue proves agents
  can reach Shepherd's HTTP server through the membrane/egress sandbox and authenticate
  per session, so reachability is **already solved in production**.
- **Ingest** — one new authenticated route alongside the queue route in `src/server.ts`;
  its handler must only validate + enqueue (translate event → existing `Signal`/activity
  shapes) so the Bun loop stays unblocked (memory _single-loop-no-sync-exec_).
- **Downstream** — emit the same `session:activity` / `session:block` events the poller
  already emits, so autopilot, critic, plan-gate, recap, and the UI need no changes.

---

## 4. High-value applications, mapped to current pain

| Hook                                               | Retires / improves                                              | Win                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Notification` (`permission_prompt`/`idle_prompt`) | PTY-regex block classification (`blocked.ts`)                   | authoritative, locale-proof "awaiting input / idle" — the single biggest fragility removed                                   |
| `PostToolUse`                                      | 7 s transcript-tail probe (`activity-signal.ts`)                | sub-second structured activity (tool, status, exit code) with no loop-side file parse                                        |
| `Stop`                                             | herdr-"done" ambiguity (memory _herdr-done-is-idle-not-exited_) | precise turn-complete edge for autopilot/critic triggers                                                                     |
| `SessionStart`                                     | herdr-list liveness poll for boot                               | instant "agent up" confirmation                                                                                              |
| `SubagentStart/Stop`                               | _(no equivalent today)_                                         | new capability: live sub-agent fan-out in the HUD                                                                            |
| `SessionEnd`                                       | archive-time recap inference (PR #665)                          | authoritative end edge to drive recap/teardown                                                                               |
| `PreToolUse` (optional, later)                     | _(no equivalent)_                                               | optional policy gating (e.g. defense-in-depth on top of egress allowlist) — **observe-first; gating is a separate decision** |

---

## 5. Risks, constraints & gotchas

- **Sandbox reachability is the gating risk — but de-risked.** Agents may run under
  membrane/bwrap with the egress netns firewall (PR #601). The HTTP hook must reach
  Shepherd's loopback port through that boundary. The build-queue curl channel already does
  this, so the path exists; still, **verify** hook-time reachability under a fully
  sandboxed profile before relying on it, and keep polling as the fallback if a profile
  blocks it.
- **Per-tool latency.** `command`/`http` hooks run **synchronously** and block the agent
  until they return (default timeout 600 s). A `PostToolUse` hook on a tool-heavy agent
  adds per-call overhead. Mitigate: HTTP type with a short timeout to a local port,
  fail-open, and keep the handler trivially fast.
- **Spoofing / auth.** The ingest route is a local HTTP endpoint; any local process could
  POST fake events. Require the bearer `token` (as the queue route does) and treat the
  body as untrusted — validate `session_id` against a live session before acting.
- **No "thinking" heartbeat.** No hook fires _during_ a long pure-generation turn, so
  hooks do **not** fully replace stall detection for the thinking case — the
  transcript-silence + terminal-freeze cross-check stays. Hooks tighten the _active_ path,
  not the silent one. State this honestly; don't rip out `stall.ts`.
- **Merge / precedence.** `--settings` hooks merge with operator global hooks. Confirm the
  injected block coexists with (doesn't clobber) the operator's and the project
  `SessionStart` deps hook.
- **Opt-out spawns.** Transient `disableAllHooks` spawns (reviewer/recap/namer/distiller)
  and token-trimmed drain spawns won't carry monitoring hooks — acceptable, but the
  fallback poller must still cover them.
- **Parallelism non-determinism.** Multiple hooks on one event run in parallel; don't rely
  on ordering between an injected hook and an operator hook.

---

## 6. Recommendation & phasing

Adopt hooks as an **additive, flag-gated, observe-only** signal source; never the sole
source of truth in phase 1.

- **Phase 0 — spike (1 PR).** Inject a single `PostToolUse` HTTP hook for non-sandboxed
  interactive spawns; add the ingest route; log received events. Goal: prove correlation
  (`session_id`), reachability, and latency end-to-end. Then repeat the spike **inside a
  fully sandboxed profile** to confirm the egress boundary lets it through.
- **Phase 1 — retire the fragile heuristics (1–2 PRs).** Wire `Notification` → block/idle
  signal and `PostToolUse` → activity signal into the existing pipeline, behind a config
  flag, polling retained as fallback. Measure: block-detection accuracy, activity latency.
- **Phase 2 — lifecycle edges (1 PR).** `SessionStart` / `Stop` / `SessionEnd` for precise
  boot/turn/end edges feeding autopilot, critic, and recap.
- **Phase 3 — new capability (1 PR).** `SubagentStart/Stop` to surface live sub-agent
  fan-out in the HUD (no current equivalent).

Each phase is independently shippable and reversible by flag.

### Proposed follow-up issues

1. **Spike: Claude Code hook → Shepherd ingest channel** — inject one `PostToolUse` HTTP
   hook + `/api/sessions/:id/hooks` route; verify correlation, reachability (incl.
   sandboxed profile), and latency. _(Phase 0)_
2. **Replace PTY-regex block detection with the `Notification` hook** — authoritative
   awaiting-input/idle, flag-gated, poller fallback retained. _(Phase 1)_
3. **Push-based activity feed via `PostToolUse`** — sub-second structured activity,
   superseding the 7 s tail probe on the hot path. _(Phase 1)_
4. **Lifecycle-edge signals via `SessionStart`/`Stop`/`SessionEnd`** — precise edges for
   autopilot/critic/recap. _(Phase 2)_
5. **Live sub-agent fan-out via `SubagentStart/Stop`** — new HUD capability. _(Phase 3)_

---

## Appendix — monitoring-relevant hook event reference

Grounded against the official reference (<https://code.claude.com/docs/en/hooks>,
verified 2026-06-15). Output/control columns note only what's relevant to an observe-only
monitor; most also support context injection and (where noted) gating.

| Event                            | Stdin highlights                                                    | Can gate?                                  | Output of interest            |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ | ----------------------------- |
| `SessionStart`                   | `source`, `session_id`, `cwd`                                       | no                                         | `additionalContext` (inject)  |
| `UserPromptSubmit`               | `prompt`                                                            | yes (`decision: block`)                    | context inject                |
| `PreToolUse`                     | `tool_name`, `tool_input`                                           | yes (`permissionDecision: deny/allow/ask`) | observe / gate                |
| `PostToolUse`                    | `tool_name`, `tool_input`, `tool_response{stdout,stderr,exit_code}` | advisory only                              | observe / `additionalContext` |
| `Notification`                   | matcher `type` (`permission_prompt`, `idle_prompt`, …)              | no                                         | observe                       |
| `Stop`                           | `stop_hook_active`                                                  | yes (`decision: block` → continue)         | observe / force-continue      |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type`                                            | SubagentStop: yes                          | observe                       |
| `SessionEnd`                     | matcher: reason                                                     | no                                         | observe                       |
| `PreCompact` / `PostCompact`     | —                                                                   | PreCompact: yes                            | observe                       |

Full event set (~30, per the reference; most not monitoring-relevant): `SessionStart`,
`Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`,
`PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`,
`MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`,
`StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`,
`FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`,
`Elicitation`, `ElicitationResult`, `SessionEnd`.

### Sources

- Claude Code Hooks Reference — <https://code.claude.com/docs/en/hooks>
- Claude Code Hooks Guide — <https://code.claude.com/docs/en/hooks-guide>
- Shepherd codebase: `src/service.ts` (`spawnSettingsOverlay`, `buildQueueDirective`,
  `buildSpawnArgv`), `src/poller.ts`, `src/activity.ts`, `src/activity-signal.ts`,
  `src/stall.ts`, `src/blocked.ts`, `src/herdr.ts`, `src/usage.ts`, `src/config.ts`,
  `src/server.ts`.
