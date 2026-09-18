import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Attaches `Authorization: Bearer <token>` from the `CredentialStore`, and
/// turns a 401 into a logout: the stored credential is cleared and
/// `onUnauthorized` fires so `ShepherdClient` can publish `needsLogin`.
///
/// The 401 is *not* converted into a thrown error here — the generated client
/// maps it to a documented `.unauthorized` output case, and `ShepherdClient`
/// turns that into `ShepherdError.unauthenticated`. Doing the mapping in one
/// place keeps the middleware free of per-operation knowledge.
public struct AuthenticationMiddleware: ClientMiddleware, Sendable {
  private let store: any CredentialStore
  private let credentialKey: String
  private let onUnauthorized: @Sendable () -> Void

  public init(
    store: any CredentialStore,
    credentialKey: String,
    onUnauthorized: @escaping @Sendable () -> Void
  ) {
    self.store = store
    self.credentialKey = credentialKey
    self.onUnauthorized = onUnauthorized
  }

  public func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var request = request
    if let credential = try? store.load(for: credentialKey) {
      request.headerFields[.authorization] = "Bearer \(credential.token)"
    }

    let (response, responseBody) = try await next(request, body, baseURL)

    if response.status == .unauthorized {
      ShepherdLog.client.notice(
        "401 on \(operationID, privacy: .public) — clearing the stored credential")
      try? store.delete(for: credentialKey)
      onUnauthorized()
    }
    return (response, responseBody)
  }
}
