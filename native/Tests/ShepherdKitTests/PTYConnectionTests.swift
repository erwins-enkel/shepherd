import Foundation
import Testing

@testable import ShepherdKit

@Suite("PTYConnection", .timeLimit(.minutes(1)))
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

  /// `collect`, plus a flag the test polls instead of awaiting: a regression
  /// that leaves a `for await` running forever must fail in seconds, and
  /// `await reader.value` would instead park the run until a time limit fires
  /// (cancelling the test task does not cancel this reader).
  private func collectUntilEnd<Element: Sendable>(
    _ stream: AsyncStream<Element>
  ) -> (Box<Element>, Box<Bool>, Task<Void, Never>) {
    let box = Box<Element>()
    let ended = Box<Bool>()
    return (
      box, ended,
      Task {
        for await value in stream { box.append(value) }
        ended.append(true)
      }
    )
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

  /// Short retry delay by default so the retry tests finish in a second. A test
  /// that needs the *first* retry to stay parked until it says otherwise passes
  /// a long delay instead of racing it.
  private func makeConnection(
    _ server: FakePTYServer, id: String = "sess-1", cols: Int = 120, rows: Int = 40,
    reconnectDelay: Duration = .milliseconds(30)
  ) -> PTYConnection {
    PTYConnection(
      baseURL: server.baseURL, sessionID: id, tokenProvider: { "shp_test" },
      cols: cols, rows: rows, reconnectDelay: reconnectDelay)
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

  @Test("every output() stream gets every chunk, and stop() ends them")
  func outputFansOutToEveryConsumer() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (first, firstEnded, firstReader) = collectUntilEnd(await connection.output())
    let (second, secondEnded, secondReader) = collectUntilEnd(await connection.output())
    defer {
      firstReader.cancel()
      secondReader.cancel()
    }
    let chunks = [Data([0x61]), Data([0x62]), Data([0x63])]

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    for chunk in chunks { server.sendBytes(chunk) }
    #expect(try await eventually { first.all() == chunks && second.all() == chunks })

    await connection.stop()
    // Both `for await` loops end rather than hanging: `stop()` finishes every
    // stream it handed out.
    #expect(try await eventually { firstEnded.all() == [true] && secondEnded.all() == [true] })
  }

  @Test("every lifecycle() stream gets every event, and stop() ends them")
  func lifecycleFansOutToEveryConsumer() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (first, firstEnded, firstReader) = collectUntilEnd(await connection.lifecycle())
    let (second, secondEnded, secondReader) = collectUntilEnd(await connection.lifecycle())
    defer {
      firstReader.cancel()
      secondReader.cancel()
    }

    await connection.start()
    // `connectionCount()` counts upgrade *requests*, which the confirmation
    // that releases `.attached` comes after — wait for the event itself, or
    // `stop()` races ahead of it.
    #expect(try await eventually { first.all() == [.attached] })
    await connection.stop()

    #expect(try await eventually { firstEnded.all() == [true] && secondEnded.all() == [true] })
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

  @Test("an attach whose upgrade was refused does not make the next one a .reattached")
  func reattachedOnlyAfterARealAttach() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    server.setRejectUpgrades(true)
    // A backoff longer than the test: the close policy would otherwise retry the
    // refused attach every few milliseconds and this test is about which event
    // the *next* attach reports, not about the retry cadence (see
    // `fastFailsGiveUp` for that).
    let connection = makeConnection(server, reconnectDelay: .seconds(30))
    let (events, reader) = collect(await connection.lifecycle())
    let (bytes, byteReader) = collect(await connection.output())
    defer {
      reader.cancel()
      byteReader.cancel()
    }

    await connection.start()
    // No `.attached` at all: the upgrade was refused, so the socket never
    // proved itself and the held attach event was dropped with it.
    #expect(try await eventually { events.all() == [.detached] })

    // The refused attach cleared nothing, so the next one is still `.attached`.
    server.setRejectUpgrades(false)
    await connection.takeOver()
    #expect(try await eventually { server.connectionCount() == 2 })
    server.sendBytes(Data([0x68, 0x69]))
    #expect(try await eventually { bytes.all() == [Data([0x68, 0x69])] })
    #expect(events.all() == [.detached, .attached])

    // That attach was confirmed: from here a reconnect replays scrollback,
    // so the view has to clear first and the event is `.reattached`.
    await connection.takeOver()
    #expect(try await eventually { events.all().last == .reattached })
    await connection.stop()
  }

  @Test("close 4000 parks the connection instead of reconnecting")
  func supersededParks() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: 4000)

    #expect(try await eventually { lifecycle.all().contains(.closed(.superseded)) })
    // The whole point: no second attach. Reconnecting here would bump the
    // device that just took over, which would bump back.
    #expect(
      try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)
    #expect(!lifecycle.all().contains(.detached))
    await connection.stop()
  }

  @Test("close 4001 ends the connection for good")
  func goneEnds() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: 4001)

    #expect(try await eventually { lifecycle.all().contains(.closed(.gone)) })
    #expect(
      try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)
    await connection.stop()
  }

  @Test("takeOver re-attaches after a 4000")
  func takeOverReattaches() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    let (bytes, byteReader) = collect(await connection.output())
    defer {
      reader.cancel()
      byteReader.cancel()
    }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    // One real frame first: `.reattached` only follows an attach that actually
    // carried scrollback (`deliver(output:)`), which is what the superseded
    // terminal this test models had.
    server.sendBytes(Data([0x68, 0x69]))
    #expect(try await eventually { bytes.all() == [Data([0x68, 0x69])] })
    server.close(code: 4000)
    #expect(try await eventually { lifecycle.all().contains(.closed(.superseded)) })

    await connection.takeOver()
    #expect(try await eventually { server.connectionCount() == 2 })
    // A second socket is a reattach, not a first attach: the view must clear
    // its buffer before the replayed scrollback lands.
    #expect(try await eventually { lifecycle.all().contains(.reattached) })
    await connection.stop()
  }

  @Test("a transient drop reconnects and reports .reattached")
  func transientReconnects() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    let (bytes, byteReader) = collect(await connection.output())
    defer {
      reader.cancel()
      byteReader.cancel()
    }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    // Same reason as in `takeOverReattaches`: the drop has to interrupt an
    // attach that carried something, or `.attached` is the correct report.
    server.sendBytes(Data([0x68, 0x69]))
    #expect(try await eventually { bytes.all() == [Data([0x68, 0x69])] })
    server.dropCurrentConnection()

    #expect(try await eventually { server.connectionCount() >= 2 })
    #expect(try await eventually { lifecycle.all().contains(.detached) })
    #expect(try await eventually { lifecycle.all().contains(.reattached) })
    await connection.stop()
  }

  @Test("eight refused upgrades in a row report .unreachable and stop retrying")
  func fastFailsGiveUp() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    server.setRejectUpgrades(true)
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually(timeout: .seconds(10)) {
      lifecycle.all().contains(.closed(.unreachable))
    })
    let attempts = server.connectionCount()
    #expect(attempts == PTYConnection.maxFastFails)
    // And it really stopped: no further attach after the verdict.
    #expect(try await eventually(timeout: .milliseconds(400)) {
      server.connectionCount() > attempts
    } == false)
    await connection.stop()
  }

  @Test("stop() reports .closed(.stopped) and opens nothing more")
  func stopIsTerminal() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.stop()

    #expect(try await eventually { lifecycle.all().contains(.closed(.stopped)) })
    #expect(
      try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)
  }

  @Test("stop() after a parked close still ends the streams")
  func stopAfterParkedCloseEndsStreams() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, ended, reader) = collectUntilEnd(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    // Same reason as in `lifecycleFansOutToEveryConsumer`: the close below has
    // to land after the attach is confirmed, not racing it.
    #expect(try await eventually { lifecycle.all() == [.attached] })
    server.close(code: 4001)
    #expect(try await eventually { lifecycle.all().contains(.closed(.gone)) })

    // `stopped` is already true, so this adds no event — but the streams the
    // close policy deliberately left open (so `takeOver()` can reclaim a
    // superseded terminal) still have to end when the caller says it is done.
    await connection.stop()
    #expect(try await eventually { ended.all() == [true] })
    #expect(lifecycle.all() == [.attached, .closed(.gone)])
  }

  @Test(
    "a parked connection ignores start(): only takeOver() reclaims the terminal",
    arguments: [UInt16(4000), UInt16(4001)])
  func startDoesNotReviveAParkedConnection(code: UInt16) async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: code)
    #expect(try await eventually { lifecycle.all().contains { $0 != .attached } })

    // The hazard this pins: a view whose `.task`/`onAppear` runs again calls
    // `start()`, and a `start()` that re-attached here would restart the
    // takeover war the park exists to end.
    await connection.start()
    #expect(
      try await eventually(timeout: .milliseconds(400)) { server.connectionCount() > 1 } == false)

    // Only the explicit operator gesture reclaims it.
    await connection.takeOver()
    #expect(try await eventually { server.connectionCount() == 2 })
    await connection.stop()
  }

  @Test("input held across a park is dropped, not completed into the next attach")
  func parkDropsHeldInput() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    // The lead byte of "ä" with its continuation byte still to come: `send`
    // holds it back rather than putting a replacement character on the wire.
    await connection.send(Data(Array("ä".utf8).prefix(1)))
    server.close(code: 4000)
    #expect(try await eventuallyAsync { await connection.lastCloseCode == 4000 })

    await connection.takeOver()
    #expect(try await eventually { server.connectionCount() == 2 })
    await connection.send(Data("x".utf8))
    #expect(try await eventually { server.receivedTexts().contains("x") })
    // The half character belonged to the session that was taken away; joining
    // it to the first keystroke of the new attach would type a stray character
    // into somebody's shell.
    #expect(!server.receivedTexts().contains { $0.contains("\u{FFFD}") })
    await connection.stop()
  }

  @Test("stop() on a parked connection drops the held input too")
  func parkedStopDropsHeldInput() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    await connection.send(Data(Array("ä".utf8).prefix(1)))
    #expect(await connection.pendingInput.isEmpty == false)
    server.close(code: 4000)
    #expect(try await eventuallyAsync { await connection.lastCloseCode == 4000 })

    // `stop()` takes the parked branch — no socket left to close — and still
    // has to drop what the dead session never finished.
    await connection.stop()
    #expect(await connection.pendingInput.isEmpty)
  }

  @Test("a superseded pump's close code cannot clobber the live socket's verdict")
  func staleCloseCodeIsIgnored() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    server.close(code: 4000)
    #expect(try await eventuallyAsync { await connection.lastCloseCode == 4000 })

    // What a pump left running by `takeOver()`/`stop()` reports: the 1001 its
    // socket was cancelled with, from a generation that no longer owns the
    // lifecycle. It must not overwrite the verdict of the socket that does.
    await connection.recordCloseCode(1001, generation: 0)
    #expect(await connection.lastCloseCode == 4000)
  }

  @Test("fast failures retry flat, so .unreachable arrives without a backoff ladder")
  func unreachableArrivesPromptly() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    server.setRejectUpgrades(true)
    // 8 fast failures at a flat 200 ms is ~1.6 s. A doubling ladder would need
    // 200 ms · (2⁸ − 1) ≈ 25 s to reach the same verdict; the web client
    // (`ui/src/lib/pty.ts`) retries flat at 1 s and gives up in ~8 s, and a
    // native client that sulked for a minute and a half would look hung.
    let connection = makeConnection(server, reconnectDelay: .milliseconds(200))
    let (lifecycle, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    let started = ContinuousClock.now
    await connection.start()
    #expect(try await eventually(timeout: .seconds(8)) {
      lifecycle.all().contains(.closed(.unreachable))
    })
    #expect(ContinuousClock.now - started < .seconds(4))
    await connection.stop()
  }

  @Test("a successful attach with nothing to replay still reports .attached")
  func silentAttachStillReportsAttached() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (events, reader) = collect(await connection.lifecycle())
    let (bytes, byteReader) = collect(await connection.output())
    defer {
      reader.cancel()
      byteReader.cancel()
    }

    await connection.start()
    // Not one frame is ever sent. A pane whose scrollback is empty is a
    // healthy pane, so the attach cannot be made to wait for output — the pong
    // is what proves the upgrade went through.
    #expect(try await eventually { events.all() == [.attached] })
    #expect(bytes.all().isEmpty)
    await connection.stop()
  }

  @Test("a retry whose upgrade is refused reports .detached and never .reattached")
  func refusedRetryNeverReportsReattached() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (events, reader) = collect(await connection.lifecycle())
    defer { reader.cancel() }

    await connection.start()
    #expect(try await eventually { events.all() == [.attached] })

    // herdr restarts under a live terminal: the socket dies and every attach
    // after it is refused. A `.reattached` here would clear the emulator for a
    // scrollback replay that is never coming and flip the view to "live" over a
    // socket that never opened — and then do it again on every retry.
    server.setRejectUpgrades(true)
    server.dropCurrentConnection()

    #expect(try await eventually { events.all().contains(.detached) })
    #expect(try await eventually { server.connectionCount() >= 3 })
    #expect(!events.all().contains(.reattached))
    await connection.stop()
  }

  @Test("a reattach's .reattached is released by the replay it tells the view to clear for")
  func reattachIsReleasedByItsReplay() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (events, reader) = collect(await connection.lifecycle())
    let (bytes, byteReader) = collect(await connection.output())
    defer {
      reader.cancel()
      byteReader.cancel()
    }

    await connection.start()
    #expect(try await eventually { events.all() == [.attached] })
    server.dropCurrentConnection()
    #expect(try await eventually { server.connectionCount() == 2 })
    server.sendBytes(Data([0x68, 0x69]))

    #expect(try await eventually { bytes.all() == [Data([0x68, 0x69])] })
    // Nothing is still held back by the time the replay is visible: the flush
    // runs in the same actor turn as the delivery and ahead of it, so the
    // clear is ordered before the scrollback it clears for, never after.
    #expect(await connection.pendingAttach == nil)
    #expect(try await eventually { events.all() == [.attached, .detached, .reattached] })
    await connection.stop()
  }

  /// One distinguishable chunk per index, so a dropped one is visible as a gap
  /// rather than as a shorter array of identical bytes.
  private static func burstChunk(_ index: Int) -> Data { Data("\(index);".utf8) }

  @Test("an output() consumer that stalls through a burst still gets every chunk, oldest first")
  func outputTapNeverDropsTheOldestChunks() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    // `stalled` is taken now and deliberately not drained until the burst is
    // over — a main-actor stall is exactly the condition this models. `live` is
    // drained throughout and is only here to tell the test when the whole burst
    // has been yielded to every tap, so the assertion below is not racing the
    // socket.
    let stalled = await connection.output()
    let (live, liveReader) = collect(await connection.output())
    defer { liveReader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })
    // Past `.bufferingNewest(4096)`: under the old policy the stalled tap would
    // be holding only the newest 4096 of these by now.
    let count = 5000
    for index in 0..<count { server.sendBytes(Self.burstChunk(index)) }
    #expect(try await eventually(timeout: .seconds(30)) { live.all().count == count })

    // The kit's tap is the bottleneck the app-side relay sits *downstream* of,
    // so an `.unbounded` relay cannot make up for a bounded tap: the oldest
    // chunks would already be gone, and a chunk lost mid-escape-sequence
    // corrupts the emulator rather than costing a repaint.
    let (buffered, bufferedReader) = collect(stalled)
    defer { bufferedReader.cancel() }
    #expect(try await eventually(timeout: .seconds(10)) { buffered.all().count == count })
    #expect(buffered.all() == (0..<count).map(Self.burstChunk))
    await connection.stop()
  }

  @Test("a frame from a superseded pump is not injected into the live socket's output")
  func staleFrameIsDropped() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (bytes, byteReader) = collect(await connection.output())
    defer { byteReader.cancel() }

    await connection.start()
    #expect(try await eventually { server.connectionCount() == 1 })

    // What a pump left running by `takeOver()`/`stop()` replays: a receive
    // completion queued for a socket this connection has moved on from. `nil`
    // stands in for that dead socket — whatever it was, it is not the live
    // `task` — and generation 0 never owned one either. Delivering it would
    // wedge the emulator with bytes from the wrong attach, in between the live
    // socket's scrollback frames.
    #expect(await connection.deliverIfCurrent(Data([0x66]), from: nil, generation: 0) == false)
    server.sendBytes(Data([0x68]))
    #expect(try await eventually { bytes.all() == [Data([0x68])] })
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
