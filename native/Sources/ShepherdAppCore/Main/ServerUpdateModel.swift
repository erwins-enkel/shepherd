import Foundation
import Observation
import ShepherdKit

/// What the connection banner can offer beyond Retry when the server and this app disagree
/// about the contract (#2987).
public enum ServerUpdateOffer: Equatable, Sendable {
    /// Nothing to offer: the server's update status is unknown or its check failed.
    case none
    /// The server is behind its tracked branch — updating it is the likely fix.
    case updateServer(behind: Int)
    /// The server is up to date, so this app is the older side.
    case testFlight
}

/// What the update sheet shows. The same state machine as the web update modal's
/// `LocalUpdate.mode` (ui/src/lib/components/update/local-update.svelte.ts).
public enum ServerUpdateMode: Equatable, Sendable {
    case progress, loading, clean, dirty, tooLarge, nowClean, rawLog
}

/// The deploy as the sheet shows it: the server's own state, or a synthesized failure when
/// the server stayed unreachable for too long.
public struct ServerUpdateDeployView: Equatable, Sendable {
    public let phase: String
    public let exitCode: Int?
    public let log: String
    public let reason: String?

    init(phase: String, exitCode: Int?, log: String, reason: String?) {
        self.phase = phase; self.exitCode = exitCode; self.log = log; self.reason = reason
    }
    init(_ deploy: ServerUpdateDeploy) {
        self.init(phase: deploy.phase, exitCode: deploy.exitCode, log: deploy.log, reason: deploy.reason)
    }
}

/// The calls the flow makes. Injected so tests drive the polling with a scripted server and clock.
struct ServerUpdateCalls: Sendable {
    var status: @Sendable () async throws -> ServerUpdateStatus
    var dirty: @Sendable () async throws -> ServerUpdateDirty
    var apply: @Sendable (_ discard: Bool, _ sig: String?) async throws -> Void
    var log: @Sendable () async throws -> ServerUpdateDeploy
    var sleep: @Sendable (Duration) async throws -> Void
    var now: @Sendable () -> Date
}

/// Updates the connected server from the app (#2987): the web update modal's flow — a fresh
/// dirty-tree probe, a confirmed discard pinned to the shown signature, a stale re-confirm,
/// the live deploy log — then a reconnect once the restarted server reports `done`.
///
/// Scoped to one profile activation, so the deploy watch survives the banner and sheet
/// coming and going while the server restarts; `teardown()` stops it.
@Observable @MainActor public final class ServerUpdateModel: AppExtension {
    public enum DirtyProbe: Equatable, Sendable { case idle, pending, clean, dirty, error }

    /// Poll cadence and give-up window, as the web modal's `watchDeploy()` uses them.
    static let pollInterval: Duration = .milliseconds(1500)
    static let unreachableLimit: TimeInterval = 3 * 60

    public private(set) var offer: ServerUpdateOffer = .none
    public private(set) var status: ServerUpdateStatus?
    public var presented = false
    public private(set) var dirtyProbe: DirtyProbe = .idle
    public private(set) var dirty: ServerUpdateDirty?
    /// The destructive discard waits for a second, explicit confirmation.
    public var arming = false
    /// The tree changed since it was shown: the list was replaced and needs a fresh confirmation.
    public private(set) var staleHint = false
    public private(set) var submitting = false
    /// An update was accepted and the deploy is being followed.
    public private(set) var updating = false
    public private(set) var error: String?
    public private(set) var deploy: ServerUpdateDeployView?

    @ObservationIgnored private let calls: ServerUpdateCalls
    @ObservationIgnored private let onDone: @MainActor () -> Void
    @ObservationIgnored private var offerGeneration = 0
    @ObservationIgnored private var probeGeneration = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored var watchTask: Task<Void, Never>?

    init(calls: ServerUpdateCalls, onDone: @escaping @MainActor () -> Void) {
        self.calls = calls
        self.onDone = onDone
    }

    public convenience init(store: SessionStore, app: AppModel) {
        let client = store.client
        self.init(calls: .init(
            status: { try await client.updateStatus() },
            dirty: { try await client.updateDirty() },
            apply: { discard, sig in try await client.applyUpdate(discard: discard, sig: sig) },
            log: { try await client.updateLog() },
            sleep: { try await Task.sleep(for: $0) },
            now: { Date() }),
            onDone: { [weak app] in app?.retry() })
    }

    public func teardown() {
        stopped = true
        watchTask?.cancel()
        watchTask = nil
    }

    // MARK: - offer

