import Foundation

/// A minted access token plus the id needed to revoke it. Stored as one
/// Keychain item so logout can revoke server-side before clearing locally.
public struct StoredCredential: Codable, Hashable, Sendable {
  /// The `shp_…` plaintext. Never logged, never written outside the store.
  public let token: String
  /// `AccessTokenSummary.id`, for `DELETE /api/access-tokens/{id}`.
  public let tokenId: String

  public init(token: String, tokenId: String) {
    self.token = token
    self.tokenId = tokenId
  }
}

/// Where a profile's access token lives. Synchronous and `Sendable` so the
/// auth middleware can read it from whatever executor the transport uses —
/// `ClientMiddleware.intercept` has no cheap place to await an actor hop.
public protocol CredentialStore: Sendable {
  /// Returns the credential for `key`, or `nil` when there is none.
  func load(for key: String) throws -> StoredCredential?
  /// Stores `credential` under `key`, replacing any previous value.
  func save(_ credential: StoredCredential, for key: String) throws
  /// Removes the credential for `key`. A missing key is not an error.
  func delete(for key: String) throws
}
