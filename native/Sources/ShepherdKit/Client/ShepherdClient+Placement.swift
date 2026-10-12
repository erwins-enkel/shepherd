import Foundation
import OpenAPIRuntime

// The machine choice (#2772–#2776): where a new task would run and why, what its description
// calls for, and the tasks for connected machines that are not settled yet.

public typealias Capability = Components.Schemas.Capability
public typealias CapabilityKnown = Components.Schemas.CapabilityKnown
public typealias MachinePlacement = Components.Schemas.Placement
public typealias PlacementRequest = Components.Schemas.PlacementRequest
public typealias PlacementPreview = Components.Schemas.PlacementPreview
public typealias PlacementWait = Components.Schemas.PlacementWait
public typealias PlacementRefusal = Components.Schemas.PlacementRefusal
public typealias TaskTarget = Components.Schemas.TaskTarget
public typealias RequirementsDeriveRequest = Components.Schemas.RequirementsDeriveRequest
public typealias RequirementsDerivation = Components.Schemas.RequirementsDerivation
public typealias RemoteDispatch = Components.Schemas.RemoteDispatch
public typealias RemoteDispatchState = Components.Schemas.RemoteDispatchState
public typealias DispatchReadiness = Components.Schemas.DispatchReadiness
public typealias SessionLaunchMetadata = Components.Schemas.SessionLaunchMetadata

extension Components.Schemas.Capability: OpenEnum {}
extension Components.Schemas.RemoteDispatchState: OpenEnum {}
extension Components.Schemas.DispatchReadiness.StatePayload: OpenEnum {}
extension Components.Schemas.Placement.ModePayload: OpenEnum {}
extension Components.Schemas.Placement.BasisPayload: OpenEnum {}
extension Components.Schemas.RequirementsDerivation.StatusPayload: OpenEnum {}
extension Components.Schemas.RequirementsDerivation.CausePayload: OpenEnum {}

extension Components.Schemas.Capability {
  /// A capability by its wire ID (`xcode`, `sdk:ios`, …), known to this client or not.
  public init(id: String) { self.init(value1: CapabilityKnown(rawValue: id), value2: id) }
}

/// A create or a redirect the machine choice refused, with the fields of the server's answer, so a
/// client can say in words what is missing or out of reach (`ui/src/lib/placement.ts`). Nothing was
/// stored, sent or started. `missing` holds capability IDs for `no_suitable_machine` and
/// `{capability, reason}` for `missing_capabilities`; both arrive here as `Missing`.
public struct MachineRefusal: Error, Equatable, Sendable {
  public struct Missing: Equatable, Sendable {
    public let capability: String
    /// Why the machine lacks it (`not_installed`, `not_verified`, …); nil when the answer names
    /// only the capability.
    public let reason: String?

    public init(capability: String, reason: String? = nil) {
      self.capability = capability
      self.reason = reason
    }
  }

  public let code: String
  /// The server's own sentence: the machine's reason for `remote_rejected`.
  public let error: String
  public let host: SessionHost?
  public let reason: String?
  public let together: Bool
  public let elsewhere: [SessionHost]
  public let missing: [Missing]

  public init(
    code: String, error: String = "", host: SessionHost? = nil, reason: String? = nil,
    together: Bool = false, elsewhere: [SessionHost] = [], missing: [Missing] = []
  ) {
    self.code = code
    self.error = error
    self.host = host
    self.reason = reason
    self.together = together
    self.elsewhere = elsewhere
    self.missing = missing
  }

  /// The 422 codes a create or redirect answers about the machine it would run on.
  public static let codes: Set<String> = [
    "no_suitable_machine", "missing_capabilities", "remote_rejected", "remote_target_unknown",
    "remote_target_unreleased", "remote_project_missing", "remote_project_unknown",
  ]

  /// The refusal in an error body, or nil when its code is not about the machine.
  public init?(_ body: Components.Schemas._Error) {
    guard let code = body.code, Self.codes.contains(code),
          let data = try? JSONEncoder().encode(body) else { return nil }
    self.init(json: data, fallbackCode: code, fallbackError: body.error)
  }

