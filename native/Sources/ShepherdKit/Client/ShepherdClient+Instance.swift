import Foundation

extension ShepherdClient {
  /// `GET /api/instance` — this server's persisted identity (#2759). A client connected to
  /// several servers keys sessions by its `instanceId`, so a session mirrored through a
  /// coordinator and the same session read from its own machine are recognised as one.
  public func instance() async throws -> InstanceIdentity {
    do {
      switch try await generated.getInstance(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getInstance")
      }
    } catch { throw ShepherdError.from(error, route: "getInstance") }
  }
}
