import Foundation
import ShepherdKit

enum LocalServerStatus: Sendable, Equatable {
    case found(version: String)
    case absent
}

/// Unauthenticated liveness check for a Shepherd server already running on this
/// Mac. GET /api/health is the one route with `security: []` in the contract, so
/// no token and no profile are needed.
struct LocalServerProbe: Sendable {
    static let defaultURL = URL(string: "http://127.0.0.1:7330/api/health")!

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    /// Short timeout: this runs on the welcome screen while the operator waits.
    func probe(url: URL = LocalServerProbe.defaultURL) async -> LocalServerStatus {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                Log.connect.debug("local probe: non-200")
                return .absent
            }
            let health = try JSONDecoder().decode(Components.Schemas.Health.self, from: data)
            guard health.ok, !health.version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .absent }
            Log.connect.info("local server found, version \(health.version, privacy: .public)")
            return .found(version: health.version)
        } catch {
            Log.connect.debug("local probe failed: \(String(describing: error), privacy: .public)")
            return .absent
        }
    }
}
