# ShepherdIOS Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated iOS 18 shell using `ShepherdAppCore` for remote profiles, login, live session listing, and read-only session details with activity recovery.

**Architecture:** Add a separate XcodeGen iOS app target that owns navigation, scene lifecycle, passive notification adapters and isolated launch setup. Register only `SidebarModel` and `DetailModel`; `AppModel` remains the owner of profiles, activation, credentials and the one `SessionStore`/`EventStream`. A narrowly scoped Stage-2 prerequisite fixes AppModel activation to preserve the audited client while attaching one event socket.

**Tech Stack:** Swift 6 strict concurrency, SwiftUI, Observation, Swift Testing/XCTest, XcodeGen 2.46+, iOS 18 Simulator, existing `ShepherdKit` and `ShepherdAppCore` products, Bun-generated localization, existing simulator selector and serialized `uitest-lock.sh`. No new package dependency.

**Spec:** `docs/superpowers/specs/2026-09-22-shepherd-ios-stage-2-design.md`

## Global Constraints

- Branch from `origin/main`; rebase only; one Stage-2 PR linked to #2431 and #2446.
- iOS deployment floor is 18.0; preserve macOS 15 and the package identity `ShepherdKit`.
- Duo-specific `DeviceHinge`/Reserved-Region APIs are beta/availability-gated; the size-class layout must remain fully functional on iOS 18 and current non-Duo devices. Use Xcode 27.1/iOS 27.1 beta only for the Duo simulator lane when available.
- Core remains UIKit/AppKit-free; no SwiftTerm, Sparkle, local server, second network client, second event socket or handwritten payload model.
- Register only `SidebarModel` and `DetailModel`; do not invoke `StreamRegistrations.installAll`.
- All app-authored strings use `L.t()` and generated EN/DE resources; no hardcoded user-facing copy.
- Automated launches use isolated arguments/environment, throwaway defaults and `InMemoryCredentialStore`; never Keychain prompts or either Keychain-test opt-in variable.
- Live validation is read-only except the harness-owned login/mint/revoke lifecycle; verify that exact token returns HTTP 401 before cleanup completes.
- Every local native command, including SwiftPM, xcodebuild, scripts and scheme discovery, runs once through `/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/uitest-lock.sh`. CI uses `native/scripts/uitest-lock.sh`.
- Preserve command exit status while showing only filtered output or the last 40 lines. Never read generated sources or raw secret-bearing logs whole. Use `bun run test`, never bare `bun test`.
- Do not edit `native/Apps/ShepherdMac/project.yml`, Mac build/test scripts, the lock implementations, or Stage-1 conservation inventories as incidental cleanup. #2434 owns Mac automation/keychain-dialog work.
- Do not implement before this written plan is approved.

## Review Focus

1. AppModel activation must attach an EventStream to the same audited client. Test: a fake socket pushes a session change and presence is observed; a profile switch stops the old socket.
2. A stopped store must never be restarted. Test: rapid scene transitions use `setActive`, retain the store, and foreground recovery refreshes without duplicate sockets or taps.
3. An activity request that fails before connectivity returns must be retried when the current store re-enters `.live`, even if no later `session:activity` event arrives. Test activation/model identity and selection guards.
4. Login completion, profile removal or a revoked/failed session must not dismiss a replacement sheet or reactivate an old profile. Test generation and busy-dismissal behavior.
5. Isolated UI tests must execute real assertions with no terminal/write affordances and must fail closed when the result inventory or owned-token HTTP-401 cleanup is missing.

---

## File ownership and dependency order

| Task | Owner | Exclusive files | Depends on |
| --- | --- | --- | --- |
| 1 | Integrator | `native/Apps/ShepherdIOS/project.yml`, `Sources/Info.plist`, package/app target wiring | none |
| 2 | Integrator | `native/Sources/ShepherdAppCore/App/AppModel.swift`, `native/Tests/ShepherdAppCoreTests/AppModelEventCompositionTests.swift` | 1 |
| 3 | Composition owner | `native/Apps/ShepherdIOS/Sources/App/{ShepherdIOSApp,RootView,IOSAppLifecycle,IOSNotificationEnvironment,IOSLaunchEnvironment,IOSLiveCleanup}.swift`, composition/lifecycle tests | 1, 2 |
| 4 | Presentation owner | Welcome, profile and connection views plus their unit tests | 3 |
| 5 | Session/detail owner | Sessions list/detail/activity views plus lifecycle recovery tests | 3, 4 |
| 6 | Acceptance owner | iOS scripts, UI tests, result checker and `native-ios.yml` | 1–5 |
| 7 | Documentation/integrator | `native/docs/ios-development.md`, manifests/catalog generation and final evidence | 1–6 |