    /// Reads the server's update status and decides what the mismatch banner offers.
    public func refreshOffer() async {
        guard !stopped else { return }
        offerGeneration &+= 1
        let generation = offerGeneration
        do {
            let read = try await calls.status()
            guard generation == offerGeneration, !stopped else { return }
            status = read
            if read.behind > 0 { offer = .updateServer(behind: read.behind) }
            else { offer = read.error == nil ? .testFlight : .none }
        } catch {
            guard generation == offerGeneration, !stopped else { return }
            Log.connect.debug("server update status unavailable: \(ShepherdErrorCopy.message(error), privacy: .public)")
            if !updating { offer = .none }
        }
    }

    // MARK: - sheet

    public var busy: Bool { submitting || updating }
    public var failed: Bool { deploy?.phase == "failed" }
    /// Newest non-empty line of the deploy output while it runs, so progress is visible.
    public var liveLogLine: String? {
        guard busy, !failed, let log = deploy?.log else { return nil }
        return Self.lastLogLine(log)
    }
    var dirtyReactive: Bool { failed && (deploy?.reason == "dirty" || deploy?.reason == "stale") }

    public var mode: ServerUpdateMode {
        if busy { return .progress }
        if dirtyReactive {
            if dirtyProbe == .error { return .rawLog }
            if dirtyProbe == .clean { return .nowClean }
            return probeMode
        }
        if failed { return .rawLog }
        return probeMode
    }

    private var probeMode: ServerUpdateMode {
        switch dirtyProbe {
        case .idle, .pending: .loading
        case .dirty: dirty?.sig == nil ? .tooLarge : .dirty
        case .clean, .error: .clean // a failed probe degrades to the plain update, never a stuck sheet
        }
    }

    /// Opens the sheet and probes the tree fresh — it is volatile, so never from a cache.
    public func open() async {
        presented = true
        error = nil
        guard !busy else { return }
        if !failed { staleHint = false }
        await probe()
    }

    func probe() async {
        probeGeneration &+= 1
        let generation = probeGeneration
        dirtyProbe = .pending
        arming = false
        do {
            let read = try await calls.dirty()
            guard generation == probeGeneration else { return }
            dirty = read
            dirtyProbe = read.dirty ? .dirty : .clean
        } catch {
            guard generation == probeGeneration else { return }
            dirty = nil
            dirtyProbe = .error
        }
    }

    /// The clean (and retry) path: a plain, non-destructive update.
    public func runUpdate() async {
        await start(discard: false, sig: nil)
    }

    /// The destructive path's second step: discard exactly what was shown.
    public func confirmDiscard() async {
        arming = false
        await start(discard: true, sig: dirty?.sig)
    }

    private func start(discard: Bool, sig: String?) async {
        guard !busy, !stopped else { return }
        submitting = true
        error = nil
        do {
            try await calls.apply(discard, sig)
            submitting = false
            deploy = nil
            staleHint = false
            updating = true
            watch()
        } catch let stale as ServerUpdateStale {
            submitting = false
            dirty = stale.dirty
            dirtyProbe = stale.dirty.dirty ? .dirty : .clean
            staleHint = true
        } catch {
            submitting = false
            self.error = ShepherdErrorCopy.message(error)
        }
    }

    /// Follows the detached deploy until it reports `done` (the restarted server already
    /// answered its health check) or `failed`, or the server stays unreachable too long.
    private func watch() {
        watchTask?.cancel()
        let calls = calls
        watchTask = Task { @MainActor [weak self] in
            var lastReachable = calls.now()
            while !Task.isCancelled {
                do { try await calls.sleep(Self.pollInterval) } catch { return }
                guard let self, !self.stopped, !Task.isCancelled else { return }
                do {
                    let read = try await calls.log()
                    guard !Task.isCancelled else { return }
                    lastReachable = calls.now()
                    let view = ServerUpdateDeployView(read)
                    self.deploy = view
                    if view.phase == "done" { self.finish(); return }
                    if view.phase == "failed" { await self.fail(view); return }
                } catch {
                    guard !Task.isCancelled else { return }
                    // Expected while the server restarts; give up only far beyond a restart.
                    if calls.now().timeIntervalSince(lastReachable) > Self.unreachableLimit {
                        self.deploy = ServerUpdateDeployView(
                            phase: "failed", exitCode: nil, log: L.t("updatemodal_unreachable"), reason: nil)
                        self.updating = false
                        return
                    }
                }
            }
        }
    }

    private func finish() {
        updating = false
        deploy = nil
        offer = .none
        presented = false
        dirtyProbe = .idle
        onDone()
    }

    private func fail(_ view: ServerUpdateDeployView) async {
        updating = false
        guard view.reason == "dirty" || view.reason == "stale" else { return }
        // A tree that blocked the pull, or drifted after confirmation, goes back through
        // the dirty flow with a fresh probe.
        staleHint = view.reason == "stale"
        await probe()
    }

    /// The newest non-empty line of a deploy log, capped for a one-line readout.
    static func lastLogLine(_ log: String) -> String? {
        log.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }
            .map { String($0.prefix(160)) }
    }
}
