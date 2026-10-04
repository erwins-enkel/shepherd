# Claude Code mods — what Shepherd can use them for

_Research report — 2026-10-05. Reference + design material; no code in this PR._

## TL;DR

Claude Code **mods** (GA in v2.1.287; this host runs 2.1.289) are plugins whose JavaScript/
TypeScript event handlers run **inside the `claude` process**. A handler sits in a middleware
chain in front of Claude Code's own behaviour and can observe, rewrite or answer: tool calls,
permission decisions, prompts, system-prompt sections, turns (with per-request token usage),
sessions, inter-session messages and the TUI itself. Mods also get an API (`$`) for HTTP, files,
processes, timers, model calls, `$.prompt.submit`, `$.session.usage()` and drawing.

For Shepherd, mods are the first official way to read a Claude session's state **as typed data
instead of terminal text**, and to enforce rules **at the call site instead of in the prompt**.
They map onto the most fragile parts of the codebase:

| Shepherd today (brittle)                                                       | Mod replacement                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Menu/yes-no **regex over the PTY** to shape a block (`src/blocked.ts`)         | `tool.call` on `AskUserQuestion` / `ExitPlanMode` → typed payload |
| herdr's `done` (cleared by _viewing_ the pane, #2267) + turn-end backstop      | `turn.start` / `turn.complete` (`isAborted`, `answer`, `usage`)   |
| `/usage` typed into a **throwaway claude** every 5 min (`src/usage-probe.ts`)  | `$.session.usage()` + `session.measure` (context %, rate limits)  |
| Plan gate's "do NOT write product code" exists **only as prompt text**         | `tool.call` deny on `Edit`/`Write` outside the plan files         |
| Tool guard = one `node` spawn per Bash call (`scripts/tool-guard.mjs`)         | In-process `tool.call` hook, fail-closed via `.catch`             |
| `STEER_PROVENANCE_NOTICE` resident in every prompt so pasted steers are obeyed | `prompt.submit` hook attests a _verified_ Shepherd steer          |
| Steers as bracketed paste + CR, no delivery confirmation (`sendSteerTo`)       | `$.prompt.submit` (waits for idle, resolves when the turn starts) |

**The catch is `PRD.md` §3.** "We steer by typing, like a human" is a hard design default — the
Codex app-server spike was approved for _observation_ and rejected for _steering_ on exactly that
ground (`docs/spikes/2135-codex-app-server.md`). So the uses split into two tiers:

- **Tier 1 — observe, enforce, display.** Compatible with the PRD as written (same footing as the
  HTTP hooks and the tool guard Shepherd already ships). **Recommended**, spike first.
- **Tier 2 — mod as the control channel** (steers, answering dialogs, interrupts). Removes the
  biggest remaining fragility but **needs an explicit PRD decision** by the operator.

Mods are Claude-only; Codex keeps today's path, and Anthropic can switch installed mods off
remotely — so every mod signal must stay an accelerator with the polling/hooks path as fallback.

---

## 1. What a mod is (facts from the docs)

- **Shape:** a plugin directory — `.claude-plugin/plugin.json`, `hooks/hooks.json`
  (`"modules": ["./register.js"]`) and an ES module exporting `register(on, options)`. `options`
  carries the plugin's `userConfig` values.
- **Loading:** `claude --plugin-dir <dir>` (repeatable, hot-reloads on save), the
  `CLAUDE_CODE_PLUGIN_DIRS` env var, or a marketplace install. A `--plugin-dir` mod is named
  `<name>@inline`; its config goes under `pluginConfigs["<name>@inline"]`.
- **Hook contract:** `on(event, matcher?, async ($, e, next) => …)`. Return `next(e)` to observe,
  `next({...e, field})` to rewrite, or a result without calling `next` to answer. `e` is deeply
  frozen. A failing hook is skipped (fail-open) unless it has a `.catch` handler (fail-closed).
- **Where it runs:** hooks run in every session type that loads the plugin (terminal, Desktop,
  `claude -p`, Agent SDK, Remote Control). Drawing shows only in the terminal and Desktop.