Tasks 3–5 can be drafted independently after their interfaces are fixed, but integration and all native validation remain sequential. Task 3 owns the initial `RootView` and lifecycle API; after its checkpoint, Task 5 has an explicit handoff to add only the session destination wiring in the marked integration region of `RootView`, while preserving the lifecycle API. No other worker edits that file. The integrator owns any required generated localization output.

## Task 1: Add the iOS XcodeGen shell target

**Files:**

- Create: `native/Apps/ShepherdIOS/project.yml`
- Create: `native/Apps/ShepherdIOS/Sources/Info.plist`
- Create: source directory structure for Tasks 3–5; do not add product code in this task.

**Interfaces:** Produces a `ShepherdIOS` application target and `ShepherdIOSTests`/`ShepherdIOSUITests` targets depending on the local `ShepherdAppCore` product. It must not depend on SwiftTerm or Sparkle. The project uses iOS 18.0, Swift 6, complete strict concurrency, `ExistentialAny`, bundle ID `run.shepherd.ios`, and an iPhone/iPad application scene.

- [ ] **Step 1: Copy only the Mac project conventions that apply to iOS.** Keep package path `../..`, local product dependency `ShepherdAppCore`, manual/ad-hoc signing defaults compatible with CI, and generated Info.plist ownership. Omit Mac entitlements, Sparkle, SwiftTerm, hardened-runtime settings and Mac-only build phases.
- [ ] **Step 2: Define the app, unit-test and UI-test targets.** The test target hosts the app and receives `ShepherdAppCore`; the UI target points at `ShepherdIOS` and has no live credentials. Add schemes with build/test actions and no parallel testing assumption.
- [ ] **Step 3: Generate and inspect the project.** Run `xcodegen generate` from the app directory through the shared lock wrapper; inspect only the generated scheme/target names and errors. Generated `.xcodeproj` remains ignored.
- [ ] **Step 4: Commit the target skeleton.**

```bash
git add native/Apps/ShepherdIOS/project.yml native/Apps/ShepherdIOS/Sources/Info.plist
git commit -m "feat(native): add ShepherdIOS project shell"
```

## Task 2: Restore the audited AppModel event composition

**Files:**

- Modify: `native/Sources/ShepherdAppCore/App/AppModel.swift: activate(_:)`
- Create: `native/Tests/ShepherdAppCoreTests/AppModelEventCompositionTests.swift`
- Reuse: `InMemoryCredentialStore`, `CoreTestSupport` and generated fixtures; the new AppCore-owned combined loopback fixture is deliberately separate because the Kit test fakes are target-private.

**Interfaces:** `activate(_:)` continues to create one `ShepherdClient(profile:credentials:readOnlyAudit:)`, then creates `SessionStore(client: client, events: EventStream(client: client))`. No public signature changes. The test proves the AppModel path rather than a direct `SessionStore(profile:)` convenience initializer.

- [ ] **Step 1: Add an AppCore-owned combined local-server fixture.** The existing `FakeShepherdServer` and `FakeEventServer` are private to `ShepherdKitTests` and cannot be imported by `ShepherdAppCoreTests`; AppModel also constructs its client with the default URLSession, so a URLProtocol-only fixture would not exercise production activation. Create `native/Tests/ShepherdAppCoreTests/AppModelEventFixture.swift` with one loopback `NWListener` that serves the required HTTP bootstrap routes and `/events` WebSocket frames on the same ephemeral port. Copy only fixture behavior, never production networking or payload types. The fixture URL is accepted by ShepherdKit's loopback policy.
- [ ] **Step 2: Write a failing composition test.** Seed an isolated default, in-memory credential and valid loopback profile; activate through AppModel against the combined fixture, wait for `.live`, send one valid session event, assert the registered SidebarModel observes it, assert one presence frame after `setActive(true)`, then switch/deactivate and assert the old server receives no further subscription work.
- [ ] **Step 3: Run only that test through the shared lock.** Use `swift test --package-path native --no-parallel --filter ShepherdAppCoreTests/AppModelEventCompositionTests` via the wrapper. It must fail because AppModel currently passes no EventStream.
- [ ] **Step 4: Implement the minimal wiring correction.** Keep the audited client instance in a local constant; do not construct a second client for the socket and do not use the convenience initializer, because that would drop `readOnlyAudit`.
- [ ] **Step 5: Re-run the focused test and the existing AppModel/core tests.** Filter output to test results/errors, preserve the exit code, and record the tested SHA in local untracked evidence.
- [ ] **Step 6: Commit.**

