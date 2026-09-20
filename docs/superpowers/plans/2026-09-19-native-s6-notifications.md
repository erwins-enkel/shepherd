# Stream S6 — Local notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shepherd for Mac tell the operator when a session needs them — the same five things
the web UI pushes for (a turn finished, an agent blocked, a session waiting on you, the merge train
stuck, the 5-hour usage cap in sight) — as `UserNotifications` banners driven by
`SessionStore.events()`, quiet while the window is focused, with a per-profile on/off and category
switch, a Dock badge, and a click that selects the session.

**Architecture:** Everything is pure except one thin adapter. `NotificationTrigger` turns a
`ServerEvent` into a `NotificationIntent` (the port of `src/push.ts`'s `attachPush`,
`attachMergePush` and `attachUsagePush`), `NotificationCopy` turns an intent into a title and a body
(the port of `buildPayload` + `NOTIFY_TEXT`), `NotificationGate` decides whether it may be shown
(focus, per-profile settings, the 120 s cooldown), and `NotificationsModel` — one `AppExtension` —
wires those to a tap on `SessionStore.events()` and to an injected `NotificationCenterClient`.
`SystemNotificationCenter` is the only file that touches `UserNotifications`; the tests use
`FakeNotificationCenter` and never ask macOS for anything.

**Tech Stack:** Swift 6 (language mode 6, strict concurrency `complete`), `UserNotifications`,
SwiftUI, Swift Testing (`import Testing`), `os.Logger`, Bun for the string-catalog generator.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route or
  event this stream needs is added to `contracts/openapi.yaml` first, then
  `bun run gen:contract-swift` + `./native/scripts/sync-contract.sh` regenerate and copy the derived
  file. Never hand-edit `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
  **This stream adds nothing to the contract** — see "No contract task" below — so the two commands
  appear here only in the gate sweep.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
  (This stream adds no kit file at all.)
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_NOTIFICATIONS` in `native/scripts/gen-strings.ts`. Never
  add a string only in Swift. German copy matches the web verbatim.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh` (which export `SHEPHERD_ISOLATED=1`, so the app runs on a private
  `UserDefaults` suite and an `InMemoryCredentialStore`). `SHEPHERD_KEYCHAIN_TESTS` is **never** set
  locally — it is CI's switch for the real-keychain suite. This stream adds a second prompt to keep
  off: an isolated launch installs `FakeNotificationCenter` and therefore never calls
  `requestAuthorization`, so an unattended run cannot stall behind the macOS permission alert
  either.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`): the bare runner walks the wrong file
  set and "passes" without running the suite you meant.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**,
  never from a file, and never in CI. Nothing in this branch writes either value to disk.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this stream.
  It ships `NotificationsStream.install(app)` and the integration lane (S0-int) adds the one line.
- **Logging:** `run.shepherd.mac` (`Log.app`, `Log.ui`). **Never log a session prompt, a recap body
  or a notification body** — they carry the operator's own work.
- **Branch:** `feat/native-notifications`, cut from `origin/main`. Rebase to update; never
  `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `(cd ui && bun run check:i18n)` | EN and DE agree |
| `swift test --package-path native` | the kit still compiles and passes |
| `bun run lint` · `bun run test` | repo gates |

### File ownership (hard rule)

Create or modify **only**: `native/Apps/ShepherdMac/Sources/Notifications/**` ·
`native/Apps/ShepherdMac/Tests/{NotificationCopy,NotificationTrigger,NotificationGate,NotificationSettings,NotificationsModel,NotificationsStrings,NotificationsLive}Tests.swift`
· the `KEYS_NOTIFICATIONS` array in `native/scripts/gen-strings.ts` · `ui/messages/{en,de}.json`
(append-only, union merge driver) · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`, `ShepherdApp.swift`,
`StreamRegistrations.swift`, `SessionDetailView.swift`, `WelcomeView.swift`, any slot file,
`SessionStore.swift`, `SessionStore+EventTap.swift`, `ServerEvent.swift`, `EventStream.swift`,
`ShepherdClient.swift`, `contracts/openapi.yaml`, `test/contract/**`, `project.yml`, `native.yml`.
`project.yml` needs no edit: its `sources: - path: Sources` entry globs new subdirectories, and
`UserNotifications` is a system framework that SwiftUI targets link implicitly — no entitlement is
required for **local** notifications (`aps-environment` is for remote push, which this app does not
use).

### Preconditions — verify before Task 1

```bash
grep -q "KEYS_NOTIFICATIONS" native/scripts/gen-strings.ts \
  && test -f native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift \
  && test -f native/Sources/ShepherdKit/Model/SessionStore+EventTap.swift \
  && grep -q "public func setActive" native/Sources/ShepherdKit/Model/SessionStore.swift \
  && grep -q "var selectedSessionID: String?" native/Apps/ShepherdMac/Sources/App/AppModel.swift \
  && grep -q "case unknown(name: String, payload: Data?)" native/Sources/ShepherdKit/Realtime/ServerEvent.swift \
  && echo OK || echo "S0-prep MISSING — stop and tell the orchestrator"
```

Expected: `OK`.

### No contract task — and why that is correct

Every other stream's Task 1 extends `contracts/openapi.yaml`. This one does not, for two reasons,
both of which must survive review:

1. **This stream needs no new surface.** All five triggers ride events the core block already
   declares and `ServerEvent` already decodes into typed cases: `session:status`, `session:block`,
   `session:ready`, `automerge:status`, `usage:limits`. There is nothing to add.
2. **There is no `notifications` block to add to.** `test/contract/stream-blocks.ts` fixes
   `STREAM_NAMES = ["terminal", "detail", "sidebar", "actions"]`, and
   `test/contract/stream-blocks.test.ts` requires exactly those twelve marker pairs, present and in
   order. Opening a fifth block would mean editing `stream-blocks.ts`, its test and
   `contracts/README.md` — three shared files this stream does not own.

The one event the stream brief mentioned that is **not** in the core block is `session:recap`, which
**S4 declares** in the `actions` block. Recap-driven notifications are therefore deferred: once S4
merges, adding them is a `NotificationTrigger` case plus two catalog keys, with no contract work.
That deferral is listed under "Deliberate deviations" and repeated in the PR body.

### Deliberate deviations from the stream brief

The brief asked for notifications on "session ready/blocked/needs-input/failed and whatever the web
UI notifies on". Reading `src/push.ts` changed four things.

1. **There is no `failed` session status.** `SessionStatus` is
   `running | idle | blocked | done | archived` (`src/types.ts`). A halt with
   `haltReason == "error"` and a red CI rollup are the two things that read as "failed", and the web
   notifies for neither as a category of its own: a halted session reaches the operator as the
   `done` notification, and CI failure rides `session:git`, which S2 owns. **This stream notifies on
   exactly what the web pushes from these five events and invents no sixth kind.**
   "Needs input" is `blocked`, which is covered.
2. **`review`, `review-human`, `ci`, `autopilot`, `autopilot-done`, `extra_credits`,
   `learnings_*`, `backup_stale`, `onboarding_stale`, `landing_conflict` and `judge_ceiling` are
   out.** Every one of them is driven by an event that is not in the contract
   (`session:review`, `session:git`, `session:autopilot`, …). They arrive as
   `ServerEvent.unknown(name:payload:)` with no schema to decode, and hand-writing one would break
   the "contract is the only type source" rule. Each becomes a `NotificationTrigger` case the day
   its event enters the contract.
3. **Two categories, not three.** The web's device panel offers `agent`, `reviews` and `ci`
   (`KIND_CATEGORY` in `src/push.ts`). This stream produces no `reviews` kind (see 2), so the
   settings panel shows `agent` and `ci`; the third toggle lands with the review events.
4. **The badge counts less than the web's.** `deriveTabState`
   (`ui/src/lib/tab-signal.svelte.ts`) counts ci-red ∪ blocked ∪ unanswered-plan-question ∪
   ready-to-merge. The first needs `GitState` (S2) and the third needs `PlanGate` (no stream owns
   it), so the native badge counts blocked ∪ ready-to-merge and exposes
   `NotificationsModel.extraAttention` as the seam S0-int assigns once S2 lands. The badge also
   mirrors the web in clearing the instant the window is focused.

**Where the web's push copy lives, and why it is copied.** The design spec says the titles and
bodies "come from the same catalog keys `src/push.ts::buildPayload` uses". They do not: `push.ts`
carries its own inline EN/DE `NOTIFY_TEXT` table, because the server package cannot import the
Paraglide catalogs. Task 1 therefore mirrors that copy **verbatim** into `ui/messages/{en,de}.json`
under `native_notify_*` keys, so the app obeys the repo's i18n rule and the two surfaces read the
same. The blocked body is the exception: it is `renderHold(...)` output, and the identical lines
already exist in the catalogs as `hold_blocked_*` / `hold_quota_*`, so those keys are reused rather
than duplicated.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | Strings: `KEYS_NOTIFICATIONS` + EN/DE | `gen-strings.ts`, `ui/messages/*.json` |
| 2 | `NotificationKind` and `NotificationCopy` | `Sources/Notifications/NotificationCopy.swift` |
| 3 | `NotificationTrigger` — events to intents | `Sources/Notifications/NotificationTrigger.swift` |
| 4 | `NotificationSettings` — per-profile storage | `Sources/Notifications/NotificationSettings.swift` |
| 5 | `NotificationCenterClient` + the system adapter | `Sources/Notifications/NotificationCenterClient.swift` |
| 6 | `NotificationsModel`, the gate, the badge, the install | `Sources/Notifications/{NotificationGate,NotificationsModel,NotificationsStream}.swift` |
| 7 | Settings window and menu item | `Sources/Notifications/NotificationSettingsView.swift` |
| 8 | Live check, gate sweep, PR | `Tests/NotificationsLiveTests.swift` |

---

### Task 1: Strings — `KEYS_NOTIFICATIONS` and the EN/DE additions

**Files:** modify `native/scripts/gen-strings.ts` (the `KEYS_NOTIFICATIONS` array only) and
`ui/messages/{en,de}.json`; regenerate `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`;
create `native/Apps/ShepherdMac/Tests/NotificationsStringsTests.swift`.

**Interfaces:** produces every catalog key Tasks 2, 6 and 7 pass to `L.t(_:)` / `L.t(_:_:)`.

- [ ] **Step 1: Cut the branch**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-notifications -b feat/native-notifications origin/main
cd .claude/worktrees/feat-native-notifications && bun install
```

- [ ] **Step 2: Append the notification copy to both catalogs**

Every title and body below is copied **verbatim** from `NOTIFY_TEXT` in `src/push.ts` (EN at
`src/push.ts` `en:`, DE at `de:`), with the template literal's `${name}` / `${pct}` / `${desig}` /
`${time}` rewritten as Paraglide's `{name}` / `{pct}` / `{desig}` / `{time}`. Append before the
closing brace of `ui/messages/en.json`:

```json
  "native_notify_done_title": "{name} — waiting",
  "native_notify_done_body": "Agent finished its turn.",
  "native_notify_blocked_title": "{name} — needs you",
  "native_notify_ready_title": "{name} — your turn",
  "native_notify_ready_body": "Waiting on you for 5s — your turn.",
  "native_notify_manual_steps_title": "{name} — manual steps",
  "native_notify_manual_steps_body": "Ready to merge, but held until you ack the manual steps it needs.",
  "native_notify_merge_error_title": "Merge failed",
  "native_notify_merge_error_body": "{desig}: the merge train needs your help",
  "native_notify_rebase_cap_title": "Rebase limit reached",
  "native_notify_rebase_cap_body": "{desig}: too many rebase attempts — over to you",
  "native_notify_usage_title": "5-hour limit at {pct}%",
  "native_notify_usage_body": "Approaching the usage cap.",
  "native_notify_usage_body_reset": "Approaching the usage cap — resets at {time}.",
  "native_notify_settings_title": "Notifications",
  "native_notify_settings_menu_item": "Notifications…",
  "native_notify_settings_enabled": "Notify me about this server",
  "native_notify_settings_scope": "These settings apply to {name} only.",
  "native_notify_settings_quiet_hint": "Nothing is shown while the Shepherd window is focused — the list in front of you already says it.",
  "native_notify_settings_permission_ask": "Allow notifications",
  "native_notify_settings_permission_denied": "macOS is not letting Shepherd post notifications. Turn them on in System Settings › Notifications › Shepherd."
```

and to `ui/messages/de.json`:

```json
  "native_notify_done_title": "{name} — wartet",
  "native_notify_done_body": "Agent hat seinen Zug beendet.",
  "native_notify_blocked_title": "{name} — braucht dich",
  "native_notify_ready_title": "{name} — du bist dran",
  "native_notify_ready_body": "Wartet seit 5s auf dich — du bist dran.",
  "native_notify_manual_steps_title": "{name} — manuelle Schritte",
  "native_notify_manual_steps_body": "Bereit zum Mergen, aber zurückgehalten, bis du die manuellen Schritte bestätigst.",
  "native_notify_merge_error_title": "Merge fehlgeschlagen",
  "native_notify_merge_error_body": "{desig}: der Merge-Train braucht deine Hilfe",
  "native_notify_rebase_cap_title": "Rebase-Limit erreicht",
  "native_notify_rebase_cap_body": "{desig}: zu viele Rebase-Versuche — du bist dran",
  "native_notify_usage_title": "5-Stunden-Limit bei {pct} %",
  "native_notify_usage_body": "Limit fast erreicht.",
  "native_notify_usage_body_reset": "Limit fast erreicht — Reset um {time}.",
  "native_notify_settings_title": "Benachrichtigungen",
  "native_notify_settings_menu_item": "Benachrichtigungen…",
  "native_notify_settings_enabled": "Über diesen Server benachrichtigen",
  "native_notify_settings_scope": "Diese Einstellungen gelten nur für {name}.",
  "native_notify_settings_quiet_hint": "Solange das Shepherd-Fenster im Vordergrund ist, wird nichts angezeigt — die Liste vor dir sagt es bereits.",
  "native_notify_settings_permission_ask": "Benachrichtigungen erlauben",
  "native_notify_settings_permission_denied": "macOS lässt Shepherd keine Benachrichtigungen senden. Aktiviere sie in Systemeinstellungen › Mitteilungen › Shepherd."
```

The blocked **body** adds nothing new: `hold_blocked_menu`, `hold_blocked_yes_no`,
`hold_blocked_awaiting_input`, `hold_blocked_stall`, `hold_blocked_generic`, `hold_quota_rework`,
`hold_quota_review`, `hold_quota_error` and `hold_quota_plan` already carry exactly the lines
`src/hold.ts` renders. The category labels reuse `settings_push_cat_agent` and
`settings_push_cat_ci`.

- [ ] **Step 3: Fill `KEYS_NOTIFICATIONS`**

Replace the empty array S0-prep left in `native/scripts/gen-strings.ts` with:

```ts
/** S6 — notification titles and bodies. Keep alphabetical. */
export const KEYS_NOTIFICATIONS: readonly string[] = [
  "hold_blocked_awaiting_input", "hold_blocked_generic", "hold_blocked_menu",
  "hold_blocked_stall", "hold_blocked_yes_no", "hold_quota_error", "hold_quota_plan",
  "hold_quota_review", "hold_quota_rework",
  "native_notify_blocked_title", "native_notify_done_body", "native_notify_done_title",
  "native_notify_manual_steps_body", "native_notify_manual_steps_title",
  "native_notify_merge_error_body", "native_notify_merge_error_title",
  "native_notify_ready_body", "native_notify_ready_title",
  "native_notify_rebase_cap_body", "native_notify_rebase_cap_title",
  "native_notify_settings_enabled", "native_notify_settings_menu_item",
  "native_notify_settings_permission_ask", "native_notify_settings_permission_denied",
  "native_notify_settings_quiet_hint", "native_notify_settings_scope",
  "native_notify_settings_title", "native_notify_usage_body", "native_notify_usage_body_reset",
  "native_notify_usage_title",
  "settings_push_cat_agent", "settings_push_cat_ci",
];
```

`common_close`, `common_cancel` and `common_save` are already in `KEYS_CORE`; a key in two arrays
fails the generator by name. If S3's `KEYS_SIDEBAR` has already claimed a `hold_*` key on `main`
when this branch rebases, the generator will say which — move it out of **this** array, never out
of the other stream's.

- [ ] **Step 4: Regenerate and check both gates**

```bash
bun run native/scripts/gen-strings.ts && bun run check:strings && (cd ui && bun run check:i18n)
```

Expected: `Localizable.xcstrings is up to date (N keys).` and the UI i18n gate passes.

- [ ] **Step 5: Write the catalog test**

`native/Apps/ShepherdMac/Tests/NotificationsStringsTests.swift`:

```swift
import Testing

