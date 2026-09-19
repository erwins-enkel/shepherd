import Foundation
import Testing

@testable import ShepherdKit

@MainActor
@Suite("SessionStore event tap")
struct SessionStoreEventTapTests {
  /// A store with no socket of its own: `consume(_:)` is driven by hand, which
  /// is the only part of the pipeline this suite is about.
  private func makeStore() throws -> SessionStore {
    let profile = ServerProfile(
      name: "fake", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local, credentialKey: "k")
    let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
    return SessionStore(client: client)
  }

  /// Polls until `condition` holds or the deadline passes. Same shape as
  /// `EventStreamTests.eventually` — Network.framework callbacks land on their
  /// own queue, so a test observes them by polling.
  private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  @Test("an event the client does not model reaches a tap with its payload")
  func unknownEventReachesATap() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    let store = try makeStore()

    let seen = EventBox()
    let tap = store.events()
    let reader = Task { @MainActor in
      for await event in tap {
        seen.set(event)
        break
      }
    }
    let pump = Task { @MainActor in await store.consume(stream.events()) }
    defer {
      reader.cancel()
      pump.cancel()
    }

    await stream.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.send(#"{"event":"session:git","data":{"prNumber":7}}"#)

    #expect(try await eventually { seen.get() != nil })
    guard case .unknown(let name, let payload) = try #require(seen.get()) else {
      Issue.record("expected an .unknown event")
      return
    }
    #expect(name == "session:git")
    // A stream decodes this with the generated schema its own contract block
    // declares; here it is enough to prove the bytes survived the trip.
    let json =
      try JSONSerialization.jsonObject(with: try #require(payload)) as? [String: Any]
    #expect(json?["prNumber"] as? Int == 7)

    await stream.stop()
  }

  @Test("every tap finishes when the store stops")
  func tapsFinishOnStop() async throws {
    let store = try makeStore()
    let first = store.events()
    let second = store.events()

    let drained = Task { @MainActor () -> Int in
      var count = 0
      for await _ in first { count += 1 }
      return count
    }
    let other = Task { @MainActor in
      for await _ in second {}
      return true
    }

    // One event, to both taps, before the stop.
    store.apply(.unknown(name: "held:changed", payload: nil))
    store.stop()

    // Both `for await` loops end only because `stop()` finished the
    // continuations; without that this test would hang rather than fail, which
    // is the clearest possible signal.
    #expect(await drained.value == 1)
    #expect(await other.value)
  }

  /// Holds the first element a reader saw. `@unchecked Sendable` is not needed:
  /// the box is only ever touched from the main actor here.
  @MainActor
  private final class EventBox {
    private var value: ServerEvent?
    func set(_ event: ServerEvent) { if value == nil { value = event } }
    func get() -> ServerEvent? { value }
  }
}
