import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Retries idempotent GETs with exponential backoff, per the design spec:
/// "Retries idempotent GETs three times with backoff."
///
/// Only bodyless GETs are eligible. `HTTPBody` is a single-pass stream, so
/// replaying a request that carries one would send an empty body the second
/// time — silently corrupting the call. GETs in this contract never have a
/// body, so the guard costs nothing and removes the whole class of bug.
///
/// Cancellation is never a retryable failure: a cancelled task is retried into
/// a busy loop that ignores the cancellation it was handed.
public struct RetryingMiddleware: ClientMiddleware, Sendable {
  private let maxAttempts: Int
  private let initialBackoff: Duration

  public init(maxAttempts: Int = 3, initialBackoff: Duration = .milliseconds(200)) {
    precondition(maxAttempts >= 1, "maxAttempts must be at least 1")
    self.maxAttempts = maxAttempts
    self.initialBackoff = initialBackoff
  }

  public func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    guard request.method == .get, body == nil else {
      return try await next(request, body, baseURL)
    }

    var backoff = initialBackoff
    var attempt = 1
    while true {
      // Cheaper and more honest than discovering the cancellation inside the
      // transport: never start an attempt for a task that is already gone.
      try Task.checkCancellation()

      let response: HTTPResponse
      let responseBody: HTTPBody?
      do {
        (response, responseBody) = try await next(request, body, baseURL)
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        if attempt >= maxAttempts { throw error }
        ShepherdLog.client.debug(
          "retrying \(operationID, privacy: .public) after a transport failure")
        try await Task.sleep(for: backoff)
        backoff *= 2
        attempt += 1
        continue
      }

      guard response.status.kind == .serverError, attempt < maxAttempts else {
        return (response, responseBody)
      }

      ShepherdLog.client.debug(
        "retrying \(operationID, privacy: .public) after \(response.status.code)")
      // The 5xx body is about to be dropped on the floor. Drain it first: an
      // unconsumed `HTTPBody` holds its connection until it is deinitialised,
      // so the retry would otherwise queue behind the response it is replacing.
      if let responseBody {
        do {
          for try await _ in responseBody {}
        } catch {
          ShepherdLog.client.debug("discarded 5xx body ended early")
        }
      }
      // Deliberately outside the `do` above: a cancellation raised while we
      // back off is a cancellation, not one more transport failure to retry.
      try await Task.sleep(for: backoff)
      backoff *= 2
      attempt += 1
    }
  }
}
