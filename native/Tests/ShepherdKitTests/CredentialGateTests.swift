import Foundation
import Synchronization
import Testing
@testable import ShepherdKit

/// A verifier the test flips, and that can hold one answer open.
private final class Verdict: Sendable {
  private let value = Mutex(false)
  private let holds = Mutex<CheckedContinuation<Void, Never>?>(nil)
  private let holding = Mutex(false)

  func set(_ verified: Bool) { value.withLock { $0 = verified } }
  func hold() { holding.withLock { $0 = true } }
  var isHeld: Bool { holds.withLock { $0 != nil } }
  func release() { holds.withLock { $0?.resume(); $0 = nil } }

  func verify(_: ServerProfile) async -> Bool {
    if holding.withLock({ $0 }) {
      await withCheckedContinuation { continuation in holds.withLock { $0 = continuation } }
    }
    return value.withLock { $0 }
  }
}

@Suite("CredentialGate", .timeLimit(.minutes(1)))
struct CredentialGateTests {
  private let profile = ServerProfile(
    name: "local", baseURL: URL(string: "http://127.0.0.1:7330")!, mode: .local, credentialKey: "k")
  private let credential = StoredCredential(token: "shp_local", tokenId: "tok_1")

  private func seeded() throws -> InMemoryCredentialStore {
    let base = InMemoryCredentialStore()
    try base.save(credential, for: profile.credentialKey)
    return base
  }

  @Test("a gate that was never verified withholds the token")
  func closedByDefault() throws {
    let gate = CredentialGate { _ in true }
    let store = GatedCredentialStore(base: try seeded(), gate: gate)
    #expect(!gate.isOpen)
    #expect(try store.load(for: profile.credentialKey) == nil)
  }

  @Test("a passing verification releases the token, a failing one withholds it again")
  func refreshFollowsTheVerdict() async throws {
    let verdict = Verdict()
    let gate = CredentialGate { await verdict.verify($0) }
    let store = GatedCredentialStore(base: try seeded(), gate: gate)

    verdict.set(true)
    #expect(await gate.refresh(for: profile))
    #expect(gate.isOpen)
    #expect(try store.load(for: profile.credentialKey) == credential)

    verdict.set(false)
    #expect(await gate.refresh(for: profile) == false)
    #expect(!gate.isOpen)
    #expect(try store.load(for: profile.credentialKey) == nil)
  }

  @Test("close withholds the token until the next verification")
  func closeWithholds() async throws {
    let gate = CredentialGate { _ in true }
    let store = GatedCredentialStore(base: try seeded(), gate: gate)
    #expect(await gate.refresh(for: profile))
    gate.close()
    #expect(try store.load(for: profile.credentialKey) == nil)
  }

  @Test("verification opens only the verified profile's key")
  func boundToTheVerifiedKey() async throws {
    let base = try seeded()
    try base.save(StoredCredential(token: "shp_other", tokenId: "tok_2"), for: "other")
    let gate = CredentialGate { _ in true }
    let store = GatedCredentialStore(base: base, gate: gate)
    #expect(await gate.refresh(for: profile))
    #expect(try store.load(for: profile.credentialKey) == credential)
    #expect(try store.load(for: "other") == nil)
  }

  @Test("a verification superseded by close cannot reopen the gate")
  func staleVerificationStaysClosed() async throws {
    let verdict = Verdict()
    verdict.set(true)
    verdict.hold()
    let gate = CredentialGate { await verdict.verify($0) }
    let profile = profile
    let pending = Task { await gate.refresh(for: profile) }
    while !verdict.isHeld { await Task.yield() }
    gate.close()
    verdict.release()
    #expect(await pending.value == false)
    #expect(!gate.isOpen)
  }

  @Test("save and delete pass through while the gate is closed")
  func writesPassThrough() throws {
    let base = InMemoryCredentialStore()
    let store = GatedCredentialStore(base: base, gate: CredentialGate { _ in false })
    try store.save(credential, for: "k")
    #expect(try base.load(for: "k") == credential)
    try store.delete(for: "k")
    #expect(try base.load(for: "k") == nil)
  }
}
