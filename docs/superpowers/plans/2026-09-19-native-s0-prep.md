# Stream S0-prep — seams for parallel streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the extension points, manifest split and contract blocks in place so streams S1–S6 can be built in parallel worktrees without ever editing the same lines of `AppModel.swift`, `MainWindow.swift`, `WelcomeView.swift`, `SessionDetailView.swift`, `gen-strings.ts` or `contracts/openapi.yaml`.

**Architecture:** Four seams, all `@MainActor`, under `native/Apps/ShepherdMac/Sources/App/`. A `DetailTabRegistry` that `SessionDetailView` renders as a `TabView` (the built-in "prompt" tab is always there unless a stream replaces it by id); three view slots (`SidebarSlot`, `WelcomeSlots.localPanel`, `ActionBarSlot`) that `MainWindow`/`WelcomeView` consult before their built-in content; an `AppExtension` protocol whose instances `AppModel` creates right after a `SessionStore` exists and tears down right before that store stops. `StreamRegistrations.swift` is the single call site the integration lane edits per merged stream. Alongside: the string manifest splits into seven per-area arrays, and `contracts/openapi.yaml` gains four empty comment-delimited blocks so stream contract additions become pure insertion conflicts.

**Tech Stack:** Swift 6 (language mode 6, `SWIFT_STRICT_CONCURRENCY: complete`), SwiftUI, Swift Testing (`import Testing`), XcodeGen 2.46 + `xcodebuild`, Bun for `gen-strings.ts` and the contract tests.

## Global Constraints

- **Branch:** `feat/native-s0-prep`, cut from `origin/main` **after PR #2373 (Gate 2) merges**. Rebase to update; never `git merge main`. One feature per branch.
- **Concurrency:** Swift 6 strict concurrency, `complete`. No `@preconcurrency`, no `nonisolated(unsafe)`, no `@unchecked Sendable` in anything this plan writes.
- **App model:** `@Observable @MainActor final class AppModel` stays the single owner of the active `SessionStore`. Nothing added here starts networking of its own.
- **Kit is the only type source:** no hand-written `Codable` for server payloads, and no new payload model of any kind. The kit changes in this plan are Task 6's two seams only — one access modifier, the `.unknown` payload, and the event tap — and they add no types the contract does not already generate.
- **Strings:** every user-visible string goes through `L.t()` and exists in `ui/messages/en.json` **and** `de.json`. **This plan adds and removes zero keys** — deliverable 4 requires `Localizable.xcstrings` to regenerate byte-identical, so every seam reuses an existing key.
- **Commits:** conventional, lowercase subject (`feat(mac): …`, `chore(i18n): …`, `chore(contract): …`), body lines ≤ 100 characters, body ends with `Co-Authored-By: <executing model> <noreply@anthropic.com>` — e.g. `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Substitute the model that ran the task.
- **Never run bare `bun test`** (repo `CLAUDE.md`). `bun run test` is the root gate; a path-scoped `bun test ./test/<file>.test.ts` for one focused file is fine.
- **Verification commands** (repo root): `./native/scripts/test-app.sh -only-testing:ShepherdTests`, `./native/scripts/build-app.sh Release`, `bun run check:strings`, `bun run test`, `bun run test:contract`, `bun run check:contract-swift`, `./native/scripts/sync-contract.sh --check`, `bun run lint`, `bunx prettier --check .` (`contracts/openapi.yaml` is **not** in `.prettierignore`).
- **Out of scope — write none of it:** the PTY/terminal view, any new contract path or schema *content*, sidebar triage, quick actions, the local-server supervisor, notifications. S0-prep ships empty seams only.

### Seam contract, and the three Swift-forced refinements

Names and signatures are Appendix B's, verbatim except where Swift 6 makes them unwritable:

1. `extension` is a keyword, so the accessor is `` func `extension`<E: AppExtension>(_:) `` with backticks.
2. Slot closure types carry `@MainActor` (`(@MainActor (AppModel) -> AnyView)?`); without it the body could not touch `AppModel` or `SessionStore`.
3. `AppModel.register` stores a **factory closure** keyed by `ObjectIdentifier`, not an `any AppExtension.Type`: calling a protocol `init` requirement through an existential metatype is not expressible, so the generic `register<E>` captures `E`.

| # | Task | Appendix B item |
| --- | --- | --- |
| 1 | `DetailTab` + `DetailTabRegistry`; `SessionDetailView` renders tabs | 1 |
| 2 | `SidebarSlot`, `WelcomeSlots.localPanel`, `ActionBarSlot` wired into both windows | 2 |
| 3 | `AppExtension` + `AppModel.register`/`` `extension` ``, `StreamRegistrations` | 3 |
| 4 | `gen-strings.ts` manifest split into seven arrays | 4 |
| 5 | `contracts/openapi.yaml` empty stream blocks | 5 |
| 6 | Three verified-unmet preconditions: kit-internal `generated`, block-aware coverage gate, `SessionStore` event tap | — (raised by the S2/S3 planners) |
| 7 | Live-gated `LiveServerTests`, README seam rules, PR | 6 + 7 |

---

### Task 1: `DetailTab` protocol and registry

**Files:** Create `native/Apps/ShepherdMac/Sources/App/DetailTabs.swift` and
`native/Apps/ShepherdMac/Tests/DetailTabRegistryTests.swift`; replace
`native/Apps/ShepherdMac/Sources/Main/SessionDetailView.swift`.

**Interfaces:**

- Consumes: `Session`, `SessionStore`, `InMemoryCredentialStore` (ShepherdKit); `AppModel`; `L.t(_:)`; `SessionStatusStyle`; `PreviewData`.
- Produces: `protocol DetailTab: Identifiable, Sendable where ID == String` — `id: String`, `title: String`, `systemImage: String`, `order: Int`, `@MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView`; `@MainActor enum DetailTabRegistry` — `nonisolated static let promptTabID = "prompt"`, `static func register(_ tab: any DetailTab)`, `static var tabs: [any DetailTab]`, `static func reset()`; `struct PromptDetailTab: DetailTab`; `struct PromptTabView: View`.

- [ ] **Step 1: Cut the branch from `origin/main`**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git cat-file -e origin/main:native/Apps/ShepherdMac/Sources/App/AppModel.swift && echo "gate 2 is on main"
git checkout -b feat/native-s0-prep origin/main
```

Expected: `gate 2 is on main`, then `Switched to a new branch 'feat/native-s0-prep'`. If
`git cat-file` fails, PR #2373 has not merged — **stop and tell the orchestrator**. (A worktree is
fine: create it from `origin/main` with superpowers:using-git-worktrees.)

- [ ] **Step 2: Write the failing test**

Create `native/Apps/ShepherdMac/Tests/DetailTabRegistryTests.swift`:

```swift
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd

/// A stand-in stream tab. Stateless, so `Sendable` costs nothing.
private struct StubTab: DetailTab {
    let id: String
    let order: Int
    var title: String { id }
    let systemImage = "circle"

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        AnyView(Text(verbatim: id))
    }
}

/// `.serialized`: the registry is per-process state, so these may not interleave.
@MainActor
@Suite(.serialized)
struct DetailTabRegistryTests {
    @Test func anEmptyRegistryStillOffersTheBuiltInPromptTab() {
        DetailTabRegistry.reset()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
    }

    @Test func tabsAreOrderedByOrderThenID() {
        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: "diff", order: 5))
        DetailTabRegistry.register(StubTab(id: "terminal", order: 0))
        DetailTabRegistry.register(StubTab(id: "activity", order: 5))
        #expect(DetailTabRegistry.tabs.map(\.id) == ["terminal", "activity", "diff", "prompt"])
    }

    @Test func anIDIsRegisteredOnce_andThePromptTabCanBeReplacedAndRestored() {
        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: "diff", order: 9))
        DetailTabRegistry.register(StubTab(id: "diff", order: 1))
        #expect(DetailTabRegistry.tabs.map(\.id) == ["diff", "prompt"])
        #expect(DetailTabRegistry.tabs.first?.order == 1)

        DetailTabRegistry.reset()
        DetailTabRegistry.register(StubTab(id: DetailTabRegistry.promptTabID, order: 3))
        #expect(DetailTabRegistry.tabs.count == 1)
        #expect(DetailTabRegistry.tabs.first?.order == 3)

        DetailTabRegistry.reset()
        #expect(DetailTabRegistry.tabs.map(\.id) == ["prompt"])
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests/DetailTabRegistryTests`
Expected: FAIL — `cannot find type 'DetailTab' in scope`, `cannot find 'DetailTabRegistry' in scope`.

- [ ] **Step 4: Write the registry**

Create `native/Apps/ShepherdMac/Sources/App/DetailTabs.swift`:

```swift
import SwiftUI
import ShepherdKit

/// A pluggable tab in the session detail pane. Streams register one each instead
/// of editing `SessionDetailView`, which is how four branches add four tabs
/// without touching the same lines. `Sendable` is free — a conformer is a
/// stateless value naming a view builder; `makeView` is `@MainActor` because
/// `AppModel` and `SessionStore` are.
protocol DetailTab: Identifiable, Sendable where ID == String {
    /// Registry key: "terminal", "activity", "diff", "files", "git".
    var id: String { get }
    /// Read through `L.t(...)` at render time, never stored, so a language change
    /// needs no re-registration.
    var title: String { get }
    var systemImage: String { get }
    /// Ascending sort key; ties break on `id`. Terminal is 0, the built-in prompt
    /// tab 1_000, so a stream tab lands ahead of it by default.
    var order: Int { get }

    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView
}

/// The built-in tab. Always present unless a stream registers `promptTabID`.
struct PromptDetailTab: DetailTab {
    var id: String { DetailTabRegistry.promptTabID }
    var title: String { L.t("newtask_prompt_label") }
    let systemImage = "text.alignleft"
    let order = 1_000

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        AnyView(PromptTabView(session: session))
    }
}

/// Lifted out of `SessionDetailView` unchanged, so the copy — and therefore the
/// string catalog — stays exactly as Gate 2 left it.
struct PromptTabView: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox(L.t("newtask_prompt_label")) {
                ScrollView {
                    Text(verbatim: session.prompt)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 220)
            }
            GroupBox(L.t("native_detail_placeholder_title")) {
                Text(verbatim: L.t("native_detail_placeholder_body"))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer()
        }
        .padding(16)
        .accessibilityIdentifier("detail-tab-prompt")
    }
}

/// Where streams hang their detail tabs. Per-process main-actor state:
/// registration happens once at launch, every read is a SwiftUI body evaluation.
@MainActor
enum DetailTabRegistry {
    /// `nonisolated` so the non-isolated `PromptDetailTab` can name it; a `let`
    /// of a `Sendable` type is safe to read anywhere.
    nonisolated static let promptTabID = "prompt"

    private static var registered: [String: any DetailTab] = [:]

    /// Idempotent per id — the last registration wins, so a stream can take the
    /// prompt slot by registering `promptTabID`.
    static func register(_ tab: any DetailTab) { registered[tab.id] = tab }

    /// Registered tabs plus the built-in one, ordered by `order` then `id` so the
    /// sequence never depends on dictionary iteration order.
    static var tabs: [any DetailTab] {
        var byID: [String: any DetailTab] = [promptTabID: PromptDetailTab()]
        for (id, tab) in registered { byID[id] = tab }
        return byID.values.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests/DetailTabRegistryTests`
