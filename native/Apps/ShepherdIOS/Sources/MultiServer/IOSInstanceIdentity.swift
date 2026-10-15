import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// This server's instance ID (`GET /api/instance`), read once per activation (#2768). The merged
/// session list keys sessions by `(instance ID, session ID)`, so a session mirrored through a
/// coordinator and the same session read from its own machine are shown once. A server that is
/// not reachable yet is asked again with backoff; one that answers anything else (no such route,
/// a refusal) stays unknown and keeps the per-server identity the list always had.
@Observable
@MainActor
final class IOSInstanceIdentity: AppExtension {
    private(set) var instanceID: String?
    /// The server relays notifications for its mirrored machines and accepts the coverage fields
    /// in push registration (#3058); older servers get the registration they always had.
    private(set) var pushRelay = false
    /// The read is over, answered or not: a notification naming an instance stops waiting here.
    private(set) var settled = false
    @ObservationIgnored private var reader: Task<Void, Never>?

    required init(store: SessionStore, app: AppModel) {
        let client = store.client
        reader = Task { [weak self] in
            var delay: Duration = .seconds(2)
            while !Task.isCancelled {
                do {
                    let identity = try await client.instance()
                    self?.instanceID = identity.instanceId
                    self?.pushRelay = identity.pushRelay == true
                    self?.settled = true
                    return
                } catch ShepherdError.transport(_) {
                    // Not reachable yet: the store reconnects on its own, and so does this read.
                } catch {
                    self?.settled = true
                    return
                }
                do { try await Task.sleep(for: delay) } catch { return }
                delay = min(delay * 2, .seconds(30))
            }
        }
    }

    func teardown() {
        reader?.cancel()
        reader = nil
    }
}
