import Foundation
import OpenAPIRuntime

public typealias TaskBriefDraft = Components.Schemas.TaskBriefDraft
public typealias ShapeRequest = Components.Schemas.ShapeRequest
public typealias ShapeRound = Components.Schemas.ShapeRound
public typealias ShapeBriefRequest = Components.Schemas.ShapeBriefRequest

public enum ComposeShapeError: Error, Equatable, Sendable {
    case failed(String)
}

public enum ComposeUploadError: Error, Equatable, Sendable {
    case fileTooLarge(String)
}

public typealias BranchListing = Components.Schemas.BranchListing
public typealias BranchStatus = Components.Schemas.BranchStatus
public typealias InitEmptyCommitResponse = Components.Schemas.InitEmptyCommitResponse

public typealias Issue = Components.Schemas.Issue
public typealias IssueFetchAttempt = Components.Schemas.IssueFetchAttempt
public typealias IssueListing = Components.Schemas.IssueListing
public typealias SlashCommandScope = Components.Schemas.SlashCommandScope
public typealias SlashCommandKind = Components.Schemas.SlashCommandKind
public typealias SlashCommand = Components.Schemas.SlashCommand
public typealias CommandListing = Components.Schemas.CommandListing
public typealias EpicSummary = Components.Schemas.EpicSummary
public typealias EpicListing = Components.Schemas.EpicListing

extension Components.Schemas.IssueFetchTransport: OpenEnum {}

extension Components.Schemas.SlashCommandScope: OpenEnum {}
extension Components.Schemas.SlashCommandKind: OpenEnum {}
extension Components.Schemas.IssueFetchAttempt.ReasonPayload: OpenEnum {}

extension ShepherdClient {
    public func shapeTask(_ request: ShapeRequest) async throws -> ShapeRound {
        do {
            switch try await generated.shapeTask(.init(body: .json(request))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .unprocessableContent(let bad): throw ComposeShapeError.failed(try bad.body.json.error.rawValue)
            case .serviceUnavailable(let bad): throw ComposeShapeError.failed(try bad.body.json.error.rawValue)
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "shapeTask")
            }
        } catch let error as ComposeShapeError { throw error }
        catch { throw ShepherdError.from(error, route: "shapeTask") }
    }

    public func shapeBrief(_ request: ShapeBriefRequest) async throws -> String {
        do {
            switch try await generated.shapeBrief(.init(body: .json(request))) {
            case .ok(let ok): return try ok.body.json.brief
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "shapeBrief")
            }
        } catch { throw ShepherdError.from(error, route: "shapeBrief") }
    }

    /// Pre-session staging only: never attaches to, or creates, a live session.
    /// Reports file bytes consumed by the streaming transport, excluding multipart framing.
    /// Buffered bytes are not a server acknowledgement: callers must cap progress below 100%
    /// until this method returns successfully. Uses this client's usual auth and credential store.
    public func uploadFile(
        data: Data, filename: String,
        progress: @escaping @Sendable (Int) async -> Void = { _ in }
    ) async throws -> Components.Schemas.UploadResponse {
        do {
            let file = HTTPBody(ComposeUploadBytes(data: data, progress: progress),
                                length: .known(Int64(data.count)), iterationBehavior: .single)
            // RFC 7578 percent-encoding also prevents newlines becoming multipart headers.
            let filename = filename.replacingOccurrences(of: "%", with: "%25")
                .replacingOccurrences(of: "\r", with: "%0D").replacingOccurrences(of: "\n", with: "%0A")
                .replacingOccurrences(of: "\"", with: "%22")
            let body: MultipartBody<Operations.UploadFile.Input.Body.MultipartFormPayload> = [
                .file(.init(payload: .init(body: file), filename: filename))
            ]
            switch try await generated.uploadFile(.init(body: .multipartForm(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .contentTooLarge(let bad): throw ComposeUploadError.fileTooLarge(try bad.body.json.error)
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "uploadFile")
            }
        } catch let error as ComposeUploadError { throw error }
        catch { throw ShepherdError.from(error, route: "uploadFile") }
    }

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
    public func branches(repoPath: String) async throws -> BranchListing {
        do {
            switch try await generated.listBranches(.init(query: .init(repo: repoPath))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listBranches")
            }
        } catch { throw ShepherdError.from(error, route: "listBranches") }
    }

    public func branchStatus(repoPath: String, branch: String) async throws -> BranchStatus {
        do {
            switch try await generated.getBranchStatus(.init(query: .init(repo: repoPath, branch: branch))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getBranchStatus")
            }
        } catch { throw ShepherdError.from(error, route: "getBranchStatus") }
    }

    public func initEmptyCommit(repoPath: String, branch: String) async throws -> InitEmptyCommitResponse {
        do {
            switch try await generated.initEmptyCommit(.init(body: .json(.init(repo: repoPath, branch: branch)))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .unprocessableContent(let bad): throw ShepherdError.unprocessable(try bad.body.json.error)
            case .undocumented(let statusCode, _):
                throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "initEmptyCommit")
            }
        } catch { throw ShepherdError.from(error, route: "initEmptyCommit") }
    }

}

/// Pull-driven chunks keep progress paced by URLSessionTransport's streaming backpressure.
/// Report the previous chunk only when the consumer resumes, never while preparing the body.
struct ComposeUploadBytes: AsyncSequence, Sendable {
    typealias Element = ArraySlice<UInt8>
    let data: Data
    let progress: @Sendable (Int) async -> Void

    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(data: data, progress: progress) }

    struct AsyncIterator: AsyncIteratorProtocol {
        let data: Data
        let progress: @Sendable (Int) async -> Void
        private var offset = 0
        private var reported = 0

        init(data: Data, progress: @escaping @Sendable (Int) async -> Void) {
            self.data = data
            self.progress = progress
        }

        mutating func next() async throws -> Element? {
            try Task.checkCancellation()
            if offset > reported {
                await progress(offset)
                reported = offset
            }
            try Task.checkCancellation()
            guard offset < data.count else { return nil }
            let chunk = ArraySlice(data.dropFirst(offset).prefix(64 * 1024))
            offset += chunk.count
            return chunk
        }
    }
}
