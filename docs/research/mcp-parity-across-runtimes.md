# MCP parity across runtimes: helping Claude and Codex share the same servers

**Summary.** When you start a session with **Codex** (as TASK-433 did) it sees only the MCP servers in `~/.codex/config.toml`; when you start with **Claude** it sees only the servers in `~/.claude` + the repo's `.mcp.json`. Shepherd treats the two CLIs as **interchangeable runtimes** (diagnostics requires _at least one_ to exist — `src/diagnostics.ts:266-299`) but does **nothing** to keep their MCP toolsets in parity — each CLI reads its own native config and Shepherd passes it through untouched. So a server you configured once "on the Claude side" is invisible the moment you flip a task to Codex, and you only find out mid-run ("merkt dann dass der MCP fehlt"). This doc maps why that happens, then proposes a small **MCP-parity** automation modeled on the two patterns Shepherd already has for exactly this shape of problem — the **diagnostics/remediation** service and the **distiller** learnings flywheel — so an MCP configured "here" can be surfaced (and optionally bridged) "there".

> Engineering design exploration evaluated **2026-06-29** — a capability map and recommendation for making the two runtimes interchangeable, not a committed plan.

---

## 1. The problem, concretely

The user's two CLIs configure MCP servers in **mutually invisible** places, in **different file formats**:

|                      | Claude Code                                                                                     | Codex                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| User-scope config    | `~/.claude.json` / `~/.claude/` (`CLAUDE_CONFIG_DIR`)                                           | `~/.codex/config.toml` (`CODEX_HOME`)                                                                           |
| Project-scope config | `.mcp.json` (repo root, committed)                                                              | `.codex/config.toml` (trusted projects)                                                                         |
| Format               | **JSON** — `mcpServers: { name: { command, args, env } }`; HTTP servers `{ type: "http", url }` | **TOML** — `[mcp_servers.<name>]` tables `{ command, args, env }`; HTTP servers `{ url, bearer_token_env_var }` |
| Discovery UX         | interactive "N new MCP servers found" approval gate                                             | no gate — read silently at startup                                                                              |

A server defined in one column never appears in the other. There is no shared registry, no translation, no "you have this on Claude but not Codex" warning. Switching the runtime silently changes the available toolset.

