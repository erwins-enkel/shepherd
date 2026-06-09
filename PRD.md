# Shepherd — Product Requirements

> Self-hosted mission control for **interactive** Claude Code — and opinionated about how
> agent-built software ships. Spawn, watch, and steer a herd of real `claude` sessions live in
> the browser/mobile — ToS-clean, with best-practice guardrails built in, on your own server.

Derived from Creator Magic's "Shepherd" demo (yt: hXWwqPgexZU), re-architected for our stack
(kanban-api · herdr · gitea · searxng · Hermes). Clean-room; we can do better.

---

## 1. Why (thesis)

Anthropic's 2026 crackdown killed **programmatic** subscription use — Agent SDK and `claude -p`
cut off **2026-06-15**. **Interactive terminal use was NOT banned.** Shepherd drives genuine
interactive `claude` sessions and only _observes/steers_ them. That keeps subscription usage in
the white zone. Black zone = token hijack, impersonation, 3rd-party clients, programmatic SDK,
team farming.

**Corollary (the real prize):** Hermes today executes via `claude -p` — exactly the restricted
path on a sub. Shepherd's interactive-session substrate becomes the **compliant execution path** for
the whole ecosystem, not just a dashboard.

## 2. Goals / Non-goals

**Goals**

- One operator parallelizes many `claude` agents without being the bottleneck.
- Every agent = a real interactive session (full PTY), observable + steerable from web + mobile.
- Single pane over: sessions, tasks, git/PRs, usage, research. No SaaS sprawl, nothing leaves
  the building except Anthropic calls.
- Reuse the ecosystem brain (`kanban-api` task store, gitea, searxng); add only the thin parts.
- Enforce engineering best practices across the herd, automated per repo: Plan gate (adversarial
  plan review before an autonomous run) → Critic (PR review on CI-green) → Merge train (a PR
  behind its base is rebased + re-verified before merge), plus Readiness (guardrail scoring
  before agents are pointed at a repo), Learnings (approved house rules injected into new
  sessions) and hygiene gates.

**Non-goals (v1)**

- No multi-user / team farming (ToS). Single operator, bring-your-own-Claude (sub).
- No Agent SDK, no `claude -p`. Ever, on a sub.
- No cloud orchestration.

## 3. ToS compliance model (hard constraint)

| Requirement                            | Mechanism                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Sessions must be genuinely interactive | Real PTY via **herdr**, not `claude -p`                                           |
| We observe, we don't impersonate       | Read terminal via `herdr agent read`; state via herdr agent-status + Claude hooks |
| We steer by typing, like a human       | `herdr agent send` injects prompt text into the live pane                         |
| Auth = the operator's own login        | `claude` uses operator's Max/Pro session; no token relay                          |

If a feature can't be done by _typing into a real terminal_, it doesn't ship.

## 4. Users

Solo power-user on Claude Max/Pro. Desktop primary; mobile (existing PWA pattern) for
monitoring + light steering on the go.

## 5. Architecture

Greenfield app in `~/Work/shepherd/`. Thin orchestrator over existing infra.

```
┌─ Shepherd Web/PWA (SvelteKit5 + Bun + Tailwind4) ─┐      browser + mobile
│   task list · status lights · xterm.js pane  │
│   PR/merge buttons · chat · usage · img DnD   │
└───────────────┬───────────────────────────────┘
                │ WS/SSE + REST
┌───────────────┴─ Shepherd orchestrator (Bun/TS) ─┐      the only NEW backend
│  • spawns/steers claude via herdr socket API  │
│  • registers Claude Code hooks → telemetry    │
│  • bridges PTY output → browser (xterm.js)     │
└──┬──────────┬──────────┬──────────┬───────────┘
   │          │          │          │
 herdr     kanban-api   gitea     searxng
 (PTY +   (task store, (self-    (research
 agent     WS events,   hosted    backend)
 state)    SQLite)      git+CI)
```

**herdr** is the session substrate (replaces tmux). Relevant surface (v0.6.0, socket API):

- `herdr agent start <name> --cwd PATH -- claude …` → spawn interactive session
- `herdr agent read <t> --format ansi --source visible|recent` → stream terminal to xterm.js
- `herdr agent send <t> <text>` → inject prompts ("commit and merge", screenshots paths)
- `herdr agent wait <t> --status idle|working|blocked|done` → **status lights, free**
- `herdr agent list/get` → enumerate the herd; `herdr session` → persistence/detach/reattach
- `herdr integration install claude|hermes` → native agent-state awareness already exists

## 6. Stack

| Layer           | Choice                                                               |
| --------------- | -------------------------------------------------------------------- |
| Frontend        | SvelteKit 5, Svelte 5 runes, Tailwind 4, Bun, xterm.js               |
| Orchestrator    | Bun + TypeScript (Hono or SvelteKit endpoints)                       |
| Sessions        | herdr (Rust binary, socket API)                                      |
| Task store      | kanban-api (Go/SQLite, WS `/api/ws/events`) — extended, not replaced |
| Git + CI        | gitea :3000 + act runner                                             |
| Research        | searxng (already running)                                            |
| State of record | `~/.hermes/kanban.db` via kanban-api                                 |

