import Foundation
import Network

/// An in-process WebSocket server for `/pty/{id}`.
///
/// `URLProtocol` cannot fake a WebSocket — it has no way to emit a 101
/// Switching Protocols — so this is a real `NWListener` on an ephemeral
/// loopback port speaking `NWProtocolWebSocket`.
///
/// `@unchecked Sendable`: `NWListener` and `NWConnection` are not `Sendable`,
/// but every handler Network.framework calls runs on this object's own serial
/// `queue`, and every piece of mutable state lives behind `State`'s lock.
final class FakePTYServer: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "run.shepherd.kit.tests.pty")
  private let state = State()

  /// `http://127.0.0.1:<port>` — callers hand this to
  /// `PTYConnection.ptyURL(for:…)`, which appends `/pty/<id>` and swaps the
  /// scheme. Replaces FakeEventServer's `url` (which hard-coded `/events`).
  let baseURL: URL

  init() throws {
    let parameters = NWParameters.tcp
    let options = NWProtocolWebSocket.Options(.version13)
    options.autoReplyPing = true
    let state = self.state
    // The upgrade request's non-mechanical headers (including Authorization)
    // are handed to this callback — that is how the bearer assertion works.
    options.setClientRequestHandler(queue) { _, headers in
      state.recordUpgrade(headers)
      if state.shouldRejectUpgrades() {
        return NWProtocolWebSocket.Response(status: .reject, subprotocol: nil)
      }
      return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
    }
    parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
    // Bind loopback only: the suite must never listen on a routable address,
    // and this also keeps macOS from asking for a firewall exception.
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)

    listener = try NWListener(using: parameters)

    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    listener.newConnectionHandler = { [state, queue] connection in
      state.adopt(connection)
      // A rejected upgrade still lets the raw `NWConnection` reach `.ready`
      // — Network.framework's WebSocket layer only refuses the protocol
      // handshake, it does not tear down the connection on our behalf — and
      // `URLSessionWebSocketTask` never learns the upgrade failed until the
      // connection actually closes. So a reject that the caller does not
      // follow with a close would leave the client hanging in `receive()`
      // forever instead of failing over to the next reconnect attempt.
      // Cancelling here, right after `.ready`, if this connection was
      // rejected is what turns "the handshake was refused" into "the socket
      // closed", which is the only failure `URLSessionWebSocketTask`
      // surfaces.
      connection.stateUpdateHandler = { [weak connection] connectionState in
        guard case .ready = connectionState, state.shouldRejectUpgrades() else { return }
        connection?.cancel()
      }
      connection.start(queue: queue)
      FakePTYServer.receiveLoop(connection, state: state)
    }
    listener.start(queue: queue)
    guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port else {
      listener.cancel()
      throw FakePTYServerError.didNotBind
    }
    baseURL = URL(string: "http://127.0.0.1:\(port.rawValue)")!
  }

  /// Push raw terminal bytes as a binary frame, the way herdr's bridge does.
  /// Replaces FakeEventServer's text-only `send(_ json: String)`.
  func sendBytes(_ data: Data) {
    guard let connection = state.current() else { return }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
    let context = NWConnection.ContentContext(identifier: "out", metadata: [metadata])
    connection.send(
      content: data, contentContext: context, isComplete: true,
      completion: .contentProcessed { _ in })
  }

  /// Close with an APPLICATION code. `.protocolCode` cannot express 4000–4999,
  /// which is exactly the range the PTY's single-owner policy lives in — this
  /// is why the events fake could not simply be reused.
  func close(code: UInt16) {
    guard let connection = state.current() else { return }
    let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
    metadata.closeCode = .applicationCode(code)
    let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
    connection.send(
      content: nil, contentContext: context, isComplete: true,
      completion: .contentProcessed { _ in })
  }

  /// Drop the connection with no close frame — a transient network failure.
  /// Replaces `closeCurrentConnection()`.
  func dropCurrentConnection() { state.current()?.cancel() }

  func receivedTexts() -> [String] { state.texts() }
  func upgradeHeaders() -> [String: String] { state.headers() }

  /// The number of upgrade *attempts* the client-request handler has seen —
  /// incremented on every call to it, whether the response was `.accept` or
  /// `.reject`. Not "successful connections": a run with
  /// `rejectNextUpgrade()`/`setRejectUpgrades(true)` active still bumps this
  /// on each rejected attempt, which is exactly what the backoff test needs
  /// to count.
  func connectionCount() -> Int { state.connections() }

  /// Makes every upgrade from now on fail with `NWProtocolWebSocket.Response
  /// .reject` until called again with `false`. Network.framework's WebSocket
  /// upgrade path only exposes a fixed `.reject` status — there is no way to
  /// plumb a caller-chosen HTTP status code (401, 403, …) through
  /// `setClientRequestHandler`'s return value — so this toggles the
  /// rejection itself rather than which status accompanies it; the client
  /// only ever observes "the upgrade failed", which is what its reconnect
  /// logic reacts to either way.
  func setRejectUpgrades(_ reject: Bool) {
    state.setRejectUpgrades(reject)
  }

  func stop() {
    state.cancelAll()
    listener.cancel()
  }

  private static func receiveLoop(_ connection: NWConnection, state: State) {
    connection.receiveMessage { content, _, _, error in
      if error != nil { return }
      if let content, let text = String(data: content, encoding: .utf8), !text.isEmpty {
        state.recordText(text)
      }
      receiveLoop(connection, state: state)
    }
  }

  /// Every `NWListener`/`NWConnection` handler is `@Sendable` and runs on the
  /// listener's queue, so all shared state goes through this lock box.
  private final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var connectionsList: [NWConnection] = []
    private var receivedTexts: [String] = []
    private var lastHeaders: [String: String] = [:]
    private var upgrades = 0
    private var rejectUpgrades = false

    func adopt(_ connection: NWConnection) {
      lock.lock()
      defer { lock.unlock() }
      connectionsList.append(connection)
    }

    func current() -> NWConnection? {
      lock.lock()
      defer { lock.unlock() }
      return connectionsList.last
    }

    func recordText(_ text: String) {
      lock.lock()
      defer { lock.unlock() }
      receivedTexts.append(text)
    }

    func recordUpgrade(_ headers: [(name: String, value: String)]) {
      lock.lock()
      defer { lock.unlock() }
      upgrades += 1
      lastHeaders = Dictionary(headers.map { ($0.name, $0.value) }, uniquingKeysWith: { _, b in b })
    }

    func texts() -> [String] {
      lock.lock()
      defer { lock.unlock() }
      return receivedTexts
    }

    func headers() -> [String: String] {
      lock.lock()
      defer { lock.unlock() }
      return lastHeaders
    }

    func connections() -> Int {
      lock.lock()
      defer { lock.unlock() }
      return upgrades
    }

    func setRejectUpgrades(_ reject: Bool) {
      lock.lock()
      defer { lock.unlock() }
      rejectUpgrades = reject
    }

    func shouldRejectUpgrades() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return rejectUpgrades
    }

    func cancelAll() {
      lock.lock()
      let all = connectionsList
      connectionsList = []
      lock.unlock()
      for connection in all { connection.cancel() }
    }
  }
}

enum FakePTYServerError: Error, Equatable {
  case didNotBind
}
