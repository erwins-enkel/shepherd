# ShepherdAppCore — Stage 1 design for #2431

Date: 2026-09-21  
Classification: **architectural**  
Status: **Stage 1 implementation Tasks 1–4 approved; Task 5 documentation reconciliation in progress; aggregate acceptance remains unmet**  
Repository inspected: `83e8d451` (`feat(tokens): read scope sees in-flight review runs (#2423)`).

## Agreed intent and review boundary

Extract the existing platform-neutral application layer into `ShepherdAppCore`, so the Mac app and a future iOS app can use the same state, rules, lifecycle, extension seams and localized copy. Stage 1 is one extraction PR. It must preserve Mac behavior and every existing test, including tests relocated out of the application bundle. The operator has already selected staged extraction (option 3); that decision is not reopened here.

“No rewrites” means preserve algorithms, state transitions, requests, persistence keys, timing, error handling and presentation. Use `git mv` for whole-file moves. Mixed files require declaration-level splits, explicit public access, imports, and narrow platform adapters. Those extraction-required changes are specified below; they are not permission to redesign the application.

The original specification run performed repository exploration and documentation only. Subsequent approved implementation Tasks 1–4 are complete and independently reviewed through source commit `1f4259884c87fa60cbfe063c189e1b80958934f7`; the evidence status below distinguishes those results from the still-unrun hosted CI and blocked live gate. No push, PR, merge, Stage 2 iOS skeleton, or Stage 3 view extraction has occurred.

The [brainstorming skill](/Users/kai.osthoff/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.1/skills/brainstorming/SKILL.md)'s architectural gate says: “written-spec approval only permits invoking writing-plans.” The operator reviewed this document and replied “go”, explicitly approving both recommended existing-ShepherdKit exceptions. The plan was subsequently approved and Tasks 1–4 were implemented and reviewed. Planning artifacts remain part of the Task 5 documentation reconciliation.

## Alternatives and selected scope

| Approach                                                                           | Consequence                                                                                            | Decision                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Copy the application models into an iOS app                                        | Fast initial scaffold, two implementations of activation, event reconciliation and rules immediately   | Rejected; defeats shared feature development |
| Extract state and all reusable views together                                      | Larger review surface; platform modifier and navigation changes obscure behavioral extraction failures | Deferred to later stages                     |
| Extract models, rules, seams and localization first; then iOS skeleton; then views | Establishes the module boundary while keeping current Mac presentation and integration tests           | **Approved option 3**                        |

The issue's final definition of done spans all stages. iOS sign-in/session-list UI and shared sidebar/plan views are not Stage 1 acceptance requirements. Building **and running core unit tests** on an iOS simulator is required in Stage 1, even though the issue mentions a new iOS app CI job under Stage 2.

## Verified repository facts

- `native/Package.swift` is named `ShepherdKit`, tools version 6.1, Swift language mode 6, platforms macOS 15 and iOS 18. It currently exposes only `ShepherdKit` and has `ShepherdKitTests`.
- `native/Apps/ShepherdMac/project.yml` names the project `Shepherd`, app module/target `Shepherd`, scheme `Shepherd`, unit target `ShepherdTests`, UI target `ShepherdUITests`. Its deployment floor and Info.plist are macOS 15.0. It enables complete strict concurrency and the `ExistentialAny` upcoming feature. The local package key must remain `ShepherdKit`; product names are separate from package identity.
- SwiftTerm 1.20.0 is an exact, app-only dependency. Existing CI requires Swift 6.2+ because `TerminalHostView` uses an isolated delegate conformance. No dependency or deployment-floor upgrade is needed.
- The issue's `HerdModel` is actually `HerdSignals`, with `HerdBindings` in `HerdStream.swift`. `ComposeModel` is presentation-owned, not an `AppExtension`. `SettingsReadyModel` is an extension even though it is not observable. Extraction must follow actual ownership, not a list of names ending in `Model`.
- `NotificationsModel.swift` imports AppKit, samples `NSApp?.isActive`, observes Mac activation notifications, reads `LaunchEnvironment`, and constructs its center/settings dependencies. Moving it unchanged would violate the boundary.
- `LocalServerModel` imports Foundation but depends on `LocalServerEnvironment`, `LocalServerSupervisor`, `InstallerRun`, and `LogRing`. Those ShepherdKit declarations are guarded by `#if os(macOS)`. Import scans alone cannot detect this dependency.
- `resetStreamSeams()` currently lives in **`native/Apps/ShepherdMac/Tests/StreamSeams.swift`**, not app production sources.
- At the approval baseline, `L.t()` used the default bundle and `gen-strings.ts` wrote only `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`; all per-stream manifests and EN-first placeholder numbering already existed.
- Static census: **98 Mac unit/support Swift files, 1,090 `@Test` declarations; 4 UI/support files, 13 XCTest test methods; 42 ShepherdKit test/support files, 416 `@Test` declarations**. These are source counts, not executed-case counts or proof of passing tests. Parameterization, conditional compilation and live/Keychain skips affect runtime totals.

## Target and dependency boundary

Add a library product/target `ShepherdAppCore` and test target `ShepherdAppCoreTests` within the existing package:

```text
Shepherd Mac app ───────► ShepherdAppCore ───────► ShepherdKit
       │                       │
       ├──► SwiftTerm          └── Foundation / Observation / SwiftUI / os
       └──► Mac adapters (AppKit, UserNotifications, local-server process host)

Future iOS app ─────────► ShepherdAppCore          [later stage]
```

Core sources live under `native/Sources/ShepherdAppCore/`, preserving stream directories. Core tests live under `native/Tests/ShepherdAppCoreTests/`. Keep package identity, existing ShepherdKit sources/product, existing dependencies and platform floors. Add `defaultLocalization: "en"` for package resources. The Mac app explicitly depends on the new product and imports it at usage sites; retained tests also receive an explicit package-product dependency for `@testable import ShepherdAppCore`.

Core may use SwiftUI types in existing contracts (`AnyView`, `Color`, `EventModifiers`), but must not import AppKit/UIKit, SwiftTerm, the app module, or use Mac-only symbols through transitive imports. The new guard scans core production Swift sources, including conditional imports and scoped import forms. The simulator build is the semantic gate for unavailable symbols hidden behind innocuous Foundation/SwiftUI imports. Do not use `#if os(macOS)` to hide a Mac implementation inside core.

