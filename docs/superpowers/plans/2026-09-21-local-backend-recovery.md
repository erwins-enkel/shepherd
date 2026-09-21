# Local Backend Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (requested) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local bootstrap, server adoption, and native recovery work coherently for #2432.

**Architecture:** Preserve the actor supervisor and official installer. Verify optional local health identity and share one activation-scoped diagnostics/recovery model across terminal, composer and Settings. Keep lifecycle actions inside local supervision.

**Tech Stack:** Swift 6, SwiftUI/AppKit, Foundation Process/URLSession, Bun/TypeScript, OpenAPI, Swift Testing and isolated XCTest UI tests.

**Spec:** `docs/superpowers/specs/2026-09-21-local-backend-recovery-design.md`

## Global Constraints

- Swift 6 strict concurrency; no unchecked Sendable workaround.
- Contract-first: edit contracts/openapi.yaml before server or generated-client integration.
- User-facing copy uses L.t() with EN and DE catalog entries.
- Automated tests use temporary homes, fake installers/transports, in-memory credentials and isolated app launches.
- No Keychain prompts; set SHEPHERD_CODESIGN_IDENTITY=- for app build/test commands.
- Serialize every xcodebuild/XCUITest invocation through the existing uitest-lock.sh wrapper.
- Do not stop live herdr, unlink real sockets, change the operator's real install, or write to remote servers.
- One PR for this coherent stage; squash-merge only after every required CI check is green.
- Never git add -f under .superpowers/.

## Review Focus

- Custom install path with spaces or symlinks: preserve HOME and pass arguments safely (task 1).
- Old or wrong health listener responding during startup: never certify app ownership or show an invented DB path (task 1).
- Profile switch while diagnostics or installer refresh is suspended: discard stale responses (tasks 1–2).
- Missing/unknown diagnostics and unrelated Settings endpoint failure: retain an honest fallback and usable diagnostics (task 2).
- Settings opened before main-window registration and while local backend is down: real title, summary and working action, no false Connect message (task 3).

---

### Task 1: Bootstrap and verified local adoption

**Files:**
- Modify `contracts/openapi.yaml`, regenerate `contracts/openapi.swift.yaml` using `bun run gen:contract-swift`.
- Modify `.env.schema` and corresponding docs-site environment documentation for any new opt-in/token variables.
- Modify `src/server.ts` health handler and configuration/helper module only as required for opt-in resolved identity.
- Modify `native/Sources/ShepherdKit/LocalServer/{InstallerRun,LocalServerEnvironment,LocalHealthCheck,LocalServerSupervisor}.swift`.
- Create `native/Sources/ShepherdKit/LocalServer/LocalServerIdentity.swift`; isolate runner-start process handling in `LocalRunnerStart.swift` if needed to keep supervisor focused.
- Modify `native/Apps/ShepherdMac/Sources/App/LocalServerProbe.swift` and `Sources/LocalServer/{LocalServerModel,LocalServerPanel}.swift`.
- Modify `native/Apps/ShepherdMac/Resources/Localizable.xcstrings` and `native/docs/getting-started.md`.
- Tests: existing `InstallerRunTests`, `LocalServerEnvironmentTests`, `LocalHealthCheckTests`, supervisor tests, app `LocalServerModelTests`/`LocalServerPanelTests`; add `LocalServerIdentityTests` and a server health contract test under `test/`.

**Interfaces produced:**

```swift
public struct LocalServerIdentity: Codable, Sendable, Equatable {
    public let appDirectory: String
    public let databasePath: String
    public let instanceID: String
}
// Health.localInstall is optional on the wire; old servers decode successfully.
// LocalServerEnvironment exposes homeDirectory, appDirectory and databasePath.
// Existing LocalServerModel start/stop/restart/refresh remain unchanged.
@MainActor func startRunner() async // method on LocalServerModel
// LocalServerModel exposes externalIdentity: LocalServerIdentity?,
// externalAcknowledged: Bool and acknowledgeExternalServer() for panel gating.
```

