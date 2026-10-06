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
        case .upgradingBun: L.t("native_local_bun_upgrading")
        case .updating: L.t("native_local_update_updating")
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
        case .bunOutdated(let version): L.t("native_local_error_bun_outdated", version)
        case .updateFailed(let code): L.t("native_local_update_failed", String(code))
        case .bunUpgradeFailed(let code): L.t("native_local_error_bun_upgrade_failed", String(code))
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
    static let shared: LocalServerModel = {
        guard LaunchEnvironment.configuration().isIsolated else { return LocalServerModel() }
        // Isolated app hosts must never adopt or supervise the operator's server.
        let home = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shepherd-isolated-local-\(UUID().uuidString)")
        return LocalServerModel(environment: LocalServerEnvironment(home: home, processEnvironment: [:]),
                                discoverExternal: { nil }, launch: { nil })
    }()

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
    private var pendingPasswordProfileID: UUID?

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
    private var lifecycleGeneration = 0
    private let updatesAllowed: Bool
    private var automaticUpdatesAllowed = true
    private var automaticProfileSource: (() -> ServerProfile?)?
    private var automaticCheckInFlight = false
    private var quittingUpdates = false
    /// The in-flight `install()`, held so the quit path can cancel it — see
    /// `beginInstall()` / `cancelInstallForQuit()`.
    private var installTask: Task<Void, Never>?
    private(set) var updateStatus: LocalUpdateStatus?
    private(set) var updateCheckFailure: LocalUpdateCheckFailure?
    /// A failed `update.sh` run, kept beside `state` rather than in it: the
    /// old supervised server is usually still healthy, and folding the failure
    /// into `state` would hide Stop/Restart/Connect for a server that works.
    private(set) var updateFailure: LocalServerFailure?
    private(set) var isCheckingUpdate = false
    private var updateCheckGeneration = 0
    private var lastUpdateCheckAttempt: Date?
    private var updateTask: Task<Void, Never>?
    private var deployment: LocalUpdateDeployment?
    private var recoveryFailed = false
    private var launchRecoveryTask: Task<Bool, Never>?
    private var updateCheckTask: Task<Result<LocalUpdateStatus, LocalUpdateCheckFailure>, Never>?
    private let updateChecker: @Sendable (LocalServerEnvironment) async -> Result<LocalUpdateStatus, LocalUpdateCheckFailure>
    private let updater: @Sendable (LocalServerEnvironment, LogRing) async -> Result<Void, LocalServerFailure>
    private let updateNow: @Sendable () -> Date
    private let updateMonitorClock: any SupervisorClock
    private var updateMonitorTask: Task<Void, Never>?
    private var bunUpgradeTask: Task<Void, Never>?
    private var lastOutdatedBunVersion: String?
    private let bunUpgrader: @Sendable (LocalServerEnvironment, LogRing) async -> Result<String, LocalServerFailure>

    var outdatedBunVersion: String? {
        if case .failed(.bunOutdated(let version)) = state { return version }
        return lastOutdatedBunVersion
    }

    init(
        environment: LocalServerEnvironment = LocalServerEnvironment(),
        isolated: Bool = LaunchEnvironment.configuration().isIsolated,
        allowTemporaryUpdates: Bool = false,
        probeExternal: (@Sendable () async -> Bool)? = nil,
        discoverExternal: (@Sendable () async -> Components.Schemas.Health?)? = nil,
        health: (@Sendable () async -> Bool)? = nil,
        launch: (@Sendable () -> LocalServerLaunch?)? = nil,
        installer: (
            @Sendable (LocalServerEnvironment, LogRing) async -> Result<Void, LocalServerFailure>
        )? = nil,
        bunUpgrader: (@Sendable (LocalServerEnvironment, LogRing) async -> Result<String, LocalServerFailure>)? = nil,
        updateChecker: (@Sendable (LocalServerEnvironment) async -> Result<LocalUpdateStatus, LocalUpdateCheckFailure>)? = nil,
        updater: (@Sendable (LocalServerEnvironment, LogRing) async -> Result<Void, LocalServerFailure>)? = nil,
        updateNow: @escaping @Sendable () -> Date = { Date() },
        updateMonitorClock: any SupervisorClock = SystemSupervisorClock(),
        bunVersion: @escaping @Sendable (URL) async -> String? = { await LocalServerEnvironment.probeBunVersion($0) },
        clock: any SupervisorClock = SystemSupervisorClock()
    ) {
        self.environment = environment
        self.updatesAllowed = !(isolated || LaunchEnvironment.configuration().isIsolated)
            || (allowTemporaryUpdates && environment.isTemporaryUpdateEnvironment)
        self.discoverExternal = discoverExternal ?? {
            if let probeExternal {
                return await probeExternal() ? .init(ok: true, version: "unknown") : nil
            }
            return await LocalHealthCheck(port: environment.port).read()
        }
        self.installer = installer ?? { environment, log in
            await InstallerRun(environment: environment, log: log).run()
        }
        self.bunUpgrader = bunUpgrader ?? { environment, log in
            await BunUpgradeRun(environment: environment, log: log).run()
        }
        self.updateChecker = updateChecker ?? { environment in
            await LocalUpdateCheck(environment: environment).run()
        }
        self.updater = updater ?? { environment, log in
            await LocalUpdateRun(environment: environment, log: log).run()
        }
        self.updateNow = updateNow
        self.updateMonitorClock = updateMonitorClock
        let ring = log
        self.supervisor = LocalServerSupervisor(
            environment: environment, log: ring,
            health: health,
            clock: clock, bunVersion: bunVersion,
            launch: launch ?? LocalServerSupervisor.defaultLaunch(environment))
    }

    /// Serialize launch recovery before discovery/adoption AND explicit actions.
    /// Keep the journal until the unconfirmed process has safely stopped: a crash
    /// between teardown and rollback must remain recoverable on the next launch.
    private func ensureLaunchRecovery() async -> Bool {
        guard updatesAllowed else { return true }
        if let launchRecoveryTask { return await launchRecoveryTask.value }
        let task = Task { @MainActor in
            do {
                var restart = false
                if try LocalUpdateDeployment.needsServerRestart(environment: environment) {
                    let external = await discoverExternal()
                    restart = await supervisor.stopForDeploymentRecovery(
                        healthyIdentity: external?.localInstall.map(LocalServerIdentity.init))
                    guard external == nil || restart else {
                        throw LocalServerFailure.updateFailed(exitCode: 1)
                    }
                }
                if let message = try LocalUpdateDeployment.recover(environment: environment) {
                    await log.append(message)
                }
                // Recovery never publishes the unconfirmed server as running.
                // A replacement uses the detached launch + new ownership record.
                if restart && !quittingUpdates { await supervisor.start() }
                return !quittingUpdates
            } catch {
                recoveryFailed = true
                state = .failed(.updateFailed(exitCode: 1))
                updateFailure = .updateFailed(exitCode: 1)
                await log.append("Backend launch recovery failed: \(error). Server startup and adoption are blocked.")
                return false
            }
        }
        launchRecoveryTask = task
        return await task.value
    }

    /// The endpoint managed by this supervisor, also used to choose the login profile.
    var baseURL: URL { URL(string: "http://127.0.0.1:\(environment.port)")! }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }
    var canInstall: Bool {
        switch state {
        case .failed(.bunOutdated), .failed(.bunUpgradeFailed), .upgradingBun, .updating: false
        default: !busy && !recoveryFailed && (state == .notInstalled || isFailed)
        }
    }
    var canStart: Bool { !busy && !recoveryFailed && (state == .stopped || isFailed) }
    var canStop: Bool { !busy && state.isRunning }
    var canRestart: Bool { !busy && state.isRunning }

    var canManageUpdates: Bool {
        updatesAllowed && !recoveryFailed && environment.isShepherdCheckout() && state != .notInstalled && state != .installing && state != .externallyManaged
    }

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
        guard await ensureLaunchRecovery(), !busy else { await pullLog(); return }
        if recoveryFailed { await pullLog(); return }
        await resolveState()
        await checkForUpdate(force: false)
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
        let identity = external?.localInstall.map(LocalServerIdentity.init)
        let adopted = await supervisor.adopt(healthyIdentity: identity)
        guard generation == expected else { return }
        if adopted {
            clearExternalObservation()
            state = await supervisor.state
            guard generation == expected else { return }
            await pullLog()
            return
        }
        if let external {
            if externalIdentity != identity || externalVersion != external.version {
                externalAcknowledged = false
            }
            externalIdentity = identity
            externalVersion = external.version
            state = .externallyManaged
            return
        }
        clearExternalObservation()
        switch state {
        case .failed(.bunOutdated), .failed(.bunUpgradeFailed):
            break // Keep the upgrade result and retry button when the panel reappears.
        default:
            if case .failed = supervised { state = supervised }
            else { state = environment.isShepherdCheckout() ? .stopped : .notInstalled }
        }
        await pullLog()
    }

    func install() async {
        guard await ensureLaunchRecovery() else { return }
        guard !busy, !recoveryFailed else { return }
        busy = true
        generation += 1
        lifecycleGeneration += 1
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
        guard !busy, !recoveryFailed else { return }
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

    func upgradeBun() async {
        guard await ensureLaunchRecovery() else { return }
        guard !busy, !recoveryFailed else { return }
        busy = true
        generation += 1
        lifecycleGeneration += 1
        lastOutdatedBunVersion = outdatedBunVersion
        state = .upgradingBun
        let progress = sampleProgress()
        defer { progress.cancel(); busy = false }
        let result = await bunUpgrader(environment, log)
        await pullLog()
        guard !Task.isCancelled else { state = .stopped; return }
        switch result {
        case .success:
            await resolveState()
            guard state != .externallyManaged, !Task.isCancelled else { return }
            state = .starting
            await supervisor.start()
            state = await supervisor.state
            await pullLog()
        case .failure(let failure): state = .failed(failure)
        }
    }

    func beginBunUpgrade() {
        guard !busy, !recoveryFailed else { return }
        bunUpgradeTask = Task { await self.upgradeBun() }
    }

    func cancelBunUpgradeForQuit() {
        bunUpgradeTask?.cancel()
        bunUpgradeTask = nil
    }

    /// A check may overlap a lifecycle action, but its answer may not overwrite
    /// one. Capture the lifecycle generation; throttle failed attempts too
    /// so a panel reappearing offline does not repeatedly fetch.
    func checkForUpdate(force: Bool = true) async {
        await performUpdateCheck(force: force)
    }

    /// App lifetime, independent of Welcome/Settings visibility. Wake and panel
    /// refreshes use the same throttle, including failed attempts.
    func startUpdateMonitoring() {
        guard updatesAllowed, updateMonitorTask == nil else { return }
        let clock = updateMonitorClock
        updateMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.automaticRefresh()
                do { try await clock.sleep(for: 30 * 60) }
                catch { return }
            }
        }
    }

    func automaticRefresh() async {
        guard updatesAllowed, automaticChecksAllowed else { return }
        await refresh()
    }

    func bindAutomaticProfile(_ source: @escaping () -> ServerProfile?) {
        automaticProfileSource = source
        updateActiveProfile(source())
    }

    private var automaticChecksAllowed: Bool {
        if let automaticProfileSource { return Self.allowsAutomaticUpdates(automaticProfileSource(), endpoint: baseURL) }
        return automaticUpdatesAllowed
    }

    private static func allowsAutomaticUpdates(_ profile: ServerProfile?, endpoint: URL) -> Bool {
        guard let profile else { return true } // Welcome has no active profile.
        return profile.mode == .local && profile.baseURL.scheme == endpoint.scheme
            && profile.baseURL.port == endpoint.port
            && ["127.0.0.1", "localhost", "::1"].contains(profile.baseURL.host(percentEncoded: false) ?? "")
            && ["", "/"].contains(profile.baseURL.path)
            && profile.baseURL.user == nil && profile.baseURL.password == nil
    }

    func cancelAutomaticUpdateCheck() {
        if automaticCheckInFlight { updateCheckTask?.cancel() }
    }

    /// Kept at the app layer: profile selection is not a server lifecycle event.
    /// Explicit maintenance in Settings remains available on a remote profile.
    func updateActiveProfile(_ profile: ServerProfile?) {
        automaticUpdatesAllowed = Self.allowsAutomaticUpdates(profile, endpoint: baseURL)
        if !automaticUpdatesAllowed { cancelAutomaticUpdateCheck() }
    }

    private func performUpdateCheck(force: Bool, allowBusy: Bool = false) async {
        guard await ensureLaunchRecovery() else { return }
        guard (!busy || allowBusy), canManageUpdates, (force || automaticChecksAllowed), !isCheckingUpdate else { return }
        let now = updateNow()
        if !force, let lastUpdateCheckAttempt, now.timeIntervalSince(lastUpdateCheckAttempt) < 30 * 60 { return }
        lastUpdateCheckAttempt = now
        let expected = lifecycleGeneration
        automaticCheckInFlight = !force
        isCheckingUpdate = true
        updateCheckGeneration += 1
        let checkGeneration = updateCheckGeneration
        let task = Task { await updateChecker(environment) }
        updateCheckTask = task
        defer {
            if updateCheckGeneration == checkGeneration {
                isCheckingUpdate = false
                automaticCheckInFlight = false
                updateCheckTask = nil
            }
        }
        let result = await withTaskCancellationHandler {
            await task.value
        } onCancel: { task.cancel() }
        guard lifecycleGeneration == expected, !Task.isCancelled, !task.isCancelled,
              canManageUpdates, (force || automaticChecksAllowed) else {
            if updateCheckGeneration == checkGeneration { lastUpdateCheckAttempt = nil }
            return
        }
        switch result {
        case .success(let status):
            updateStatus = status
            updateCheckFailure = nil
        case .failure(let failure): updateCheckFailure = failure
        }
    }

    func applyUpdate() async {
        guard await ensureLaunchRecovery() else { return }
        guard !busy, canManageUpdates, !recoveryFailed, !quittingUpdates else { return }
        busy = true
        generation += 1
        lifecycleGeneration += 1
        state = .updating
        updateFailure = nil
        // A check begun before apply is stale. Finish cancelling its fetch
        // before copying the checkout and its Git metadata.
        updateCheckTask?.cancel()
        if let task = updateCheckTask { _ = await task.value }
        updateCheckGeneration += 1
        updateCheckTask = nil
        isCheckingUpdate = false
        automaticCheckInFlight = false
        let wasRunning = await supervisor.suspendRecovery()
        let progress = sampleProgress()
        defer { progress.cancel(); busy = false }
        var failure: LocalServerFailure?
        do {
            try Task.checkCancellation()
            // Copy off the main actor; no build writes to the live deployment.
            deployment = try await Task.detached { [environment] in
                try LocalUpdateDeployment(environment: environment)
            }.value
            try Task.checkCancellation()
            let result = await updater(deployment!.environment, log)
            if case .failure(let error) = result { throw error }
            try Task.checkCancellation()
            guard !quittingUpdates else { throw LocalServerFailure.updateFailed(exitCode: 130) }
            try deployment!.promote()
            if wasRunning {
                await supervisor.restart()
                guard await supervisor.state.isRunning else { throw LocalServerFailure.updateFailed(exitCode: 1) }
            }
            try Task.checkCancellation()
            guard !quittingUpdates else { throw LocalServerFailure.updateFailed(exitCode: 130) }
            try deployment!.confirm()
        } catch {
            failure = Task.isCancelled ? .updateFailed(exitCode: 130)
                : (error as? LocalServerFailure ?? .updateFailed(exitCode: 1))
            if deployment?.promoted == true {
                // Stop a failed/cancelled replacement before restoring the old
                // directory. Otherwise resume would mistake it for the old child.
                await Task.detached { [supervisor] in await supervisor.stop() }.value
            }
            do { try deployment?.rollback() }
            catch {
                // Do not resume into an unknown deployment or delete the backup.
                updateFailure = .updateFailed(exitCode: 1)
                await log.append("Could not restore the previous deployment: \(error). Recovery remains suspended.")
                await resolveState()
                await pullLog()
                return
            }
        }
        // Quit retains promotion intent even after rollback: the next launch
        // must recover before it can adopt any persisted server.
        if !quittingUpdates { deployment?.finish() }
        deployment = nil
        updateFailure = failure
        // Cancellation must not cancel rollback recovery. Quit is the explicit
        // exception: its separate termination path must never spawn a child.
        let recover = wasRunning && !quittingUpdates
        await Task.detached { [supervisor] in
            await supervisor.resumeRecovery(restartIfNeeded: recover)
        }.value
        await resolveState()
        await pullLog()
        if failure == nil {
            updateStatus = nil
            await performUpdateCheck(force: true, allowBusy: true)
        }
    }

    func beginUpdate() {
        guard !busy, updateTask == nil, canManageUpdates else { return }
        updateTask = Task {
            defer { updateTask = nil }
            await self.applyUpdate()
        }
    }

    func cancelUpdateForQuit() {
        quittingUpdates = true
        updateMonitorTask?.cancel()
        updateMonitorTask = nil
        updateTask?.cancel()
        updateTask = nil
        updateCheckTask?.cancel()
        // willTerminate cannot await the update task. Stop the owned server and
        // restore the directory synchronously before the process exits.
        if deployment?.promoted == true {
            supervisor.terminateForQuit()
            supervisor.terminateNow(gracePeriod: 5)
            do { try deployment?.rollback() }
            catch { Log.app.error("Could not restore backend on quit: \(String(describing: error))") }
        }
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
        guard await ensureLaunchRecovery() else { return }
        guard !busy, !recoveryFailed else { return }
        busy = true
        runnerFailure = nil
        let progress = sampleProgress()
        defer { progress.cancel(); busy = false }
        if case .failure(let failure) = await supervisor.startRunner() { runnerFailure = failure }
        await pullLog()
    }

    func start() async {
        await act {
            self.state = .starting
            await self.supervisor.start()
        }
    }
    func stop() async { await act { await self.supervisor.stop() } }
    func restart() async { await act { await self.supervisor.restart() } }

    /// Reuses a saved token, retaining the one-time password only for a needed login.
    func connect(_ app: AppModel) async {
        guard state != .externallyManaged || externalAcknowledged else { return }
        let profile = app.addLocalProfile(port: environment.port)
        if let capturedPassword {
            pendingPassword = capturedPassword
            pendingPasswordProfileID = profile.id
        }
        capturedPassword = nil
        await app.connectLocal(port: environment.port)
        discardPasswordAfterTokenReuse(app, profileID: profile.id)
    }

    /// Keep the password until an authenticated snapshot arrives, including late recovery.
    private func discardPasswordAfterTokenReuse(_ app: AppModel, profileID: UUID) {
        guard pendingPassword != nil, pendingPasswordProfileID == profileID else { return }
        withObservationTracking {
            if app.activeProfile?.id != profileID || app.store?.hasLoadedSessions == true
                || app.store?.connection == .firstRunPending {
                pendingPassword = nil
                pendingPasswordProfileID = nil
            }
        } onChange: {
            Task { @MainActor [weak self, weak app] in
                guard let self, let app else { return }
                self.discardPasswordAfterTokenReuse(app, profileID: profileID)
            }
        }
    }

    func takePendingPassword() -> String? {
        defer { pendingPassword = nil; pendingPasswordProfileID = nil }
        return pendingPassword
    }

    /// The panel's explicit dismiss (X) and its one-shot Copy both route
    /// through this (V2): the notice is addressed either way and must not
    /// linger, but neither path is a "connect" — nothing is queued for the
    /// login sheet.
    func dismissCapturedPassword() { capturedPassword = nil }

    /// Quitting detaches supervision; only Stop/Restart signal the server.
    /// Synchronous because `applicationWillTerminate` gets no await.
    nonisolated func terminateForQuit() { supervisor.terminateForQuit() }

    private func act(_ body: @MainActor () async -> Void) async {
        guard await ensureLaunchRecovery() else { return }
        guard !busy, !recoveryFailed else { return }
        busy = true
        generation += 1
        lifecycleGeneration += 1
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
    nonisolated var testSupervisor: LocalServerSupervisor { supervisor }
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