```bash
git add native/Sources/ShepherdAppCore/App/AppModel.swift native/Tests/ShepherdAppCoreTests/AppModelEventFixture.swift native/Tests/ShepherdAppCoreTests/AppModelEventCompositionTests.swift
git commit -m "fix(native): attach audited event stream during app activation"
```

## Task 3: Compose the isolated iOS app and scene lifecycle

**Files:**

- Create: `native/Apps/ShepherdIOS/Sources/App/ShepherdIOSApp.swift`
- Create: `native/Apps/ShepherdIOS/Sources/App/IOSAppLifecycle.swift`
- Create: `native/Apps/ShepherdIOS/Sources/App/IOSNotificationEnvironment.swift`
- Create: `native/Apps/ShepherdIOS/Sources/App/IOSLaunchEnvironment.swift`
- Create: `native/Apps/ShepherdIOS/Sources/App/RootView.swift`
- Create: `native/Apps/ShepherdIOS/Sources/App/IOSLiveCleanup.swift`
- Create: `native/Apps/ShepherdIOS/Tests/IOSCompositionTests.swift`
- Create: `native/Apps/ShepherdIOS/Tests/IOSAppLifecycleTests.swift`
- Create: `native/Apps/ShepherdIOS/Tests/IOSLiveCleanupTests.swift`

**Interfaces:** `ShepherdIOSApp` owns one Swift Observation `@State private var appModel: AppModel` and passes it into `RootView`. `RootView` owns the top-level profile/login/connection/list/detail navigation only; feature views remain in Tasks 4–5. The iOS notification environment is passive and never requests authorization. The launch parser recognizes `-ShepherdIsolated 1`, `SHEPHERD_ISOLATED`, and `TEST_RUNNER_SHEPHERD_ISOLATED`; isolated construction fails closed if private defaults cannot be created. `IOSAppLifecycle` has `init(app:onForegroundRecovery:)`, `update(_ phase: IOSScenePhase) async`, and `storeDidChange(_ store: SessionStore?)`; it calls `setActive(false/true)` without stopping the store and invokes the callback once per current-store `.live` recovery. `IOSLiveCleanup` accepts the isolated harness status/handshake paths and records only nonsecret owned-token identifiers/status.

- [ ] **Step 1: Write composition tests.** Assert exactly SidebarModel and DetailModel are registered, no Mac-only stream host is configured, isolated storage is private/in-memory, and a normal construction path does not read the operator Keychain in tests.
- [ ] **Step 2: Write lifecycle tests.** Assert active/inactive transitions call `setActive` in order, never `stop()`/`start()`, coalesce duplicate phases, and foreground recovery calls retry/visible-detail refresh only for the current activation.
- [ ] **Step 3: Implement the passive notification and launch adapters.** Keep all platform APIs in the iOS app target. Do not add UIKit imports to ShepherdAppCore.
- [ ] **Step 4: Implement AppModel setup.** Register only the two extensions before `restoreActiveProfile()`. Configure the iOS token-name closure with `ProfileSetup.tokenName(prefix: "Shepherd for iOS (")`; isolated live tests use their own unique prefix.
- [ ] **Step 5: Run the composition/lifecycle unit tests through the shared lock.** The app target is intentionally not built until Tasks 4–5 supply all RootView destinations; run the existing package/core tests plus the new lifecycle tests only when their source dependencies are present. A missing simulator or zero executed tests is an unmet gate. Task 6 is the first complete app build checkpoint.
- [ ] **Step 6: Test the cleanup handshake.** Given an isolated owned-token test, write a mode-0600 status file containing only the nonsecret run ID, server URL and the temporary token value needed by the verifier; emit `revocation_requested` before the app request and `revocation_returned` only after it returns. On cancellation or assertion failure leave `pending` and retain the path for the harness. `verify-ios-live-cleanup.py` reads the file, performs the owned-token HTTP 401 check, overwrites/removes the token-bearing file on success, and exits nonzero when status is missing/pending or the response is not 401. Never log the token or password; failure cleanup uses the same private status path, never a name sweep.
- [ ] **Step 7: Commit all Task-3 files, including `RootView.swift` and `IOSLiveCleanup.swift`.**

