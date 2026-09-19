import Foundation
import Observation
import ShepherdKit

/// One catalog sentence per state. Next to the model rather than in the view so
/// the "every state is explained" test reaches it without SwiftUI.
enum LocalServerCopy {
    static func label(for state: LocalServerState) -> String {
        switch state {
        case .notInstalled: L.t("native_local_state_not_installed")
        case .installing: L.t("native_local_state_installing")
        case .stopped: L.t("native_local_state_stopped")
        case .starting: L.t("native_local_state_starting")
        case .running(let pid): L.t("native_local_state_running", String(pid))
        case .externallyManaged: L.t("native_local_state_external")
        case .failed(let failure): message(for: failure)
        }
    }

    static func message(for failure: LocalServerFailure) -> String {
        switch failure {
        case .bunMissing: L.t("native_local_error_bun_missing")
        case .notAShepherdCheckout(let path): L.t("native_local_error_not_checkout", path)
        case .installFailed(let code): L.t("native_local_error_install_failed", String(code))
        case .exited(let code): L.t("native_local_error_exited", String(code))
        case .crashLoop(let restarts): L.t("native_local_error_crash_loop", String(restarts))
        // Added to the kit after this stream's brief was written: the child is
        // up but never answered `/api/health`, which is not the same story as
        // an exit code and must not borrow `.exited`'s sentence.
        case .healthTimeout: L.t("native_local_error_health_timeout")
        }
    }
}

/// The Welcome panel's view model. App-lifetime, because the panel exists before
/// any profile is active and the child server must outlive an activation — an
/// `AppExtension` alone could not hold it (extensions are born with a store).
/// The per-store half lives in `LocalServerSessionExtension` below.
@Observable
@MainActor
final class LocalServerModel {
    static let shared = LocalServerModel()

    private(set) var state: LocalServerState = .stopped
    private(set) var logLines: [String] = []
    private(set) var busy = false
    /// In memory only, offered once, then dropped (D4): persisting the server's
    /// master password would make this app a second, weaker home for it.
    var capturedPassword: String?
    /// Read once by the login sheet's prefill.
    private(set) var pendingPassword: String?

    private let environment: LocalServerEnvironment
    private let log = LogRing(capacity: 500)
    /// `nonisolated` so the quit path can reach it without hopping to the main
    /// actor: `applicationWillTerminate` gets no await. Safe because the
    /// supervisor is an actor, hence `Sendable`.
    private nonisolated let supervisor: LocalServerSupervisor
    /// "Is something already answering on 7330?" — injected so tests need no
    /// loopback listener. Production reuses the app's existing `LocalServerProbe`.
    private let probeExternal: @Sendable () async -> Bool
    /// Bumped by every lifecycle action (`install`/`act`, i.e. start/stop/
    /// restart), so a `refresh()` already in flight when one of them begins
    /// cannot land afterwards and stomp the newer state back to whatever the
    /// probe or supervisor reported before the action ran. `refresh()` also
    /// bumps it on entry, so a second, later `refresh()` wins over a stale
    /// first one the same way. Pattern: `AppModel.activationGeneration`.
    private var generation = 0

    init(
        environment: LocalServerEnvironment = LocalServerEnvironment(),
        probeExternal: (@Sendable () async -> Bool)? = nil,
        health: (@Sendable () async -> Bool)? = nil,
        launch: (@Sendable () -> LocalServerLaunch?)? = nil,
        clock: any SupervisorClock = SystemSupervisorClock()
    ) {
        self.environment = environment
        self.probeExternal = probeExternal ?? {
            if case .found = await LocalServerProbe().probe() { return true }
            return false
        }
        let ring = log
        self.supervisor = LocalServerSupervisor(
            environment: environment, log: ring,
            health: health ?? { await LocalHealthCheck()() },
            clock: clock,
            launch: launch ?? LocalServerSupervisor.defaultLaunch(environment))
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }
    var canInstall: Bool { !busy && (state == .notInstalled || isFailed) }
    var canStart: Bool { !busy && (state == .stopped || isFailed) }
    var canStop: Bool { !busy && state.isRunning }
    var canRestart: Bool { !busy && state.isRunning }

    /// Order matters: a server we already supervise wins over the loopback probe,
    /// because the probe cannot tell our child from anyone else's.
    ///
    /// Every `await` below re-checks `generation` on the way back: a
    /// `start()`/`stop()`/`restart()`/`install()` landing mid-refresh bumps it,
    /// and this call must then drop its now-stale answer instead of writing it
    /// over the newer state that action already committed.
    func refresh() async {
        generation += 1
        let expected = generation
        let supervised = await supervisor.state
        guard generation == expected else { return }
        if supervised.isRunning || supervised == .starting {
            state = supervised
            await pullLog()
            return
        }
        let external = await probeExternal()
        guard generation == expected else { return }
        if external {
            state = .externallyManaged
            return
        }
        state = environment.isShepherdCheckout() ? .stopped : .notInstalled
        await pullLog()
    }

    func install() async {
        guard !busy else { return }
        busy = true
        generation += 1
        state = .installing
        defer { busy = false }
        let result = await InstallerRun(environment: environment, log: log).run()
        await pullLog()
        switch result {
        case .success: await refresh()
        case .failure(let failure): state = .failed(failure)
        }
    }

    func start() async { await act { await self.supervisor.start() } }
    func stop() async { await act { await self.supervisor.stop() } }
    func restart() async { await act { await self.supervisor.restart() } }

    /// Routes into the app's one sheet channel, consuming the captured password so
    /// it can never be offered twice.
    func connect(_ app: AppModel) {
        pendingPassword = capturedPassword
        capturedPassword = nil
        app.beginLocalLogin()
    }

    func takePendingPassword() -> String? {
        defer { pendingPassword = nil }
        return pendingPassword
    }

    /// The quit path, and the **only** caller of `terminateNow()` anywhere in the
    /// app. Synchronous by design — `applicationWillTerminate` gets no await — and
    /// it blocks the calling thread for up to the grace period, which is why no UI
    /// action may route here: `stop()` is the interactive path.
    nonisolated func terminateForQuit() { supervisor.terminateNow(gracePeriod: 5) }

    private func act(_ body: @MainActor () async -> Void) async {
        guard !busy else { return }
        busy = true
        generation += 1
        defer { busy = false }
        await body()
        state = await supervisor.state
        // Cleared on the supervisor right after this read, not just dropped
        // from `self.capturedPassword` by `connect()`: otherwise a later
        // restart(), which mints no new password, re-copies this same stale
        // secret back in here even after `connect()` already handed it off.
        if let password = await supervisor.capturedPassword {
            capturedPassword = password
            await supervisor.clearCapturedPassword()
        }
        await pullLog()
    }

    private func pullLog() async { logLines = await log.lines }
}

/// The per-store half of this stream's state: while a store is live for the local
/// profile, the panel can stop offering "Sign in". Torn down with the store, so a
/// superseded activation can never leave it set.
@MainActor
final class LocalServerSessionExtension: AppExtension {
    private(set) var hasLiveStore = true
    init(store: SessionStore, app: AppModel) {
        _ = store
        _ = app
    }
    func teardown() { hasLiveStore = false }
}
