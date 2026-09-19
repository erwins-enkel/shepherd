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
  /// The request never produced a usable HTTP response. Carries the cause
  /// *and* the underlying error's description, so connection refused, a
  /// timeout and a TLS rejection stay distinguishable in a bug report.
  case transport(String)
  /// The task making the request was cancelled. Not a failure of the server,
  /// the network or the contract: the caller walked away. A long-running
  /// consumer treats it as a no-op — nothing to show the operator, nothing to
  /// retry — which is why it is its own case and not a `.transport`.
  case cancelled

  /// Maps a thrown error from the generated client. The generated client only
  /// throws for transport failures and body decoding failures — documented
  /// statuses come back as `Output` cases instead.
  ///
  /// The classification uses only public API: `ClientError.underlyingError`
  /// (the root cause the runtime already unwrapped for us), `operationID`,
  /// `causeDescription` and whether a `response` was ever received. The
  /// runtime's own error enum is `internal`, so it can never be named here;
  /// "we got as far as an HTTP response and still failed" is the reliable
  /// signal that the failure is about the contract rather than the network.
  public static func from(_ error: any Error, route: String) -> ShepherdError {
    if let shepherd = error as? ShepherdError { return shepherd }
    if let profile = error as? ServerProfileError { return .insecureProfile(profile) }
    if error is CancellationError { return .cancelled }
    if let urlError = error as? URLError, isCancellation(urlError) { return .cancelled }

    guard let clientError = error as? ClientError else {
      // A bare coding error — thrown by our own encoding of `PresenceFrame`,
      // or by a decode outside an operation — is still a contract failure.
      if error is DecodingError || error is EncodingError {
        return .contractMismatch(route: route, underlying: capped(String(describing: error)))
      }
      return .transport(capped(String(describing: error)))
    }

    // `operationID` is empty when the failure happened before the runtime knew
    // which operation it was serving; the caller's `route` is the better name.
    let operationRoute = clientError.operationID.isEmpty ? route : clientError.operationID
    let underlying = clientError.underlyingError

    // A middleware of ours threw: the runtime wraps it, then hands the root
    // cause straight back through `underlyingError`. Pass it through unchanged
    // rather than re-describing it as a transport failure.
    if let shepherd = underlying as? ShepherdError { return shepherd }
    if let profile = underlying as? ServerProfileError { return .insecureProfile(profile) }

    // Cancellation travels the same route as a transport failure — a
    // middleware's backoff sleep throws it, and the runtime wraps it — but it
    // means the caller walked away, not that the request could not be made.
    if underlying is CancellationError { return .cancelled }
    // `URLSession` reports a task it cancelled (e.g. a POST or DELETE whose
    // caller walked away) as `URLError(.cancelled)`, not `CancellationError` —
    // that error never travels through Swift's structured-concurrency
    // cancellation at all. Left unmapped, it would surface as `.transport`,
    // which reads as "the server could not be reached" rather than "nobody is
    // waiting for this anymore".
    if let urlError = underlying as? URLError, isCancellation(urlError) { return .cancelled }

    if underlying is DecodingError || underlying is EncodingError {
      return .contractMismatch(
        route: operationRoute, underlying: capped(String(describing: underlying)))
    }

    // The network layer's own vocabulary: URLSession and the BSD socket layer.
    // Neither of these ever means the server disagreed with the contract.
    if underlying is URLError || underlying is POSIXError {
      return .transport(capped("\(clientError.causeDescription): \(underlying)"))
    }

    // Anything else: a response means the exchange reached the server and the
    // runtime rejected what came back (undocumented content type, missing
    // required header, unparseable body) — a contract mismatch. No response
    // means the request never completed — a transport failure.
    return clientError.response == nil
      ? .transport(capped(clientError.causeDescription))
      : .contractMismatch(route: operationRoute, underlying: capped(clientError.causeDescription))
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

  /// Ceiling on any diagnostic string carried into a case payload. The
  /// runtime's descriptions interpolate whole generated `Output` values, so an
  /// unbounded copy could drag a full session list into a log line or an
  /// alert. The cap bounds that.
  ///
  /// It is *not* a redaction: nothing reachable here may carry a secret in the
  /// first place. The only token in play is the `Authorization` header the
  /// auth middleware adds after serialisation, and neither `causeDescription`
  /// nor `underlyingError` describes request headers. Never widen this to
  /// `ClientError.description`, which does print them.
  private static let diagnosticLimit = 500

  private static func capped(_ text: String) -> String {
    text.count <= diagnosticLimit ? text : String(text.prefix(diagnosticLimit)) + "…"
  }

  /// `URLError.Code.cancelled` and its raw value, `NSURLErrorCancelled`
  /// (-999), are the same code under two names — `URLSession` uses this one
  /// code both for a task the caller cancelled and for a redirect it declined
  /// to follow, but the caller-cancelled case is the only one this client's
  /// requests can hit. Checked by raw value as well as by the typed `.code`
  /// so a `URLError` built directly from the NSURLError domain constant (as a
  /// test, or an older API, might) still matches.
  private static func isCancellation(_ error: URLError) -> Bool {
    error.code == .cancelled || error.errorCode == NSURLErrorCancelled
  }
}