No new networking layer, container framework, plugin discovery, state-store abstraction, second event socket, hand-written server payload, or fork of ShepherdKit is introduced. Server schemas, routes and OpenEnum conformances remain contract-first in ShepherdKit. Existing Mac-only portions of ShepherdKit remain guarded and unchanged.

### Swift public API strategy

Existing types are mostly internal. Export only declarations needed by retained app code or external protocol conformers:

- `AppModel`, `AppExtension`, shared model/state types, their actual app-facing initializers, actions, values, bindings, and `register`/typed `extension` access.
- Registry protocols, registry operations, slot closures, descriptor types and their initializers, `L.t`, and the narrow host adapter/configuration contracts described below.
- Make protocol witnesses public where their conforming type is public. Explicitly provide public initializers where the app previously relied on internal synthesized memberwise/default initializers. Expose nested enums/value types required by public signatures, including generated ShepherdKit types without wrapping/redeclaring them.
- Preserve `private(set)` on externally read-only state; do not turn caches, task handles, generations or `liveExtensions` into writable public API. Keep existing test injection points internal and reach them with `@testable import ShepherdAppCore`, including in mixed Mac integration tests.
- Preserve `@MainActor`, `@Sendable`, `nonisolated` constants, `@Observable` and `@ObservationIgnored`. Public access is not permission to weaken actor isolation. Keep classes final; no `open`, blanket public conversion, underscored re-export, or app dependency hidden behind `@testable` in production.
- Public default argument expressions cannot reference inaccessible internal helpers. Use an explicit initializer body/overload where needed, without changing the default behavior.

`Bundle.main` in `AppModel.appVersion` intentionally means the consuming application's version and stays that way. Only localized copy changes to the module bundle. Keep the existing `run.shepherd.mac` profile/defaults/credential-key and logging names: renaming them would change persisted identity. Future iOS policy is outside this extraction.

## Inventory: moves, splits, and retained platform files

Paths in this section are relative to `native/Apps/ShepherdMac/Sources/` unless qualified. A split moves the named non-view declarations and their dependencies unchanged in behavior; the remaining views retain their source location. **Every view body remains in the Mac target in Stage 1**, including AppKit-free bodies.

### Whole-file core moves

| Area                            | Files/declarations moving to core                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App state and utilities         | `App/AppModel.swift` (including `AppSheet`, `RemoteServerForm`, `ConnectionSource`, `ProbeGate`), `AppModel+Extensions.swift`, `ProfileStore.swift`, `SessionSignals.swift`, `ShepherdErrorCopy.swift`, `Log.swift`, `L.swift` |
| Simple seams                    | `App/SidebarSlot.swift`, `WelcomeSlots.swift`, `ActionBarSlot.swift`, `NewSessionSlot.swift` including `NewSessionExtras`                                                                                                      |
| Sidebar                         | `Sidebar/SidebarModel.swift`, `HerdPartition.swift`, `SidebarCopy.swift`                                                                                                                                                       |
| Detail                          | `Detail/DetailModel.swift` including `Loaded` and `DetailFeed`, `UnifiedPatch.swift`, `DiffAnnotationLayout.swift`                                                                                                             |
| Actions                         | `Actions/ActionsModel.swift`, `ActionRules.swift`, `ActionErrorCopy.swift`                                                                                                                                                     |
| Herd                            | `Herd/HerdSignals.swift`, `HerdClassifier.swift`, `HerdStream.swift` including its private activation-scoped `HerdBindings`                                                                                                    |
| Plan                            | `Plan/PlanModel.swift`, `PlanGateChip.swift` (a value/rules type, despite its name)                                                                                                                                            |
| Queues                          | `Queues/QueuesModel.swift` and its reads/state types                                                                                                                                                                           |
| Composer                        | `Compose/ComposeModel.swift`, `ComposeSubmission.swift`, `RepoBranchModel.swift`, `ShapeRoundModel.swift`, `AttachmentModel.swift`, `IssueFilter.swift`                                                                        |
| Merge                           | `Merge/MergeModel.swift`, `MergeRules.swift`, `MergeConfirmationRules.swift`, `MergeOverviewCopy.swift`                                                                                                                        |
| Settings                        | `Settings/SettingsModel.swift`, `SettingsTokensModel.swift`, `SettingsReadyModel.swift` including `SettingsNotificationBridge`, `SettingsReadyRules`, `SettingsReadyState`; `SettingsDiagnosticCopy.swift`                     |
| Notification policy             | `Notifications/NotificationSettings.swift`, `NotificationCopy.swift`, `NotificationGate.swift`, `NotificationTrigger.swift`, neutral `NotificationsStream.swift` after dependency injection                                    |
| Terminal state, not terminal UI | `Terminal/TerminalController.swift`, `TerminalSessionModel.swift`, `PTYAttaching.swift` including `PTYCommandQueue`/`LivePTYAttachment`, `ConnectingOverlayDebouncer.swift`                                                    |
| Shared presentation values      | `Main/SessionStatusStyle.swift`; `Main/PreviewData.swift` remains DEBUG-only, moved with the model fixtures it supplies to both tests and Mac previews                                                                         |

Terminal state owns attachment sequencing/output callbacks and depends on ShepherdKit, not SwiftTerm. Moving it does not provide an iOS terminal view, keyboard or touch input. `AttachmentModel` keeps its existing bounded reads and security-scoped URL lifetime; the Mac file importer/paste UI does not move.

### Mandatory declaration-level splits

