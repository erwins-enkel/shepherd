#if os(macOS)
import Foundation

/// `GET http://127.0.0.1:<port>/api/health` — the one route with `security: []`
/// in the contract, so no token and no profile are needed. This is the kit's own
/// check, used by the supervisor's poll; the app's welcome card keeps using its
/// existing `LocalServerProbe`, which also reports the server version.
public struct LocalHealthCheck: Sendable {
  public let url: URL
  private let load: @Sendable (URLRequest) async throws -> (Data, URLResponse)
  private let timeout: TimeInterval

  public init(port: Int = 7330, session: URLSession = .shared, timeout: TimeInterval = 1.5) {
    self.url = URL(string: "http://127.0.0.1:\(port)/api/health")!
    self.load = { try await session.data(for: $0) }
    self.timeout = timeout
  }

  /// Inject only transport in tests, keeping the request and decoding path real.
  init(port: Int = 7330, timeout: TimeInterval = 1.5,
       load: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse)) {
    self.url = URL(string: "http://127.0.0.1:\(port)/api/health")!
    self.timeout = timeout
    self.load = load
  }

  /// Short timeout: this runs in a poll loop while the operator watches a
  /// spinner. Any failure at all reads as "not healthy yet".
  public func callAsFunction(expectedIdentity: LocalServerIdentity? = nil) async -> Bool {
    guard let health = await read() else { return false }
    guard let expectedIdentity else { return true }
    guard let actual = health.localInstall else { return false }
    return expectedIdentity.matches(LocalServerIdentity(actual))
  }

  /// Generated contract decoding shared by discovery and owned-child readiness.
  public func read() async -> Components.Schemas.Health? {
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    do {
      let (data, response) = try await load(request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
      let health = try JSONDecoder().decode(Components.Schemas.Health.self, from: data)
      guard health.ok, !health.version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
      return health
    } catch { return nil }
  }
}
#endif
