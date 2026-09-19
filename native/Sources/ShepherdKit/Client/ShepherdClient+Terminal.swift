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
        // The generated client always sends application/json, so this is
        // unreachable in practice — map it rather than crash if it ever is not.
        throw ShepherdError.badRequest("Content-Type must be application/json")
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "replySession")
      }
    } catch { throw ShepherdError.from(error, route: "replySession") }
  }
}
