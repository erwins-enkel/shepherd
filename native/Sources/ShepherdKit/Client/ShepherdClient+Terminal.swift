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

  /// `POST /api/sessions` with the clean-terminal arm — `{repoPath, terminal: true}` and nothing
  /// else: a bare operator shell in the repo's main checkout. A second one for the same repo is a
  /// 409 (`ShepherdError.conflict`), which callers resolve by focusing the live terminal.
  ///
  /// Hand-built because the contract's `CreateSessionRequest` models only the standard arm (its
  /// `baseBranch` and `prompt` are required), so the generated client cannot spell this body. It
  /// carries the same bearer, and a 401 maps like the generated routes — but unlike them it does
  /// not clear the stored credential.
  public func createTerminalSession(repoPath: String) async throws -> Session {
    do {
      var request = URLRequest(url: profile.baseURL.appendingPathComponent("api/sessions"))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      if let token = currentToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
      request.httpBody = try JSONEncoder().encode(TerminalCreateBody(repoPath: repoPath))
      let (data, response) = try await longRunningURLSession.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw ShepherdError.fromUndocumented(statusCode: 0, route: "createTerminalSession")
      }
      switch http.statusCode {
      case 200, 201: return try JSONDecoder().decode(Session.self, from: data)
      case 401: throw ShepherdError.unauthenticated
      case 409: throw ShepherdError.fromConflict(try JSONDecoder().decode(Components.Schemas._Error.self, from: data))
      default: throw ShepherdError.fromUndocumented(statusCode: http.statusCode, route: "createTerminalSession")
      }
    } catch { throw ShepherdError.from(error, route: "createTerminalSession") }
  }
}

private struct TerminalCreateBody: Encodable {
  let repoPath: String
  let terminal = true
}
