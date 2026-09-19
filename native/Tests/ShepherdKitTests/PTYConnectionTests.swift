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

  @Test("connecting sends the bearer on the upgrade and reports .attached")
  func attaches() async throws {
    let server = try FakePTYServer()
    defer { server.stop() }
    let connection = makeConnection(server)
    let (lifecycle, reader) = collect(connection.lifecycle())
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
    let (bytes, reader) = collect(connection.output())
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
}
