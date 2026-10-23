import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Generated header parameters are URI-encoded. HTTP validators must keep their
/// quotes, weak prefix and separators on the wire (swift-openapi-generator#529).
struct UpNextConditionalHeaderMiddleware: ClientMiddleware, Sendable {
  func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var request = request
    if operationID == "peekUpNext", let validator = request.headerFields[.ifNoneMatch] {
      request.headerFields[.ifNoneMatch] = validator.removingPercentEncoding
    }
    return try await next(request, body, baseURL)
  }
}
