import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
@testable import ShepherdKit

struct ReadOnlyRequestAuditTests {
  @Test func refusesWritesAndFetchingGETBeforeTransport() async throws {
    let audit = ReadOnlyRequestAudit()
    let middleware = ReadOnlyRequestMiddleware(audit: audit)
    for (method, operation) in [(HTTPRequest.Method.post, "createSession"), (.put, "putBuildQueue"),
                                (.delete, "archiveSession"), (.get, "getBranchStatus")] {
      do {
        _ = try await middleware.intercept(HTTPRequest(method: method), body: nil,
          baseURL: URL(string: "https://fixture.invalid")!, operationID: operation) { _, _, _ in
            Issue.record("a refused request reached transport")
            return (HTTPResponse(status: .ok), nil)
          }
        Issue.record("a refused request succeeded")
      } catch { }
    }
    _ = try await middleware.intercept(HTTPRequest(method: .get), body: nil,
      baseURL: URL(string: "https://fixture.invalid")!, operationID: "listIssues") { _, _, _ in
        (HTTPResponse(status: .ok), nil)
      }
    #expect(audit.counts.reads == 1)
    #expect(audit.counts.rejected == 4)
  }
}
