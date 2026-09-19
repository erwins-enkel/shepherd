import Foundation
import OpenAPIRuntime

extension ShepherdClient {
  /// `POST /api/sessions/{id}/reply` — steer a running session with operator
  /// free text.
  ///
  /// 404 is a normal outcome, not a bug: the server answers it for an unknown
  /// id *and* for a session whose agent pane has since died, and a caller's
  /// session list is always a tick stale. Surface it as "the agent is no longer
  /// listening", never as a crash.
  ///
  /// Never log `text`: it is operator prose and may carry anything.
  public func replySession(id: String, text: String) async throws {
    do {
      switch try await generated.replySession(
        .init(path: .init(id: id), body: .json(.init(text: text)))
      ) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .unsupportedMediaType:
        // The generated client always sends `application/json`, so a 415 says
        // something between it and herdr disagrees about the contract — a proxy
        // rewriting the request, or a server that is not the one this build was
        // generated against. Never the operator's fault, so never `.badRequest`:
        // a view would offer to fix the prose, and there is nothing to fix.
        throw ShepherdError.contractMismatch(
          route: "replySession", underlying: "server rejected application/json")
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "replySession")
      }
    } catch { throw ShepherdError.from(error, route: "replySession") }
  }
}
