import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import ShepherdKit

/// Pins `ShepherdError.from(_:route:)`'s classification. The runtime's own
/// error enum is `internal`, so these build `ClientError` values by hand the
/// way `UniversalClient.makeError` does: a cause description plus the root
/// cause it already unwrapped, and a `response` when the exchange got that far.
@Suite("ShepherdError", .timeLimit(.minutes(1)))
struct ShepherdErrorTests {
  private func clientError(
    operationID: String = "listSessions",
    response: HTTPResponse? = nil,
    causeDescription: String,
    underlyingError: any Error
  ) -> ClientError {
    ClientError(
      operationID: operationID,
      operationInput: "input",
      response: response,
      causeDescription: causeDescription,
      underlyingError: underlyingError
    )
  }

  @Test("a wrapped decoding failure is a contract mismatch")
  func decodingIsContractMismatch() {
    let decoding = DecodingError.dataCorrupted(
      .init(codingPath: [], debugDescription: "not json"))
    let error = clientError(
      response: HTTPResponse(status: .ok),
      causeDescription: "Response body could not be decoded.",
      underlyingError: decoding)

    guard case .contractMismatch(let route, let underlying) = ShepherdError.from(
      error, route: "fallback")
    else {
      Issue.record("expected a contract mismatch")
      return
    }
    #expect(route == "listSessions")
    #expect(underlying.contains("not json"))
  }

  @Test("an empty operation id falls back to the caller's route")
  func emptyOperationIDUsesRoute() {
    let decoding = DecodingError.dataCorrupted(
      .init(codingPath: [], debugDescription: "not json"))
    let error = clientError(
      operationID: "",
      causeDescription: "Response body could not be decoded.",
      underlyingError: decoding)

    guard case .contractMismatch(let route, _) = ShepherdError.from(error, route: "fallback") else {
      Issue.record("expected a contract mismatch")
      return
    }
    #expect(route == "fallback")
  }

  @Test("a URLError becomes a transport failure that names the cause")
  func urlErrorIsTransport() {
    let urlError = URLError(.cannotConnectToHost)
    let error = clientError(
      causeDescription: "Transport threw an error.", underlyingError: urlError)

    guard case .transport(let text) = ShepherdError.from(error, route: "listSessions") else {
      Issue.record("expected a transport failure")
      return
    }
    #expect(text.contains("Transport threw an error."))
    // The point of carrying the underlying error: "cannot connect to host"
    // stays distinguishable from a timeout or a TLS rejection.
    #expect(text.contains("NSURLErrorDomain"))
    #expect(text.contains("\(urlError.errorCode)"))
  }

  @Test("a cancelled URLError is .cancelled, not .transport")
  func cancelledURLErrorIsCancelled() {
    // A cancelled POST or DELETE — the caller walked away — surfaces from
    // `URLSession` as `URLError(.cancelled)`, never `CancellationError`. Left
    // unmapped this reads as "the server could not be reached" instead of
    // "nobody is waiting for this anymore".
    let error = clientError(
      causeDescription: "Transport threw an error.",
      underlyingError: URLError(.cancelled))

    #expect(ShepherdError.from(error, route: "createSession") == .cancelled)
    // Bare, unwrapped by a `ClientError` — the shape `EventStream`'s own
    // `URLSession` calls would produce.
    #expect(ShepherdError.from(URLError(.cancelled), route: "createSession") == .cancelled)
  }

  @Test("a POSIX error becomes a transport failure")
  func posixErrorIsTransport() {
    let error = clientError(
      causeDescription: "Transport threw an error.",
      underlyingError: POSIXError(.ECONNREFUSED))

    guard case .transport(let text) = ShepherdError.from(error, route: "listSessions") else {
      Issue.record("expected a transport failure")
      return
    }
    #expect(text.contains("Transport threw an error."))
  }

