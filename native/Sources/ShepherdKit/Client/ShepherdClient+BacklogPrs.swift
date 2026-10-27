import Foundation

public typealias MergeResponsibility = Components.Schemas.MergeResponsibility
public typealias MergeConfirmation = Components.Schemas.MergeConfirmation

/// A 409 from `POST /api/prs/merge` that the operator can answer: the responsibility gate
/// (`merge_confirm_required` / `merge_confirm_stale`) with the values to show and echo back as
/// `MergeConfirmation`. Any other 409 (conflict, busy base, untested stack) stays a plain
/// `ShepherdError.conflict`.
public struct BacklogMergeRefusal: Error, Equatable, Sendable {
  public enum Code: String, Sendable { case required = "merge_confirm_required", stale = "merge_confirm_stale" }
  public let code: Code
  public let message: String
  public let gate: MergeResponsibility?
  public let headSha: String?
  public let baseRefName: String?

  public init(code: Code, message: String, gate: MergeResponsibility?, headSha: String?, baseRefName: String?) {
    self.code = code; self.message = message; self.gate = gate; self.headSha = headSha; self.baseRefName = baseRefName
  }

  init?(_ body: Components.Schemas.MergeConfirmRefusal) {
    guard let raw = body.code?.value2, let code = Code(rawValue: raw) else { return nil }
    self.init(code: code, message: body.error, gate: body.gate, headSha: body.headSha, baseRefName: body.baseRefName)
  }

  /// What a retry must echo: the responsibility the operator was shown.
  public var confirmation: MergeConfirmation {
    .init(headSha: headSha, baseRefName: baseRefName,
          handoff: gate?.handoff.flatMap { .init(rawValue: $0.rawValue) },
          handoffWho: gate?.handoffWho, reviewBlockBy: gate?.reviewBlockBy)
  }
}

extension ShepherdClient {
  /// `POST /api/prs/merge`: merge a backlog PR by repo + number, no session involved. `nil`
  /// method and deleteBranch take the forge defaults. Omit `confirm` for the operator's own
  /// PR; a refused or stale takeover throws `BacklogMergeRefusal` with the values to echo.
  public func mergeBacklogPr(
    repo: String, number: Int, method: MergeMethod? = nil, deleteBranch: Bool? = nil,
    confirm: MergeConfirmation? = nil
  ) async throws {
    do {
      switch try await generated.mergeBacklogPr(.init(body: .json(.init(
        repo: repo, number: number, method: method, deleteBranch: deleteBranch, confirm: confirm)))) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict):
        let body = try conflict.body.json
        if let refusal = BacklogMergeRefusal(body) { throw refusal }
        throw ShepherdError.conflict(code: body.code?.value2, message: body.error)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "mergeBacklogPr")
      }
    } catch let refusal as BacklogMergeRefusal {
      throw refusal
    } catch { throw ShepherdError.from(error, route: "mergeBacklogPr") }
  }

  /// `POST /api/prs/dependabot-rebase`: posts the opt-in `@dependabot rebase` comment on a stuck
  /// Dependabot PR. GitHub only (other forges answer 400).
  public func requestDependabotRebase(repo: String, number: Int) async throws {
    do {
      switch try await generated.requestDependabotRebase(.init(body: .json(.init(repo: repo, number: number)))) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "requestDependabotRebase")
      }
    } catch { throw ShepherdError.from(error, route: "requestDependabotRebase") }
  }

  /// `POST /api/up-next/pr-fix`: start the server's push-only repair session for a waiting PR whose
  /// action is `fix`. Refusals: `.notFound` (not fixable any more), `.conflict(code: "pr_in_flight")`
  /// (a session already holds it), `.unprocessable` (the head lives in a fork).
  public func startUpNextPrFix(repo: String, number: Int, steer: String? = nil) async throws -> Session {
    do {
      switch try await generated.startUpNextPrFix(.init(body: .json(.init(repo: repo, number: number, steer: steer)))) {
      case .created(let created): return try created.body.json.session
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .unprocessableContent(let bad): throw ShepherdError.unprocessable(try bad.body.json.error)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "startUpNextPrFix")
      }
    } catch { throw ShepherdError.from(error, route: "startUpNextPrFix") }
  }

  /// `GET /api/up-next/pr-body`: a waiting PR's full description, read on demand.
  public func upNextPrBody(repo: String, number: Int) async throws -> String {
    do {
      switch try await generated.getUpNextPrBody(.init(query: .init(repo: repo, number: number))) {
      case .ok(let ok): return try ok.body.json.body
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .serviceUnavailable(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getUpNextPrBody")
      }
    } catch { throw ShepherdError.from(error, route: "getUpNextPrBody") }
  }
}
