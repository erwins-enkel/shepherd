# Shepherd v1 — Design Spec

**Date:** 2026-05-30
**Status:** Approved (design), pending implementation plan
**Scope:** v1 "thin core" only. See PRD at `../../../PRD.md` for the full product vision and phasing.

---

## 1. Goal & scope

Shepherd v1 is a self-hosted, single-operator dashboard that spawns **genuinely interactive**
`claude` (Claude Code) sessions, each isolated in its own git worktree, and lets the operator
watch and steer them live in the browser. It exists because Anthropic permits interactive
terminal use on a subscription but restricts programmatic use (Agent SDK / `claude -p`, cut off
2026-06-15); Shepherd only _observes and steers_ real PTYs, never drives Claude programmatically.

**In scope (v1):**

- Spawn a task → auto-named session → `claude` running in an isolated worktree.
- Live, bidirectional terminal in the browser (real PTY).
- Status lights (working / idle / blocked / done) sourced from herdr.
- Persistence: sessions survive a Shepherd restart; reconcile on boot.
- Multi-session "All / Herd" view.
- The "Shepherd HUD" visual design language (§9), applied from the first build.

**Out of scope (later milestones, each its own spec):**

- Git host integration — PR/merge/redeploy buttons (gitea **or** forgejo; undecided, deferred).
- Research chat, saved history, searxng wiring.
- Usage / cost tracking from `~/.claude` JSONL.
- Hermes migration off `claude -p`.
- Mobile/PWA, kanban-api integration, sandboxing, permission profiles.

**Hard constraints:**

- Runs on the operator's Claude **subscription** → sessions MUST be real interactive PTYs.
- No Agent SDK, no `claude -p`, anywhere — including incidental uses (e.g. task naming).
- Single operator. No multi-user, no token relay.

---

## 2. Architecture

Single self-contained app in `~/Work/tank/`: one **Bun/TS server process** that serves a
**SvelteKit 5** UI, a REST API, and two WebSocket channels.

```
Browser (SvelteKit 5 + xterm.js)
   │  REST /api/sessions (CRUD)
   │  WS /events          (status pushes, fan-out)
   │  WS /pty/:id         (raw terminal bytes, bidirectional)
┌──┴─────────────────── Shepherd Server (Bun/TS) ───────────────────┐
│  HerdrDriver   — wraps herdr CLI (start / list / get / wait)   │
│  PtyBridge     — node-pty ⇄ `herdr agent attach <id>`          │
│  WorktreeMgr   — git worktree create / remove                  │
│  Namer         — ollama (mistral-small3.1) → short name        │
│  SessionStore  — SQLite behind an interface (swap later)       │
│  StatusPoller  — herdr agent state → SessionStore → /events    │
└────────────────────────────────────────────────────────────────┘
        │ spawns / attaches               │ reports state (installed hook)
     herdr (PTY persistence) ──────────── claude --dangerously-skip-permissions
```

Each unit has one job, a defined interface, and is testable in isolation. The UI is a view over
REST + the two WS channels; it holds no business logic.

**Runtime decision:** PTY streaming needs `node-pty` (native addon). Bun-first per project
convention. The **P0 spike validates `node-pty` under Bun**; documented fallback is a minimal
Node sidecar that owns only the `/pty/:id` endpoint if Bun's addon support is inadequate.
Everything else stays Bun regardless.

---

## 3. Components

### 3.1 HerdrDriver

Thin wrapper over the herdr CLI (chosen over the raw socket protocol for robustness against
herdr internals). Surface used:

- `herdr agent start <name> --cwd <worktree> -- claude --dangerously-skip-permissions "<prompt>"`
- `herdr agent list` / `herdr agent get <id>` — enumerate / inspect the herd.
- `herdr agent wait <id> --status <s> [--timeout MS]` — efficient state-change waits.
- `herdr agent attach <id> [--takeover]` — used by PtyBridge.
  Parses CLI output (prefer `--json` where available); covered by golden-fixture unit tests.

### 3.2 PtyBridge