```bash
git add native/Apps/ShepherdIOS/Sources/App native/Apps/ShepherdIOS/Tests
git commit -m "feat(native): compose isolated iOS app lifecycle"
```

## Task 4: Build profiles, login and connection presentation

**Files:**

- Create: `native/Apps/ShepherdIOS/Sources/Welcome/ServerListView.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Welcome/RemoteServerFormView.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Welcome/LoginSheet.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Connection/ConnectionStatusView.swift`
- Create: `native/Apps/ShepherdIOS/Tests/IOSWelcomeStateTests.swift`
- Create: `native/Apps/ShepherdIOS/Tests/IOSConnectionStateTests.swift`

**Interfaces:** Views call only `AppModel` public APIs: `beginRemoteLogin`, `addRemoteProfile`, `activate`, `signIn`, `signOutActiveReporting`, `remove`, `retry` and `deactivate`. They reuse `LoginSheetState`, `BannerPolicy`, `ShepherdErrorCopy`, `L.t`, `AppSheet` and generated `ServerProfile` values. No view creates a ShepherdClient or stores a token.

- [ ] **Step 1: Create exact tests in `native/Apps/ShepherdIOS/Tests/IOSWelcomeStateTests.swift` and `IOSConnectionStateTests.swift`.** Cover empty profile list, normalized duplicate address, malformed/insecure address, busy login dismissal, wrong password, `.needsLogin`, `.firstRunPending`, offline/retry, local-only sign-out notice and replacement-sheet protection.
- [ ] **Step 2: Implement the profile list and remote form.** Show saved remote profiles, add/select/remove actions, validation errors and no local “Run on this Mac” row. Preserve the kit policy exactly: remote `.ts.net` addresses are HTTPS, and only loopback may use HTTP. If iOS ATS requires an exception for the permitted loopback HTTP fixture, add only a localhost/loopback exception in the iOS Info.plist and test that remote HTTP and remote `.ts.net` HTTP remain rejected; never add a blanket ATS exception.
- [ ] **Step 3: Implement login.** Bind `LoginSheetState`, block interactive dismissal while busy, clear password after completion, and dismiss only when `model.sheet` is the matching `.login(profile)`.
- [ ] **Step 4: Implement connection states.** Use existing copy/policy mappings for loading, live, first-run-required, unauthenticated, offline and incompatible-server states. Do not claim remote revocation was confirmed when the current logout implementation only cleared local credentials.
- [ ] **Step 5: Run focused tests and commit.**

```bash
git add native/Apps/ShepherdIOS/Sources/Welcome native/Apps/ShepherdIOS/Sources/Connection native/Apps/ShepherdIOS/Tests
git commit -m "feat(native): add iOS profiles and login flow"
```

## Task 5: Add the live session list and read-only activity detail

**Files:**

- Create: `native/Apps/ShepherdIOS/Sources/Sessions/SessionListView.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/SessionDetailView.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/ActivityView.swift`
- Create: `native/Apps/ShepherdIOS/Tests/IOSSessionViewTests.swift`
- Create: `native/Apps/ShepherdIOS/Sources/Sessions/IOSVisibleActivityRecovery.swift`

**Interfaces:** `SessionListView` consumes `SidebarModel.sessions`, `rendered(_:)`, `chips` and `AppModel.reconcileSelection(against:)`. `SessionDetailView` consumes `DetailModel.activity`, `DetailTaskKey`, `poll(.activity, session:)`, `isRefreshing` and `Loaded`. `IOSVisibleActivityRecovery` is a new app-owned `@MainActor` helper with `init(app: AppModel, detail: DetailModel, selectedID: @escaping () -> String?)`, `storeDidChange(to:)` and `reloadVisibleActivityIfNeeded() async`; it is injected into the Task-3 lifecycle's existing `onForegroundRecovery` closure during the explicit RootView handoff. No new server payloads or data caches.