| Current file(s)                                                                                 | Core part                                                                                                                                                             | Mac part                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `App/DetailTabs.swift`                                                                          | `DetailTab`, registry, layout/order rules and prompt descriptor metadata                                                                                              | `PromptTabView`; injected prompt rendering closure                                                |
| `App/CommandRegistry.swift`                                                                     | `MenuCommand`, `Shortcut`, `CommandRegistry`                                                                                                                          | `MenuCommandItems`, `OptionalShortcut`, scene menu rendering                                      |
| `App/SettingsScene.swift`                                                                       | `SettingsPane`, `SettingsPaneRegistry`                                                                                                                                | `SettingsSceneView`                                                                               |
| `App/StreamRegistrations.swift`, `Wave2Seams.swift`                                             | `Installation`, fixed ordered model wiring and neutral signal connections                                                                                             | Concrete scene/tab/panel/slot rendering hooks; `IntegratedOwedPanel`                              |
| `Notifications/NotificationsModel.swift`                                                        | Observable state, trigger/gate, event tap, presence, authorization/badge generations, delivery and teardown                                                           | Launch-mode choice, actual notification-center construction and Mac focus observation/sample      |
| `Notifications/NotificationCenterClient.swift`                                                  | `NotificationRequest`, `NotificationAuthorization`, `NotificationCenterClient`, `FakeNotificationCenter`                                                              | `SystemNotificationCenter` and `ResponseDelegate`                                                 |
| `Main/MainWindow.swift`                                                                         | `SessionCommandState`, `NoticeTone`                                                                                                                                   | `MainWindow`, `NoticeBar`, toolbar and `openComposer` UI entry point                              |
| `Main/NewSessionSheet.swift`, `Welcome/FirstRunSheet.swift`, `Welcome/LoginSheet.swift`         | `NewSessionSubmission`, `ProviderSelection`, `FirstRunSubmission`, `LoginSheetState`                                                                                  | Sheets; `FolderPicking`/`SystemFolderPicker` remain with Mac folder selection                     |
| `Main/ConnectionBanner.swift`                                                                   | `BannerKind`, `SemanticVersion`, `AppVersion`, `BannerPolicy`                                                                                                         | `ConnectionBanner`                                                                                |
| `Actions/ActionBarView.swift`, `RenameSheet.swift`, `AmendSheet.swift`                          | `RecapLine`, `ActionNote`, `ActionBarOutcome`, `RenameSubmission`, `AmendSubmission`; pure current-selection predicate                                                | Views, shortcuts, sheets; optional thin forwarding method for old test/call-site spelling         |
| `Detail/DetailFeature.swift`, `FilesTabView.swift`, `GitTabView.swift`                          | Model registration portion, `DetailTaskKey`, `DetailStatePhase`, `FilesBreadcrumb`, `GitPanelRules`                                                                   | Tab conformers/factories, refresh/state containers and tab views                                  |
| `Header/UsageMeter.swift`                                                                       | `UsageBar`, `UsageMeter` rules/copy                                                                                                                                   | `UsageMeterView`                                                                                  |
| `Sidebar/SessionBadges.swift`, `Herd/HerdStepper.swift`, `Herd/HerdRowGit.swift`                | Badge descriptors/rules, `HerdStepperSegment`, `HerdStepper`, `HerdHeartbeat`                                                                                         | Badge stack, stepper, git rail and heartbeat views                                                |
| `Plan/PlanStream.swift`, `PlanTabView.swift`, `QuestionFormView.swift`                          | `PlanSignals`, neutral registration/signals; `PlanTabWriter`, `PlanTabActions`, `PlanEnvironment`; `QuestionAnswerContext`, `QuestionFormWriter`, `QuestionFormModel` | `PlanDetailTab`, plan tab and question views                                                      |
| `Plan/VisualBlocksView.swift`                                                                   | `VisualFileTree` value helper                                                                                                                                         | All visual-block/markdown rendering                                                               |
| `Queues/QueuesStream.swift`                                                                     | `QueuesPanels` and model registration                                                                                                                                 | Factories for `UpNextView`, `DonePanelView`, `OwedPanelView`                                      |
| `Queues/UpNextView.swift`                                                                       | `UpNextSort`, `UpNextGroup`, `UpNextPresentation`, `UpNextNotice`, `UpNextCommands`, `UpNextPanelState`                                                               | `UpNextView`                                                                                      |
| `Queues/HeldQueueView.swift`, `QueueActions.swift`                                              | Held presentation/confirmation/action/commands; queue presentation/confirmation/selection/action/commands and `QueueActionState`                                      | Queue controls, rows, sheets, notices, fallback owed view                                         |
| `Queues/DonePanelView.swift`, `DoneRecapView.swift`                                             | `DoneReads`, `DonePanelState`, `DonePresentation`, `DoneUsageState`, `DoneRestoreConfirmation`, `DoneMarkdown`                                                        | Done panel/chips and recap view                                                                   |
| `Compose/ComposeActions.swift`, `ComposeFooter.swift`, `CapacityLine.swift`                     | `ComposeActions`, `ComposeReadiness`, `ComposeCapacity`                                                                                                               | `ComposeSessionActions`, footer/capacity views                                                    |
| `Compose/ModelPicker.swift`, `ModelGuidance.swift`, `ModeTabs.swift`, `ComposeKeymap.swift`     | `ComposeRunConfig`, `ModelGuidance`, `ComposeMode`, `ComposeKeymap`                                                                                                   | Pickers, guidance, tabs/guards, environment keys, keycap/card views                               |
| `Compose/SourceToggle.swift`                                                                    | Nested `Source` value becomes a core `ComposeSource` enum with identical cases/conformances                                                                           | `SourceToggle`; a typealias can preserve its old nested spelling for Mac call sites               |
| `Merge/MergeOwedView.swift`, `MergePanels.swift`                                                | `MergeOwedActions`, `MergeOwedState`, `MergeInputs`                                                                                                                   | Owed/queue/overview/step-editor views                                                             |
| `Settings/SettingsFields.swift`, `SettingsRepoFields.swift`                                     | `SettingsField`, `SettingsFields`, `SettingsFieldDraft`, `SettingsRepoTextDraft`                                                                                      | Form rows and views                                                                               |
| `Settings/SettingsAppearance.swift`, `SettingsAccessView.swift`, `SettingsCommandPalette.swift` | `SettingsPresentation` (same singleton/lifetime), `SettingsTokenCopy`, `SettingsCommandSearch`                                                                        | Appearance/access/palette views, environment keys, status-shape/root modifiers and `openSettings` |
| Existing per-stream installers                                                                  | Pure registration/signal statements delegated into core at their original positions                                                                                   | Concrete tabs/slots/view composition, local-server installer and settings scene contributions     |

`QuestionFormWriter.live` currently calls `ActionBarView.isCurrent`. Extract that exact predicate into a shared non-view helper and call it from both sides. Do not simplify its selection/store/session checks. Similarly, `ComposeModel` currently names `SourceToggle.Source`: lifting the enum is required to break a reverse dependency, not a feature rename. These are concrete examples of why literal whole-file moves alone cannot satisfy the issue.

### Explicitly retained Mac files and responsibilities

