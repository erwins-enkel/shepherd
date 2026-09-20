import Foundation
import Testing

@testable import ShepherdKit

@MainActor
@Suite("SessionStore event tap", .timeLimit(.minutes(1)))
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

  @Test("events() on a stopped store finishes immediately instead of hanging")
  func eventsOnStoppedStoreFinishImmediately() async throws {
    let store = try makeStore()
    store.stop()

    // `stop()` already finished every continuation it knew about and will
    // never run again, so a tap registered afterward must not sit around
    // waiting for a broadcast or a finish that will never come.
    var count = 0
    for await _ in store.events() { count += 1 }
    #expect(count == 0)
  }

  @Test("a tap unregisters once its reader is cancelled")
  func tapUnregistersOnReaderCancellation() async throws {
    let store = try makeStore()
    let tap = store.events()
    #expect(store.eventTaps.count == 1)

    let reader = Task { @MainActor in
      for await _ in tap {}
    }
    reader.cancel()

    // Cancelling the reading task finishes the underlying `AsyncStream` for
    // it, which runs `onTermination` and removes this tap's own entry —
    // without touching any other tap the store may still have open.
    #expect(try await eventually { store.eventTaps.isEmpty })
  }

  @Test("breaking out of a for-await keeps the tap; dropping the stream removes it")
  func aBreakKeepsTheTapUntilTheStreamIsDropped() async throws {
    let store = try makeStore()
    // Held in a variable for the whole test, so what follows is about the
    // `for await`, not about the stream value going out of scope.
    var tap: AsyncStream<ServerEvent>? = store.events()
    #expect(store.eventTaps.count == 1)

    store.apply(.unknown(name: "first:frame", payload: nil))
    var seen = 0
    for await _ in tap! {
      seen += 1
      break
    }
    #expect(seen == 1)

    // Leaving the loop drops the ITERATOR, not the stream. Unlike cancelling
    // the reading task — which the test above covers — this does not terminate
    // anything: the tap is still registered and still filling its 64-frame
    // buffer with events nobody is reading.
    #expect(store.eventTaps.count == 1)
    store.apply(.unknown(name: "second:frame", payload: nil))
    for await _ in tap! {
      seen += 1
      break
    }
    #expect(seen == 2)

    // Releasing the stream value is what runs `onTermination` and removes the
    // tap. It hops back to the main actor to do it, hence the poll.
    tap = nil
    #expect(try await eventually { store.eventTaps.isEmpty })
  }

  @Test("a modeled event, not just .unknown ones, reaches a tap")
  func modeledEventReachesATap() async throws {
    let store = try makeStore()
    let tap = store.events()
    let seen = EventBox()
    let reader = Task { @MainActor in
      for await event in tap {
        seen.set(event)
        break
      }
    }
    defer { reader.cancel() }

    let event = ServerEvent.sessionStatus(
      Components.Schemas.SessionStatusEvent(
        id: "s1", status: SessionStatus(known: .running), hasScratchpadFiles: nil))
    store.apply(event)

    #expect(try await eventually { seen.get() != nil })
    #expect(seen.get() == event)
  }

  @Test("a tap observes state that already includes the event it just received")
  func tapObservesStateAfterApply() async throws {
    let store = try makeStore()
    let tap = store.events()
    let sawRow = BoolBox()
    let reader = Task { @MainActor in
      for await event in tap {
        if case .sessionNew = event {
          sawRow.set(store.sessions.contains { $0.id == "new-1" })
        }
        break
      }
    }
    defer { reader.cancel() }

    store.apply(.sessionNew(Fixtures.session(id: "new-1")))

    #expect(try await eventually { sawRow.get() != nil })
    #expect(sawRow.get() == true)
  }

  /// Holds the first element a reader saw. `@unchecked Sendable` is not needed:
  /// the box is only ever touched from the main actor here.
  @MainActor
  private final class EventBox {
    private var value: ServerEvent?
    func set(_ event: ServerEvent) { if value == nil { value = event } }
    func get() -> ServerEvent? { value }
  }

  /// Holds one `Bool` a reader observed. Same shape as `EventBox`, for a test
  /// that checks a fact about the store rather than the event itself.
  @MainActor
  private final class BoolBox {
    private var value: Bool?
    func set(_ observed: Bool) { if value == nil { value = observed } }
    func get() -> Bool? { value }
  }
}
