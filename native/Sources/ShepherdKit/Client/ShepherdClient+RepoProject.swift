import Foundation

public typealias RepoConfigProject = Components.Schemas.RepoConfigProject
public typealias RepoConfigMachine = Components.Schemas.RepoConfigMachine
public typealias RepoRules = Components.Schemas.RepoRules
public typealias RepoRulesPatch = Components.Schemas.RepoRulesPatch
public typealias RepoProjectPatch = Components.Schemas.RepoProjectPatch
public typealias RepoMachinePatch = Components.Schemas.RepoMachinePatch
public typealias RepoConfigProjectWrite = Components.Schemas.RepoConfigProjectWrite

extension ShepherdClient {
    public func getRepoConfigProject(remoteSlug: String) async throws -> RepoConfigProject {
        do {
            switch try await generated.getRepoConfigProject(.init(query: .init(remoteSlug: remoteSlug))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .undocumented(let status, let payload):
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "getRepoConfigProject")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoConfigProject") }
    }
    public func putRepoConfigProject(remoteSlug: String, instanceID: String, body: RepoProjectPatch) async throws -> RepoConfigProjectWrite {
        do {
            switch try await longRunning.putRepoConfigProject(.init(query: .init(remoteSlug: remoteSlug, instanceId: instanceID), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unprocessableContent(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, let payload):
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "putRepoConfigProject")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoConfigProject") }
    }
    public func putRepoConfigMachine(remoteSlug: String, instanceID: String, body: RepoMachinePatch) async throws -> RepoConfig {
        do {
            switch try await longRunning.putRepoConfigMachine(.init(query: .init(remoteSlug: remoteSlug, instanceId: instanceID), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, let payload):
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "putRepoConfigMachine")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoConfigMachine") }
    }
    public func getRepoConfigRoles(remoteSlug: String, instanceID: String) async throws -> RepoRolesResult {
        do {
            switch try await generated.getRepoConfigRoles(.init(query: .init(remoteSlug: remoteSlug, instanceId: instanceID))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, let payload):
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "getRepoConfigRoles")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoConfigRoles") }
    }
    public func putRepoConfigRoles(remoteSlug: String, instanceID: String, body: RepoRolesPatch) async throws -> RepoRolesResult {
        do {
            switch try await longRunning.putRepoConfigRoles(.init(query: .init(remoteSlug: remoteSlug, instanceId: instanceID), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, let payload):
                throw await ShepherdError.fromUndocumented(statusCode: status, payload: payload, route: "putRepoConfigRoles")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoConfigRoles") }
    }
}