@testable import Shepherd

/// A missing catalog entry makes `String(localized:)` echo the key back, which would post a
/// banner reading `native_notify_done_title`.
@MainActor
struct NotificationsStringsTests {
    @Test func everyPlainKeyResolves() {
        let keys: [StaticString] = [
            "hold_blocked_awaiting_input", "hold_blocked_generic", "hold_blocked_menu",
            "hold_blocked_stall", "hold_blocked_yes_no", "hold_quota_error", "hold_quota_plan",
            "hold_quota_review", "hold_quota_rework", "native_notify_done_body",
            "native_notify_manual_steps_body", "native_notify_merge_error_title",
            "native_notify_ready_body", "native_notify_rebase_cap_title",
            "native_notify_settings_enabled", "native_notify_settings_menu_item",
            "native_notify_settings_permission_ask",
            "native_notify_settings_permission_denied", "native_notify_settings_quiet_hint",
            "native_notify_settings_title", "native_notify_usage_body",
            "settings_push_cat_agent", "settings_push_cat_ci",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(!value.contains("_"), "key \(key) did not resolve")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        let keys: [StaticString] = [
            "native_notify_blocked_title", "native_notify_done_title",
            "native_notify_manual_steps_title", "native_notify_merge_error_body",
            "native_notify_ready_title", "native_notify_rebase_cap_body",
            "native_notify_settings_scope", "native_notify_usage_body_reset",
            "native_notify_usage_title",
        ]
        for key in keys {
            #expect(L.t(key, "MARKER").contains("MARKER"), "key \(key) dropped its argument")
        }
    }
}
```

- [ ] **Step 6: Run the app tests and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/scripts/gen-strings.ts native/Apps/ShepherdMac/Resources/Localizable.xcstrings \
  ui/messages/en.json ui/messages/de.json \
  native/Apps/ShepherdMac/Tests/NotificationsStringsTests.swift
git commit -m "feat(i18n): notification catalog keys for the mac app"
```

---

### Task 2: `NotificationKind` and `NotificationCopy`

**Files:** create `native/Apps/ShepherdMac/Sources/Notifications/NotificationCopy.swift` and
`native/Apps/ShepherdMac/Tests/NotificationCopyTests.swift`.

**Interfaces:**
- Consumes: `BlockReason`, `SessionStatusKnown` (ShepherdKit), `L`.
- Produces: `NotificationCategory` (`.agent`, `.ci`), `NotificationKind`
  (`.done`, `.blocked`, `.ready`, `.mergeError`, `.rebaseCap`, `.manualSteps`, `.usageLimit`, each
  with `id: String` and `category: NotificationCategory`), `NotificationIntent`
  (`kind`, `sessionID: String?`, `subject: String`, `blockShape: BlockShapeCopy?`,
  `pct: Int?`, `resetAt: Int?`, `cooldownKey: String`, `threadIdentifier: String`),
  `BlockShapeCopy` (`.menu`, `.yesNo`, `.awaitingInput`, `.stall`, `.quota(QuotaKindCopy?)`,
  `.generic`), `QuotaKindCopy` (`.rework`, `.review`, `.error`, `.plan`), and `NotificationCopy`
  with `static func title(_:) -> String`, `static func body(_:locale:) -> String`,
  `static func blockShape(of:) -> BlockShapeCopy`.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/NotificationCopyTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The port of `buildPayload` + `NOTIFY_TEXT` in `src/push.ts`. Each test names the web case it
/// pins; the copy itself lives in the catalogs and is only assembled here.
@MainActor
struct NotificationCopyTests {
    private func intent(
        _ kind: NotificationKind,
        subject: String = "TASK-07",
        sessionID: String? = "s1",
        blockShape: BlockShapeCopy? = nil,
        pct: Int? = nil,
        resetAt: Int? = nil
    ) -> NotificationIntent {
        NotificationIntent(
            kind: kind, sessionID: sessionID, subject: subject, blockShape: blockShape,
            pct: pct, resetAt: resetAt)
    }

    @Test func titlesCarryTheSubject() {
        #expect(NotificationCopy.title(intent(.done)) == L.t("native_notify_done_title", "TASK-07"))
        #expect(
            NotificationCopy.title(intent(.blocked, blockShape: .stall))
                == L.t("native_notify_blocked_title", "TASK-07"))
        #expect(NotificationCopy.title(intent(.ready)) == L.t("native_notify_ready_title", "TASK-07"))
        #expect(
            NotificationCopy.title(intent(.manualSteps))
                == L.t("native_notify_manual_steps_title", "TASK-07"))
        // The two merge-train titles name no session: the web's are bare strings too.
        #expect(NotificationCopy.title(intent(.mergeError)) == L.t("native_notify_merge_error_title"))
        #expect(NotificationCopy.title(intent(.rebaseCap)) == L.t("native_notify_rebase_cap_title"))
        #expect(
            NotificationCopy.title(intent(.usageLimit, sessionID: nil, pct: 83))
                == L.t("native_notify_usage_title", "83"))
    }

    @Test func theBlockedBodyIsTheHoldLineForItsShape() {
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .menu)) == L.t("hold_blocked_menu"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .yesNo))
                == L.t("hold_blocked_yes_no"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .awaitingInput))
                == L.t("hold_blocked_awaiting_input"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .stall))
                == L.t("hold_blocked_stall"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .quota(.rework)))
                == L.t("hold_quota_rework"))
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: .quota(nil)))
                == L.t("hold_blocked_generic"),
            "a quota block with no kind falls back to blocked-generic, exactly as the web does")
        #expect(
            NotificationCopy.body(intent(.blocked, blockShape: nil)) == L.t("hold_blocked_generic"))
    }

    @Test func mergeBodiesNameTheDesignation() {
        #expect(
            NotificationCopy.body(intent(.mergeError, subject: "TASK-07"))
                == L.t("native_notify_merge_error_body", "TASK-07"))
        #expect(
            NotificationCopy.body(intent(.rebaseCap, subject: "TASK-07"))
                == L.t("native_notify_rebase_cap_body", "TASK-07"))
    }

    @Test func theUsageBodyNamesTheResetTimeOnlyWhenItHasOne() {
        let plain = NotificationCopy.body(intent(.usageLimit, sessionID: nil, pct: 83))
        #expect(plain == L.t("native_notify_usage_body"))

        let at = NotificationCopy.body(
            intent(.usageLimit, sessionID: nil, pct: 83, resetAt: 1_800_003_600_000),
            locale: Locale(identifier: "en_US"))
        #expect(at != plain)
        #expect(at.count > plain.count, "the reset-time variant names a time the plain one does not")
    }

    @Test func blockShapeReadsTheOpenEnumAndItsQuotaKind() {
        let stall = BlockReason(shape: .init(value1: .stall), options: [], tail: [])
        #expect(NotificationCopy.blockShape(of: stall) == .stall)

        let quota = BlockReason(
            shape: .init(value1: .quota), options: [], tail: [],
            quotaKind: .init(value1: .review))
        #expect(NotificationCopy.blockShape(of: quota) == .quota(.review))

        // An open enum: a shape this build has never heard of must degrade, not crash.
        let future = BlockReason(shape: .init(value2: "telepathy"), options: [], tail: [])
        #expect(NotificationCopy.blockShape(of: future) == .generic)
    }

    @Test func everyKindHasAStableIdAndACategory() {
        let kinds: [NotificationKind] = [
            .done, .blocked, .ready, .mergeError, .rebaseCap, .manualSteps, .usageLimit,
        ]
        #expect(Set(kinds.map(\.id)).count == kinds.count)
        // KIND_CATEGORY in src/push.ts: done/blocked/ready/usage_limit are "agent";
        // merge_attention and manual_steps are "ci".
        #expect(NotificationKind.done.category == .agent)
        #expect(NotificationKind.blocked.category == .agent)
        #expect(NotificationKind.ready.category == .agent)
        #expect(NotificationKind.usageLimit.category == .agent)
        #expect(NotificationKind.mergeError.category == .ci)
        #expect(NotificationKind.rebaseCap.category == .ci)
        #expect(NotificationKind.manualSteps.category == .ci)
    }

    @Test func theCooldownKeyAndThreadMatchTheWebsTagging() {
        // cooldownKey = `${kind}:${sessionId}` (PushService.notify); the merge kinds key by the
        // affected session so two sessions in one repo never collapse into one banner.
        #expect(intent(.done).cooldownKey == "done:s1")
        #expect(intent(.mergeError).cooldownKey == "merge_error:s1")
        #expect(intent(.usageLimit, sessionID: nil).cooldownKey == "usage_limit:5h")
        #expect(intent(.done).threadIdentifier == "s1")
        #expect(intent(.usageLimit, sessionID: nil).threadIdentifier == "usage-5h")
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationCopyTests 2>&1 | tail -20
```

Expected: `cannot find 'NotificationCopy' in scope`.

- [ ] **Step 3: Write the module**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationCopy.swift`:

```swift
import Foundation
import ShepherdKit

/// The toggle a notification rides. Mirrors `PushCategory` in `src/push.ts`; the web's third
/// category, `reviews`, has no native trigger yet because its events are not in the contract.
enum NotificationCategory: String, CaseIterable, Sendable {
    case agent
    case ci

    var label: String {
        switch self {
        case .agent: L.t("settings_push_cat_agent")
        case .ci: L.t("settings_push_cat_ci")
        }
    }
}

/// What a notification is about. One case per `NotifyInput.kind` this stream can derive from the
/// events the contract declares.
enum NotificationKind: Sendable, Equatable {
    case done
    case blocked
    case ready
    case mergeError
    case rebaseCap
    case manualSteps
    case usageLimit

    /// The web's `kind` string, so the cooldown key reads the same on both sides and a log line
    /// from either is comparable.
    var id: String {
        switch self {
        case .done: "done"
        case .blocked: "blocked"
        case .ready: "ready"
        case .mergeError: "merge_error"
        case .rebaseCap: "rebase_cap"
        case .manualSteps: "manual_steps"
        case .usageLimit: "usage_limit"
        }
    }

    /// `KIND_CATEGORY` in `src/push.ts`.
    var category: NotificationCategory {
        switch self {
        case .done, .blocked, .ready, .usageLimit: .agent
        case .mergeError, .rebaseCap, .manualSteps: .ci
        }
    }

    /// The web lets `ready` past the per-device category filter unconditionally
    /// (`if (input.kind !== "ready" && !row.cats[category]) continue;`) — it is the one signal
    /// that must reach the operator whatever they muted.
    var bypassesCategoryFilter: Bool { self == .ready }
}

/// Which hold line a `blocked` notification's body uses. A copy of `BlockShape` from
/// `src/blocked.ts` plus the `generic` fallback `blockReasonToHoldCode` falls back to.
enum BlockShapeCopy: Equatable, Sendable {
    case menu
    case yesNo
    case awaitingInput
    case stall
    case quota(QuotaKindCopy?)
    case generic
}

/// `BlockReason.quotaKind` from `src/blocked.ts`.
enum QuotaKindCopy: String, Equatable, Sendable {
    case rework
    case review
    case error
    case plan
}

/// One notification, described by intent rather than by text — exactly as the server's
/// `NotifyInput` is, and for the same reason: the text is a function of the operator's locale,
/// which is resolved at render time.
struct NotificationIntent: Equatable, Sendable {
    let kind: NotificationKind
    /// The session to select when the banner is clicked. `nil` for the host-global usage warning.
    let sessionID: String?
    /// What the copy names: a session's display name, or the merge train's designation.
    let subject: String
    let blockShape: BlockShapeCopy?
    let pct: Int?
    let resetAt: Int?

    init(
        kind: NotificationKind,
        sessionID: String?,
        subject: String,
        blockShape: BlockShapeCopy? = nil,
        pct: Int? = nil,
        resetAt: Int? = nil
    ) {
        self.kind = kind
        self.sessionID = sessionID
        self.subject = subject
        self.blockShape = blockShape
        self.pct = pct
        self.resetAt = resetAt
    }

    /// `input.cooldownKey ?? \`${kind}:${sessionId}\`` in `PushService.notify`. The host-global
    /// usage warning uses the web's own fixed key.
    var cooldownKey: String {
        guard let sessionID else { return "\(kind.id):5h" }
        return "\(kind.id):\(sessionID)"
    }

    /// The `tag` the service worker passes to the Notification API — macOS's equivalent is the
    /// thread identifier, which groups a session's banners in Notification Centre.
    var threadIdentifier: String { sessionID ?? "usage-5h" }
}

