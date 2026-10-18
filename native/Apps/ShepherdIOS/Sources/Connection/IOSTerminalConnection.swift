import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// One session's owning server, never the hub's currently focused server.
@MainActor
@Observable
final class IOSTerminalConnection {
    private weak var app: AppModel?
    private weak var hub: IOSServerHub?
    private weak var terminal: IOSTerminalPresentation?
    private let activationGeneration: Int
    var latency: IOSLatencyMonitor?
    // Server-Timing lag describes the preceding minute. A successful explicit
    // round trip acknowledges that episode, even while the header still reports it.
    private var acknowledgedStall = false
    private var recoveringAttachment = false
    private var confirmationFailed = false
    @ObservationIgnored lazy var retry = IOSReconnectState(reconnect: { [weak self] in
        await self?.reconnect() ?? false
    })

    init(app: AppModel, hub: IOSServerHub?, terminal: IOSTerminalPresentation, latency: IOSLatencyMonitor?) {
        self.app = app
        activationGeneration = app.activationGeneration
        self.hub = hub
        self.terminal = terminal
        self.latency = latency
    }

    static func isUnreachable(hubUnavailable: Bool = false, connection: ConnectionState? = nil,
                              error: ShepherdError? = nil, phase: TerminalSessionModel.Phase,
                              stalled: Bool = false) -> Bool {
        if hubUnavailable || phase == .ended(.unreachable) || stalled { return true }
        if case .offline = connection { return true }
        if case .transport = error { return true }
        return false
    }

    var unreachable: Bool {
        guard let app, app.activationGeneration == activationGeneration else { return true }
        return Self.isUnreachable(hubUnavailable: hub?.isUnavailable(app) == true,
            connection: app.store?.connection, error: app.store?.lastError,
            phase: terminal?.session.phase ?? .idle,
            stalled: latency?.report.verdict == .serverStalled && !acknowledgedStall)
            || confirmationFailed || (recoveringAttachment && terminal?.session.phase == .connecting)
    }

    var lastContact: Date? {
        guard app?.activationGeneration == activationGeneration else { return nil }
        return app?.store?.client.latency.snapshot().last?.at
    }

    func update() {
        if latency?.report.verdict != .serverStalled { acknowledgedStall = false }
        retry.update(unreachable: unreachable, lastContact: lastContact)
        if unreachable || retry.phase == .checking { terminal?.lockWriting() }
    }

    private func reconnect() async -> Bool {
        guard let app, app.activationGeneration == activationGeneration,
              let store = app.store, let terminal else { return false }
        let generation = app.activationGeneration
        app.retry()
        // retry() owns its task; cancellation here only stops this view's wait.
        do {
            while app.retrying {
                try await Task.sleep(for: .milliseconds(100))
                guard app.activationGeneration == generation, app.store === store else { return false }
            }
            try Task.checkCancellation()
            guard app.activationGeneration == generation, app.store === store else { return false }
            // A real response distinguishes an old event-loop-stall metric from
            // an unreachable server. It also refreshes the header's timing samples.
            _ = try await store.client.session(id: terminal.sessionID)
            try Task.checkCancellation()
            guard app.activationGeneration == generation, app.store === store else { return false }
            confirmationFailed = false
            latency?.refresh()
            acknowledgedStall = latency?.report.verdict == .serverStalled
            if terminal.session.phase == .ended(.unreachable) {
                recoveringAttachment = true
                defer { recoveringAttachment = false }
                terminal.session.takeOver()
                let deadline = ContinuousClock.now + .seconds(8)
                while terminal.session.phase == .connecting, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(100))
                }
                try Task.checkCancellation()
            }
            await Task.yield() // let the hub reconcile its observation of the same store
            guard app.activationGeneration == generation, app.store === store else { return false }
            return !unreachable && terminal.session.phase != .connecting
        } catch {
            if !Task.isCancelled, app.activationGeneration == generation, app.store === store {
                confirmationFailed = true
            }
            return false
        }
    }
}