- [ ] Write failing fixture tests for no checkout downloading/running a fake installer; custom SHEPHERD_DIR preserving HOME; HTTP error body never executing; cancellation while download/process is active; progress visible before install finishes. Retain existing missing explicit scriptOverride test as a legitimate fixture error.
- [ ] Add health contract tests for absent metadata by default, loopback-only opt-in, actual configured paths and bodyless HEAD. Add native identity cases for missing version/metadata, wrong DB/path/token, canonical matching paths, and old server responses.
- [ ] Run the targeted kit tests: `swift test --package-path native --filter 'LocalServer|Installer'`. Record intended failures before implementation.
- [ ] Implement contract and health identity, then regenerate. Migrate both native health probes to generated Health decoding; do not extend handwritten health payloads. The serialized payload shape is:

```json
{"ok":true,"version":"test-version","localInstall":{"appDirectory":"/tmp/install","databasePath":"/tmp/state/shepherd.db","instanceID":"per-launch-marker"}}
```

- [ ] Resolve environment once, retaining explicit home. Implement injected bootstrap fetch to a temporary script, existing process runner execution, progress sampling and cancellation cleanup. On successful Install and start, call the normal supervisor start; never require Bun before giving the official bootstrap a chance to install it.
- [ ] Require the current launch identity for owned-child health. External discovery remains a warning until acknowledgment; reset acknowledgment on changed identity. Render unknown DB path honestly and provide stop instructions/recheck rather than arbitrary process signals.
- [ ] Implement idempotent runner start behind the supervisor using configured binary/socket and injected process/probe seams. Probe before start and afterward; stale socket alone does not establish liveness. Test live-daemon no-op, fake offline startup, failure timeout, and no unlink/kill of external state.
- [ ] Add bilingual bootstrap/adoption/failure copy and update native setup documentation to match actual behavior.
- [ ] Run targeted kit/server tests and the serialized app LocalServer tests. Inspect changed files for leaked paths in default remote health responses and lifecycle/cancellation regressions. Commit only task files after verification; the controller reviews that commit before the next task.

### Task 2: Shared diagnostics and recovery surfaces

**Files:**
- Create `native/Apps/ShepherdMac/Sources/Settings/BackendRecoveryModel.swift`, `BackendRecovery.swift`, and `BackendRecoveryView.swift`.
- Modify `Sources/Settings/{SettingsFeature,SettingsModel,SettingsDiagnoseView}.swift` and `Sources/App/StreamRegistrations.swift` for registration order.
- Modify `Sources/Terminal/{TerminalController,TerminalSessionModel,TerminalPane}.swift` and `Sources/Compose/{ComposeSubmission,ComposeSheet}.swift`.
- Modify `Resources/Localizable.xcstrings`.
- Tests: create app `BackendRecoveryTests.swift`, extend `TerminalStateTests`, `NewSessionSubmissionTests`, `SettingsDiagnosticsTests`.

All `Sources/` and `Resources/` paths in tasks 2–3 are relative to `native/Apps/ShepherdMac/`.

**Interfaces consumed:** LocalServerModel start(), startRunner(), refresh(), state, logLines from task 1; ShepherdClient.getDiagnostics(), existing DiagnosticsSnapshot and diagnostics:status payload.

**Interfaces produced:**

```swift
enum BackendFailure: Equatable, Sendable {
    case serverUnavailable, runnerUnavailable, sessionGone, sessionSuperseded, undetermined
}
enum BackendRecovery {
    static func classify(serverReachable: Bool?, diagnostics: DiagnosticsSnapshot?,
                         closure: PTYConnection.Closure?) -> BackendFailure
}
// @Observable @MainActor final class BackendRecoveryModel: AppExtension
// private(set) var diagnostics: DiagnosticsSnapshot?
// private(set) var serverReachable: Bool?
// func refresh() async
// func diagnosis(for closure: PTYConnection.Closure?) -> BackendFailure
// func replaceDiagnostics(_ snapshot: DiagnosticsSnapshot)
// BackendRecoveryView receives failure, isLocal and explicit action closures;
// localized title/body/action mapping lives beside BackendRecovery.
```

