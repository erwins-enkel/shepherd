import Foundation

public typealias Issue = Components.Schemas.Issue
public typealias IssueFetchAttempt = Components.Schemas.IssueFetchAttempt
public typealias IssueListing = Components.Schemas.IssueListing
public typealias SlashCommandScope = Components.Schemas.SlashCommandScope
public typealias SlashCommandKind = Components.Schemas.SlashCommandKind
public typealias SlashCommand = Components.Schemas.SlashCommand
public typealias CommandListing = Components.Schemas.CommandListing
public typealias EpicSummary = Components.Schemas.EpicSummary
public typealias EpicListing = Components.Schemas.EpicListing

extension Components.Schemas.SlashCommandScope: OpenEnum {}
extension Components.Schemas.SlashCommandKind: OpenEnum {}
extension Components.Schemas.IssueFetchAttempt.ReasonPayload: OpenEnum {}

extension ShepherdClient {
    /// A fetch failure is a successful listing with `error`, not a transport error.
    public func issues(repoPath: String) async throws -> IssueListing {
        do {
            switch try await generated.listIssues(.init(query: .init(repo: repoPath))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listIssues")
            }
        } catch { throw ShepherdError.from(error, route: "listIssues") }
    }

    public func commands(repoPath: String, provider: AgentProvider) async throws -> CommandListing {
        do {
            switch try await generated.listCommands(.init(query: .init(repo: repoPath, provider: provider))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listCommands")
            }
        } catch { throw ShepherdError.from(error, route: "listCommands") }
    }

    public func epics(repoPath: String) async throws -> EpicListing {
        do {
            switch try await generated.listEpics(.init(query: .init(repo: repoPath))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listEpics")
            }
        } catch { throw ShepherdError.from(error, route: "listEpics") }
    }
}
