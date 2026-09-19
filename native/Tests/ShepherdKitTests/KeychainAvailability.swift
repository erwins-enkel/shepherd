import Foundation
import Security
@testable import ShepherdKit

/// Whether this environment can actually exercise `SecItem*` calls.
///
/// CI runners (and some sandboxes) have no unlocked keychain to write to;
/// `SecItemAdd` then fails with `errSecInteractionNotAllowed` or
/// `errSecNotAvailable` instead of succeeding. Tests that touch
/// `KeychainCredentialStore` gate on this via `@Test(.enabled(if:))` so they
/// skip cleanly there instead of failing, while still running — and still
/// failing on a real regression — everywhere a keychain is usable.
enum KeychainAvailability {
  /// Computed once per test run: a real probe save+delete against a
  /// service name unique to this process.
  static let isUsable: Bool = probe()

  private static func probe() -> Bool {
    let service = "run.shepherd.kit.test.probe.\(UUID().uuidString)"
    let store = KeychainCredentialStore(service: service)
    do {
      try store.save(StoredCredential(token: "probe", tokenId: "probe"), for: "probe")
      try? store.delete(for: "probe")
      return true
    } catch KeychainError.unexpectedStatus(let status) {
      switch status {
      case errSecInteractionNotAllowed, errSecNotAvailable:
        return false
      default:
        // Any other status is a real failure, not an environment limit —
        // let it surface by running the tests rather than skipping them.
        return true
      }
    } catch {
      return true
    }
  }
}