On a `/pty/:id` WS connection: spawns `node-pty` running `herdr agent attach <herdr_agent_id>`,
pipes PTY→WS (bytes out) and WS→PTY (keystrokes in). One **active** attach per session; a second
viewer gets a read-only view (polled `herdr agent read --source recent`) with an explicit
"Take over" action (`--takeover`). Handles resize (`SIGWINCH`) from xterm `cols/rows`.

### 3.3 WorktreeMgr

- `create(repo_path, base_branch, name)` → `git worktree add` a new branch `tank/<name>` off
  base; returns `{ worktree_path, branch }`.
- Non-git directory → fall back to running in the directory directly (plain cwd) and flag the
  session `isolated:false`.
- `remove(session)` → `git worktree remove` (force if dirty); branch is **left intact** for
  later inspection. Called on archive.

### 3.4 Namer

`name(prompt)` → short kebab/space label via ollama (`mistral-small3.1`, local, ToS-safe).
On any failure/timeout → fall back to a cleaned first line of the prompt (truncated). Never uses
Anthropic models. Each session is also assigned a sequential **designation** `UNIT-NN` at create
(ordinal within the herd), stored on the row.

### 3.5 SessionStore

Interface (`create / get / list / update / archive`) backed by Shepherd-local **SQLite**. The
interface boundary exists so a future milestone can swap in kanban-api without touching the UI
or other components.

### 3.6 StatusPoller

Watches herdr agent state (via herdr's already-installed Claude integration —
`~/.claude/hooks/herdr-agent-state.sh`, so **no custom Claude hooks in v1**). Maps state →
status, writes to SessionStore, and fans out compact updates over `/events`. Implementation uses
`herdr agent wait --status` where possible, falling back to a short poll of `herdr agent get`.

**State → status mapping:**
| herdr state | Shepherd status | HUD color |
|---|---|---|
| working | `running` | amber (pip pulses) |
| blocked | `blocked` | red (steady) |
| idle | `idle` | dim slate |
| done | `done` | green |
| unknown | `idle` | dim slate |

---

## 4. Data model

`sessions` (SQLite):

| column                                      | notes                                      |
| ------------------------------------------- | ------------------------------------------ |
| `id`                                        | uuid, pk                                   |
| `desig`                                     | `UNIT-NN`, sequential ordinal              |
| `name`                                      | auto-generated label                       |
| `prompt`                                    | original prompt text                       |
| `repo_path`                                 | operator-chosen source dir                 |
| `base_branch`                               | branch worktree was cut from               |
| `branch`                                    | `tank/<name>` (null if cwd fallback)       |
| `worktree_path`                             | actual cwd of the session                  |
| `isolated`                                  | bool; false = cwd fallback                 |
| `herdr_session`                             | herdr session name                         |
| `herdr_agent_id`                            | herdr agent/terminal id                    |
| `status`                                    | running / idle / blocked / done / archived |
| `last_state`                                | raw herdr state (debug)                    |
| `created_at` / `updated_at` / `archived_at` | timestamps                                 |

---

## 5. Key flows

**Spawn:** `POST /api/sessions {repo_path, base_branch, prompt}` → `Namer` → name + desig →
`WorktreeMgr.create` (non-git → cwd fallback) → `HerdrDriver.start` → persist row → return
session; UI card appears.

**Watch / steer:** open terminal → browser WS `/pty/:id` → `PtyBridge` attaches via `node-pty` →
raw bytes both ways → xterm.js. Operator keystrokes flow through the PTY into live `claude`.

**Status:** `StatusPoller` observes herdr state → maps → persists → pushes over `/events` →
status pips / badges / All-grid update in real time.

**Persistence / resume:** herdr owns the PTYs, so sessions survive a Shepherd server restart. On
boot, Shepherd reconciles `SessionStore` against `herdr agent list`: live agents re-linked, dead
agents marked `done`/`archived`, orphaned worktrees flagged.

---

## 6. Error handling & edge cases

- **herdr server down** — detected on first call; UI banner + "start herdr" affordance; no crash.
- **claude exits / crashes** — status → done or blocked; scrollback remains via
  `herdr agent read --source recent`.
