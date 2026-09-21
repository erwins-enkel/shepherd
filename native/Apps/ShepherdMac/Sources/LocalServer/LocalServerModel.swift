import ShepherdAppCore
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
        case .bootstrapDownload: L.t("native_local_error_download")
        case .bootstrapInvalid: L.t("native_local_error_invalid_download")
        case .bootstrapWrite: L.t("native_local_error_write")
        case .runnerMissing: L.t("native_local_error_runner_missing")
        case .runnerTimeout: L.t("native_local_error_runner_timeout")
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
    private(set) var externalIdentity: LocalServerIdentity?
    private(set) var externalAcknowledged = false
    private(set) var runnerFailure: LocalServerFailure?
    private var externalVersion: String?
    /// In memory only, offered once, then dropped (D4): persisting the server's
    /// master password would make this app a second, weaker home for it.
    /// Production-write-only (M-4): every write goes through
    /// `drainCapturedPassword()` (a fresh boot line) or
    /// `dismissCapturedPassword()`/`connect(_:)` (consuming or discarding the
    /// offer) — never a bare assignment from outside this file.
    private(set) var capturedPassword: String?
    /// Read once by the login sheet's prefill.
    private(set) var pendingPassword: String?

    private let environment: LocalServerEnvironment
    private let log = LogRing(capacity: 500)
    /// Injectable so a test can gate or fail the install step without a real
    /// `deploy/install.sh` — pattern: `health`/`launch` below. Production
    /// default runs the kit's own `InstallerRun`.
    private let installer: @Sendable (LocalServerEnvironment, LogRing) async -> Result<
        Void, LocalServerFailure
    >
    /// `nonisolated` so the quit path can reach it without hopping to the main
    /// actor: `applicationWillTerminate` gets no await. Safe because the
    /// supervisor is an actor, hence `Sendable`.
    private nonisolated let supervisor: LocalServerSupervisor
    /// "Is something already answering on 7330?" — injected so tests need no
    /// loopback listener. Production reuses the app's existing `LocalServerProbe`.
    private let discoverExternal: @Sendable () async -> Components.Schemas.Health?
    /// Bumped by every lifecycle action (`install`/`act`, i.e. start/stop/
    /// restart), so a `refresh()` already in flight when one of them begins
    /// cannot land afterwards and stomp the newer state back to whatever the
    /// probe or supervisor reported before the action ran. `refresh()` also
    /// bumps it on entry, so a second, later `refresh()` wins over a stale
    /// first one the same way. Pattern: `AppModel.activationGeneration`.
    private var generation = 0
    /// The in-flight `install()`, held so the quit path can cancel it — see
    /// `beginInstall()` / `cancelInstallForQuit()`.
    private var installTask: Task<Void, Never>?

    init(
        environment: LocalServerEnvironment = LocalServerEnvironment(),
        probeExternal: (@Sendable () async -> Bool)? = nil,
        discoverExternal: (@Sendable () async -> Components.Schemas.Health?)? = nil,
        health: (@Sendable () async -> Bool)? = nil,
        launch: (@Sendable () -> LocalServerLaunch?)? = nil,
        installer: (
            @Sendable (LocalServerEnvironment, LogRing) async -> Result<Void, LocalServerFailure>
        )? = nil,
        clock: any SupervisorClock = SystemSupervisorClock()
    ) {
        self.environment = environment
        self.discoverExternal = discoverExternal ?? {
            if let probeExternal {
                return await probeExternal() ? .init(ok: true, version: "unknown") : nil
            }
            return await LocalHealthCheck(port: environment.port).read()
        }
        self.installer = installer ?? { environment, log in
            await InstallerRun(environment: environment, log: log).run()
        }
        let ring = log
        self.supervisor = LocalServerSupervisor(
            environment: environment, log: ring,
            health: health,
            clock: clock,
            launch: launch ?? LocalServerSupervisor.defaultLaunch(environment))
    }

    /// The endpoint managed by this supervisor, also used to choose the login profile.
    var baseURL: URL { URL(string: "http://127.0.0.1:\(environment.port)")! }

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
    ///
    /// M-1: also a no-op while `busy` — the guard above catches a lifecycle
    /// action that starts *after* this call already began, but a `.task`
    /// refresh that lands *during* one (e.g. the panel reappearing mid
    /// `install()`) starts with `busy` already `true` and would otherwise run
    /// to completion and stomp `.installing` back down to whatever the
    /// checkout/probe say with nothing in flight.
    func refresh() async {
        guard !busy else { return }
        await resolveState()
    }

    /// `refresh()` without the `busy` guard, for the one caller that is itself
    /// the reason `busy` is set. The `generation` re-checks stay: they are what
    /// keeps a stale answer from landing on a newer state, and they are a
    /// different protection from M-1's.
    private func resolveState() async {
        generation += 1
        let expected = generation
        let supervised = await supervisor.state
        guard generation == expected else { return }
        if supervised.isRunning || supervised == .starting {
            clearExternalObservation()
            state = supervised
            await pullLog()
            return
        }
        let external = await discoverExternal()
        guard generation == expected else { return }
        if let external {
            let identity = external.localInstall.map(LocalServerIdentity.init)
            if externalIdentity != identity || externalVersion != external.version {
                externalAcknowledged = false
            }
            externalIdentity = identity
            externalVersion = external.version
            state = .externallyManaged
            return
        }
        clearExternalObservation()
        if case .failed = supervised { state = supervised }
        else { state = environment.isShepherdCheckout() ? .stopped : .notInstalled }
        await pullLog()
    }

    func install() async {
        guard !busy else { return }
        busy = true
        generation += 1
        state = .installing
        let progress = sampleProgress()
        defer { progress.cancel(); busy = false }
        let result = await installer(environment, log)
        await pullLog()
        switch result {
        case .success:
            guard !Task.isCancelled else { state = .stopped; return }
            // Recheck discovery after installing: an unrelated listener may have
            // appeared while the bootstrap was running. Never silently adopt it.
            await resolveState()
            guard state != .externallyManaged, !Task.isCancelled else { return }
            state = .starting
            await supervisor.start()
            state = await supervisor.state
            await pullLog()
        case .failure(let failure): state = .failed(failure)
        }
    }

    /// The panel's Install button. The task is kept, not dropped: a bare
    /// `Task { await model.install() }` in the view had no handle anyone could
    /// cancel, so quitting mid-install left `install.sh` and its whole subtree
    /// running, still mutating `~/.shepherd/app` — and the next launch's
    /// Install raced a second installer over the same checkout.
    func beginInstall() {
        guard !busy else { return }
        installTask = Task { await self.install() }
    }

    /// The quit path's other half, next to `terminateForQuit()`.
    /// `Task.cancel()` runs `withTaskCancellationHandler`'s `onCancel`
    /// synchronously, so `InstallerRun` has signalled its child by the time
    /// this returns — which is what `applicationWillTerminate`, with no
    /// `await` to give, needs.
    func cancelInstallForQuit() {
        installTask?.cancel()
        installTask = nil
    }

    func acknowledgeExternalServer() {
        guard state == .externallyManaged else { return }
        externalAcknowledged = true
    }

    private func clearExternalObservation() {
        externalIdentity = nil
        externalVersion = nil
        externalAcknowledged = false
    }

    func startRunner() async {
        guard !busy else { return }
        busy = true
        runnerFailure = nil
        let progress = sampleProgress()
        defer { progress.cancel(); busy = false }
        if case .failure(let failure) = await supervisor.startRunner() { runnerFailure = failure }
        await pullLog()
    }

    func start() async { await act { await self.supervisor.start() } }
    func stop() async { await act { await self.supervisor.stop() } }
    func restart() async { await act { await self.supervisor.restart() } }

    /// Routes into the app's one sheet channel, consuming the captured password so
    /// it can never be offered twice.
    func connect(_ app: AppModel) {
        guard state != .externallyManaged || externalAcknowledged else { return }
        pendingPassword = capturedPassword
        capturedPassword = nil
        app.beginLocalLogin(port: environment.port)
    }

    func takePendingPassword() -> String? {
        defer { pendingPassword = nil }
        return pendingPassword
    }

    /// The panel's explicit dismiss (X) and its one-shot Copy both route
    /// through this (V2): the notice is addressed either way and must not
    /// linger, but neither path is a "connect" — nothing is queued for the
    /// login sheet.
    func dismissCapturedPassword() { capturedPassword = nil }

    /// The quit path, and the **only** caller of `terminateNow()` anywhere in the
    /// app. Synchronous by design — `applicationWillTerminate` gets no await — and
    /// it blocks the calling thread for up to the grace period, which is why no UI
    /// action may route here: `stop()` is the interactive path.
    nonisolated func terminateForQuit() { supervisor.terminateNow(gracePeriod: 5) }

    private func act(_ body: @MainActor () async -> Void) async {
        guard !busy else { return }
        busy = true
        generation += 1
        let progress = sampleProgress()
        defer { progress.cancel(); busy = false }
        await body()
        state = await supervisor.state
        // `pullLog()` drains any newly captured password too (V1) — the boot
        // line that mints it can still be in flight on the pump when `body()`
        // returns, so a single read right here is not enough.
        await pullLog()
    }

    /// V1: a fresh boot line can reach the supervisor's pump after `act()`'s
    /// own lifecycle turn has already finished — health resolving is a
    /// loopback round trip, no guarantee it loses the race against the
    /// child's first stdout flush. Every place that pulls the log therefore
    /// also checks for a newly captured password, not just the read at the
    /// end of `act()`.
    ///
    /// Cleared on the supervisor right after this read, not just dropped from
    /// `self.capturedPassword` by `dismissCapturedPassword()`/`connect()`:
    /// otherwise a later `restart()`, which mints no new password, would
    /// re-copy this same stale secret back in here even after it had already
    /// been handed off or dismissed.
    private func drainCapturedPassword() async {
        guard let password = await supervisor.capturedPassword else { return }
        capturedPassword = password
        await supervisor.clearCapturedPassword()
    }

    private func sampleProgress() -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                await self?.pullLog()
                do { try await Task.sleep(for: .milliseconds(100)) }
                catch { return }
            }
        }
    }

    private func pullLog() async {
        logLines = await log.lines
        await drainCapturedPassword()
    }
}

/// The per-store half of this stream: registered by
/// `LocalServerFeature.install(_:)` so a live local session has its own
/// lifecycle hook, torn down with the store. Presently a placeholder — M-3
/// removed the unread `hasLiveStore` flag this type used to carry; add state
/// here, not to `LocalServerModel`, if a future task needs the panel to know
/// whether a store is live for the local profile.
@MainActor
final class LocalServerSessionExtension: AppExtension {
    init(store: SessionStore, app: AppModel) {
        _ = store
        _ = app
    }
    func teardown() {}
}

#if DEBUG
extension LocalServerModel {
    /// Test seam (M-4): `capturedPassword` is production-write-only —
    /// `drainCapturedPassword()` is the one path that sets it from a real
    /// boot line. Tests use this to exercise `connect()`/`dismissCapturedPassword()`
    /// and the panel's notice without spinning up a child that actually mints
    /// a password.
    func setCapturedPasswordForTesting(_ password: String?) {
        capturedPassword = password
    }
}
#endif
