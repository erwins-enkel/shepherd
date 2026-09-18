import Foundation

/// Non-persistent `CredentialStore` for tests and SwiftUI previews.
///
/// Lock-guarded rather than an actor, because `CredentialStore` is
/// synchronous by design (see the protocol's doc comment).
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String: StoredCredential]

  public init() { storage = [:] }

  public init(seed: [String: StoredCredential]) { storage = seed }

  public func load(for key: String) throws -> StoredCredential? {
    lock.lock()
    defer { lock.unlock() }
    return storage[key]
  }

  public func save(_ credential: StoredCredential, for key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    storage[key] = credential
  }

  public func delete(for key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    storage[key] = nil
  }
}
