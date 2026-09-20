import Foundation

// Short names for the action schemas, alongside Model/PublicTypes.swift. Typealiases, not
// wrappers: one definition of each type, still from the contract.
public typealias RenameResult = Components.Schemas.RenameResult
public typealias TaskAmendment = Components.Schemas.TaskAmendment
public typealias AmendmentCreated = Components.Schemas.AmendmentCreated
public typealias Recap = Components.Schemas.Recap
public typealias RecapState = Components.Schemas.RecapState
public typealias RecapStateKnown = Components.Schemas.RecapStateKnown
public typealias RecapVerdict = Components.Schemas.RecapVerdict
public typealias RecapVerdictKnown = Components.Schemas.RecapVerdictKnown
public typealias RelaunchResult = Components.Schemas.RelaunchResult
public typealias RecapRegenerateResult = Components.Schemas.RecapRegenerateResult
public typealias RecapRegenerateStatus = Components.Schemas.RecapRegenerateStatus
public typealias RecapRegenerateStatusKnown = Components.Schemas.RecapRegenerateStatusKnown

// The three schemas this stream flags `x-shepherd-open-enum: true`. The derivation gives each an
// `anyOf` shape and a `<Name>Known` companion, but `known`, `rawValue`, `init(known:)` and
// `init(unknown:)` come from `Model/OpenEnum.swift`'s protocol extension, which reaches a type only
// once that type conforms. `OpenEnum.swift` itself hard-codes the nine core conformances and is
// S0-owned, so this stream declares its own three here — same module, no retroactive conformance.
// Without these lines every `RecapVerdict(known:)` and `.known` below fails to compile.
extension Components.Schemas.RecapState: OpenEnum {}
extension Components.Schemas.RecapVerdict: OpenEnum {}
extension Components.Schemas.RecapRegenerateStatus: OpenEnum {}

/// The per-session commands the action bar issues.
///
/// Every one of them maps the generated `Output` enum onto a value or a `ShepherdError`, so
/// callers never see a generated response case. None of them mutates `SessionStore`: the
/// server's own `/events` frames do that, which is what keeps a command issued here and a
/// command issued from the web UI indistinguishable to the list.
extension ShepherdClient {
  /// `POST /api/sessions/{id}/resume`. `force` defaults to `true`, matching the web's card menu
  /// (`resumeSession(id, true)`): it is the escape hatch for a husk the liveness sweep still
  /// believes in, and a non-forced resume of a live pane is a no-op the operator reads as a
  /// broken button.
  public func resume(sessionID: String, force: Bool = true) async throws -> Session {
    do {
      switch try await generated.resumeSession(
        .init(path: .init(id: sessionID), body: .json(.init(force: force)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "resumeSession")
      }
    } catch { throw ShepherdError.from(error, route: "resumeSession") }
  }

  /// `POST /api/sessions/{id}/rename`. The server slugifies `name`; `branchRenamed` is false when
  /// an open PR pinned the branch, which the caller must say out loud — a silent display-only
  /// rename reads as a half-failed command.
  public func rename(sessionID: String, name: String) async throws -> RenameResult {
    do {
      switch try await generated.renameSession(
        .init(path: .init(id: sessionID), body: .json(.init(name: name)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "renameSession")
      }
    } catch { throw ShepherdError.from(error, route: "renameSession") }
  }

  /// `POST /api/sessions/{id}/amendments`. The amendment is persisted before it is steered, so a
  /// `steered == false` result still means "recorded".
  public func amend(
    sessionID: String, text: String, steer: Bool
  ) async throws -> AmendmentCreated {
    do {
      switch try await generated.amendSession(
        .init(path: .init(id: sessionID), body: .json(.init(text: text, steer: steer)))
      ) {
      case .created(let created): return try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "amendSession")
      }
    } catch { throw ShepherdError.from(error, route: "amendSession") }
  }

  /// `POST /api/sessions/{id}/ready` — the manual "parked / ready to merge" flag. The server
  /// answers `{ok:true}` and pushes the change as `session:ready`, so there is nothing to return.
  public func setReadyToMerge(sessionID: String, ready: Bool) async throws {
    do {
      switch try await generated.setSessionReady(
        .init(path: .init(id: sessionID), body: .json(.init(ready: ready)))
      ) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "setSessionReady")
      }
    } catch { throw ShepherdError.from(error, route: "setSessionReady") }
  }

  /// `POST /api/sessions/{id}/relaunch` with no body — the plain relaunch. Destructive: the
  /// original's worktree goes away. `archived == false` means the replacement is up but the
  /// original still needs closing by hand.
  public func relaunch(sessionID: String) async throws -> RelaunchResult {
    do {
      switch try await generated.relaunchSession(.init(path: .init(id: sessionID))) {
      case .created(let created): return try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      // 502: the replacement could not be spawned, or a same-repo relaunch could not re-resolve
      // the linked issue. The original is left intact, which is what makes this recoverable
      // rather than a lost session — the same mapping `createSession` gives its own 502.
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "relaunchSession")
      }
    } catch { throw ShepherdError.from(error, route: "relaunchSession") }
  }

  /// `POST /api/sessions/{id}/recap/regenerate`. Accepted, not completed — the recap itself
  /// arrives later as a `session:recap` frame.
  public func regenerateRecap(sessionID: String) async throws -> RecapRegenerateResult {
    do {
      switch try await generated.regenerateRecap(.init(path: .init(id: sessionID))) {
      case .accepted(let accepted): return try accepted.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "regenerateRecap")
      }
    } catch { throw ShepherdError.from(error, route: "regenerateRecap") }
  }

  /// `GET /api/recaps` — the bootstrap snapshot. Every later change rides `session:recap`.
  public func recaps() async throws -> [String: Recap] {
    do {
      switch try await generated.listRecaps(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listRecaps")
      }
    } catch { throw ShepherdError.from(error, route: "listRecaps") }
  }
}