- [ ] Write pure classifier tests with fixture snapshots. Core assertions:

```swift
#expect(BackendRecovery.classify(serverReachable: false, diagnostics: nil,
                                closure: .unreachable) == .serverUnavailable)
#expect(BackendRecovery.classify(serverReachable: true, diagnostics: nil,
                                closure: .gone) == .sessionGone)
#expect(BackendRecovery.classify(serverReachable: true, diagnostics: nil,
                                closure: .superseded) == .sessionSuperseded)
#expect(BackendRecovery.classify(serverReachable: true, diagnostics: nil,
                                closure: .unreachable) == .undetermined)
```

- [ ] Add runner-offline/missing fixtures using existing herdr diagnostic hint keys; distinguish version-mismatch/unknown hints from offline. Add a stale-generation test and a diagnostics-event test that performs no four-endpoint settings reload.
- [ ] Implement BackendRecoveryModel with independent health/diagnostics reads and a single diagnostics event subscription. Register it before all consumers; consumers resolve it lazily or receive explicit references, never assume a later factory has already run. Cancel work and clear retained state on teardown.
- [ ] Make SettingsModel and Diagnose share this snapshot. Unrelated settings/repos/usage failure must not erase diagnostics. Route explicit refresh and successful diagnostic fixes back into the shared model.
- [ ] On terminal .unreachable, refresh diagnostics and present the classified card without reopening automatically. Preserve explicit gone/superseded and takeover. Pass recovery from TerminalController to session models and discard late completions after session/profile switch.
- [ ] On composer connectivity/runner failure, refresh the same model and show the same explanatory card. Keep validation/auth/cancellation messages meaningful. Preserve draft and never auto-resubmit a create request.
- [ ] Wire local Start server and Start runner actions to task 1; remote actions only open Diagnose/recheck. Reopen/takeover acts on the terminal, not server lifecycle. Add matching EN/DE copy.
- [ ] Run new recovery tests and affected terminal/composer/Settings suites through the serialized app runner. Review unknown diagnostics, auth failure and duplicate-submit behavior, then commit task files for independent task review.

### Task 3: Local Settings activation and window quality

**Files:**
- Modify `Sources/App/{ShepherdApp,SettingsScene}.swift` and `Sources/Settings/SettingsFeature.swift` only where needed for deterministic registration.
- Create `Sources/Settings/SettingsUnavailableView.swift`; reuse LocalServerPanel or its status/log components.
- Modify `Resources/Localizable.xcstrings`.
- Tests: extend `Tests/SettingsRegistrationTests.swift`, `SettingsIntegrationTests.swift`, `SettingsSceneTests.swift`; extend `UITests/SettingsSceneUITests.swift` using the existing IsolatedUITestHarness.

**Interfaces consumed:** app.extension(SettingsModel.self), app.extension(BackendRecoveryModel.self), app.store/activeProfile/activationGeneration; LocalServerModel state/log/actions. No new public kit interface.

