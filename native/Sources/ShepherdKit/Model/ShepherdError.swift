import Foundation
import OpenAPIRuntime

/// Every failure `ShepherdClient` can surface. Deliberately `Equatable` with
/// `String` payloads rather than wrapped `Error`s so tests can assert on an
/// exact value instead of a type check.
public enum ShepherdError: Error, Equatable, Sendable {
  /// 401. The middleware has already cleared the stored token and fired
  /// `needsLogin`; the caller should show the login sheet.
  case unauthenticated
  /// 403. The caller used a bearer token where an operator session is needed.
  case forbidden
  /// 409 with `{"error":"first_run_pending"}`. The workspace root must be
  /// picked before anything else works.
  case firstRunPending
  /// 404.
  case notFound
  /// 400, with the server's `error` text.
  case badRequest(String)
  /// 409 other than first run: name taken, worktree occupied, herdr restart.
  case conflict(code: String?, message: String)
  /// 422 — the base branch does not resolve to a ref.
  case unprocessable(String)
  /// 502 — git or the agent runner failed downstream.
  case upstreamFailure(String)
  /// The server answered with something the contract does not describe, or a
  /// body that would not decode. `route` is the operation id.
  case contractMismatch(route: String, underlying: String)
  /// The profile violates the remote-URL policy.
  case insecureProfile(ServerProfileError)
  /// The request never produced an HTTP response.
  case transport(String)

  /// Maps a thrown error from the generated client. The generated client only
  /// throws for transport failures and body decoding failures — documented
  /// statuses come back as `Output` cases instead.
  public static func from(_ error: any Error, route: String) -> ShepherdError {
    if let shepherd = error as? ShepherdError { return shepherd }
    if let profile = error as? ServerProfileError { return .insecureProfile(profile) }
    guard let clientError = error as? ClientError else {
      return .transport(String(describing: error))
    }
    let underlying = clientError.underlyingError
    if underlying is DecodingError {
      return .contractMismatch(
        route: clientError.operationID, underlying: String(describing: underlying))
    }
    // The runtime's own error type — thrown when a response's shape does not
    // match the contract (an undocumented content type, a missing required
    // header) — is `internal` to OpenAPIRuntime 1.12.1, so it cannot be named
    // in a cast. Matching the module-qualified type name is the only way to
    // tell it apart from a genuine transport failure.
    if String(reflecting: type(of: underlying)).hasPrefix("OpenAPIRuntime.") {
      return .contractMismatch(
        route: clientError.operationID, underlying: String(describing: underlying))
    }
    return .transport(clientError.causeDescription)
  }

  /// Maps the generated `.undocumented(statusCode:_)` case. A 401 there means
  /// a route the contract did not mark as returning 401 answered with one —
  /// still an auth failure, not a contract bug.
  public static func fromUndocumented(statusCode: Int, route: String) -> ShepherdError {
    switch statusCode {
    case 401: return .unauthenticated
    case 403: return .forbidden
    default:
      return .contractMismatch(route: route, underlying: "undocumented status \(statusCode)")
    }
  }

  /// Maps a documented 409 body onto `.firstRunPending` or `.conflict`.
  public static func fromConflict(_ body: Components.Schemas._Error) -> ShepherdError {
    body.error == "first_run_pending"
      ? .firstRunPending
      : .conflict(code: body.code, message: body.error)
  }
}