- **WS `/pty` drop** — xterm auto-reconnects; on reattach, replay recent buffer then resume live.
- **Two browsers, one session** — first WS holds the live PTY; second is read-only with an
  explicit "Take over" (`herdr agent attach --takeover`).
- **Worktree create fails** (dirty tree / locked branch / non-git) — fall back to cwd,
  `isolated:false`, surface a small flag on the card; never block the spawn.
- **Archive** — stop herdr agent + `git worktree remove` (force if needed); branch retained.

---

## 7. Testing

- **Unit:** HerdrDriver output parsing (golden CLI fixtures), WorktreeMgr create/remove, Namer
  fallback path, status mapping, SessionStore CRUD.
- **Integration:** spawn real `claude` in a temp git repo → assert herdr agent appears, status
  transitions amber→green, bytes flow both directions through `/pty`, restart→reconcile re-links.
- **P0 spike (first, throwaway):** prove `node-pty` → `herdr agent attach` → WS → xterm.js
  round-trips keystrokes under Bun. De-risks the whole architecture before P1.

---

## 8. Phasing within v1

- **P0 — Spike (throwaway):** the PTY bridge round-trip above. Wears the HUD shell so the feel is
  validated too.
- **P1 — Core:** SessionStore, WorktreeMgr, HerdrDriver, Namer, spawn flow, herd list, live
  viewport, StatusPoller, persistence/reconcile, full HUD styling.

---

## 9. Visual design language — "Shepherd HUD"

A thin, purely presentational layer: a `theme.css` token sheet + a matching xterm.js theme + ~5
styled component shells. Rides on top of §3 components untouched. Reference mockup:
`../../../mockup/hud.html`.

**Tokens**

- **Type:** one monospace family throughout — Berkeley Mono if licensed, else JetBrains Mono /
  IBM Plex Mono. Uppercase micro-labels (`HERD`, `UNIT`, `ELAPSED`), tight tracking.
- **Surface:** base `#0a0d0c`, panel `#0f1413`, terminal inset `#070a09`, hairline borders
  `#1b2422` (1px). Depth from border + faint inner glow; no drop shadows.
- **Status palette:** working amber `#e8a13a`, done green `#5ad19a`, blocked red `#e5484d`, idle
  slate. Each drives a pip, the row's left rule, and a ~6–9% radial glow on the selected row.
- **Motion (GPU-cheap, `prefers-reduced-motion` guarded):** pip pulse (~1.5s) only while working;
  timers tick 1s; faint scanline drifts over the active viewport; 600–900ms `INITIALIZING HERD…`
  boot sweep on first paint; blinking amber caret.
- **Motif:** box-drawing frames and corner brackets (`┌─┐ ⌜⌝⌞⌟`) as the recurring shape tying
  top bar, cards, and viewport into one instrument family.

**Screens (v1)**

- **Top HUD bar:** callsign `SHEPHERD`, herd count + amber bar-meter, working/idle/blocked tallies,
  live clock.
- **The Herd (list):** compact `UNIT-NN` rows — pip, name, last-line (live for working), badge,
  ticking elapsed, model. Selected row gets the bracket + glow.
- **Viewport:** the live `claude` framed as an instrument — header (unit · branch · model ·
  elapsed), terminal body with `+/−` diff coloring, amber prompt caret, footer steer-bar.
- **Action bar:** primary `+ NEW TASK`, `All ▦`, `Focus ⌖`.

**v1 framing note:** keep the instrument _frame_ but leave v2+ slots empty/hidden in the build —
the context gauge (`CTX %`), and `searxng`/`sub-agents` hints are placeholders for later
milestones, not wired in v1.

---

## 10. Deferred decisions (tracked, not for v1)

- Git host: gitea vs forgejo (decided at the git milestone; one-line API difference).
- kanban-api integration (swap SessionStore) — separate milestone.
- Hermes migration off `claude -p` — separate, compliance-critical milestone.
- Usage/cost source — `~/.claude` JSONL schema stability TBD at that milestone.
- Auto-naming model tuning — `mistral-small3.1` is the v1 default; revisit if names are weak.
