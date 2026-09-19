import Foundation
import Testing

@testable import ShepherdKit

@Suite("PTYConnection")
struct PTYConnectionTests {
  /// Network.framework handlers run on their own queue, so tests observe them
  /// by polling rather than by awaiting a continuation nobody resumes.
  private func eventually(
    timeout: Duration = .seconds(5), _ condition: @Sendable () -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  private final class Box<Element: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Element] = []
    func append(_ value: Element) {
      lock.lock()
      defer { lock.unlock() }
      values.append(value)
    }
    func all() -> [Element] {
      lock.lock()
      defer { lock.unlock() }
      return values
    }
  }

  /// Drains a stream into a lock-guarded box for the life of the test.
  private func collect<Element: Sendable>(
    _ stream: AsyncStream<Element>
  ) -> (Box<Element>, Task<Void, Never>) {
    let box = Box<Element>()
    return (box, Task { for await value in stream { box.append(value) } })
  }

  /// `eventually` for a condition that has to hop onto the actor.
  private func eventuallyAsync(
    timeout: Duration = .seconds(5), _ condition: () async -> Bool
  ) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if await condition() { return true }
      try await Task.sleep(for: .milliseconds(25))
    }
    return await condition()
  }

  private func makeConnection(
    _ server: FakePTYServer, id: String = "sess-1", cols: Int = 120, rows: Int = 40
  ) -> PTYConnection {
    PTYConnection(
      baseURL: server.baseURL, sessionID: id, tokenProvider: { "shp_test" },
      cols: cols, rows: rows,
      reconnectDelay: .milliseconds(30), maxReconnectDelay: .milliseconds(200))
  }

  @Test("the pty URL carries the ws scheme, the id and the attach size")
  func urlShape() {
    let url = PTYConnection.ptyURL(
      for: URL(string: "https://host.example.ts.net:7330/shepherd")!,
      sessionID: "a b/c", cols: 120, rows: 40)
    #expect(
      url.absoluteString
        == "wss://host.example.ts.net:7330/shepherd/pty/a%20b%2Fc?cols=120&rows=40")
  }

  @Test("an id's unreserved characters survive: the server matches the segment raw")
  func urlKeepsUnreservedCharacters() {
    let url = PTYConnection.ptyURL(
      for: URL(string: "http://127.0.0.1:7330")!,
      sessionID: "3f7c1a8e-0d2b-4c6a-9e1f-5b8d7a2c4e60", cols: 80, rows: 24)
    #expect(
      url.absoluteString
        == "ws://127.0.0.1:7330/pty/3f7c1a8e-0d2b-4c6a-9e1f-5b8d7a2c4e60?cols=80&rows=24")
    #expect(
      PTYConnection.ptyURL(
        for: URL(string: "http://h")!, sessionID: "a-b_c.d~e", cols: 1, rows: 1
      ).absoluteString == "ws://h/pty/a-b_c.d~e?cols=1&rows=1")
  }

  @Test("the upgrade request targets /pty/<id> with the id unencoded")
  func requestTargetIsRaw() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let id = "3f7c1a8e-0d2b-4c6a-9e1f-5b8d7a2c4e60"
    let connection = makeConnection(server, id: id)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    #expect(try await eventually { server.lastRequestTarget() != nil })
    #expect(server.lastRequestTarget() == "/pty/\(id)?cols=120&rows=40")
    await connection.stop()
  }

  @Test("connecting sends the bearer on the upgrade and reports .attached")
  func attaches() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    #expect(server.upgradeHeaders()["Authorization"] == "Bearer shp_test")
    #expect(try await eventually { lifecycle.all() == [.attached] })
    await connection.stop()
  }

  @Test("server bytes arrive on output() unchanged")
  func output() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (bytes, reader) = collect(await connection.output())
    defer { reader.cancel() }
    let payload = Data([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69])

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.sendBytes(payload)
    #expect(try await eventually { bytes.all().first == payload })
    await connection.stop()
  }

  @Test("send writes keystrokes verbatim")
  func sendsInput() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.send(Data("ls -la\r".utf8))
    #expect(try await eventually { server.receivedTexts().contains("ls -la\r") })
    await connection.stop()
  }

  @Test("resize writes the control frame the bridge parses")
  func resizes() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.resize(cols: 80, rows: 24)
    #expect(try await eventually { server.receivedTexts().contains("\u{0}resize:80:24\n") })
    await connection.stop()
  }

  @Test("a resize before the socket is open is applied to the next attach")
  func resizeBeforeAttach() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server, cols: 100, rows: 30)

    await connection.resize(cols: 90, rows: 25)
    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    #expect(await connection.currentSize() == PTYSize(cols: 90, rows: 25))
    await connection.stop()
  }

  @Test("a 4000 close reaches the close handler as 4000, not as the 1001 of a racing stop()")
  func closeCodeSurvivesRacingStop() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })

    // Force the interleaving the capture point exists for. Blocking the actor
    // lets the test queue `stop()` ahead of the receive loop's resumption: the
    // socket is closed with 4000 while the actor is busy, `stop()` then cancels
    // it with `.goingAway` (1001), and only afterwards does the close handler
    // run. Anything that read `socket.closeCode` at that point would see 1001.
    let blocker = Task { await connection.blockForTests(seconds: 0.4) }
    try await Task.sleep(for: .milliseconds(50))
    let stopper = Task { await connection.stop() }
    try await Task.sleep(for: .milliseconds(50))
    server.close(code: 4000)
    #expect(try await eventually { server.sawPeerClose() })

    _ = await blocker.value
    _ = await stopper.value
    #expect(try await eventuallyAsync { await connection.lastCloseCode == 4000 })
  }

  // A time limit rather than a hang: the point of the test is that the
  // `for await` loops end, so a regression must fail the suite, not park it.
  @Test("every output() stream gets every chunk, and stop() ends them", .timeLimit(.minutes(1)))
  func outputFansOutToEveryConsumer() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (first, firstReader) = collect(await connection.output())
    let (second, secondReader) = collect(await connection.output())
    let chunks = [Data([0x61]), Data([0x62]), Data([0x63])]

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    for chunk in chunks { server.sendBytes(chunk) }
    #expect(try await eventually { first.all() == chunks && second.all() == chunks })

    await connection.stop()
    // Both `for await` loops end rather than hanging: `stop()` finishes every
    // stream it handed out.
    await firstReader.value
    await secondReader.value
  }

  @Test(
    "every lifecycle() stream gets every event, and stop() ends them",
    .timeLimit(.minutes(1)))
  func lifecycleFansOutToEveryConsumer() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (first, firstReader) = collect(await connection.lifecycle())
    let (second, secondReader) = collect(await connection.lifecycle())

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.stop()

    await firstReader.value
    await secondReader.value
    #expect(first.all() == [.attached, .closed(.stopped)])
    #expect(second.all() == [.attached, .closed(.stopped)])
  }

  @Test("a character split across two send() calls arrives whole")
  func splitMultibyteInput() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let bytes = Array("ä".utf8)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.send(Data(bytes.prefix(1)))
    await connection.send(Data(bytes.dropFirst()))
    #expect(try await eventually { server.receivedTexts().contains("ä") })
    // Neither half was flushed on its own as a replacement character.
    #expect(!server.receivedTexts().contains { $0.contains("\u{FFFD}") })
    await connection.stop()
  }

  @Test("an attach that never carried a frame does not make the next one a .reattached")
  func reattachedOnlyAfterARealAttach() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    server.setRejectUpgrades(true)
    let connection = makeConnection(server)
    let (events, reader) = collect(await connection.lifecycle())
    let (bytes, byteReader) = collect(await connection.output())
    defer {
      reader.cancel()
      byteReader.cancel()
    }

    await connection.start()
    #expect(try await eventually { events.all() == [.attached, .detached] })

    // The refused attach cleared nothing, so the next one is still `.attached`.
    server.setRejectUpgrades(false)
    await connection.takeOver()
    #expect(try await eventually { server.connectionCount() == 2 })
    server.sendBytes(Data([0x68, 0x69]))
    #expect(try await eventually { bytes.all() == [Data([0x68, 0x69])] })
    #expect(events.all() == [.attached, .detached, .attached])

    // That frame proved the attach: from here a reconnect replays scrollback,
    // so the view has to clear first and the event is `.reattached`.
    await connection.takeOver()
    #expect(try await eventually { events.all().last == .reattached })
    await connection.stop()
  }
}

extension PTYConnection {
  /// Test-only: occupy the actor's executor so the test can control what runs
  /// on it next. Blocks the thread on purpose — a suspension would let the
  /// actor interleave, which is the opposite of what the close-code race needs.
  func blockForTests(seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }
}
