import Foundation
import Synchronization
import Testing
import ShepherdKit
@testable import Shepherd
@testable import ShepherdAppCore

/// `Sendable` gate for the model's injected seams (`probeExternal`, `health`),
/// which are `@Sendable` closures and so cannot hold a main-actor `Gate`
/// (pattern: AppModelTests.swift's `Gate`/`ProbeHold`, kept local to this file
/// rather than reaching across test files). `isWaiting` lets a test poll until
/// the parked call has actually reached the gate before it moves on, instead
/// of guessing with a fixed number of yields.
actor LocalServerGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var isWaiting = false

    func wait() async {
        if opened { return }
        isWaiting = true
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        opened = true
        isWaiting = false
        continuation?.resume()
        continuation = nil
    }
}

extension MacSeamTests {
@Suite(.serialized) @MainActor struct LocalServerModelTests {
    private func tempHome() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("s5-app-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func checkout(in home: URL) throws -> LocalServerEnvironment {
        let environment = LocalServerEnvironment(home: home)
        try FileManager.default.createDirectory(
            at: environment.appDirectory, withIntermediateDirectories: true)
        try #"{"name":"shepherd"}"#.write(
            to: environment.appDirectory.appendingPathComponent("package.json"),
            atomically: true, encoding: .utf8)
        return environment
    }

