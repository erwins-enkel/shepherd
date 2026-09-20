# Stream S10 — Attention, queues and done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** light up the three lens buttons the Mac sidebar ships **disabled**. `HerdLens.isAvailable`
today returns true only for `all` and `ready`, because `next`, `owed` and `done` are panel-only
lenses in the web and this build had no panels to swap in. This stream builds them: the held-behind-
gate queue, the up-next queue, the Done panel with its recaps and "Bring back", and the halt / retry
/ revive-stranded actions that sit beside them.

**Architecture:** Twelve operations enter `contracts/openapi.yaml` inside this stream's `queues`
block with six events; Swift is regenerated from the derived file; one kit extension
(`ShepherdClient+Queues.swift`) wraps them. The app side is one `AppExtension` (`QueuesModel`)
owning the held list, the up-next snapshot, the done list and the stranded ids, plus views under
`Sources/Queues/**` that the sidebar's existing lens strip swaps in. **The Done panel needs no
contract work at all** — `listDoneSessions` and `listRecaps` are already declared and
`doneSessions()` / `recaps()` already exist in the kit — so it is the stream's first and cheapest
view.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator 1.13.1,
Swift 6 (language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen 2.46, `os.Logger`.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route
  or event enters `contracts/openapi.yaml` first, then `bun run gen:contract-swift` +
  `./native/scripts/sync-contract.sh` regenerate and copy the derived file. Never hand-edit
  `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Every new view is AppKit-free.**
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_QUEUES` in `native/scripts/gen-strings.ts`. The
  `herd_done_*`, `done_recap_*`, `recap_*`, `upnext_*`, `halt_*`, `retry_*`, `restore_*`,
  `toast_sessions_stranded`, `toast_revive_all` and `broadcast_*` families already exist in both
  catalogs — **reuse them**. A second German translation is a review rejection.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh`. `SHEPHERD_KEYCHAIN_TESTS` is **never** set locally.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`).
- **`bun run typecheck` is a gate**, alongside `bun run lint` and `bun run test:contract`.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` for the read-only suite. Never from a file, never in CI. The
  `TEST_RUNNER_` prefix is how `xcodebuild` forwards them; set
  `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run. A base URL always goes through
  `RemoteServerForm.normalize` before it reaches a `ServerProfile`.
- **The live suite is read-only.** `POST /api/halt` interrupts every working agent on the
  operator's server, `POST /api/held/{id}/spawn` starts one, and `POST /api/revive-stranded`
  resumes several. None of them is ever issued from a test.
- **XCUITest runs serialised** — one worktree at a time.
- **`git checkout -- native/Package.resolved` after `swift test --package-path native`.**
- **No `.toolbar` inside a `DetailTab`.** This stream registers no tab.
- **A cancelled event tap still hands you its buffered frames**, so stamp work with a generation
  rather than trusting cancellation, and **finish** every `AsyncStream` watcher in `teardown()`.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; a **blank line** before the
  trailer, and the body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this
  stream. It ships `QueuesStream.install(app)` and the integration lane adds the one line.
- **Logging:** `run.shepherd.mac` (app), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-queues`, cut from `origin/main` **after S0-prep-2 merges**. Rebase to
  update; never `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `bun run typecheck` | the fixtures typecheck |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `bun run lint` · `bun run test` | repo gates |

### File ownership (hard rule)

