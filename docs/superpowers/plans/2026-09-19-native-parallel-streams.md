# Native App Milestone 2 — Parallel Streams Plan

> **For the orchestrator:** this plan schedules several independent implementation streams that run
> concurrently in separate worktrees, each executed with superpowers:subagent-driven-development from
> its own task plan. It replaces the sequential "sub-project 2b → 3 → notifications" order of the
> design spec with a swarm of streams behind one integration lane.

**Goal:** bring Shepherd for Mac from "session list" (Gate 2, PR #2373) to the web UI's daily-use
core — terminal, detail tabs, actions, sidebar triage, local server, notifications — in days rather
than weeks, by running four to five streams in parallel without merge-conflict churn.

**Baseline:** `origin/main` after #2373 merges. Contract truth: `contracts/openapi.yaml` (11 paths,
8 events today; server has ~90 routes and ~50 events — see the inventory in this plan's appendix).

**Live target for smoke checks:** `https://moes-tavern.long-tautara.ts.net:7330/` (the operator's
server; saved profile + token already in the app on the operator's Mac). Never revoke that token from
automation.

---

## 1. Why streams conflict today, and the rules that make them independent

Every Gate-2 task touched the same four files: `AppModel.swift`, `MainWindow.swift`,
`contracts/openapi.yaml`, `native/scripts/gen-strings.ts`. Parallel streams must not.

**File ownership (hard rule per stream):**

| Area | Owner | May touch shared files? |
| --- | --- | --- |
| `native/Sources/ShepherdKit/Realtime/PTY*.swift`, `native/Apps/ShepherdMac/Sources/Terminal/**` | S1 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift`, `Sources/Detail/**` | S2 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Backlog.swift`, `Sources/Sidebar/**`, `Sources/Header/**` | S3 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Actions.swift`, `Sources/Actions/**` | S4 | no |
| `native/Sources/ShepherdKit/LocalServer/**`, `Sources/LocalServer/**` | S5 | no |
| `Sources/Notifications/**` | S6 | no |
| `AppModel.swift`, `MainWindow.swift`, `SessionDetailView.swift`, `WelcomeView.swift`, `ShepherdApp.swift`, `SessionStore.swift`, `project.yml`, `native.yml` | S0 (integration) | yes, sequentially |

**Shared-file protocols:**

- `contracts/openapi.yaml`: every stream appends its paths and component schemas inside its own
  marked block (`# ── stream: terminal ──` … `# ── /stream ──`) at the end of `paths:` and
  `components.schemas:`. Rebase conflicts are then pure insertion conflicts, resolved by keeping both
  blocks. `bun run test:contract` + `gen:contract-swift` + `native/scripts/sync-contract.sh` run on
  every branch; the drift test is the arbiter after merge.
- `test/contract/*.ts`: one fixture/test file per stream (`terminal.test.ts`, `detail.test.ts`, …);
  the shared harness is not edited.
- `ui/messages/en.json` / `de.json`: union merge driver, append freely.
- `native/scripts/gen-strings.ts`: the S0-prep PR splits the `KEYS` manifest into per-area arrays
  (`KEYS_CORE`, `KEYS_TERMINAL`, `KEYS_DETAIL`, …) concatenated at the end; each stream edits only
  its own array.
- Extension points instead of edits: S0-prep introduces (a) a `DetailTab` registry so S1/S2/S4 add
  tabs by registering a view + tab id, (b) a `SidebarContent` slot so S3 replaces the list without
  editing `MainWindow`, (c) an `AppModel` `extensions` hook for per-stream `@Observable` sub-models
  owned by the model (created/torn down with the store, so the activation-generation guard applies
  automatically), (d) a `WelcomeLocalPanel` slot for S5.

**Kit rule stays:** the contract is the only type source; each stream's kit code is a thin
extension file over the generated client, in its own file.

---

## 2. Streams

| # | Stream | Scope (routes/events to add to the contract) | Model | Est. |
| --- | --- | --- | --- | --- |
| S0-prep | Seams + manifest split + live-gated UI test | none | Opus | 2 h |
| S1 | **Terminal** — `PTYConnection` (kit) over `/pty/{id}` with resize control frame, takeover codes 4000/4001, reconnect; SwiftTerm view; send input via the PTY; `POST /api/sessions/{id}/reply` for the prompt bar | Opus | 8 h |
| S2 | **Detail tabs** — activity, diff (+annotations), files (scratchpad + worktree listing, download), PR status `GET /git` + PR actions (pr, ready, draft, merge, close, request-review); events `session:git`, `session:activity` | Opus | 8 h |
| S3 | **Sidebar + header** — `GET /api/backlog` grouping by repo, triage sections (du bist dran / gemergt / stillgelegt), filters (nächstes/alle/bereit/fertig/offen), search, badges; header counters; usage meter `GET /api/usage/limits`, `GET /api/prompt-budget`, event `usage:limits` (already in contract) | Sonnet | 6 h |
| S4 | **Actions** — quick-action bar (ok, folge dir, commit-push-merge, rebase, run tests, handoff-issue, tldr-status) over `/reply`, `/amendments`, `/recommend-prompt`, `/recap/regenerate`, `/go`, `/answer-plan-questions`, `/ready`, `/rename`, `/resume`, `/relaunch`; the "Handlungsbedarf" recap line; event `session:recap` | Sonnet | 5 h |
| S5 | **Local server supervisor** — `~/.shepherd/app` checkout detection/install, start/stop/restart as child process, log tail, health poll, first-run bridge; Welcome local panel | Opus | 6 h |
| S6 | **Notifications** — `UNUserNotificationCenter` on `session:block` / `session:ready` / recap, deep-link to the session, presence-aware suppression | Sonnet | 2 h |
| S0-int | Integration after each merge: wire the stream into the slots, rebase the others, live smoke against moes-tavern, PR body | Opus | 1 h per merge |

Estimates are agent wall-clock including per-task reviews (two reviewers) and fix waves; Gate 2 needed
~1.5 fix waves per task, so these already include that overhead.

---

## 3. Schedule (wall clock, 4 concurrent implementation lanes)

```
Phase A  (2 h)   S0-prep PR ────────────────────────────────────────▶ merge
Phase B  (1.5 h) planners in parallel: S1, S2, S3, S5 (writing-plans per stream, one Opus each)
Phase C  (≈ 8 h) implement in parallel: S1 ─┐  S2 ─┐  S3 ─┐  S5 ─┐
                                            ▼      ▼      ▼      ▼
                 merges in priority order: S1 → S2 → S3 → S5  (S0-int after each; others rebase)
Phase D  (≈ 5 h) S4 and S6 start as lanes free up (after S1 and S2 respectively); merge; final live smoke
```

Expected: a usable "parity core" (terminal + tabs + triage sidebar + local server) roughly
**two working days** of wall clock after the S0-prep merge, notifications and actions the day after.

Why four lanes and not eight: CI runs on hosted macOS runners (one queue), each stream needs two
reviewers per task, and the integration lane is a single sequential worker. More lanes would only
grow the rebase queue.

---

## 4. Mechanics per stream

1. **Branch/worktree:** `feat/native-<stream>` cut from `origin/main` after S0-prep merges, worktree
   under `.claude/worktrees/`, deps installed, SDD workspace (`.superpowers/sdd/`) with a copy of the
   global constraints + the stream's file-ownership block.
2. **Plan:** one Opus planner writes `docs/superpowers/plans/2026-09-XX-native-<stream>.md`
   (writing-plans skill) from the design spec section, this document, and the route inventory. Tasks
   are contract-first: Task 1 always extends `contracts/openapi.yaml` + fixtures + drift test, Task 2
   syncs/generates, then kit extension, then views, then tests.
3. **Execute:** subagent-driven-development — fresh implementer per task (Opus for kit/concurrency,
   Sonnet for views/tests, Haiku for mechanical fixes), task review by Claude + Codex, fix waves,
   ledger in the worktree. Draft PR opened after Task 1 so CI runs from the start.
4. **Merge gate:** whole-branch review (Claude Opus; Codex on the app-sources-only diff, under 100 KB —
   the 245 KB Gate-2 diff stalled Codex), fix wave, all CI checks green, live smoke against
   moes-tavern by the integration lane, then squash-merge.
5. **Integration lane (S0-int):** after each merge, wires the slot (one small commit on a
   `chore/native-integrate-<stream>` branch), triggers `git rebase origin/main` in every other
   worktree via a Haiku agent that resolves the marked-block conflicts, re-runs each branch's tests.

---

## 5. Live verification (new, applies to every stream)

- **Live-gated XCUITest** (`ShepherdLiveUITests`, added by S0-prep): skipped unless
  `SHEPHERD_LIVE_BASE_URL` and `SHEPHERD_LIVE_TOKEN` are set in the environment; then it activates
  that server, asserts the session list is non-empty and the selected session's detail renders.
  Run locally by the integration lane before every merge; never in CI (no tailnet there).
- **Manual smoke by the orchestrator:** window screenshot via `screencapture -l <windowID>`,
  AppleScript System Events for the toolbar menu, against the saved moes-tavern profile.

---

## 6. Out of scope for this milestone

Epics, learnings, plugins, experiments, update/restart flows, repo cloning/forking, settings UI,
web-push (native notifications replace it), uploads. Each is a later stream with the same mechanics.

---

## Appendix — route inventory summary (2026-09-19)

Server routing: `src/server.ts` `ROUTE_HANDLERS` (158 handlers). Covered by the contract today:
health, login/logout, access-tokens, settings, sessions (list/create/get/delete/done/interrupt),
repos. Not covered and needed per stream: S1 `/pty/{id}` (WS, contract has `x-shepherd-pty` prose),
`/api/sessions/{id}/reply`; S2 `/activity`, `/diff`, `/diff/annotations`, `/scratchpad*`,
`/worktree*`, `/git` + `/git/{pr,merge,close,ready,draft,request-review,reviewers}`, `/automerge`;
S3 `/api/backlog`, `/api/up-next*`, `/api/holds`, `/api/blocks`, `/api/usage/limits`,
`/api/prompt-budget`; S4 `/amendments`, `/rename`, `/ready`, `/resume`, `/relaunch`,
`/recommend-prompt`, `/recap/regenerate`, `/go`, `/answer-plan-questions`, `/clear-merged`;
S6 none (events only). Events to add: `session:git`, `session:activity`, `session:recap`,
`session:amendments`, `held:changed`, `queue:update`, `upnext:snapshot`.

---

## Appendix B — Seam contract (S0-prep delivers these; stream plans code against them)

```swift
// native/Apps/ShepherdMac/Sources/App/DetailTabs.swift
/// A pluggable tab in the session detail pane. Streams register one each.
protocol DetailTab: Identifiable, Sendable where ID == String {
    var id: String { get }             // "terminal", "activity", "diff", "files", "git"
    var title: String { get }          // L.t(...) at render time
    var systemImage: String { get }
    var order: Int { get }             // sort key; terminal = 0
    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView
}
@MainActor enum DetailTabRegistry { static func register(_ tab: any DetailTab); static var tabs: [any DetailTab] }
// SessionDetailView renders DetailTabRegistry.tabs in a TabView; "prompt" is the built-in fallback tab.

// native/Apps/ShepherdMac/Sources/App/SidebarSlot.swift
/// S3 replaces the flat list: MainWindow renders `SidebarSlot.content(app)` if set, else SessionRow list.
@MainActor enum SidebarSlot { static var content: ((AppModel) -> AnyView)? }

// native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift
/// Per-stream sub-models owned by AppModel: created in activate(_:) after the store exists,
/// torn down in teardown(); a sub-model never outlives its store.
@MainActor protocol AppExtension: AnyObject { init(store: SessionStore, app: AppModel); func teardown() }
extension AppModel { func register<E: AppExtension>(_ type: E.Type); func extension<E: AppExtension>(_ type: E.Type) -> E? }

// native/Apps/ShepherdMac/Sources/App/WelcomeSlots.swift
/// S5 fills the local card body (status, install/start controls) without editing WelcomeView.
@MainActor enum WelcomeSlots { static var localPanel: ((AppModel) -> AnyView)? }

// native/Apps/ShepherdMac/Sources/App/ActionBarSlot.swift
/// S4 fills the quick-action bar under the detail pane.
@MainActor enum ActionBarSlot { static var content: ((Session, SessionStore, AppModel) -> AnyView)? }
```

String keys: `native/scripts/gen-strings.ts` exports `KEYS_CORE`, `KEYS_TERMINAL`, `KEYS_DETAIL`,
`KEYS_SIDEBAR`, `KEYS_ACTIONS`, `KEYS_LOCALSERVER`, `KEYS_NOTIFICATIONS` (each an array of key names),
concatenated into the manifest; a stream edits only its own array.

Contract blocks: in `contracts/openapi.yaml`, streams append under `paths:` and `components.schemas:`
between `# ── stream: <name> ──` and `# ── /stream: <name> ──` markers placed by S0-prep (empty
blocks for every stream, in the order terminal, detail, sidebar, actions).
