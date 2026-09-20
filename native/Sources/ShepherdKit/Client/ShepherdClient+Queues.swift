// Read-side queue enums keep future server values through the generated anyOf wrappers.
// The shared OpenEnum protocol supplies known/rawValue and known/unknown initializers.
extension Components.Schemas.HeldReason: OpenEnum {}
extension Components.Schemas.UpNextKind: OpenEnum {}
extension Components.Schemas.UsageSource: OpenEnum {}
extension Components.Schemas.UpNextSection.KindPayload: OpenEnum {}
extension Components.Schemas.SessionHaltEvent.HaltReasonPayload: OpenEnum {}

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
