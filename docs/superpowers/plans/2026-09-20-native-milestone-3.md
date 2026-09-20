# Native App Milestone 3 — Parallel Streams Plan

> **For the orchestrator:** this plan schedules six independent implementation streams that run
> concurrently in separate worktrees, each executed with superpowers:subagent-driven-development
> from its own task plan. It is the milestone-2 protocol
> (`docs/superpowers/plans/2026-09-19-native-parallel-streams.md`) applied to the next band of
> parity work, with the shared-file rules restated verbatim and the three things that changed
> called out.

**Goal:** web parity for the daily operator surfaces — the herd lifecycle (the session list telling
the truth about CI, review and handoff), plan gates (the operator's main blocking interaction),
merge and automation, the queues and Done panels behind the three disabled lenses, composer parity,
and a real settings/command surface. Milestone 2 gave the app a terminal, detail tabs, actions, a
sidebar shell, a local server and notifications. Milestone 3 makes the sidebar's eleven dead
lifecycle stages reachable and gives the operator the three actions that unblock an agent (`/go`,
`/answer-plan-questions`, release a held task).

**Baseline:** `origin/main` @ `2cd84628` (`feat(native): wire local notifications into the mac app
(#2396)`). Contract truth: `contracts/openapi.yaml` — 36 path templates, 14 declared `/events`
frames, four stream blocks (`terminal`, `detail`, `sidebar`, `actions`).

**Requirements source:** the milestone-3 parity gap inventory (166 capability rows, 22 done / 23
partial / 118 missing / 3 n/a). Every stream scope below cites its inventory rows. The inventory's
concrete claims were re-verified against the code while this plan was written; the seven it got
wrong are corrected in §6.

**Live target for smoke checks:** the operator's server, reached through `SHEPHERD_LIVE_BASE_URL` /
`SHEPHERD_LIVE_PASSWORD` in the environment. Never from a file, never in CI, and never revoke that
token from automation.

---

## 1. The single defect this milestone exists to fix

`native/Apps/ShepherdMac/Sources/Sidebar/SidebarModel.swift:44,49`:

```swift
var gitStage: @MainActor (Session) -> HerdStage? = { _ in nil }
var inReview: @MainActor (Session) -> Bool = { _ in false }
```

Nothing assigns either closure. `HerdPartition.swift` declares all fourteen web stages and the
whole grouping pipeline, but eleven of them — `ciRunning`, `ciFailed`, `reviewerRunning`,
`reworkRunning`, `needsRework`, `branchProtectionBlocked`, `waitingOnReviewer`, `waitingOnMerger`,
`draftAwaitingSignoff`, `awaitingMerge`, `merged` — are permanently empty, and the **Ready** lens
tests `inReview` on its own, so it is wrong too. The sidebar renders a flat "active" list with no
CI, no handoff and no merged section.

The cause is not the Swift. `ShepherdClient.getSessionGit` is per-session only; the web bootstraps
from the bulk `GET /api/git` plus `GET /api/reviews` and `GET /api/reviews/inflight`, and none of
those three is in the contract. **S7 is first for this reason**, and S9's merge states are
meaningless until it lands.

---

## 2. Streams

| # | Stream | Contract block | Model | Est. |
| --- | --- | --- | --- | --- |
| S0-prep-2 | Seams + manifest split + harness deps + cross-stream contract | none (edits every section) | Opus | 4 h |
| S7 | **Herd classifier** | `herd` | Opus | 10 h |
| S8 | **Plan gates & questions** | `plan` | Opus | 10 h |
| S9 | **Merge, automation & post-merge** | `merge` | Opus | 10 h |
| S10 | **Attention, queues & done** | `queues` | Sonnet | 6 h |
| S11 | **Composer parity** (first wave) | `compose` | Opus (create shape, issue flow) / Sonnet (views) | 12 h |
| S12 | **Settings, tokens & commands** | `settings` | Opus | 8 h |
| S0-int | Integration after each merge | none | Opus | 1 h per merge |

Estimates are agent wall-clock including two reviewers per task and the fix waves milestone 2
measured at ≈1.5 per task.

### S0-prep-2 — seams, manifest, harness (scope)

Everything six streams would otherwise fight over, done once. Four seams the app does not have yet
(a SwiftUI `Settings` scene with a pane registry, a `CommandMenu` registry, a `NewSessionSlot` so
S11 replaces the create sheet's body without owning `Sources/Main/NewSessionSheet.swift` or editing
`MainWindow.swift` — the sheet's own `body` branches on `NewSessionSlot.content` and falls back to
the milestone-1 form, so `MainWindow`'s "+" needs no change at all — and a scene-time registration
pass so the first two registries are populated before `ShepherdApp.body` is evaluated); the
`STREAM_NAMES` extension and the
eighteen new marker pairs; six new `KEYS_*` arrays; the cross-stream contract additions
(`UsageLimits.observed`, six already-server-supported `CreateSessionRequest` fields); the
contract-harness deps the new streams need to drive non-empty payloads through routes that
currently answer `{}`; and the `writeBadge` generation stamp left open by Codex on #2396. The
per-task plan is `docs/superpowers/plans/2026-09-20-native-s0-prep-2.md`.

### S7 — Herd classifier (bulk git + reviews)

**Fixes:** B1, B2, B3 (the Ready lens), B11, B12, B13, D3, D11 (trigger + verdict), D15. C17's
viewport banners are **deferred** — they belong in `SessionDetailView` (S0-owned) and there is no
detail-banner seam, while a `.toolbar` inside a `DetailTab` is forbidden outright; the same two
facts land on the row instead, and a `DetailBannerSlot` is the recorded follow-up.
Declares the bulk reads the web bootstraps from — `GET /api/git`, `GET /api/activity`,
`GET /api/claude-alive`, `GET /api/reviews`, `GET /api/reviews/inflight` and
`POST /api/sessions/{id}/review-pr` — in a `herd` block, wraps them in `ShepherdClient+Herd.swift`,
and adds a `HerdSignals` `AppExtension` that keeps the four maps live from
`session:git`/`session:review`/`session:reviewing`/`session:critic-activity`/`session:activity`/
`session:claude-alive` with a full re-read on every reconnect. It then assigns
`SidebarModel.gitStage` and `.inReview` through the `SessionSignals` seam pattern, which revives the
eleven dead stages and corrects the Ready lens, and adds the row stepper, the seven missing row
badges, the inline git rail on each row and the `NotificationsModel.extraAttention` ci-red feed.
The risk is classifier parity with `ui/src/lib/components/herd-partition.ts`, so every stage gets a
test against the web's own rule. Per-task plan:
`docs/superpowers/plans/2026-09-20-native-s7-herd.md`.

### S8 — Plan gates & questions

**Fixes:** E1–E8, E10, E11, D16, and the read half of C15. Declares `GET /api/plan-gates`,
`GET /api/plan-gates/inflight`, `POST /api/sessions/{id}/go`,
`POST /api/sessions/{id}/answer-plan-questions`, `POST /api/sessions/{id}/review-plan` and the two
`POST /api/sessions/{id}/quota/{resume,dismiss}` routes in a `plan` block, together with the
`PlanGate` schema and the `VisualBlock` union rendered as a read-side open enum per
`contracts/README.md` — known members typed, an unknown `kind` degrading to its markdown rather than
failing the whole decode. The app side is a `plan` `DetailTab`, a plan-gate badge, a blocks renderer
and a question-answering form with confirmations on the two irreversible actions (`/go` and
submitting answers). `Recap.blocks` is **not** part of this stream — `Recap` lives in S4's `actions`
block — and lands as a one-line integration-lane commit after S8 merges. Per-task plan:
`docs/superpowers/plans/2026-09-20-native-s8-plan-gates.md`.

### S9 — Merge, automation & post-merge

**Fixes:** D4, D5, D7, D8, D9, D10, D12, A14, B6 (the `owed` lens), B20, G10. A `merge` block
declaring `GET /api/automerge`, `POST /api/sessions/{id}/autopilot`,
`POST /api/sessions/{id}/git/redeploy`, `GET`/`POST /api/sessions/clear-merged`,
`GET /api/manual-steps/outstanding`, the per-step manual-steps actions,
`POST /api/sessions/{id}/ack-manual-steps`, `GET /api/drain`, `GET /api/drain/queue`,
`GET /api/queues` and `GET`/`PUT /api/sessions/{id}/queue`, plus the eight automation events
(`session:automerge`, `session:autopilot`, `session:merging`, `mergetrain:landed`,
`post-merge-steps:changed`, `session:manual-steps`, `queue:update`, `drain:status`). The app side is
`Sources/Merge/**`: a merge-confirm dialog with the method and delete-branch pickers the web has, an
automerge/autopilot control, the post-merge manual-steps panel that fills the `owed` lens, the
build-queue badge and panel, and the merge train. **Depends on S7** — `merging` and `awaitingMerge`
are meaningless before the classifier is alive — so it runs in Phase C. `mergeTrainPrs` on
`CreateSessionRequest` is S0-prep-2's, not this stream's. Per-stream plan: second wave.

### S10 — Attention, queues & done

**Fixes:** A10, A13, B4, B5, B22, G14, G15, G17, and the `next` and `done` lenses (`owed` lands with
S9). A `queues` block declaring `GET /api/held`, `POST /api/held/{id}/spawn`,
`PATCH /api/held/{id}`, `DELETE /api/held/{id}`, `POST /api/up-next/refresh`,
`POST /api/up-next/start`, `POST /api/halt`, `POST /api/retry`, `GET /api/stranded`,
`POST /api/revive-stranded`, `POST /api/sessions/{id}/restore`, `GET /api/sessions/{id}/usage` and
`POST /api/broadcast`, with the events `upnext:snapshot`, `halt:done`, `session:halt`,
`session:hold`, `app:sessions-stranded` and `app:auto-revived`. The Done panel needs **no** contract
work at all — `listDoneSessions` and `listRecaps` are already declared and `doneSessions()` /
`recaps()` already exist in the kit — so it is the stream's **first** view, live before a single new
route is written. Enabling the three lens buttons is a two-line integration-lane commit rather than
part of this stream: `HerdLens.isAvailable` lives in `Sources/Sidebar/HerdPartition.swift`, which is
S7's for this milestone, so S10 ships a `QueuesPanels` registry and the lane flips the enum once
both have merged. Per-task plan:
`docs/superpowers/plans/2026-09-20-native-s10-queues.md`.

### S11 — Composer parity — **first wave**

**Fixes:** L1–L8, K3, C4, C5, C6, C19, M23, F3, G9, G16, G18, B9. **Out:** C7 (the mic — it needs
`Speech.framework` plus a microphone entitlement, or the `voice-whisper` plugin routes no stream
owns), C23/G12 (the clean-terminal create — a `oneOf` reshape of a core schema, §6.3), L9 (the
video-brief skill notice, which rides on the plugin family), and G8/G13/B21, whose request bodies
attach to paths other blocks already own.

**Promoted to the first wave on operator feedback.** Side by side, the web's *Neue Aufgabe* dialog
and the Mac sheet are not the same product: the Mac sheet is still the milestone-1 shell — repo,
base branch, agent, model, prompt — and the thing the operator actually reached for, *pick an issue
and start it*, is not there at all. That is a daily-path gap on the app's most-used dialog, so S11
runs alongside S7 and S8 instead of behind them, and it is built in the web's own visual order:
**start from an issue → mode tabs (CODE / RECHERCHE / EPIC / ROH) → engine picker with its per-engine
usage meter → model · effort · cost row → Aufwand and Sandbox → Leitplanken (Plan-Gate, Autopilot bis
zum PR) → Anhängen / Schärfen / mic → footer hints and ERSTELLEN & STARTEN IN &lt;repo&gt;.**

A `compose` block declares `GET /api/issues`, `GET /api/issues/{number}`, `GET /api/commands`,
`POST /api/uploads`, `POST /api/shape`, `POST /api/shape/brief`, `GET /api/branches`,
`GET /api/branch-status`, `GET`/`PUT /api/steers`,
`POST /api/sessions/{id}/{variant,replace,recommend-prompt,leftovers}` and
`POST /api/spawns/{id}/cancel`.

The app side owns a new `Sources/Compose/**` sheet registered through S0-prep-2's `NewSessionSlot`,
so `MainWindow`'s "+" opens the composer when the slot is filled and the milestone-1 sheet
otherwise — no ownership transfer of `Sources/Main/NewSessionSheet.swift` and no edit to
`MainWindow.swift`. Copy reuses the web's existing catalog keys under `KEYS_COMPOSE`; no second
German translation is written. `POST /api/sessions/{id}/reply` stays **S1's**; the composer sends
through it without redeclaring it. `/restore` is **S10's**. The clean-terminal create (C23/G12),
`RelaunchRequest` (G8) and `archiveSession`'s `reap[]` body (G13, B21) are out — each needs a path
or shape another block already owns; see that plan's deviations. Per-task plan:
`docs/superpowers/plans/2026-09-20-native-s11-composer.md`.

### S12 — Settings, tokens & the command surface

**Fixes:** H1–H7, H12, K1, K2, K4, K6, M5, M7, M12, M13, M21, A2, A5, A6, A7, A12, B10, B15, B16.
A `settings` block declaring `GET`/`PUT /api/repo-config`, `GET`/`PUT /api/repo-roles`,
`GET /api/repo-collaborators`, `GET /api/diagnostics`, `POST /api/diagnostics/fix`,
`POST /api/settings/verify-key`, `GET /api/fs/dirs`, the repo pull/fork/sync-fork routes
(**not** `init-empty-commit`, which is S11's), and the event
`diagnostics:status`. It fills S0-prep-2's `SettingsPaneRegistry` and `CommandRegistry` — which also
retires the AppKit `NSWindow` in `NotificationSettingsView.swift`, an iOS-readiness win — and it
renders the three `UsageLimits` fields nobody shows yet. **S12 runs alone in the last phase**, and that is
what buys it the one exception in this plan: it may add a `patch:` operation under the existing core
`/api/settings` path and expand the core `Settings` schema, because no other stream is in flight to
conflict with. Access tokens (H6) are free — all three routes and their schemas are already in the
contract with zero kit methods. Per-stream plan: second wave.

---

## 3. File ownership (hard rule per stream)

| Area | Owner | May touch shared files? |
| --- | --- | --- |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Herd.swift`, `Sources/Herd/**`, `Sources/Sidebar/**` | S7 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Plan.swift`, `Sources/Plan/**` | S8 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Merge.swift`, `Sources/Merge/**` | S9 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Queues.swift`, `Sources/Queues/**` | S10 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift`, `Sources/Compose/**` | S11 | no |
| `native/Sources/ShepherdKit/Client/ShepherdClient+Settings.swift`, `Sources/Settings/**` | S12 | no |
| `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`, `SessionDetailView.swift`, `SessionRow.swift`, `NewSessionSheet.swift`, `WelcomeView.swift`, `ShepherdApp.swift`, `SessionStore.swift`, `StreamRegistrations.swift`, every `*Slot.swift`, `project.yml`, `native.yml` | S0 (integration) | yes, sequentially |

`Sources/Sidebar/**` moves from S3 to **S7** for this milestone: S7 assigns the two dead closures,
adds the row stepper and the seven missing badges, and nothing else touches those files. S3 is
merged and closed.

Per-stream test files follow the same rule: `native/Tests/ShepherdKitTests/ShepherdClient<Stream>Tests.swift`
and `native/Apps/ShepherdMac/Tests/<Stream>*Tests.swift`, each named in its own plan's ownership
block.

---

## 4. Shared-file protocols

Restated verbatim from milestone 2 (`2026-09-19-native-parallel-streams.md` §1), because they are
what made four concurrent lanes cost no merge churn:

- **`contracts/openapi.yaml`:** every stream appends its paths, component schemas **and** event
  frames inside its own marked block (`# ── stream: <name> ──` … `# ── /stream: <name> ──`) in all
  three extensible sections — `components.schemas:`, `paths:`, `x-shepherd-events:`. Rebase
  conflicts are then pure insertion conflicts, resolved by keeping both blocks. `bun run
  test:contract` + `bun run gen:contract-swift` + `./native/scripts/sync-contract.sh` run on every
  branch; the drift test is the arbiter after merge.
- **`test/contract/*.ts`:** one fixture/test file per stream
  (`herd.test.ts`, `plan.test.ts`, …), each ending with its own coverage gate over
  `operationsForStream("<name>")` / `eventsForStream("<name>")` and exercising every status it
  declares — 401 included — from that same file, because Bun's file order does not guarantee the
  global sweep in `openapi.test.ts` ran first. The shared harness is not edited.
- **`ui/messages/en.json` / `de.json`:** union merge driver (`scripts/json-union-merge.mjs`),
  append freely. A conflict there is a genuine one — two branches gave the same key different
  values; resolve it on the merits.
- **`native/scripts/gen-strings.ts`:** per-area `KEYS_*` arrays concatenated into `KEYS`; each
  stream edits only its own array. A key in two arrays fails the generator (`duplicateKeys`).
- **Extension points instead of edits:** `DetailTabRegistry`, `SidebarSlot`, `ActionBarSlot`,
  `WelcomeSlots`, `AppModel.register(_:)` / `AppExtension`, `SessionSignals`, and — new in
  S0-prep-2 — `SettingsPaneRegistry`, `CommandRegistry` and `NewSessionSlot`.
- **Kit rule stays:** the contract is the only type source; each stream's kit code is a thin
  extension file over the internal `generated` client, in its own file. Never a second `Client`.
- **Never edit `StreamRegistrations.swift`** inside a stream: it ships your own
  `<Stream>Install.install(app)` function in your own directory, and the integration lane adds the
  one line.

### What changed for milestone 3

1. **`STREAM_NAMES` grows from four to ten.** `test/contract/stream-blocks.ts` hard-codes the list,
   and `test/contract/stream-blocks.test.ts` asserts `every section names exactly the four streams`
   — so a stream whose name is not in `STREAM_NAMES` makes `parseStreamBlocks` throw
   `unknown stream "<name>" — not in STREAM_NAMES`, and a name in the list with no markers makes the
   real-contract test fail. Both halves are S0-prep-2's, done once: the array, the test's own
   wording, and **eighteen new marker pairs** (six streams × three sections), placed empty and in
   order. A stream that finds its three markers missing must stop and tell the orchestrator rather
   than place them itself.
2. **The contract harness gains the optional deps the new routes read.** `test/contract/deps.ts`
   wires `store`, `service`, `events`, `usageLimits` and `distiller` — and nothing else. Every bulk
   route this milestone declares reads an **optional** dep that is absent there, so
   `GET /api/git` answers `{}`, `GET /api/activity` answers `{}` and `GET /api/stranded` answers
   `[]`. A stream can prove the status codes but not the payload shape, which is exactly what the
   drift test exists to prove. `deps.ts` is a shared harness file streams must not edit, so
   **S0-prep-2 wires the eleven optional deps once** and exposes them through `ContractDeps.stubs`,
   following the existing "swap one method for the duration of a single request, restore what you
   replace" contract.
3. **`native/README.md`'s "Parallel streams: seams and rules" now carries the milestone-2 lessons**,
   and every stream plan repeats them in its Global Constraints: no `.toolbar` inside a `DetailTab`
   (the `TabView` keeps every visited child alive and AppKit throws out of
   `-[NSToolbar _insertNewItemWithItemIdentifier:…]` after four tabs); a cancelled event tap still
   hands you its buffered frames, so stamp work with a generation instead of trusting cancellation;
   never park a long-lived watcher on a bare `withCheckedContinuation` — wait on an `AsyncStream`
   you **finish** in `teardown()`; and `bun run typecheck` is a gate alongside `bun run lint` and
   `bun run test:contract`.

---

## 5. Schedule

```
Phase A  (4 h)   S0-prep-2 PR ──────────────────────────────────────────────▶ merge
Phase B  (2 h)   planners: S0-prep-2, S7, S8, S10, S11 are written; S9 and S12 are planned here
Phase C  (≈10 h) implement in parallel:  S11 ─┐   S7 ─┐   S8 ─┐
                                              ▼       ▼       ▼
                 merges in priority order:   S11  →  S7   →  S8    (S0-int after each)
Phase D  (≈10 h) implement in parallel:  S10 ─┐   S9 ─┐      (S9 starts only after S7 merges)
                                              ▼       ▼
                 merges:                     S10  →  S9        (S0-int after each)
Phase E  (≈8 h)  S12 alone ───────────────────────────────────────────────▶ merge; final live smoke
```

Order: **S0-prep-2 → S11 ‖ S7 ‖ S8 → S10 ‖ S9 → S12**, with the integration lane running after each
merge. S11 leads Phase C on operator feedback: the create dialog is the app's most-used surface and
the furthest from the web. S7 merges next because every other stream's list rendering reads better
once the stages are alive, and S8's `/go` plus `/answer-plan-questions` are the two actions that
unblock an agent. S9 waits for S7 — its `merging` / `awaitingMerge` semantics are meaningless
without the classifier — and S10's `owed` lens waits for S9's manual steps, which is why it merges
first inside Phase D and picks up the lens in the integration commit. S12 is alone in Phase E
because it is the only stream with an approved core-path edit.

Three concurrent lanes hold across both phases, so the CI queue, the two-reviewers-per-task budget
and the single serialised XCUITest slot are unchanged by the reordering.

Three concurrent implementation lanes, not six: CI runs on hosted macOS runners (one queue), each
stream needs two reviewers per task, the XCUITest bundle must run **one worktree at a time**
(parallel `xcodebuild` runs fight over `testmanagerd`), and the integration lane is a single
sequential worker.

### Integration lane (S0-int), after every merge

1. Add the one line to `StreamRegistrations.swift` (or `installScene()` for a settings pane or a
   menu command) on a `chore/native-integrate-<stream>` branch.
2. Assign the cross-stream seams the merged stream fills and the next one reads — see §7.
3. Trigger `git rebase origin/main` in every other live worktree; marked-block conflicts are
   insertion conflicts, keep both blocks.
4. Re-run each rebased branch's `bun run test:contract`, `bun run typecheck` and `swift build`.
5. Live smoke against the operator's server with `SHEPHERD_LIVE_BASE_URL` /
   `SHEPHERD_LIVE_PASSWORD` and `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1`.

---

## 6. Inventory corrections

The inventory is the requirements source, and five of its concrete claims did not survive the code.
Each stream's plan carries the correction it is affected by; they are collected here so nobody
re-derives them.

1. **`HeldTask` is in the contract, but it is not the held-list row.** `contracts/openapi.yaml`'s
   `HeldTask` is `{held: true, id, count}` — the `POST /api/sessions` response that says the usage
   hold queued the task. `GET /api/held`'s rows are a different shape. **S10 declares its own
   schema under a different name** and leaves `HeldTask` alone.
2. **The held-task edit is `PATCH /api/held/{id}`, not `PUT`.** `handleHeld` (`src/server.ts:6056`)
   dispatches on `PATCH` and requires a JSON content type; a `PUT` falls through to a 404.
3. **`terminal` is not a `CreateSessionRequest` field.** `POST /api/sessions` is a **union**:
   `src/validate.ts:530-533` branches on `obj.terminal !== undefined` **before** the standard
   allowlist, and the clean-terminal arm is `TERMINAL_ALLOWED_KEYS = {repoPath, terminal}` and
   nothing else (`:583`). Expressing that needs `CreateSessionRequest` to become a `oneOf` of two
   object schemas, which is a core-schema change and a generator question in one. **C23/G12 is
   deferred**, with the finding recorded in S11's plan; the other six fields the inventory lists are
   genuinely in `ALLOWED_KEYS` (`src/validate.ts:42-61`) and land in S0-prep-2.
4. **Six, not seven, `CreateSessionRequest` fields are already server-supported:** `mergeTrainPrs`,
   `issueRef`, `research`, `epicAuthoring`, `attachmentNames`, `launchUiState`. See (3).
5. **The contract's `GitState` is missing five fields the classifier needs.** The server's
   `GitState` (`src/forge/types.ts:247-271`) carries `noCi`, `handoff` (`"reviewer" | "merger"`),
   `handoffWho`, `reviewBlock` (`{reviewer, state, latestAt}`) and `headSha`; the contract's
   version, in S2's `detail` block, declares none of them, because the per-session Git tab did not
   need them. The web's cascade reads `noCi` (through `checksCleared`), `reviewBlock`
   (`needsRework`), `mergeStateStatus === "blocked"` (`branchProtectionBlocked`) and
   `handoff` / `isDraft` (the three handoff stages), and the stepper reads `headSha` (verdict
   freshness). **S7 declares its own `HerdGitState` inside the `herd` block** — the same wire object
   with those five fields spelled out — rather than editing S2's schema, and `GitStateMap` is keyed
   on that. Both descriptions are legal because both carry `additionalProperties: true`.
6. **`GET /api/up-next` answers the JSON literal `null`** when nothing is cached
   (`src/server.ts:1201-1214`), so it cannot be declared at all — see Appendix A.4 for what S10
   does instead.
7. **Two wire fields no TypeScript UI type declares, which a Swift model must still tolerate:**
   `HeldTask.reason` (`"usage" | "capacity"`, `src/types.ts:1537-1545`) and `Recap.base`
   (`src/types.ts:968-994`). Both are genuinely on the wire; declare them optional.

---

## 7. Cross-stream seams (S0-int fills these)

Same discipline as `Sources/App/SessionSignals.swift`: a stream that needs a fact another stream
owns declares a closure defaulting to the conservative answer, and the integration lane points it at
the extension that keeps that fact current. Nothing here issues a second request.

| Seam | Filled by | Read by | Conservative default |
| --- | --- | --- | --- |
| `SidebarModel.gitStage` | S7 `HerdSignals` | `HerdPartition.stageOf` | `nil` — no git-decided stage |
| `SidebarModel.inReview` | S7 `HerdSignals` | `HerdPartition.stageOf`, the Ready lens | `false` |
| `SessionSignals.gitMerged` | S7 `HerdSignals` (replaces S2's sparse per-session cache) | `ActionRules` | `false` |
| `NotificationsModel.extraAttention` | S7 (ci-red) and S8 (unanswered plan question) | the Dock badge | `[]` |
| `SessionSignals.planQuestionsUnanswered` (new, S0-prep-2) | S8 `PlanStream` | S7's row badge, `NotificationsModel` | `false` |
| `SessionSignals.manualStepsOutstanding` (new, S0-prep-2) | S9 `MergeModel` | S10's `owed` lens | `[:]` |
| `PlanSignals.planReviewing` (S8's own file) | S8 `PlanModel` | S7's `HerdContext.reviewing` — the web ORs the critic and plan-gate flags (`Herd.svelte:262`) | `false` |
| `HerdContext.planRework` | S8 `PlanModel`, through the lane | S7's `isReworkRunning` | `false` |
| `QueuesPanels` → `HerdLens.isAvailable` | S10's panels | S7's lens strip | the three lenses stay disabled |
| `NewSessionSlot.content` | S11 `ComposeStream` | `NewSessionSheet.body` (falls back to the milestone-1 form) | the milestone-1 form |
| `Recap.blocks` | integration commit after S8 | S4's `ActionBarView` recap line | absent |
| `RelaunchRequest`, `archiveSession.reap[]` | integration commit after S11 | S4's relaunch, `MainWindow`'s archive | no body |

---

## 8. Out of scope for this milestone

Learnings (I1), backlog/issues/epics (F1–F7), the usage analytics dashboard (J1), plugins (H8),
update/restart flows (H11), onboarding and what's-new (M8, M9), demo mode (M18), and visual
review / Pierre diff (C10). Together they are roughly two further milestones with the same
mechanics.

**The iOS placeholder target is deferred**, deliberately. `native/Package.swift` already declares
`platforms: [.macOS(.v15), .iOS(.v18)]` and `ShepherdKit` is AppKit-free, so the package half is
done. The app half is not cheap in the way the inventory hoped: a target that no scheme builds is
never compiled and therefore proves nothing, and adding one to a scheme puts a second `xcodebuild`
destination into the **blocking** `shepherdkit` CI job. The requirement "cheap in `project.yml` and
CI-neutral" cannot be met at once. What S0-prep-2 does instead costs nothing and keeps the debt
from growing: every new milestone-3 view is AppKit-free by construction (a rule in each stream's
Global Constraints, asserted by a grep in each stream's final gate task), and S12's SwiftUI
`Settings` scene retires the one AppKit `NSWindow` in the app. The placeholder target gets its own
small plan once somebody is ready to pay for the CI lane.

---

## Appendix A — contract surface by stream (no path is claimed twice)

Existing claims on `origin/main`, for the disjointness check:

| Block | Path templates |
| --- | --- |
| *(core)* | `/api/health`, `/api/login`, `/api/logout`, `/api/access-tokens`, `/api/access-tokens/{id}`, `/api/settings`, `/api/sessions`, `/api/sessions/done`, `/api/sessions/{id}`, `/api/sessions/{id}/interrupt`, `/api/repos` |
| `terminal` | `/api/sessions/{id}/reply` |
| `detail` | `/api/sessions/{id}/activity`, `/diff`, `/diff/annotations`, `/scratchpad`, `/worktree`, `/git`, `/git/pr`, `/git/merge`, `/git/ready`, `/git/draft`, `/git/close`, `/git/reviewers`, `/git/request-review` |
| `sidebar` | `/api/working-blocked`, `/api/holds`, `/api/blocks`, `/api/usage/limits` |
| `actions` | `/api/sessions/{id}/resume`, `/rename`, `/amendments`, `/ready`, `/relaunch`, `/recap/regenerate`, `/api/recaps` |

### A.1 — `herd` (S7)

| Path | Method | Statuses | Note |
| --- | --- | --- | --- |
| `/api/git` | GET | 200, 401 | bulk `Record<sessionId, GitState>`; `$ref`s `detail`'s `GitState` |
| `/api/activity` | GET | 200, 401 | bulk `Record<sessionId, SessionActivity>` |
| `/api/claude-alive` | GET | 200, 401 | bulk `Record<sessionId, boolean>` |
| `/api/reviews` | GET | 200, 401 | `Record<sessionId, ReviewVerdict>` |
| `/api/reviews/inflight` | GET | 200, 401 | in-flight critic runs with their reviewer env |
| `/api/sessions/{id}/review-pr` | POST | 202, 401, 404, 502 | trigger a critic review; **202**, body `{ok, status}`. Two distinct 404 bodies (`not found`, `no forge for this repo`) |

Events: `session:review`, `session:reviewing`, `session:critic-activity`, `session:claude-alive`.
Schemas: `GitStateMap`, `SessionActivity`, `ActivityMap`, `ClaudeAliveMap`, `ReviewVerdict`,
`ReviewDecision`, `ReviewVerdictMap`, `ReviewerEnv`, `ReviewerInflightEntry`, `PrReviewTrigger`,
`PrReviewResult`, and the three event payloads. `GitStateMap` `$ref`s `detail`'s `GitState`, so the
`herd` block depends on the `detail` block already being on `main` — it is.

### A.2 — `plan` (S8)

| Path | Method | Statuses | Note |
| --- | --- | --- | --- |
| `/api/plan-gates` | GET | 200, 401 | `Record<sessionId, PlanGate>` |
| `/api/plan-gates/inflight` | GET | 200, 401 | array of `{id} & ReviewerEnv` |
| `/api/sessions/{id}/go` | POST | 200, 401, 409 | release the gate. **No 404** — `releasePlanGate` answers `false` for an unknown id, so it collapses into the 409 |
| `/api/sessions/{id}/answer-plan-questions` | POST | 200, 400, 401, 404, 409 | submit `question-form` answers; two 400 bodies and two 409 bodies. 415 stays undeclared per `contracts/README.md` |
| `/api/sessions/{id}/review-plan` | POST | 202, 401, 404 | **202** `{ok, status}` carrying the `PlanReviewTrigger` |
| `/api/sessions/{id}/quota/resume` | POST | 202, 401, 404, 502 | **202** `{ok, status}`; the critic branch adds a second 404 body and the 502 |
| `/api/sessions/{id}/quota/dismiss` | POST | 202, 401, 404 | **202** `{ok, status}` |

Events: `session:plangate` (polymorphic — `{id, gate}` **or** `{id, planPhase}`; both keys optional),
`session:plangate-reviewing`, `session:plangate-activity`.
Schemas: `PlanGate`, `PlanDecision`, `PlanSummaryCode`, `PlanReviewTrigger`,
`PlanQuotaResumeStatus`, `PlanQuotaDismissStatus`, `RawAnswer`, `AnswerPlanQuestionsRequest`,
`PlanGateMap`, `VisualBlock` and its thirteen member schemas.

**`ReviewerEnv` is S7's.** Both streams need the same `{provider, model, effort}` triple; a schema
name may appear in exactly one block (`stream-blocks.test.ts` asserts no entry is claimed twice), so
S7 declares it and S8 `$ref`s `#/components/schemas/ReviewerEnv`. S7 merges first, so the reference
resolves; if S8 somehow lands first, it declares the schema and S7 `$ref`s it instead — whichever
way round, exactly one block holds it and the other's plan carries the note.

**`Recap.blocks` is not S8's.** The web `Recap` (`ui/src/lib/types.ts:780`) and the server one
(`src/types.ts:991`) both carry `blocks?: VisualBlock[]`, but the contract's `Recap` sits in S4's
`actions` block. S8 declares `VisualBlock` and leaves `Recap` alone; the integration lane adds the
one optional property after S8 merges, which is what unlocks C15's full recap panel.

### A.3 — `merge` (S9)

| Path | Method | Statuses | Note |
| --- | --- | --- | --- |
| `/api/automerge` | GET | 200, 401 | per-repo automerge status; bootstraps the declared `automerge:status` event |
| `/api/sessions/{id}/autopilot` | POST | 200, 400, 401, 404 | toggle |
| `/api/sessions/{id}/git/redeploy` | POST | 200, 401, 404, 409 | adjacent to `detail`'s `/git/*`, a distinct template |
| `/api/sessions/clear-merged` | GET, POST | 200, 401 | literal path; the server matches it before `/api/sessions/{id}` |
| `/api/manual-steps/outstanding` | GET | 200, 401 | fills the `owed` lens |
| `/api/manual-steps/{id}/done` | POST | 200, 401, 404 | |
| `/api/manual-steps/{id}/skip` | POST | 200, 401, 404 | |
| `/api/sessions/{id}/ack-manual-steps` | POST | 200, 401, 404 | |
| `/api/drain` | GET | 200, 401 | |
| `/api/drain/queue` | GET | 200, 401 | |
| `/api/queues` | GET | 200, 401 | build queue |
| `/api/sessions/{id}/queue` | GET, PUT | 200, 400, 401, 404 | |

Events: `session:automerge`, `session:autopilot`, `session:merging`, `mergetrain:landed`,
`post-merge-steps:changed`, `session:manual-steps`, `queue:update`, `drain:status`.

### A.4 — `queues` (S10)

| Path | Method | Statuses | Note |
| --- | --- | --- | --- |
| `/api/held` | GET | 200, 401 | the held-task list; **not** the core `HeldTask` schema (§6.1) |
| `/api/held/{id}` | PATCH, DELETE | 200, 400, 401, 404 | `PATCH`, not `PUT` (§6.2). `DELETE` never 404s — it answers `{ok:true}` for an unknown id too |
| `/api/held/{id}/spawn` | POST | **201**, 400, 401, 403, 404, 409, 422, 502 | answers the created `Session`; the create-failure ladder is `createErrorResponse`'s |
| `/api/up-next/refresh` | POST | **202**, 401, 503 | |
| `/api/up-next/start` | POST | **201**, 200, 400, 401, 409, 502 | one body shape for 201/200/502; the status encodes created / held-only / all-errors |
| `/api/halt` | POST | 200, 401 | `{halted}`. A herdr-unreachable halt is a genuine 500 by design; undeclared like every other 5xx |
| `/api/retry` | POST | 200, 400, 401 | `{resumed, steered, total}`; `total` is the **requested** id count |
| `/api/stranded` | GET | 200, 401 | ids only; the liveness map is `herd`'s `/api/claude-alive` |
| `/api/revive-stranded` | POST | 200, 401 | `{revived, failed}`; no 4xx — the server computes the target set |
| `/api/sessions/{id}/restore` | POST | 200, 401, 404, 409 | **S10's, not S11's** — the Done panel's "Bring back". Four distinct 409 `code`s |
| `/api/sessions/{id}/usage` | GET | 200, 401, 404 | per-session usage on a done row |
| `/api/broadcast` | POST | 200, 400, 401 | G17 |

Events: `upnext:snapshot`, `halt:done`, `session:halt`, `session:hold`, `app:sessions-stranded`,
`app:auto-revived`.

**`GET /api/up-next` is deliberately not declared.** `handleUpNextGet` answers the JSON literal
`null` when no snapshot is cached (`src/server.ts:1201-1214`), and a whole-body `null` cannot be
expressed in a response position: `scripts/gen-contract-swift.ts:225-233` throws for a nullable
union outside a property schema, and swift-openapi-generator cannot make a nullable *object* an
optional response body. S3 hit and documented exactly this in milestone 2. S10 therefore bootstraps
the Up Next lens from `POST /api/up-next/refresh` (202, fire-and-forget) plus the `upnext:snapshot`
frame, which always carries a non-null `UpNextSnapshot` — the same pair that keeps the web's panel
current. The cost is a "computing…" state on a cold open, which is what `refresh` is for.

### A.5 — `compose` (S11, first wave)

| Path | Method | Statuses | Task |
| --- | --- | --- | --- |
| `/api/issues` | GET | 200, 400, 401 | 1 — the issue list and its open count. **Never 5xx**: a failed listing is a 200 carrying `error: "fetch_failed"` |
| `/api/commands` | GET | 200, 400, 401 | 1 — the BEFEHLE half of the toggle and `/` in the prompt |
| `/api/epics` | GET | 200, 400, 401 | 1 — the "hide sub-issues" filter's parent set |
| `/api/branches` | GET | 200, 400, 401 | 2 — the base-branch picker |
| `/api/branch-status` | GET | 200, 400 ×2, 401 | 2 — performs a real bounded `git fetch`; cached 10 s |
| `/api/repos/init-empty-commit` | POST | 200, 400, 401, 422 | 2 — the base-repair button |
| `/api/uploads` | POST | 200, 400, 401, 413 | 7 — Anhängen. **multipart/form-data**, field `file` |
| `/api/shape` | POST | 200, 400 ×2, 401, 422, 503 | 8 — Schärfen. **503** when the server has no shaper |
| `/api/shape/brief` | POST | 200, 400, 401 | 8 |
| `/api/steers` | GET, PUT | 200, 400, 401 | 10 |
| `/api/sessions/{id}/variant` | POST | 201, 400, 401, 404 | 10 |
| `/api/sessions/{id}/replace` | POST | 201, 400, 401, 404 | 10 |
| `/api/sessions/{id}/recommend-prompt` | POST | 200, 401, 404 | 10 |
| `/api/sessions/{id}/leftovers` | GET | 200, 401, 404 | 10 |
| `/api/spawns/{id}/cancel` | POST | 200, 400, 401, 404 | 9 (slow-spawn cancel) |

Event: `spawn:progress` (Task 9). Exact statuses are pinned in the per-task plan against the
handlers; the rows above are what the block claims, and no other stream claims any of them.

Two schemas are **`$ref`'d, not declared**: `VisualBlockQuestionForm` and `RawAnswer` belong to
S8's `plan` block, and `POST /api/shape` answers one of each. Both streams are in the first wave; if
S8 has not merged, the reference fails loudly at `bun run test:contract` and the answer is to
rebase, never to declare a second copy.

Explicitly **not** claimed: `/api/sessions/{id}/reply` (S1's — the composer sends through it and
declares nothing), `POST /api/sessions/{id}/restore` (S10's), `/api/sessions/{id}/relaunch` and
`DELETE /api/sessions/{id}` (S4's and core respectively — `RelaunchRequest` and the `reap[]` body
land as integration-lane commits after S11 merges), `POST /api/sessions` itself (whose six new
request fields S0-prep-2 declared so S9 and S11 would not both edit a core schema), and
`GET /api/issues/{number}` — the peek route exists but the New Task dialog never calls it, so
declaring it would add a status the coverage gate demands for a call that is never made. The
clean-terminal create is out entirely — it needs `CreateSessionRequest` to become a `oneOf`
(§6.3). The microphone is deferred: it needs either `Speech.framework` plus a microphone
entitlement, or the `voice-whisper` plugin routes, and the plugin family is out of milestone 3.

### A.6 — `settings` (S12)

| Path | Method | Statuses |
| --- | --- | --- |
| `/api/repo-config` | GET, PUT | 200, 400, 401 |
| `/api/repo-roles` | GET, PUT | 200, 400, 401 |
| `/api/repo-collaborators` | GET | 200, 400, 401 |
| `/api/diagnostics` | GET | 200, 401 |
| `/api/diagnostics/fix` | POST | 200, 400, 401 |
| `/api/settings/verify-key` | POST | 200, 400, 401 |
| `/api/fs/dirs` | GET | 200, 400, 401 |
| `/api/repos/pull` | POST | 200, 400, 401 |
| `/api/repos/fork` | POST | 200, 400, 401 |
| `/api/repos/sync-fork` | POST | 200, 400, 401 |

Events: `diagnostics:status`. **`/api/repos/init-empty-commit` is S11's**, not S12's: it is the
composer's base-repair button and it merges in the first wave. S12's repo-management pane calls
S11's declaration rather than declaring a second. **Approved core edit (Phase E only):** a `patch:` operation under the
existing `/api/settings` path plus the `Settings` schema's ~24 operator fields, and the
`GET`/`POST`/`DELETE /api/access-tokens*` kit methods for routes already declared.

### A.7 — S0-prep-2's cross-stream contract additions

Not in any block, because they extend core schemas two streams would otherwise both edit:

| Schema | Add | For |
| --- | --- | --- |
| `UsageLimits` | `observed` (`ObservedLimitWindows`: `{session5h, week}` of `{pct, resetAt, scrapedAt}` or `null`) | A5, rendered by S12 |
| `CreateSessionRequest` | `mergeTrainPrs`, `issueRef`, `research`, `epicAuthoring`, `attachmentNames`, `launchUiState` | S9's merge train (D5), S11's L3/F3 |

Both are additive and optional, so no declared status changes and the core coverage gate in
`openapi.test.ts` is unaffected.
