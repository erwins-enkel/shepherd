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
  /// Dependabot PR. Hand-built like `createTerminalSession` because the route is not in the
  /// Swift contract yet; GitHub only (other forges answer 400).
  public func requestDependabotRebase(repo: String, number: Int) async throws {
    do {
      var request = URLRequest(url: profile.baseURL.appendingPathComponent("api/prs/dependabot-rebase"))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      if let token = currentToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
      request.httpBody = try JSONEncoder().encode(DependabotRebaseBody(repo: repo, number: number))
      let (data, response) = try await longRunningURLSession.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw ShepherdError.fromUndocumented(statusCode: 0, route: "requestDependabotRebase")
      }
      switch http.statusCode {
      case 200: return
      case 400: throw ShepherdError.badRequest(try JSONDecoder().decode(Components.Schemas._Error.self, from: data).error)
      case 401: throw ShepherdError.unauthenticated
      case 502: throw ShepherdError.fromUpstream(try JSONDecoder().decode(Components.Schemas._Error.self, from: data))
      default: throw ShepherdError.fromUndocumented(statusCode: http.statusCode, route: "requestDependabotRebase")
      }
    } catch { throw ShepherdError.from(error, route: "requestDependabotRebase") }
  }
}

private struct DependabotRebaseBody: Encodable {
  let repo: String
  let number: Int
}