- `App/ShepherdApp.swift`, `LaunchEnvironment.swift`/`IsolatedLaunch`, `LocalServerProbe.swift`; app lifecycle, windows, menus, settings scene, isolated launch/termination and live seed remain Mac-owned.
- `LocalServer/LocalServerModel.swift`, `LocalServerFeature.swift`, `LocalServerPanel.swift`, including `LocalServerSessionExtension`, `LocalServerCopy`, `LocalServerPanelState`. This is the explicit exception to “all observable models”: it models a **Mac-hosted child process**, not cross-platform application state. No fake iOS supervisor or conditional local-server core is added.
- `Terminal/TerminalHostView.swift`, `TerminalPane.swift`, `TerminalTab.swift` and rendering portion of `TerminalInstall`; SwiftTerm stays in `project.yml` only.
- All remaining `View`/`ViewModifier` declarations, including `Header/*` view bodies, welcome/session/sidebar screens, composer attachment importer and clipboard action, platform keyboard/focus interactions, and all feature panels. Being AppKit-free does not move a view ahead of Stage 3.
- Mac notification/focus adapters, folder picker, app `Info.plist`, entitlements, generated Xcode project, signing/build scripts and bundle metadata. The app resource catalog is removed from Mac resource membership after its move; no stale duplicate catalog remains.

## View-bearing registries without moving Mac views

Keep the existing type-erased contracts. A Mac `DetailTab` or `SettingsPane` conformer implements the public core protocol and returns an `AnyView` of its Mac view. Slot/panel closures are created in the app and stored by core. Core never imports or names their concrete view types. Preserve lazy construction, environment injection, render-time localized titles, IDs, sort order, last-registration-wins behavior, fallback resolution and accessibility identifiers.

The built-in prompt is a special case: today `DetailTabRegistry.tabs` constructs `PromptDetailTab`, whose method directly builds `PromptTabView`. Keep its descriptor metadata in core (`prompt`, order 1,000, title/system image) and supply its renderer through the host configuration before scene construction. Core delegates `makeView` to that required main-actor factory; Mac supplies the unchanged `PromptTabView`. Do not substitute `EmptyView`, remove the fallback, or move this view to core. Missing host configuration is a programming error with a clear precondition at rendering, not a silent UI fallback. Registry metadata can still be queried without rendering.

The renderer is host configuration, not a registered stream override: resetting stream registrations restores the built-in prompt descriptor and continues to use the host's prompt renderer. Core tests install a deterministic renderer where rendering is exercised; Mac rendering tests exercise the actual prompt body. This new configuration requirement must be documented and tested at Mac launch, previews, direct installer tests, and after reset.

## Installation, reset and lifecycle

Retain `StreamRegistrations.Installation`'s existing synchronous two-pass behavior in core. Core owns the explicit ordered sequence, while the Mac host supplies named, main-actor callbacks for presentation and the local-server slot. Extract callbacks at existing statement boundaries; do not group all model creation first and all view registration afterwards. This is a narrow split of the current composition root, not a new extensible ordering system: no priorities, dependency graph or dynamically discovered plugins.

Configure the host once in `ShepherdApp.init()` **before** `installScene()` and any `Scene` body read. Tests/previews use explicit fixture/Mac configuration. Required hooks have no silently empty production defaults. Process-lived presentation hooks capture no AppModel or SessionStore; they use the model/store passed at invocation. Keep production host configuration stable across stream resets; test renderer configuration is likewise deterministic per test process, with the existing independent `Installation(scene:model:)` instances used for lifecycle probes. Keep the public direct stream installer entry points as thin compositions where existing tests/previews need them; both direct and full installation use the same extracted model statements, without double registration or changed ordering.

### Order that must survive

| Pass                           | Existing sequence to preserve                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene, once per installation   | Queues panel factories → Merge scene command → Wave2 integrated owed-panel override → Settings panes/commands                                                                                             |
| Model, repeatable per AppModel | Terminal → Detail → Sidebar → Actions → LocalServer → Notifications → `SessionSignals.connect` → Plan → Herd → Queues → Compose → Merge → `Wave2Seams.connect` → Settings → Settings notification bridges |

Within that sequence, preserve the current statements' order too: terminal tab registration precedes `TerminalController` registration; detail/sidebar/actions installers retain their original model/slot order; Plan establishes reviewing/unanswered-question closures before Herd consumes them. Herd registers `HerdSignals`, then `HerdBindings`. Settings registers `SettingsModel`, then `SettingsReadyModel`. Compose contributes presentation-owned state through views; do not invent an application extension for it.

Queues' repeatable model installer re-registers its fallback panels. Wave2 must therefore reinstall `IntegratedOwedPanel` after Queues, on every model pass, as it does today. Herd replaces `SessionSignals`' sparse Detail git answer with its complete cache. Compose wraps the ActionBar predecessor before Merge wraps the complete action bar and sidebar. Preserve weak composition ownership and release-on-slot-reset; no process-wide “already composed” boolean.

Move `resetStreamSeams()` into core as an explicitly test/preview-oriented main-actor API, callable by both test targets. It resets the scene guard, Settings notification bridges, `SettingsPresentation.shared`, `QueuesPanels`, `MergeInputs` (including conservative true defaults), `PlanSignals`, all detail/sidebar/welcome/action/new-session registries, `SessionSignals`, commands and settings panes. It does not change immutable host configuration or production lifecycle. Slot release must still release Mac composition owners. Keep `ComposeStream.resetActionsForTesting()` where direct Mac composition tests require it; it must not become a core dependency. Test reset followed by scene installation and repeated full passes against real Mac hooks.

### Ownership and concurrency invariants

- `AppModel` remains the application-lifetime owner. Extension factories are keyed by type, ordered by registration, and idempotent. Registering against an already-live store constructs immediately and reconciles its current state.
- On activation/teardown, keep generation increments and extension cancellation **before** the outgoing store stops. Build fresh instances for the incoming store. Tear extensions down in reverse creation order, once per instance.
- Process-lived signals capture the app weakly and look up the current extension per invocation; they must not retain an outgoing profile/model. Keep the `HerdBindings` per-activation observer and teardown.
- Preserve independent event taps, reconnect refreshes, snapshot/push race guards, coalescing, task cancellation and continuation finishing. Do not turn main-actor tasks into detached work or move asynchronous work into registry reads.
- Keep model-specific reconciliation intact: Detail diff polling stays at 15 seconds; Queues preserves independently successful snapshots and its push revisions, and a successful Up Next POST is not treated as a snapshot; Merge preserves its revision-driven re-read and serial writes; RepoBranch keeps selection/request generations, debounce and the live-smoke status-probe prohibition.
- Presentation-owned state remains presentation-owned: composer submission/upload/shaping, question confirmation, plan actions, queue panels, merge-owed state and settings drafts retain their existing view-driven teardown/current-selection guards.
- Preserve full Swift 6 checking and mirror `ExistentialAny` for the extracted target. No new `@unchecked Sendable`, `nonisolated(unsafe)` or concurrency-suppressing annotation. Preserve documented test URLProtocol stubs only where still needed. Existing ShepherdKit annotations identified below are approved unchanged exceptions, not permission to add more.

