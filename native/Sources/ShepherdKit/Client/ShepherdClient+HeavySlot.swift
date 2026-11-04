extension ShepherdClient {
  public func heavySlot() async throws -> Components.Schemas.HeavySlotSnapshot {
    do {
      switch try await generated.getHeavySlot(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, let payload):
        throw await ShepherdError.fromUndocumented(statusCode: statusCode, payload: payload, route: "getHeavySlot")
      }
    } catch { throw ShepherdError.from(error, route: "getHeavySlot") }
  }
}