  /// The refusal a placement preview answers.
  public init(_ refusal: PlacementRefusal) {
    let data = (try? JSONEncoder().encode(refusal)) ?? Data()
    self.init(json: data, fallbackCode: refusal.code, fallbackError: refusal.error)
  }

  private init(json: Data, fallbackCode: String, fallbackError: String) {
    let wire = try? JSONDecoder().decode(Wire.self, from: json)
    self.init(
      code: wire?.code ?? fallbackCode, error: wire?.error ?? fallbackError, host: wire?.host,
      reason: wire?.reason, together: wire?.together ?? false, elsewhere: wire?.elsewhere ?? [],
      missing: wire?.missing ?? [])
  }

  /// Every member read on its own, so one unexpected shape never loses the others.
  private struct Wire: Decodable {
    var code: String?
    var error: String?
    var host: SessionHost?
    var reason: String?
    var together: Bool?
    var elsewhere: [SessionHost]?
    var missing: [Missing]?

    enum CodingKeys: String, CodingKey { case code, error, host, reason, together, elsewhere, missing }

    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      code = try? c.decodeIfPresent(String.self, forKey: .code)
      error = try? c.decodeIfPresent(String.self, forKey: .error)
      host = try? c.decodeIfPresent(SessionHost.self, forKey: .host)
      reason = try? c.decodeIfPresent(String.self, forKey: .reason)
      together = try? c.decodeIfPresent(Bool.self, forKey: .together)
      elsewhere = try? c.decodeIfPresent([SessionHost].self, forKey: .elsewhere)
      missing = (try? c.decodeIfPresent([MissingWire].self, forKey: .missing))?.map(\.value)
    }
  }

  /// `"xcode"` or `{"capability":"xcode","reason":"not_installed"}`.
  private struct MissingWire: Decodable {
    let value: Missing

    private enum CodingKeys: String, CodingKey { case capability, reason }

    init(from decoder: any Decoder) throws {
      if let id = try? decoder.singleValueContainer().decode(String.self) {
        value = Missing(capability: id)
        return
      }
      let c = try decoder.container(keyedBy: CodingKeys.self)
      value = Missing(
        capability: try c.decode(String.self, forKey: .capability),
        reason: try? c.decodeIfPresent(String.self, forKey: .reason))
    }
  }
}

/// What `DELETE /api/remote-dispatches/{id}` did.
public enum RemoteDispatchCancel: Equatable, Sendable {
  /// It never starts on the machine.
  case canceled(RemoteDispatch)
  /// The machine is out of reach: the cancel is delivered as soon as it answers.
  case pending(RemoteDispatch)
}

/// A remote dispatch that can no longer be canceled or redirected: the machine has it, it is being
/// sent right now, or it is not waiting any more. `dispatch` is what it is now, when the server
/// said.
public struct RemoteDispatchConflict: Error, Equatable, Sendable {
  public let code: String?
  public let dispatch: RemoteDispatch?

  public init(code: String?, dispatch: RemoteDispatch?) {
    self.code = code
    self.dispatch = dispatch
  }

  init(_ body: Components.Schemas._Error) {
    struct Wire: Decodable { var dispatch: RemoteDispatch? }
    let data = try? JSONEncoder().encode(body)
    let wire = data.flatMap { try? JSONDecoder().decode(Wire.self, from: $0) }
    self.init(code: body.code, dispatch: wire?.dispatch)
  }
}

extension ShepherdClient {
  /// `POST /api/placement` — where a create with these inputs would run and why, without storing
  /// or sending anything. A server that predates the machine choice answers 404: `.notFound`.
  public func previewPlacement(_ request: PlacementRequest) async throws -> PlacementPreview {
    do {
      switch try await generated.previewPlacement(.init(body: .json(request))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .forbidden: throw ShepherdError.forbidden
      case .undocumented(404, _): throw ShepherdError.notFound
      case .undocumented(let code, _):
        throw ShepherdError.fromUndocumented(statusCode: code, route: "previewPlacement")
      }
    } catch { throw ShepherdError.from(error, route: "previewPlacement") }
  }

