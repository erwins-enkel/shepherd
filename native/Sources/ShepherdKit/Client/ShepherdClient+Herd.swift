import Foundation

// Short names for the herd schemas, alongside Model/PublicTypes.swift. Typealiases, not wrappers:
// one definition of each type, still from the contract.
public typealias PrHandoff = Components.Schemas.PrHandoff
public typealias PrHandoffKnown = Components.Schemas.PrHandoffKnown
public typealias PrReviewBlock = Components.Schemas.PrReviewBlock
public typealias SessionActivitySignal = Components.Schemas.SessionActivitySignal
public typealias ReviewVerdict = Components.Schemas.ReviewVerdict
public typealias ReviewDecision = Components.Schemas.ReviewDecision
public typealias ReviewDecisionKnown = Components.Schemas.ReviewDecisionKnown
public typealias ReviewerEnv = Components.Schemas.ReviewerEnv
public typealias ReviewerProvider = Components.Schemas.ReviewerProvider
public typealias ReviewerProviderKnown = Components.Schemas.ReviewerProviderKnown
public typealias ReviewerInflightEntry = Components.Schemas.ReviewerInflightEntry
public typealias PrReviewTrigger = Components.Schemas.PrReviewTrigger
public typealias PrReviewTriggerKnown = Components.Schemas.PrReviewTriggerKnown
public typealias PrReviewResult = Components.Schemas.PrReviewResult

// The derivation gives each open enum an `anyOf` shape and a `<Name>Known` companion.
// Conformance supplies `known`, `rawValue`, `init(known:)` and `init(unknown:)` from OpenEnum.
// These generated schemas live in this module, so none is a retroactive conformance.
extension Components.Schemas.SessionClaudeAliveEvent.LivenessPayload: OpenEnum {}
extension Components.Schemas.ReviewDecision: OpenEnum {}
extension Components.Schemas.ReviewerProvider: OpenEnum {}
extension Components.Schemas.PrReviewTrigger: OpenEnum {}

/// The herd-wide snapshots the sidebar classifier runs on, plus the one write it offers.
///
/// Every read is a single request answering a whole snapshot. Calling `getSessionGit` per row
/// would issue one request per session on every bootstrap. None of these mutates `SessionStore`:
/// the server's own `/events` frames do that.
extension ShepherdClient {
  /// `GET /api/git`. Session id to PR state, for every session the poller has state for.
  /// An absent session has no cached PR state, which means no git-decided stage.
  public func gitStates() async throws -> [String: GitState] {
    do {
      switch try await generated.gitStates(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "gitStates")
      }
    } catch { throw ShepherdError.from(error, route: "gitStates") }
  }

  /// `GET /api/activity`. Session id to transcript heartbeat.
  public func activityStates() async throws -> [String: SessionActivitySignal] {
    do {
      switch try await generated.activityStates(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "activityStates")
      }
    } catch { throw ShepherdError.from(error, route: "activityStates") }
  }

  /// `GET /api/claude-alive`. Whether a coding-CLI process still lives in each session's worktree.
  public func claudeAliveStates() async throws -> [String: Bool] {
    do {
      switch try await generated.claudeAliveStates(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "claudeAliveStates")
      }
    } catch { throw ShepherdError.from(error, route: "claudeAliveStates") }
  }

  /// `GET /api/reviews`. Session id to the latest critic verdict.
  public func reviews() async throws -> [String: ReviewVerdict] {
    do {
      switch try await generated.listReviews(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "listReviews")
      }
    } catch { throw ShepherdError.from(error, route: "listReviews") }
  }

  /// `GET /api/reviews/inflight`. Current critic runs, including each reviewer's CLI environment.
  public func reviewsInflight() async throws -> [ReviewerInflightEntry] {
    do {
      switch try await generated.listReviewsInflight(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "listReviewsInflight")
      }
    } catch { throw ShepherdError.from(error, route: "listReviewsInflight") }
  }

  /// `POST /api/sessions/{id}/review-pr`. Requests a critic run and returns the server's decision.
  /// The response is 202: the asynchronous run arrives as `session:reviewing`, then `session:review`.
  /// A `.skipped` status is a normal answer when the verdict for this head is already current.
  /// Both 404 bodies (`not found`, `no forge for this repo`) map to `.notFound`.
  public func reviewPr(sessionID: String) async throws -> PrReviewResult {
    do {
      switch try await generated.reviewPr(.init(path: .init(id: sessionID))) {
      case .accepted(let accepted): return try accepted.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .badGateway(let bad):
        throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "reviewPr")
      }
    } catch { throw ShepherdError.from(error, route: "reviewPr") }
  }
}
