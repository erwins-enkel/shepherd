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
///
/// The logout only fires for a request that actually carried a credential. An
/// anonymous request answered with 401 says nothing about the stored token —
/// deleting it there would log the user out of a working session because one
/// unauthenticated probe came back 401.
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
    var sentCredential = false
    do {
      if let credential = try store.load(for: credentialKey) {
        request.headerFields[.authorization] = "Bearer \(credential.token)"
        sentCredential = true
      }
    } catch {
      // A locked or unreadable Keychain is not "no token": we simply could not
      // find out. Say so, send the request unauthenticated, and leave the item
      // alone — a 401 that follows must not delete a credential we never read.
      // The error describes an OSStatus, never the item's contents.
      ShepherdLog.credentials.error(
        """
        could not read the credential for \(operationID, privacy: .public): \
        \(String(describing: error), privacy: .public) — sending unauthenticated
        """)
    }

    let (response, responseBody) = try await next(request, body, baseURL)

    if response.status == .unauthorized, sentCredential {
      ShepherdLog.client.notice(
        "401 on \(operationID, privacy: .public) — clearing the stored credential")
      do {
        try store.delete(for: credentialKey)
      } catch {
        ShepherdLog.credentials.error(
          "could not clear the credential: \(String(describing: error), privacy: .public)")
      }
      onUnauthorized()
    }
    return (response, responseBody)
  }
}
