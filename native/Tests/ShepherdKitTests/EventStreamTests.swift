import Foundation
import Testing

@testable import ShepherdKit

@Suite("EventStream")
struct EventStreamTests {
  /// Polls `condition` until it holds or the deadline passes. Network.framework
  /// handlers run on their own queue, so tests observe them by polling rather
  /// than by awaiting a continuation the server never resumes.
  private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @Sendable () -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  /// Waits until the server has both accepted the upgrade *and* adopted the
  /// connection. Those are two different callbacks on two different points of
  /// the handshake, so a test that only waits for the upgrade can call
  /// `send(_:)` before there is a connection to send on — the frame would be
  /// dropped and the test would wait forever for it.
  private func awaitConnected(_ server: FakeEventServer, count: Int = 1) async throws {
    #expect(try await eventually { server.connectionCount() == count })
    // The presence frame the client sends on connect is proof that the server
    // side adopted the socket and its receive loop is running.
    #expect(try await eventually { server.receivedTexts().count >= count })
  }

  /// Reads one event without ever blocking forever: a reader task parks the
  /// first element in a box and the poll loop gives up at the deadline, so a
  /// frame that never arrives fails the test instead of hanging the suite.
  private func firstEvent(
    from stream: AsyncStream<ServerEvent>,
    timeout: Duration = .seconds(5)
  ) async throws -> ServerEvent? {
    let box = FirstEventBox()
    let reader = Task {
      for await event in stream {
        box.set(event)
        break
      }
    }
    defer { reader.cancel() }
    _ = try await eventually(timeout: timeout) { box.get() != nil }
    return box.get()
  }

  private final class FirstEventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ServerEvent?

    func set(_ event: ServerEvent) {
      lock.lock()
      defer { lock.unlock() }
      if value == nil { value = event }
    }