  @Test("cancellation is its own case, bare or wrapped by the runtime")
  func cancellationIsItsOwnCase() {
    // A middleware's backoff sleep throws this and the runtime wraps it, so it
    // arrives looking exactly like a transport failure — but it means the
    // caller walked away, which a long-running consumer must not paint as
    // "the server could not be reached".
    let wrapped = clientError(
      causeDescription: "Middleware of type 'RetryingMiddleware' threw an error.",
      underlyingError: CancellationError())

    #expect(ShepherdError.from(wrapped, route: "listSessions") == .cancelled)
    #expect(ShepherdError.from(CancellationError(), route: "listSessions") == .cancelled)
  }

  @Test("an opaque failure with a response attached is a contract mismatch")
  func opaqueFailureWithResponseIsContractMismatch() {
    struct Opaque: Error {}
    let error = clientError(
      operationID: "getSession",
      response: HTTPResponse(status: .ok),
      causeDescription: "Unexpected response, expected status code: 200",
      underlyingError: Opaque())

    #expect(
      ShepherdError.from(error, route: "fallback")
        == .contractMismatch(
          route: "getSession", underlying: "Unexpected response, expected status code: 200"))
  }

  @Test("an opaque failure with no response is a transport failure")
  func opaqueFailureWithoutResponseIsTransport() {
    struct Opaque: Error {}
    let error = clientError(
      causeDescription: "Transport threw an error.", underlyingError: Opaque())

    #expect(ShepherdError.from(error, route: "fallback") == .transport("Transport threw an error."))
  }

  @Test("a ShepherdError thrown by a middleware passes through")
  func shepherdErrorPassesThrough() {
    let error = clientError(
      causeDescription: "Middleware of type 'X' threw an error.",
      underlyingError: ShepherdError.unauthenticated)

    #expect(ShepherdError.from(error, route: "fallback") == .unauthenticated)
    #expect(ShepherdError.from(ShepherdError.notFound, route: "fallback") == .notFound)
  }

  @Test("a ServerProfileError thrown by a middleware becomes insecureProfile")
  func serverProfileErrorBecomesInsecureProfile() {
    let profileError = ServerProfileError.insecureRemoteURL("example.com")
    let error = clientError(
      causeDescription: "Middleware of type 'X' threw an error.",
      underlyingError: profileError)

    #expect(ShepherdError.from(error, route: "fallback") == .insecureProfile(profileError))
    #expect(ShepherdError.from(profileError, route: "fallback") == .insecureProfile(profileError))
  }

  @Test("a bare decoding error is a contract mismatch on the given route")
  func bareDecodingErrorUsesRoute() {
    let decoding = DecodingError.keyNotFound(
      StringKey("id"),
      .init(codingPath: [], debugDescription: "no id"))

    guard case .contractMismatch(let route, let underlying) = ShepherdError.from(
      decoding, route: "listSessions")
    else {
      Issue.record("expected a contract mismatch")
      return
    }
    #expect(route == "listSessions")
    #expect(underlying.contains("no id"))
  }

  @Test("a bare non-coding error is a transport failure")
  func bareOtherErrorIsTransport() {
    struct Opaque: Error {}
    guard case .transport = ShepherdError.from(Opaque(), route: "listSessions") else {
      Issue.record("expected a transport failure")
      return
    }
  }

  @Test("diagnostics are capped so a whole Output never lands in a log line")
  func diagnosticsAreCapped() {
    struct Opaque: Error {}
    let error = clientError(
      response: HTTPResponse(status: .ok),
      causeDescription: String(repeating: "x", count: 4_000),
      underlyingError: Opaque())

    guard case .contractMismatch(_, let underlying) = ShepherdError.from(error, route: "r") else {
      Issue.record("expected a contract mismatch")
      return
    }
    #expect(underlying.count == 501)
    #expect(underlying.hasSuffix("…"))
  }
}

/// A `CodingKey` for building a `DecodingError.keyNotFound` by hand.
private struct StringKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }
  init(_ stringValue: String) { self.stringValue = stringValue }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { nil }
}
