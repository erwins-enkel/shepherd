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
/// The logout only fires for a request that actually carried a credential, and
/// only while the store still holds *that* credential. An anonymous request
/// answered with 401 says nothing about the stored token — deleting it there
/// would log the user out of a working session because one unauthenticated
/// probe came back 401 — and neither does a 401 for a token that has since
/// been replaced: a slow request signed with the old token can land long after
/// a fresh login stored a new one, and deleting then would throw away a
/// credential the server never rejected.
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
    var sentCredential: StoredCredential?
    do {
      if let credential = try store.load(for: credentialKey) {
        request.headerFields[.authorization] = "Bearer \(credential.token)"
        sentCredential = credential
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

    if response.status == .unauthorized, let sent = sentCredential {
      // Only clear what was actually rejected. Comparing the whole
      // `StoredCredential` — not just the token — also catches a re-mint that
      // happens to reuse a token string under a new id.
      let stored: StoredCredential?
      do {
        stored = try store.load(for: credentialKey)
      } catch {
        // A read that fails proves nothing about what is in there, and a
        // delete on that basis could destroy a credential the server never
        // rejected. Leave the item alone and say nothing.
        ShepherdLog.credentials.error(
          """
          401 on \(operationID, privacy: .public) but the credential could not be \
          re-read (\(String(describing: error), privacy: .public)) — leaving it alone
          """)
        return (response, responseBody)
      }
      guard stored == sent else {
        // A newer credential is in the store: this 401 is about the token this
        // request carried, which is already gone. Not a logout.
        ShepherdLog.client.notice(
          """
          401 on \(operationID, privacy: .public) for a credential that has since been \
          replaced — keeping the stored one
          """)
        return (response, responseBody)
      }
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
