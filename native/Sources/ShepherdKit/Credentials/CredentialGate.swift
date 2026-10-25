import Foundation
import Synchronization

/// Withholds a profile's stored token until the server at its endpoint has
/// proved it is the one the app expects — for a `.local` profile, the
/// supervised child (or the acknowledged external install) and not whatever
/// else happens to listen on `127.0.0.1:<port>`.
///
/// Every token reader goes through the `CredentialStore`: the
/// `AuthenticationMiddleware` on each request, and `ShepherdClient.currentToken()`
/// for `EventStream` on every connect and reconnect, the PTY and the terminal.
/// Wrapping that store in a `GatedCredentialStore` is therefore the one choke
/// point. A closed gate sends requests anonymously; the middleware only clears
/// a credential on a 401 for a request that carried one, so it is no logout.
///
/// Starts closed. The open state is bound to the verified profile's
/// `credentialKey`, and each `refresh` or `close` starts a new epoch, so a
/// verification still in flight from an older refresh can never reopen it.
public final class CredentialGate: Sendable {
  private struct State {
    var epoch = 0
    var openKey: String?
  }

  private let state = Mutex(State())
  private let verify: @Sendable (ServerProfile) async -> Bool

  public init(verify: @escaping @Sendable (ServerProfile) async -> Bool) {
    self.verify = verify
  }

  /// True while some profile's verification stands.
  public var isOpen: Bool { state.withLock { $0.openKey != nil } }

  /// True while the verification stands for this credential key.
  public func isVerified(for key: String) -> Bool { state.withLock { $0.openKey == key } }

  /// Closes the gate, then verifies `profile` and opens it for that profile
  /// on success. Returns `false` when verification fails or a newer
  /// `refresh`/`close` superseded this one.
  @discardableResult
  public func refresh(for profile: ServerProfile) async -> Bool {
    let epoch = state.withLock { current -> Int in
      current.epoch &+= 1
      current.openKey = nil
      return current.epoch
    }
    let verified = await verify(profile)
    return state.withLock { current -> Bool in
      guard current.epoch == epoch else { return false }
      current.openKey = verified ? profile.credentialKey : nil
      return verified
    }
  }

  /// Verifies `profile` without touching the gate's state — for a one-off
  /// send (a token revocation) that must not close an open gate under a live
  /// session.
  public func check(_ profile: ServerProfile) async -> Bool {
    await verify(profile)
  }

  public func close() {
    state.withLock { current in
      current.epoch &+= 1
      current.openKey = nil
    }
  }
}

/// A `CredentialStore` whose reads see nothing while its `CredentialGate` is
/// closed for the key. Writes pass straight through: a login or logout the
/// operator starts is theirs to make.
public struct GatedCredentialStore: CredentialStore {
  public let base: any CredentialStore
  public let gate: CredentialGate

  public init(base: any CredentialStore, gate: CredentialGate) {
    self.base = base
    self.gate = gate
  }

  public func load(for key: String) throws -> StoredCredential? {
    guard gate.isVerified(for: key) else { return nil }
    return try base.load(for: key)
  }

  public func save(_ credential: StoredCredential, for key: String) throws {
    try base.save(credential, for: key)
  }

  public func delete(for key: String) throws {
    try base.delete(for: key)
  }
}
