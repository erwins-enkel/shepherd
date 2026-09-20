import Foundation

// Short names for the plan schemas. The contract remains the only payload type source.
public typealias PlanDecision = Components.Schemas.PlanDecision
public typealias PlanDecisionKnown = Components.Schemas.PlanDecisionKnown
public typealias PlanSummaryCode = Components.Schemas.PlanSummaryCode
public typealias PlanSummaryCodeKnown = Components.Schemas.PlanSummaryCodeKnown
public typealias CalloutTone = Components.Schemas.CalloutTone
public typealias CalloutToneKnown = Components.Schemas.CalloutToneKnown
public typealias FileTreeChange = Components.Schemas.FileTreeChange
public typealias FileTreeChangeKnown = Components.Schemas.FileTreeChangeKnown
public typealias FileTreeEntry = Components.Schemas.FileTreeEntry
public typealias DiffAnnotation = Components.Schemas.DiffAnnotation
public typealias QuestionKind = Components.Schemas.QuestionKind
public typealias QuestionKindKnown = Components.Schemas.QuestionKindKnown
public typealias PlanQuestion = Components.Schemas.PlanQuestion
public typealias VisualBlockRichText = Components.Schemas.VisualBlockRichText
public typealias VisualBlockCallout = Components.Schemas.VisualBlockCallout
public typealias VisualBlockFileTree = Components.Schemas.VisualBlockFileTree
public typealias VisualBlockDiff = Components.Schemas.VisualBlockDiff
public typealias VisualBlockCode = Components.Schemas.VisualBlockCode
public typealias VisualBlockAnnotatedCode = Components.Schemas.VisualBlockAnnotatedCode
public typealias VisualBlockTable = Components.Schemas.VisualBlockTable
public typealias VisualBlockChecklist = Components.Schemas.VisualBlockChecklist
public typealias VisualBlockMermaid = Components.Schemas.VisualBlockMermaid
public typealias VisualBlockWireframe = Components.Schemas.VisualBlockWireframe
public typealias VisualBlockApiEndpoint = Components.Schemas.VisualBlockApiEndpoint
public typealias VisualBlockDataModel = Components.Schemas.VisualBlockDataModel
public typealias VisualBlockQuestionForm = Components.Schemas.VisualBlockQuestionForm
public typealias VisualBlockUnknown = Components.Schemas.VisualBlockUnknown
public typealias VisualBlock = Components.Schemas.VisualBlock
public typealias PlanGate = Components.Schemas.PlanGate
public typealias PlanGateMap = Components.Schemas.PlanGateMap
public typealias PlanGateInflightEntry = Components.Schemas.PlanGateInflightEntry
public typealias PlanGateInflightList = Components.Schemas.PlanGateInflightList
public typealias PlanReviewTrigger = Components.Schemas.PlanReviewTrigger
public typealias PlanReviewTriggerKnown = Components.Schemas.PlanReviewTriggerKnown
public typealias PlanReviewResult = Components.Schemas.PlanReviewResult
public typealias PlanQuotaStatus = Components.Schemas.PlanQuotaStatus
public typealias PlanQuotaStatusKnown = Components.Schemas.PlanQuotaStatusKnown
public typealias PlanQuotaResult = Components.Schemas.PlanQuotaResult
public typealias RawAnswer = Components.Schemas.RawAnswer
public typealias AnswerPlanQuestionsRequest = Components.Schemas.AnswerPlanQuestionsRequest
public typealias AnswerPlanQuestionsResult = Components.Schemas.AnswerPlanQuestionsResult
public typealias SessionPlanGateEvent = Components.Schemas.SessionPlanGateEvent
public typealias SessionPlanGateReviewingEvent = Components.Schemas.SessionPlanGateReviewingEvent
public typealias SessionPlanGateActivityEvent = Components.Schemas.SessionPlanGateActivityEvent

extension Components.Schemas.WireframeSurface: OpenEnum {}
extension Components.Schemas.PlanGatePhase: OpenEnum {}
extension Components.Schemas.PlanDecision: OpenEnum {}
extension Components.Schemas.PlanSummaryCode: OpenEnum {}
extension Components.Schemas.CalloutTone: OpenEnum {}
extension Components.Schemas.FileTreeChange: OpenEnum {}
extension Components.Schemas.QuestionKind: OpenEnum {}
extension Components.Schemas.PlanReviewTrigger: OpenEnum {}
extension Components.Schemas.PlanQuotaStatus: OpenEnum {}

