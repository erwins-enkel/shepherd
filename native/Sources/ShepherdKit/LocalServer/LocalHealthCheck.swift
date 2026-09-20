#if os(macOS)
import Foundation

/// `GET http://127.0.0.1:<port>/api/health` — the one route with `security: []`
/// in the contract, so no token and no profile are needed. This is the kit's own
/// check, used by the supervisor's poll; the app's welcome card keeps using its
/// existing `LocalServerProbe`, which also reports the server version.
public struct LocalHealthCheck: Sendable {
  public let url: URL
  private let session: URLSession

  public init(port: Int = 7330, session: URLSession = .shared) {
    self.url = URL(string: "http://127.0.0.1:\(port)/api/health")!
    self.session = session
  }

  private struct Health: Decodable { let ok: Bool }

  /// Short timeout: this runs in a poll loop while the operator watches a
  /// spinner. Any failure at all reads as "not healthy yet".
  public func callAsFunction() async -> Bool {
    var request = URLRequest(url: url)
    request.timeoutInterval = 1.5
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
      return try JSONDecoder().decode(Health.self, from: data).ok
    } catch { return false }
  }
}
#endif
