import Foundation
import OpenAPIRuntime

public typealias HerdrRuntimeStatus = Components.Schemas.HerdrRuntimeStatus
public typealias HerdrUpdateStatus = Components.Schemas.HerdrUpdateStatus
public typealias HerdrUpdateResult = Components.Schemas.HerdrUpdateResult
public typealias CodexUpdateStatus = Components.Schemas.CodexUpdateStatus
public typealias CodexUpdateResult = Components.Schemas.CodexUpdateResult
public typealias CodexReleaseNotesResult = Components.Schemas.CodexReleaseNotesResult

extension ShepherdClient {
    public func getHerdrUpdate() async throws -> HerdrUpdateStatus {
        do {
            switch try await generated.getHerdrUpdate(.init()) {
            case .ok(let value): return try value.body.json
            case .forbidden: throw ShepherdError.forbidden
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "getHerdrUpdate")
            }
        } catch { throw ShepherdError.from(error, route: "getHerdrUpdate") }
    }
    public func getCodexUpdate() async throws -> CodexUpdateStatus {
        do {
            switch try await generated.getCodexUpdate(.init()) {
            case .ok(let value): return try value.body.json
            case .forbidden: throw ShepherdError.forbidden
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "getCodexUpdate")
            }
        } catch { throw ShepherdError.from(error, route: "getCodexUpdate") }
    }
    public func getCodexReleaseNotes() async throws -> CodexReleaseNotesResult {
        do {
            switch try await generated.getCodexReleaseNotes(.init()) {
            case .ok(let value): return try value.body.json
            case .forbidden: throw ShepherdError.forbidden
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "getCodexReleaseNotes")
            }
        } catch { throw ShepherdError.from(error, route: "getCodexReleaseNotes") }
    }
    public func applyHerdrUpdate() async throws {
        do {
            switch try await generated.applyHerdrUpdate(.init()) {
            case .accepted(let value):
                guard try value.body.json.ok else { throw ShepherdError.conflict(code: "runner_update_not_started", message: "update not started") }
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .conflict(let value):
                let body = try value.body.json
                throw ShepherdError.conflict(code: body.code ?? (body.error == nil ? "runner_update_not_started" : nil),
                    message: body.error ?? "update not started")
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "applyHerdrUpdate")
            }
        } catch { throw ShepherdError.from(error, route: "applyHerdrUpdate") }
    }
    public func applyHerdrDowngrade() async throws {
        do {
            switch try await generated.applyHerdrDowngrade(.init()) {
            case .accepted(let value):
                guard try value.body.json.ok else { throw ShepherdError.conflict(code: "runner_update_not_started", message: "update not started") }
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .conflict(let value):
                let body = try value.body.json
                throw ShepherdError.conflict(code: body.code ?? (body.error == nil ? "runner_update_not_started" : nil),
                    message: body.error ?? "update not started")
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "applyHerdrDowngrade")
            }
        } catch { throw ShepherdError.from(error, route: "applyHerdrDowngrade") }
    }
    public func applyHerdrSandboxDowngrade() async throws {
        do {
            switch try await generated.applyHerdrSandboxDowngrade(.init()) {
            case .accepted(let value):
                guard try value.body.json.ok else { throw ShepherdError.conflict(code: "runner_update_not_started", message: "update not started") }
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .conflict(let value):
                let body = try value.body.json
                throw ShepherdError.conflict(code: body.code ?? (body.error == nil ? "runner_update_not_started" : nil),
                    message: body.error ?? "update not started")
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "applyHerdrSandboxDowngrade")
            }
        } catch { throw ShepherdError.from(error, route: "applyHerdrSandboxDowngrade") }
    }
    public func restartHerdrServer(installedVersion: String, serverVersion: String?) async throws {
        do {
            switch try await generated.restartHerdrServer(.init(body: .json(.init(confirmed: true,
                installedVersion: installedVersion, serverVersion: try OpenAPIValueContainer(unvalidatedValue: serverVersion))))) {
            case .accepted(let value):
                guard try value.body.json.ok else { throw ShepherdError.conflict(code: "runner_update_not_started", message: "update not started") }
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .conflict(let value):
                let body = try value.body.json
                throw ShepherdError.conflict(code: body.code ?? (body.error == nil ? "runner_update_not_started" : nil),
                    message: body.error ?? "update not started")
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "restartHerdrServer")
            }
        } catch { throw ShepherdError.from(error, route: "restartHerdrServer") }
    }
    public func applyCodexUpdate() async throws {
        do {
            switch try await generated.applyCodexUpdate(.init()) {
            case .accepted(let value):
                guard try value.body.json.ok else { throw ShepherdError.conflict(code: "runner_update_not_started", message: "update not started") }
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .conflict(let value):
                let body = try value.body.json
                throw ShepherdError.conflict(code: body.code ?? (body.error == nil ? "runner_update_not_started" : nil),
                    message: body.error ?? "update not started")
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _):
                if status == 404 { throw ShepherdError.notFound }
                throw ShepherdError.fromUndocumented(statusCode: status, route: "applyCodexUpdate")
            }
        } catch { throw ShepherdError.from(error, route: "applyCodexUpdate") }
    }
}
