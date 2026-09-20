import Foundation
import OpenAPIRuntime

public typealias SettingsPatch = Components.Schemas.SettingsPatch
public typealias SettingsPatchResult = Components.Schemas.SettingsPatchResult
public typealias RepoConfig = Components.Schemas.RepoConfig
public typealias RepoConfigPatch = Components.Schemas.RepoConfigPatch
public typealias RepoRoles = Components.Schemas.RepoRoles
public typealias RepoRolesResult = Components.Schemas.RepoRolesResult
public typealias RepoRolesPatch = Components.Schemas.RepoRolesPatch
public typealias RepoCollaborators = Components.Schemas.RepoCollaborators
public typealias DiagnosticState = Components.Schemas.DiagnosticState
public typealias DiagnosticCheck = Components.Schemas.DiagnosticCheck
public typealias DiagnosticsSnapshot = Components.Schemas.DiagnosticsSnapshot
public typealias DiagnosticsFix = Components.Schemas.DiagnosticsFix
public typealias KeyVerification = Components.Schemas.KeyVerification
public typealias DirectoryEntry = Components.Schemas.DirectoryEntry
public typealias DirectoryListing = Components.Schemas.DirectoryListing
public typealias RepoPullRequest = Components.Schemas.RepoPullRequest
public typealias RepoPullResult = Components.Schemas.RepoPullResult
public typealias RepoForkRequest = Components.Schemas.RepoForkRequest
public typealias ForkedRepo = Components.Schemas.ForkedRepo
public typealias RepoSyncForkRequest = Components.Schemas.RepoSyncForkRequest
public typealias RepoSyncForkResult = Components.Schemas.RepoSyncForkResult
extension Components.Schemas.DiagnosticState: OpenEnum {}
extension Components.Schemas.RepoRolesPatch {
    public static func values(reviewer: String?, merger: String?) throws -> Self {
        .init(reviewer: try OpenAPIValueContainer(unvalidatedValue: reviewer),
            merger: try OpenAPIValueContainer(unvalidatedValue: merger))
    }
}

extension ShepherdClient {
    public func getRepoConfig(repo: String) async throws -> Components.Schemas.RepoConfig {
        do {
            switch try await generated.getRepoConfig(.init(query: .init(repo: repo))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getRepoConfig")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoConfig") }
    }
    public func putRepoConfig(repo: String, body: RepoConfigPatch) async throws -> Components.Schemas.RepoConfig {
        do {
            switch try await generated.putRepoConfig(.init(query: .init(repo: repo), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "putRepoConfig")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoConfig") }
    }
    public func getRepoRoles(repo: String) async throws -> Components.Schemas.RepoRolesResult {
        do {
            switch try await generated.getRepoRoles(.init(query: .init(repo: repo))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getRepoRoles")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoRoles") }
    }
    public func putRepoRoles(repo: String, body: RepoRolesPatch) async throws -> Components.Schemas.RepoRolesResult {
        do {
            switch try await generated.putRepoRoles(.init(query: .init(repo: repo), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .badGateway(let value): throw ShepherdError.upstreamFailure(code: nil, message: try value.body.json.pushError ?? "push rejected")
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "putRepoRoles")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoRoles") }
    }
    public func getRepoCollaborators(repo: String) async throws -> Components.Schemas.RepoCollaborators {
        do {
            switch try await generated.getRepoCollaborators(.init(query: .init(repo: repo))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getRepoCollaborators")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoCollaborators") }
    }
    public func getDiagnostics(refresh: String? = nil) async throws -> Components.Schemas.DiagnosticsSnapshot {
        do {
            switch try await generated.getDiagnostics(.init(query: .init(refresh: refresh))) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getDiagnostics")
            }
        } catch { throw ShepherdError.from(error, route: "getDiagnostics") }
    }
    public func fixDiagnostics(body: DiagnosticsFix) async throws -> Components.Schemas.DiagnosticsSnapshot {
        do {
            switch try await generated.fixDiagnostics(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "fixDiagnostics")
            }
        } catch { throw ShepherdError.from(error, route: "fixDiagnostics") }
    }
    public func verifySettingsKey() async throws -> Components.Schemas.KeyVerification {
        do {
            switch try await generated.verifySettingsKey(.init()) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "verifySettingsKey")
            }
        } catch { throw ShepherdError.from(error, route: "verifySettingsKey") }
    }
    public func listDirectories(path: String? = nil) async throws -> Components.Schemas.DirectoryListing {
        do {
            switch try await generated.listDirectories(.init(query: .init(path: path))) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "listDirectories")
            }
        } catch { throw ShepherdError.from(error, route: "listDirectories") }
    }
    public func pullRepo(body: RepoPullRequest) async throws -> Components.Schemas.RepoPullResult {
        do {
            switch try await generated.pullRepo(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value):
                let result = try value.body.json
                throw ShepherdError.conflict(code: result.reason, message: result.reason ?? "pull failed")
            case .badGateway(let value):
                let result = try value.body.json
                throw ShepherdError.upstreamFailure(code: result.reason, message: result.reason ?? "pull failed")
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "pullRepo")
            }
        } catch { throw ShepherdError.from(error, route: "pullRepo") }
    }
    public func forkRepo(body: RepoForkRequest) async throws -> Components.Schemas.ForkedRepo {
        do {
            switch try await generated.forkRepo(.init(body: .json(body))) {
            case .created(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .unprocessableContent(let value): throw ShepherdError.unprocessable(try value.body.json.error)
            case .gatewayTimeout(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "forkRepo")
            }
        } catch { throw ShepherdError.from(error, route: "forkRepo") }
    }
    public func syncFork(body: RepoSyncForkRequest) async throws -> Components.Schemas.RepoSyncForkResult {
        do {
            switch try await generated.syncFork(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "syncFork")
            }
        } catch { throw ShepherdError.from(error, route: "syncFork") }
    }
    public func patchSettings(body: SettingsPatch) async throws -> Components.Schemas.SettingsPatchResult {
        do {
            switch try await generated.patchSettings(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "patchSettings")
            }
        } catch { throw ShepherdError.from(error, route: "patchSettings") }
    }
    public func loginForTokenAdministration(password: String) async throws {
        do {
            switch try await generated.login(.init(body: .json(.init(password: password)))) {
            case .ok: return
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "login")
            }
        } catch { throw ShepherdError.from(error, route: "login") }
    }
    public func listAccessTokens() async throws -> Components.Schemas.AccessTokenList {
        do {
            switch try await generated.listAccessTokens(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "listAccessTokens")
            }
        } catch { throw ShepherdError.from(error, route: "listAccessTokens") }
    }
    public func mintAccessToken(body: Components.Schemas.AccessTokenMintRequest) async throws -> Components.Schemas.AccessTokenMinted {
        do {
            switch try await generated.mintAccessToken(.init(body: .json(body))) {
            case .created(let created): return try created.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "mintAccessToken")
            }
        } catch { throw ShepherdError.from(error, route: "mintAccessToken") }
    }
    public func revokeAccessToken(id: String) async throws {
        do {
            switch try await generated.revokeAccessToken(.init(path: .init(id: id))) {
            case .ok: return
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "revokeAccessToken")
            }
        } catch { throw ShepherdError.from(error, route: "revokeAccessToken") }
    }
}
