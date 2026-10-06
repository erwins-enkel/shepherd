import Foundation
import Synchronization
import Testing
@testable import ShepherdKit
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

/// Cancellable ticks let the monitor run without wall-clock waits.
actor LocalUpdateMonitorClock: SupervisorClock {
    private let ticks = AsyncStream<Void>.makeStream()
    private(set) var sleeps: [TimeInterval] = []
    var now: Date { Date(timeIntervalSince1970: 0) }
    func sleep(for seconds: TimeInterval) async throws {
        sleeps.append(seconds)
        var iterator = ticks.stream.makeAsyncIterator()
        guard await iterator.next() != nil else { throw CancellationError() }
        try Task.checkCancellation()
    }
    func tick() { ticks.continuation.yield(()) }
}

private struct ImmediateUpdateHealthClock: SupervisorClock {
    var now: Date { Date() }
    func sleep(for seconds: TimeInterval) async throws { await Task.yield() }
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
        let environment = LocalServerEnvironment(home: home, processEnvironment: [:])
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

    private func waitForGate(_ gate: LocalServerGate) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if await gate.isWaiting { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
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

    /// `act()` drains the supervisor's captured password once, when its
    /// lifecycle turn ends; a boot line still on the pump then only surfaces
    /// through a later `refresh()` → `pullLog()`. Polls that, bounded by
    /// wall-clock so a slow runner gets time instead of a fixed budget.
    private func refreshUntilPasswordCaptured(
        _ model: LocalServerModel, timeout: Duration = .seconds(10)
    ) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            await model.refresh()
            if model.capturedPassword != nil { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return model.capturedPassword != nil
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

    @Test func upgradingBunStartsTheSupervisorAndPullsTheLog() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let gate = LocalServerGate()
        let model = LocalServerModel(
            environment: try checkout(in: home), probeExternal: { false }, health: { true }, launch: { launch },
            bunUpgrader: { _, log in
                await gate.wait()
                await log.append("Bun updated")
                return .success("1.4.2")
            })
        let task = Task { await model.upgradeBun() }
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await gate.isWaiting), ContinuousClock.now < deadline { await Task.yield() }
        #expect(model.busy)
        #expect(model.state == .upgradingBun)
        await model.refresh()
        #expect(model.state == .upgradingBun)
        await gate.open()
        await task.value
        #expect(model.state.isRunning)
        #expect(model.logLines.contains("Bun updated"))
        #expect(!model.busy)
        await model.stop()
    }