Sources for the two formats: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp), [Codex MCP docs](https://developers.openai.com/codex/mcp), [Codex config reference](https://developers.openai.com/codex/config-reference).

## 2. What Shepherd does today (and doesn't)

**It passes each CLI's native MCP config through, untouched.**

- **Claude** — the spawn overlay (`src/service.ts:246-266`, `spawnSettingsOverlay`) only sets `env.ENABLE_CLAUDEAI_MCP_SERVERS:"false"` (line 254) to suppress claude.ai _account-connector_ servers; it never enumerates or edits file/project MCP servers. The user's `~/.claude` (incl. its MCP definitions) reaches the spawn via the `CLAUDE_CONFIG_DIR` mirror (`src/auth-config-dir.ts:43-120`) and the sandbox bind (`src/sandbox.ts:385-399`, `src/spawn-membrane.ts:100-115`). For **transient internal agents only**, `enableAllProjectMcpServers:true` + `--safe-mode` pre-approve/quarantine the repo's `.mcp.json` so the interactive gate never hangs an unattended pane (`buildTransientAgentArgv`, `src/transient-agent-argv.ts:126-149` — set at lines 134 and 148; per-kind `mcpIsolated` rationale at 42-119). None of this touches _user_ sessions' server _content_.
- **Codex** — the spawn argv (`src/service.ts:1614-1629`) is `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox [--model M] <prompt>`. **No `--settings`, no MCP flags.** Codex reads `~/.codex/config.toml` (`CODEX_HOME`, `src/codex-usage.ts:18-20`) entirely on its own.

**It does not detect or validate MCP servers for either CLI.** Claude's only "detection" is its built-in gate (which Shepherd _suppresses_, not reads); Codex has none. Nothing in `src/diagnostics.ts` / `src/remediations.ts` mentions MCP — the agent-CLI probe (`agentCliProbes`, `src/diagnostics.ts:269-299`) is **presence-only** ("is `claude`/`codex` on PATH"). So the gap that bit TASK-433 is structurally invisible to Shepherd.

**Net:** the runtimes are interchangeable for _spawning_ but not for _capabilities_. That asymmetry is the bug.

## 3. Two existing patterns this should be modeled on

Shepherd already solves two adjacent problems with reusable machinery. The MCP-parity feature is a composition of both — **not** new infrastructure.

### 3.1 Diagnostics + remediation — "detect a missing capability, offer the fix"

`DiagnosticsService` (`src/diagnostics.ts:133-414`) fans out probes behind a TTL cache; each returns a pure `{ id, state, hintKey }` (`ok | optional | warning | error`), and non-ok checks are annotated with a verbatim **remediation** command from a `hintKey → command` map (`src/remediations.ts:35-79`), surfaced as a one-click **Fix** in the HUD. This is the exact template for an **"MCP X is on Claude but missing on Codex"** check — a new probe + a remediation, with the same payload-purity discipline (never leak server URLs/tokens into the snapshot).

### 3.2 The distiller flywheel — "derive a proposal, let a human approve it"

The **Destillierer** (`src/distiller.ts`, scheduled `src/index.ts:1560-1573` on a 30s tick + daily `consider` per repo) is Shepherd's archetype for _background reconciliation with human-in-the-loop approval_: it mines signals, spawns a disposable read-only agent, writes **proposals** to `.shepherd-learnings.json`, and the operator approves/dismisses in the Learnings pane. The Optimizer and MergeSuggester (`src/optimizer.ts`, `src/merge-suggest.ts`) reuse the identical lifecycle (`consider`/`tick`/`reapOrphans`/`health`, `maintenance.active` pause, orphan-tab reaping by `__label__` prefix). An MCP-sync service that **proposes** "copy server `foo` from Claude→Codex?" rather than silently rewriting config files inherits all of that battle-tested restart-safety — and matches the user's stated intuition ("in die Richtung unserer Destillierer").

The distinction matters: a config bridge that _just runs_ is a footgun (it can inject an untrusted/HTTP-auth server into a runtime that auto-loads it). A bridge that _proposes a diff and waits for one click_ is the same trust posture the distiller already ships.

## 4. Proposed capability: an MCP-parity reconciler

A small service that **reads both runtimes' MCP config, diffs the server sets, surfaces the divergence, and offers to bridge a server across the gap** — with the translation and the approval gate as the load-bearing parts.

### 4.1 Read & normalize (pure, no spawn)

Parse the four sources into one normalized shape keyed by server name:

```
{ name, transport: "stdio" | "http",
  command?, args?, env?,        // stdio
  url?, auth?,                  // http
  presentIn: { claudeUser?, claudeProject?, codexUser?, codexProject? } }
```

- Claude: `JSON.parse` of `~/.claude.json` `mcpServers` + repo `.mcp.json`.
- Codex: a TOML parse of `~/.codex/config.toml` `[mcp_servers.*]` (+ `.codex/config.toml` if a trusted project).

This is the only genuinely new code; everything downstream reuses §3.

### 4.2 Diff → surface

Compute, per scope, **servers present in one runtime but not the other**. Surface it the diagnostics way — a `warning`-level check `mcp_parity` with a `hintKey` like `diagnostics_hint_mcp_codex_missing_servers` — _or_ the distiller way — a proposal card in the Learnings/an MCP pane. (Recommendation in §6.) Payload purity: list **server names only**; never the command/url/env, which can carry secrets.

### 4.3 Bridge (the translation)

For a chosen server, translate one runtime's entry into the other's format and write it (after approval):

| Field                  | Claude (JSON)            | Codex (TOML)                                                         | Notes                             |
| ---------------------- | ------------------------ | -------------------------------------------------------------------- | --------------------------------- |
| stdio command/args/env | `{ command, args, env }` | `[mcp_servers.x] command/args` + `[mcp_servers.x.env]`               | near 1:1; env becomes a sub-table |
| HTTP url               | `{ type: "http", url }`  | `url = ...`                                                          | 1:1                               |
| HTTP auth              | inline header / `oauth`  | `bearer_token_env_var` + `env_vars` (`source = "local" \| "remote"`) | **does not map cleanly** — see §5 |

Writing must be **merge, not overwrite** (preserve unrelated tables/keys, and TOML comments where feasible) — the same care `.shepherd-learnings.json` and the i18n union-merge driver take with shared files.

### 4.4 Lifecycle

Wrap as a service with the distiller's contract — `consider(repoPath)` from the daily sweep, `tick()` on the 30s interval, `reapOrphans()` at boot, `health()`, `maintenance.active` guard, a `POST /api/.../mcp-sync` manual trigger, and `__mcp_sync__`-prefixed labels if it ever spawns an agent (likely it needs **no** agent at all — the diff is deterministic, so it can be pure server-side code, cheaper than the distiller).

## 5. Risks / why this isn't a blind `cp`

1. **Auto-load asymmetry is a security boundary.** Codex reads `config.toml` with _no_ approval gate; Claude gates project servers. Bridging a server _into_ Codex means it loads silently on the next spawn. An attacker who lands a malicious `.mcp.json` in a repo could, via an over-eager bridge, get it auto-loaded by Codex. → Bridging must be **operator-approved**, and project→user promotion especially so. This is precisely why the distiller's propose-then-approve shape is the right one, not a silent sync.
2. **HTTP-auth doesn't round-trip.** Claude's inline/OAuth auth and Codex's `bearer_token_env_var` + `env_vars` `source` model are not 1:1. Bridge **stdio servers cleanly first**; mark HTTP servers as "manual — auth differs" rather than guessing.
3. **Secrets in `env`.** Some MCP entries inline tokens in `env`. The diff/UI must show **names only**; the bridge writes values but never logs/snapshots them (diagnostics payload-purity rule, `src/diagnostics.ts:119-132`).
4. **Direction & truth.** "Claude is canonical" vs "union of both" vs "per-server pick" changes behavior. Defaulting to _propose both directions, operator picks per server_ avoids picking a wrong master.
5. **TOML round-tripping** is fiddlier than JSON (comments, table ordering); a merge-write must not nuke a hand-maintained `config.toml`.

## 6. Recommendation

**Ship the smallest useful slice first: detect-and-surface, no auto-write.**

1. **Phase 1 — parity probe (diagnostics).** Add a pure reader/normalizer + an `mcp_parity` diagnostic that warns "Codex is missing N server(s) configured for Claude" (and vice versa), names-only. This alone fixes the TASK-433 surprise — you'd see the gap _before_ starting the Codex session, not mid-run. Low risk, no config writes, reuses the whole diagnostics surface (TTL cache, HUD card, i18n `hintKey`).
2. **Phase 2 — one-click bridge for stdio servers**, as an **operator-approved proposal** (distiller-style card or a Fix button on the parity check) that merge-writes a single normalized stdio entry into the target format. HTTP/auth servers stay "manual" with a copy-paste snippet.
3. **Phase 3 (optional)** — a standing reconciler in the daily sweep that keeps proposing newly-diverged servers, so parity is maintained over time, never auto-applied.

Phase 1 is a few hundred lines against an existing service and would have turned TASK-433's mid-run discovery into a pre-flight warning. Phases 2–3 are additive and gated behind the same approval UX the distiller already trains operators to use.

## 7. Open questions for the user

- **Surface:** fold the parity check into the existing **Diagnostics** panel (lowest-friction, matches "missing capability"), or give MCP its own **pane** with per-server bridge buttons (more room, but new UI)? _(Phase 1 leans Diagnostics.)_
- **Direction default:** propose **both** directions and let you pick per server, or treat **Claude as canonical** source-of-truth and only ever propose Claude→Codex?
- **Scope:** reconcile **user-scope** servers (`~/.claude` ↔ `~/.codex`) only, or also **project-scope** (`.mcp.json` ↔ `.codex/config.toml`)? Project-scope is where the auto-load-into-Codex risk (§5.1) is sharpest.
- **Auto vs. approve:** is "always operator-approved" right, or do you want a per-server "always sync this one" opt-in once trusted?