/// Title and body for an intent. Pure and synchronous, so every line is assertable without
/// hosting a view or touching `UNUserNotificationCenter`.
enum NotificationCopy {
    static func title(_ intent: NotificationIntent) -> String {
        switch intent.kind {
        case .done: L.t("native_notify_done_title", intent.subject)
        case .blocked: L.t("native_notify_blocked_title", intent.subject)
        case .ready: L.t("native_notify_ready_title", intent.subject)
        case .manualSteps: L.t("native_notify_manual_steps_title", intent.subject)
        case .mergeError: L.t("native_notify_merge_error_title")
        case .rebaseCap: L.t("native_notify_rebase_cap_title")
        // String, not Int: `gen-strings.ts` renders every placeholder as `%1$@`, and handing
        // `String(format:)` an Int for an object conversion is undefined behaviour.
        case .usageLimit: L.t("native_notify_usage_title", String(intent.pct ?? 0))
        }
    }

    static func body(
        _ intent: NotificationIntent,
        locale: Locale = .current
    ) -> String {
        switch intent.kind {
        case .done: return L.t("native_notify_done_body")
        case .ready: return L.t("native_notify_ready_body")
        case .manualSteps: return L.t("native_notify_manual_steps_body")
        case .mergeError: return L.t("native_notify_merge_error_body", intent.subject)
        case .rebaseCap: return L.t("native_notify_rebase_cap_body", intent.subject)
        case .blocked: return holdLine(for: intent.blockShape)
        case .usageLimit:
            guard let resetAt = intent.resetAt else { return L.t("native_notify_usage_body") }
            let time = Date(timeIntervalSince1970: Double(resetAt) / 1_000)
                .formatted(.dateTime.hour().minute().locale(locale))
            return L.t("native_notify_usage_body_reset", time)
        }
    }

    /// `blockReasonToHoldCode` + `renderHold` from `src/hold.ts`, reusing the identical catalog
    /// lines the web's hold row already renders.
    private static func holdLine(for shape: BlockShapeCopy?) -> String {
        switch shape {
        case .menu: L.t("hold_blocked_menu")
        case .yesNo: L.t("hold_blocked_yes_no")
        case .awaitingInput: L.t("hold_blocked_awaiting_input")
        case .stall: L.t("hold_blocked_stall")
        case .quota(.rework): L.t("hold_quota_rework")
        case .quota(.review): L.t("hold_quota_review")
        case .quota(.error): L.t("hold_quota_error")
        case .quota(.plan): L.t("hold_quota_plan")
        case .quota(nil), .generic, nil: L.t("hold_blocked_generic")
        }
    }

    /// Reads the contract's two open enums off a `BlockReason`. A shape or kind this build has
    /// never heard of degrades to the generic line rather than dropping the notification: the
    /// operator still needs to know the agent stopped.
    static func blockShape(of block: BlockReason) -> BlockShapeCopy {
        switch block.shape.value1 {
        case .menu: return .menu
        case .yesNo: return .yesNo
        case .awaitingInput: return .awaitingInput
        case .stall: return .stall
        case .quota:
            switch block.quotaKind?.value1 {
            case .rework: return .quota(.rework)
            case .review: return .quota(.review)
            case .error: return .quota(.error)
            case .plan: return .quota(.plan)
            case nil: return .quota(nil)
            }
        case nil: return .generic
        }
    }
}
```

`BlockReason.shape` is an **inline** flagged enum, so the generator emits an anonymous `anyOf`
payload with `value1` (the closed enum) and `value2` (the raw string) rather than a named type —
that is why the code reads `block.shape.value1`.

**Generated enum-case spelling.** `native/Sources/ShepherdKit/openapi-generator-config.yaml` sets
`namingStrategy: idiomatic` and `accessModifier: public`, so every `Components.Schemas.*` type is
visible from the app target and a hyphenated member folds to camelCase: `yes-no` → `.yesNo`,
`awaiting-input` → `.awaitingInput`. Characters the strategy cannot fold keep the defensive
substitution — which is why `EventName`'s members read `.session_colon_new`. Confirm both case
names against the generated `Components.Schemas.BlockReason` in `native/.build/` before writing
this file; never rename a contract member to make a guess compile.

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationCopyTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationCopy.swift \
  native/Apps/ShepherdMac/Tests/NotificationCopyTests.swift
git commit -m "feat(mac): notification kinds and copy ported from src/push.ts"
```

---

### Task 3: `NotificationTrigger` — events to intents

**Files:** create `native/Apps/ShepherdMac/Sources/Notifications/NotificationTrigger.swift` and
`native/Apps/ShepherdMac/Tests/NotificationTriggerTests.swift`.

**Interfaces:**
- Consumes: `ServerEvent`, `Session`, `SessionStatusKnown`, `BlockReason`, `AutoMergeStatus`,
  `UsageLimits` (ShepherdKit); Task 2's `NotificationIntent`, `NotificationKind`,
  `NotificationCopy.blockShape(of:)`.
- Produces: `NotificationTrigger` (`static let usageWarnPercent: Int`,
  `init(subjectFor:)`, `mutating func intents(for:) -> [NotificationIntent]`), where
  `subjectFor: @MainActor (String) -> String?` resolves a session id to its display name.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/NotificationTriggerTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The port of `attachPush`, `attachMergePush` and `attachUsagePush` in `src/push.ts`. Pure: an
/// event in, zero or one intents out.
@MainActor
struct NotificationTriggerTests {
    private func trigger() -> NotificationTrigger {
        NotificationTrigger(subjectFor: { id in id == "s1" ? "TASK-07" : nil })
    }

    private func limits(pct: Double?, resetAt: Int = 1_800_003_600_000) -> UsageLimits {
        UsageLimits(
            session5h: pct.map { .init(pct: $0, resetAt: resetAt) },
            week: nil, perModelWeek: [], credits: nil,
            stale: false, calibratedAt: nil, subscriptionOnly: false)
    }