  /// `POST /api/requirements/derive` — what the task's description calls for. A helper reads it
  /// for up to 30 seconds, so this runs on the long-running client.
  public func deriveRequirements(_ request: RequirementsDeriveRequest) async throws
    -> RequirementsDerivation
  {
    do {
      switch try await longRunning.deriveRequirements(.init(body: .json(request))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .forbidden: throw ShepherdError.forbidden
      case .undocumented(404, _): throw ShepherdError.notFound
      case .undocumented(let code, _):
        throw ShepherdError.fromUndocumented(statusCode: code, route: "deriveRequirements")
      }
    } catch { throw ShepherdError.from(error, route: "deriveRequirements") }
  }

  /// `GET /api/remote-dispatches` — tasks for connected machines that are not settled, oldest
  /// first. A server that predates them answers 404: `.notFound`.
  public func remoteDispatches() async throws -> [RemoteDispatch] {
    do {
      switch try await generated.listRemoteDispatches(.init()) {
      case .ok(let ok): return try ok.body.json.dispatches
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(404, _): throw ShepherdError.notFound
      case .undocumented(let code, _):
        throw ShepherdError.fromUndocumented(statusCode: code, route: "listRemoteDispatches")
      }
    } catch { throw ShepherdError.from(error, route: "listRemoteDispatches") }
  }

  /// `DELETE /api/remote-dispatches/{id}`. A dispatch that cannot be canceled any more throws
  /// `RemoteDispatchConflict`.
  public func cancelRemoteDispatch(id: String) async throws -> RemoteDispatchCancel {
    do {
      switch try await generated.cancelRemoteDispatch(.init(path: .init(id: id))) {
      case .ok(let ok): return .canceled(try ok.body.json)
      case .accepted(let accepted): return .pending(try accepted.body.json)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw RemoteDispatchConflict(try conflict.body.json)
      case .undocumented(let code, _):
        throw ShepherdError.fromUndocumented(statusCode: code, route: "cancelRemoteDispatch")
      }
    } catch let error as RemoteDispatchConflict { throw error }
    catch { throw ShepherdError.from(error, route: "cancelRemoteDispatch") }
  }

  /// `POST /api/remote-dispatches/{id}/redirect` — run a waiting task on `instanceId` now.
  /// Answered like a create: a session, a hold, or a wait for that machine. A machine that does
  /// not fit throws `MachineRefusal`; one that is not waiting any more `RemoteDispatchConflict`.
  public func redirectRemoteDispatch(id: String, to instanceId: String) async throws
    -> CreateOutcome
  {
    do {
      switch try await generated.redirectRemoteDispatch(.init(
        path: .init(id: id), body: .json(.init(target: .init(instanceId: instanceId)))))
      {
      case .created(let created): return .created(try created.body.json)
      case .ok(let ok): return .held(try ok.body.json)
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict):
        let body = try conflict.body.json
        if body.code == "remote_dispatch_not_redirectable" { throw RemoteDispatchConflict(body) }
        throw ShepherdError.fromConflict(body)
      case .unprocessableContent(let bad):
        let body = try bad.body.json
        if let refusal = MachineRefusal(body) { throw refusal }
        throw ShepherdError.unprocessable(body.error)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .gatewayTimeout(let timeout): throw ShepherdError.fromUpstream(try timeout.body.json)
      case .undocumented(let code, _):
        throw ShepherdError.fromUndocumented(statusCode: code, route: "redirectRemoteDispatch")
      }
    } catch let error as MachineRefusal { throw error }
    catch let error as RemoteDispatchConflict { throw error }
    catch { throw ShepherdError.from(error, route: "redirectRemoteDispatch") }
  }
}