- [ ] **Step 1: Write session/list tests.** Cover event-driven row updates, connected-empty, offline last-known rows, archived/removal selection reconciliation, unknown enum fallback, iPhone stack and iPad split navigation state.
- [ ] **Step 2: Write detail/recovery tests.** Cover initial activity loading, empty/failure/retry, cancellation after selection change, same session ID on a new profile, failed foreground load followed by current-store `.live` recovery without a new activity event, and no duplicate refreshes.
- [ ] **Step 3: Implement the list.** Use the existing all-sessions lens and rendered status. Do not recreate Herd grouping or status rules. Provide no write affordances.
- [ ] **Step 4: Implement detail/activity.** Key `.task(id:)` with `DetailTaskKey`; guard current AppModel activation and selected ID; preserve model-provided ordering. Expose identity, status, repository/branch/prompt metadata and activity only. Defer diff/files/git/plan/terminal.
- [ ] **Step 5: Implement recovery ownership.** Implement `IOSVisibleActivityRecovery` and connect it through the Task-3 lifecycle callback handoff. Observe current-store connection transitions to `.live`, coalesce with event-driven activity loads, and reload only the visible session. Do not add a timer or second socket. The only RootView edit is the agreed destination wiring after Task 3's checkpoint.
- [ ] **Step 6: Run focused tests and commit.**

```bash
git add native/Apps/ShepherdIOS/Sources/Sessions native/Apps/ShepherdIOS/Sources/App/RootView.swift native/Apps/ShepherdIOS/Tests
git commit -m "feat(native): add iOS session list and activity detail"
```

## Task 6: Add iOS scripts, UI tests and blocking CI

**Files:**

- Create: `native/scripts/build-ios-app.sh`
- Create: `native/scripts/test-ios-app.sh`
- Create: `native/scripts/check-ios-results.py`
- Create: `native/scripts/select-ios-simulator.py`
- Create: `native/scripts/live-ios-smoke.sh`
- Create: `native/scripts/verify-ios-live-cleanup.py`
- Create: `native/scripts/archive-ios-app.sh`
- Create: `native/scripts/validate-ios-archive.sh`
- Create: `native/Apps/ShepherdIOS/UITests/ShepherdIOSUITests.swift`
- Create: `native/Apps/ShepherdIOS/UITests/ShepherdIOSLiveCleanupUITests.swift`
- Create: `native/Apps/ShepherdIOS/UITests/ShepherdIOSDuoUITests.swift`
- Create: `test/fixtures/native-ios-stage2-results-pass.json`
- Create: `test/fixtures/native-ios-stage2-results-zero.json`
- Create: `test/fixtures/native-ios-stage2-results-skip.json`
- Create: `test/fixtures/native-ios-stage2-results-malformed.json`
- Create: `.github/workflows/native-ios.yml`
- Create: `native/Apps/ShepherdIOS/ExportOptions.example.plist`

**Interfaces:** Scripts generate the XcodeGen project, use the existing `select-core-simulator.py` for the core lane and the new `select-ios-simulator.py --family iPhone|iPad|DuoOuter|DuoInner` for app UI lanes, set isolated launch arguments, disable parallel testing and preserve result bundles. Scripts do not invoke the lock wrapper themselves; callers wrap the entire script exactly once, so there is no nested lock. The result checker fails on missing/zero expected test identities and reports pass/skip/failure separately. `ShepherdIOSLiveCleanupUITests` consumes only the isolated harness handshake and never reads the live-smoke file. `live-ios-smoke.sh --config ~/.config/shepherd/codex/live-smoke.json` is the only live entry point; it passes redacted run metadata and temporary owned-token material through the existing secure harness path, invokes `verify-ios-live-cleanup.py` internally with its private status path and server URL, and fails when the owned token's HTTP 401 is absent. CI has generic simulator build plus concrete iPhone and iPad UI-test destinations and no live credentials. Duo UI cases use size-class/width scenarios and availability-gated Reserved-Region/Hinge behavior; they do not pretend a generic iPhone simulator is a Duo hardware substitute.