Create or modify **only**: `contracts/openapi.yaml` (between `# ── stream: queues ──` and
`# ── /stream: queues ──` only, in all three sections) · the generated
`contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml` ·
`test/contract/queues.test.ts`, `test/contract/queues-fixtures.ts` ·
`native/Sources/ShepherdKit/Client/ShepherdClient+Queues.swift` ·
`native/Tests/ShepherdKitTests/ShepherdClientQueuesTests.swift` ·
`native/Apps/ShepherdMac/Sources/Queues/**` ·
`native/Apps/ShepherdMac/Tests/{QueuesModel,DonePanel,HeldQueue,UpNext,QueuesStrings,
QueuesLive}Tests.swift` · the `KEYS_QUEUES` array in `native/scripts/gen-strings.ts` ·
`ui/messages/{en,de}.json` (append-only) · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`,
`SessionDetailView.swift`, `SessionRow.swift`, `NewSessionSheet.swift`, `ShepherdApp.swift`,
`StreamRegistrations.swift`, `SessionSignals.swift`, any `*Slot.swift`, `SessionStore.swift`,
`ServerEvent.swift`, `EventStream.swift`, `ShepherdClient.swift`, `project.yml`, `native.yml`, or
`test/contract/{harness,deps,stream-blocks,openapi.test}.ts`.

**`Sources/Sidebar/**` is S7's for this milestone**, and that is the one awkward edge in this plan.
See deviation 1.

### Preconditions — verify before Task 1

```bash
grep -c "── stream: queues ──" contracts/openapi.yaml \
  && grep -q "KEYS_QUEUES" native/scripts/gen-strings.ts \
  && grep -q "manualStepsOutstanding" native/Apps/ShepherdMac/Sources/App/SessionSignals.swift \
  && grep -q "recapCache" test/contract/deps.ts \
  && grep -qE "^\s+(internal )?let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  && grep -q "func doneSessions" native/Sources/ShepherdKit/Client/ShepherdClient*.swift \
  && grep -q "enum HerdLens" native/Apps/ShepherdMac/Sources/Sidebar/HerdPartition.swift \
  && echo OK || echo "S0-prep-2 MISSING — stop and tell the orchestrator"
```

Expected: `3` then `OK`. Two of those deserve spelling out.

1. **`doneSessions()` must already exist in the kit.** `GET /api/sessions/done` and
   `GET /api/recaps` are already in the contract and already wrapped — that is what makes the Done
   panel a pure-UI task. If the grep fails, somebody removed a method and this plan's Task 2 is
   wrong.
2. **`SessionSignals.manualStepsOutstanding` must exist.** It is the seam the `owed` lens reads, and
   **S9 fills it**. Until S9 merges it answers `[:]`, so the `owed` lens shows an honest empty list
   rather than a wrong one.

### Deliberate deviations from the stream brief

Reading the web and the server changed six things. Each is intentional and must survive review.

1. **The lens strip is S7's file, so this stream does not enable the lenses itself.**
   `HerdLens.isAvailable` lives in `Sources/Sidebar/HerdPartition.swift`, which belongs to **S7**
   for this milestone. This stream ships the three panels and a `QueuesPanels` registry naming which
   lenses now have one; enabling them is a **two-line integration-lane commit** after both merge.
   That is strictly better than two streams editing one enum, and the PR body says so. The panels
   are reachable and testable meanwhile through their own accessibility identifiers.
2. **`GET /api/up-next` is not declared.** `handleUpNextGet` (`src/server.ts:1262-1273`) answers the
   JSON literal `null` when no snapshot is cached, and a whole-body `null` cannot be expressed in a
   response position: `scripts/gen-contract-swift.ts:225-233` throws for a nullable union outside a
   property schema, and swift-openapi-generator cannot make a nullable *object* an optional response
   body. S3 hit and documented exactly this in milestone 2. **The Up Next lens bootstraps from
   `POST /api/up-next/refresh` (202, fire-and-forget) plus the `upnext:snapshot` frame**, which
   always carries a non-null snapshot — the same pair that keeps the web's panel current. The cost
   is a "computing…" state on a cold open, which is what `refresh` is for.
3. **`GET /api/held`'s rows are not the contract's `HeldTask`.** The contract already has a
   `HeldTask` — `{held: true, id, count}`, the `POST /api/sessions` response that says the usage
   hold queued the task. The list rows are a different object
   (`{id, repoPath, input, createdAt, reason}`, `src/types.ts:1537-1545`). This stream declares
   `HeldQueueEntry` and leaves `HeldTask` alone.
4. **The held-task edit is `PATCH`, not `PUT`.** `handleHeld` (`src/server.ts:6056`) dispatches on
   `PATCH` and requires a JSON content type; a `PUT` falls through to a 404. Note that
   `checkOrigin` does **not** cover `PATCH` — that is the server's business, not the client's, but
   it means the contract test's CSRF expectations differ for this one route.
5. **Three statuses the brief would have got wrong.** `POST /api/held/{id}/spawn` answers **201**
   with the created `Session`; `POST /api/up-next/refresh` answers **202**; and
   `POST /api/up-next/start` answers **201 / 200 / 502** with an *identical body* — the status
   encodes created / held-only / all-errors. A generated client switching on `.ok` alone would show
   a server error for two of the three successful outcomes.
6. **`DELETE /api/held/{id}` never 404s.** It answers `{ok: true}` for an unknown id too
   (`src/server.ts:6011`). The UI must therefore not treat a successful discard as proof the row
   existed; it re-reads the list, which is what the web does.

**Known parity gaps, documented not fixed.** The `owed` lens's data is S9's
(`GET /api/manual-steps/outstanding`); this stream renders the panel from
`SessionSignals.manualStepsOutstanding`, which answers `[:]` until S9 lands. The held popover's
"auto-release" toggle rides `PATCH /api/settings` (`putUsageHoldAutoRelease`), which is **S12's**, so
the toggle is omitted rather than faked. `held:changed` carries only a count and has **no reconnect
snapshot**, so this stream re-reads `GET /api/held` on every `.live` transition — exactly as the web
re-reads it in `resync()`.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | Contract: thirteen operations, six events | `contracts/openapi.yaml`, `test/contract/queues{,-fixtures}.ts` |
| 2 | **The Done panel** — no contract work needed | `Sources/Queues/{DonePanelView,DoneRecapView}.swift` |
| 3 | Kit: `ShepherdClient+Queues.swift` | `ShepherdClient+Queues.swift` |
| 4 | Strings: `KEYS_QUEUES` + the web's existing keys | `gen-strings.ts`, `ui/messages/*.json` |
| 5 | `QueuesModel` — the `AppExtension` | `Sources/Queues/QueuesModel.swift` |
| 6 | The held queue: list, edit, spawn, discard | `Sources/Queues/HeldQueueView.swift` |
| 7 | Up Next: the panel, its sort, and start | `Sources/Queues/UpNextView.swift` |
| 8 | Restore, halt, retry, stranded, broadcast | `Sources/Queues/QueueActions.swift` |
| 9 | Panels registry and the install point | `Sources/Queues/QueuesStream.swift` |
| 10 | Live check, gate sweep, PR | `Tests/QueuesLiveTests.swift` |

---

### Task 1: Contract — the queue surface

**Files:** modify `contracts/openapi.yaml` (queues blocks only); create
`test/contract/queues-fixtures.ts`, `test/contract/queues.test.ts`; regenerate the derived files.

**Interfaces:**
- Consumes: the core block's `Session`, `Ok`, `Error`, `AgentProvider`, `CreateSessionRequest`,
  `IssueRef` (S0-prep-2's) and `#/components/responses/Unauthorized`; `harness.ts`'s helpers;
  `deps.ts`'s `stubs.{stranded,holds,recapCache}`. **`HoldReason` is the `sidebar` block's** — it
  backs S3's `GET /api/holds` — so `$ref` `#/components/schemas/HoldReason` and do not declare a
  second one. (`HeldReason` below is a *different* enum for a different route; the near-identical
  names are the server's, not this plan's.)
- Produces: schemas `HeldReason`, `HeldQueueEntry`, `HeldSpawnRequest`, `UpNextKind`,
  `UpNextIssueRef`, `UpNextItem`, `UpNextSection`, `UpNextSnapshot`, `UpNextStartItem`,
  `UpNextStartRequest`, `UpNextStartHeld`, `UpNextStartError`, `UpNextStartResult`, `HaltResult`,
  `RetryRequest`, `RetryResult`, `ReviveResult`, `SessionUsage`, `UsageSource`,
  `BroadcastRequest`, `BroadcastResult`, `UpNextSnapshotEvent`, `HaltDoneEvent`,
  `SessionHaltEvent`, `SessionHoldEvent`, `SessionsStrandedEvent`, `AutoRevivedEvent`; operations
  `listHeld`, `spawnHeld`, `updateHeld`, `discardHeld`, `refreshUpNext`, `startUpNext`, `haltHerd`,
  `retryHalted`, `listStranded`, `reviveStranded`, `restoreSession`, `sessionUsage`, `broadcast`;
  events `upnext:snapshot`, `halt:done`, `session:halt`, `session:hold`, `app:sessions-stranded`,
  `app:auto-revived`.

- [ ] **Step 1: Cut the branch and write the fixtures**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-queues -b feat/native-queues origin/main
cd .claude/worktrees/feat-native-queues && bun install
```

`test/contract/queues-fixtures.ts` types its payloads with the server's own types
(`HeldTask` from `src/types.ts`, `UpNextSnapshot` from `src/up-next-core.ts`) so a field rename
breaks `bun run typecheck` before it can drift past the contract.

- [ ] **Step 2: Run it and watch it fail, then add the schemas**

The two that carry the most risk:

```yaml
    HeldReason:
      type: string
      x-shepherd-open-enum: true
      description: >-
        Why this task is held (src/types.ts:1537-1545). `usage` is the usage gate; `capacity` is a
        plugin refusing for want of an account. The list is ordered
        `ORDER BY (reason = 'capacity'), createdAt ASC` (src/store.ts:6605-6620) — capacity holds
        sort last, everything else is FIFO.
      enum: [usage, capacity]
    HeldQueueEntry:
      type: object
      additionalProperties: true
      description: >-
        One row of GET /api/held. NOT the same object as the core `HeldTask` schema, which is the
        `{held, id, count}` answer POST /api/sessions gives when the gate trips. `input` is the
        create payload the task will spawn with, so editing a held task is editing this object.
      required: [id, repoPath, input, createdAt]
      properties:
        id: { type: string }
        repoPath: { type: string }
        input: { $ref: "#/components/schemas/CreateSessionRequest" }
        createdAt: { type: integer }
        reason: { $ref: "#/components/schemas/HeldReason" }
    UpNextSnapshot:
      type: object
      additionalProperties: true
      description: >-
        The Up Next queue. Delivered ONLY through the upnext:snapshot event — GET /api/up-next
        answers the JSON literal `null` when nothing is cached, which cannot be expressed in a
        response position, so it is deliberately undeclared and the client bootstraps with
        POST /api/up-next/refresh.
      required: [generatedAt, sections, repoCount, fallback, failedRepoCount]
      properties:
        generatedAt: { type: integer }
        sections: { type: array, items: { $ref: "#/components/schemas/UpNextSection" } }
        repoCount: { type: integer }
        fallback: { type: [string, "null"] }
        failedRepoCount: { type: integer, description: 'Repos whose listing failed. Non-zero with an empty `sections` is the panel''s "could not load" state.' }
```

`UpNextItem` carries `repoPath`, `repoSlug`, `repoLabel`, `number`, `title`, `url`, `kind`,
`priority`, `createdAt`, `labels`, `labelColors`, `epicParent` and `issueRef` — and `issueRef` is
what `POST /api/up-next/start` echoes back, so it is `$ref`'d to S0-prep-2's core `IssueRef` rather
than redeclared.

`SessionUsage` is `{available, source, total, input, output, cacheRead, cacheWrite, messageCount,
byModel}`, copied from `src/server.ts:625-635`, with the comment that **`available: false` means "no
resolvable data source"** while a real zero is `available: true, total: 0`.

- [ ] **Step 3: Add the thirteen operations**

Each with the statuses its handler actually sends. The table the implementer works from:

| Path | Method | Statuses | Note |
| --- | --- | --- | --- |
| `/api/held` | GET | 200, 401 | `HeldQueueEntry[]` |
| `/api/held/{id}/spawn` | POST | **201**, 400 ×3, 401, 403, 404, 409 ×2, 422, 502 | answers the created `Session`; the create-failure ladder is `createErrorResponse`'s |
| `/api/held/{id}` | PATCH | 200, 400, 401, 404 | body is a full `CreateSessionRequest`; answers the updated entry |
| `/api/held/{id}` | DELETE | 200, 401 | `{ok: true}` — **no 404** and no 400, even for an unknown id (`src/server.ts:6217-6221`) |
| `/api/up-next/refresh` | POST | **202**, 401, 503 | fire-and-forget; 503 when the dep is unwired |
| `/api/up-next/start` | POST | **201**, 200, 400 ×3, 401, 409, 502 | one body for 201/200/502 |
| `/api/halt` | POST | 200, 401, 405 | `{halted}`. **405** on any other verb: `handleHalt` answers `method not allowed` (`src/server.ts:6293`) instead of falling through to the terminal 404, so the coverage gate needs it declared and exercised |
| `/api/retry` | POST | 200, 400, 401 | `{resumed, steered, total}` |
| `/api/stranded` | GET | 200, 401 | `string[]` |
| `/api/revive-stranded` | POST | 200, 401 | `{revived, failed}` |
| `/api/sessions/{id}/restore` | POST | 200, 401, 404, 409 ×6 | **six** distinct `code`s, not four — see below |
| `/api/sessions/{id}/usage` | GET | 200, 401, 404 | |
| `/api/broadcast` | POST | 200, 400, 401 | |

Three descriptions must carry the trap in prose, because a reader of the contract alone would get
them wrong:

- **`/api/up-next/start`**: *"Status encodes the outcome over one body shape: 201 when at least one
  session was created, 200 when everything was held instead, 502 when every item errored. A client
  must read all three arrays regardless of status."*
- **`/api/halt`**: *"A herdr that cannot be reached is a genuine 500, by design — a silent
  `{halted: 0}` would read as 'nothing was running'. Undeclared, like every other 5xx."*
- **`/api/retry`**: *"`total` is the number of ids REQUESTED, not the number screened — unknown ids
  and terminal sessions are dropped silently and still counted."*

`/api/sessions/{id}/restore`'s 409 gets one schema and a description naming all **six** `code`s:
`in_progress` (`src/server.ts:3877`), `not_archived` and `cannot_restore` (`RestoreError`,
`src/service.ts:152-157`), `branch_gone` and `branch_in_use` (`WorktreeRestoreError`,
`src/worktree.ts:49-54`) and `spawn_refused` (`src/server.ts:3896`). The brief said four; six is
what the handlers send. The core `Error` schema **already carries an optional `code`**
(verified on `origin/main`) — `$ref` it and add nothing.

- [ ] **Step 4: Add the six events, regenerate, sync, commit**

```yaml
  upnext:snapshot:
    description: A freshly computed Up Next queue. The ONLY delivery path for the snapshot — see UpNextSnapshot.
    schema: { $ref: "#/components/schemas/UpNextSnapshotEvent" }
  halt:done:
    description: A herd halt finished. Broadcast to every client, so a client that did not issue it still learns.
    schema: { $ref: "#/components/schemas/HaltDoneEvent" }
  session:halt:
    description: One session's halt flag moved. `haltReason: null` means it cleared.
    schema: { $ref: "#/components/schemas/SessionHaltEvent" }
  session:hold:
    description: 'Why one session is parked, or null when it is not. Despite the name this is UNRELATED to the held-task queue.'
    schema: { $ref: "#/components/schemas/SessionHoldEvent" }
  app:sessions-stranded:
    description: The stranded set GREW. Fires on growth only, so the count is a prompt to re-read GET /api/stranded, not a running total.
    schema: { $ref: "#/components/schemas/SessionsStrandedEvent" }
  app:auto-revived:
    description: The poller revived stranded sessions by itself. Totals for the current restart episode.
    schema: { $ref: "#/components/schemas/AutoRevivedEvent" }
```

Do **not** add these names to the `EventName` enum.

```bash
bun run test:contract && bun run typecheck && bun run gen:contract-swift \
  && ./native/scripts/sync-contract.sh && bun run check:contract-swift \
  && ./native/scripts/sync-contract.sh --check && swift build --package-path native 2>&1 | tail -3
git add contracts/ native/Sources/ShepherdKit/openapi.yaml test/contract/queues*.ts
git commit -m "feat(contract): held tasks, up next, halt, retry and restore"
```

---

### Task 2: The Done panel

**Files:** create `native/Apps/ShepherdMac/Sources/Queues/{DonePanelView,DoneRecapView}.swift` and
`native/Apps/ShepherdMac/Tests/DonePanelTests.swift`.

**No contract work.** `GET /api/sessions/done` (`listDoneSessions`) and `GET /api/recaps`
(`listRecaps`) are already declared, and `ShepherdClient.doneSessions()` / `.recaps()` already
exist. This is pure UI over routes the kit has had since milestone 2, which is why it is first: it
turns one of the three dark lenses on before a single new route is written.

The rules, from `ui/src/lib/components/herd/HerdDoneList.svelte` and `DoneRecapPanel.svelte`:

- The list is **archived sessions from the last 48 hours**, newest first by `archivedAt`
  (`DONE_LENS_WINDOW_MS`, `src/config.ts:1062`). The server does the windowing; the client does not
  re-filter by time.
- A row shows `desig`, the repo basename, the recap's **verdict chip only when
  `recap.state == .ready && recap.verdict != nil`**, `done_recap_finished` with the elapsed time,
  and a snippet that is the recap headline when ready and the session's name-or-prompt otherwise.
- Verdict colours: `ready` green, `parked` the done tint, `needs_attention` amber.
- **The Done lens has its own selection space.** The live `selectedSessionID` resolves against
  `store.sessions`, which has already evicted archived rows, so a shared selection would silently
  select nothing. `DonePanelView` owns `doneSelectedID`, and the helpers are ported from
  `ui/src/lib/done-filter.ts`: keep the selection if it is still present, else the first row, else
  nil.
- The panel **re-reads on every lens open** — both the list and the recaps. Archived data is static
  and there is no event that adds to it.
- One live subtlety worth a comment: `session:archived` drops a recap from the store, and the
  post-archive `session:recap` finalise event adds it back. Do not "fix" that by ignoring the
  re-add, or the Done lens goes blank.

`DoneRecapView` renders the selected row: the verdict chip, the headline, the body markdown when
`state == .ready`, `openItems`, `changedFiles`, and — per `recap.state` — the generating, failed
(with its `RecapFailureCode` copy and a provider/model disclosure) and empty branches. `blocks` is
rendered **only if S8's `VisualBlock` has reached `Recap`** by the time this task runs; if the
integration commit has not landed, the markdown body is the whole render and a comment says so.

`RECAP_FEATURE_EPOCH_MS = 1781423073000`: a session finished before that with no recap shows
`recap_predates_feature`, not a generic "unavailable". That distinction is the difference between
"this is old" and "this is broken".

**Bring back** is a two-step arm → confirm with a 3 000 ms disarm, and it calls
`POST /api/sessions/{id}/restore` — which Task 1 declares and Task 8 wraps. Until then the button is
present and disabled with a comment naming the task; this is the one forward reference in this task
and it exists so the panel can ship first.

Per-session usage on the selected row is a one-shot `GET /api/sessions/{id}/usage` in a task keyed
on the row id, with an `alive` flag so a late answer for a previous row is dropped. Errors are
swallowed — the status bar shows "—". No polling: archived usage is static.

---

### Task 3: Kit — `ShepherdClient+Queues.swift`

Thirteen methods over Task 1's operations, following the `ShepherdClient+Herd.swift` shape. The four
whose mapping is not mechanical, each with its own test:

```swift
    /// `POST /api/held/{id}/spawn`. **201**, answering the created `Session` — the same object
    /// `POST /api/sessions` answers, because releasing a held task IS the create it was holding.
    /// The whole `createErrorResponse` ladder can come back (403 sandbox refusal, 409 terminal
    /// conflicts, 422 a missing base ref, 502 anything else), so this maps each to its own
    /// `ShepherdError` case rather than collapsing them: "the sandbox refused" and "the base
    /// branch is gone" need different sentences.
    public func spawnHeld(id: String, agentProvider: AgentProvider?) async throws -> Session

    /// `POST /api/up-next/start`. The status is part of the answer, so this returns the body AND
    /// the outcome rather than throwing on 502: 201 means sessions were created, 200 means every
    /// item was held instead, and **502 means every item errored** — with the same body carrying
    /// the reasons. Throwing on the 502 would discard exactly the information the operator needs.
    public func startUpNext(
        items: [UpNextStartItem], choice: UpNextStartChoice?
    ) async throws -> UpNextStartResult

    /// `DELETE /api/held/{id}`. Answers `{ok: true}` even for an id that never existed, so a
    /// caller must re-read the list rather than treating success as proof the row was there.
    public func discardHeld(id: String) async throws

    /// `POST /api/sessions/{id}/restore`. Four distinct 409 `code`s, each with its own operator
    /// sentence, so the conflict is surfaced as a typed reason rather than a message string.
    public func restore(sessionID: String) async throws -> Session
```

`UpNextStartChoice`'s three fields are **spread flat** into the request body
(`{items, agentProvider?, model?, effort?}`), not nested under a `choice` key — the contract's
`UpNextStartRequest` says so and the kit test asserts the encoded body.

---

### Task 4: Strings — `KEYS_QUEUES`

Take the web's keys. `rg -n '"(herd_done_|done_recap_|recap_|upnext_|halt_|retry_|restore_|broadcast_)' ui/messages/en.json`
finds the whole family in both catalogs. Add only genuinely app-only keys, prefixed `native_`, to
both files alphabetically. Fill `KEYS_QUEUES` with exactly the keys Tasks 2 and 5–9 pass to `L.t`,
minus anything already in `KEYS_CORE` or `KEYS_SIDEBAR` — a key in two arrays fails
`duplicateKeys`. Regenerate, run `bun run check:strings` and `(cd ui && bun run check:i18n)`, write
`QueuesStringsTests.swift`, commit.

---

### Task 5: `QueuesModel` — the `AppExtension`

Model it on `SidebarModel`: a `QueuesReads` struct with a `.live(client)` factory, a `generation`
counter plus the `app.activationGeneration` check around every commit, a `subscribe(store)` tap on
`store.events()`, a `watchConnection` `AsyncStream` **finished** in `teardown()`, and a
`refreshPending` collapse.

State: `held: [HeldQueueEntry]`, `heldCount: Int`, `upNext: UpNextSnapshot?`,
`upNextLoadFailed: Bool`, `done: [Session]`, `recaps: [String: Recap]`, `stranded: Set<String>`.

The event rules, each with a test:

1. **`held:changed` carries only a count and has no reconnect snapshot.** The model stores the
   count for the badge and triggers a `GET /api/held` re-read; the reconnect watcher re-reads it
   too, which is what the web's `refreshHeldCount()` does in `resync()`.
2. **`upnext:snapshot` replaces the snapshot wholesale** and clears `upNextLoadFailed`.
3. **`session:halt` patches nothing here** — the store owns `Session` — it only invalidates the
   retry dialog's preselection.
4. **`app:sessions-stranded` fires on growth only**, so its count is a prompt to re-read
   `GET /api/stranded`, never a running total. The model re-reads.
5. **`app:auto-revived` is a separate notice** from the stranded one and must not replace it — the
   web uses two different toast keys for exactly that reason.

---

### Task 6: The held queue

**Files:** create `Sources/Queues/HeldQueueView.swift` and `Tests/HeldQueueTests.swift`.

A popover over the header's held badge, rendering only when `heldCount > 0`. Per row: the input's
prompt, the repo basename, the original CLI, a per-row provider picker over `[.claude, .codex]`, and
three actions — **Edit**, **Spawn now**, **Discard**.

- **Spawn now** sends `POST /api/held/{id}/spawn` with `{agentProvider}` when the picker moved and
  `{}` otherwise, then re-reads the list. The new session arrives through `session:new`; the model
  does not insert it by hand.
- **Edit** hands the entry's `input` to the composer. `NewSessionSlot` is **S11's** once that stream
  merges, so this task does the honest thing: it opens a small edit sheet of its own with the
  fields the milestone-1 form has, and the PR body records that routing Edit through S11's composer
  is a one-line integration follow-up. Editing sends `PATCH /api/held/{id}` with a full
  `CreateSessionRequest` and the server preserves `mergeTrainPrs` across the edit.
- **Discard** sends the `DELETE` and re-reads — it cannot trust the `{ok: true}`.

Every action runs through the existing `SessionCommandState` busy/error gate from
`Sources/Main/MainWindow.swift`. A second gate with a different name is a review rejection.

---

### Task 7: Up Next

**Files:** create `Sources/Queues/UpNextView.swift` and `Tests/UpNextTests.swift`.

The panel bootstraps by firing `POST /api/up-next/refresh` (202) and rendering a computing state
until the first `upnext:snapshot` arrives — deviation 2. A snapshot older than the current repo
filter still renders; the filter is client-side.

Sort modes, ported from `UpNextPanel.svelte`: `recommended` (server order, no client sort),
`newest`, `oldest`, `title-asc`, `title-desc`, all breaking ties on
`repoLabel → repoPath → number`. The default is **`newest`**, not `recommended`, and it persists in
`UserDefaults` under this app's own key — the web's `localStorage` key is the web's.

Grouping follows the sort: `recommended` renders one group per server section with caps of **10**
(priority) and **5** (repo); any other sort flattens everything and splits into priority (cap 10)
and normal (cap 5). A "show all N" expander lifts the cap per group.

**Start** sends `POST /api/up-next/start` and reads **all three arrays regardless of status** —
`created`, `held`, `errors` — surfacing one notice each. A batch of more than three arms a confirm
step first. The label chips drop the exact `shepherd:priority` label and drop `epic` for epic-kind
rows, because both are already shown as badges.

---

### Task 8: Restore, halt, retry, stranded, broadcast

**Files:** create `Sources/Queues/QueueActions.swift` and extend `Tests/QueuesModelTests.swift`.

- **Restore** finishes Task 2's Bring-back button.
- **Halt** counts the haltable set from the **raw** `session.status == .running`, never
  `displayStatus` — a working-while-blocked session is latched blocked in herdr and must not be
  counted. It is a two-step arm → confirm, disabled at zero, and its failure is a sticky notice with
  a retry, because a halt that did not reach herdr is a real 500 and must not read as "nothing was
  running".
- **Retry** preselects every session whose `haltReason == "usage_limit"` **once, at presentation**
  — not in an observer — so a later `session:halt` cannot silently re-add a row the operator
  unchecked. The steer text is localised **client-side** (`retry_continue_steer`); the server stays
  i18n-agnostic.
- **Stranded** renders the banner from `stranded.count`, with a "revive all" button over
  `POST /api/revive-stranded`. The banner clears when the count reaches zero.
- **Broadcast** is a small sheet over `POST /api/broadcast`.

---

### Task 9: Panels registry and the install point

**Files:** create `Sources/Queues/QueuesStream.swift`.

```swift
@MainActor
enum QueuesStream {
    static func install(_ app: AppModel) {
        app.register(QueuesModel.self)
        // Which lenses now have a panel behind them. `HerdLens.isAvailable` lives in
        // Sources/Sidebar/HerdPartition.swift, which is S7's for this milestone, so enabling the
        // buttons is a two-line integration-lane commit rather than two streams editing one enum.
        QueuesPanels.register(.next) { AnyView(UpNextView()) }
        QueuesPanels.register(.done) { AnyView(DonePanelView()) }
        QueuesPanels.register(.owed) { AnyView(OwedPanelView()) }
    }
}
```

`QueuesPanels` is this stream's own registry in `Sources/Queues/`, keyed by `HerdLens` — reading
that enum is fine; **writing** its `isAvailable` is not.

**`OwedPanelView` is built in Task 8**, alongside the other `SessionSignals`-fed surfaces: it
renders `SessionSignals.manualStepsOutstanding()`, which answers `[:]` until S9 lands, so it ships
as an honest empty list with its own accessibility identifier. It is named here only because this
is where it is registered.

**Registering a panel is not enough to render one, and the integration commit is therefore three
lines, not two.** `SidebarView` renders herd groups unconditionally today; with the lens buttons
merely enabled, `.next` and `.owed` would show empty group lists and `.done` would show live
sessions. So the integration-lane commit after S7 and S10 have both merged does all of:

1. flip `HerdLens.isAvailable` for the three lenses that now have a panel;
2. add the `if let panel = QueuesPanels.panel(for: lens) { panel() } else { herdGroups }` branch at
   the top of `SidebarView`'s content; and
3. assert both in `SidebarViewTests`.

Until it lands, the three panels are reachable and fully testable through their own accessibility
identifiers, which is what this stream's own tests drive. Recorded in the PR body so the lane does
not ship half of it.

---

### Task 10: Live check, full verification and the PR

**Read-only**, and the file says why at the top: halt interrupts every working agent, held-spawn
starts one, revive-stranded resumes several. The live test reads `held()`, `stranded()`,
`doneSessions()` and `recaps()`, asserts every done session has an `archivedAt` and that every recap
key matches a `sessionId`, and issues no write.

Then the standard close: every gate, the ownership proof
(`git diff --name-only origin/main...HEAD | sort` — **`Sources/Sidebar/**` must not appear**), a
rebase, the PR, CI.

```bash
bun run test:contract && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && bun run check:strings && (cd ui && bun run check:i18n) && bun run lint && bun run typecheck \
  && bun run test && swift test --package-path native \
  && git checkout -- native/Package.resolved \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests \
  && ./native/scripts/build-app.sh
```

PR title: `feat(mac): held tasks, up next and the done panel`. The body names what landed, the six
deviations, the two-line lens-enabling follow-up for the integration lane, the
`StreamRegistrations` one-liner (`QueuesStream.install(app)`), and the verification list. It ends
with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

**Spec coverage.** The master plan's S10 scope lists seven deliverables. Held gate → Tasks 1 and 6.
Up-next → Tasks 1 and 7, with the `GET /api/up-next` impossibility resolved rather than ignored
(deviation 2). Done panel + restore → Tasks 2 and 8, using `listDoneSessions` and `listRecaps`
already in the kit, which is why the panel is task 2 and needs no contract work. Halt/retry →
Tasks 1 and 8. Stranded → Tasks 1 and 8. "Declaring only what is missing in a
`# ── stream: queues ──` block" → Task 1, which declares nothing that already exists: `Session`,
`Ok`, `Error`, `HoldReason`, `AgentProvider`, `CreateSessionRequest` and `IssueRef` are all
`$ref`'d. Enabling the `next` / `owed` / `done` lenses → Task 9's panels registry plus the
two-line integration commit (deviation 1), because the enum belongs to S7 this milestone. Tests →
every task ends with one. Final task → Task 10.

**Placeholders.** None in Task 1, which carries the schema and status decisions in full. Tasks 2 and
5–9 carry their rules and their copy keys and name the web component each rule is ported from,
rather than a full SwiftUI body: `SessionStatusStyle.swift`, `SessionCommandState` and the existing
`SidebarModel` are files whose real API the implementer must read, and re-deriving a second busy
gate here is the review rejection. Two deliberate forward references, each named where it appears:
Task 2's Bring-back button is disabled until Task 8 wraps `/restore`, and Task 2's `blocks` render
depends on the integration commit that puts `VisualBlock` on `Recap` after **S8** merges.

**Type consistency.** `HeldQueueEntry` is one schema, one typealias, and the same type in the kit,
`QueuesModel.held` and `HeldQueueView`; the core `HeldTask` is never confused with it, and
deviation 3 says so. `UpNextSnapshot` / `UpNextSection` / `UpNextItem` are each declared once and
the panel's grouping reads them by name. `UpNextStartResult`'s three arrays are the same three in
the kit signature, in the start handler and in the notices. `SessionUsage`'s nine fields are the
same nine in the contract, in the kit and in `DoneRecapView`. `HerdLens` is S7's enum, read here and
never written.

**No duplicate path claims.** The thirteen paths this block adds — `/api/held`, `/api/held/{id}`,
`/api/held/{id}/spawn`, `/api/up-next/refresh`, `/api/up-next/start`, `/api/halt`, `/api/retry`,
`/api/stranded`, `/api/revive-stranded`, `/api/broadcast`, `/api/sessions/{id}/restore`,
`/api/sessions/{id}/usage` — appear in no other block and in no core path.
`GET /api/sessions/done` and `GET /api/recaps` are **already declared** (core and S4's `actions`
block respectively) and are consumed, not redeclared. `GET /api/up-next` is deliberately undeclared.
`GET /api/manual-steps/outstanding` is **S9's** and is not claimed here, which is why the `owed`
panel reads `SessionSignals.manualStepsOutstanding` instead. The six event names appear in no other
block.