Expected: PASS — `Test run with 3 tests passed`.

- [ ] **Step 6: Render the registry from `SessionDetailView`**

Replace the whole of `native/Apps/ShepherdMac/Sources/Main/SessionDetailView.swift`:

```swift
import SwiftUI
import ShepherdKit

/// The detail pane: a fixed header, then one tab per registered `DetailTab`.
///
/// The store and the model come from the environment rather than from
/// initialiser parameters, so adding a tab never changes this view's signature
/// and no stream has to touch `MainWindow` to hand them over.
struct SessionDetailView: View {
    let session: Session?
    @Environment(AppModel.self) private var model

    var body: some View {
        // `model.store` is non-nil for every render inside `MainWindow`, which is
        // mounted only while a store exists; the nil branch is the same "nothing
        // selected" state as before.
        if let session, let store = model.store {
            VStack(alignment: .leading, spacing: 16) {
                header(session)
                TabView {
                    ForEach(DetailTabRegistry.tabs, id: \.id) { tab in
                        tab.makeView(session: session, store: store, app: model)
                            .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    }
                }
            }
            .padding(24)
            .accessibilityIdentifier("session-detail")
        } else {
            ContentUnavailableView(L.t("native_detail_no_selection"), systemImage: "sidebar.left")
        }
    }

    private func header(_ session: Session) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: session.desig).font(.title3.monospaced().weight(.semibold))
            Text(verbatim: session.name).font(.title3)
            Spacer()
            Text(verbatim: L.t("native_detail_status_label"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: SessionStatusStyle.label(session.status))
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(SessionStatusStyle.tint(session.status).opacity(0.18), in: Capsule())
                .foregroundStyle(SessionStatusStyle.tint(session.status))
        }
    }
}

#if DEBUG
// The tab body previews on its own; `SessionDetailView` needs a live store to
// show tabs at all, which a preview has no way to produce.
#Preview("Prompt tab") {
    PromptTabView(session: PreviewData.session()).frame(width: 720, height: 520)
}

#Preview("No selection") {
    // Its own defaults suite and an in-memory credential store, so a preview
    // never reads the operator's real profiles or Keychain.
    SessionDetailView(session: nil)
        .environment(
            AppModel(
                defaults: UserDefaults(suiteName: "preview-\(UUID().uuidString)")!,
                credentials: InMemoryCredentialStore()))
        .frame(width: 720, height: 520)
}
#endif
```

- [ ] **Step 7: Run the unit bundle and build**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh Release
```

Expected: `** TEST SUCCEEDED **` and `** BUILD SUCCEEDED **`. `StringCatalogTests` and
`PlaceholderRenderingTests` must still pass — copy moved between views, no key changed.

- [ ] **Step 8: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/App/DetailTabs.swift \
        native/Apps/ShepherdMac/Sources/Main/SessionDetailView.swift \
        native/Apps/ShepherdMac/Tests/DetailTabRegistryTests.swift
git commit -m "feat(mac): detail tab registry with a built-in prompt tab

Streams register a DetailTab instead of editing SessionDetailView, so four
branches can add four tabs without touching the same lines. The prompt tab is
the built-in fallback and can be replaced by id.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: View slots for the sidebar, the welcome local panel and the action bar

**Files:** Create `SidebarSlot.swift`, `WelcomeSlots.swift`, `ActionBarSlot.swift` under
`native/Apps/ShepherdMac/Sources/App/` and `native/Apps/ShepherdMac/Tests/SlotTests.swift`;
edit `native/Apps/ShepherdMac/Sources/Main/MainWindow.swift` and
`native/Apps/ShepherdMac/Sources/Welcome/WelcomeView.swift`.

**Interfaces:**

- Consumes: `AppModel`, `Session`, `SessionStore`, `SessionRow`, `WelcomeCard`, `LocalServerStatus`.
- Produces: `@MainActor enum SidebarSlot` — `enum Resolution: Equatable { case fallback, slot }`, `static var content: (@MainActor (AppModel) -> AnyView)?`, `static var resolution: Resolution`, `static func reset()`; `@MainActor enum WelcomeSlots` — `static var localPanel: (@MainActor (AppModel) -> AnyView)?`, `static var localPanelResolution: SidebarSlot.Resolution`, `static func reset()`; `@MainActor enum ActionBarSlot` — `static var content: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?`, `static var resolution: SidebarSlot.Resolution`, `static func reset()`.

- [ ] **Step 1: Write the failing test**

Create `native/Apps/ShepherdMac/Tests/SlotTests.swift`:

```swift
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd

/// State-level only: these assert what the windows will *choose*, not what
/// SwiftUI draws. Hosting a view to find that out would need a live store and a
/// window server and would prove nothing extra.
@MainActor
@Suite(.serialized)
struct SlotTests {
    @Test func theSidebarFallsBackWhenUnsetAndPassesTheModelWhenSet() {
        SidebarSlot.reset()
        #expect(SidebarSlot.resolution == .fallback)
        #expect(SidebarSlot.content == nil)

        var seen: ObjectIdentifier?
        SidebarSlot.content = { app in
            seen = ObjectIdentifier(app)
            return AnyView(Text(verbatim: "stream sidebar"))
        }
        #expect(SidebarSlot.resolution == .slot)

        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        _ = SidebarSlot.content?(app)
        #expect(seen == ObjectIdentifier(app))

        SidebarSlot.reset()
        #expect(SidebarSlot.resolution == .fallback)
    }