## 7. Functional requirements

| #   | Feature                  | Notes / how                                                                                                                            |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Spawn task → live agent  | Prompt → auto-name (small local model) → `herdr agent start … -- claude --dangerously-skip-permissions` in a per-task git **worktree** |
| F2  | Live terminal in browser | xterm.js fed by `herdr agent read --format ansi`; bidirectional via `agent send`                                                       |
| F3  | State telemetry          | herdr agent-status + Claude Code hooks (`SessionStart`/`PreToolUse`/`PostToolUse`/`Stop`) POST to orchestrator → kanban-api            |
| F4  | Status lights + All view | working=amber, idle/done=blue, **blocked=red (needs you)**; grid of all concurrent sessions                                            |
| F5  | Persistent + resumable   | herdr named sessions; detach/reattach; survives browser close; no VPS                                                                  |
| F6  | Git action buttons       | open PR / merge / mark done → `agent send` the instruction OR call gitea API directly                                                  |
| F7  | Self-hosted git + CI     | gitea PR view + merge; merge triggers act-runner redeploy                                                                              |
| F8  | Markdown TODO sync       | repo `TODO.md` ↔ dashboard, two-way                                                                                                    |
| F9  | Research chat            | interactive `claude` w/ sub-agents, searxng as search; history saved (kanban-api / SQLite), markdown-rendered                          |
| F10 | Usage tracking           | parse `~/.claude` session JSONL for real tokens/cost + 5h/weekly %; store + chart                                                      |
| F11 | Image drag-and-drop      | drop → temp path → `agent send` the path → Claude vision reads it                                                                      |
| F12 | Project icons            | per-project icon picker                                                                                                                |
| F13 | Self-building            | Shepherd can build its own features and redeploy via CI                                                                                |

**Improvements over the original (explicit):**

- I1 Real bidirectional PTY (not hook-echo-only) — also strengthens ToS "interactive" claim.
- I2 Worktree-per-task → concurrent agents never collide on a checkout.
- I3 Permission profiles roadmap (v1 = skip/auto mode per user; v2 = per-project allowlists).
- I4 Real sandboxing roadmap (firejail/bwrap/nspawn) — make "live dangerously" not literal.
- I5 Real cost from session JSONL, not just usage %.
- I6 Mobile-native monitoring/steering via existing PWA patterns.

## 8. Data model

Reuse kanban-api `tasks`. Add task `kind = "claude-session"` carrying:
`herdr_session`, `herdr_agent_id`, `worktree_path`, `repo`, `branch`, `pr_url`, `model`.
Map herdr state → existing statuses: working→`running`, blocked→`review`, done→`done`.
Chat history + usage either in kanban-api SQLite or a small Shepherd-local SQLite (decide in spec).

## 9. Integration workstreams

1. **Shepherd app** (greenfield) — UI + orchestrator + herdr bridge. _New._
2. **kanban-api ext** — `claude-session` task kind, hook ingest endpoint, session log passthrough.
3. **Hermes migration** — replace `claude -p` execution with interactive-via-herdr (herdr has a
   `hermes` integration already). **Compliance-critical; likely its own milestone.**
4. **gitea wiring** — PR/merge/redeploy buttons → gitea API + act runner.
5. **searxng wiring** — research backend for F9.

## 10. Security posture

- v1: `--dangerously-skip-permissions` / auto mode (per user). Run isolated, never as root.
- Network: Tailscale-only, same as kanban-api. Nothing public.
- Roadmap: per-agent sandbox (I4) + permission profiles (I3) before any unattended autonomy.

## 11. Phasing (proposed)

- **P0 Spike** — herdr socket API: spawn `claude`, read ANSI, send text, observe status. Prove
  the bridge + xterm.js render. Throwaway.
- **P1 Core** — task list, spawn-in-worktree, live terminal, status lights, persistence.
- **P2 Git** — gitea PR/merge/redeploy buttons + CI.
- **P3 Research + chat + usage** — searxng, history, cost from JSONL, image DnD.
- **P4 Hermes migration** — move Hermes off `claude -p` onto interactive-via-herdr.
- **P5 Hardening** — sandboxing, permission profiles, mobile polish.

## 12. Open questions

1. Hook ingest + session storage: into kanban-api, or Shepherd-local SQLite then sync?
2. herdr socket API — documented/stable for programmatic drive, or do we wrap the CLI?
3. PR/merge: drive by _typing into claude_ (max ToS purity) or direct gitea API calls (simpler)?
   Mixed?
4. Auto-naming model — which local model, and is it worth it vs. first-line-of-prompt?
5. Hermes migration scope — same milestone as Shepherd, or sequence after P3?
6. Usage source of truth — `~/.claude` JSONL schema stable enough to parse for cost?
