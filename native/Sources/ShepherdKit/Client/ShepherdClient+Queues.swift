extension ShepherdClient {
  /// Archived usage is a static snapshot. The Done panel reads it once per selection.
  public func sessionUsage(id: String) async throws -> Components.Schemas.SessionUsage {
    do {
      switch try await generated.sessionUsage(.init(path: .init(id: id))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "sessionUsage")
      }
    } catch { throw ShepherdError.from(error, route: "sessionUsage") }
  }
}