    @Test func theWelcomePanelAndTheActionBarFallBackUntilAStreamFillsThem() {
        WelcomeSlots.reset()
        ActionBarSlot.reset()
        #expect(WelcomeSlots.localPanelResolution == .fallback)
        #expect(ActionBarSlot.resolution == .fallback)

        WelcomeSlots.localPanel = { _ in AnyView(Text(verbatim: "local")) }
        ActionBarSlot.content = { _, _, _ in AnyView(Text(verbatim: "actions")) }
        #expect(WelcomeSlots.localPanelResolution == .slot)
        #expect(ActionBarSlot.resolution == .slot)

        WelcomeSlots.reset()
        ActionBarSlot.reset()
        #expect(WelcomeSlots.localPanel == nil)
        #expect(ActionBarSlot.content == nil)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests/SlotTests`
Expected: FAIL — `cannot find 'SidebarSlot' in scope`, `cannot find 'WelcomeSlots' in scope`,
`cannot find 'ActionBarSlot' in scope`.

- [ ] **Step 3: Write the three slots**

Create `native/Apps/ShepherdMac/Sources/App/SidebarSlot.swift`:

```swift
import SwiftUI

/// Where S3 replaces the flat session list. `MainWindow` renders
/// `SidebarSlot.content(model)` when set and its own list otherwise.
///
/// The closure type carries `@MainActor` (Swift 6): a stream's sidebar reads
/// `AppModel` and its store, both main-actor-isolated.
@MainActor
enum SidebarSlot {
    /// What a window will render. Named rather than inferred at the call site, so
    /// the choice is assertable without hosting a view.
    enum Resolution: Equatable {
        /// The built-in content ships.
        case fallback
        /// A stream has taken the slot.
        case slot
    }

    static var content: (@MainActor (AppModel) -> AnyView)?
    static var resolution: Resolution { content == nil ? .fallback : .slot }
    /// Tests and previews only.
    static func reset() { content = nil }
}
```

Create `native/Apps/ShepherdMac/Sources/App/WelcomeSlots.swift`:

```swift
import SwiftUI

/// Where S5 fills the "Run on this Mac" card body — status, install and start
/// controls — without editing `WelcomeView`. The card chrome (title, blurb,
/// divider) stays with the welcome screen; only the body below it is the slot.
@MainActor
enum WelcomeSlots {
    static var localPanel: (@MainActor (AppModel) -> AnyView)?
    static var localPanelResolution: SidebarSlot.Resolution {
        localPanel == nil ? .fallback : .slot
    }
    /// Tests and previews only.
    static func reset() { localPanel = nil }
}
```

Create `native/Apps/ShepherdMac/Sources/App/ActionBarSlot.swift`:

```swift
import SwiftUI
import ShepherdKit

/// Where S4 fills the quick-action bar under the detail pane. Unlike the other
/// two slots there is no built-in content: unset means no bar, which is what
/// Gate 2 shipped.
@MainActor
enum ActionBarSlot {
    static var content: (@MainActor (Session, SessionStore, AppModel) -> AnyView)?
    static var resolution: SidebarSlot.Resolution { content == nil ? .fallback : .slot }
    /// Tests and previews only.
    static func reset() { content = nil }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests/SlotTests`
Expected: PASS — `Test run with 2 tests passed`.

- [ ] **Step 5: Consult the slots from `MainWindow`**

In `native/Apps/ShepherdMac/Sources/Main/MainWindow.swift`, three surgical edits.

(a) Rename the existing `sidebar` property: change its declaration line
`private var sidebar: some View {` to `private var builtInSessionList: some View {`, and delete
the two modifier lines at the bottom of that property — `.navigationTitle(L.t("native_sidebar_title"))`
and `.accessibilityIdentifier("session-sidebar")` — leaving its `Group { … }` body as the
property's value. Then insert the new dispatcher directly above it:

```swift
    private var sidebar: some View {
        Group {
            if let content = SidebarSlot.content {
                content(model)
            } else {
                builtInSessionList
            }
        }
        .navigationTitle(L.t("native_sidebar_title"))
        .accessibilityIdentifier("session-sidebar")
    }

    /// The flat list Gate 2 shipped. S3 replaces it through `SidebarSlot`; it
    /// stays as the fallback so the app works on a branch without that stream.
```

(b) In the `detail` property, immediately **after** the line
`SessionDetailView(session: selectedSession)`, insert:

```swift
            // Only for a selected session against a live store — a quick action
            // has nothing to act on otherwise.
            if let session = selectedSession,
               let store = model.store,
               let actions = ActionBarSlot.content {
                actions(session, store, model)
            }
```

- [ ] **Step 6: Consult the slot from `WelcomeView`**

In `native/Apps/ShepherdMac/Sources/Welcome/WelcomeView.swift`, inside `localCard`, replace the
`WelcomeCard(...) { … }` trailing closure's body — the whole `switch localStatus { … }` — with:

```swift
            if let panel = WelcomeSlots.localPanel {
                panel(model)
            } else {
                builtInLocalControls
            }
```

and move that `switch` verbatim into a new property added directly below `localCard`:

```swift
    /// The probe-only controls Gate 2 shipped. S5 replaces them with real
    /// install/start controls through `WelcomeSlots.localPanel`. `@ViewBuilder`
    /// because a `switch` with several cases is not one `some View`.
    @ViewBuilder
    private var builtInLocalControls: some View {
        // ← the switch from localCard, unchanged, including its comments
    }
```

- [ ] **Step 7: Run the unit bundle, build, and re-run the UI smoke suite**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh Release
./native/scripts/test-app.sh -only-testing:ShepherdUITests
```

Expected: `** TEST SUCCEEDED **` twice and `** BUILD SUCCEEDED **`. The XCUITest suite matters
here: `WelcomeSmokeUITests` asserts on `welcome-local-card`, whose body this step restructured.

- [ ] **Step 8: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/App/SidebarSlot.swift \
        native/Apps/ShepherdMac/Sources/App/WelcomeSlots.swift \
        native/Apps/ShepherdMac/Sources/App/ActionBarSlot.swift \
        native/Apps/ShepherdMac/Tests/SlotTests.swift \
        native/Apps/ShepherdMac/Sources/Main/MainWindow.swift \
        native/Apps/ShepherdMac/Sources/Welcome/WelcomeView.swift
git commit -m "feat(mac): sidebar, welcome-local and action-bar view slots

MainWindow and WelcomeView consult a slot before their built-in content, so the
sidebar, the local-server panel and the quick-action bar can each arrive from a
separate branch. Unset slots keep Gate 2's behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `AppExtension` lifecycle on `AppModel`

**Files:** Create `native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift`,
`native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift` and
`native/Apps/ShepherdMac/Tests/AppExtensionTests.swift`; edit
`native/Apps/ShepherdMac/Sources/App/AppModel.swift` (storage, `activate(_:)`, `teardown()`) and
`native/Apps/ShepherdMac/Sources/App/ShepherdApp.swift` (`RootView`'s `.task`).

**Interfaces:**

- Consumes: `AppModel.store`, `AppModel.activationGeneration`, `SessionStore`, `ServerProfile`.
- Produces: `@MainActor protocol AppExtension: AnyObject { init(store: SessionStore, app: AppModel); func teardown() }`; on `AppModel`: `func register<E: AppExtension>(_ type: E.Type)`, `` func `extension`<E: AppExtension>(_ type: E.Type) -> E? ``, `func makeExtensions(store: SessionStore)`, `func tearDownExtensions()`, plus stored `extensionFactories` / `liveExtensions`; `@MainActor enum StreamRegistrations { static func installAll(into app: AppModel) }`.

- [ ] **Step 1: Write the failing test**

Create `native/Apps/ShepherdMac/Tests/AppExtensionTests.swift`:

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// What a fake extension recorded, kept off the fake so a test can read it after
/// the instance is gone.
@MainActor
final class ExtensionLedger {
    var created = 0
    var tornDown = 0
    /// At teardown time, was the model still holding the store this extension was
    /// built for? That proves `tearDownExtensions()` runs before the model lets go
    /// of the store — and so before `store.stop()`, which sits on the next line in
    /// both `activate(_:)` and `teardown()`.
    var storeStillOwnedAtTeardown: [Bool] = []
}

@MainActor
final class FakeExtension: AppExtension {
    /// The ledger the next instance writes to; `.serialized` keeps it to one.
    static var ledger = ExtensionLedger()

    let store: SessionStore
    private weak var app: AppModel?
    private let ledger: ExtensionLedger

    init(store: SessionStore, app: AppModel) {
        self.store = store
        self.app = app
        self.ledger = FakeExtension.ledger
        ledger.created += 1
    }

    func teardown() {
        ledger.tornDown += 1
        ledger.storeStillOwnedAtTeardown.append(app?.store === store)
    }
}

@MainActor
@Suite(.serialized)
struct AppExtensionTests {
    private func makeModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        FakeExtension.ledger = ExtensionLedger()
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    private func remote(_ model: AppModel, _ label: String) throws -> ServerProfile {
        try model.addRemoteProfile(name: label, address: "https://\(label).example.ts.net")
    }

    @Test func itIsBuiltOnActivation_foundByType_andTornDownWhileTheStoreIsStillHeld()
        async throws
    {
        let model = makeModel()
        model.register(FakeExtension.self)
        #expect(model.extension(FakeExtension.self) == nil)

        await model.activate(try remote(model, "one"))
        let ext = try #require(model.extension(FakeExtension.self))
        #expect(ext.store === model.store)
        #expect(FakeExtension.ledger.created == 1)

        model.teardown()
        #expect(FakeExtension.ledger.tornDown == 1)
        #expect(FakeExtension.ledger.storeStillOwnedAtTeardown == [true])
        #expect(model.extension(FakeExtension.self) == nil)
    }

    @Test func switchingProfilesTearsTheOldOneDownAndBuildsAFreshOne() async throws {
        let model = makeModel()
        model.register(FakeExtension.self)
        let first = try remote(model, "two")
        let second = try remote(model, "three")

        await model.activate(first)
        let firstExtension = try #require(model.extension(FakeExtension.self))
        await model.activate(second)
        let secondExtension = try #require(model.extension(FakeExtension.self))

        #expect(firstExtension !== secondExtension)
        #expect(FakeExtension.ledger.created == 2)
        #expect(FakeExtension.ledger.tornDown == 1)
        #expect(FakeExtension.ledger.storeStillOwnedAtTeardown == [true])
        model.teardown()
    }

    @Test func registeringIsIdempotentAndBuildsImmediatelyWhenAStoreIsLive() async throws {
        let model = makeModel()
        await model.activate(try remote(model, "four"))

        model.register(FakeExtension.self)
        model.register(FakeExtension.self)

        #expect(model.extension(FakeExtension.self) != nil)
        #expect(FakeExtension.ledger.created == 1)
        model.teardown()
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests/AppExtensionTests`
Expected: FAIL — `cannot find type 'AppExtension' in scope`,
`value of type 'AppModel' has no member 'register'`.

- [ ] **Step 3: Add the storage to `AppModel`**

In `AppModel.swift`, immediately after the line
`@ObservationIgnored private var watchedProfile: ServerProfile?`, insert:

```swift
    /// Per-stream sub-models, keyed by extension type. Not `private`:
    /// `AppModel+Extensions.swift` is a different file and owns every write to
    /// both of these. Nothing else may touch them.
    ///
    /// A factory closure rather than an `any AppExtension.Type`: calling a
    /// protocol `init` requirement through an existential metatype is not
    /// expressible, so `register<E>` captures the concrete `E` here instead.
    @ObservationIgnored
    var extensionFactories:
        [(key: ObjectIdentifier, make: @MainActor (SessionStore, AppModel) -> any AppExtension)] = []
    /// Live instances for the current activation, in creation order. Emptied by
    /// `tearDownExtensions()`; never outlives its store.
    @ObservationIgnored
    var liveExtensions: [(key: ObjectIdentifier, value: any AppExtension)] = []
```

- [ ] **Step 4: Hook the lifecycle into `activate(_:)` and `teardown()`**

Three insertions in `AppModel.swift`. In `activate(_:)`, immediately **before** the comment block
beginning `// A stopped SessionStore cannot be restarted`:

```swift
        // Before the old store stops: an extension may need a last word with the
        // store it was built for, and none may outlive it.
        tearDownExtensions()
```

Further down in the same method, immediately **after** the line `self.store = store`:

```swift
        // After the store exists and before anything consumes events, so an
        // extension is in place for the first frame the store publishes.
        makeExtensions(store: store)
```

And in `teardown()`, immediately **before** the comment block beginning
`// stop() also publishes`:

```swift
        tearDownExtensions()
```

- [ ] **Step 5: Write the protocol and the accessors**

Create `native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift`:

```swift
import Foundation
import ShepherdKit

/// A per-stream sub-model owned by `AppModel`.
///
/// Built in `activate(_:)` once the `SessionStore` exists, torn down in
/// `teardown()` — and at the top of the next `activate(_:)` — before that store
/// stops. It therefore never outlives its store, which is the point: it may hold
/// the store strongly without keeping a dead activation alive.
///
/// `AnyObject` because an extension holds tasks and observable state. Conform
/// with a `final class`: a non-final one would need `required init`.
///
/// **Async work is the extension's own problem.** Anything that suspends must
/// capture `app.activationGeneration` before the first `await` and drop its
/// result once that value has moved on, exactly as `AppModel`'s own async steps
/// do. `teardown()` is synchronous and must cancel, not await.
@MainActor
protocol AppExtension: AnyObject {
    init(store: SessionStore, app: AppModel)
    /// Cancel tasks, drop observers, release the store. Called exactly once.
    func teardown()
}

extension AppModel {
    /// Records `type` so every future activation builds one, and builds one now if
    /// a store is already live.
    ///
    /// Idempotent per type. Building immediately matters because
    /// `StreamRegistrations.installAll(into:)` runs from a view task, which can
    /// land after a restored profile has already activated — without it that
    /// launch would silently have no extensions.
    func register<E: AppExtension>(_ type: E.Type) {
        let key = ObjectIdentifier(type)
        guard !extensionFactories.contains(where: { $0.key == key }) else { return }
        extensionFactories.append((key, { store, app in E(store: store, app: app) }))
        if let store {
            liveExtensions.append((key, E(store: store, app: self)))
        }
    }

    /// The live instance for `type`, or `nil` when nothing is active. Backticks
    /// because `extension` is a keyword — Appendix B's spelling is kept.
    func `extension`<E: AppExtension>(_ type: E.Type) -> E? {
        let key = ObjectIdentifier(type)
        return liveExtensions.first { $0.key == key }?.value as? E
    }

    /// One instance per registered type, in registration order. Called by
    /// `activate(_:)` right after `self.store` is set.
    func makeExtensions(store: SessionStore) {
        for factory in extensionFactories {
            liveExtensions.append((factory.key, factory.make(store, self)))
        }
    }

    /// Tears live instances down in reverse creation order, so an extension built
    /// on top of an earlier one goes first. Called by `activate(_:)` and
    /// `teardown()` immediately before `store?.stop()`.
    func tearDownExtensions() {
        for entry in liveExtensions.reversed() { entry.value.teardown() }
        liveExtensions.removeAll()
    }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests/AppExtensionTests`
Expected: PASS — `Test run with 3 tests passed`.

- [ ] **Step 7: Add the one call site streams are wired into**

Create `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`:

```swift
import SwiftUI

/// The single place a merged stream is wired into the app.
///
/// Owned by the integration lane (S0-int): each stream merge adds exactly one
/// line here and nothing else in `Sources/App/` changes. That is what keeps
/// `ShepherdApp.swift`, `MainWindow.swift` and `AppModel.swift` out of every
/// stream's diff.
///
/// Idempotent by construction — `DetailTabRegistry.register` is keyed by tab id,
/// `AppModel.register` by extension type, a slot assignment is a plain overwrite
/// — so the launch task may run it more than once.
@MainActor
enum StreamRegistrations {
    static func installAll(into app: AppModel) {
        // Streams add one line each, e.g.
        //   TerminalStream.install(app)   // S1: DetailTab + AppExtension
        //   SidebarStream.install(app)    // S3: SidebarSlot
        _ = app
    }
}
```

In `ShepherdApp.swift`, replace `RootView`'s `.task { await model.restoreActiveProfile() }` with:

```swift
        // Registration runs first and synchronously: an extension registered
        // after the restored activation would miss it.
        .task {
            StreamRegistrations.installAll(into: model)
            await model.restoreActiveProfile()
        }
```

Leave the comment block already above that modifier in place.

- [ ] **Step 8: Run the unit bundle and build**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh Release
```

Expected: `** TEST SUCCEEDED **` and `** BUILD SUCCEEDED **`. `AppModelTests` — activation,
removal and the generation guards — must still pass untouched.

- [ ] **Step 9: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift \
        native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift \
        native/Apps/ShepherdMac/Sources/App/AppModel.swift \
        native/Apps/ShepherdMac/Sources/App/ShepherdApp.swift \
        native/Apps/ShepherdMac/Tests/AppExtensionTests.swift
git commit -m "feat(mac): AppExtension lifecycle tied to the active store

A stream's sub-model is built after the SessionStore exists and torn down before
it stops, so it can never outlive its activation. StreamRegistrations is the one
file the integration lane edits per merged stream.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Split the string manifest into per-stream arrays

**Files:** Modify `native/scripts/gen-strings.ts` (the `KEYS` constant and `build()`) and
`test/native-gen-strings.test.ts`.

**Interfaces:**

- Consumes: nothing new.
- Produces from `native/scripts/gen-strings.ts`: `KEYS_CORE`, `KEYS_TERMINAL`, `KEYS_DETAIL`, `KEYS_SIDEBAR`, `KEYS_ACTIONS`, `KEYS_LOCALSERVER`, `KEYS_NOTIFICATIONS` (each `readonly string[]`), `KEYS` (their concatenation — same name and type as today), `duplicateKeys(keys: readonly string[]): string[]`.

- [ ] **Step 1: Write the failing test**

In `test/native-gen-strings.test.ts`, replace the import line at the top with:

```ts
import {
  convert,
  duplicateKeys,
  KEYS,
  KEYS_ACTIONS,
  KEYS_CORE,
  KEYS_DETAIL,
  KEYS_LOCALSERVER,
  KEYS_NOTIFICATIONS,
  KEYS_SIDEBAR,
  KEYS_TERMINAL,
  placeholderOrder,
} from "../native/scripts/gen-strings";
```

and append at the end of the file:

```ts
describe("gen-strings manifest", () => {
  const streamManifests = [
    KEYS_TERMINAL,
    KEYS_DETAIL,
    KEYS_SIDEBAR,
    KEYS_ACTIONS,
    KEYS_LOCALSERVER,
    KEYS_NOTIFICATIONS,
  ];

  test("KEYS is exactly the per-stream manifests concatenated, in a fixed order", () => {
    expect([...KEYS]).toEqual([...KEYS_CORE, ...streamManifests.flat()]);
  });

  test("only the core manifest is populated before the streams land", () => {
    expect(KEYS_CORE.length).toBeGreaterThan(0);
    for (const manifest of streamManifests) expect([...manifest]).toEqual([]);
  });

  test("the core manifest stays alphabetical", () => {
    expect([...KEYS_CORE]).toEqual([...KEYS_CORE].sort());
  });

  test("no key is claimed by two manifests", () => {
    expect(duplicateKeys(KEYS)).toEqual([]);
    expect(duplicateKeys(["b", "a", "b", "a", "c"])).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/native-gen-strings.test.ts`
Expected: FAIL — `SyntaxError: export 'duplicateKeys' not found in module` (or, on some Bun
versions, the manifest assertions failing because `KEYS_CORE` is `undefined`).

- [ ] **Step 3: Split the manifest**

In `native/scripts/gen-strings.ts`:

1. **Rename `KEYS` to `KEYS_CORE` in place** — change only the declaration line
   `export const KEYS: readonly string[] = [` to `export const KEYS_CORE: readonly string[] = [`.
   Leave all 99 key strings exactly as they are: same spelling, same alphabetical order, none
   added, none removed. Replace the doc comment above it with:

```ts
/**
 * Every catalog key the macOS app is allowed to use, split by the parallel
 * stream that owns it. A stream edits ONLY its own array, so two branches
 * appending keys produce insertion conflicts a rebase resolves rather than a
 * fight over one list. Keep each array alphabetical.
 *
 * Core: the shell — window, welcome, login, first run, session list, detail
 * header, shared status and effort labels.
 */
```

2. Immediately **after** the closing `];` of `KEYS_CORE`, add:

```ts
/** S1 — terminal view, PTY status, takeover and reconnect copy. */
export const KEYS_TERMINAL: readonly string[] = [];

/** S2 — detail tabs: activity, diff, files, PR status and PR actions. */
export const KEYS_DETAIL: readonly string[] = [];

/** S3 — sidebar triage sections, filters, search, header counters, usage meter. */
export const KEYS_SIDEBAR: readonly string[] = [];

/** S4 — the quick-action bar and the "Handlungsbedarf" recap line. */
export const KEYS_ACTIONS: readonly string[] = [];

/** S5 — local server detection, install, start/stop/restart and the log tail. */
export const KEYS_LOCALSERVER: readonly string[] = [];

/** S6 — notification titles and bodies. */
export const KEYS_NOTIFICATIONS: readonly string[] = [];

/**
 * The manifest the catalog is generated from. Order here does not reach the
 * output — `build()` sorts before emitting — but is fixed so the concatenation
 * is easy to assert.
 */
export const KEYS: readonly string[] = [
  ...KEYS_CORE,
  ...KEYS_TERMINAL,
  ...KEYS_DETAIL,
  ...KEYS_SIDEBAR,
  ...KEYS_ACTIONS,
  ...KEYS_LOCALSERVER,
  ...KEYS_NOTIFICATIONS,
];

/**
 * Keys appearing more than once, sorted. Two streams claiming the same key is an
 * authoring mistake the sorted, de-duplicating emit would otherwise hide: the
 * catalog would be right and `KEYS.length` would be a lie.
 */
export function duplicateKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  return [...dupes].sort();
}
```

3. Inside `build()`, immediately after `const de = load(DE);`, add:

```ts
  const dupes = duplicateKeys(KEYS);
  if (dupes.length > 0) {
    throw new Error(`keys claimed by more than one stream manifest: ${dupes.join(", ")}`);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/native-gen-strings.test.ts`
Expected: PASS — 8 tests (the 4 existing `convert` tests plus the 4 new ones).

- [ ] **Step 5: Prove the catalog regenerates byte-identical**

```bash
bun run gen:strings
git diff --exit-code -- native/Apps/ShepherdMac/Resources/Localizable.xcstrings && echo "catalog unchanged"
bun run check:strings
```

Expected: `Wrote …/Localizable.xcstrings (99 keys, en + de).`, then `catalog unchanged` (empty
diff, exit 0), then `Localizable.xcstrings is up to date (99 keys).` A non-empty diff means a key
was dropped, added or misspelled while splitting — fix the arrays; never commit a changed catalog
from this task. (`99` is `KEYS_CORE.length` on this branch; if Gate 2 landed another key before
the cut, the count moves with it — the **empty diff** is the assertion that matters.)

- [ ] **Step 6: Run the full root suite and the formatter**

```bash
bun run test
bunx prettier --check native/scripts/gen-strings.ts test/native-gen-strings.test.ts
```

Expected: the root suite passes with 0 failures; `All matched files use Prettier code style!`.

- [ ] **Step 7: Commit**

```bash
git add native/scripts/gen-strings.ts test/native-gen-strings.test.ts
git commit -m "chore(i18n): split the mac string manifest per stream

KEYS becomes KEYS_CORE plus six empty per-stream arrays, so each stream appends
to its own list and rebases cleanly. The generated catalog is byte-identical; a
key claimed by two manifests now fails the generator.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Empty stream blocks in the contract

**Files:** Create `test/contract/stream-blocks.test.ts`; modify `contracts/openapi.yaml` (end of
`components.schemas:`, end of `paths:`).

**Interfaces:**

- Consumes: `contracts/openapi.yaml` as text.
- Produces: marker pairs `# ── stream: <name> ──` / `# ── /stream: <name> ──` for `terminal`, `detail`, `sidebar`, `actions` — once each inside `components.schemas:` and once each inside `paths:`, in that order.

- [ ] **Step 1: Write the failing test**

Create `test/contract/stream-blocks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-stream insertion points in the contract.
 *
 * Every parallel stream appends its paths and schemas INSIDE its own marked
 * block, so two branches adding routes collide as insertion conflicts resolved
 * by keeping both blocks — not as a fight over the same trailing lines. This
 * guards the markers; openapi.test.ts still guards what goes between them.
 */
const CONTRACT = readFileSync(
  join(import.meta.dir, "..", "..", "contracts", "openapi.yaml"),
  "utf8",
);
const LINES = CONTRACT.split("\n").map((line) => line.trim());
const STREAMS = ["terminal", "detail", "sidebar", "actions"] as const;

const first = (needle: string) => LINES.indexOf(needle);
const last = (needle: string) => LINES.lastIndexOf(needle);
const count = (needle: string) => LINES.filter((line) => line === needle).length;

describe("contract stream blocks", () => {
  test("every stream has one open and one close marker per section", () => {
    for (const stream of STREAMS) {
      expect(count(`# ── stream: ${stream} ──`)).toBe(2);
      expect(count(`# ── /stream: ${stream} ──`)).toBe(2);
    }
  });

  test("the schema blocks sit at the end of components.schemas, before responses", () => {
    const schemas = first("schemas:");
    const responses = first("responses:");
    expect(schemas).toBeGreaterThan(-1);
    expect(responses).toBeGreaterThan(schemas);
    for (const stream of STREAMS) {
      expect(first(`# ── stream: ${stream} ──`)).toBeGreaterThan(schemas);
      expect(first(`# ── /stream: ${stream} ──`)).toBeLessThan(responses);
    }
  });

  test("the path blocks sit at the end of paths, before x-shepherd-events", () => {
    const paths = first("paths:");
    const events = first("x-shepherd-events:");
    expect(events).toBeGreaterThan(paths);
    for (const stream of STREAMS) {
      expect(last(`# ── stream: ${stream} ──`)).toBeGreaterThan(paths);
      expect(last(`# ── /stream: ${stream} ──`)).toBeLessThan(events);
    }
  });

  test("the streams appear in the agreed order in both sections", () => {
    const opens = LINES.filter((line) => line.startsWith("# ── stream: ")).map((line) =>
      line.replace("# ── stream: ", "").replace(" ──", ""),
    );
    expect(opens).toEqual([...STREAMS, ...STREAMS]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/contract/stream-blocks.test.ts`
Expected: FAIL — the first test reports `expect(received).toBe(expected) // received: 0, expected: 2`.

- [ ] **Step 3: Add the schema blocks**

In `contracts/openapi.yaml`, inside `components:` → `schemas:`, after the last schema
(`SessionReadyEvent`, final line `        ready: { type: boolean }`) and **before** the
`  responses:` key, insert at four-space indentation:

```yaml
    # ── stream: terminal ──
    # ── /stream: terminal ──
    # ── stream: detail ──
    # ── /stream: detail ──
    # ── stream: sidebar ──
    # ── /stream: sidebar ──
    # ── stream: actions ──
    # ── /stream: actions ──
```

- [ ] **Step 4: Add the path blocks**

At the end of `paths:` — after the last route (`/api/repos`, final line
`          $ref: "#/components/responses/Unauthorized"`) and **before** the top-level
`x-shepherd-events:` key — insert at two-space indentation:

```yaml
  # ── stream: terminal ──
  # ── /stream: terminal ──
  # ── stream: detail ──
  # ── /stream: detail ──
  # ── stream: sidebar ──
  # ── /stream: sidebar ──
  # ── stream: actions ──
  # ── /stream: actions ──
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test ./test/contract/stream-blocks.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Prove nothing downstream moved**

```bash
bunx prettier --write contracts/openapi.yaml test/contract/stream-blocks.test.ts
git diff --stat -- contracts/openapi.yaml
bun run check:contract-swift
./native/scripts/sync-contract.sh --check
bun run test:contract
```

Expected, in order: prettier rewrites both files (it may re-indent the comments — the test trims,
so that is fine); `git diff --stat` shows `contracts/openapi.yaml | 16 ++++++++++++++++` and
nothing else; `check:contract-swift` regenerates `contracts/openapi.swift.yaml` and its
`git diff --exit-code` exits 0 with **no** output (YAML comments never reach the derived file);
`sync-contract: up to date`; the contract suite passes. A diff from `check:contract-swift` means a
marker landed inside a schema or a path object instead of between them — move it.

- [ ] **Step 7: Commit**

```bash
git add contracts/openapi.yaml test/contract/stream-blocks.test.ts
git commit -m "chore(contract): empty per-stream blocks in paths and schemas

Each stream appends inside its own marked block, so two branches adding routes
conflict as insertions rather than as a fight over the file's tail. Comments do
not reach the derived Swift contract, so the drift gates are untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Three preconditions the stream planners found unmet

Three things streams need that today's code does not allow. Each is a separate failing-test-first
cycle with its own commit.

**Files:**

- Modify: `native/Sources/ShepherdKit/Client/ShepherdClient.swift` (one access modifier)
- Create: `native/Tests/ShepherdKitTests/GeneratedClientVisibilityTests.swift`
- Create: `native/Sources/ShepherdKit/Model/SessionStore+EventTap.swift`
- Modify: `native/Sources/ShepherdKit/Realtime/ServerEvent.swift` (the `.unknown` case carries its payload)
- Modify: `native/Sources/ShepherdKit/Model/SessionStore.swift` (tap storage, `applyNow(_:)`, `stop()`)
- Modify: `native/Tests/ShepherdKitTests/{EventStreamTests,ServerEventTests,SessionStoreTests}.swift` (the `.unknown` pattern gains a payload binding)
- Create: `native/Tests/ShepherdKitTests/SessionStoreEventTapTests.swift`
- Create: `test/contract/stream-blocks.ts`
- Modify: `test/contract/openapi.test.ts` (the coverage gate)
- Modify: `test/contract/stream-blocks.test.ts` (Task 5's file — the helper's tests are folded in here)

**Interfaces:**

- Consumes: `Client` (generated, `accessModifier: public`), `FakeEventServer`, `EventStream(baseURL:tokenProvider:reconnectDelay:maxReconnectDelay:)`, `SessionStore.consume(_:)`, `declaredOperations()` from `./harness`.
- Produces: `ShepherdClient.generated` at `internal`; `case ServerEvent.unknown(name: String, payload: Data?)`; `public func SessionStore.events() -> AsyncStream<ServerEvent>` plus internal `broadcast(_:)` / `finishEventTaps()` and the stored `eventTaps`; from `test/contract/stream-blocks.ts`: `STREAM_NAMES`, `type StreamName`, `parseStreamBlocks(yaml: string): StreamBlocks`, `streamBlocks(): StreamBlocks`, `streamOwnedPaths(): Set<string>`, `operationTemplate(operation: string): string`, `operationsForStream(stream: StreamName): string[]`.

#### A. `ShepherdClient.generated` is `internal`, not `private`

S1–S4 each add a kit file (`ShepherdClient+Terminal.swift`, `+Detail.swift`, `+Backlog.swift`,
`+Actions.swift`) that wraps generated operations. A `private` stored property is file-scoped, so
none of them can reach it today.

- [ ] **Step 1: Write the failing test**

Create `native/Tests/ShepherdKitTests/GeneratedClientVisibilityTests.swift`:

```swift
import Foundation
import Testing

@testable import ShepherdKit

/// Stands in for the per-stream extension files S1–S4 add inside the kit
/// (`ShepherdClient+Terminal.swift`, `+Detail.swift`, `+Backlog.swift`,
/// `+Actions.swift`). They reach the generated client exactly like this.
///
/// This extension is the regression guard: narrow `generated` back to `private`
/// and this file stops COMPILING. A visibility regression must be a build
/// failure here, not a surprise in four stream worktrees at once.
extension ShepherdClient {
  /// The one move every stream wrapper makes: call a generated operation and
  /// map its `Output` enum. `getHealth` is used because it is the contract's
  /// only `security: []` route, so this needs no credential.
  func probeGeneratedClientIsReachable() async throws -> Bool {
    switch try await generated.getHealth(.init()) {
    case .ok: return true
    case .undocumented: return false
    }
  }
}

@Suite("generated client visibility")
struct GeneratedClientVisibilityTests {
  @Test("a kit extension in another file can reach ShepherdClient.generated")
  func extensionReachesTheGeneratedClient() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    let client = try ShepherdClient(
      profile: profile, credentials: InMemoryCredentialStore(), urlSession: server.urlSession())

    let reachable = try await client.probeGeneratedClientIsReachable()
    #expect(reachable)
  }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --package-path native --filter GeneratedClientVisibility`
Expected: FAIL at compile time — `'generated' is inaccessible due to 'private' protection level`.

- [ ] **Step 3: Widen the modifier**

In `native/Sources/ShepherdKit/Client/ShepherdClient.swift`, replace the line
`  private let generated: Client` with:

```swift
  /// The generated client, `internal` on purpose: the per-stream wrappers
  /// (`ShepherdClient+Terminal.swift`, `+Detail.swift`, `+Backlog.swift`,
  /// `+Actions.swift`) live in other files of THIS module and could not reach a
  /// `private` property. Never `public` — the whole point of this type is that
  /// callers outside the kit never see generated `Output` cases. The guard that
  /// it stays exactly here is `GeneratedClientVisibilityTests`.
  let generated: Client
```

- [ ] **Step 4: Run the test and pin the modifier**

```bash
swift test --package-path native --filter GeneratedClientVisibility
grep -n "let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift
```

Expected: the test passes, and `grep` prints exactly one line, `  let generated: Client`, with
neither `private` nor `public` on it. `@testable import` would happily compile against a `public`
property too, so this grep — not the test — is what pins "internal, never public".

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient.swift \
        native/Tests/ShepherdKitTests/GeneratedClientVisibilityTests.swift
git commit -m "feat(kit): make ShepherdClient.generated internal for stream wrappers

Per-stream route wrappers live in their own kit files, which a private stored
property cannot reach. A test-target extension calls it, so narrowing it back
to private is a build failure rather than four blocked worktrees.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

#### B. `SessionStore` event tap

S2 and S3 must consume `session:git`, `session:activity`, `held:changed` and friends. Adding cases
to the generated-backed `EventName` switch in `ServerEvent.swift` would put every stream in the
same S0-owned file and break its exhaustive `switch`. Instead every event — decoded or not —
is broadcast to per-caller taps, and `.unknown` starts carrying its raw payload so a stream can
decode it with the generated schema its own contract block declares.

- [ ] **Step 1: Write the failing test**

Create `native/Tests/ShepherdKitTests/SessionStoreEventTapTests.swift`:

```swift
import Foundation
import Testing

@testable import ShepherdKit

@MainActor
@Suite("SessionStore event tap")
struct SessionStoreEventTapTests {
  /// A store with no socket of its own: `consume(_:)` is driven by hand, which
  /// is the only part of the pipeline this suite is about.
  private func makeStore() throws -> SessionStore {
    let profile = ServerProfile(
      name: "fake", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local, credentialKey: "k")
    let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
    return SessionStore(client: client)
  }

  /// Polls until `condition` holds or the deadline passes. Same shape as
  /// `EventStreamTests.eventually` — Network.framework callbacks land on their
  /// own queue, so a test observes them by polling.
  private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  @Test("an event the client does not model reaches a tap with its payload")
  func unknownEventReachesATap() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    let store = try makeStore()

    let seen = EventBox()
    let tap = store.events()
    let reader = Task { @MainActor in
      for await event in tap {
        seen.set(event)
        break
      }
    }
    let pump = Task { @MainActor in await store.consume(stream.events()) }
    defer {
      reader.cancel()
      pump.cancel()
    }

    await stream.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.send(#"{"event":"session:git","data":{"prNumber":7}}"#)

    #expect(try await eventually { seen.get() != nil })
    guard case .unknown(let name, let payload) = try #require(seen.get()) else {
      Issue.record("expected an .unknown event")
      return
    }
    #expect(name == "session:git")
    // A stream decodes this with the generated schema its own contract block
    // declares; here it is enough to prove the bytes survived the trip.
    let json =
      try JSONSerialization.jsonObject(with: try #require(payload)) as? [String: Any]
    #expect(json?["prNumber"] as? Int == 7)

    await stream.stop()
  }

  @Test("every tap finishes when the store stops")
  func tapsFinishOnStop() async throws {
    let store = try makeStore()
    let first = store.events()
    let second = store.events()

    let drained = Task { @MainActor () -> Int in
      var count = 0
      for await _ in first { count += 1 }
      return count
    }
    let other = Task { @MainActor in
      for await _ in second {}
      return true
    }

    // One event, to both taps, before the stop.
    store.apply(.unknown(name: "held:changed", payload: nil))
    store.stop()

    // Both `for await` loops end only because `stop()` finished the
    // continuations; without that this test would hang rather than fail, which
    // is the clearest possible signal.
    #expect(await drained.value == 1)
    #expect(await other.value)
  }

  /// Holds the first element a reader saw. `@unchecked Sendable` is not needed:
  /// the box is only ever touched from the main actor here.
  @MainActor
  private final class EventBox {
    private var value: ServerEvent?
    func set(_ event: ServerEvent) { if value == nil { value = event } }
    func get() -> ServerEvent? { value }
  }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --package-path native --filter SessionStoreEventTap`
Expected: FAIL at compile time — `value of type 'SessionStore' has no member 'events'`, and
`extra argument 'payload' in call` on `.unknown(name:payload:)`.

- [ ] **Step 3: Give `.unknown` its payload**

In `native/Sources/ShepherdKit/Realtime/ServerEvent.swift`:

(a) add `import OpenAPIRuntime` under `import Foundation`;

(b) replace the `unknown` case declaration with:

```swift
  /// An event this client does not handle — either a name the contract does
  /// not list, or a listed name whose payload would not decode. Ignored by
  /// the store, never an error: the server emits many events the native
  /// client does not use yet, and one bad frame must not kill the stream.
  ///
  /// `payload` is the frame's `data` re-encoded as JSON, or `nil` when the
  /// frame carried none. It is how a parallel stream reads an event its own
  /// contract block declares — match the raw `name`, then decode `payload`
  /// into the generated schema — without adding a case to `EventName` and the
  /// exhaustive switch below, which every stream would then have to edit.
  case unknown(name: String, payload: Data?)
```

(c) inside `init(from:)`, immediately after the `func payload<T: Decodable>(…)` helper, add the
raw reader, and give every `.unknown(name:)` construction the payload:

```swift
    /// The `data` member as JSON bytes. Decoded through
    /// `OpenAPIValueContainer` — the runtime's any-JSON box — because a keyed
    /// container hands out decoded values, never the original bytes.
    func rawPayload() -> Data? {
      guard let value = try? container.decode(OpenAPIValueContainer.self, forKey: .data)
      else { return nil }
      return try? JSONEncoder().encode(value)
    }
```

Then replace **every** `.unknown(name: name.rawValue)` in this file — all nine of them, the eight
`?? .unknown(…)` fall-backs and the `case nil:` line — with
`.unknown(name: name.rawValue, payload: rawPayload())`.

- [ ] **Step 4: Fix the four existing `.unknown` call sites**

Pattern matches and equality checks elsewhere now need the second binding:

- `native/Sources/ShepherdKit/Model/SessionStore.swift`: `case .unknown(let name):` →
  `case .unknown(let name, _):`
- `native/Tests/ShepherdKitTests/SessionStoreTests.swift`: `store.apply(.unknown(name: "epic:progress"))`
  → `store.apply(.unknown(name: "epic:progress", payload: nil))`
- `native/Tests/ShepherdKitTests/EventStreamTests.swift` and
  `native/Tests/ShepherdKitTests/ServerEventTests.swift`: replace each
  `#expect(… == .unknown(name: "<n>"))` with a name-only pattern match, because those fixtures do
  carry a `data` member and the payload is no longer `nil`:

```swift
    guard case .unknown(let name, _) = try #require(try await firstEvent(from: events)) else {
      Issue.record("expected an .unknown event")
      return
    }
    #expect(name == "epic:progress")
```

In `ServerEventTests` the value is already in hand, so the two cases there read
`guard case .unknown(let name, _) = event else { … }` followed by
`#expect(name == "epic:progress")` and `#expect(name == "session:ready")`.

- [ ] **Step 5: Add the tap storage and its two hooks**

In `native/Sources/ShepherdKit/Model/SessionStore.swift`, immediately after the line
`@ObservationIgnored private var consumer: Task<Void, Never>?`'s doc block ends — that is, right
before `/// The task following `EventStream.lifecycle()`` — insert:

```swift
  /// Live event taps, keyed by the id `events()` handed out.
  ///
  /// Not `private`: `SessionStore+EventTap.swift` is a different file and owns
  /// every write to this. One continuation per `events()` call, so several
  /// streams can each consume every frame without competing for elements the
  /// way a single shared `AsyncStream` would.
  @ObservationIgnored
  var eventTaps: [UUID: AsyncStream<ServerEvent>.Continuation] = [:]
```

In `applyNow(_:)`, immediately after its opening line `private func applyNow(_ event: ServerEvent) {`
and before `switch event {`, insert:

```swift
    // Every frame the store applies, decoded or not, reaches the taps here —
    // after the snapshot buffer has released it, so a tap consumer that reads
    // `sessions` sees state that already includes this event.
    broadcast(event)
```

In `stop()`, immediately after the line `connection = .idle`, insert:

```swift
    // A tap must not outlive the store it reads from: finishing the
    // continuations ends every consumer's `for await`.
    finishEventTaps()
```

- [ ] **Step 6: Write the tap**

Create `native/Sources/ShepherdKit/Model/SessionStore+EventTap.swift`:

```swift
import Foundation

extension SessionStore {
  /// A live feed of every event this store applies, including the ones it does
  /// not model itself.
  ///
  /// One independent stream per call — several parallel streams tap the same
  /// store and each sees every frame. Buffered `.bufferingNewest(64)`: a tap
  /// consumer that stalls drops its own oldest frames rather than backing up
  /// the store's event loop for everybody. Every stream finishes on `stop()`,
  /// and a consumer that simply stops iterating removes its own tap.
  ///
  /// This is the seam parallel streams consume events through. A stream matches
  /// the raw name on `.unknown(name:payload:)` and decodes `payload` with the
  /// generated schema its own `contracts/openapi.yaml` block declares — the
  /// contract stays the only type source. Streams never add a case to
  /// `EventName` or edit `ServerEvent.swift`: that switch is exhaustive and
  /// S0-owned, so every stream that touched it would collide with every other.
  public func events() -> AsyncStream<ServerEvent> {
    let id = UUID()
    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(64))
    // Runs on whatever executor ended the stream (a cancelled consumer, a
    // dropped iterator), so it hops back before touching main-actor state.
    continuation.onTermination = { [weak self] _ in
      Task { @MainActor in self?.eventTaps[id] = nil }
    }
    eventTaps[id] = continuation
    return stream
  }

  /// Fans one applied event out to every tap. Called by `applyNow(_:)`.
  func broadcast(_ event: ServerEvent) {
    for continuation in eventTaps.values { continuation.yield(event) }
  }

  /// Ends every tap. Called by `stop()`.
  func finishEventTaps() {
    for continuation in eventTaps.values { continuation.finish() }
    eventTaps.removeAll()
  }
}
```

- [ ] **Step 7: Run the kit suite**

```bash
swift test --package-path native
```

Expected: `Test run with N tests passed`. `ServerEventTests`, `EventStreamTests`,
`SessionStoreTests` and the two new suites all pass; nothing else in the kit references `.unknown`.

- [ ] **Step 8: Commit**

```bash
git add native/Sources/ShepherdKit/Model/SessionStore+EventTap.swift \
        native/Sources/ShepherdKit/Model/SessionStore.swift \
        native/Sources/ShepherdKit/Realtime/ServerEvent.swift \
        native/Tests/ShepherdKitTests/SessionStoreEventTapTests.swift \
        native/Tests/ShepherdKitTests/SessionStoreTests.swift \
        native/Tests/ShepherdKitTests/EventStreamTests.swift \
        native/Tests/ShepherdKitTests/ServerEventTests.swift
git commit -m "feat(kit): SessionStore.events() tap and a payload-carrying .unknown

Streams consume the events their contract block declares through a per-caller
tap and decode the raw payload with their generated schema, instead of adding
cases to the exhaustive EventName switch every stream would then have to edit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

#### C. The contract coverage gate becomes block-aware

`test/contract/openapi.test.ts` ends with a gate asserting every declared operation was exercised.
Bun runs test files in filesystem order, so that gate can run **before** a stream's own
`test/contract/<stream>.test.ts` — the moment S1 adds routes to its marked block with fixtures in
its own file, the gate fails on every branch. It must only police paths outside the markers.

- [ ] **Step 1: Write the failing test**

Append to `test/contract/stream-blocks.test.ts` (Task 5's file), and add the import at its top:

```ts
import {
  operationTemplate,
  parseStreamBlocks,
  streamBlocks,
  streamOwnedPaths,
  STREAM_NAMES,
} from "./stream-blocks";
```

```ts
// A miniature contract: one route and one schema outside the markers, one of
// each inside the sidebar block. Parsing a fixture rather than the real file is
// what lets this test exist before any stream has filled a block.
const SYNTHETIC = `openapi: 3.1.0
components:
  schemas:
    Health:
      type: object
    # ── stream: sidebar ──
    Backlog:
      type: object
    # ── /stream: sidebar ──
  responses:
    Unauthorized:
      description: no
paths:
  /api/health:
    get:
      operationId: getHealth
  # ── stream: sidebar ──
  /api/backlog:
    get:
      operationId: getBacklog
  # ── /stream: sidebar ──
x-shepherd-events:
  description: nope
`;

describe("stream-blocks helper", () => {
  test("paths and schemas inside a block are attributed to that stream", () => {
    const blocks = parseStreamBlocks(SYNTHETIC);
    expect(blocks.paths.get("sidebar")).toEqual(["/api/backlog"]);
    expect(blocks.schemas.get("sidebar")).toEqual(["Backlog"]);
    // Everything outside the markers stays unowned — including the `responses:`
    // sibling of `schemas:` and the top-level keys after `paths:`.
    for (const stream of STREAM_NAMES) {
      if (stream === "sidebar") continue;
      expect(blocks.paths.get(stream)).toEqual([]);
      expect(blocks.schemas.get(stream)).toEqual([]);
    }
  });

  test("a close marker for the wrong stream is a parse error", () => {
    const mismatched = SYNTHETIC.replace("# ── /stream: sidebar ──", "# ── /stream: actions ──");
    expect(() => parseStreamBlocks(mismatched)).toThrow(/closed by actions/);
  });

  test("operationTemplate strips the method and the status", () => {
    expect(operationTemplate("GET /api/sessions/{id} 200")).toBe("/api/sessions/{id}");
  });

  test("the gate's filter drops operations inside a block and keeps the rest", () => {
    const owned = new Set([...parseStreamBlocks(SYNTHETIC).paths.values()].flat());
    const declared = ["GET /api/health 200", "GET /api/backlog 200", "GET /api/backlog 401"];
    // This is exactly the expression the coverage gate in openapi.test.ts uses.
    expect(declared.filter((o) => !owned.has(operationTemplate(o)))).toEqual([
      "GET /api/health 200",
    ]);
  });

  test("the real contract's blocks are all still empty on this branch", () => {
    expect(streamOwnedPaths().size).toBe(0);
    expect([...streamBlocks().paths.keys()].sort()).toEqual([...STREAM_NAMES].sort());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/contract/stream-blocks.test.ts`
Expected: FAIL — `Cannot find module './stream-blocks'` (the four marker-shape tests from Task 5
do not run either, because the import fails at module load).

- [ ] **Step 3: Write the helper**

Create `test/contract/stream-blocks.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredOperations } from "./harness";

/** The streams that own a marked block, in the order S0-prep placed them. */
export const STREAM_NAMES = ["terminal", "detail", "sidebar", "actions"] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

export interface StreamBlocks {
  /** Path templates inside each stream's block in `paths:`. */
  paths: Map<string, string[]>;
  /** Component schema names inside each stream's block in `components.schemas:`. */
  schemas: Map<string, string[]>;
}

const CONTRACT_PATH = join(import.meta.dir, "..", "..", "contracts", "openapi.yaml");
const OPEN = /^#\s*──\s*stream:\s*([a-z]+)\s*──$/;
const CLOSE = /^#\s*──\s*\/stream:\s*([a-z]+)\s*──$/;

/**
 * Parses the `# ── stream: <name> ──` blocks out of an OpenAPI document.
 *
 * Raw text, not `Bun.YAML.parse`: the markers are comments and a YAML parse
 * drops them. Indentation is the section discriminator — a top-level key sits at
 * column 0, a path template two spaces under `paths:`, a schema name four spaces
 * under `components:` → `schemas:`.
 */
export function parseStreamBlocks(yaml: string): StreamBlocks {
  const paths = new Map<string, string[]>();
  const schemas = new Map<string, string[]>();
  for (const name of STREAM_NAMES) {
    paths.set(name, []);
    schemas.set(name, []);
  }

  let section: "paths" | "schemas" | null = null;
  let open: string | null = null;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const opened = OPEN.exec(trimmed);
    if (opened) {
      open = opened[1]!;
      continue;
    }
    const closed = CLOSE.exec(trimmed);
    if (closed) {
      if (closed[1] !== open) {
        throw new Error(`stream block ${open ?? "(none)"} closed by ${closed[1]}`);
      }
      open = null;
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    // A column-0 key ends whatever section we were in.
    if (/^\S/.test(line)) {
      section = line.startsWith("paths:") ? "paths" : null;
      open = null;
      continue;
    }
    const twoSpace = /^ {2}([^\s:][^:]*):/.exec(line);
    if (twoSpace) {
      if (section === "paths") {
        if (open && twoSpace[1]!.startsWith("/")) paths.get(open)!.push(twoSpace[1]!);
      } else {
        // Under `components:`. `schemas:` opens the schema section; any other
        // two-space key (`responses:`, `securitySchemes:`) closes it.
        section = twoSpace[1] === "schemas" ? "schemas" : null;
        open = null;
      }
      continue;
    }
    const fourSpace = /^ {4}([^\s:][^:]*):/.exec(line);
    if (fourSpace && section === "schemas" && open) schemas.get(open)!.push(fourSpace[1]!);
  }

  return { paths, schemas };
}

let cached: StreamBlocks | null = null;
/** The real `contracts/openapi.yaml`, parsed once. */
export function streamBlocks(): StreamBlocks {
  if (!cached) cached = parseStreamBlocks(readFileSync(CONTRACT_PATH, "utf8"));
  return cached;
}

/** Every path template any stream owns. */
export function streamOwnedPaths(): Set<string> {
  const out = new Set<string>();
  for (const templates of streamBlocks().paths.values()) for (const t of templates) out.add(t);
  return out;
}

/** `"GET /api/sessions/{id} 200"` → `"/api/sessions/{id}"`. */
export function operationTemplate(operation: string): string {
  const parts = operation.split(" ");
  return parts.slice(1, -1).join(" ");
}

/**
 * Every `"METHOD /template status"` the contract declares inside `stream`'s
 * block — what that stream's own `test/contract/<stream>.test.ts` gates on, as
 * its last `describe`.
 *
 * A stream's gate must not lean on coverage another FILE recorded: Bun runs test
 * files in filesystem order, so `openapi.test.ts`'s global unauthenticated sweep
 * may run after the stream's file. A stream therefore exercises every status it
 * declares — 401 included — from its own file.
 */
export function operationsForStream(stream: StreamName): string[] {
  const owned = new Set(streamBlocks().paths.get(stream) ?? []);
  return declaredOperations().filter((o) => owned.has(operationTemplate(o)));
}
```

- [ ] **Step 4: Run the helper's tests**

Run: `bun test ./test/contract/stream-blocks.test.ts`
Expected: PASS — 9 tests (Task 5's 4 marker-shape tests plus these 5).

- [ ] **Step 5: Make the gate block-aware**

In `test/contract/openapi.test.ts`, add to the import list from `./harness` nothing new, and add a
second import below it:

```ts
import { operationTemplate, streamOwnedPaths } from "./stream-blocks";
```

Then replace the final `describe("coverage gate", …)` block with:

```ts
// The coverage gate stays the LAST describe in this file for the whole plan; every later
// contract area adds its describe above it.
describe("coverage gate", () => {
  // Block-aware. A path inside a `# ── stream: … ──` block belongs to the stream that
  // added it, and its fixtures live in that stream's own test/contract/<stream>.test.ts.
  // Bun runs test files in filesystem order, so this gate can run BEFORE those files —
  // policing their paths here would fail every stream branch the day it adds a route.
  // Each stream file ends with its own gate over operationsForStream(<name>).
  test("every declared operation outside a stream block was exercised", () => {
    const { operations } = coverage();
    const owned = streamOwnedPaths();
    const missingOps = declaredOperations().filter(
      (o) => !owned.has(operationTemplate(o)) && !operations.has(o),
    );
    expect(missingOps).toEqual([]);
  });

  // `x-shepherd-events` carries no marked blocks, so every declared event is still this
  // gate's business. A stream that adds an event will hit exactly the ordering problem
  // this task fixed for paths — flag it to the orchestrator rather than pre-building a
  // second marker scheme nobody needs yet.
  test("every declared event was exercised", () => {
    const { events } = coverage();
    expect(declaredEvents().filter((e) => !events.has(e))).toEqual([]);
  });
});
```

The unauthenticated sweep above it is left exactly as it is: it stays global, so a stream's routes
still have to answer 401 without credentials.

- [ ] **Step 6: Run the contract suite and the formatter**

```bash
bun run test:contract
bunx prettier --check test/contract/stream-blocks.ts test/contract/stream-blocks.test.ts test/contract/openapi.test.ts
bun run test
```

Expected: `bun run test:contract` ends with `0 fail` and a pass count six higher than before this
task (the gate's one test became two, and the helper's describe added five); prettier reports
`All matched files use Prettier code style!`; the root suite is green.

- [ ] **Step 7: Commit**

```bash
git add test/contract/stream-blocks.ts test/contract/stream-blocks.test.ts test/contract/openapi.test.ts
git commit -m "test(contract): make the coverage gate stream-block aware

Bun runs contract test files in filesystem order, so the global gate can run
before a stream's own fixtures file. It now polices only paths outside the
marked blocks; each stream gates its own block from its own file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Live-gated smoke test, README seam rules and the PR

**Files:** Create `native/Apps/ShepherdMac/Tests/LiveServerTests.swift` (**or extend it if it
already exists** — Step 1); modify `native/README.md` (new section after `## Signing`, before the
`# ShepherdKit` heading).

**Interfaces:**

- Consumes: `AppModel.addRemoteProfile(name:address:)` / `.activate(_:)` / `.teardown()`, `SessionStore.connection` / `.sessions` / `.settings` / `.lastError`, `InMemoryCredentialStore`, `StoredCredential(token:tokenId:)`, `ServerProfile.credentialKey`.
- Produces: `enum LiveServer { static func value(_ name: String) -> String?; static var baseURL: String?; static var token: String?; static var isConfigured: Bool }`, `struct LiveServerTests`.

- [ ] **Step 1: Check whether a live test already landed on the branch**

```bash
ls native/Apps/ShepherdMac/Tests/ | grep -i live || echo "no live test yet"
```

If `LiveServerTests.swift` already exists (an earlier branch may have added one gated by
`SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD`): **do not create a second file and do not
rename it.** Read it, keep its gate and helpers, add only the
`theSessionListRendersAgainstTheLiveServer` test from Step 3, and — if its gate reads a password —
add a `token` accessor so `SHEPHERD_LIVE_TOKEN` also enables it. Then go to Step 5. If the command
printed `no live test yet`, continue with Step 2.

- [ ] **Step 2: Confirm nothing is configured in this shell**

Run: `env | grep -c SHEPHERD_LIVE || true`
Expected: `0` — so the suite must come out *skipped*, not failed, in Step 4.

This is a **unit test in `ShepherdTests`, not an XCUITest**: XCUITest would have to pass the URL
and token through `XCUIApplication.launchEnvironment`, and the *app* would have to read them and
build a profile at launch — a test-only code path inside the shipping binary. A unit test reaches
the same state (`AppModel.activate` → `SessionStore` → the session list) with no production code
added.

- [ ] **Step 3: Write the live-gated test**

Create `native/Apps/ShepherdMac/Tests/LiveServerTests.swift`:

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// Reads the live-server configuration out of the test process's environment.
enum LiveServer {
    /// `xcodebuild` does not reliably forward the invoking shell's environment
    /// into a hosted unit-test bundle; the documented way in is the
    /// `TEST_RUNNER_` prefix, which the runner strips before the process sees the
    /// variable. Reading both spellings means nobody has to remember which one
    /// this toolchain honours.
    static func value(_ name: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        for candidate in [name, "TEST_RUNNER_\(name)"] {
            if let raw = env[candidate] {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    static var baseURL: String? { value("SHEPHERD_LIVE_BASE_URL") }
    static var token: String? { value("SHEPHERD_LIVE_TOKEN") }
    static var isConfigured: Bool { baseURL != nil && token != nil }
}

/// A smoke check against a REAL Shepherd server, off unless the operator asks for
/// it. Swift Testing SKIPS it unless both variables are set; CI has neither the
/// tailnet nor a token, so it never runs there — and must never be made to. The
/// integration lane runs it locally before each stream merge.
@MainActor
@Suite(
    .enabled(
        if: LiveServer.isConfigured,
        "set SHEPHERD_LIVE_BASE_URL and SHEPHERD_LIVE_TOKEN to run the live smoke test"),
    .serialized)
struct LiveServerTests {
    @Test func theSessionListRendersAgainstTheLiveServer() async throws {
        let address = try #require(LiveServer.baseURL)
        let token = try #require(LiveServer.token)

        // Its own defaults suite and an in-memory credential store: this must not
        // read, write or revoke anything in the operator's real profile list or
        // Keychain.
        let suite = "live-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let credentials = InMemoryCredentialStore()
        let model = AppModel(defaults: defaults, credentials: credentials)

        let profile = try model.addRemoteProfile(name: "live", address: address)
        try credentials.save(
            StoredCredential(token: token, tokenId: "live-smoke"),
            for: profile.credentialKey)

        await model.activate(profile)
        let store = try #require(model.store, "activation produced no store")

        // start() bootstraps on its own task, so poll rather than assume. 30 s: a
        // cold tailnet hop plus a bootstrap is slow, and a flake here would be
        // read as a broken app.
        for _ in 0..<600 where store.connection != .live {
            try await Task.sleep(for: .milliseconds(50))
        }

        #expect(
            store.connection == .live,
            "connection is \(store.connection); lastError \(String(describing: store.lastError))")
        #expect(store.settings != nil, "the bootstrap delivered no settings")
        // "The list renders": every row the sidebar would draw carries the two
        // fields it draws with. A live server may legitimately hold zero sessions,
        // so emptiness is reported, not asserted.
        #expect(store.sessions.allSatisfy { !$0.id.isEmpty && !$0.desig.isEmpty })
        print("live smoke: \(store.sessions.count) session(s) from \(address)")

        // Local teardown only. `teardown()` does NOT revoke — `signOutActive()`
        // is the one that does, and this test must never revoke the operator's
        // token.
        model.teardown()
    }
}
```

- [ ] **Step 4: Run the bundle and confirm the live test is skipped, not run**

Run: `./native/scripts/test-app.sh -only-testing:ShepherdTests`
Expected: `** TEST SUCCEEDED **`, and the log contains `Suite "LiveServerTests" skipped` with the
reason `set SHEPHERD_LIVE_BASE_URL and SHEPHERD_LIVE_TOKEN to run the live smoke test`. If it
*ran*, the environment has those variables set — unset them and re-run.

- [ ] **Step 5: Run it for real against the operator's server, once**

```bash
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL=https://moes-tavern.long-tautara.ts.net:7330/ \
TEST_RUNNER_SHEPHERD_LIVE_TOKEN="$SHEPHERD_LIVE_TOKEN" \
./native/scripts/test-app.sh -only-testing:ShepherdTests/LiveServerTests
```

Expected: `** TEST SUCCEEDED **` and a `live smoke: N session(s) from …` line. If the suite still
comes out *skipped*, retry with the plain `SHEPHERD_LIVE_BASE_URL=… SHEPHERD_LIVE_TOKEN=…` prefix
— `LiveServer.value` accepts either. If the token is not in the shell, ask the orchestrator for
it; **never** revoke or re-mint the operator's moes-tavern token from automation.

- [ ] **Step 6: Document the seams in `native/README.md`**

Insert after the `## Signing` section, immediately before the `# ShepherdKit` heading:

````markdown
## Parallel streams: seams and rules

Milestone 2 is built by several streams running at once in separate worktrees. They stay out of
each other's way by extending the app through seams instead of editing shared files.

| Want to add | Use | Never edit |
| --- | --- | --- |
| A tab in the session detail pane | `DetailTabRegistry.register(_:)` with your own `DetailTab` | `SessionDetailView.swift` |
| A replacement sidebar | `SidebarSlot.content` | `MainWindow.swift` |
| The "Run on this Mac" card body | `WelcomeSlots.localPanel` | `WelcomeView.swift` |
| A quick-action bar | `ActionBarSlot.content` | `MainWindow.swift` |
| A long-lived sub-model | `AppModel.register(MyExtension.self)` with `AppExtension` | `AppModel.swift` |
| A kit route wrapper | your own `ShepherdClient+<Stream>.swift`, over the internal `generated` client | `ShepherdClient.swift` |
| Handling a server event | `store.events()` — match the raw name on `.unknown(name:payload:)` | `ServerEvent.swift`, `EventName` |
| Copy | your stream's own `KEYS_*` array in `native/scripts/gen-strings.ts` | `KEYS_CORE` |
| Routes and schemas | your `# ── stream: <name> ──` block in `contracts/openapi.yaml` | anything outside it |
| Contract fixtures | your own `test/contract/<stream>.test.ts`, gated on `operationsForStream("<stream>")` | the gate in `openapi.test.ts` |

- **One call site.** Everything is wired up from `Sources/App/StreamRegistrations.swift`, owned by
  the integration lane: a merged stream adds exactly one line there. Your own `install(_:)`
  function lives in your own directory.
- **Lifecycle.** An `AppExtension` is built in `AppModel.activate(_:)` right after the
  `SessionStore` exists and torn down right before that store stops, in reverse creation order. It
  may hold its store strongly. Anything that suspends must capture `app.activationGeneration`
  before the first `await` and drop its result once that value has moved on.
- **Tabs.** `order` is the sort key (terminal = 0), ties break on `id`, the built-in `"prompt"` tab
  is `1_000`. Registering `"prompt"` replaces it.
- **Copy.** Add keys to `ui/messages/en.json` *and* `de.json` first, then to your own `KEYS_*`
  array, then run `native/scripts/gen-strings.sh`. A key in two arrays fails the generator.
- **Events.** Consume them through `SessionStore.events()`: one independent `AsyncStream` per call,
  every frame, finished on `stop()`. Match the raw name on `.unknown(name:payload:)` and decode
  `payload` with the generated schema your own contract block declares — the contract stays the only
  type source. **Never add a case to `EventName` or edit `ServerEvent.swift`:** that switch is
  exhaustive and S0-owned, so every stream that touched it would collide with every other.
- **Kit routes.** Wrap generated operations in your own `ShepherdClient+<Stream>.swift`. The
  `generated` property is `internal` for exactly that, and never `public`.
- **Contract fixtures.** The gate in `openapi.test.ts` only polices paths *outside* the markers.
  Your block is yours to cover: end your own `test/contract/<stream>.test.ts` with a gate over
  `operationsForStream("<stream>")`, and exercise every status you declare — 401 included — from
  that same file, because Bun's file order does not guarantee the global sweep ran first.
- **Live smoke.** `ShepherdTests/LiveServerTests` connects to a real server and asserts the session
  list renders. It is skipped unless both variables are set, and never runs in CI:

```
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL=https://your-server.example.ts.net:7330/ \
TEST_RUNNER_SHEPHERD_LIVE_TOKEN=shp_… \
native/scripts/test-app.sh -only-testing:ShepherdTests/LiveServerTests
```

  The plain `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_TOKEN` spelling works too where `xcodebuild`
  forwards the shell environment. The test uses an in-memory credential store and never revokes the
  token.
````

- [ ] **Step 7: Run every gate one last time**

```bash
swift build --package-path native
swift test --package-path native
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh Release
bun run check:strings
bun run test
bun run test:contract
bun run check:contract-swift
./native/scripts/sync-contract.sh --check
bun run lint
bunx prettier --check .
```

Expected: the kit builds and its suite passes, then `** TEST SUCCEEDED **`, `** BUILD SUCCEEDED **`,
`Localizable.xcstrings is up to date (99 keys).`, both Bun suites green, an empty
`check:contract-swift` diff, `sync-contract: up to date`, eslint silent,
`All matched files use Prettier code style!`.

- [ ] **Step 8: Commit, push and open the PR**

```bash
git add native/Apps/ShepherdMac/Tests/LiveServerTests.swift native/README.md
git commit -m "test(mac): live-gated smoke test and the parallel-stream seam rules

LiveServerTests activates a real server and asserts the session list renders. It
is skipped unless SHEPHERD_LIVE_BASE_URL and SHEPHERD_LIVE_TOKEN are set, so CI
never runs it. README documents the seams every stream extends through.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/native-s0-prep
gh pr create --base main --title "feat(mac): seams for the parallel milestone-2 streams" --body "$(cat <<'BODY'
S0-prep: everything streams S1–S6 need so they can be built in parallel without
editing the same lines.

- `DetailTab` + `DetailTabRegistry`; `SessionDetailView` renders registered tabs
  plus the built-in "prompt" tab.
- `SidebarSlot`, `WelcomeSlots.localPanel`, `ActionBarSlot`; `MainWindow` and
  `WelcomeView` consult them and fall back to Gate 2's content.
- `AppExtension` + `AppModel.register`/`extension`, built after the store exists
  and torn down before it stops. `StreamRegistrations` is the one call site the
  integration lane edits per merged stream.
- `gen-strings.ts` manifest split into `KEYS_CORE` plus six empty per-stream
  arrays. The generated catalog is byte-identical.
- Empty `# ── stream: … ──` blocks at the end of `paths:` and
  `components.schemas:`. The derived Swift contract is unchanged.
- `ShepherdClient.generated` is `internal` (never public) so per-stream kit
  wrappers can reach it; a test-target extension makes a regression a build
  failure.
- `SessionStore.events()` — a per-caller event tap — and `.unknown` now carries
  its raw payload, so a stream decodes an event its own contract block declares
  without editing the exhaustive `EventName` switch.
- The contract coverage gate is block-aware: it polices only paths outside the
  markers, and each stream gates its own block from its own fixtures file.
- `ShepherdTests/LiveServerTests`, skipped unless `SHEPHERD_LIVE_BASE_URL` and
  `SHEPHERD_LIVE_TOKEN` are set. Never runs in CI.
- `native/README.md`: "Parallel streams: seams and rules".

No new strings and no new contract routes. The only kit changes are the two
seams above.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Expected: the push succeeds and `gh pr create` prints the PR URL. Report it to the orchestrator —
streams S1–S5 branch from `origin/main` only after it merges.

---

## Self-review

**Spec coverage.** Appendix B item 1 → Task 1; item 2 → Task 2; item 3 → Task 3; item 4 → Task 4;
item 5 → Task 5; items 6 and 7 → Task 7. The three preconditions the S2/S3 planners verified unmet
→ Task 6 A (kit-internal `generated`), B (`SessionStore.events()` tap, `.unknown` payload) and C
(block-aware coverage gate); all three are documented in Task 7's README seam appendix. All three
Swift-forced refinements are stated in the header and again at their call sites.

**Placeholder scan.** Two steps deliberately do not reprint existing code, and both name the exact
lines to move: Task 2 Step 6 (the `switch localStatus` block moves verbatim into
`builtInLocalControls`) and Task 4 Step 3 (the 99 core keys stay put while only the declaration
line is renamed — the only edit that can keep the catalog byte-identical). Everything else shows
the complete file or an exact anchored insertion with its expected output.

**Type consistency.** `DetailTabRegistry.promptTabID` is used by `PromptDetailTab`, the registry
and Task 1's tests; `SidebarSlot.Resolution` is the single resolution type all three slots report
through; `extensionFactories` / `liveExtensions` are declared in Task 3 Step 3 and read only in
Step 5; `makeExtensions(store:)` and `tearDownExtensions()` are declared in Step 5 and called from
the anchors in Step 4; `duplicateKeys` is exported in Task 4 Step 3 and imported in Step 1;
`LiveServer.value` / `.baseURL` / `.token` / `.isConfigured` are declared and used in one file.
In Task 6, `eventTaps` is declared in Part B Step 5 and read only by `SessionStore+EventTap.swift`
in Step 6; `broadcast(_:)` / `finishEventTaps()` are declared in Step 6 and called from the Step 5
anchors; `parseStreamBlocks` / `streamOwnedPaths` / `operationTemplate` are exported in Part C
Step 3 and imported in Steps 1 and 5; `.unknown(name:payload:)` is changed in Step 3 and every one
of its four other call sites is listed in Step 4.

**Known follow-up.** `x-shepherd-events` has no marked blocks, so the event half of the coverage
gate is still global. A stream adding an event under it will hit the same file-order problem Part C
fixed for paths — the plan says so at the gate and this is for the orchestrator to schedule, not
for S0-prep to pre-build.