## Notification adapter split

Move policy and state, not Mac activation APIs. Introduce only the dependencies already hard-coded by `NotificationsModel.init(store:app:)`: a notification center factory, notification-settings defaults factory, and synchronous focus sampling/observation with synchronous cancellation. Keep these in a small main-actor configuration carried by `AppModel`; app construction explicitly supplies it before any extension can be built. Retain `AppExtension.init(store:app:)`, which reads that configuration. Tests supply fake centers/focus plus throwaway defaults; there is no implicit system-center default in core.

The Mac factory retains `LaunchEnvironment.configuration().isIsolated` behavior: normal launches get `SystemNotificationCenter` and the existing persistent settings domain; isolated launches get the fake and the existing isolated settings policy. Do not quietly change the current isolated-defaults fallback or persistence policy while extracting it. `IsolatedLaunch.makeModel()` and normal app creation both supply the correct configuration.

The focus adapter owns Mac notification names and observers, samples `NSApp?.isActive`, and forwards events on the main actor. Core retains the current ordering: center click handler → `start()` → store subscription → focus observation → synchronous initial focus sample → authorization task and current-generation presence/badge update. Preserve existing callback/task sequencing; do not add an await before the sample, cancel the preceding rapid focus transition, or replay a stale captured focus after authorization. Retain authorization/badge generations, badge desired-state deduplication, cooldown/latch semantics and reduced-push policy.

Teardown retains the existing order: cancel owned tasks, synchronously remove observation, detach click selection, drop store/source references, then call `clearBadgeNow()` before the next activation's badge work. Its guarantee remains submission order, not a newly claimed OS-level FIFO guarantee. No iOS notification delivery, badge implementation, scene-phase reinterpretation or cold-launch behavior fix is part of Stage 1.

## Localization and generator strategy

`L` and both existing overloads become public in core. Lookup explicitly uses `Bundle.module`; formatting continues to use `String(format:locale:arguments:)` with `.current`. `Bundle.module` remains an implementation detail, not a public app bundle accessor. Package-owned lookup follows Apple's [package localization guidance](https://developer.apple.com/documentation/xcode/localizing-package-resources) and [resource bundle guidance](https://developer.apple.com/documentation/xcode/bundling-resources-with-a-swift-package).

Use the existing generator as the only source of derived files, with outputs under `native/Sources/ShepherdAppCore/Resources/`:

- `Catalog/Localizable.xcstrings`, preserving the existing catalog structure, comments, sorted keys and EN/DE values.
- `en.lproj/Localizable.strings` and `de.lproj/Localizable.strings`, generated from the same converted entries for runtime consumption by both command-line SwiftPM and Xcode.

This small generator extension avoids assuming that copying an xcstrings source catalog makes command-line localization work. The implemented package explicitly uses `.copy("Resources/Catalog")` for source data (also available to catalog validation tests) and **processes** the two localized strings resources, with `defaultLocalization: "en"`. Copying `Resources/Localizable.xcstrings` directly is not used: Xcode 26.6 compiled the individually copied catalog and duplicated the generated runtime `.strings` outputs. The directory copy is the accepted, tested toolchain deviation. Do not process the catalog into a second competing `Localizable.strings` output. Apple's [`Resource.copy` contract](https://developer.apple.com/documentation/packagedescription/resource/copy%28_%3A%29) provides the distinction; successful builds and runtime lookup tests verify the final bundle on both toolchains.

No new generator dependency/plugin or runtime JSON localization parser. Extend `gen-strings.ts` write/`--check` to cover all three outputs atomically in meaning: any missing/stale file fails, and the directory is created for a fresh checkout. Preserve manifest uniqueness, key ownership, EN-first `%N$@` numbering, DE reordering, literal-percent behavior and StaticString call sites. Escape `.strings` quotes, backslashes and control characters with generator tests. Both formats must derive from one conversion result, not two translation implementations.

Move catalog/placeholder and the pure catalog/lookup cases in all per-stream string tests with `L`; split any retained-view assertions into the Mac target. Replace repository-relative catalog paths in `StringCatalogTests` and `PlaceholderRenderingTests` with the copied module resource, accessible through an internal core accessor for tests. Simulator tests must not depend on the checkout path embedded in `#filePath`. Assert EN and DE lookup, representative argument reordering/percent handling, and complete key resolution in built bundles; retain an app-host assertion that Mac views see translated copy through core. No replacement of missing translations with English literals to make tests pass.

Update `native/scripts/gen-strings.sh` descriptions, generator tests and `native/docs/development.md` localization/seams/layout guidance. Existing regeneration remains `bun run gen:contract-swift`, `native/scripts/sync-contract.sh`, `bun run native/scripts/gen-strings.ts`; extraction should cause no contract/schema semantic diff.

## Test migration and conservation accounting

Preserve every existing test's scenario/assertions. Change imports, fixture/resource paths and adapter setup where required. Split mixed suites by responsibility rather than dropping a platform-incompatible assertion or wrapping an entire shared suite in `#if os(macOS)`.

| Destination                               | Existing coverage                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core unit target, macOS and iOS simulator | App/profile/form/submission/banner policy; extension lifecycle; Sidebar, Herd, Detail, Actions, Plan, Queues, Compose, Merge, Settings models and extracted state/rules; terminal state; notification fake/gate/trigger/copy/settings/badge races; registry ordering/reset contracts with test view factories; catalogs/formatting |
| Mac unit target                           | LocalServer model/panel/probe; LaunchEnvironment/isolation; actual folder picker/sheet injection; Mac view rendering and modifiers; real tab/slot/command/pane composition; Mac notification focus/adapter wiring; full production stream installation                                                                             |
| Split with explicit old-test mapping      | `StreamRegistrationsTests`, `SettingsIntegrationTests`, `SettingsFinalTests`, `SettingsRegistrationTests`, `SettingsSceneTests`, `DetailFeatureTests`, `SidebarInstallTests`, `MergeRegistrationTests`, `FolderPickerTests`, and any suite mixing retained views with extracted models                                             |
| Mac live/host harness                     | Existing `*LiveTests` and `LiveServerTests` remain opt-in/read-only with their Mac host setup; do not accidentally turn these into simulator CI network tests. Pure unit tests inside a live-named file still follow their dependency, and none are lost.                                                                          |
| Unchanged                                 | All ShepherdKit tests; all 13 Mac UI methods and their shared isolated harness                                                                                                                                                                                                                                                     |

