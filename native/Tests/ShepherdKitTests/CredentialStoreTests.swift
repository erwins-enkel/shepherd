import Foundation
import Testing
@testable import ShepherdKit

@Suite("CredentialStore")
struct CredentialStoreTests {
  @Test("in-memory store round-trips and deletes")
  func inMemoryRoundTrip() throws {
    let store = InMemoryCredentialStore()
    #expect(try store.load(for: "k") == nil)

    let credential = StoredCredential(token: "shp_abc", tokenId: "tok_1")
    try store.save(credential, for: "k")
    #expect(try store.load(for: "k") == credential)

    try store.delete(for: "k")
    #expect(try store.load(for: "k") == nil)
  }

  @Test("deleting a key that was never stored is not an error")
  func inMemoryDeleteMissing() throws {
    try InMemoryCredentialStore().delete(for: "nope")
  }

  @Test("saving twice replaces the credential")
  func inMemoryReplace() throws {
    let store = InMemoryCredentialStore()
    try store.save(StoredCredential(token: "a", tokenId: "1"), for: "k")
    try store.save(StoredCredential(token: "b", tokenId: "2"), for: "k")
    #expect(try store.load(for: "k")?.token == "b")
  }

  @Test("seeded store reads back its seed")
  func inMemorySeed() throws {
    let store = InMemoryCredentialStore(seed: ["k": StoredCredential(token: "t", tokenId: "i")])
    #expect(try store.load(for: "k")?.tokenId == "i")
  }

  // Writes to a real keychain, so it is opt-in (SHEPHERD_KEYCHAIN_TESTS=1),
  // uses a service name unique to this run, and cleans up after itself.
  @Test(
    "keychain store round-trips, replaces and deletes",
    .enabled(if: KeychainAvailability.isUsable)
  )
  func keychainRoundTrip() throws {
    let service = "run.shepherd.kit.test.\(UUID().uuidString)"
    let store = KeychainCredentialStore(service: service)
    let key = "profile.test"
    defer { try? store.delete(for: key) }

    #expect(try store.load(for: key) == nil)
    let credential = StoredCredential(token: "shp_keychain", tokenId: "tok_k")
    try store.save(credential, for: key)
    #expect(try store.load(for: key) == credential)

    try store.save(StoredCredential(token: "shp_second", tokenId: "tok_k2"), for: key)
    #expect(try store.load(for: key)?.token == "shp_second")

    try store.delete(for: key)
    #expect(try store.load(for: key) == nil)
  }

  // Saving twice for the same key hits `SecItemAdd`'s `errSecDuplicateItem`
  // path on the second call, which must fall through to `SecItemUpdate`
  // rather than leaving the first token in place (or failing outright).
  @Test(
    "keychain store save updates an existing item in place",
    .enabled(if: KeychainAvailability.isUsable)
  )
  func keychainSaveUpdatesInPlace() throws {
    let service = "run.shepherd.kit.test.\(UUID().uuidString)"
    let store = KeychainCredentialStore(service: service)
    let key = "profile.update"
    defer { try? store.delete(for: key) }

    try store.save(StoredCredential(token: "shp_first", tokenId: "tok_1"), for: key)
    try store.save(StoredCredential(token: "shp_second", tokenId: "tok_2"), for: key)

    #expect(try store.load(for: key) == StoredCredential(token: "shp_second", tokenId: "tok_2"))
  }

  // The two tests above skip themselves where no keychain is usable, which is
  // exactly how a regressed CI keychain step would hide: the job would stay
  // green with nothing exercising `SecItem*`. This test never skips, and it
  // guards both halves of that — without ever touching the Keychain itself
  // when the opt-in switch is off:
  //
  //   * CI must set SHEPHERD_KEYCHAIN_TESTS=1, so dropping it from the
  //     workflow turns the whole `SecItem*` suite silent — and red here.
  //   * having set it, the keychain must really be writable, so a broken
  //     "Prepare a test keychain" step fails loudly instead of skipping.
  @Test("CI opts in to the keychain tests, and the keychain then works")
  func keychainIsUsableOnCI() {
    let isCI = ProcessInfo.processInfo.environment["CI"] != nil
    #expect(!isCI || KeychainAvailability.isEnabled)
    #expect(!KeychainAvailability.isEnabled || KeychainAvailability.isUsable)
  }
}