extension ShepherdClient {
  /// `GET /api/plan-gates` — the bootstrap snapshot, keyed by session id.
  public func planGates() async throws -> [String: PlanGate] {
    do {
      switch try await generated.listPlanGates(.init()) {
      case .ok(let ok):
        let gates = try ok.body.json.additionalProperties
        for gate in gates.values { try gate.validateVisualBlocks() }
        return gates
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "listPlanGates")
      }
    } catch { throw ShepherdError.from(error, route: "listPlanGates") }
  }

  /// `GET /api/plan-gates/inflight` — active reviews with their reviewer environment.
  public func planGatesInflight() async throws -> [PlanGateInflightEntry] {
    do {
      switch try await generated.listPlanGatesInflight(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "listPlanGatesInflight")
      }
    } catch { throw ShepherdError.from(error, route: "listPlanGatesInflight") }
  }

  /// `POST /api/sessions/{id}/go`. Reports whether execution actually started.
  /// A refusal is an ordinary false outcome, including when the session id is unknown.
  public func releasePlanGate(sessionID: String) async throws -> Bool {
    do {
      switch try await generated.releasePlanGate(.init(path: .init(id: sessionID))) {
      case .ok: return true
      case .conflict: return false
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "releasePlanGate")
      }
    } catch { throw ShepherdError.from(error, route: "releasePlanGate") }
  }

  /// `POST /api/sessions/{id}/answer-plan-questions`.
  /// `delivered == false` still means the answers were recorded; the agent may have moved on.
  public func answerPlanQuestions(
    sessionID: String, answers: [RawAnswer]
  ) async throws -> AnswerPlanQuestionsResult {
    do {
      switch try await generated.answerPlanQuestions(
        .init(path: .init(id: sessionID), body: .json(.init(answers: answers)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "answerPlanQuestions")
      }
    } catch { throw ShepherdError.from(error, route: "answerPlanQuestions") }
  }

  /// `POST /api/sessions/{id}/review-plan`. Accepted; the review finishes asynchronously.
  public func reviewPlan(sessionID: String) async throws -> PlanReviewResult {
    do {
      switch try await generated.reviewPlan(.init(path: .init(id: sessionID))) {
      case .accepted(let accepted): return try accepted.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "reviewPlan")
      }
    } catch { throw ShepherdError.from(error, route: "reviewPlan") }
  }

  /// `POST /api/sessions/{id}/quota/resume`. Resets the budget and re-delivers findings.
  public func resumePlanQuota(sessionID: String) async throws -> PlanQuotaResult {
    do {
      switch try await generated.resumePlanQuota(.init(path: .init(id: sessionID))) {
      case .accepted(let accepted): return try accepted.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "resumePlanQuota")
      }
    } catch { throw ShepherdError.from(error, route: "resumePlanQuota") }
  }

  /// `POST /api/sessions/{id}/quota/dismiss`. Resets the budget for an operator takeover.
  public func dismissPlanQuota(sessionID: String) async throws -> PlanQuotaResult {
    do {
      switch try await generated.dismissPlanQuota(.init(path: .init(id: sessionID))) {
      case .accepted(let accepted): return try accepted.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "dismissPlanQuota")
      }
    } catch { throw ShepherdError.from(error, route: "dismissPlanQuota") }
  }
}

extension Components.Schemas.PlanGate {
  /// Validate after decoding HTTP snapshots AND event payloads. The generated anyOf decoder
  /// ignores VisualBlockUnknown's exclusion pattern, so a malformed known block otherwise
  /// slips into value14. Keep the truth contract strict and check the typed member here.
  public func validateVisualBlocks() throws {
    for block in blocks ?? [] { try block.validateKnownType() }
  }
}

extension Components.Schemas.VisualBlock {
  public func validateKnownType() throws {
    guard let fallback = value14 else { return }
    let valid: Bool
    switch fallback._type {
    case "rich-text": valid = value1 != nil
    case "callout": valid = value2 != nil
    case "file-tree": valid = value3 != nil
    case "diff": valid = value4 != nil
    case "code": valid = value5 != nil
    case "annotated-code": valid = value6 != nil
    case "data-model": valid = value7 != nil
    case "api-endpoint": valid = value8 != nil
    case "table": valid = value9 != nil
    case "checklist": valid = value10 != nil
    case "mermaid": valid = value11 != nil
    case "wireframe": valid = value12 != nil
    case "question-form": valid = value13 != nil
    default: return // A genuinely new type remains forward-compatible.
    }
    guard valid else {
      throw DecodingError.dataCorrupted(
        .init(codingPath: [], debugDescription: "Invalid known visual block: \(fallback._type)"))
    }
  }
}
