import Foundation

// Short names for the sidebar schemas, alongside Model/PublicTypes.swift. Typealiases, not
// wrappers: one definition of each type, still from the contract.
public typealias HoldReason = Components.Schemas.HoldReason
public typealias HoldCode = Components.Schemas.HoldCode
public typealias HoldCodeKnown = Components.Schemas.HoldCodeKnown
public typealias BlockReason = Components.Schemas.BlockReason
public typealias UsageLimits = Components.Schemas.UsageLimits
public typealias UsageLimitsResponse = Components.Schemas.UsageLimitsResponse
public typealias UsageProjection = Components.Schemas.UsageProjection

// `HoldCode` is one of the contract's open enums (see `Model/OpenEnum.swift`): its shape is
// `{value1: HoldCodeKnown?, value2: String?}`, exactly what the protocol requires. It has no
// component of its own in that file because `HoldCode` shipped after it, in the sidebar stream —
// conforming it here keeps callers switching on `.known` / reading `.rawValue` like every other
// open enum instead of reaching into `value1`/`value2` directly.
extension Components.Schemas.HoldCode: OpenEnum {}

/// The four snapshot reads the Herd sidebar and header bootstrap from. Each is a plain in-memory
/// snapshot server-side, so re-reading is cheap — which is what the sidebar does, because the
/// matching `/events` frames carry a signal, not a patch.
extension ShepherdClient {
  /// `GET /api/working-blocked` — session id to "is in fact still producing output".
  public func workingBlocked() async throws -> [String: Bool] {
    do {
      switch try await generated.getWorkingBlocked(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getWorkingBlocked")
      }
    } catch { throw ShepherdError.from(error, route: "getWorkingBlocked") }
  }

  /// `GET /api/holds` — session id to why that session is parked. Absent means not holding.
  public func holds() async throws -> [String: HoldReason] {
    do {
      switch try await generated.getHolds(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getHolds")
      }
    } catch { throw ShepherdError.from(error, route: "getHolds") }
  }

  /// `GET /api/blocks` — the map `SessionStore` keeps live from `session:block`, read once at
  /// bootstrap so the first paint is not empty.
  public func blocks() async throws -> [String: BlockReason] {
    do {
      switch try await generated.getBlocks(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getBlocks")
      }
    } catch { throw ShepherdError.from(error, route: "getBlocks") }
  }

  /// `GET /api/usage/limits` — the wrapper. The `usage:limits` push carries `UsageLimits` bare, so
  /// projections only move on an explicit re-read.
  public func usage() async throws -> UsageLimitsResponse {
    do {
      switch try await generated.getUsageLimits(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getUsageLimits")
      }
    } catch { throw ShepherdError.from(error, route: "getUsageLimits") }
  }
}