Move shared fixtures/helpers with their consumers, including latches and fake readers currently declared in another test file. Preserve DEBUG-only `PreviewData` for both previews and tests. Do not make production internals public just to let a retained test mutate them. Mac tests can import both modules with `@testable`; core tests cannot import Shepherd. Fake notifications remain available to the isolated app as well as tests, so they are not relocated exclusively into a test bundle.

Global registries make async test interleaving significant. Existing `.serialized` suite annotations must survive, but independently serialized suites are not a process-wide lock. Run core Swift Testing gates with `--no-parallel`; turn off Xcode parallel testing and ensure all global-seam tests within a runner share a serialized enclosing suite or equivalent suite-level organization. No cross-test reset during another test's suspension. Preserve existing behavior tests when changing suite organization.

Before any future relocation, record suite/test identities and parameterized runtime results from the unchanged base. Maintain a reviewable old identity → destination identity mapping for all **1,090** declarations; identify any one-to-many file/suite split without double-counting the scenario. At completion:

```text
existing Mac-unit scenarios retained + existing scenarios moved to core = 1,090 declarations
existing ShepherdKit declarations retained = 416
existing Mac UI test methods retained = 13
new extraction-specific tests = separately reported, never compensation for a removed old test
```

For runtime reports, compare pass/skip/failure/parameterized-case totals using identical environment settings and report changed identifiers. Do not insist on 1,090 executions remaining in the app bundle after moves, or claim that a raw source count is the runtime total. Live tests skipped without credentials must be explicitly distinguished from the required live-smoke run. Core's shared cases run on both platforms; Mac-only cases must remain exercised on Mac. Record results once; reviews reuse those reports unless changed code invalidates them.

Additional extraction coverage is narrow: public-API consumption from the Mac target; forbidden imports; package resources on both platforms; notification adapter ordering/teardown; production and fixture install/reset paths; source/destination test accounting. Preserve wave-1/2 integration tests for stale activation rejection, bootstrap gate conservatism, repeated installation, composition and bridge resolution.

## Required validation gates for the future implementation

**No gate was run while writing this specification.** These commands define acceptance, not a claim of validation or a task-by-task implementation plan. Use a foreground Bash shell with `set -euo pipefail`; filtered output must preserve command failure. Never use bare `bun test`.

### Serialized xcodebuild wrapper

Every local `xcodebuild`, including package simulator builds, app scripts that call it, unit tests, UI tests and scheme/device queries, runs through the existing wrapper:

```bash
UITEST_LOCK=/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/uitest-lock.sh
```

Its actual interface is `uitest-lock.sh <command...>`; it serializes via `/private/tmp/claude-501/shepherd-uitest.lock`, waits up to 45 minutes and reaps only a dead holder or an old pid-less lock. Ensure its parent directory exists before a future invocation. Wrap the **whole** `test-app.sh`/`build-app.sh` invocation, not a second nested lock inside it. One foreground gate at a time; no background runners, parallel worktrees or testmanagerd killing. Read at most filtered errors/results or the last 40 lines of output.

### Gate set

From repository root unless a working directory is shown:

```bash
bun run gen:contract-swift
native/scripts/sync-contract.sh
bun run native/scripts/gen-strings.ts
bun run check:contract-swift
native/scripts/sync-contract.sh --check
bun run check:strings
bun run typecheck
bun run lint
bun run test:contract
bun run test
swift build --package-path native
swift test --package-path native --no-parallel
```

Filter build/test/Bun output while retaining exit status, for example `2>&1 | tail -n 40` under `pipefail`. `bun run test:contract` covers `test/contract/native-open-enum.test.ts` and `native-ui-isolation.test.ts`; the full root script covers `test/native-gen-strings.test.ts`. The duplicate-OpenEnum guard already scans both `native/Sources` and `native/Apps`, so preserve it rather than inventing a narrower replacement. Add the core forbidden-import source guard to this enforced root test set. Keep existing repository formatting/other required CI checks green; check the new documentation with the repository Prettier convention.

The mandatory simulator build from `native/` is:

```bash
"$UITEST_LOCK" xcodebuild -scheme ShepherdAppCore \
  -destination 'generic/platform=iOS Simulator' \
  -skipPackagePluginValidation build 2>&1 | tail -n 40
```

It must resolve the actual shared package scheme; confirm discovery through the same wrapper. If the generated product scheme omits `ShepherdAppCoreTests`, commit the minimal shared package test scheme needed to include that target. Do not create an iOS app just to make the gate work.

The simulator **test** gate also runs from `native/`:

```bash
"$UITEST_LOCK" xcodebuild -scheme ShepherdAppCore \
  -destination "platform=iOS Simulator,id=$CORE_SIMULATOR_UDID" \
  -parallel-testing-enabled NO -only-testing:ShepherdAppCoreTests \
  -skipPackagePluginValidation test 2>&1 | tail -n 40
```

`CORE_SIMULATOR_UDID` is a gate input resolved from `xcrun simctl list devices available -j`: select an available iPhone on an installed iOS runtime at least 18.0, deterministically by runtime version then name/UDID. Fail clearly if none exists. Do not use the generic destination for tests, silently skip, or hard-code an unverified hosted-runner phone name. The job must report its selected runtime and actual executed core-test count. Restricting this run to core deliberately avoids executing ShepherdKit's CI-Keychain sentinel on a simulator; ShepherdKit is still built as a dependency and fully tested in its existing Mac lane.

From repository root, sequentially:

```bash
"$UITEST_LOCK" native/scripts/build-app.sh Release 2>&1 | tail -n 40
"$UITEST_LOCK" native/scripts/test-app.sh \
  -parallel-testing-enabled NO -only-testing:ShepherdTests 2>&1 | tail -n 40
"$UITEST_LOCK" native/scripts/test-app.sh \
  -parallel-testing-enabled NO -only-testing:ShepherdUITests 2>&1 | tail -n 40
```

Keep the existing Release signature/entitlement checks in `native.yml` (ad-hoc in CI, hardened runtime, no release get-task-allow, sandbox false, strict codesign verification). Locally preserve existing signing-script behavior; do not change operator signing identity. App tests use `test-app.sh`'s isolated environment and UI launch arguments. Never launch the app outside isolated mode for automated checks.