    @Test func aFailedBunUpgradeDoesNotSpawnAndAllowsRetry() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launches = Mutex(0)
        let model = LocalServerModel(
            environment: try checkout(in: home), probeExternal: { false },
            launch: { launches.withLock { $0 += 1 }; return nil },
            bunUpgrader: { _, _ in .failure(.bunUpgradeFailed(exitCode: 3)) })
        await model.upgradeBun()
        #expect(model.state == .failed(.bunUpgradeFailed(exitCode: 3)))
        await model.refresh()
        #expect(model.state == .failed(.bunUpgradeFailed(exitCode: 3)))
        #expect(launches.withLock { $0 } == 0)
        #expect(!model.busy)
        #expect(LocalServerPanelState(state: model.state, busy: model.busy).canUpgradeBun)
    }

    @Test func quitCancelsTheKeptBunUpgradeTask() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let entered = Mutex(false)
        let cancelled = Mutex(false)
        let model = LocalServerModel(
            environment: try checkout(in: home), probeExternal: { false },
            bunUpgrader: { _, _ in
                await withTaskCancellationHandler {
                    entered.withLock { $0 = true }
                    do { try await Task.sleep(for: .seconds(30)) } catch {}
                    return .failure(.bunUpgradeFailed(exitCode: 130))
                } onCancel: { cancelled.withLock { $0 = true } }
            })
        model.beginBunUpgrade()
        #expect(await settle { entered.withLock { $0 } })
        model.cancelBunUpgradeForQuit()
        #expect(cancelled.withLock { $0 })
        #expect(await settle { !model.busy })
        #expect(!model.state.isRunning)
    }

    @Test func applyingUpdateRestartsARunningServerAndRechecks() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let launches = Mutex(0)
        let checks = Mutex(0)
        let gate = LocalServerGate()
        let model = LocalServerModel(
            environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false }, health: { true },
            launch: { launches.withLock { $0 += 1 }; return launch },
            updateChecker: { _ in
                checks.withLock { $0 += 1 }
                return .success(.init(behind: 0, current: "def5678", latest: "def5678"))
            }, updater: { _, log in
                await gate.wait()
                await log.append("Backend rebuilt")
                return .success(())
            })
        await model.start()
        let oldPID = try #require(model.state.pid)
        let task = Task { await model.applyUpdate() }
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await gate.isWaiting), ContinuousClock.now < deadline { await Task.yield() }
        #expect(model.state == .updating && model.busy)
        await model.refresh()
        #expect(model.state == .updating)
        await gate.open()
        await task.value
        #expect(model.state.isRunning)
        #expect(model.state.pid != oldPID)
        #expect(launches.withLock { $0 } == 2)
        #expect(checks.withLock { $0 } == 1)
        #expect(model.updateStatus?.behind == 0)
        #expect(model.logLines.contains("Backend rebuilt"))
        #expect(!model.busy)
        await model.stop()
    }

    @Test func applyingUpdateToAStoppedServerDoesNotStartIt() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launches = Mutex(0)
        let model = LocalServerModel(
            environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            launch: { launches.withLock { $0 += 1 }; return nil },
            updateChecker: { _ in .success(.init(behind: 0, current: "abcd123", latest: "abcd123")) },
            updater: { _, _ in .success(()) })
        await model.applyUpdate()
        #expect(model.state == .stopped)
        #expect(launches.withLock { $0 } == 0)
        #expect(model.updateStatus?.behind == 0)
    }

    @Test func failedUpdateKeepsTheOldServerAndFailureVisibleAcrossRefresh() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let launches = Mutex(0)
        let model = LocalServerModel(
            environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false }, health: { true },
            launch: { launches.withLock { $0 += 1 }; return launch },
            updateChecker: { _ in .failure(.commandFailed(exitCode: 7)) },
            updater: { _, log in
                await log.append("--pull needs a clean tree")
                return .failure(.updateFailed(exitCode: 1))
            })
        await model.start()
        await model.applyUpdate()
        #expect(model.state.isRunning)
        #expect(model.updateFailure == .updateFailed(exitCode: 1))
        await model.refresh()
        #expect(model.state.isRunning)
        #expect(model.updateFailure == .updateFailed(exitCode: 1))
        #expect(launches.withLock { $0 } == 1)
        #expect(model.logLines.contains("--pull needs a clean tree"))
        #expect(!model.canInstall)
        await model.stop()
    }

    @Test func refreshThrottlesChecksForThirtyMinutesButManualCheckForcesThem() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let checks = Mutex(0)
        let now = Mutex(Date(timeIntervalSince1970: 1000))
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updateChecker: { _ in
                checks.withLock { $0 += 1 }
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            }, updateNow: { now.withLock { $0 } })
        await model.refresh()
        await model.refresh()
        #expect(checks.withLock { $0 } == 1)
        now.withLock { $0 += 1799 }
        await model.refresh()
        #expect(checks.withLock { $0 } == 1)
        now.withLock { $0 += 1 }
        await model.refresh()
        #expect(checks.withLock { $0 } == 2)
        await model.checkForUpdate()
        #expect(checks.withLock { $0 } == 3)
    }

    @Test func backgroundMonitorChecksAtLaunchOnTimerAndWakeWithoutAPanel() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let checks = Mutex(0)
        let now = Mutex(Date(timeIntervalSince1970: 1000))
        let clock = LocalUpdateMonitorClock()
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updateChecker: { _ in
                checks.withLock { $0 += 1 }
                return .success(.init(behind: 9, current: "abc1234", latest: "def5678"))
            }, updateNow: { now.withLock { $0 } }, updateMonitorClock: clock)
        defer { model.cancelUpdateForQuit() }
        model.startUpdateMonitoring()
        model.startUpdateMonitoring() // Multiple windows must not double the timer.
        let deadline = ContinuousClock.now + .seconds(5)
        while await clock.sleeps.count < 1, ContinuousClock.now < deadline { await Task.yield() }
        #expect(await clock.sleeps == [1800])
        #expect(checks.withLock { $0 } == 1)
        #expect(model.updateStatus?.behind == 9)
        await model.refresh() // Wake within the throttle window.
        #expect(checks.withLock { $0 } == 1)
        now.withLock { $0 += 1800 }
        await clock.tick()
        while await clock.sleeps.count < 2, ContinuousClock.now < deadline { await Task.yield() }
        #expect(await clock.sleeps == [1800, 1800])
        #expect(checks.withLock { $0 } == 2)
        now.withLock { $0 += 1800 }
        await model.refresh() // Wake after enough time elapsed.
        #expect(checks.withLock { $0 } == 3)
        model.cancelUpdateForQuit()
        await clock.tick()
        await Task.yield()
        #expect(checks.withLock { $0 } == 3)
    }

    @Test func quittingCancelsABackgroundCheckAndCannotPublishItsResult() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let started = Mutex(false)
        let cancelled = Mutex(false)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updateChecker: { _ in
                started.withLock { $0 = true }
                do { try await Task.sleep(for: .seconds(60)) }
                catch { cancelled.withLock { $0 = true } }
                return .success(.init(behind: 9, current: "abc1234", latest: "def5678"))
            })
        model.startUpdateMonitoring()
        #expect(await settle { started.withLock { $0 } })
        model.cancelUpdateForQuit()
        #expect(await settle { cancelled.withLock { $0 } && !model.isCheckingUpdate })
        #expect(model.updateStatus == nil)
    }

    @Test func failedCheckIsQuietAndAlsoThrottled() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let checks = Mutex(0)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updateChecker: { _ in checks.withLock { $0 += 1 }; return .failure(.commandFailed(exitCode: 7)) })
        await model.refresh()
        await model.refresh()
        #expect(model.state == .stopped)
        #expect(model.updateCheckFailure == .commandFailed(exitCode: 7))
        #expect(checks.withLock { $0 } == 1)
    }

    @Test func externalAndMissingServersNeverCheckOrApplyUpdates() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let calls = Mutex(0)
        for external in [false, true] {
            let environment = external ? try checkout(in: home) : LocalServerEnvironment(home: home)
            let model = LocalServerModel(environment: environment, probeExternal: { external },
                updateChecker: { _ in calls.withLock { $0 += 1 }; return .failure(.invalidOutput) },
                updater: { _, _ in calls.withLock { $0 += 1 }; return .success(()) })
            await model.refresh()
            await model.checkForUpdate()
            await model.applyUpdate()
            #expect(!model.canManageUpdates)
        }
        #expect(calls.withLock { $0 } == 0)
    }

    @Test func staleCheckCannotLandAfterALifecycleAction() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let gate = LocalServerGate()
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updateChecker: { _ in
                await gate.wait()
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            })
        let check = Task { await model.checkForUpdate() }
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await gate.isWaiting), ContinuousClock.now < deadline { await Task.yield() }
        await model.stop()
        await gate.open()
        await check.value
        #expect(model.updateStatus == nil)
        #expect(!model.isCheckingUpdate)
    }

    @Test func quitCancelsTheKeptUpdateTask() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let entered = Mutex(false)
        let cancelled = Mutex(false)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updater: { _, _ in
                await withTaskCancellationHandler {
                    entered.withLock { $0 = true }
                    do { try await Task.sleep(for: .seconds(30)) } catch {}
                    return .failure(.updateFailed(exitCode: 130))
                } onCancel: { cancelled.withLock { $0 = true } }
            })
        model.beginUpdate()
        #expect(await settle { entered.withLock { $0 } })
        model.cancelUpdateForQuit()
        #expect(cancelled.withLock { $0 })
        #expect(await settle { !model.busy })
        #expect(!model.state.isRunning)
    }

    @Test func quitCancelsTheKeptCheckTask() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let entered = Mutex(false)
        let cancelled = Mutex(false)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true, probeExternal: { false },
            updateChecker: { _ in
                await withTaskCancellationHandler {
                    entered.withLock { $0 = true }
                    do { try await Task.sleep(for: .seconds(30)) } catch {}
                    return .failure(.commandFailed(exitCode: 130))
                } onCancel: { cancelled.withLock { $0 = true } }
            })
        let task = Task { await model.checkForUpdate() }
        #expect(await settle { entered.withLock { $0 } })
        model.cancelUpdateForQuit()
        #expect(cancelled.withLock { $0 })
        await task.value
        #expect(model.updateCheckFailure == nil)
        #expect(!model.isCheckingUpdate)
    }

    @Test func failedAndCancelledBuildsPreserveDeploymentAndDeferCrashRecovery() async throws {
        for cancelling in [false, true] {
            let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
            let environment = try checkout(in: home)
            let ui = environment.appDirectory.appendingPathComponent("ui/build")
            try FileManager.default.createDirectory(at: ui, withIntermediateDirectories: true)
            try "working UI".write(to: ui.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
            let code = environment.appDirectory.appendingPathComponent("code")
            try "previous".write(to: code, atomically: true, encoding: .utf8)
            let launch = try fakeScript(in: home, emitPasswordOnce: false)
            let versions = Mutex<[String]>([])
            let gate = LocalServerGate()
            let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
                probeExternal: { false }, health: { true },
                launch: {
                    versions.withLock { $0.append((try? String(contentsOf: code, encoding: .utf8)) ?? "missing") }
                    return launch
                }, updater: { staged, _ in
                    try! "broken".write(to: staged.appDirectory.appendingPathComponent("code"), atomically: true, encoding: .utf8)
                    try! FileManager.default.removeItem(at: staged.appDirectory.appendingPathComponent("ui/build"))
                    await gate.wait()
                    return .failure(.updateFailed(exitCode: 7))
                })
            await model.start()
            let pid = try #require(model.state.pid)
            let task = Task { await model.applyUpdate() }
            #expect(await waitForGate(gate))
            kill(pid, SIGKILL) // Only the temporary fixture child we own.
            try await Task.sleep(for: .milliseconds(200))
            #expect(versions.withLock { $0 } == ["previous"])
            #expect(try String(contentsOf: ui.appendingPathComponent("index.html"), encoding: .utf8) == "working UI")
            if cancelling { task.cancel() }
            await gate.open()
            await task.value
            #expect(model.state.isRunning)
            #expect(model.updateFailure == .updateFailed(exitCode: cancelling ? 130 : 7))
            #expect(versions.withLock { $0 } == ["previous", "previous"])
            #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
            #expect(try String(contentsOf: ui.appendingPathComponent("index.html"), encoding: .utf8) == "working UI")
            await model.stop()
        }
    }

    @Test func cancellationAfterPromotionRestoresPreviousDeploymentAndRunningChild() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let code = environment.appDirectory.appendingPathComponent("code")
        try "previous".write(to: code, atomically: true, encoding: .utf8)
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let launches = Mutex(0)
        let gate = LocalServerGate()
        let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            probeExternal: { false }, health: {
                if launches.withLock({ $0 }) == 2 { await gate.wait() }
                return true
            }, launch: { launches.withLock { $0 += 1 }; return launch },
            updater: { staged, _ in
                try! "replacement".write(to: staged.appDirectory.appendingPathComponent("code"), atomically: true, encoding: .utf8)
                return .success(())
            })
        await model.start()
        let task = Task { await model.applyUpdate() }
        #expect(await waitForGate(gate))
        #expect(try String(contentsOf: code, encoding: .utf8) == "replacement")
        task.cancel()
        await gate.open()
        await task.value
        #expect(model.state.isRunning)
        #expect(model.updateFailure == .updateFailed(exitCode: 130))
        #expect(launches.withLock { $0 } == 3)
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
        await model.stop()
    }

    @Test func launchRecoveryPrecedesServerStartupAndFailureBlocksIt() async throws {
        for invalid in [false, true] {
            let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
            let environment = try checkout(in: home)
            let code = environment.appDirectory.appendingPathComponent("code")
            try "previous".write(to: code, atomically: true, encoding: .utf8)
            var interrupted = try LocalUpdateDeployment(environment: environment)
            try "replacement".write(to: interrupted.environment.appDirectory.appendingPathComponent("code"),
                atomically: true, encoding: .utf8)
            try interrupted.promote()
            if invalid {
                try FileManager.default.removeItem(at: interrupted.environment.appDirectory)
            }
            let launch = try fakeScript(in: home, emitPasswordOnce: false)
            let versions = Mutex<[String]>([])
            let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
                probeExternal: { false }, health: { true }, launch: {
                    versions.withLock { $0.append((try? String(contentsOf: code, encoding: .utf8)) ?? "missing") }
                    return launch
                })
            await model.start()
            #expect(versions.withLock { $0 } == (invalid ? [] : ["previous"]))
            #expect(model.state.isRunning == !invalid)
            if invalid {
                #expect(model.state == .failed(.updateFailed(exitCode: 1)))
                #expect(!model.canStart && !model.canInstall && !model.canManageUpdates)
            }
            await model.stop()
        }
    }

    @Test func quitBetweenReplacementRunAndPublicationStopsChildAndRetainsRecoveryJournal() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let code = environment.appDirectory.appendingPathComponent("code")
        try "previous".write(to: code, atomically: true, encoding: .utf8)
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            probeExternal: { false }, health: { true }, launch: { launch },
            updater: { staged, _ in
                try! "replacement".write(to: staged.appDirectory.appendingPathComponent("code"), atomically: true, encoding: .utf8)
                return .success(())
            })
        let supervisor = model.testSupervisor
        defer { supervisor.terminateNow(gracePeriod: 0) }
        await model.start()
        let pausedPID = Mutex<Int32?>(nil)
        let release = DispatchSemaphore(value: 0)
        await supervisor.setTestSeamAfterChildRunWithPID { pid in
            pausedPID.withLock { $0 = pid }
            release.wait()
        }
        let update = Task { await model.applyUpdate() }
        for _ in 0..<500 where pausedPID.withLock({ $0 }) == nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        defer { release.signal() }
        let pid = try #require(pausedPID.withLock { $0 })
        #expect(try String(contentsOf: code, encoding: .utf8) == "replacement")
        #expect(kill(pid, 0) == 0)
        // Release only AFTER quit has fenced future lifecycle work. This runs
        // off the main actor, which synchronous quit teardown is allowed to block.
        let releaser = Task.detached {
            while !supervisor.testIsQuitting { await Task.yield() }
            release.signal()
        }
        model.cancelUpdateForQuit()
        #expect(kill(pid, 0) != 0)
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
        #expect(try LocalUpdateDeployment.needsServerRestart(environment: environment))
        update.cancel()
        await releaser.value
        await update.value
        // The cancelled update continuation must not erase the recovery fence.
        #expect(try LocalUpdateDeployment.needsServerRestart(environment: environment))
        #expect(!FileManager.default.fileExists(atPath: supervisor.recordURL.path))
        #expect(kill(pid, 0) != 0)
        // Launch recovery recognizes the already-restored directory and cleans up.
        try LocalUpdateDeployment.recover(environment: environment)
        #expect(!(try LocalUpdateDeployment.needsServerRestart(environment: environment)))
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
    }

    @Test func quitDuringReadinessSynchronouslyRestoresPreviousDeployment() async throws {
        try await exerciseQuitDuringReadiness(adopted: false)
    }

    @Test func quitDuringAdoptedServerPromotionStopsReplacementAndRestoresDeployment() async throws {
        try await exerciseQuitDuringReadiness(adopted: true)
    }

    private func exerciseQuitDuringReadiness(adopted: Bool) async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let code = environment.appDirectory.appendingPathComponent("code")
        try "previous".write(to: code, atomically: true, encoding: .utf8)
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let launches = Mutex(0)
        let gate = LocalServerGate()
        var first: LocalServerSupervisor?
        defer { first?.terminateNow(gracePeriod: 0) }
        let discovered: Components.Schemas.Health?
        if adopted {
            let previous = LocalServerSupervisor(environment: environment, health: { true },
                launch: { launches.withLock { $0 += 1 }; return launch })
            first = previous
            await previous.start()
            previous.terminateForQuit()
            discovered = try ownedHealth(in: home)
        } else { discovered = nil }
        let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            discoverExternal: { discovered }, health: {
                if launches.withLock({ $0 }) == 2 { await gate.wait() }
                return true
            }, launch: { launches.withLock { $0 += 1 }; return launch },
            updater: { staged, _ in
                try! "replacement".write(to: staged.appDirectory.appendingPathComponent("code"), atomically: true, encoding: .utf8)
                return .success(())
            })
        if adopted { await model.refresh() }
        else { await model.start() }
        let task = Task { await model.applyUpdate() }
        #expect(await waitForGate(gate))
        #expect(try String(contentsOf: code, encoding: .utf8) == "replacement")
        model.cancelUpdateForQuit()
        // No await: the previous deployment must already be live at return.
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
        task.cancel()
        await gate.open()
        await task.value
        #expect(!model.state.isRunning)
        #expect(model.updateFailure == .updateFailed(exitCode: 130))
        #expect(launches.withLock { $0 } == 2)
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
        await model.stop()
    }

    @Test func failedReplacementReadinessRollsBackAndRestartsThePreviousDeployment() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let code = environment.appDirectory.appendingPathComponent("code")
        try "previous".write(to: code, atomically: true, encoding: .utf8)
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let launches = Mutex(0)
        let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            probeExternal: { false }, health: { launches.withLock { $0 } != 2 },
            launch: { launches.withLock { $0 += 1 }; return launch },
            updater: { staged, _ in
                try! "replacement".write(to: staged.appDirectory.appendingPathComponent("code"), atomically: true, encoding: .utf8)
                return .success(())
            }, clock: ImmediateUpdateHealthClock())
        await model.start()
        await model.applyUpdate()
        #expect(model.state.isRunning)
        #expect(model.updateFailure == .updateFailed(exitCode: 1))
        #expect(launches.withLock { $0 } == 3)
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
        await model.stop()
    }

    @Test func lifecycleInvalidationReleasesTheAutomaticCheckThrottle() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let gate = LocalServerGate()
        let checks = Mutex(0)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true,
            probeExternal: { false }, updateChecker: { _ in
                checks.withLock { $0 += 1 }
                await gate.wait()
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            })
        let first = Task { await model.automaticRefresh() }
        #expect(await waitForGate(gate))
        await model.stop()
        await gate.open()
        await first.value
        #expect(model.updateStatus == nil)
        await model.automaticRefresh()
        #expect(checks.withLock { $0 } == 2)
        #expect(model.updateStatus?.behind == 2)
    }

    @Test func isolatedModelRejectsEveryUpdateEntryPointWithoutExplicitTemporaryOptIn() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let calls = Mutex(0)
        let model = LocalServerModel(environment: try checkout(in: home), isolated: true,
            probeExternal: { false },
            updateChecker: { _ in calls.withLock { $0 += 1 }; return .failure(.invalidOutput) },
            updater: { _, _ in calls.withLock { $0 += 1 }; return .success(()) })
        await model.refresh()
        await model.checkForUpdate()
        await model.checkForUpdate(force: false)
        await model.automaticRefresh()
        await model.applyUpdate()
        model.beginUpdate()
        model.startUpdateMonitoring()
        await Task.yield()
        #expect(!model.canManageUpdates)
        #expect(calls.withLock { $0 } == 0)
        // This only constructs a value; never reads or writes the real checkout.
        let real = LocalServerModel(environment: LocalServerEnvironment(home: home, processEnvironment: ["SHEPHERD_DIR": "/outside-temporary-home/app"]),
            isolated: true, allowTemporaryUpdates: true, probeExternal: { false })
        #expect(!real.canManageUpdates)
    }

    @Test func remoteProfileCancelsAutomaticFetchAndAllowsRetryOnReturnToLocal() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let gate = LocalServerGate()
        let checks = Mutex(0)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true,
            probeExternal: { false }, updateChecker: { _ in
                checks.withLock { $0 += 1 }
                await gate.wait()
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            })
        let pending = Task { await model.automaticRefresh() }
        #expect(await waitForGate(gate))
        model.updateActiveProfile(ServerProfile(name: "Remote", baseURL: URL(string: "https://remote.invalid")!, mode: .remote))
        await gate.open()
        await pending.value
        #expect(model.updateStatus == nil)
        await model.refresh()
        await model.automaticRefresh()
        #expect(checks.withLock { $0 } == 1)
        model.updateActiveProfile(nil)
        await model.automaticRefresh()
        #expect(checks.withLock { $0 } == 2)
        #expect(model.updateStatus?.behind == 2)
    }

    @Test func remoteProfileSkipsMonitorTicksAndWakeChecks() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let remote = ServerProfile(name: "Remote", baseURL: URL(string: "https://remote.invalid")!, mode: .remote)
        let selected = Mutex<ServerProfile?>(remote)
        let checks = Mutex(0)
        let clock = LocalUpdateMonitorClock()
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true,
            probeExternal: { false }, updateChecker: { _ in
                checks.withLock { $0 += 1 }
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            }, updateMonitorClock: clock)
        defer { model.cancelUpdateForQuit() }
        model.bindAutomaticProfile { selected.withLock { $0 } }
        model.startUpdateMonitoring()
        let deadline = ContinuousClock.now + .seconds(5)
        while await clock.sleeps.count < 1, ContinuousClock.now < deadline { await Task.yield() }
        await clock.tick()
        while await clock.sleeps.count < 2, ContinuousClock.now < deadline { await Task.yield() }
        await model.automaticRefresh()
        #expect(checks.withLock { $0 } == 0)
        selected.withLock { $0 = nil }
        await clock.tick()
        while await clock.sleeps.count < 3, ContinuousClock.now < deadline { await Task.yield() }
        #expect(checks.withLock { $0 } == 1)
        // A profile change is gated immediately, even before its observer runs.
        selected.withLock { $0 = remote }
        await model.automaticRefresh()
        #expect(checks.withLock { $0 } == 1)
    }

    @Test func overlappingPanelRefreshRetainsTheSharedFetchResultAndThrottle() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let gate = LocalServerGate()
        let checks = Mutex(0)
        let model = LocalServerModel(environment: try checkout(in: home), allowTemporaryUpdates: true,
            probeExternal: { false }, updateChecker: { _ in
                checks.withLock { $0 += 1 }
                await gate.wait()
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            })
        let first = Task { await model.automaticRefresh() }
        #expect(await waitForGate(gate))
        await model.refresh()
        await gate.open()
        await first.value
        await model.refresh()
        #expect(model.updateStatus?.behind == 2)
        #expect(checks.withLock { $0 } == 1)
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

    @Test func everyBackendUpdateStateHasACatalogSentence() {
        for state in [LocalServerState.updating, .failed(.updateFailed(exitCode: 1))] {
            let text = LocalServerCopy.label(for: state)
            #expect(!text.isEmpty && !text.hasPrefix("native_local_"))
        }
    }

    @Test func everyBunUpgradeStateHasACatalogSentence() {
        let states: [LocalServerState] = [
            .upgradingBun, .failed(.bunOutdated(version: "1.3.1")), .failed(.bunUpgradeFailed(exitCode: 3)),
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
            // The boot line can still be on the pump when `start()` returns;
            // `refreshUntilPasswordCaptured` re-drains until it lands.
            health: { true },
            launch: { launch })

        await model.start()
        #expect(await refreshUntilPasswordCaptured(model))

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
        #expect(model.state == .starting)
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

        #expect(await refreshUntilPasswordCaptured(model))
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

    private func ownershipURL(in home: URL) throws -> URL {
        try #require(FileManager.default.contentsOfDirectory(
            at: home.appendingPathComponent(".shepherd/run"), includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix("app-server-") && $0.pathExtension == "json" })
    }

    private func ownedHealth(in home: URL) throws -> Components.Schemas.Health {
        let json = try #require(try JSONSerialization.jsonObject(
            with: Data(contentsOf: ownershipURL(in: home))) as? [String: Any])
        let identity = try #require(json["identity"] as? [String: String])
        return .init(ok: true, version: "test", localInstall: .init(
            appDirectory: try #require(identity["appDirectory"]),
            databasePath: try #require(identity["databasePath"]),
            instanceID: try #require(identity["instanceID"])))
    }

    @Test func adoptedServerShowsUpdateIndicatorAndApplyReplacesOwnership() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let first = LocalServerSupervisor(environment: environment, health: { true }, launch: { launch })
        defer { first.terminateNow(gracePeriod: 0) }
        await first.start()
        let pid = try #require(await first.state.pid)
        first.terminateForQuit()
        let health = try ownedHealth(in: home)
        let next = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            discoverExternal: { health }, health: { true }, launch: { launch },
            updateChecker: { _ in .success(.init(behind: 2, current: "abc1234", latest: "def5678")) },
            updater: { _, _ in .success(()) })
        defer {
            next.terminateForQuit()
            if let pid = next.state.pid { killpg(pid, SIGKILL) }
        }
        await next.refresh()
        #expect(next.state == .running(pid: pid))
        #expect(next.canManageUpdates)
        let profile = ServerProfile(name: "local", baseURL: next.baseURL, mode: .local)
        #expect(LocalBackendUpdateIndicatorState.count(profile: profile, endpoint: next.baseURL,
            state: next.state, managesUpdates: next.canManageUpdates, behind: next.updateStatus?.behind ?? 0) == 2)
        await next.applyUpdate()
        let replacement = try #require(next.state.pid)
        #expect(replacement != pid && kill(pid, 0) != 0)
        #expect(next.updateFailure == nil)
        let record = try #require(try JSONSerialization.jsonObject(
            with: Data(contentsOf: ownershipURL(in: home))) as? [String: Any])
        #expect((record["pid"] as? NSNumber)?.int32Value == replacement)
        #expect((record["processGroup"] as? NSNumber)?.int32Value == replacement)
        #expect(record["processStart"] != nil)
        // Detachment and re-adoption prove the replacement took #2823's path.
        next.terminateForQuit()
        let replacementHealth = try ownedHealth(in: home)
        let relaunched = LocalServerModel(environment: environment, discoverExternal: { replacementHealth },
            health: { true }, launch: { launch })
        await relaunched.refresh()
        #expect(relaunched.state == .running(pid: replacement))
        await relaunched.stop()
    }

    @Test func healthyLocalServerWithoutOwnershipNeverOffersUpdates() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let calls = Mutex(0)
        let health = Components.Schemas.Health(ok: true, version: "test", localInstall: .init(
            appDirectory: environment.appDirectory.path, databasePath: environment.databasePath.path, instanceID: "external"))
        let model = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            discoverExternal: { health }, updateChecker: { _ in
                calls.withLock { $0 += 1 }
                return .success(.init(behind: 2, current: "abc1234", latest: "def5678"))
            }, updater: { _, _ in calls.withLock { $0 += 1 }; return .success(()) })
        await model.refresh()
        await model.checkForUpdate()
        await model.applyUpdate()
        #expect(model.state == .externallyManaged && !model.canManageUpdates)
        #expect(calls.withLock { $0 } == 0)
        let profile = ServerProfile(name: "local", baseURL: model.baseURL, mode: .local)
        #expect(LocalBackendUpdateIndicatorState.count(profile: profile, endpoint: model.baseURL,
            state: model.state, managesUpdates: model.canManageUpdates, behind: 2) == nil)
    }

    @Test func unconfirmedDeploymentStopsHealthyOwnedServerBeforeRollbackAndAdoption() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let environment = try checkout(in: home)
        let code = environment.appDirectory.appendingPathComponent("code")
        try "previous".write(to: code, atomically: true, encoding: .utf8)
        var interrupted = try LocalUpdateDeployment(environment: environment)
        try "replacement".write(to: interrupted.environment.appDirectory.appendingPathComponent("code"),
            atomically: true, encoding: .utf8)
        try interrupted.promote()
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let first = LocalServerSupervisor(environment: environment, health: { true }, launch: { launch })
        defer { first.terminateNow(gracePeriod: 0) }
        await first.start()
        let pid = try #require(await first.state.pid)
        first.terminateForQuit()
        let health = try ownedHealth(in: home)
        let versions = Mutex<[String]>([])
        let next = LocalServerModel(environment: environment, allowTemporaryUpdates: true,
            discoverExternal: { health }, health: { true }, launch: {
                versions.withLock { $0.append((try? String(contentsOf: code, encoding: .utf8)) ?? "missing") }
                return launch
            }, updateChecker: { _ in .success(.init(behind: 0, current: "abc1234", latest: "abc1234")) })
        defer {
            next.terminateForQuit()
            if let pid = next.state.pid { killpg(pid, SIGKILL) }
        }
        await next.refresh()
        let replacement = try #require(next.state.pid)
        #expect(replacement != pid && kill(pid, 0) != 0)
        #expect(versions.withLock { $0 } == ["previous"])
        #expect(try String(contentsOf: code, encoding: .utf8) == "previous")
        #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent(".shepherd/run/backend-update.json").path))
        let record = try #require(try JSONSerialization.jsonObject(
            with: Data(contentsOf: ownershipURL(in: home))) as? [String: Any])
        #expect((record["pid"] as? NSNumber)?.int32Value == replacement)
        await next.stop()
    }

    @Test func quittingPreservesTheServerAndNextModelAdoptsBeforeExternalAcknowledgment() async throws {
        let home = try tempHome()
        var childPID: Int32?
        defer {
            if let childPID { killpg(childPID, SIGKILL) }
            try? FileManager.default.removeItem(at: home)
        }
        let environment = try checkout(in: home)
        let launch = try fakeScript(in: home, emitPasswordOnce: false)
        let first = LocalServerModel(environment: environment, probeExternal: { false },
                                     health: { true }, launch: { launch })
        await first.start()
        let pid = try #require(first.state.pid)
        childPID = pid
        first.terminateForQuit()
        let recordURL = try #require(FileManager.default.contentsOfDirectory(at: home.appendingPathComponent(".shepherd/run"), includingPropertiesForKeys: nil).first { $0.pathExtension == "json" })
        #expect(kill(pid, 0) == 0)
        let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: recordURL)) as? [String: Any])
        let identity = try #require(json["identity"] as? [String: String])
        let health = Components.Schemas.Health(ok: true, version: "test", localInstall: .init(
            appDirectory: try #require(identity["appDirectory"]),
            databasePath: try #require(identity["databasePath"]),
            instanceID: try #require(identity["instanceID"])))
        let next = LocalServerModel(environment: environment, discoverExternal: { health },
                                    health: { true }, launch: { launch })
        await next.refresh()
        #expect(next.state == .running(pid: pid))
        #expect(next.canStop && next.canRestart)
        #expect(next.externalIdentity == nil)
        #expect(next.capturedPassword == nil)
        await next.restart()
        let replacement = try #require(next.state.pid)
        childPID = replacement
        #expect(replacement != pid)
        #expect(kill(pid, 0) != 0)
        await next.stop()
        childPID = nil
        #expect(kill(replacement, 0) != 0)
        #expect(!FileManager.default.fileExists(atPath: recordURL.path))
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
