import Foundation

/// One attached terminal: the `/pty/{id}` WebSocket.
///
/// Shaped like `EventStream` — bearer on the upgrade, an `AsyncStream` of
/// output, a `lifecycle()` stream, capped exponential backoff — but with the
/// PTY's own single-owner policy: a 4000 (superseded) or 4001 (gone) close is
/// terminal and must never be retried. Reconnecting after a 4000 restarts the
/// takeover war with the device that just took the terminal.
public actor PTYConnection {
  /// Why the connection stopped for good.
  public enum Closure: Sendable, Equatable {
    /// 4000: another client owns this terminal now. `takeOver()` reclaims it.
    case superseded
    /// 4001: the session has no live agent. Nothing to reattach to.
    case gone
    /// Too many attaches died instantly — herdr is down, not busy. Mirrors the
    /// fast-fail heuristic in `ui/src/lib/pty.ts`.
    case unreachable
    /// `stop()` was called.
    case stopped
  }

  /// `.reattached` is distinct from `.attached` because the server replays the
  /// scrollback on every attach: the view must clear its buffer first.
  public enum LifecycleEvent: Sendable, Equatable {
    case attached
    case reattached
    case detached
    case closed(Closure)
  }

  /// Contract `x-shepherd-pty.closeCodes` / `.resizePrefix`.
  static let supersededCode = 4000
  static let goneCode = 4001
  static let resizePrefix = "\u{0}resize:"
  /// A socket that died within this long of opening never carried a session.
  static let fastFailWindow: Duration = .seconds(4)
  /// Consecutive fast failures that mean herdr itself is gone (`MAX_FAST_FAILS`).
  static let maxFastFails = 8

  private let baseURL: URL
  private let sessionID: String
  private let tokenProvider: @Sendable () -> String?
  private let urlSession: URLSession
  private let reconnectDelay: Duration
  private let maxReconnectDelay: Duration

  private let outputContinuation: AsyncStream<Data>.Continuation
  private let lifecycleContinuation: AsyncStream<LifecycleEvent>.Continuation
  private nonisolated let outputStream: AsyncStream<Data>
  private nonisolated let lifecycleStream: AsyncStream<LifecycleEvent>

  private var task: URLSessionWebSocketTask?
  private var pump: Task<Void, Never>?
  private var stopped = true
  private var everAttached = false
  private var cols: Int
  private var rows: Int

  /// Bumped by every `connect()`. `handleClose` captures it before its backoff
  /// sleep and compares after: `task == nil` alone cannot tell this backoff
  /// window from a later one that also opened and lost a socket. Same guard
  /// `EventStream.scheduleReconnect` uses, for the same reason.
  private var connectionGeneration = 0
  private var currentReconnectDelay: Duration
  private var connectedAt: ContinuousClock.Instant?
  private var consecutiveFastFails = 0

  public init(
    baseURL: URL,
    sessionID: String,
    tokenProvider: @escaping @Sendable () -> String?,
    urlSession: URLSession = .shared,
    cols: Int = 100,
    rows: Int = 30,
    reconnectDelay: Duration = .seconds(1),
    maxReconnectDelay: Duration = .seconds(30)
  ) {
    self.baseURL = baseURL
    self.sessionID = sessionID
    self.tokenProvider = tokenProvider
    self.urlSession = urlSession
    self.cols = cols
    self.rows = rows
    self.reconnectDelay = reconnectDelay
    self.maxReconnectDelay = maxReconnectDelay
    self.currentReconnectDelay = reconnectDelay
    // Terminal output is bursty; 4096 chunks is far above what one repaint
    // produces between reads by the view.
    let (output, outputContinuation) = AsyncStream<Data>.makeStream(
      bufferingPolicy: .bufferingNewest(4096))
    outputStream = output
    self.outputContinuation = outputContinuation
    let (lifecycle, lifecycleContinuation) = AsyncStream<LifecycleEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(16))
    lifecycleStream = lifecycle
    self.lifecycleContinuation = lifecycleContinuation
  }

  /// Derive the URL and the token from a live client.
  public init(
    client: ShepherdClient, sessionID: String, cols: Int = 100, rows: Int = 30,
    urlSession: URLSession = .shared
  ) {
    self.init(
      baseURL: client.profile.baseURL, sessionID: sessionID,
      tokenProvider: { client.currentToken() }, urlSession: urlSession, cols: cols, rows: rows)
  }

  /// `http(s)://host/prefix` → `ws(s)://host/prefix/pty/<id>?cols=&rows=`,
  /// preserving a reverse-proxy path prefix and percent-encoding the id.
  /// Never force-unwraps: a baseURL `URLComponents` will not round-trip falls
  /// back to string surgery rather than trapping.
  public static func ptyURL(for baseURL: URL, sessionID: String, cols: Int, rows: Int) -> URL {
    let encoded =
      sessionID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? sessionID
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      return fallbackURL(baseURL: baseURL, encodedID: encoded, cols: cols, rows: rows)
    }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.fragment = nil
    let path = components.path
    let prefix = path.hasSuffix("/") ? String(path.dropLast()) : path
    // percentEncodedPath, not path: `path` would re-encode the `%` of an
    // already-encoded id into `%25`.
    components.percentEncodedPath = prefix + "/pty/" + encoded
    components.queryItems = [
      URLQueryItem(name: "cols", value: String(cols)),
      URLQueryItem(name: "rows", value: String(rows)),
    ]
    guard let url = components.url else {
      return fallbackURL(baseURL: baseURL, encodedID: encoded, cols: cols, rows: rows)
    }
    return url
  }

  private static func fallbackURL(baseURL: URL, encodedID: String, cols: Int, rows: Int) -> URL {
    let appended = baseURL.appendingPathComponent("pty").appendingPathComponent(encodedID)
    var absolute = appended.absoluteString + "?cols=\(cols)&rows=\(rows)"
    if absolute.hasPrefix("https://") {
      absolute = "wss://" + absolute.dropFirst("https://".count)
    } else if absolute.hasPrefix("http://") {
      absolute = "ws://" + absolute.dropFirst("http://".count)
    }
    return URL(string: absolute) ?? appended
  }

  /// Output bytes, oldest first. Single-consumer, like `EventStream.events()`:
  /// two iterators would split the elements, not each get a copy.
  public nonisolated func output() -> AsyncStream<Data> { outputStream }
  /// Socket lifecycle, oldest first. Single-consumer for the same reason.
  public nonisolated func lifecycle() -> AsyncStream<LifecycleEvent> { lifecycleStream }
  /// The size the next attach will use.
  public func currentSize() -> PTYSize { PTYSize(cols: cols, rows: rows) }

  /// Opens the socket and keeps it open. Idempotent.
  public func start() {
    guard stopped else { return }
    stopped = false
    currentReconnectDelay = reconnectDelay
    consecutiveFastFails = 0
    connect()
  }

  /// Closes the socket and stops retrying. Does **not** finish `output()` —
  /// `start()`/`takeOver()` can reopen it — so a consumer that no longer wants
  /// bytes must cancel its own task.
  public func stop() {
    guard !stopped else { return }
    stopped = true
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    lifecycleContinuation.yield(.closed(.stopped))
  }

  /// Re-attach after a `.superseded` (or any terminal state the operator wants
  /// to override): makes this client the owner again and resets the backoff.
  public func takeOver() {
    stopped = false
    currentReconnectDelay = reconnectDelay
    consecutiveFastFails = 0
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    connect()
  }

  /// Keystrokes, verbatim. Dropped when there is no live socket: a terminal has
  /// no sensible queue semantics for input typed while detached.
  public func send(_ bytes: Data) {
    task?.send(.string(String(decoding: bytes, as: UTF8.self))) { _ in }
  }

  /// Remember the size (so a reconnect attaches at it) and, if a socket is
  /// live, write the control frame the bridge's demuxer parses.
  public func resize(cols: Int, rows: Int) {
    guard cols > 0, rows > 0 else { return }
    self.cols = cols
    self.rows = rows
    task?.send(.string("\(Self.resizePrefix)\(cols):\(rows)\n")) { _ in }
  }

  private func connect() {
    var request = URLRequest(
      url: Self.ptyURL(for: baseURL, sessionID: sessionID, cols: cols, rows: rows))
    // Read the token afresh: a rotated token has to reach the next upgrade.
    if let token = tokenProvider() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let socket = urlSession.webSocketTask(with: request)
    task = socket
    connectionGeneration += 1
    connectedAt = .now
    socket.resume()
    lifecycleContinuation.yield(everAttached ? .reattached : .attached)
    everAttached = true
    pump = Task { [weak self] in await self?.receiveLoop(socket) }
  }

  private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        switch try await socket.receive() {
        case .string(let text): outputContinuation.yield(Data(text.utf8))
        case .data(let data): outputContinuation.yield(data)
        @unknown default: break
        }
      } catch {
        break  // any receive failure means the socket is gone
      }
    }
    await handleClose(of: socket)
  }

  deinit {
    outputContinuation.finish()
    lifecycleContinuation.finish()
  }
}

/// The attach dimensions of a `PTYConnection`.
public struct PTYSize: Equatable, Sendable {
  public let cols: Int
  public let rows: Int
  public init(cols: Int, rows: Int) {
    self.cols = cols
    self.rows = rows
  }
}

extension PTYConnection {
  /// TEMPORARY (Task 2 only). Task 3 replaces this with the real close policy.
  private func handleClose(of socket: URLSessionWebSocketTask) async {
    guard !stopped, task === socket else { return }
    task = nil
    lifecycleContinuation.yield(.detached)
  }
}