    // attachPush: `if (status !== "done") return;`
    @Test func onlyADoneStatusNotifies() {
        var t = trigger()
        #expect(
            t.intents(for: .sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
                .map(\.kind) == [.done])
        for status: SessionStatusKnown in [.running, .idle, .blocked, .archived] {
            #expect(
                t.intents(for: .sessionStatus(.init(id: "s1", status: SessionStatus(known: status))))
                    .isEmpty, "\(status) must not notify")
        }
    }

    // attachPush: `if (!block) return;` — a cleared block is good news, not a banner.
    @Test func onlyANonNullBlockNotifies() {
        var t = trigger()
        let block = BlockReason(shape: .init(value1: .yesNo), options: [], tail: [])
        let intents = t.intents(for: .sessionBlock(.init(id: "s1", block: block)))
        #expect(intents.map(\.kind) == [.blocked])
        #expect(intents.first?.blockShape == .yesNo)
        #expect(t.intents(for: .sessionBlock(.init(id: "s1", block: nil))).isEmpty)
    }

    @Test func onlyAReadyTrueNotifies() {
        var t = trigger()
        #expect(t.intents(for: .sessionReady(.init(id: "s1", ready: true))).map(\.kind) == [.ready])
        #expect(t.intents(for: .sessionReady(.init(id: "s1", ready: false))).isEmpty)
    }

    // attachMergePush: manual_steps first, then merge_error / rebase_cap; everything else ignored.
    @Test func theThreeMergeAttentionStatesNotifyAndNothingElseDoes() {
        var t = trigger()
        func status(_ state: String?) -> AutoMergeStatus {
            AutoMergeStatus(
                repoPath: "/repos/a", enabled: true, state: state, detail: "TASK-07",
                sessionId: "s1")
        }
        #expect(t.intents(for: .automergeStatus(status("manual_steps"))).map(\.kind) == [.manualSteps])
        #expect(t.intents(for: .automergeStatus(status("merge_error"))).map(\.kind) == [.mergeError])
        #expect(t.intents(for: .automergeStatus(status("rebase_cap"))).map(\.kind) == [.rebaseCap])
        #expect(t.intents(for: .automergeStatus(status("merging"))).isEmpty)
        #expect(t.intents(for: .automergeStatus(status(nil))).isEmpty)
    }

    // `const desig = detail ?? repoPath; const target = sessionId ?? repoPath;`
    @Test func aMergeAttentionWithoutASessionFallsBackToTheRepoPath() {
        var t = trigger()
        let orphan = AutoMergeStatus(
            repoPath: "/repos/a", enabled: true, state: "merge_error", detail: nil, sessionId: nil)
        let intent = t.intents(for: .automergeStatus(orphan)).first
        #expect(intent?.subject == "/repos/a")
        #expect(intent?.sessionID == "/repos/a")
    }

    // attachUsagePush: `if (!session5h || session5h.pct < USAGE_WARN_PCT) return;`
    @Test func theUsageWarningFiresAtEightyPercentAndOncePerWindow() {
        var t = trigger()
        #expect(t.intents(for: .usageLimits(limits(pct: nil))).isEmpty)
        #expect(t.intents(for: .usageLimits(limits(pct: 79))).isEmpty)

        let first = t.intents(for: .usageLimits(limits(pct: 83)))
        #expect(first.map(\.kind) == [.usageLimit])
        #expect(first.first?.pct == 83)
        #expect(first.first?.sessionID == nil)

        #expect(
            t.intents(for: .usageLimits(limits(pct: 91))).isEmpty,
            "one warning per 5-hour window, keyed by resetAt")
        #expect(
            !t.intents(for: .usageLimits(limits(pct: 83, resetAt: 1_800_020_000_000))).isEmpty,
            "a new window warns again")
    }

    @Test func anEventForAnUnknownSessionStillNotifiesUnderItsId() {
        var t = trigger()
        // store.get(id)?.name ?? id — the web falls back to the id rather than staying silent.
        let intent = t.intents(
            for: .sessionStatus(.init(id: "ghost", status: SessionStatus(known: .done)))).first
        #expect(intent?.subject == "ghost")
    }

    @Test func everyOtherFrameIsIgnored() {
        var t = trigger()
        #expect(t.intents(for: .sessionArchived(.init(id: "s1"))).isEmpty)
        #expect(t.intents(for: .sessionRenamed(.init(id: "s1", name: "n", branch: nil))).isEmpty)
        #expect(t.intents(for: .unknown(name: "session:recap", payload: nil)).isEmpty)
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationTriggerTests 2>&1 | tail -20
```

Expected: `cannot find 'NotificationTrigger' in scope`.

- [ ] **Step 3: Write the module**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationTrigger.swift`:

```swift
import Foundation
import ShepherdKit

/// Turns `/events` frames into notification intents.
///
/// A direct port of the three bridges in `src/push.ts` — `attachPush` (`session:status` = done,
/// `session:block` non-null), `attachMergePush` (`automerge:status` in an attention state) and
/// `attachUsagePush` (`usage:limits` over the warning threshold). Keeping them in one pure type
/// means the native app and the server's push can be compared case by case instead of by
/// reading two event loops.
///
/// Stateful in exactly one respect: the usage warning fires once per 5-hour window, which the
/// web persists as a `usageWarnedResetAt5h` setting. Here it is in-memory, which is the right
/// scope — a relaunched app has no banner on screen to duplicate.
struct NotificationTrigger {
    /// `USAGE_WARN_PCT` in `src/push.ts`.
    static let usageWarnPercent = 80

    /// A session id to the name the copy should use. `nil` for an id the store has not seen,
    /// which falls back to the id itself — `store.get(id)?.name ?? id` in the web.
    private let subjectFor: @MainActor (String) -> String?
    /// The `resetAt` of the 5-hour window already warned about.
    private var warnedWindow: Int?

    init(subjectFor: @escaping @MainActor (String) -> String?) {
        self.subjectFor = subjectFor
    }

    /// Zero or one intent per frame. An array rather than an optional so a later event that
    /// deserves two (none does today) needs no signature change at every call site.
    @MainActor
    mutating func intents(for event: ServerEvent) -> [NotificationIntent] {
        switch event {
        case .sessionStatus(let payload):
            guard payload.status.known == .done else { return [] }
            return [
                NotificationIntent(
                    kind: .done, sessionID: payload.id, subject: subject(payload.id))
            ]

        case .sessionBlock(let payload):
            // A cleared block is the agent coming back, not something to interrupt anybody for.
            guard let block = payload.block else { return [] }
            return [
                NotificationIntent(
                    kind: .blocked, sessionID: payload.id, subject: subject(payload.id),
                    blockShape: NotificationCopy.blockShape(of: block))
            ]

        case .sessionReady(let payload):
            guard payload.ready else { return [] }
            return [
                NotificationIntent(
                    kind: .ready, sessionID: payload.id, subject: subject(payload.id))
            ]

        case .automergeStatus(let status):
            let kind: NotificationKind
            switch status.state {
            case "manual_steps": kind = .manualSteps
            case "merge_error": kind = .mergeError
            case "rebase_cap": kind = .rebaseCap
            default: return []
            }
            // `detail ?? repoPath` names it; `sessionId ?? repoPath` is what a click selects and
            // what the cooldown keys on, so two sessions in one repo never collapse.
            let designation = status.detail ?? status.repoPath
            let target = status.sessionId ?? status.repoPath
            return [
                NotificationIntent(kind: kind, sessionID: target, subject: designation)
            ]

        case .usageLimits(let limits):
            guard let window = limits.session5h,
                Int(window.pct.rounded()) >= Self.usageWarnPercent
            else { return [] }
            guard warnedWindow != window.resetAt else { return [] }
            warnedWindow = window.resetAt
            return [
                NotificationIntent(
                    kind: .usageLimit, sessionID: nil, subject: "5h",
                    pct: Int(window.pct.rounded()), resetAt: window.resetAt)
            ]

        case .sessionNew, .sessionRenamed, .sessionArchived, .unknown:
            // Nothing the web pushes for. `session:recap` arrives here as `.unknown`; it becomes
            // a case the day S4's contract block declares it.
            return []
        }
    }

    @MainActor
    private func subject(_ id: String) -> String { subjectFor(id) ?? id }
}
```

`UsageLimits.session5h.pct` is `number` in the contract, so it decodes as `Double`; the copy and
the threshold both work in whole percent, which is why it is rounded once here.

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationTriggerTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationTrigger.swift \
  native/Apps/ShepherdMac/Tests/NotificationTriggerTests.swift
git commit -m "feat(mac): notification triggers ported from the push bridges"
```

---

### Task 4: `NotificationSettings` — per-profile storage

**Files:** create `native/Apps/ShepherdMac/Sources/Notifications/NotificationSettings.swift` and
`native/Apps/ShepherdMac/Tests/NotificationSettingsTests.swift`.

**Interfaces:**
- Consumes: `ServerProfile` (ShepherdKit), Task 2's `NotificationCategory`, `Log.app`.
- Produces: `NotificationSettings` (`Codable`, `Equatable`, `Sendable`; `enabled: Bool`,
  `categories: [String: Bool]`, `static let `default``, `func allows(_:) -> Bool`,
  `func setting(_:to:) -> NotificationSettings`, `func isOn(_:) -> Bool`) and
  `NotificationSettingsStore` (`init(defaults:)`, `func load(for: UUID) -> NotificationSettings`,
  `func save(_:for: UUID)`, `static func key(for: UUID) -> String`).

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/NotificationSettingsTests.swift`:

```swift
import Foundation
import Testing

@testable import Shepherd

@MainActor
struct NotificationSettingsTests {
    private func scratch() -> UserDefaults {
        UserDefaults(suiteName: "run.shepherd.mac.notifytests.\(UUID().uuidString)")!
    }

    @Test func theDefaultIsEverythingOn() {
        let d = NotificationSettings.default
        #expect(d.enabled)
        for category in NotificationCategory.allCases { #expect(d.isOn(category)) }
    }

    @Test func theMasterSwitchOverridesEveryCategory() {
        let off = NotificationSettings.default.settingEnabled(false)
        for category in NotificationCategory.allCases { #expect(!off.allows(category)) }
    }

    @Test func aMutedCategoryIsRefusedAndTheOthersAreNot() {
        let muted = NotificationSettings.default.setting(.ci, to: false)
        #expect(!muted.allows(.ci))
        #expect(muted.allows(.agent))
        #expect(!muted.isOn(.ci))
    }

    @Test func anUnknownCategoryInStorageDefaultsToOn() {
        // A settings blob written by a newer build may not carry today's categories. Absent must
        // mean "on": silently muting a signal the operator never turned off is the worse failure.
        let partial = NotificationSettings(enabled: true, categories: ["ci": false])
        #expect(partial.allows(.agent))
        #expect(!partial.allows(.ci))
    }

    @Test func settingsRoundTripPerProfile() {
        let defaults = scratch()
        let store = NotificationSettingsStore(defaults: defaults)
        let a = UUID()
        let b = UUID()

        #expect(store.load(for: a) == .default, "an unseen profile starts at the default")
        store.save(NotificationSettings.default.setting(.agent, to: false), for: a)
        #expect(!store.load(for: a).isOn(.agent))
        #expect(store.load(for: b) == .default, "settings are per profile, not global")
    }

    @Test func anUnreadableBlobFallsBackToTheDefaultRatherThanCrashing() {
        let defaults = scratch()
        let id = UUID()
        defaults.set(Data("not json".utf8), forKey: NotificationSettingsStore.key(for: id))
        #expect(NotificationSettingsStore(defaults: defaults).load(for: id) == .default)
    }

    @Test func theStorageKeyIsNamespacedPerProfile() {
        let id = UUID()
        #expect(
            NotificationSettingsStore.key(for: id)
                == "run.shepherd.mac.notifications.\(id.uuidString)")
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationSettingsTests 2>&1 | tail -20
```

Expected: `cannot find 'NotificationSettings' in scope`.

- [ ] **Step 3: Write the module**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationSettings.swift`:

```swift
import Foundation

/// What one server profile's notifications are allowed to do.
///
/// Per profile, not global: an operator who watches a work server all day and a home server
/// occasionally wants one of them quiet, and "which server is this about" is the only axis the
/// app can answer from what it has. The web's equivalent is per *device* — its subscription row
/// carries the category map — which has no meaning here, because the app is the device.
///
/// `categories` is a dictionary rather than three `Bool`s so a blob written by a newer build,
/// carrying a category this one has never heard of, round-trips unharmed instead of being
/// silently rewritten.
struct NotificationSettings: Codable, Equatable, Sendable {
    /// The master switch. Off means nothing is posted for this profile at all.
    var enabled: Bool
    /// Category raw value -> allowed. An absent key means allowed.
    var categories: [String: Bool]

    static let `default` = NotificationSettings(enabled: true, categories: [:])

    /// Absent means on, so a newly added category starts audible. Muting something the operator
    /// never turned off is the worse failure of the two.
    func isOn(_ category: NotificationCategory) -> Bool {
        categories[category.rawValue] ?? true
    }

    func allows(_ category: NotificationCategory) -> Bool {
        enabled && isOn(category)
    }

    func setting(_ category: NotificationCategory, to on: Bool) -> NotificationSettings {
        var copy = self
        copy.categories[category.rawValue] = on
        return copy
    }

    func settingEnabled(_ on: Bool) -> NotificationSettings {
        var copy = self
        copy.enabled = on
        return copy
    }
}

/// Per-profile settings persisted as JSON in `UserDefaults`, one key per profile id.
///
/// Mirrors `ProfileStore`'s shape deliberately, down to dropping `Sendable`: `UserDefaults` does
/// not conform on this SDK, and the global constraints forbid every escape hatch that would fake
/// it. Nothing secret lives here.
struct NotificationSettingsStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    static func key(for profileID: UUID) -> String {
        "run.shepherd.mac.notifications.\(profileID.uuidString)"
    }

    func load(for profileID: UUID) -> NotificationSettings {
        guard let data = defaults.data(forKey: Self.key(for: profileID)) else { return .default }
        do {
            return try JSONDecoder().decode(NotificationSettings.self, from: data)
        } catch {
            // Never the operator's content, so this is safe to log; and a blob we cannot read is
            // better replaced by the audible default than by silence.
            Log.app.error(
                "dropping unreadable notification settings: \(String(describing: error), privacy: .public)")
            return .default
        }
    }

    func save(_ settings: NotificationSettings, for profileID: UUID) {
        do {
            defaults.set(try JSONEncoder().encode(settings), forKey: Self.key(for: profileID))
        } catch {
            Log.app.error(
                "could not persist notification settings: \(String(describing: error), privacy: .public)")
        }
    }
}
```

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationSettingsTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationSettings.swift \
  native/Apps/ShepherdMac/Tests/NotificationSettingsTests.swift
git commit -m "feat(mac): per-profile notification settings storage"
```

---

