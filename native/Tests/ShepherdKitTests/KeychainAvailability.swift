import Foundation
import Security
@testable import ShepherdKit

/// Whether this test run may touch a real Keychain at all, and whether doing so
/// would actually work.
///
/// Touching the *login* keychain from a test is not free: each freshly built
/// test runner is a different signer, so macOS asks the operator to approve
/// access to items an earlier run created. That is a modal dialog in the middle
/// of what is supposed to be an unattended `swift test`, so these tests are
/// opt-in rather than opt-out:
///
///   SHEPHERD_KEYCHAIN_TESTS=1 swift test --package-path native
///
/// CI sets it, because the workflow prepares a throwaway keychain first (see
/// the "Prepare a test keychain" step in `.github/workflows/native.yml`).
/// Without the variable the `SecItem*` tests skip and nothing in the suite
/// reaches the Keychain — not even the probe below, which is itself a write.
enum KeychainAvailability {
  /// The opt-in switch. `xcodebuild` forwards a test runner's environment under
  /// a `TEST_RUNNER_` prefix, so both spellings count.
  static let isEnabled: Bool = {
    let environment = ProcessInfo.processInfo.environment
    for name in ["SHEPHERD_KEYCHAIN_TESTS", "TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS"] {
      guard let raw = environment[name] else { continue }
      switch raw.trimmingCharacters(in: .whitespaces).lowercased() {
      case "1", "true", "yes": return true
      default: continue
      }
    }
    return false
  }()

  /// Computed once per test run: opted in *and* a real probe save+delete
  /// against a service name unique to this process succeeded.
  ///
  /// The `&&` short-circuits, so with the switch off no `SecItem*` call is
  /// ever made.
  static let isUsable: Bool = isEnabled && probe()

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
