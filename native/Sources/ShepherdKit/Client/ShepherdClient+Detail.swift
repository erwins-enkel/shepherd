import Foundation

// The ten open-enum schemas the `# ── stream: detail ──` contract block flags with
// `x-shepherd-open-enum: true`. Each generates as an `anyOf: [{$ref: <Name>Known}, {type:
// string}]` wrapper struct — the same shape `Model/OpenEnum.swift` documents for the core
// schemas — so conforming them to `OpenEnum` here is what unlocks `.known` / `.rawValue`
// wherever this stream's views and tests read a detail route's status fields. `MergeMethod`
// (the one request-side enum in this block) stays closed and is not listed: it never appears in
// a server response, so a client never needs to tolerate a value it doesn't know.
extension Components.Schemas.ActivityStatus: OpenEnum {}
extension Components.Schemas.DiffFileStatus: OpenEnum {}
extension Components.Schemas.DiffNoteKind: OpenEnum {}
extension Components.Schemas.DiffNoteSide: OpenEnum {}
extension Components.Schemas.BrowseEntryType: OpenEnum {}
extension Components.Schemas.ForgeKind: OpenEnum {}
extension Components.Schemas.PrState: OpenEnum {}
extension Components.Schemas.ChecksState: OpenEnum {}
extension Components.Schemas.MergeStateStatus: OpenEnum {}
extension Components.Schemas.PrReviewState: OpenEnum {}

// MARK: - Short names for the generated detail schemas
//
// `PrReviewerOptions` and `MergeMethod` are deliberately not aliased here: they belong to
// `reviewers()` and the PR-action writes, which a later task adds together with the still-missing
// 502 on `GET /git/reviewers` (see this task's report). Adding the alias now, unused, would just
// invite a redeclaration clash when that task lands its own copy.

public typealias ActivityEntry = Components.Schemas.ActivityEntry
public typealias DiffResult = Components.Schemas.DiffResult
public typealias DiffFile = Components.Schemas.DiffFile
public typealias DiffNote = Components.Schemas.DiffNote
public typealias BrowseListing = Components.Schemas.BrowseListing
public typealias BrowseEntry = Components.Schemas.BrowseEntry
public typealias GitState = Components.Schemas.GitState
public typealias PrReview = Components.Schemas.PrReview
// Decoded from `ServerEvent.unknown(name:payload:)`'s `payload` in `DetailModel.subscribe(_:)` —
// `session:activity`/`session:git` are declared under this stream's own `x-shepherd-events` block
// but never added to `EventName`, so the app decodes them itself through these two.
public typealias SessionActivityEvent = Components.Schemas.SessionActivityEvent
public typealias SessionGitEvent = Components.Schemas.SessionGitEvent

// The closed enum each detail open enum splits off (see OpenEnum.swift for the mechanism).
public typealias ActivityStatusKnown = Components.Schemas.ActivityStatusKnown
public typealias DiffFileStatusKnown = Components.Schemas.DiffFileStatusKnown
public typealias PrStateKnown = Components.Schemas.PrStateKnown
public typealias ChecksStateKnown = Components.Schemas.ChecksStateKnown
public typealias MergeStateStatusKnown = Components.Schemas.MergeStateStatusKnown
public typealias ForgeKindKnown = Components.Schemas.ForgeKindKnown

// MARK: - Reads

extension ShepherdClient {
  /// Recent tool use from the agent transcript, oldest first. An unreadable transcript is an
  /// empty list server-side, never an error.
  public func activity(sessionID: String) async throws -> [ActivityEntry] {
    do {
      switch try await generated.getSessionActivity(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionActivity")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionActivity") }
  }

  /// The session branch against its base. `files[].patch` carries the raw unified patch; this
  /// route sends no parsed hunks.
  public func diff(sessionID: String) async throws -> DiffResult {
    do {
      switch try await generated.getSessionDiff(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .internalServerError(let bad):
        throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionDiff")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionDiff") }
  }

  /// Agent and review notes on the diff. Best effort server-side, so a caller may ignore a
  /// failure here and still show the diff.
  public func diffAnnotations(sessionID: String) async throws -> [DiffNote] {
    do {
      switch try await generated.getSessionDiffAnnotations(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json.notes
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionDiffAnnotations")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionDiffAnnotations") }
  }

  /// One directory of the session scratchpad; `nil` lists the root.
  public func scratchpad(sessionID: String, path: String? = nil) async throws -> BrowseListing {
    do {
      switch try await generated.getSessionScratchpad(
        .init(path: .init(id: sessionID), query: .init(path: path))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionScratchpad")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionScratchpad") }
  }

  /// One directory of the session worktree, read-only; `nil` lists the root.
  public func worktreeFiles(sessionID: String, path: String? = nil) async throws -> BrowseListing {
    do {
      switch try await generated.getSessionWorktree(
        .init(path: .init(id: sessionID), query: .init(path: path))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionWorktree")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionWorktree") }
  }

  /// PR and forge state, or `nil` when the server has none to give.
  ///
  /// 404 is deliberately not an error: the route answers it both for an unknown session and for
  /// a repo with no forge, and the panel renders nothing either way — the mapping `gitState()`
  /// makes in the web client.
  public func git(sessionID: String) async throws -> GitState? {
    do {
      switch try await generated.getSessionGit(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: return nil
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionGit")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionGit") }
  }

  // `reviewers()` is deliberately not here yet: the contract's `GET /git/reviewers` is missing
  // its reachable 502 (`reviewRequestError` funnels a thrown forge into an undeclared 502 —
  // Task 1's report flagged this). A fixer is adding that status now; Task 4 adds `reviewers()`
  // together with the PR-action writes once it lands, per the orchestrator's note on this task.
}