- [ ] Write activation tests using unique UserDefaults suites and InMemoryCredentialStore: local profile before registration, registration before activation, repeat registration, profile switch. Assert exactly one SettingsModel and BackendRecoveryModel per active store.
- [ ] Add a Settings-first test and ensure the entry point installs required factories even if RootView.task has not run. Reuse idempotent registration; do not create duplicate store/extension instances or bypass auth.
- [ ] Add a pure availability mapping for local-offline, local-active, remote-inactive and no-profile states. Render local-offline supervisor status/logs plus start/install action; remote-inactive title/summary/Connect action; keep appearance usable.
- [ ] Replace the bare native_settings_connect fallback and placeholder dead ends with explanatory surfaces. Use existing scene opener/profile routing so the labeled action actually reaches login or local recovery.
- [ ] Make tab label icons explicit and validate each SF Symbol with NSImage(systemSymbolName:accessibilityDescription:). Preserve six-pane TabView and repeated Command-comma single-window behavior.
- [ ] Extend isolated UI test: open Settings while disconnected, select Notifications, assert title/summary/action identifiers and six toolbar buttons, invoke next step, verify destination. Include local-offline fixture if needed, without real daemon startup.
- [ ] Run serialized app unit/UI tests with ad-hoc signing. Review EN/DE copy and actual isolated screenshots; do not claim visual verification from symbol existence alone. Commit verified task files for independent task review.

## Verification and handoff

- [ ] Run `swift build --package-path native` and `swift test --package-path native`; compare any failures with baseline (47 targeted LocalServer/Installer tests and 18 app LocalServerModel/SettingsIntegration tests passed before changes).
- [ ] Run `bun run check:env-schema` and `bun run check:env-schema-docs` for newly introduced environment keys.
- [ ] Run `bun run lint` and affected `bun run test` suites; run full required server/contract CI checks for the health change.
- [ ] App command payload: `env SHEPHERD_CODESIGN_IDENTITY=- native/scripts/test-app.sh -only-testing:ShepherdTests`; UI payload: same script with `-only-testing:ShepherdUITests/SettingsSceneUITests`. Root orchestrator wraps both with its existing `uitest-lock.sh`; never run concurrent xcodebuild.
- [ ] Perform whole-branch review after all three task reviews; fix findings and rerun affected checks.
- [ ] Open one PR explaining cold bootstrap, verified external warning, shared diagnostics and local Settings. Record automated evidence and explicitly mark operator-Mac cold/existing/stale-socket manual scenarios as pending if not safely performed.
- [ ] Squash merge only after all required checks are green. No approval to terminate the existing operator herdr daemon is implied by this implementation.


## Recorded verification — 2026-09-21

Implementation commits: `c8141eee` (bootstrap), `63abc03a` (socket normalization), `d12d7c6d` (shared recovery), `fcd528f5` (Settings), `4fdde2f1` (local Settings login navigation).

- Full ShepherdKit: 428 tests in 44 suites passed after bootstrap review fixes.
- Full native app: 1,106 tests in 120 suites passed after Settings implementation. The subsequent navigation fix passed all 31 affected unit tests and all three Settings UI tests.
- Settings UI: three isolated tests passed, including actual disconnected-pane navigation. The exported English screenshot was inspected: six icons, title, summary and action are visible without clipping.
- TypeScript typecheck and full ESLint passed; Web UI check reported zero errors and warnings. Contract synchronization and native string freshness passed.
- Full server suite: 10,536 passed, 41 skipped, 23 failed and three errors on macOS with isolated Bun 1.4.2 and disposable state. The 17 herdr-recovery failures/three errors and one merge-driver failure reproduced identically on an exported `origin/main`. Other failures concern macOS path aliases, unsupported non-UTF-8 filenames and node-pty helper permissions. This broad gate is not green.
- Full Web UI suite: 5,502 passed and 23 failed. All 22 keyboard failures reproduced in the explicit `origin/main` Chromium baseline (192 passed/22 failed across the 214 affected browser tests). The remaining backlog import timeout passed on the current branch in a targeted run (63/63).
- The installed Bun 1.3.1 was left unchanged; official Bun 1.4.2 was used from a temporary directory to match CI's latest-Bun policy.

Manual cold install, existing proper installation and stale-socket recovery on the operator's real Mac remain unverified. No existing daemon/socket/install or remote server was mutated. German and local-offline screenshots were not separately captured; localization and state behavior have automated coverage.

These local results do not authorize merging past a red required CI check. Any PR must retain the broad-gate limitations and manual checks in its validation notes.