- [ ] **Step 1: Write result-checker fixtures first.** Use the exact four `test/fixtures/native-ios-stage2-results-{pass,zero,skip,malformed}.json` files above: passing nonzero inventory, zero-test failure, unexpected skip and malformed result. Reuse existing `check-core-results.py` conventions without changing that checker.
- [ ] **Step 2: Implement build/test scripts.** Fail closed when XcodeGen, a simulator or isolated arguments are unavailable. Never launch the app outside isolated mode. Filter output and retain raw diagnostics only as local artifacts.
- [ ] **Step 3: Implement deterministic isolated UI tests.** Assert profile/login/list/detail transitions, no terminal/write controls, iPhone/iPad navigation, Duo outer compact and inner regular size-class behavior, 12.9-inch iPad regular layout with hardware-keyboard focus, Reserved-Region/Hinge fallback when the beta SDK is present, and a real event-driven row update. Do not load the live-smoke config in ordinary UI tests. Implement the separate cleanup UI test to report owned-token completion/cancellation through `IOSLiveCleanup`; the harness, not the app, verifies the exact token's HTTP 401.
- [ ] **Step 4: Implement `native-ios.yml`.** Trigger on iOS app/scripts/shared native/contracts/catalog changes. Keep it separate from `native.yml`; use the existing repository lock wrapper, selected simulator, sequential test jobs, artifacts and actual-count checks.
- [ ] **Step 5: Run local build and unit/UI gates sequentially.** Call the external shared wrapper around each entire script or direct xcodebuild command; scripts themselves do not call the wrapper. Record selected runtime/UDID, executed identities and filtered outcomes; a missing simulator or signing/toolchain prerequisite is UNMET. Run `LOCK native/scripts/live-ios-smoke.sh --config ~/.config/shepherd/codex/live-smoke.json` only with the operator-named config; the script must prove HTTP 401 internally before success.
- [ ] **Step 6: Commit.**

```bash
git add native/scripts/build-ios-app.sh native/scripts/test-ios-app.sh native/scripts/check-ios-results.py native/scripts/select-ios-simulator.py native/scripts/live-ios-smoke.sh native/scripts/verify-ios-live-cleanup.py native/Apps/ShepherdIOS/UITests test/fixtures/native-ios-stage2-results-pass.json test/fixtures/native-ios-stage2-results-zero.json test/fixtures/native-ios-stage2-results-skip.json test/fixtures/native-ios-stage2-results-malformed.json .github/workflows/native-ios.yml
git commit -m "ci(native): add isolated iOS build and test lane"
```

## Task 7: Documentation, localization and final verification

**Files:**

- Create: `native/docs/ios-development.md`
- Create: `native/docs/testflight-ios.md`
- Create: `native/Apps/ShepherdIOS/ExportOptions.example.plist`
- Modify only if new copy is needed: `ui/messages/en.json`, `ui/messages/de.json`, `native/scripts/gen-strings.ts`, generated `native/Sources/ShepherdAppCore/Resources/**`
- Create: `test/native-ios-stage2-contract.test.ts` for the iOS workflow/source-boundary assertions; do not rewrite Stage-1 inventories.

