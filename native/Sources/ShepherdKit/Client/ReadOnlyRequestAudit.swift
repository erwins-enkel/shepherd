import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Opt-in live-test boundary. Records counts only, never URLs, bodies or credentials.
/// Authentication uses ProfileSetup's separate client; this guards the activated store.
public final class ReadOnlyRequestAudit: Sendable {
  private let state = NSLock()
  nonisolated(unsafe) private var reads = 0
  nonisolated(unsafe) private var rejected = 0

  public init() {}

  public var counts: (reads: Int, rejected: Int) {
    state.withLock { (reads, rejected) }
  }

  func record(method: HTTPRequest.Method, operationID: String) throws {
    // getBranchStatus is a GET with git-fetch side effects on the server.
    let allowed = method == .get && operationID != "getBranchStatus"
    state.withLock {
      if allowed { reads += 1 } else { rejected += 1 }
    }
    if !allowed { throw Refused.writeInReadOnlyLaunch }
  }

  private enum Refused: Error { case writeInReadOnlyLaunch }
}

struct ReadOnlyRequestMiddleware: ClientMiddleware {
  let audit: ReadOnlyRequestAudit
  func intercept(
    _ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    try audit.record(method: request.method, operationID: operationID)
    return try await next(request, body, baseURL)
  }
}