    /// `AppModel` takes `defaults:` + `credentials:`, not a built `ProfileStore`
    /// — a private suite keeps this test off the operator's real defaults, and
    /// the in-memory credential store keeps it out of the Keychain.
    private func freshApp() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
    }

    /// Writes a `/bin/sh` script under `dir` that sleeps, optionally printing
    /// the operator-password boot line first — but only on its *first* run
    /// (a marker file gates it), mirroring a real `bun run src/index.ts`,
    /// which mints a password once on a fresh install and never reprints it on
    /// a later restart. Touches no bun, install.sh or real Shepherd server —
    /// pattern: `fakeScript` in `LocalServerSupervisorTests.swift`, duplicated
    /// locally because that helper lives in the `ShepherdKitTests` target.
    private func fakeScript(in dir: URL, emitPasswordOnce: Bool) throws -> LocalServerLaunch {
        let marker = dir.appendingPathComponent("password-shown")
        let script = dir.appendingPathComponent("fake.sh")
        let passwordLine = emitPasswordOnce
            ? """
              if [ ! -f '\(marker.path)' ]; then
                echo 'Operator password (shown ONCE): abcdefghijklmnopqrstuvwxyz012345'
                touch '\(marker.path)'
              fi
              """
            : ""
        let body = "#!/bin/sh\n\(passwordLine)\nsleep 100\n"
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return LocalServerLaunch(
            executable: URL(fileURLWithPath: "/bin/sh"), arguments: [script.path],
            workingDirectory: dir, environment: ["PATH": "/usr/bin:/bin"])
    }

    /// Writes a `/bin/sh` script that prints the boot line only after
    /// `delayMillis` of real sleep, so `act()`'s single post-`start()` read of
    /// `capturedPassword` reliably misses it (V1) — a real bun boot line
    /// reaching the pump loses that race in practice too, health being a
    /// loopback HTTP round trip.
    private func fakeScriptWithDelayedPassword(in dir: URL, delayMillis: Int) throws -> LocalServerLaunch {
        let script = dir.appendingPathComponent("fake-late.sh")
        let body = """
            #!/bin/sh
            sleep \(Double(delayMillis) / 1000.0)
            echo 'Operator password (shown ONCE): late0123456789abcdefghijklmnop'
            sleep 100
            """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return LocalServerLaunch(
            executable: URL(fileURLWithPath: "/bin/sh"), arguments: [script.path],
            workingDirectory: dir, environment: ["PATH": "/usr/bin:/bin"])
    }

    /// Yields until `condition` holds or the budget runs out. Everything under
    /// test here is main-actor work a yield lets run, so there is nothing to
    /// sleep for. Pattern: `settle` in AppModelTests.swift, kept local since
    /// that one is `private` to its own file.
    private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
        for _ in 0..<yields {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }

    @Test func aMissingCheckoutReadsAsNotInstalled() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { false })
        await model.refresh()
        #expect(model.state == .notInstalled)
        #expect(model.canInstall)
    }

    @Test func aCheckoutWithNoRunningServerReadsAsStopped() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(environment: try checkout(in: home), probeExternal: { false })
        await model.refresh()
        #expect(model.state == .stopped)
        #expect(model.canStart)
    }

    /// A server we did not start must never be stoppable from this panel.
    @Test func somethingAlreadyOnPort7330IsExternallyManaged() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { true })
        await model.refresh()
        #expect(model.state == .externallyManaged)
        #expect(model.canStop == false)
    }

    @Test func everyStateHasACatalogSentence() {
        let states: [LocalServerState] = [
            .notInstalled, .installing, .stopped, .starting, .running(pid: 42), .externallyManaged,
            .failed(.bunMissing), .failed(.notAShepherdCheckout(path: "/tmp/x")),
            .failed(.installFailed(exitCode: 3)), .failed(.exited(code: 1)),
            .failed(.crashLoop(restarts: 3)), .failed(.healthTimeout),
        ]
        for state in states {
            let text = LocalServerCopy.label(for: state)
            #expect(!text.isEmpty)
            #expect(text.hasPrefix("native_local_") == false)  // a leaked key = missing catalog entry
        }
    }

    /// Offered once, then dropped — never written anywhere that outlives the panel.
    @Test func connectingHandsThePasswordToTheLoginSheetExactlyOnce() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let app = freshApp()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { false })
        model.setCapturedPasswordForTesting("Zx9_test-password-abcdefgh")

        model.connect(app)
        #expect(app.sheet == .login(app.addLocalProfile()))
        #expect(model.capturedPassword == nil)
        #expect(model.takePendingPassword() == "Zx9_test-password-abcdefgh")
        #expect(model.takePendingPassword() == nil)
    }

    @Test func installingTheFeatureFillsTheWelcomeSlotAndIsIdempotent() {
        WelcomeSlots.localPanel = nil
        let app = freshApp()
        LocalServerFeature.install(app)
        #expect(WelcomeSlots.localPanel != nil)
        LocalServerFeature.install(app)
        #expect(WelcomeSlots.localPanel != nil)
        WelcomeSlots.reset()
    }

    /// Task 7's deviation: Task 6 left `app.register(LocalServerSessionExtension.self)`
    /// out of `install()` because the panel it gates did not exist yet.
    @Test func installingTheFeatureRegistersTheSessionExtensionType() {
        let app = freshApp()
        LocalServerFeature.install(app)
        #expect(app.extensionFactories.contains { $0.key == ObjectIdentifier(LocalServerSessionExtension.self) })
        WelcomeSlots.reset()
    }

    // MARK: - Review fixes (H1, H2, Medium — see task-7-report.md)

    /// H1: a `restart()` that mints no new password used to re-copy the
    /// *already consumed* one back into `capturedPassword`, because `act()`
    /// read the supervisor's copy without ever clearing it — so it sat there
    /// to be re-read by every later action, `connect()`'s own
    /// `capturedPassword = nil` notwithstanding.
    @Test func restartDoesNotResurrectAPasswordAlreadyHandedToConnect() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: true)
        let app = freshApp()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            probeExternal: { false },
            // A small delay, not an instant `true`: the boot line reaches
            // `capturedPassword` through the supervisor's output pump, a
            // concurrent `Task` racing this closure. A real health check hits
            // a network round trip and loses that race in practice; an
            // instant stub here would not. `act()` reads `capturedPassword`
            // exactly once, right after `start()` returns — pattern:
            // `theGeneratedPasswordIsCapturedAndRedacted` in
            // LocalServerSupervisorTests.swift, which polls with `waitUntil`
            // for the same reason.
            health: { try? await Task.sleep(for: .milliseconds(50)); return true },
            launch: { launch })

        await model.start()
        #expect(model.capturedPassword != nil)

        model.connect(app)
        #expect(model.capturedPassword == nil)

        await model.restart()
        #expect(model.capturedPassword == nil)
        guard case .running = model.state else {
            Issue.record("expected .running after restart, got \(model.state)")
            return
        }
    }

    /// H2: `install()`/`start()`/`stop()`/`restart()`/`act()` had no seam a
    /// unit test could drive — `init` hardcoded a real `LocalServerSupervisor`
    /// wired to the production `health`/`launch` closures. `health` is now
    /// gated so this test can observe `busy` while the transition is
    /// genuinely in flight, not just before and after.
    @Test func startKeepsBusyTrueUntilHealthResolvesThenTransitionsToRunning() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let gate = LocalServerGate()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            probeExternal: { false },
            health: { await gate.wait(); return true },
            launch: { launch })

        #expect(model.busy == false)
        let task = Task { await model.start() }
        #expect(await settle(until: { model.busy }))
        #expect(model.canStart == false)  // every action is gated while busy
        #expect(model.canInstall == false)

        await gate.open()
        await task.value

        #expect(model.busy == false)
        guard case .running = model.state else {
            Issue.record("expected .running, got \(model.state)")
            return
        }

        await model.stop()
        #expect(model.state == .stopped)
        #expect(model.busy == false)
    }

    /// H2, continued: a second `start()` racing the first must be a no-op —
    /// the busy guard, not the supervisor's own lifecycle gate, is what this
    /// model-level test exercises.
    @Test func aSecondStartWhileBusyIsANoOp() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let gate = LocalServerGate()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            probeExternal: { false },
            health: { await gate.wait(); return true },
            launch: { launch })

        let first = Task { await model.start() }
        #expect(await settle(until: { model.busy }))

        await model.start()  // parked behind `guard !busy else { return }`
        if case .running = model.state {
            Issue.record("a second start() while busy must not itself resolve to .running")
        }

        await gate.open()
        await first.value
        guard case .running = model.state else {
            Issue.record("expected .running once the first start() completed, got \(model.state)")
            return
        }
    }

    /// Medium: `refresh()` used to write `state` unconditionally, so a refresh
    /// still in flight when `start()` landed and finished could resume
    /// afterwards and stomp the newer `.running` state back down to whatever
    /// the probe/supervisor reported before `start()` ran.
    @Test func aStaleRefreshCannotOverwriteANewerStartedState() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let gate = LocalServerGate()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            // Nothing is running yet when this refresh starts, so it falls
            // through to the loopback probe — held open here so the refresh
            // is still in flight once `start()` below has already finished.
            probeExternal: { await gate.wait(); return false },
            health: { true },
            launch: { launch })

        let refreshTask = Task { await model.refresh() }
        var parked = false
        for _ in 0..<500 {
            if await gate.isWaiting { parked = true; break }
            await Task.yield()
        }
        #expect(parked)  // the refresh is parked in the probe, not resolved yet

        await model.start()
        guard case .running = model.state else {
            Issue.record("expected .running before the stale refresh resumes, got \(model.state)")
            return
        }

        await gate.open()
        await refreshTask.value

        guard case .running = model.state else {
            Issue.record("a stale refresh overwrote the running state with \(model.state)")
            return
        }
    }

    // MARK: - Task 7 fix wave (see task-7-fix-brief.md)

    /// V1 (high): `act()` used to read `supervisor.capturedPassword` exactly
    /// once, right after `start()` returned. A boot line that reaches the pump
    /// *after* that read — plausible any time health resolves before the
    /// child has flushed its first line — was silently lost forever. Every
    /// later read that drains the log (`pullLog()`, and therefore `refresh()`
    /// too) must also pick it up.
    @Test func aLatePasswordLineStillSurfacesAfterHealthResolves() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScriptWithDelayedPassword(in: home, delayMillis: 150)
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            probeExternal: { false },
            health: { true },  // resolves immediately — well before the boot line
            launch: { launch })

        await model.start()
        #expect(model.capturedPassword == nil)  // the boot line has not landed yet
        guard case .running = model.state else {
            Issue.record("expected .running, got \(model.state)")
            return
        }

        var found = false
        for _ in 0..<40 {
            await model.refresh()
            if model.capturedPassword != nil { found = true; break }
            try? await Task.sleep(for: .milliseconds(20))
        }
        #expect(found)
        #expect(model.capturedPassword?.hasPrefix("late") == true)
    }

    /// M-1 (medium): `refresh()` used to write `state` unconditionally, so a
    /// `.task` refresh landing mid-install (e.g. the panel reappearing) could
    /// resolve to "not a checkout"/"stopped" and stomp `.installing` back
    /// down while the installer was still genuinely running.
    @Test func refreshDuringAnInstallCannotOverwriteInstallingState() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let gate = LocalServerGate()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            probeExternal: { false }, launch: { nil },
            installer: { _, _ in await gate.wait(); return .success(()) })

        let installTask = Task { await model.install() }
        #expect(await settle(until: { model.busy }))
        #expect(model.state == .installing)

        await model.refresh()  // must be a no-op while busy
        #expect(model.state == .installing)

        await gate.open()
        await installTask.value
    }

    /// M-4 (medium): `capturedPassword` is now production-write-only —
    /// draining the supervisor is the one path allowed to set it. This
    /// exercises `dismissCapturedPassword()`, the panel's dismiss (X) and its
    /// one-shot Copy both route through it, using the `#if DEBUG` seam to set
    /// up the notice without spinning up a real child.
    @Test func dismissingTheCapturedPasswordClearsItWithoutConsumingIt() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { false })
        model.setCapturedPasswordForTesting("Zx9_test-password-abcdefgh")

        model.dismissCapturedPassword()

        #expect(model.capturedPassword == nil)
        // Dismissing is not the same as connecting: no pending password is
        // handed to the login sheet.
        #expect(model.takePendingPassword() == nil)
    }

    // MARK: - Final whole-branch review (C2, I2)

    @Test func aSuccessfulInstallStartsThroughTheSupervisorAndShowsProgressBeforeFinishing() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let gate = LocalServerGate()
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { false },
            health: { true }, launch: { launch },
            installer: { _, log in
                await log.append("fixture installer progress")
                await gate.wait()
                return .success(())
            })
        let task = Task { await model.install() }
        for _ in 0..<50 {
            if model.logLines.contains("fixture installer progress") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(model.state == .installing)
        #expect(model.logLines.contains("fixture installer progress"))
        await gate.open()
        await task.value
        #expect(model.busy == false)
        #expect(model.state.isRunning)
        await model.stop()
    }

    @Test func connectingUsesTheConfiguredPortAndDoesNotReuseAnotherEndpointsCredential() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let app = freshApp()
        let original = app.addLocalProfile()
        let model = LocalServerModel(environment: LocalServerEnvironment(home: home,
            processEnvironment: ["SHEPHERD_PORT": "7349"]), probeExternal: { true })
        await model.refresh()
        model.acknowledgeExternalServer()
        model.connect(app)
        guard case .login(let profile) = app.sheet else { Issue.record("expected login"); return }
        #expect(profile.baseURL.absoluteString == "http://127.0.0.1:7349")
        #expect(profile.credentialKey != original.credentialKey)
        model.connect(app)
        #expect(app.sheet == .login(profile))
    }

    @Test func externalAcknowledgmentIsResetWhenIdentityChangesOrDisappears() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let reply = Mutex<Components.Schemas.Health?>(.init(ok: true, version: "1", localInstall: .init(
            appDirectory: "/external", databasePath: "/external.db", instanceID: "first")))
        let model = LocalServerModel(environment: LocalServerEnvironment(home: home),
                                     discoverExternal: { reply.withLock { $0 } })
        await model.refresh()
        #expect(model.state == .externallyManaged)
        #expect(model.externalIdentity?.databasePath == "/external.db")
        #expect(!model.externalAcknowledged)
        model.acknowledgeExternalServer()
        await model.refresh()
        #expect(model.externalAcknowledged)
        reply.withLock { $0?.localInstall?.instanceID = "replacement" }
        await model.refresh()
        #expect(!model.externalAcknowledged)
        model.acknowledgeExternalServer()
        reply.withLock { $0 = nil }
        await model.refresh()
        #expect(!model.externalAcknowledged)
        #expect(model.externalIdentity == nil)
        reply.withLock { $0 = .init(ok: true, version: "old") }
        await model.refresh()
        #expect(model.state == .externallyManaged)
        #expect(model.externalIdentity == nil)
        #expect(!model.externalAcknowledged)
    }

    /// I2: the panel fired `Task { await model.install() }` and dropped the
    /// handle, so `terminateForQuit()` — which only reaches the supervisor's
    /// child — left `install.sh` and its whole subtree running after the app
    /// had gone, still mutating ~/.shepherd/app. Relaunching and pressing
    /// Install again then raced two installers over the same checkout.
    @Test func quittingMidInstallCancelsTheInstaller() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let cancelled = Mutex(false)
        // Stands in for `InstallerRun`, whose own `withTaskCancellationHandler`
        // is what signals `install.sh`. `running` is how the test knows the
        // handler is installed before it cancels — otherwise the cancel lands
        // in the window before the installer has even been entered, and proves
        // nothing about the handler.
        let running = Mutex(false)
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home),
            probeExternal: { false },
            installer: { _, _ in
                await withTaskCancellationHandler {
                    running.withLock { $0 = true }
                    for _ in 0..<500 where !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(20))
                    }
                    return .failure(.installFailed(exitCode: 130))
                } onCancel: {
                    cancelled.withLock { $0 = true }
                }
            })

        model.beginInstall()  // the panel's Install button
        #expect(await settle(until: { model.busy && running.withLock { $0 } }))
        #expect(model.state == .installing)

        model.cancelInstallForQuit()  // applicationWillTerminate

        #expect(cancelled.withLock { $0 })  // `onCancel` runs synchronously
        #expect(await settle(until: { !model.busy }))
    }
}
}
