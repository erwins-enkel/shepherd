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
      do {
        let (response, responseBody) = try await next(request, body, baseURL)
        if response.status.kind == .serverError, attempt < maxAttempts {
          ShepherdLog.client.debug(
            "retrying \(operationID, privacy: .public) after \(response.status.code)")
          try await Task.sleep(for: backoff)
          backoff *= 2
          attempt += 1
          continue
        }
        return (response, responseBody)
      } catch {
        if attempt >= maxAttempts { throw error }
        ShepherdLog.client.debug(
          "retrying \(operationID, privacy: .public) after a transport failure")
        try await Task.sleep(for: backoff)
        backoff *= 2
        attempt += 1
      }
    }
  }
}