    func get() -> ServerEvent? {
      lock.lock()
      defer { lock.unlock() }
      return value
    }
  }

  /// Runs `body` against a fresh fake server and a stream wired to it, and
  /// tears both down in the right order — the stream first, so its reconnect
  /// loop cannot outlive the listener — even when `body` throws.
  ///
  /// A `defer` cannot do this: `stop()` is `async`, and a `defer` body may not
  /// `await`. Without this wrapper a throwing `eventually` (it sleeps, so it
  /// can be cancelled) would leak a listener and a reconnecting stream into
  /// the rest of the suite.
  private func withStream(
    tokenProvider: @escaping @Sendable () -> String? = { nil },
    reconnectDelay: Duration = .seconds(1),
    maxReconnectDelay: Duration = .seconds(30),
    _ body: (FakeEventServer, EventStream) async throws -> Void
  ) async throws {
    let server = try FakeEventServer()
    let stream = EventStream(
      baseURL: server.url, tokenProvider: tokenProvider,
      reconnectDelay: reconnectDelay, maxReconnectDelay: maxReconnectDelay)
    do {
      try await body(server, stream)
    } catch {
      await stream.stop()
      server.stop()
      throw error
    }
    await stream.stop()
    server.stop()
  }

  @Test("the bearer token rides the upgrade request")
  func sendsBearerOnUpgrade() async throws {
    // `withStream` is the structured teardown: `stop()` is awaited to
    // completion before the server goes away, rather than racing an
    // unstructured `Task { … }` against `server.stop()` in unordered
    // `defer`s — and it runs even when an assertion throws.
    try await withStream(tokenProvider: { "shp_events" }) { server, stream in
      await stream.start()

      try await awaitConnected(server)
      #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_events")
    }
  }

  @Test("frames arrive as decoded ServerEvents")
  func yieldsDecodedEvents() async throws {
    try await withStream(tokenProvider: { "shp_events" }) { server, stream in
      let events = stream.events()
      await stream.start()

      try await awaitConnected(server)
      server.send(#"{"event":"session:ready","data":{"id":"a","ready":true}}"#)

      let first = try await firstEvent(from: events)
      #expect(first == .sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
    }
  }

  @Test("an unknown event name still reaches the consumer as .unknown")
  func yieldsUnknownEvents() async throws {
    try await withStream { server, stream in
      let events = stream.events()
      await stream.start()

      try await awaitConnected(server)
      server.send(#"{"event":"epic:progress","data":{}}"#)

      #expect(try await firstEvent(from: events) == .unknown(name: "epic:progress"))
    }
  }

  @Test("a malformed frame is dropped and the stream keeps going")
  func dropsMalformedFrames() async throws {
    try await withStream { server, stream in
      let events = stream.events()
      await stream.start()

      try await awaitConnected(server)
      server.send("not json at all")
      server.send(#"{"event":"session:archived","data":{"id":"a"}}"#)

      #expect(
        try await firstEvent(from: events)
          == .sessionArchived(Components.Schemas.SessionArchivedEvent(id: "a")))
    }
  }

  @Test("presence starts false and is reported on connect and on every change")
  func reportsPresence() async throws {
    try await withStream { server, stream in
      await stream.start()

      // `active` starts `false` (see `setActive`'s doc comment): the initial
      // presence frame reports it before the app has ever called
      // `setActive(true)`, and `awaitConnected` waits for exactly that frame.
      // (It is also the statement that makes this closure throwing: effect
      // inference runs before `#expect` expands, so a `try` that only appears
      // inside the macro's arguments does not count.)
      try await awaitConnected(server)
      #expect(server.receivedTexts().count == 1)
      #expect(server.receivedTexts().first?.contains("\"presence\"") == true)
      #expect(server.receivedTexts().first?.contains("\"active\":false") == true)

      await stream.setActive(true)
      #expect(try await eventually { server.receivedTexts().count == 2 })
      #expect(server.receivedTexts().last?.contains("\"active\":true") == true)
    }
  }

  @Test("a server close reconnects after the delay")
  func reconnectsAfterClose() async throws {
    try await withStream(reconnectDelay: .milliseconds(50)) { server, stream in
      await stream.start()

      try await awaitConnected(server)
      server.closeCurrentConnection()
      #expect(try await eventually { server.connectionCount() == 2 })
    }
  }

  @Test("the lifecycle stream reports the open, the loss and the reopen")
  func reportsLifecycle() async throws {
    try await withStream(reconnectDelay: .milliseconds(50)) { server, stream in
      let lifecycle = stream.lifecycle()
      await stream.start()

      try await awaitConnected(server)
      server.closeCurrentConnection()
      #expect(try await eventually { server.connectionCount() == 2 })

      // Elements are buffered from construction, so the first `.connected` is
      // still there even though nothing was iterating when it was yielded.
      var seen: [EventStream.LifecycleEvent] = []
      for await event in lifecycle {
        seen.append(event)
        if seen.count == 3 { break }
      }
      #expect(seen == [.connected, .disconnected, .connected])
    }
  }

  @Test("reconnectNow() opens a fresh socket without waiting out the delay")
  func reconnectNowIsImmediate() async throws {
    try await withStream(reconnectDelay: .seconds(60)) { server, stream in
      await stream.start()

      try await awaitConnected(server)
      await stream.reconnectNow()
      // A 60 s reconnect delay means only `reconnectNow()` can produce this.
      #expect(try await eventually(timeout: .seconds(5)) { server.connectionCount() == 2 })
    }
  }

  @Test("the token is re-read on every connect")
  func rereadsTokenOnReconnect() async throws {
    let tokens = TokenSequence(["shp_first", "shp_second"])
    try await withStream(tokenProvider: { tokens.next() }, reconnectDelay: .milliseconds(50)) {
      server, stream in
      await stream.start()

      try await awaitConnected(server)
      #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_first")

      server.closeCurrentConnection()
      #expect(try await eventually { server.connectionCount() == 2 })
      #expect(
        try await eventually { server.upgradeHeaders()["Authorization"] == "Bearer shp_second" })
    }
  }

  /// Hands out one token per `next()`, so a second upgrade proves the stream
  /// re-read the provider rather than caching the first token.
  private final class TokenSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: [String]

    init(_ tokens: [String]) { remaining = tokens }

    func next() -> String? {
      lock.lock()
      defer { lock.unlock() }
      return remaining.isEmpty ? nil : remaining.removeFirst()
    }
  }

  @Test("stop() does not reconnect")
  func stopIsFinal() async throws {
    try await withStream(reconnectDelay: .milliseconds(50)) { server, stream in
      await stream.start()

      try await awaitConnected(server)
      await stream.stop()
      server.closeCurrentConnection()

      try await Task.sleep(for: .milliseconds(400))
      #expect(server.connectionCount() == 1)
    }
  }

  @Test("a rejected upgrade backs off with a growing delay, then recovers once accepted")
  func backsOffOnRejectedUpgrades() async throws {
    try await withStream(
      reconnectDelay: .milliseconds(20), maxReconnectDelay: .milliseconds(160)
    ) { server, stream in
      let events = stream.events()

      server.setRejectUpgrades(true)
      await stream.start()

      // Give the stream a fixed window to retry against the rejecting server.
      // A flat, non-backing-off 20 ms retry would fit roughly window / 20 ms
      // attempts in that time (~40 for an 800 ms window); capped exponential
      // backoff (20, 40, 80, 160, 160, 160, … ms) fits far fewer — about 7.
      // The upper bound below is comfortably between the two, so only a
      // growing delay between attempts explains staying under it.
      try await Task.sleep(for: .milliseconds(800))
      let attemptsWhileRejecting = server.connectionCount()
      #expect(attemptsWhileRejecting >= 2)
      #expect(attemptsWhileRejecting < 20)

      server.setRejectUpgrades(false)
      // The next attempt after un-rejecting succeeds: the presence frame is
      // proof the upgrade was accepted and the connection adopted.
      #expect(try await eventually(timeout: .seconds(5)) { server.receivedTexts().count >= 1 })

      server.send(#"{"event":"session:ready","data":{"id":"a","ready":true}}"#)
      #expect(
        try await firstEvent(from: events)
          == .sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
    }
  }

  @Test(
    "eventsURL(for:) swaps the scheme, keeps any path prefix, and drops query/fragment",
    arguments: [
      (URL(string: "https://host/shepherd/")!, "wss://host/shepherd/events"),
      (URL(string: "http://127.0.0.1:7330")!, "ws://127.0.0.1:7330/events"),
      (URL(string: "https://host/shepherd?x=1#frag")!, "wss://host/shepherd/events"),
      (URL(string: "https://host/shepherd/foo/")!, "wss://host/shepherd/foo/events"),
    ])
  func eventsURLPreservesPathPrefix(_ pair: (URL, String)) {
    #expect(EventStream.eventsURL(for: pair.0).absoluteString == pair.1)
  }
}