Required live validation is a foreground, serialized run of the existing Mac unit live suites plus UI smoke with the operator's environment securely supplied. Do not read/print `.claude/settings.local.json`, include secrets in arguments/logs, mint other tokens or modify server state. Allow only the harness's existing authentication/test-token lifecycle and audited reads, with queue recomputation and terminal input disabled. Preserve the existing audit exclusion for `getBranchStatus`: it is a GET with git-fetch side effects, so “GET” alone does not make a route acceptable. Preserve the request audit and cleanup of the harness-owned `Shepherd UI test (…)` token. No live environment in ordinary CI. No local invocation enables `SHEPHERD_KEYCHAIN_TESTS` or its test-runner-prefixed spelling. Missing live credentials means an unmet gate, not a passing smoke result.

## CI coverage and deployment

| Lane                                         | Current behavior                                                                                                                      | Stage 1 requirement                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native.yml` / `shepherdkit` (`ShepherdKit`) | macos-latest; Swift 6.2+; contract checks; package build/test; strings; Release app/signature; Mac unit bundle; temporary CI Keychain | Preserve job identity and current Mac gates. Include core in the package build; separate Kit and core test invocations so the old Kit opt-in never reaches core. Execute moved scenarios and resource/guard tests, and report conservation totals. Apply the approved existing-Kit-only CI Keychain exception below. |
| New blocking core simulator lane             | Absent today                                                                                                                          | Swift 6.2+ toolchain with available iOS 18+ simulator; generic iOS build plus executed `ShepherdAppCoreTests`; no live credentials/Keychain opt-in; package/localization freshness checks; publish results                                                                                                           |
| `native.yml` / `shepherd-mac-ui`             | macos-latest, `continue-on-error: true`, existing UI smoke                                                                            | Preserve existing hosted-runner status policy; local isolated UI/live evidence remains mandatory for this PR. Do not relabel this currently advisory job as an existing blocking check.                                                                                                                              |
| `ci.yml` / `verify`                          | Root format/lint/typecheck/tests plus other repository checks                                                                         | Preserve; updated generator and both source guards are exercised by root tests                                                                                                                                                                                                                                       |
| `macos.yml`                                  | Bun backend/process probes                                                                                                            | Preserve; this is not native app or simulator coverage                                                                                                                                                                                                                                                               |

Under the approved existing-CI exception, retain its temporary-Keychain setup and scope the existing opt-in test step to `swift test --package-path native --no-parallel --filter ShepherdKitTests`. Run core in a separate step with neither Keychain opt-in spelling present: `swift test --package-path native --no-parallel --filter ShepherdAppCoreTests`. Assert nonzero expected execution counts and account for every original Kit/core test identity; a filter matching nothing is a failure. The unfiltered package test command above remains the local gate with no Keychain opt-in. This split preserves the old CI coverage without exposing new core tests to the opt-in environment.

Path filters already include `native/**`, `contracts/**`, `ui/messages/*.json` and `native.yml`. Retain those paths. No Linux core build is promised: SwiftUI limits this target to Apple platforms. iOS 18 is the matching existing package floor; the installed simulator runtime may be newer. Preserve macOS 15.0 Info.plist/project/package consistency. No iOS deployment, signing, bundle ID, entitlements or App Store work belongs here.

Hosted jobs run on separate machines; serialize xcodebuild within each runner. They cannot depend on an operator-home script or UID-specific path. A repository-owned CI equivalent of the lock wrapper may use a runner-local temporary directory with the same command/exit semantics; do not commit the operator tooling or add credentials. Keep build/test steps sequential and use the wrapper consistently for all native xcodebuild entry points. CI workflow concurrency groups alone do not serialize processes on a shared machine.

## Risks and approved policy decisions

| Risk                                                                     | Required evidence/containment                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Hidden app dependency through mixed files/transitive imports             | Declaration inventory, import guard, actual simulator build and tests                                           |
| Visibility expansion becomes an API redesign                             | App-driven public surface, explicit constructors, private setters/internal test seams                           |
| Installation callback split changes ordering or captures old activations | Exact order above; preserved production install/reset tests and per-activation bridge tests                     |
| Notification extraction changes focus/presence/badge races               | Synchronous adapter contract and existing delayed-completion/badge/teardown tests; Mac host integration tests   |
| Module compiles but strings resolve to keys                              | Generated runtime strings, module bundle lookup and EN/DE runtime assertions on both platforms and Mac app host |
| Test loss hidden by moving suites or platform guards                     | 1,090-identity mapping, separate 416 Kit/13 UI conservation, runtime pass/skip accounting                       |
| Global registry tests overlap                                            | Serial core runner plus suite organization covering all shared global state                                     |
| Local-server model incorrectly treated as shared                         | Explicit Mac exception; no fake process implementation on iOS                                                   |

**Approved decision 1 — existing CI Keychain coverage.** Retain the pre-existing isolated ShepherdKit CI coverage, including its throwaway CI Keychain and `CredentialStoreTests.keychainIsUsableOnCI` sentinel. Scope the opt-in step to Kit only. Never opt local/core/simulator tests in with either environment-variable spelling. The operator explicitly approved this exception; it does not authorize credential access during planning.

**Approved decision 2 — pre-existing ShepherdKit concurrency exceptions.** Preserve `Credentials/InMemoryCredentialStore.swift`'s existing `@unchecked Sendable` and `Client/ReadOnlyRequestAudit.swift`'s existing `nonisolated(unsafe)` counters unchanged. Add no unsafe annotations or concurrency suppression. Preserve documented test stubs and Swift 6 checking. The operator explicitly approved this exception; changing those Kit implementations is outside this extraction.

No other large behavior choice is deferred: the proposed host-required prompt factory, notification dependency injection, declaration splits and generated runtime localization resources are approved concrete design choices. Their toolchain feasibility is not claimed as tested. Scheme discovery, resource bundling and actual simulator availability remain mandatory future verification, not reasons to weaken acceptance. ShepherdKit declares iOS 18 support, but no simulator build was performed in this run: any pre-existing SDK incompatibility discovered by the gate must be reported explicitly, not hidden with a platform stub, test exclusion or an unreviewed Kit rewrite.

## Recorded pre-rebase implementation evidence

Tasks 1–4 were implemented and independently reviewed through `1f4259884c87fa60cbfe063c189e1b80958934f7` (Task 4 fix) and its approved scoped re-review. The reusable native evidence was collected on arm64 macOS 26.6.2 with Swift 6.3.3, Xcode 26.6 build 17F113, and iPhone 17 / iOS 26.5 simulator `70214AF9-7AEB-49EA-96FF-BAA3E8B9F814`. The exact commands and bounded logs are recorded in `.superpowers/sdd/2026-09-21-shepherd-app-core-stage-1/task-4-report.md` and `task-4-fix-1-report.md`; no new product gate is claimed by this documentation task.

The accepted pre-rebase native matrix was: core 936 pass on macOS and simulator; Kit 414 pass plus 2 permitted local Keychain skips; Mac 147 pass plus 15 live skips; UI 6 pass plus 7 live skips. The simulator result checker proved 936 identities, 36 parameterized declarations and 135 argument executions. Conservation remains 1,519 original identities and 1,527 total declarations, with 8 explicit additions; the prior 1,519/1,519 baseline is unchanged. The existing Kit-only Keychain exception and the two approved unchanged Kit annotations remain the only exceptions.

At that pre-rebase checkpoint, acceptance was not overall complete: the root gate was `10,600 pass / 41 skip / 18 fail / 3 errors` with no new failing identities; G5 read-only live smoke is UNMET because automatic approval blocked authenticated execution; hosted CI is pending and has not been run. These are unmet gates, not waived failures. No CI URL, live success, merge, PR or issue completion is claimed. Stage 2 iOS skeleton and Stage 3 view extraction remain later work.

## Pinned rebase integration evidence

Task 6 rebased the ten original commits onto `c4961c40ec2cdfde9c011387536d2bd0bc1f9e58`,
assessing all six upstream commits. Integration source is recorded at
`e84307181410a81ae7b2de4ba76e24d5c09938eb`. All upstream backend recovery and terminal resume changes now follow their
shared-core owners; updater, first-launch installation, local-process hosting and window behavior
remain Mac-owned. Recovery precedes terminal in the complete model pass, and early Settings
registration remains in app initialization. Original notification and presentation hook ordering
is preserved around those upstream additions.

The immutable 1,519-test baseline and original eight additions remain separate from 54 upstream
additions. Eleven original scenarios have explicit Git-backed upstream transitions, including two
renames with changed upstream assertions. Final declaration counts are **960 core / 179 Mac /
428 Kit / 14 UI = 1,581**. Independent upstream provenance is recorded in
`native/Tests/Conservation/issue-2431-upstream.json`; no baseline was recaptured.

Fresh native evidence: core **960 pass** on macOS and iOS Simulator; Kit **426 pass / 2 permitted
local Keychain skips**; Mac **164 pass / 15 live skips**; UI **7 pass / 7 live skips**. The simulator
proves **41 parameterized declarations / 151 argument executions**, preserving all original
arguments. Universal Release, strict ad-hoc/hardened-runtime signing, update signatures/appcast,
update packaging, DMG copies, generators/conservation, typecheck, lint and contract checks passed.
Exact commands, source snapshots and results are in the Task 6 rebase report/evidence directory.

Overall acceptance remains **UNMET**. The fresh root result is **10,613 pass / 41 skip / 18 fail /
3 errors**, with the same 18 failing identities. G5 remains blocked by the binding automatic
approval rejection; hosted CI has not run. Local passes do not waive either gate. The rebase and
provenance integration require fresh deep review before the later publication/acceptance workflow.

## Acceptance criteria

- [x] New product/target/test target consume the existing ShepherdKit under macOS 15 / iOS 18 floors; Mac app uses the shared implementation with no duplicate model definitions.
- [x] Every listed shared model/state/rule and seam moves; required splits contain no copied/reimplemented algorithms; all view bodies and listed Mac adapters remain Mac-owned.
- [x] Core has no AppKit/UIKit/SwiftTerm/app dependency; Swift 6 checking and required API access work in both Mac consumption and simulator compilation.
- [x] Scene installation precedes scene reads; pinned upstream registration order and early Settings registration are preserved. Late registration, repeated installation, conservative reset defaults, prompt fallback and teardown/signal semantics remain intact.
- [x] Notification focus, delivery, badge ordering, profile-bound settings and isolated launch behavior are unchanged with explicit adapters.
- [x] Generator/check covers module catalog plus EN/DE runtime resources; `L.t` resolves/formats correctly from module resources on both platforms and in the Mac host.
- [x] All 1,090 existing app-unit declarations/scenarios, 416 Kit declarations and 13 UI methods are accounted for and preserved. Moved unit cases execute on both platforms; Mac-only cases remain exercised; new tests are reported separately.
- [ ] Package build/test, simulator build/test, app bundle/unit/UI, read-only live smoke, contract/typecheck/lint/strings, import/OpenEnum guards, formatting and required CI checks have recorded results with no unexplained skips.
- [x] `native/docs/development.md` describes the new source paths, public seams, platform hooks, ownership, reset, resources and test commands; generator descriptions and target resource membership are current.
- [x] Both existing-ShepherdKit exceptions were explicitly approved by the operator (“go”).
- [x] Implementation observes those narrow exceptions; no credentials, product changes outside extraction, deployment work or unapproved stage scope enters the PR.

## Later stages and current handoff

Stage 2 creates `native/Apps/ShepherdIOS` and its app CI lane, with profiles/login, session list/event stream and read-only detail. Stage 3+ migrates AppKit-free views in the approved order: sidebar rows/lenses, plan gates, queues, composer, merge, settings; each remains simulator-gated. Touch terminal, iOS notifications, new navigation/window behavior, outstanding parity backlog, server-contract changes, new persistence namespaces and lifecycle redesign are excluded from Stage 1.

For the eventual implementation branch, retain origin/main ancestry, rebase-only updates, one PR per stage and green-check squash-merge policy. No branch mutation is part of this documentation run. Never force-add `.superpowers/`.

Self-review completed against source inventory, registration/reset code, generator/resource paths, static test census, scripts and CI. Corrected assumptions include `HerdSignals` naming, presentation-owned composer state, Mac-only local-server dependencies, required mixed-file splits, prompt fallback injection, runtime localization, CI's advisory UI lane and pre-existing policy conflicts. Implementation evidence is recorded above; aggregate acceptance remains unmet as stated.

**Current handoff:** specification and both narrow exceptions approved. Tasks 1–4 are complete and Task 5 reconciles the implementation plan at `docs/superpowers/plans/2026-09-21-shepherd-app-core-stage-1.md` with the recorded evidence. Preserve the selected sequential implementation/review method; Task 6 remains responsible for final whole-branch review, hosted CI, live evidence and merge handoff.
