import Foundation
import Observation
import ShepherdKit

struct BackendRecoveryReads: Sendable {
    var health: @Sendable () async -> Bool?
    var diagnostics: @Sendable () async throws -> DiagnosticsSnapshot
}

/// Activation-scoped health and diagnostics, independent of Settings' other reads.
@Observable @MainActor final class BackendRecoveryModel: AppExtension {
    private(set) var diagnostics: DiagnosticsSnapshot?
    private(set) var serverReachable: Bool?
    @ObservationIgnored private let reads: BackendRecoveryReads
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var tap: Task<Void, Never>?
    @ObservationIgnored private var initial: Task<Void, Never>?

    init(reads: BackendRecoveryReads) { self.reads = reads }
    convenience init(store: SessionStore, app: AppModel) {
        let client = store.client
        self.init(reads: .init(health: {
            do { return try await client.health().ok }
            catch ShepherdError.transport { return false }
            catch { return nil }
        }, diagnostics: { try await client.getDiagnostics(refresh: "1") }))
        let events = store.events()
        tap = Task { [weak self] in
            for await event in events {
                guard let self, !self.stopped, !Task.isCancelled else { return }
                self.receive(event)
            }
        }
        initial = Task { [weak self] in await self?.refresh() }
    }
    func refresh() async {
        guard !stopped, !Task.isCancelled else { return }
        generation &+= 1
        let mine = generation
        async let health = reads.health()
        async let snapshot = try? reads.diagnostics()
        let result = await (health, snapshot)
        guard !stopped, mine == generation, !Task.isCancelled else { return }
        serverReachable = result.0
        // Failed/auth-denied reads cannot leave stale runner diagnoses behind.
        diagnostics = result.1
    }
    func diagnosis(for closure: PTYConnection.Closure?) -> BackendFailure {
        BackendRecovery.classify(serverReachable: serverReachable, diagnostics: diagnostics, closure: closure)
    }
    func receive(_ event: ServerEvent) {
        guard !stopped, case .unknown(let name, let data) = event,
              name == "diagnostics:status", let data,
              let snapshot = try? JSONDecoder().decode(DiagnosticsSnapshot.self, from: data) else { return }
        replaceDiagnostics(snapshot)
    }
    func replaceDiagnostics(_ snapshot: DiagnosticsSnapshot) {
        guard !stopped else { return }
        generation &+= 1
        diagnostics = snapshot
        serverReachable = true
    }
    func teardown() {
        stopped = true; generation &+= 1
        tap?.cancel(); initial?.cancel(); tap = nil; initial = nil
        diagnostics = nil; serverReachable = nil
    }
}
