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

// Aliases expose the contract's types without creating a second wire model.
public typealias HeldQueueEntry = Components.Schemas.HeldQueueEntry
public typealias HeldReason = Components.Schemas.HeldReason
public typealias UpNextItem = Components.Schemas.UpNextItem
public typealias UpNextSection = Components.Schemas.UpNextSection
public typealias UpNextSnapshot = Components.Schemas.UpNextSnapshot
public typealias UpNextKind = Components.Schemas.UpNextKind
public typealias UpNextStartItem = Components.Schemas.UpNextStartItem
public typealias HaltResult = Components.Schemas.HaltResult
public typealias RetryResult = Components.Schemas.RetryResult
public typealias ReviveResult = Components.Schemas.ReviveResult
public typealias SessionUsage = Components.Schemas.SessionUsage
public typealias UsageSource = Components.Schemas.UsageSource
public typealias BroadcastResult = Components.Schemas.BroadcastResult
public typealias RestoreConflict = Components.Schemas.RestoreConflict
public typealias RestoreConflictReason = Components.Schemas.RestoreConflictReason

extension Components.Schemas.RestoreConflictReason: OpenEnum {}
// Throw the generated payload itself: its open code supports all six current reasons and
// preserves future ones, while the server's sentence remains available for diagnostics.
extension Components.Schemas.RestoreConflict: Error {}

/// A local selection, flattened into the generated request by `startUpNext`.
/// This is not a wire payload; the contract remains the only Codable definition.
public struct UpNextStartChoice: Sendable, Equatable {
  public var agentProvider: AgentProvider?
  public var model: String?
  public var effort: String?

  public init(agentProvider: AgentProvider? = nil, model: String? = nil, effort: String? = nil) {
    self.agentProvider = agentProvider
    self.model = model
    self.effort = effort
  }
}

/// The HTTP outcome plus the unmodified generated body. Held rows and errors can coexist
/// with created sessions, so callers must inspect all three arrays for every outcome.
public struct UpNextStartResult: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    case created
    case held
    case allErrors
  }

  public let outcome: Outcome
  public let body: Components.Schemas.UpNextStartResult

  public init(outcome: Outcome, body: Components.Schemas.UpNextStartResult) {
    self.outcome = outcome
    self.body = body
  }

  public var created: [Session] { body.created }
  public var held: [Components.Schemas.UpNextStartHeld] { body.held }
  public var errors: [Components.Schemas.UpNextStartError] { body.errors }
}

extension ShepherdClient {
  /// `GET /api/held`. Preserve the server's capacity-last, FIFO ordering.
  public func heldTasks() async throws -> [HeldQueueEntry] {
    do {
      switch try await generated.listHeld(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listHeld")
      }
    } catch { throw ShepherdError.from(error, route: "listHeld") }
  }

