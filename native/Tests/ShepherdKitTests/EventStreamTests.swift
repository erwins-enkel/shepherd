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

  @Test("the bearer token rides the upgrade request")
  func sendsBearerOnUpgrade() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { "shp_events" })
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_events")
  }

  @Test("frames arrive as decoded ServerEvents")
  func yieldsDecodedEvents() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { "shp_events" })
    let events = stream.events()
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    server.send(#"{"event":"session:ready","data":{"id":"a","ready":true}}"#)

    let first = try await firstEvent(from: events)
    #expect(first == .sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
  }

  @Test("an unknown event name still reaches the consumer as .unknown")
  func yieldsUnknownEvents() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    let events = stream.events()
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    server.send(#"{"event":"epic:progress","data":{}}"#)

    #expect(try await firstEvent(from: events) == .unknown(name: "epic:progress"))
  }

  @Test("a malformed frame is dropped and the stream keeps going")
  func dropsMalformedFrames() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    let events = stream.events()
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    server.send("not json at all")
    server.send(#"{"event":"session:archived","data":{"id":"a"}}"#)

    #expect(
      try await firstEvent(from: events)
        == .sessionArchived(Components.Schemas.SessionArchivedEvent(id: "a")))
  }

  @Test("presence is reported on connect and on every change")
  func reportsPresence() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(baseURL: server.url, tokenProvider: { nil })
    await stream.start()
    defer { Task { await stream.stop() } }

    #expect(try await eventually { server.receivedTexts().count == 1 })
    #expect(server.receivedTexts().first?.contains("\"presence\"") == true)
    #expect(server.receivedTexts().first?.contains("\"active\":true") == true)

    await stream.setActive(false)
    #expect(try await eventually { server.receivedTexts().count == 2 })
    #expect(server.receivedTexts().last?.contains("\"active\":false") == true)
  }

  @Test("a server close reconnects after the delay")
  func reconnectsAfterClose() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(
      baseURL: server.url, tokenProvider: { nil }, reconnectDelay: .milliseconds(50))
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    server.closeCurrentConnection()
    #expect(try await eventually { server.connectionCount() == 2 })
  }

  @Test("reconnectNow() opens a fresh socket without waiting out the delay")
  func reconnectNowIsImmediate() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(
      baseURL: server.url, tokenProvider: { nil }, reconnectDelay: .seconds(60))
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    await stream.reconnectNow()
    // A 60 s reconnect delay means only `reconnectNow()` can produce this.
    #expect(try await eventually(timeout: .seconds(5)) { server.connectionCount() == 2 })
  }

  @Test("the token is re-read on every connect")
  func rereadsTokenOnReconnect() async throws {
    let server = try FakeEventServer()
    defer { server.stop() }
    let tokens = TokenSequence(["shp_first", "shp_second"])
    let stream = EventStream(
      baseURL: server.url, tokenProvider: { tokens.next() }, reconnectDelay: .milliseconds(50))
    await stream.start()
    defer { Task { await stream.stop() } }

    try await awaitConnected(server)
    #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_first")

    server.closeCurrentConnection()
    #expect(try await eventually { server.connectionCount() == 2 })
    #expect(
      try await eventually { server.upgradeHeaders()["Authorization"] == "Bearer shp_second" })
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
    let server = try FakeEventServer()
    defer { server.stop() }
    let stream = EventStream(
      baseURL: server.url, tokenProvider: { nil }, reconnectDelay: .milliseconds(50))
    await stream.start()

    try await awaitConnected(server)
    await stream.stop()
    server.closeCurrentConnection()

    try await Task.sleep(for: .milliseconds(400))
    #expect(server.connectionCount() == 1)
  }
}