- [ ] **Step 1: Document local iOS setup, isolation, simulator selection, lock usage, token cleanup and the explicit boundary with #2434.** Do not document or print credentials.
- [ ] **Step 2: Add only missing EN/DE keys and regenerate through the existing command.** Run `bun run check:strings`; no hand-edited generated output.
- [ ] **Step 3: Produce and validate the TestFlight candidate without uploading it.** Run `"$LOCK" native/scripts/archive-ios-app.sh Release` to create an exportable archive/IPA using `native/Apps/ShepherdIOS/ExportOptions.example.plist` as a nonsecret template, then `"$LOCK" native/scripts/validate-ios-archive.sh` to verify bundle ID, version/build, supported device families, signing/export-compliance inputs and absence of an Internal-Only distribution setting. Fail closed when the Apple team, signing identity, provisioning profile or export-compliance inputs are absent; never substitute credentials or commit the archive. Record only the archive path, build number and nonsecret validation results.
- [ ] **Step 4: Run the full required gates sequentially.** Set `LOCK=/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/uitest-lock.sh`; each native command below is invoked as `"$LOCK" <command>` exactly once. Run `bun run gen:contract-swift`; `native/scripts/sync-contract.sh`; `bun run native/scripts/gen-strings.ts`; `bun run check:contract-swift`; `native/scripts/sync-contract.sh --check`; `bun run check:strings`; `bun run typecheck`; `bun run lint`; `bun run test:contract`; `bun run test`; `"$LOCK" swift build --package-path native`; `"$LOCK" swift test --package-path native --no-parallel`; `"$LOCK" native/scripts/build-ios-app.sh Debug`; `"$LOCK" native/scripts/test-ios-app.sh unit --result-bundle-path /private/tmp/shepherd-ios-unit.xcresult`; `"$LOCK" native/scripts/test-ios-app.sh ui --family iPhone --result-bundle-path /private/tmp/shepherd-ios-iphone.xcresult`; `"$LOCK" native/scripts/test-ios-app.sh ui --family iPad --result-bundle-path /private/tmp/shepherd-ios-ipad.xcresult`; `"$LOCK" xcodebuild -scheme ShepherdAppCore -destination 'generic/platform=iOS Simulator' -skipPackagePluginValidation -resultBundlePath /private/tmp/shepherd-core-build.xcresult build` from `native/`; write simulator JSON to `/private/tmp/shepherd-ios-simulators.json` with `"$LOCK" xcrun simctl list devices available -j`, then set `CORE_SIMULATOR_UDID=$(python3 native/scripts/select-core-simulator.py /private/tmp/shepherd-ios-simulators.json)`; run `"$LOCK" xcodebuild -scheme ShepherdAppCore -destination "platform=iOS Simulator,id=$CORE_SIMULATOR_UDID" -parallel-testing-enabled NO -only-testing:ShepherdAppCoreTests -skipPackagePluginValidation -resultBundlePath /private/tmp/shepherd-core-tests.xcresult test` from `native/`; run `"$LOCK" xcrun xcresulttool get test-results summary --path /private/tmp/shepherd-core-tests.xcresult > /private/tmp/shepherd-core-summary.json` and `"$LOCK" xcrun xcresulttool get test-results tests --path /private/tmp/shepherd-core-tests.xcresult > /private/tmp/shepherd-core-tests.json`, then `python3 native/scripts/check-core-results.py /private/tmp/shepherd-core-summary.json /private/tmp/shepherd-core-tests.json --parameters native/Tests/Conservation/issue-2431-core-parameters.json`; finally run `"$LOCK" native/scripts/build-app.sh Release`, `"$LOCK" native/scripts/test-app.sh -parallel-testing-enabled NO -only-testing:ShepherdTests` and `"$LOCK" native/scripts/test-app.sh -parallel-testing-enabled NO -only-testing:ShepherdUITests` as the existing Mac Release/unit/UI gates. The core simulator step is required after the AppModel event-wiring change; report actual nonzero execution counts from its xcresult.
- [ ] **Step 5: Run `"$LOCK" native/scripts/live-ios-smoke.sh --config ~/.config/shepherd/codex/live-smoke.json` only with that named file.** The script owns isolated app start, unique token naming, audited GETs, no queue recomputation/terminal input/getBranchStatus, invokes the private cleanup verifier, and must verify the exact owned token returns HTTP 401 before declaring cleanup. Never print config values, token material or passwords.
- [ ] **Step 6: Complete TestFlight handoff.** Follow `native/docs/testflight-ios.md`: upload the archive only when explicit Apple signing/App Store Connect authority exists, fill export-compliance/privacy/test information, add an internal group, run the Duo/iPad beta smoke, then prepare (but do not silently publish) the external group/public link. The first external build may require App Review; track the 90-day build expiry and up to 100 internal/10,000 external tester limits.
- [ ] **Step 7: Fresh whole-branch review.** Review the diff against `origin/main`, task evidence and #2431 constraints. Fix only scoped findings through a fresh implementation run, then repeat the review and affected gates.
- [ ] **Step 8: Rebase and prepare one PR linked to #2431/#2446.** Do not merge, close #2431, or run a second stage in this plan. Squash merge remains gated on green required checks and reviewed head SHA.

## Handoff

The plan is complete and saved at `docs/superpowers/plans/2026-09-22-shepherd-ios-stage-2.md`. Review it before any implementation begins. The plan requires fresh Codex runs per task and independent review; native tests remain serialized through the shared lock. Implementation, app launches and live tests remain blocked until this plan is approved.