### Task 5: `NotificationCenterClient` and the system adapter

**Files:** create `native/Apps/ShepherdMac/Sources/Notifications/NotificationCenterClient.swift` and
`native/Apps/ShepherdMac/Tests/NotificationCenterClientTests.swift`.

**Interfaces:**
- Consumes: `UserNotifications`, `Log.app`.
- Produces: `NotificationRequest` (`identifier`, `title`, `body`, `threadIdentifier`,
  `sessionID: String?`), `NotificationAuthorization` (`.notDetermined`, `.granted`, `.denied`),
  `NotificationCenterClient` protocol (`@MainActor`, `AnyObject`:
  `var onSelectSession: ((String) -> Void)? { get set }`,
  `func authorization() async -> NotificationAuthorization`,
  `func requestAuthorization() async -> NotificationAuthorization`,
  `func post(_ request: NotificationRequest) async`,
  `func setBadgeCount(_ count: Int) async`, `func start()`),
  `SystemNotificationCenter`, `FakeNotificationCenter` (`posted: [NotificationRequest]`,
  `badge: Int`, `var nextAuthorization: NotificationAuthorization`, `authorizationRequests: Int`,
  `func deliverClick(sessionID: String)`).

`FakeNotificationCenter` lives in the app target (not the test target) so previews can use it too,
and because the isolated-launch path in Task 6 installs it in the shipping binary.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/NotificationCenterClientTests.swift`:

```swift
import Foundation
import Testing

@testable import Shepherd

/// The system adapter itself is not unit-tested — it is a five-line bridge to
/// `UNUserNotificationCenter`, and exercising it would pop the macOS permission alert, which the
/// global constraints forbid. What IS tested is the seam every other task codes against.
@MainActor
struct NotificationCenterClientTests {
    @Test func theFakeRecordsWhatItWasAskedToPost() async {
        let center = FakeNotificationCenter()
        await center.post(
            NotificationRequest(
                identifier: "n1", title: "t", body: "b", threadIdentifier: "s1",
                sessionID: "s1"))
        #expect(center.posted.count == 1)
        #expect(center.posted.first?.sessionID == "s1")
        #expect(center.posted.first?.threadIdentifier == "s1")
    }

    @Test func theFakeRecordsTheBadgeAndTheAuthorizationRequest() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        #expect(await center.requestAuthorization() == .denied)
        #expect(center.authorizationRequests == 1)

