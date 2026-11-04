import Foundation
import OpenAPIRuntime

/// This Shepherd's own self-update (#2987) — the routes the web update modal drives.
public typealias ServerUpdateStatus = Components.Schemas.UpdateStatus
public typealias ServerUpdateCommit = Components.Schemas.UpdateCommit
public typealias ServerUpdateDirty = Components.Schemas.UpdateDirtyStatus
public typealias ServerUpdateDeploy = Components.Schemas.UpdateDeployState

/// `POST /api/update` refused a discard because the tracked changes moved since the
/// snapshot the operator confirmed. Carries the fresh snapshot, to show and confirm again.
public struct ServerUpdateStale: Error, Equatable, Sendable {
    public let dirty: ServerUpdateDirty
    public init(dirty: ServerUpdateDirty) { self.dirty = dirty }
}

extension ShepherdClient {
    /// How far the server's running checkout is behind its tracked branch.
    public func updateStatus() async throws -> ServerUpdateStatus {
        do {
            switch try await generated.getUpdateStatus(.init()) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .undocumented(let status, let payload):
                if status == 404 { throw ShepherdError.notFound }
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "getUpdateStatus")
            }
        } catch { throw ShepherdError.from(error, route: "getUpdateStatus") }
    }

    /// The detached deploy's live state and output tail.
    public func updateLog() async throws -> ServerUpdateDeploy {
        do {
            switch try await generated.getUpdateLog(.init()) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .undocumented(let status, let payload):
                if status == 404 { throw ShepherdError.notFound }
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "getUpdateLog")
            }
        } catch { throw ShepherdError.from(error, route: "getUpdateLog") }
    }

    /// A fresh snapshot of the tracked changes an update would trip over (or discard).
    public func updateDirty() async throws -> ServerUpdateDirty {
        do {
            switch try await generated.getUpdateDirty(.init()) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, let payload):
                if status == 404 { throw ShepherdError.notFound }
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "getUpdateDirty")
            }
        } catch { throw ShepherdError.from(error, route: "getUpdateDirty") }
    }

    /// Starts the update. `discard` resets the listed tracked changes first, and only while
    /// they still match `sig` — the signature of the snapshot the operator was shown;
    /// otherwise the server answers `ServerUpdateStale` with the fresh one.
    public func applyUpdate(discard: Bool = false, sig: String? = nil) async throws {
        let request = discard
            ? Components.Schemas.UpdateApplyRequest(discard: true, sig: sig)
            : Components.Schemas.UpdateApplyRequest()
        do {
            switch try await generated.applyUpdate(.init(body: .json(request))) {
            case .accepted: return
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .conflict(let value):
                let body = try value.body.json
                if body.error == "stale", let dirty = body.dirty { throw ServerUpdateStale(dirty: dirty) }
                throw ShepherdError.conflict(code: nil, message: body.error)
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, let payload):
                if status == 404 { throw ShepherdError.notFound }
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "applyUpdate")
            }
        } catch let stale as ServerUpdateStale {
            throw stale
        } catch { throw ShepherdError.from(error, route: "applyUpdate") }
    }
}
