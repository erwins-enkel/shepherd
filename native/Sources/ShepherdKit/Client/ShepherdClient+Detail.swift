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

public typealias ActivityEntry = Components.Schemas.ActivityEntry
public typealias DiffResult = Components.Schemas.DiffResult
public typealias DiffFile = Components.Schemas.DiffFile
public typealias DiffNote = Components.Schemas.DiffNote
public typealias BrowseListing = Components.Schemas.BrowseListing
public typealias BrowseEntry = Components.Schemas.BrowseEntry
public typealias GitState = Components.Schemas.GitState
public typealias PrReview = Components.Schemas.PrReview
public typealias PrReviewerOptions = Components.Schemas.PrReviewerOptions
/// The request-side merge method (`merge` | `squash` | `rebase`). A closed enum: it never
/// appears in a server response, so a client never needs to tolerate a value it doesn't know.
public typealias MergeMethod = Components.Schemas.MergeMethod
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

  /// Candidate reviewers for the open PR. GitHub only; any other forge, or one that refuses the
  /// request, comes back as a `.badRequest`/`.conflict` carrying the server's machine code.
  public func reviewers(sessionID: String) async throws -> PrReviewerOptions {
    do {
      switch try await generated.getPullRequestReviewers(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.code)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict):
        let code = try conflict.body.json.code
        throw ShepherdError.conflict(code: code, message: try conflict.body.json.error ?? code)
      case .badGateway(let bad):
        throw ShepherdError.upstreamFailure(try bad.body.json.error ?? bad.body.json.code)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getPullRequestReviewers")
      }
    } catch { throw ShepherdError.from(error, route: "getPullRequestReviewers") }
  }
}

// MARK: - PR actions

extension ShepherdClient {
  /// Opens a PR for the session branch. `nil` for either field lets the server fall back to the
  /// session's name and prompt. The response carries no `kind` — see `GitState`.
  public func openPR(sessionID: String, title: String?, body: String?) async throws -> GitState {
    do {
      switch try await generated.openPullRequest(
        .init(path: .init(id: sessionID), body: .json(.init(title: title, body: body)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "openPullRequest")
      }
    } catch { throw ShepherdError.from(error, route: "openPullRequest") }
  }

  /// Merges the open PR. `nil` takes the forge's own defaults (its merge method, and deleting
  /// the branch). A 502 here often means the host only *enqueued* the merge — still not a
  /// success, and the server's sentence says which it was.
  public func mergePR(
    sessionID: String, method: MergeMethod?, deleteBranch: Bool?
  ) async throws -> GitState {
    do {
      switch try await generated.mergePullRequest(
        .init(
          path: .init(id: sessionID),
          body: .json(.init(method: method, deleteBranch: deleteBranch)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "mergePullRequest")
      }
    } catch { throw ShepherdError.from(error, route: "mergePullRequest") }
  }

  /// Marks the PR ready for review. Idempotent server-side. A forge with no `markReady` (e.g.
  /// `LocalForge`) answers 400.
  public func markPRReady(sessionID: String) async throws -> GitState {
    do {
      switch try await generated.setPullRequestReady(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "setPullRequestReady")
      }
    } catch { throw ShepherdError.from(error, route: "setPullRequestReady") }
  }

  /// Converts the PR back to a draft. Idempotent server-side. A forge with no `convertToDraft`
  /// (e.g. `LocalForge`) answers 400.
  public func markPRDraft(sessionID: String) async throws -> GitState {
    do {
      switch try await generated.setPullRequestDraft(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "setPullRequestDraft")
      }
    } catch { throw ShepherdError.from(error, route: "setPullRequestDraft") }
  }

  /// Closes the PR without merging. A forge with no `closePr` (e.g. `LocalForge`) answers 400.
  public func closePR(sessionID: String) async throws -> GitState {
    do {
      switch try await generated.closePullRequest(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "closePullRequest")
      }
    } catch { throw ShepherdError.from(error, route: "closePullRequest") }
  }

  /// Requests a human review on the open PR. GitHub only.
  ///
  /// - Returns: `true` when the server requested the review but its own follow-up status read
  ///   failed (`refreshPending`), so the caller should re-read `git(sessionID:)`. This route's
  ///   error bodies carry a machine code and often no prose, so the code stands in for both.
  /// - Throws: `.upstreamFailure` on 502, the sibling git routes' mapping — a forge outage, not
  ///   a contract mismatch.
  @discardableResult
  public func requestPRReview(
    sessionID: String, prNumber: Int, reviewer: String
  ) async throws -> Bool {
    do {
      switch try await generated.requestPullRequestReview(
        .init(path: .init(id: sessionID), body: .json(.init(prNumber: prNumber, reviewer: reviewer)))
      ) {
      case .ok(let ok): return try ok.body.json.refreshPending ?? false
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.code)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .forbidden: throw ShepherdError.forbidden
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict):
        let code = try conflict.body.json.code
        throw ShepherdError.conflict(code: code, message: try conflict.body.json.error ?? code)
      case .unprocessableContent(let unprocessable):
        throw ShepherdError.unprocessable(try unprocessable.body.json.code)
      // `reviewRequestError()` answers 502 `review_request_failed` for anything the forge threw
      // that is not a refusal or a bad login — a plain GitHub outage. Without this case it fell
      // through to `.undocumented` and read to the operator as a contract mismatch.
      case .badGateway(let bad):
        throw ShepherdError.upstreamFailure(try bad.body.json.error ?? bad.body.json.code)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "requestPullRequestReview")
      }
    } catch { throw ShepherdError.from(error, route: "requestPullRequestReview") }
  }
}