        await center.setBadgeCount(3)
        #expect(center.badge == 3)
    }

    @Test func aClickIsDeliveredToTheHandler() {
        let center = FakeNotificationCenter()
        var selected: String?
        center.onSelectSession = { selected = $0 }
        center.deliverClick(sessionID: "s9")
        #expect(selected == "s9")
    }

    @Test func aRequestIdentifierIsUniquePerPost() {
        // Reusing an identifier replaces the banner already on screen. Two different sessions
        // going blocked must produce two banners, so the identifier carries a fresh UUID and the
        // GROUPING lives on threadIdentifier instead.
        let a = NotificationRequest.make(title: "t", body: "b", threadIdentifier: "s1", sessionID: "s1")
        let b = NotificationRequest.make(title: "t", body: "b", threadIdentifier: "s1", sessionID: "s1")
        #expect(a.identifier != b.identifier)
        #expect(a.threadIdentifier == b.threadIdentifier)
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationCenterClientTests 2>&1 | tail -20
```

Expected: `cannot find 'FakeNotificationCenter' in scope`.

- [ ] **Step 3: Write the module**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationCenterClient.swift`:

```swift
import Foundation
import UserNotifications

/// One banner to post. Not a server payload — it never crosses the wire — so it is an ordinary
/// value type and the "no hand-written Codable" rule does not apply.
struct NotificationRequest: Equatable, Sendable {
    /// Unique per post. `UNUserNotificationCenter` replaces a pending request with the same
    /// identifier, so reusing one would let a second session's banner eat the first's.
    let identifier: String
    let title: String
    let body: String
    /// Groups a session's banners in Notification Centre — the macOS analogue of the web
    /// service worker's `tag`.
    let threadIdentifier: String
    /// What a click selects. `nil` for the host-global usage warning, which just opens the app.
    let sessionID: String?

    static func make(
        title: String, body: String, threadIdentifier: String, sessionID: String?
    ) -> NotificationRequest {
        NotificationRequest(
            identifier: UUID().uuidString, title: title, body: body,
            threadIdentifier: threadIdentifier, sessionID: sessionID)
    }
}

/// What macOS currently allows.
enum NotificationAuthorization: Equatable, Sendable {
    case notDetermined
    case granted
    case denied
}

/// The seam between this stream and `UserNotifications`.
///
/// Every test drives `FakeNotificationCenter` through this protocol, which is what keeps the
/// suite from popping the macOS permission alert — an unattended run that stalls behind a system
/// dialog is exactly the failure the repo's "no prompts" rule exists to prevent.
@MainActor
protocol NotificationCenterClient: AnyObject {
    /// Called on the main actor when the operator clicks a banner carrying a session id.
    var onSelectSession: ((String) -> Void)? { get set }
    func authorization() async -> NotificationAuthorization
    func requestAuthorization() async -> NotificationAuthorization
    func post(_ request: NotificationRequest) async
    func setBadgeCount(_ count: Int) async
    /// Installs the click handler. Called once, after `onSelectSession` is set.
    func start()
}

/// The real thing. The only file in this stream that imports `UserNotifications`.
@MainActor
final class SystemNotificationCenter: NotificationCenterClient {
    var onSelectSession: ((String) -> Void)?

    private let center = UNUserNotificationCenter.current()
    /// `UNUserNotificationCenterDelegate` is an `NSObjectProtocol`, so the delegate itself is a
    /// small forwarding shim rather than this class.
    private lazy var delegate = ResponseDelegate { [weak self] id in self?.onSelectSession?(id) }

    /// Key in the banner's `userInfo` carrying the session id. Read back in `ResponseDelegate`.
    static let sessionKey = "shepherd.sessionID"

    func start() {
        center.delegate = delegate
    }

    func authorization() async -> NotificationAuthorization {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .authorized, .provisional, .ephemeral: .granted
        default: .denied
        }
    }

    func requestAuthorization() async -> NotificationAuthorization {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            return granted ? .granted : .denied
        } catch {
            Log.app.error(
                "notification authorization failed: \(String(describing: error), privacy: .public)")
            return .denied
        }
    }

    func post(_ request: NotificationRequest) async {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.threadIdentifier = request.threadIdentifier
        content.sound = .default
        if let sessionID = request.sessionID {
            content.userInfo = [Self.sessionKey: sessionID]
        }
        do {
            // `trigger: nil` delivers immediately.
            try await center.add(
                UNNotificationRequest(
                    identifier: request.identifier, content: content, trigger: nil))
        } catch {
            // Never log the body — it can name the operator's own work.
            Log.app.error(
                "could not post a notification: \(String(describing: error), privacy: .public)")
        }
    }

    func setBadgeCount(_ count: Int) async {
        do {
            try await center.setBadgeCount(count)
        } catch {
            Log.app.error(
                "could not set the badge: \(String(describing: error), privacy: .public)")
        }
    }

    /// Forwards a click to the closure and keeps a foregrounded banner silent, which is belt and
    /// braces: `NotificationGate` already refuses to post while the window is focused.
    private final class ResponseDelegate: NSObject, UNUserNotificationCenterDelegate {
        private let onSelect: @MainActor (String) -> Void

        init(onSelect: @escaping @MainActor (String) -> Void) {
            self.onSelect = onSelect
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            let info = response.notification.request.content.userInfo
            guard let id = info[SystemNotificationCenter.sessionKey] as? String else { return }
            await MainActor.run { self.onSelect(id) }
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            []
        }
    }
}

/// Records instead of posting. Used by every test, by previews, and — deliberately — by an
/// isolated launch, so an automated run never asks macOS for permission.
@MainActor
final class FakeNotificationCenter: NotificationCenterClient {
    var onSelectSession: ((String) -> Void)?
    private(set) var posted: [NotificationRequest] = []
    private(set) var badge = 0
    private(set) var authorizationRequests = 0
    private(set) var started = false
    var nextAuthorization: NotificationAuthorization = .granted

    func start() { started = true }
    func authorization() async -> NotificationAuthorization { nextAuthorization }

    func requestAuthorization() async -> NotificationAuthorization {
        authorizationRequests += 1
        return nextAuthorization
    }

    func post(_ request: NotificationRequest) async { posted.append(request) }
    func setBadgeCount(_ count: Int) async { badge = count }

    /// Test seam: pretend the operator clicked a banner for `sessionID`.
    func deliverClick(sessionID: String) { onSelectSession?(sessionID) }

    func reset() {
        posted.removeAll()
        badge = 0
        authorizationRequests = 0
    }
}
```

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationCenterClientTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationCenterClient.swift \
  native/Apps/ShepherdMac/Tests/NotificationCenterClientTests.swift
git commit -m "feat(mac): injectable notification center seam and its system adapter"
```

---

### Task 6: `NotificationsModel`, the gate, the badge and the install

**Files:** create `native/Apps/ShepherdMac/Sources/Notifications/NotificationGate.swift`,
`native/Apps/ShepherdMac/Sources/Notifications/NotificationsModel.swift`,
`native/Apps/ShepherdMac/Sources/Notifications/NotificationsStream.swift` and
`native/Apps/ShepherdMac/Tests/NotificationsModelTests.swift`.

**Interfaces:**
- Consumes: `AppExtension`, `AppModel.register(_:)` / `app.extension(_:)`,
  `AppModel.selectedSessionID`, `AppModel.activeProfile`, `SessionStore`, `SessionStore.events()`,
  `SessionStore.setActive(_:)`, `SessionStore.sessions`, `LaunchEnvironment.configuration()`,
  Tasks 2–5.
- Produces: `NotificationGate` (`init(cooldown:)`, `static let defaultCooldown: Int`,
  `mutating func allows(_:at:settings:windowFocused:authorized:) -> Bool`), and
  ```swift
  @Observable @MainActor final class NotificationsModel: AppExtension {
      init(store: SessionStore, app: AppModel)
      init(center: any NotificationCenterClient, settingsStore: NotificationSettingsStore,
           profileID: UUID, now: @escaping @Sendable () -> Int,
           subjectFor: @escaping @MainActor (String) -> String?,
           select: @escaping @MainActor (String) -> Void)
      var settings: NotificationSettings
      var authorization: NotificationAuthorization
      var windowFocused: Bool
      var extraAttention: Set<String>
      var isSubscribed: Bool
      func handle(_ event: ServerEvent) async
      func setWindowFocused(_ focused: Bool) async
      func updateBadge(sessions: [Session]) async
      func requestAuthorization() async
      func save(_ settings: NotificationSettings)
      func teardown()
  }
  @MainActor enum NotificationsStream { static func install(_ app: AppModel) }
  ```

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/NotificationsModelTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

@MainActor
struct NotificationGateTests {
    private let settings = NotificationSettings.default

    private func intent(_ kind: NotificationKind, _ id: String) -> NotificationIntent {
        NotificationIntent(kind: kind, sessionID: id, subject: id)
    }

    @Test func afocusedWindowStopsEverything() {
        var gate = NotificationGate()
        #expect(
            !gate.allows(
                intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: true,
                authorized: true),
            "the list in front of the operator already says it")
    }

    @Test func aDeniedAuthorizationStopsEverything() {
        var gate = NotificationGate()
        #expect(
            !gate.allows(
                intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: false,
                authorized: false))
    }

    @Test func aMutedCategoryStopsItsKindsButNotReady() {
        var gate = NotificationGate()
        let muted = settings.setting(.agent, to: false)
        #expect(
            !gate.allows(
                intent(.done, "s1"), at: 0, settings: muted, windowFocused: false,
                authorized: true))
        // `if (input.kind !== "ready" && !row.cats[category]) continue;` — ready always gets out.
        #expect(
            gate.allows(
                intent(.ready, "s1"), at: 0, settings: muted, windowFocused: false,
                authorized: true))
    }

    @Test func theMasterSwitchAlsoSilencesReady() {
        var gate = NotificationGate()
        let off = settings.settingEnabled(false)
        #expect(
            !gate.allows(
                intent(.ready, "s1"), at: 0, settings: off, windowFocused: false,
                authorized: true),
            "a profile the operator turned off is off, with no exceptions")
    }

    @Test func aRepeatWithinTheCooldownIsDropped() {
        var gate = NotificationGate()
        let first = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: false, authorized: true)
        #expect(first)
        #expect(
            !gate.allows(
                intent(.done, "s1"), at: NotificationGate.defaultCooldown - 1, settings: settings,
                windowFocused: false, authorized: true))
        #expect(
            gate.allows(
                intent(.done, "s1"), at: NotificationGate.defaultCooldown, settings: settings,
                windowFocused: false, authorized: true))
    }

    @Test func distinctKindsAndSessionsNeverCollapse() {
        var gate = NotificationGate()
        #expect(
            gate.allows(
                intent(.done, "s1"), at: 0, settings: settings, windowFocused: false,
                authorized: true))
        #expect(
            gate.allows(
                intent(.blocked, "s1"), at: 1, settings: settings, windowFocused: false,
                authorized: true))
        #expect(
            gate.allows(
                intent(.done, "s2"), at: 2, settings: settings, windowFocused: false,
                authorized: true))
    }

    @Test func aSuppressedIntentDoesNotStartTheCooldownClock() {
        // PushService only stamps `lastNotified` on a successful send, so a notification the
        // operator never saw must not swallow the next one.
        var gate = NotificationGate()
        #expect(
            !gate.allows(
                intent(.done, "s1"), at: 0, settings: settings, windowFocused: true,
                authorized: true))
        #expect(
            gate.allows(
                intent(.done, "s1"), at: 1, settings: settings, windowFocused: false,
                authorized: true))
    }
}

@MainActor
struct NotificationsModelTests {
    private func scratch() -> UserDefaults {
        UserDefaults(suiteName: "run.shepherd.mac.notifymodel.\(UUID().uuidString)")!
    }

    /// `async` because the test-seam `init` does not read the authorization state — only the
    /// `init(store:app:)` path does, from a task — so every suite that expects a banner has to
    /// resolve it first, exactly as the app does at launch.
    private func model(
        center: FakeNotificationCenter,
        selected: @escaping @MainActor (String) -> Void = { _ in },
        clock: @escaping @Sendable () -> Int = { 0 }
    ) async -> NotificationsModel {
        let m = NotificationsModel(
            center: center,
            settingsStore: NotificationSettingsStore(defaults: scratch()),
            profileID: UUID(),
            now: clock,
            subjectFor: { $0 == "s1" ? "TASK-07" : nil },
            select: selected)
        await m.requestAuthorization()
        return m
    }

    @Test func aBlockedFramePostsABannerNamingTheSession() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        let block = BlockReason(shape: .init(value1: .stall), options: [], tail: [])
        await m.handle(.sessionBlock(.init(id: "s1", block: block)))

        #expect(center.posted.count == 1)
        #expect(center.posted.first?.title == L.t("native_notify_blocked_title", "TASK-07"))
        #expect(center.posted.first?.body == L.t("hold_blocked_stall"))
        #expect(center.posted.first?.sessionID == "s1")
    }

    @Test func nothingIsPostedWhileTheWindowIsFocused() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(true)
        await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(center.posted.isEmpty)
    }

    @Test func aClickSelectsTheSession() async {
        let center = FakeNotificationCenter()
        var selected: String?
        _ = await model(center: center, selected: { selected = $0 })
        center.deliverClick(sessionID: "s9")
        #expect(selected == "s9")
        #expect(center.started, "the click handler must be installed at init")
    }

    @Test func theBadgeCountsBlockedAndReadySessionsAndClearsWhenFocused() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        var blocked = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))
        var ready = PreviewData.session(id: "b", status: SessionStatus(known: .idle))
        ready.readyToMerge = true
        let busy = PreviewData.session(id: "c", status: SessionStatus(known: .running))
        let archived = PreviewData.session(id: "d", status: SessionStatus(known: .archived))
        blocked.readyToMerge = false

        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [blocked, ready, busy, archived])
        #expect(center.badge == 2)

        m.extraAttention = ["c"]
        await m.updateBadge(sessions: [blocked, ready, busy, archived])
        #expect(center.badge == 3, "the S2 seam adds ci-red sessions once it is assigned")

        await m.setWindowFocused(true)
        #expect(center.badge == 0, "focusing the window clears the badge, as the web tab does")
    }

    @Test func aSessionCountedTwiceIsCountedOnce() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        var both = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))
        both.readyToMerge = true
        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [both])
        #expect(center.badge == 1)
    }

    @Test func settingsPersistAndTakeEffectImmediately() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        m.save(NotificationSettings.default.settingEnabled(false))
        await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(center.posted.isEmpty)
    }

    @Test func aDeniedAuthorizationIsRecordedAndNothingIsPosted() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        let m = await model(center: center)
        #expect(m.authorization == .denied)
        await m.setWindowFocused(false)
        await m.handle(.sessionReady(.init(id: "s1", ready: true)))
        #expect(center.posted.isEmpty)
    }

    @Test func teardownEndsTheSubscriptionAndClearsTheBadge() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [PreviewData.session(id: "a", status: SessionStatus(known: .blocked))])
        #expect(center.badge == 1)
        m.teardown()
        #expect(!m.isSubscribed)
        // `teardown()` is synchronous but the badge clear is a main-actor `Task`, so give the
        // run loop one turn before asserting on it.
        await Task.yield()
        #expect(center.badge == 0, "a profile switch must not leave the old server's count up")
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationGateTests 2>&1 | tail -20
```

Expected: `cannot find 'NotificationGate' in scope`.

- [ ] **Step 3: Write the gate**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationGate.swift`:

```swift
import Foundation

/// Whether an intent may be shown right now.
///
/// Three rules, all ported from `PushService.notify` in `src/push.ts`:
///  - **focus**: `if (this.isActive()) return false;`. The web suppresses while any tab is
///    focused and visible; here it is this app's own window. The live list already says
///    everything a banner would.
///  - **settings**: the per-device category filter, with `ready` bypassing it exactly as the web
///    does — except that the profile's master switch overrides even that, because an operator who
///    turned a server off did not mean "except sometimes".
///  - **cooldown**: `withinCooldown(key, t, cooldownMs)` with the same 120 s default and the same
///    "only a send starts the clock" rule. A notification nobody saw must not swallow the next.
struct NotificationGate {
    /// `SHEPHERD_PUSH_COOLDOWN_MS`'s default in `src/config.ts`, in milliseconds.
    static let defaultCooldown = 120_000

    private let cooldown: Int
    /// Cooldown key -> the timestamp of the last notification actually posted under it.
    private var lastPosted: [String: Int] = [:]

    init(cooldown: Int = NotificationGate.defaultCooldown) {
        self.cooldown = cooldown
    }

    /// Mutating: a positive answer stamps the cooldown clock, so the caller must post whatever
    /// this returns true for.
    mutating func allows(
        _ intent: NotificationIntent,
        at now: Int,
        settings: NotificationSettings,
        windowFocused: Bool,
        authorized: Bool
    ) -> Bool {
        guard authorized, !windowFocused, settings.enabled else { return false }
        if !intent.kind.bypassesCategoryFilter, !settings.isOn(intent.kind.category) {
            return false
        }
        if cooldown > 0, let last = lastPosted[intent.cooldownKey], now - last < cooldown {
            return false
        }
        lastPosted[intent.cooldownKey] = now
        return true
    }
}
```

- [ ] **Step 4: Write the model**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationsModel.swift`:

```swift
import Foundation
import Observation
import ShepherdKit

/// Local notifications for the active profile.
///
/// An `AppExtension`, so it is built in `AppModel.activate(_:)` once the store exists and torn
/// down right before that store stops — which is also what scopes the settings, the cooldown
/// table and the badge to one server.
///
/// It owns three things the rest of the app does not: the focus signal (which it also forwards
/// to the server as a presence frame, so browser push stays quiet while the Mac app is in front),
/// the badge, and the click that selects a session.
@Observable
@MainActor
final class NotificationsModel: AppExtension {
    private(set) var settings: NotificationSettings
    private(set) var authorization: NotificationAuthorization = .notDetermined
    private(set) var windowFocused = false
    private(set) var isSubscribed = false

    /// Session ids that need the operator for a reason this build cannot see — S2's ci-red, and
    /// a plan gate with unanswered questions. Empty until the integration lane assigns it; the
    /// badge counts blocked ∪ ready-to-merge ∪ this.
    var extraAttention: Set<String> = []

    private let center: any NotificationCenterClient
    private let settingsStore: NotificationSettingsStore
    private let profileID: UUID
    private let now: @Sendable () -> Int
    private var trigger: NotificationTrigger
    private var gate = NotificationGate()

    @ObservationIgnored private var tap: Task<Void, Never>?
    @ObservationIgnored private var focusObservers: [any NSObjectProtocol] = []
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var badgeSource: @MainActor () -> [Session] = { [] }

    /// `NSApplication`'s activation notifications, spelled out as strings so nothing here has to
    /// import AppKit — the same trick `IsolatedLaunch` uses, and for the same reason: reaching
    /// for `NSApplication` from the SwiftUI layer has cost this app its window before.
    private static let didBecomeActive = Notification.Name("NSApplicationDidBecomeActiveNotification")
    private static let willResignActive = Notification.Name("NSApplicationWillResignActiveNotification")

    // MARK: - Init

    init(store: SessionStore, app: AppModel) {
        let isolated = LaunchEnvironment.configuration().isIsolated
        // An isolated launch (every XCUITest and the unit bundle's host app) gets the fake, so it
        // never asks macOS for permission and never posts a real banner. That is what keeps an
        // unattended run from stalling behind a system dialog.
        self.center = isolated ? FakeNotificationCenter() : SystemNotificationCenter()
        self.settingsStore = NotificationSettingsStore(
            defaults: isolated
                ? (UserDefaults(suiteName: "run.shepherd.mac.notifications.isolated.\(UUID().uuidString)")
                    ?? .standard)
                : .standard)
        self.profileID = app.activeProfile?.id ?? UUID()
        self.now = { Int(Date().timeIntervalSince1970 * 1_000) }
        self.settings = settingsStore.load(for: profileID)
        self.trigger = NotificationTrigger(subjectFor: { [weak store] id in
            store?.session(id: id)?.name
        })
        self.store = store
        self.badgeSource = { [weak store] in store?.sessions ?? [] }

        center.onSelectSession = { [weak app] id in
            // The seam, not an edit: `selectedSessionID` is `AppModel`'s own published property,
            // and `MainWindow` already reconciles a selection that no longer exists.
            app?.selectedSessionID = id
        }
        center.start()

        subscribe(to: store)
        Task { [weak self] in
            await self?.refreshAuthorization()
            await self?.updateBadge(sessions: self?.badgeSource() ?? [])
        }
        observeFocus()
    }

    /// Test/preview seam: no store, no socket, no AppKit notifications.
    init(
        center: any NotificationCenterClient,
        settingsStore: NotificationSettingsStore,
        profileID: UUID,
        now: @escaping @Sendable () -> Int,
        subjectFor: @escaping @MainActor (String) -> String?,
        select: @escaping @MainActor (String) -> Void
    ) {
        self.center = center
        self.settingsStore = settingsStore
        self.profileID = profileID
        self.now = now
        self.settings = settingsStore.load(for: profileID)
        self.trigger = NotificationTrigger(subjectFor: subjectFor)
        center.onSelectSession = select
        center.start()
    }

    // MARK: - Events

    private func subscribe(to store: SessionStore) {
        isSubscribed = true
        let events = store.events()
        tap = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                await self.handle(event)
            }
            self?.isSubscribed = false
        }
    }

    /// One frame in; zero or one banner out, plus a badge refresh.
    func handle(_ event: ServerEvent) async {
        for intent in trigger.intents(for: event) {
            guard
                gate.allows(
                    intent, at: now(), settings: settings, windowFocused: windowFocused,
                    authorized: authorization == .granted)
            else { continue }
            await center.post(
                NotificationRequest.make(
                    title: NotificationCopy.title(intent),
                    body: NotificationCopy.body(intent),
                    threadIdentifier: intent.threadIdentifier,
                    sessionID: intent.sessionID))
            // The kind, never the body: a body can name the operator's own work.
            Log.ui.info("posted a \(intent.kind.id, privacy: .public) notification")
        }
        await updateBadge(sessions: badgeSource())
    }

    // MARK: - Focus

    private func observeFocus() {
        for (name, focused) in [(Self.didBecomeActive, true), (Self.willResignActive, false)] {
            let observer = NotificationCenter.default.addObserver(
                forName: name, object: nil, queue: nil
            ) { _ in
                // `queue: nil` runs on the posting thread, and AppKit posts both on the main one.
                MainActor.assumeIsolated {
                    Task { await self.setWindowFocused(focused) }
                }
            }
            focusObservers.append(observer)
        }
    }

    /// Records the focus state, forwards it to the server as a presence frame — so the web push
    /// the operator's phone would get stays suppressed too, exactly as an open browser tab does —
    /// and clears the badge when the window comes forward.
    func setWindowFocused(_ focused: Bool) async {
        windowFocused = focused
        await store?.setActive(focused)
        if focused {
            await center.setBadgeCount(0)
        } else {
            await updateBadge(sessions: badgeSource())
        }
    }

    // MARK: - Badge

    /// The web's `deriveTabState` count, minus the two inputs this build cannot see (see the
    /// plan's deviation 4). Only while the window is NOT focused, which is how the web tab
    /// behaves: attended means the count is in front of you already.
    func updateBadge(sessions: [Session]) async {
        guard !windowFocused else {
            await center.setBadgeCount(0)
            return
        }
        var needing: Set<String> = []
        for session in sessions where session.status.known != .archived {
            if session.status.known == .blocked { needing.insert(session.id) }
            if session.readyToMerge { needing.insert(session.id) }
        }
        needing.formUnion(extraAttention)
        await center.setBadgeCount(needing.count)
    }

    // MARK: - Authorization and settings

    private func refreshAuthorization() async {
        authorization = await center.authorization()
    }

    /// Asks macOS once. A denial is recorded and shown in the settings panel with the path to
    /// System Settings — asking again would do nothing, because macOS only prompts once.
    func requestAuthorization() async {
        authorization = await center.requestAuthorization()
    }

    func save(_ settings: NotificationSettings) {
        self.settings = settings
        settingsStore.save(settings, for: profileID)
    }

    // MARK: - Lifecycle

    func teardown() {
        tap?.cancel()
        tap = nil
        isSubscribed = false
        for observer in focusObservers { NotificationCenter.default.removeObserver(observer) }
        focusObservers.removeAll()
        store = nil
        badgeSource = { [] }
        // A profile switch must not leave the outgoing server's count on the Dock icon.
        let center = self.center
        Task { await center.setBadgeCount(0) }
    }
}
```

`SessionStore.session(id:)` and `SessionStore.setActive(_:)` are existing public members
(`native/Sources/ShepherdKit/Model/SessionStore.swift`); nothing here changes the kit.

- [ ] **Step 5: Write the install point**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationsStream.swift`:

```swift
import SwiftUI

/// This stream's single entry point. The integration lane adds exactly one line to
/// `StreamRegistrations.installAll(into:)`:
///
///     NotificationsStream.install(app)
///
/// Idempotent: `AppModel.register` is keyed by extension type, and `NotificationSettingsWindow`
/// guards its own menu item, so the launch task may run it more than once.
@MainActor
enum NotificationsStream {
    static func install(_ app: AppModel) {
        app.register(NotificationsModel.self)
        NotificationSettingsWindow.installMenuItem(app)
        Log.app.info("notifications stream installed")
    }
}
```

`NotificationSettingsWindow` is written in Task 7; the build in Step 6 below is green only once
both files exist, so run Task 7 before that build if you are executing strictly in order.

- [ ] **Step 6: Run green, build, commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -2
```

Expected: `** TEST SUCCEEDED **` and `** BUILD SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationGate.swift \
  native/Apps/ShepherdMac/Sources/Notifications/NotificationsModel.swift \
  native/Apps/ShepherdMac/Sources/Notifications/NotificationsStream.swift \
  native/Apps/ShepherdMac/Tests/NotificationsModelTests.swift
git commit -m "feat(mac): local notifications driven by the session event tap"
```

---

### Task 7: The settings panel and its menu item

**Files:** create `native/Apps/ShepherdMac/Sources/Notifications/NotificationSettingsView.swift`;
extend `native/Apps/ShepherdMac/Tests/NotificationsModelTests.swift`.

**Interfaces:**
- Consumes: `NotificationsModel`, `NotificationSettings`, `NotificationCategory`,
  `NotificationAuthorization`, `AppModel.activeProfile`, `L`, `Log.app`.
- Produces: `NotificationSettingsView`, and `NotificationSettingsWindow` with
  `static func installMenuItem(_ app: AppModel)`, `static func show(_ app: AppModel)`,
  `static private(set) var menuItemInstalled: Bool`, `static func reset()`.

**Why a window and not a `Settings` scene.** A `Settings` scene or a `CommandGroup` lives on the
`Scene` in `ShepherdApp.swift`, which this stream must not edit and which the integration lane's
one-line contract cannot express. A window opened from a menu item this stream installs itself is
entirely inside `Sources/Notifications/**`. If a later milestone gives the app a real Settings
scene, moving the same `NotificationSettingsView` into it is a one-line change.

- [ ] **Step 1: Write the failing tests**

Append to `native/Apps/ShepherdMac/Tests/NotificationsModelTests.swift`:

```swift
@MainActor
@Suite(.serialized)
struct NotificationSettingsViewTests {
    init() { NotificationSettingsWindow.reset() }

    private func scratchApp() -> AppModel {
        AppModel(defaults: UserDefaults(suiteName: "run.shepherd.mac.notifyview.\(UUID().uuidString)")!)
    }

    @Test func theMenuItemIsInstalledOnceHoweverOftenInstallRuns() {
        let app = scratchApp()
        #expect(!NotificationSettingsWindow.menuItemInstalled)
        NotificationSettingsWindow.installMenuItem(app)
        NotificationSettingsWindow.installMenuItem(app)
        #expect(NotificationSettingsWindow.menuItemInstalled)
    }

    @Test func installingTheStreamRegistersOneExtension() {
        let app = scratchApp()
        NotificationsStream.install(app)
        NotificationsStream.install(app)
        #expect(app.extensionFactories.count == 1)
    }

    @Test func theViewModelReportsWhatThePanelMustSay() {
        #expect(
            NotificationSettingsView.permissionNote(for: .denied)
                == L.t("native_notify_settings_permission_denied"))
        #expect(NotificationSettingsView.permissionNote(for: .granted) == nil)
        #expect(
            NotificationSettingsView.permissionNote(for: .notDetermined) == nil,
            "not-yet-asked shows the button, not the warning")
        #expect(NotificationSettingsView.showsAskButton(for: .notDetermined))
        #expect(!NotificationSettingsView.showsAskButton(for: .granted))
        #expect(!NotificationSettingsView.showsAskButton(for: .denied))
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationSettingsViewTests 2>&1 | tail -20
```

Expected: `cannot find 'NotificationSettingsWindow' in scope`.

- [ ] **Step 3: Write the panel and the window**

`native/Apps/ShepherdMac/Sources/Notifications/NotificationSettingsView.swift`:

```swift
import AppKit
import ShepherdKit
import SwiftUI

/// The per-profile notification switches.
///
/// The two pure helpers exist so the panel's three permission states are assertable without
/// hosting SwiftUI — the same reason `SidebarSlot.Resolution` and `DetailTabRegistry.Layout` are
/// named rather than decided inline.
struct NotificationSettingsView: View {
    let model: NotificationsModel
    let profileName: String

    /// `nil` unless macOS has actually refused; "not yet asked" is a button, not a warning.
    static func permissionNote(for authorization: NotificationAuthorization) -> String? {
        authorization == .denied ? L.t("native_notify_settings_permission_denied") : nil
    }

    static func showsAskButton(for authorization: NotificationAuthorization) -> Bool {
        authorization == .notDetermined
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("native_notify_settings_title")).font(.headline)
            Text(verbatim: L.t("native_notify_settings_scope", profileName))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let note = Self.permissionNote(for: model.authorization) {
                NoticeBar(message: note) {}
            }
            if Self.showsAskButton(for: model.authorization) {
                Button(L.t("native_notify_settings_permission_ask")) {
                    Task { await model.requestAuthorization() }
                }
                .accessibilityIdentifier("notify-request-permission")
            }

            Toggle(
                L.t("native_notify_settings_enabled"),
                isOn: Binding(
                    get: { model.settings.enabled },
                    set: { model.save(model.settings.settingEnabled($0)) })
            )
            .accessibilityIdentifier("notify-enabled")

            ForEach(NotificationCategory.allCases, id: \.rawValue) { category in
                Toggle(
                    category.label,
                    isOn: Binding(
                        get: { model.settings.isOn(category) },
                        set: { model.save(model.settings.setting(category, to: $0)) })
                )
                .disabled(!model.settings.enabled)
                .padding(.leading, 18)
                .accessibilityIdentifier("notify-category-\(category.rawValue)")
            }

            Text(verbatim: L.t("native_notify_settings_quiet_hint"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(width: 420, alignment: .leading)
        .accessibilityIdentifier("notification-settings")
    }
}

/// A standalone window plus the app-menu item that opens it.
///
/// AppKit rather than a SwiftUI `Settings` scene because a scene lives on `ShepherdApp`, which
/// this stream must not edit. The window is created lazily and reused; closing it releases
/// nothing the model needs.
@MainActor
enum NotificationSettingsWindow {
    private(set) static var menuItemInstalled = false
    private static var controller: NSWindowController?

    /// Adds "Notifications…" to the application menu, once per process. A second call is a no-op,
    /// which matters because `StreamRegistrations.installAll(into:)` may run more than once.
    static func installMenuItem(_ app: AppModel) {
        guard !menuItemInstalled else { return }
        menuItemInstalled = true
        guard let appMenu = NSApp?.mainMenu?.items.first?.submenu else {
            // Under `swift test`-style hosting there is no main menu yet; the panel is still
            // reachable through `show(_:)`, so this is a missing convenience, not a failure.
            Log.app.info("no application menu to add the notifications item to")
            return
        }
        let item = NSMenuItem(
            title: L.t("native_notify_settings_menu_item"),
            action: #selector(MenuTarget.open(_:)), keyEquivalent: "")
        let target = MenuTarget(app: app)
        item.target = target
        item.representedObject = target  // keeps the target alive with the item
        appMenu.insertItem(item, at: min(1, appMenu.items.count))
        appMenu.insertItem(.separator(), at: min(2, appMenu.items.count))
    }

    static func show(_ app: AppModel) {
        guard let model = app.extension(NotificationsModel.self) else {
            Log.app.info("no notifications model yet — connect a server first")
            return
        }
        let name = app.activeProfile?.name ?? "Shepherd"
        if let controller {
            controller.window?.makeKeyAndOrderFront(nil)
            return
        }
        let hosting = NSHostingController(
            rootView: NotificationSettingsView(model: model, profileName: name))
        let window = NSWindow(contentViewController: hosting)
        window.title = L.t("native_notify_settings_title")
        window.styleMask = [.titled, .closable]
        let created = NSWindowController(window: window)
        controller = created
        created.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
    }

    /// Tests and previews only.
    static func reset() {
        menuItemInstalled = false
        controller?.close()
        controller = nil
    }

    /// `NSMenuItem` needs an Objective-C target; this is the smallest one that closes over the
    /// model.
    private final class MenuTarget: NSObject {
        private let app: AppModel

        init(app: AppModel) {
            self.app = app
        }

        @objc func open(_ sender: Any?) {
            MainActor.assumeIsolated { NotificationSettingsWindow.show(app) }
        }
    }
}
```

This is the one file in the stream that imports AppKit. It is an app-layer file, so the
"ShepherdKit has no UI dependency" rule is unaffected.

- [ ] **Step 4: Run green, build, commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -2
```

Expected: `** TEST SUCCEEDED **` and `** BUILD SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationSettingsView.swift \
  native/Apps/ShepherdMac/Tests/NotificationsModelTests.swift
git commit -m "feat(mac): per-profile notification settings panel"
```

---

### Task 8: Live check, full verification and the PR

**Files:** create `native/Apps/ShepherdMac/Tests/NotificationsLiveTests.swift`.

**Interfaces:** consumes everything above, plus `SHEPHERD_LIVE_BASE_URL` /
`SHEPHERD_LIVE_PASSWORD` (or `SHEPHERD_LIVE_TOKEN`), read through the existing
`LiveServerEnvironment` in `native/Apps/ShepherdMac/Tests/LiveServerTests.swift`.

- [ ] **Step 1: Write the live-gated test**

`native/Apps/ShepherdMac/Tests/NotificationsLiveTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// Skipped unless the environment arms it, so CI (which has no tailnet) never runs it. It posts
/// nothing to macOS: the model is built on `FakeNotificationCenter`, so the only thing that
/// touches the real server is the read-only bootstrap.
@MainActor
struct NotificationsLiveTests {
    private func liveStore() throws -> SessionStore? {
        guard let raw = LiveServerEnvironment.baseURL, let url = URL(string: raw),
            let token = LiveServerEnvironment.token
        else { return nil }
        let credentials = InMemoryCredentialStore()
        try credentials.save(StoredCredential(token: token, tokenId: "live"), for: "live")
        return try SessionStore(
            profile: ServerProfile(
                name: "live", baseURL: url, mode: .remote, credentialKey: "live"),
            credentials: credentials)
    }

    private func model(_ center: FakeNotificationCenter, store: SessionStore) -> NotificationsModel {
        NotificationsModel(
            center: center,
            settingsStore: NotificationSettingsStore(
                defaults: UserDefaults(suiteName: "run.shepherd.mac.notifylive.\(UUID().uuidString)")!),
            profileID: UUID(),
            now: { Int(Date().timeIntervalSince1970 * 1_000) },
            subjectFor: { [weak store] id in store?.session(id: id)?.name },
            select: { _ in })
    }

    @Test func theBadgeCountsTheLiveHerdsAttentionSessions() async throws {
        guard let store = try liveStore() else { return }
        try await store.bootstrap()
        let center = FakeNotificationCenter()
        let m = model(center, store: store)
        await m.setWindowFocused(false)
        await m.updateBadge(sessions: store.sessions)

        let expected = Set(
            store.sessions
                .filter { $0.status.known != .archived }
                .filter { $0.status.known == .blocked || $0.readyToMerge }
                .map(\.id))
        #expect(center.badge == expected.count)
        #expect(!store.sessions.isEmpty, "the live server should have sessions")
    }

    @Test func aRealBlockFrameWouldProduceARealBanner() async throws {
        guard let store = try liveStore() else { return }
        try await store.bootstrap()
        let center = FakeNotificationCenter()
        let m = model(center, store: store)
        await m.setWindowFocused(false)
        // Authorization on the fake defaults to granted, so this exercises copy + gate against a
        // real session's name without asking macOS for anything.
        await m.requestAuthorization()
        guard let session = store.sessions.first(where: { $0.status.known != .archived }) else {
            return
        }
        let block = BlockReason(shape: .init(value1: .awaitingInput), options: [], tail: [])
        await m.handle(.sessionBlock(.init(id: session.id, block: block)))

        #expect(center.posted.count == 1)
        #expect(center.posted.first?.title.contains(session.name) == true)
        #expect(center.posted.first?.sessionID == session.id)
    }
}
```

- [ ] **Step 2: Run it against the live server**

```bash
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL="$SHEPHERD_LIVE_BASE_URL" \
TEST_RUNNER_SHEPHERD_LIVE_TOKEN="$SHEPHERD_LIVE_TOKEN" \
  ./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationsLiveTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`. Both variables come from the environment only — never from a
file, never committed. Without them the same command passes with both tests trivially satisfied,
which is the CI path.

- [ ] **Step 3: Prove no real prompt can fire from a test**

```bash
git grep -n "SystemNotificationCenter()" -- native/Apps/ShepherdMac \
  && git grep -c "SHEPHERD_KEYCHAIN_TESTS" -- native/Apps/ShepherdMac
```

Expected: exactly one hit for `SystemNotificationCenter()` —
`NotificationsModel.init(store:app:)`, on the `!isolated` branch — and `0` for
`SHEPHERD_KEYCHAIN_TESTS`. A second construction site anywhere means a test path can reach the
real notification centre.

- [ ] **Step 4: Run every gate this stream can turn red**

```bash
bun run check:strings && (cd ui && bun run check:i18n) && bun run lint \
  && bun run test && bun run test:contract \
  && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && swift test --package-path native \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests \
  && ./native/scripts/build-app.sh
```

Expected in order: `Localizable.xcstrings is up to date` · i18n gate passes · eslint clean · root
suite passes · contract tests pass · no derived-file diff · `sync-contract: up to date` ·
`swift test` passes · `** TEST SUCCEEDED **` · `** BUILD SUCCEEDED **`. Never `bun test`. The
contract commands are here only to prove this branch did **not** disturb the contract.

- [ ] **Step 5: Prove the ownership rule was kept**

```bash
git diff --name-only origin/main...HEAD | sort
```

Expected: exactly the files in "File ownership" — `Sources/Notifications/**`, the seven test files,
`native/scripts/gen-strings.ts`, `Localizable.xcstrings`, `ui/messages/en.json`,
`ui/messages/de.json` — and nothing else. If `contracts/openapi.yaml`, `AppModel.swift`,
`ShepherdApp.swift`, `StreamRegistrations.swift` or `project.yml` appears — **revert that file**
and report it.

- [ ] **Step 6: Look at it on the operator's Mac**

`NotificationsStream.install(app)` is not wired into `StreamRegistrations` yet (S0-int's one
line), so a launched build shows nothing new. Verify instead that the build is signed and launches:

```bash
open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
```

Expected: the app comes up unchanged, with no permission dialog — nothing has installed the
stream yet. Record that in the PR body. **Do not** hand-edit `StreamRegistrations.swift` to try it.

- [ ] **Step 7: Rebase and re-run the string gates**

```bash
git fetch origin && git rebase origin/main \
  && bun run check:strings && (cd ui && bun run check:i18n)
```

A conflict in `ui/messages/*.json` that the union merge driver did **not** resolve is a real one —
two branches gave the same key different values; resolve it on the merits. If the generator now
reports a key claimed by two stream manifests, remove it from `KEYS_NOTIFICATIONS` (the `hold_*`
keys are shared copy; whichever stream landed first keeps them, and `L.t` still resolves them).

- [ ] **Step 8: Open the PR**

```bash
git push --no-verify -u origin feat/native-notifications
gh pr create --base main --title "feat(mac): local notifications" --body "$(cat <<'EOF'
Stream S6. Shepherd for Mac now tells the operator when a session needs them.

## What landed
- **No contract change.** All five triggers ride events the core block already declares, and there
  is no `notifications` stream block to add to (`STREAM_NAMES` is fixed at four).
- **`NotificationCopy`** — `NOTIFY_TEXT` + `buildPayload` from `src/push.ts`, ported, with the copy
  mirrored verbatim into `ui/messages/{en,de}.json` under `native_notify_*`. The blocked body reuses
  the existing `hold_blocked_*` / `hold_quota_*` keys.
- **`NotificationTrigger`** — `attachPush`, `attachMergePush` and `attachUsagePush`, ported:
  `session:status` = done, `session:block` non-null, `session:ready` true, `automerge:status` in
  `manual_steps` / `merge_error` / `rebase_cap`, and `usage:limits` over 80 % once per 5-hour window.
- **`NotificationGate`** — focus suppression, the per-profile category filter (with `ready`
  bypassing it, as the web does), and the same 120 s per-`kind:session` cooldown that only a real
  post starts.
- **`NotificationSettings`** — per profile: a master switch plus the `agent` and `ci` categories,
  in `UserDefaults` under `run.shepherd.mac.notifications.<profile>`.
- **`NotificationCenterClient`** — the injectable seam. `SystemNotificationCenter` is the only file
  touching `UserNotifications`; every test and every isolated launch gets `FakeNotificationCenter`,
  so no suite can pop a macOS permission dialog.
- **`NotificationsModel`** (`AppExtension`) — the event tap, the Dock badge, the focus observer
  (which also forwards presence to the server, so browser push stays quiet while the Mac app is in
  front) and the click that sets `AppModel.selectedSessionID`.
- **Settings panel** in its own window, opened from a "Notifications…" item this stream adds to the
  application menu.

## Deliberate deviations from the stream brief
- **No `failed` notification.** `SessionStatus` has no such value; a halt reaches the operator as
  the `done` notification and CI failure rides `session:git`, which S2 owns.
- **`review`, `ci`, `autopilot`, `extra_credits`, `learnings_*` and the host-global alerts are
  out** — each needs an event the contract does not declare, and hand-writing its payload would
  break the "contract is the only type source" rule. Each is one `NotificationTrigger` case away.
- **Recap notifications are deferred**: `session:recap` is declared in S4's contract block, so they
  land as a follow-up once S4 merges — a trigger case plus two catalog keys, no contract work.
- **Two category toggles, not three.** The web's `reviews` category has no native trigger yet.
- **The badge counts blocked ∪ ready-to-merge**, not the web's four-way set: ci-red needs S2 and
  unanswered plan questions need a plan-gate stream. `NotificationsModel.extraAttention` is the
  one-line seam S0-int assigns.
- **The settings panel is an AppKit window, not a SwiftUI `Settings` scene**, because a scene lives
  on `ShepherdApp.swift`, which this stream must not edit.

## Integration lane
`StreamRegistrations.installAll(into:)` gains exactly one line: `NotificationsStream.install(app)`.
After that line lands, the live check is: launch the app, put another app in front, and confirm a
blocked session posts a banner whose click selects that session.

## Verification
`bun run check:strings` · `ui && bun run check:i18n` · `bun run lint` · `bun run test` ·
`bun run test:contract` · `bun run check:contract-swift` · `native/scripts/sync-contract.sh --check`
· `swift test --package-path native` · `native/scripts/test-app.sh -only-testing:ShepherdTests` ·
`native/scripts/build-app.sh` · read-only live smoke with `SHEPHERD_LIVE_BASE_URL` /
`SHEPHERD_LIVE_TOKEN` from the environment. No test posts a real notification or asks macOS for
permission.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Watch CI**

```bash
gh pr checks --watch
```

Expected: every check green, including the `native` workflow's `ShepherdKit` job.

---

## Self-review

**Spec coverage.** The design spec's Notifications paragraph asks for `UNUserNotificationCenter`
local notifications from `session:status` (done), `session:block`, `automerge:status` and
`usage:limits`, with titles and bodies from the catalog `src/push.ts::buildPayload` uses, suppressed
for the foreground session, and a click that opens the session. Triggers → Task 3 (plus
`session:ready`, which `src/ready-notify.ts` pushes and the brief asked for). Copy → Tasks 1 and 2,
with the "there are no catalog keys; `push.ts` has its own table" finding recorded above and in the
PR body. Suppression → Task 6's `NotificationGate`, widened from "the foreground session" to "the
focused window", which is what the server itself does (`presence.isActive()` is global, not
per-session) — and the presence frame is forwarded so the web's own suppression agrees. Click →
selects the session → Task 5's `onSelectSession` + Task 6's `AppModel.selectedSessionID`. The
master plan's extra asks: per-profile settings → Tasks 4 and 7; badge count → Task 6;
do-not-disturb during active window focus → Task 6's `setWindowFocused`; strings via
`KEYS_NOTIFICATIONS` → Task 1; injectable notification-center protocol → Task 5; gate/live/PR →
Task 8.

**Placeholders.** None. Every code step carries the whole file; every command carries its expected
output. Three deliberate forward references, each called out where it appears:
`NotificationSettingsWindow` (written in Task 7, called in Task 6's `NotificationsStream` — Task 6
Step 6 says to run Task 7 first if executing strictly in order), `PreviewData.session(id:status:)`
and `LiveServerEnvironment` (existing helpers — read the file and use the real signature), and the
generated `BlockReason.shape.value1` case spellings in Task 2 Step 3.

**Type consistency.** `NotificationKind`'s seven cases are identical in Task 2 (definition),
Task 3 (`intents(for:)`), the gate tests and the model. `NotificationIntent`'s six stored
properties and its `cooldownKey` / `threadIdentifier` derivations are defined once in Task 2 and
consumed unchanged in Tasks 3 and 6. `NotificationCategory` has exactly two cases everywhere
(`.agent`, `.ci`) — in the kind mapping, in `NotificationSettings.isOn/allows/setting`, and in the
panel's `ForEach`. `NotificationSettings`'s four methods (`isOn`, `allows`, `setting(_:to:)`,
`settingEnabled`) have the same signatures in Task 4's definition, Task 6's gate call and Task 7's
bindings. `NotificationCenterClient`'s six members are identical in the protocol, in
`SystemNotificationCenter`, in `FakeNotificationCenter` and at every call site.
`NotificationGate.allows` has the same five-parameter signature
(`_:at:settings:windowFocused:authorized:`) in its definition, its tests and `NotificationsModel.handle`.
`NotificationRequest.make(title:body:threadIdentifier:sessionID:)` is the only construction site
outside the tests. The 32 keys in `KEYS_NOTIFICATIONS` are exactly the union of what Tasks 2, 6 and
7 pass to `L.t`, and exactly the keys asserted in `NotificationsStringsTests`.