- **Limits that matter here:** 10 s of the hook's _own_ execution time per event — time spent
  awaiting `next` or a mods API call (e.g. `$.http.fetch`) does not count, so long-polling
  Shepherd from inside a held tool call is allowed. `$.process.run` 30 s default. `$.store` 4 MiB.
- **Trust model:** not sandboxed by Claude Code; runs with the user's rights. It cannot restyle the
  permission prompt, but it can approve/deny before that prompt appears (`tool.check`).
- **Org controls:** managed `disableSideloadFlags` rejects `--plugin-dir`; `allowManagedModsOnly`
  refuses non-org mods; Anthropic has a remote kill switch ("hooks modules are turned off in this
  process").

### Events and API calls that matter for Shepherd

| Event / call                           | What it gives Shepherd                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tool.call` (matcher `{ tool }`)       | Every tool call incl. subagents and MCP, before it runs. Answer with `{ deny }` or `{ result }`.                |
| `tool.check`                           | The final allow/ask/deny decision, after permission rules and `PreToolUse` hooks.                               |
| `turn.start` / `turn.complete`         | Turn edges. `complete` carries `isAborted`, `answer` (final text), `durationMs`, `usage`, `agentId`.            |
| `turn.step` (async generator)          | Each model request; `result.usage` (input/output/cache read/cache write, model). Can change `model` / `effort`. |
| `session.measure`, `$.session.usage()` | `context { tokens, window, percent }`, `rateLimits [{ kind, percentUsed, resetsAt }]`, `cost`.                  |
| `prompt.submit`                        | The submitted text; can rewrite it, add Claude-only `context`, or `drop` it.                                    |
| `prompt.section` / `prompt.attachment` | Each system-prompt section / injected reminder; replace or omit (`{ text: null }`).                             |
| `session.compact`, `session.end`       | Compaction (can `skip`) and end with `reason`.                                                                  |
| `agent.spawn`                          | A subagent is about to start; can pick its `model` or deny it.                                                  |
| `$.prompt.submit({ text, asUser? })`   | Starts a turn once the session is idle; without `asUser`, Claude is told the mod sent it.                       |
| `$.session.send`, `session.receive`    | Native message to another session / subagent.                                                                   |
| `$.turn.abort()`                       | Interrupt the running turn.                                                                                     |
| `$.http.fetch(url, { socketPath })`    | HTTP over TCP or a Unix socket — the transport back to the Shepherd server.                                     |
| `$.ui.status`, `AbovePrompt`, `Pane`   | A line under the prompt, a band above it, a docked pane — visible in Shepherd's web terminal.                   |

---

## 2. The constraint: PRD §3 "steer by typing"

`PRD.md` §3 lists how Shepherd operates under its reading of the consumer terms: a real PTY via
herdr, "we observe, we don't impersonate" (terminal reads + herdr status + Claude hooks), "we steer
by typing, like a human" (`herdr agent send`), and "if a feature can't be done by _typing into a
real terminal_, it doesn't ship". The Codex app-server spike applied this literally: typed
observation **GO**, `turn/steer` / `turn/start` **NO-GO** without a PRD change.

Applied to mods:

- **Reading** events, **enforcing** local policy at the call site and **displaying** state are the
  same category as the HTTP hooks (`buildHooksFragment`, `src/service.ts:562`) and the
  `PreToolUse` tool guard Shepherd already ships. Tier 1.
- **Submitting prompts, answering `AskUserQuestion`/plan approval, aborting turns, or messaging
  sessions from a mod** puts input into the conversation outside the PTY. Tier 2 — the same
  question the Codex spike raised, and the operator's call, not this report's.

Note that "we observe via Claude hooks" is already in the PRD's mechanism column, and a mod is an
official Claude Code extension point running inside a genuine interactive TUI session. Whether that
is enough to move Tier 2 inside the posture is a product decision; this report only maps the
options.

---

## 3. Tier 1 — observe, enforce, display (no PRD change)

### 3.1 Structured dialog capture (highest value)

**Today:** a `Notification(permission_prompt)` hook raises the block edge fast, but its payload has
no options, so `classifyBlocked` still regexes the visible PTY for a numbered run plus dialog
chrome (`src/blocked.ts:206-224`, `src/poller.ts:1249-1252`). Known breakage: prose shaped like a
menu (#2281/#2287), missed spinner frames (#2282), three wordings of one hint in 2.1.266
(`src/blocked.ts:127-131`), fullscreen packing (`src/blocked.ts:26-31`), English-only patterns, and
the classic renderer pinned because the scrapers depend on it (`src/herdr.ts:652-657`).

**With a mod:** `on('tool.call', { tool: ['AskUserQuestion', 'ExitPlanMode'] }, …)` observes the
call, POSTs the typed `questions`/`options` (or the plan) to Shepherd, and returns `next(e)`. The
dialog still renders in the terminal and the operator still answers by typing (web terminal, iOS
key row #2700), so this is pure observation. After `await next(e)` the hook also sees the
**answer**, which closes the block edge authoritatively instead of via the spinner/queued-input
suppression regexes (`src/blocked.ts:93-150`, #2280).

**Honest note:** a classic `PreToolUse` HTTP hook with matcher `AskUserQuestion|ExitPlanMode` would
deliver the same `tool_input` today, without mods — and Shepherd does not register one yet
(`buildHooksFragment` covers eight events, not `PreToolUse`). That is a cheap win worth taking
independently. The mod adds the answer-side edge and shares one bridge with everything below.

### 3.2 Authoritative turn edges

**Today:** herdr's `done` is a "nobody has looked yet" notification state that viewing the pane
clears; the plan gate, autopilot and push key on it, so a watching operator could hang a session
(#2267), patched by `src/turn-end-backstop.ts` and #2268. The `Stop` hook is ingested but
"measurement only" (`src/hooks-ingest.ts:13-18`). The autopilot classifier reads the visible
buffer (`src/index.ts:2440-2443`).

**With a mod:** `turn.start`/`turn.complete` give both edges, `isAborted` (Esc vs. finished), the
final `answer` text (clean classifier input instead of a screen dump), `durationMs` and the turn's
token `usage`, plus `agentId` for subagent turns. That lets turn-complete become authoritative for
Claude sessions, with herdr status as fallback.

### 3.3 Usage, context fill and plan limits

**Today:** per-session tokens are parsed after the fact from the transcript JSONL
(`src/usage.ts`); no context-window percentage is computed anywhere; a model unknown to the CLI
silently gets a 200k window (`src/claude-model-cli.ts:33-35`). Plan 5h/week % comes from typing
`/usage` into a throwaway interactive claude every 5 min, sleeping 900 ms and sending `\r`
(`src/usage-probe.ts:121-198`, trust pre-seed #1075).

**With a mod:** `$.session.usage()` returns `context.percent` against the real window and
`rateLimits[].percentUsed/resetsAt`; `session.measure` fires after each turn and whenever a limit
percentage changes. Push those to Shepherd and the usage probe can retire for any host with a live
Claude session (keep it only as a cold-start fallback). `turn.step` adds live per-request cache
read/write numbers for the cache-rebuild detector. The same data is what the `claude-swap` plugin
wants for account rotation (`docs/research/plugin-ui-widgets.md`).

### 3.4 Call-site policy instead of prompt text

**Today:** the tool guard is a `PreToolUse` command hook on `Bash` only — one `node` process per
Bash call, fail-open (`src/tool-guard-hook.ts`, `scripts/tool-guard.mjs`). It already cut the
standing prompt from 8,389 to 2,148 chars (`docs/research/standing-prompt-trim-2026-08-03.md`).
The plan gate's "Do NOT write or modify any product code yet" is prompt text only
(`src/service.ts:1504`).

**With a mod:**

- Port the guard's rules to an in-process `tool.call` hook on `Bash` — no process spawn, and a
  `.catch` makes it fail **closed**.
- Extend it to `Edit`/`Write`/`NotebookEdit`: while a session is in the plan phase, deny writes
  outside `.shepherd-plan.md` / `.shepherd-plan-blocks.json` with an actionable `deny` text. The
  rule moves from "hope the model complies" to enforcement.
- Re-check the remaining resident blocks (`src/service.ts:1922-2043`) for ones that can become a
  call-site deny or a just-in-time `prompt.submit` `context` line.

Ordering caveat: managed-settings `PreToolUse` hooks run before any mod; other `PreToolUse` hooks
run after the last mod calls `next`. Shepherd's guard is not managed, so the mod runs first.

### 3.5 Steer provenance attestation

**Today:** every steer is a bracketed paste, Claude Code shows it as `<pasted_content>`, and the
model refused plan-go and autopilot steers until `STEER_PROVENANCE_NOTICE` was added to every spawn
and resume (`src/service.ts:710-731`, #2609). The notice trusts _any_ paste-only turn.

**With a mod (steer still typed):** a `prompt.submit` hook asks Shepherd "did you just send this
text to this session?" (hash match against the steer `sendSteerTo` recorded) and, if so, adds a
Claude-only `context` line "verified Shepherd steer". The resident notice can go, and trust becomes
narrower — only steers Shepherd actually sent. **Spike needed:** whether `e.text` for a pasted
block is the expanded content or a placeholder.

### 3.6 Display inside the agent's terminal

`$.ui.status`, the `AbovePrompt` band or a docked `Pane` can show Shepherd state (plan-gate phase,
queue position, PR/CI, steers in flight) inside the TUI, visible in Shepherd's web terminal and to
an operator attached to the herdr pane directly. **Low priority:** Shepherd's own UI already wraps
the terminal, and every surface must follow the UI/i18n rules.

### 3.7 Smaller options

- `agent.spawn` → enforce a per-subagent-type model policy (cost control as a Shepherd setting).
- `prompt.attachment` → drop noisy reminders (e.g. `todo_reminder`) in long autonomous sessions.
- `session.compact` → mark "context was compacted here" in the timeline.
- `attribution.text` → one place for commit/PR attribution.

---

## 4. Tier 2 — the mod as control channel (needs a PRD decision)

| Use                                       | Mechanism                                                                                   | Retires                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steers without the PTY**                | Bridge long-polls Shepherd; `$.prompt.submit({ text })`                                     | Paste + CR serializer (#1567), multi-line loss (#260), ESC-vs-CR race in `haltAll`, `agent_not_ready` for sandboxed agents, the provenance notice entirely |
| **Answer dialogs from Shepherd UI / iOS** | `tool.call` on `AskUserQuestion` returns `{ result: { answers } }` from the operator's pick | Key-row keystrokes (#2700); autopilot could answer menus it now stands down on                                                                             |
| **Plan approval as a held tool call**     | `tool.call` on `ExitPlanMode` waits for the Shepherd plan review, returns allow/deny+notes  | The `.shepherd-plan*.md` + pasted plan-go handshake                                                                                                        |
| **Interrupt**                             | `$.turn.abort()`                                                                            | The lone ESC (`src/service.ts:5760-5849`)                                                                                                                  |
| **Agent-to-agent**                        | `$.session.send` / `session.receive`                                                        | Server-composed critic/plan-review steers                                                                                                                  |
| **Drop `--dangerously-skip-permissions`** | `tool.check` applies Shepherd's policy; routes genuine `ask`s to the operator               | Blanket bypass on every task session (`src/service.ts:3378`)                                                                                               |

`$.prompt.submit` waits until the session is idle and resolves when the turn starts — the first
real delivery confirmation Shepherd would have. Without `asUser: true`, Claude reads a sentence
naming the mod as the sender, which solves provenance structurally.

**Open design point:** if a mod holds `AskUserQuestion` for a remote answer, the terminal dialog
does not render. Answering in _either_ place (race local vs. remote) needs a spike.

---

## 5. Architecture sketch

One Shepherd-owned mod, e.g. `shepherd-bridge`, shipped in the Shepherd checkout:

- **Load:** `--plugin-dir <install>/agent-mod` on spawn **and** resume (`src/service.ts:3375-3423`,
  `3491-3539`), next to `agentSkillsArgs()`. Its path joins `agentSupportPaths`
  (`src/spawn-membrane.ts:157`, `src/service.ts:2869`), which `agentSupportFlags` turns into
  `--ro-bind-try` in the membrane (`src/sandbox.ts:405-417`) — exactly as for the tool-guard script.
- **Config:** session id, base URL and token via `pluginConfigs["shepherd-bridge@inline"]` in the
  existing `--settings` overlay, or env vars read with `$.env.get`.
- **Transport:** the existing hooks ingress (`/api/sessions/<id>/hooks`, slirp `10.0.2.2` under
  the sandbox, `src/agent-control.ts:590-596`), batched POSTs; Tier 2 adds a long-poll route.
  `$.http.fetch` also takes a `socketPath`, so a bound Unix socket is an alternative.
- **State:** keep it in the Shepherd server, not `$.store` — `claudeDir` is read-only in the
  membrane.
- **Fallback:** the server treats bridge events as a fast path. herdr status, the HTTP hooks and
  the transcript parse stay as they are; Codex is untouched.
- **Verification:** `claude plugin validate --strict --json` and `claude plugin test` in CI; check
  the `mods active` / `hooks module … loaded` debug line in diagnostics.

---

## 6. Risks and limits

- **Claude-only.** Codex has no mods, so every feature keeps a second path (Codex's analog is the
  app-server sidecar from the #2135 spike).
- **Remote kill switch + young API.** Anthropic can turn installed mods off; the public type file
  was written by 2.1.277 while the host runs 2.1.289. Pin behaviour to the types Claude Code writes
  for the installed build (`.claude-plugin/types/`) and add a version floor (≥ 2.1.287) to
  diagnostics — Shepherd has no Claude Code minimum today (`src/diagnostics.ts:1475-1514`).
- **Org-managed operators.** `disableSideloadFlags` rejects `--plugin-dir` at startup — a hard
  spawn failure, not a silent no-op. Detect it and spawn without the bridge.
- **Auth inside the sandbox.** Under the autonomous profile with a token, the token is wiped from
  the env and the HTTP hooks get 401 (`src/service.ts:549-560`). The bridge inherits that unless
  it gets its own session-scoped credential. Do not copy the MCP endpoint's "UUID is the
  capability" model for a channel that can approve tool calls.
- **Shared chain.** The operator's own mods run in the same chain (user tier); one that answers
  `tool.call` can starve the bridge. Trimmed spawns already disable plugins via `enabledPlugins`.
- **Prompt cache.** Section/context text that changes between requests invalidates the cache —
  keep injected text static or turn-scoped.
- **Security.** The bridge sees every prompt and tool call and can approve calls. It ships from the
  same checkout as the tool guard, so the trust boundary does not move, but review it with the same
  care as `src/sandbox.ts`.

---

## 7. Recommendation and proposed follow-ups

1. **Quick win, no mods:** add a `PreToolUse` HTTP hook for `AskUserQuestion|ExitPlanMode` to
   `buildHooksFragment` and feed the typed options into block classification (§3.1).
2. **Spike — `shepherd-bridge` no-op mod:** load it in a sandboxed spawn and resume; verify the
   `AskUserQuestion` payload and answer edge, `turn.complete` against herdr `done`,
   `$.session.usage()` against the `/usage` probe, and what `prompt.submit` sees for a pasted
   steer. Measure the overhead of a hook per tool call.
3. **Tier 1, in order of payoff:** turn edges + usage/limits (§3.2–3.3) → dialog capture (§3.1)
   → tool-guard port with plan-phase write denial (§3.4) → provenance attestation (§3.5).
4. **Tier 2:** only after the operator decides whether a mod-submitted prompt counts as steering
   under `PRD.md` §3. If yes, start with `$.prompt.submit` steers — it retires the most code.

Not recommended: making mod panes a primary UI (Shepherd's web UI is the product), or building any
feature that only works with mods and has no Codex/fallback path.

## Sources

- Mods overview — <https://code.claude.com/docs/de/plugins/mods/overview>
- Create, interface, events, API, test, troubleshoot, admin, reference —
  <https://code.claude.com/docs/en/plugins/mods/>
- Type declarations — <https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts>
- Sample mods (`token-weather`, `blast-radius`, `replay-theater`) —
  <https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods>
- Built-in mod sources (`diff`, `agents-md`, `sec-default`, `telemetry`) —
  <https://github.com/anthropics/claude-code/tree/main/mods>
- Shepherd: `PRD.md` §3, `docs/spikes/2135-codex-app-server.md`,
  `docs/research/claude-code-hooks-ingestion.md`, `docs/research/standing-prompt-trim-2026-08-03.md`