  /// `PATCH /api/held/{id}` replaces the full create input while keeping its queue position.
  public func updateHeld(id: String, input: CreateSessionRequest) async throws -> HeldQueueEntry {
    do {
      switch try await generated.updateHeld(.init(path: .init(id: id), body: .json(input))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "updateHeld")
      }
    } catch { throw ShepherdError.from(error, route: "updateHeld") }
  }

  /// `POST /api/held/{id}/spawn` returns the created Session with 201. Preserve the
  /// create-error ladder so sandbox refusal, terminal conflicts and a missing base differ.
  public func spawnHeld(id: String, agentProvider: AgentProvider?) async throws -> Session {
    do {
      switch try await generated.spawnHeld(.init(
        path: .init(id: id), body: agentProvider.map { .json(.init(agentProvider: $0)) }
      )) {
      case .created(let created): return try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .forbidden: throw ShepherdError.forbidden
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .unprocessableContent(let bad): throw ShepherdError.unprocessable(try bad.body.json.error)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "spawnHeld")
      }
    } catch { throw ShepherdError.from(error, route: "spawnHeld") }
  }

  /// `DELETE /api/held/{id}` succeeds even for a missing id. The caller must re-read
  /// the list after success; this is not proof the row existed or a local-store mutation.
  public func discardHeld(id: String) async throws {
    do {
      switch try await generated.discardHeld(.init(path: .init(id: id))) {
      case .ok: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "discardHeld")
      }
    } catch { throw ShepherdError.from(error, route: "discardHeld") }
  }

  /// `POST /api/up-next/refresh` accepts computation with 202. Read the snapshot from
  /// the upnext:snapshot event; acceptance does not mean computation has finished.
  public func refreshUpNext() async throws {
    do {
      switch try await generated.refreshUpNext(.init()) {
      case .accepted: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .serviceUnavailable(let unavailable):
        throw ShepherdError.fromUpstream(try unavailable.body.json)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "refreshUpNext")
      }
    } catch { throw ShepherdError.from(error, route: "refreshUpNext") }
  }

  /// `POST /api/up-next/start`. 201 created sessions, 200 held items, 502 all errors:
  /// all three return the result body so no per-item error is discarded.
  public func startUpNext(
    items: [UpNextStartItem], choice: UpNextStartChoice?
  ) async throws -> UpNextStartResult {
    let request = Components.Schemas.UpNextStartRequest(
      items: items, agentProvider: choice?.agentProvider, model: choice?.model, effort: choice?.effort)
    do {
      switch try await generated.startUpNext(.init(body: .json(request))) {
      case .created(let created): return .init(outcome: .created, body: try created.body.json)
      case .ok(let ok): return .init(outcome: .held, body: try ok.body.json)
      case .badGateway(let bad): return .init(outcome: .allErrors, body: try bad.body.json)
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "startUpNext")
      }
    } catch { throw ShepherdError.from(error, route: "startUpNext") }
  }

  /// `POST /api/halt`. The count is the server's answer; events reconcile the store.
  public func halt() async throws -> HaltResult {
    do {
      switch try await generated.haltHerd(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .methodNotAllowed:
        // This wrapper always sends POST; a 405 therefore contradicts the route.
        throw ShepherdError.contractMismatch(
          route: "haltHerd", underlying: "POST /api/halt returned 405 Method Not Allowed")
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "haltHerd")
      }
    } catch { throw ShepherdError.from(error, route: "haltHerd") }
  }

  /// `POST /api/retry`. `total` counts requested ids, including ones the server skipped.
  public func retry(ids: [String], text: String) async throws -> RetryResult {
    do {
      switch try await generated.retryHalted(.init(body: .json(.init(text: text, ids: ids)))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "retryHalted")
      }
    } catch { throw ShepherdError.from(error, route: "retryHalted") }
  }

  public func strandedSessions() async throws -> [String] {
    do {
      switch try await generated.listStranded(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listStranded")
      }
    } catch { throw ShepherdError.from(error, route: "listStranded") }
  }

  /// The server computes which sessions to revive; the client supplies no target list.
  public func reviveStranded() async throws -> ReviveResult {
    do {
      switch try await generated.reviveStranded(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "reviveStranded")
      }
    } catch { throw ShepherdError.from(error, route: "reviveStranded") }
  }

  /// `POST /api/sessions/{id}/restore`. Throws `RestoreConflict` for a 409, whose
  /// generated open `code` distinguishes all six current reasons without parsing sentences.
  public func restore(sessionID: String) async throws -> Session {
    do {
      switch try await generated.restoreSession(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw try conflict.body.json
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "restoreSession")
      }
    } catch let conflict as RestoreConflict {
      throw conflict
    } catch { throw ShepherdError.from(error, route: "restoreSession") }
  }

  public func broadcast(ids: [String], text: String) async throws -> BroadcastResult {
    do {
      switch try await generated.broadcast(.init(body: .json(.init(text: text, ids: ids)))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "broadcast")
      }
    } catch { throw ShepherdError.from(error, route: "broadcast") }
  }
}
