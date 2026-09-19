import Foundation

/// One attached terminal: the `/pty/{id}` WebSocket.
///
/// Shaped like `EventStream` — bearer on the upgrade, an `AsyncStream` of
/// output, a `lifecycle()` stream, capped exponential backoff — except that
/// both streams are per-call broadcasts (a terminal has more than one reader)
/// rather than the single-consumer streams `EventStream` hands its store. The
/// difference that matters is the PTY's own single-owner policy: a 4000
/// (superseded) or 4001 (gone) close is terminal and must never be retried.
/// Reconnecting after a 4000 restarts the takeover war with the device that
/// just took the terminal.
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

  /// One continuation per live `output()` / `lifecycle()` stream. Dictionaries,
  /// not a single shared continuation, because a shared `AsyncStream` splits
  /// its elements between iterators instead of broadcasting — see `output()`.
  private var outputTaps: [UUID: AsyncStream<Data>.Continuation] = [:]
  private var lifecycleTaps: [UUID: AsyncStream<LifecycleEvent>.Continuation] = [:]
  /// A trailing UTF-8 sequence `send(_:)` is holding until the caller finishes
  /// it. At most 3 bytes. See `send(_:)`.
  private var pendingInput = Data()

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
  /// The raw WebSocket close code of the socket that closed most recently, or
  /// `0` when it died without a close frame (a dropped TCP connection). Read
  /// inside URLSession's completion callback, before anything can hop back onto
  /// this actor — see `nextFrame(on:)`.
  private(set) var lastCloseCode = 0
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

  /// RFC 3986 unreserved characters: what a path segment may carry literally.
  ///
  /// Narrower than `.urlPathAllowed` (which passes `/` and the sub-delims) and
  /// wider than `.alphanumerics`, and the difference is load-bearing:
  /// herdr matches `/^\/pty\/([^/]+)$/` and uses the captured segment **raw**,
  /// with no decoding (`src/server.ts`), exactly as the web client sends it
  /// (`ui/src/lib/pty.ts`). Percent-encoding the `-` of a UUID would make every
  /// real session id a *different* id to the server — a guaranteed 404 — so
  /// `-._~` must pass through, while `/`, `?`, `#` and space must not.
  static let unreservedPathCharacters: CharacterSet = {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return allowed
  }()

  /// `http(s)://host/prefix` → `ws(s)://host/prefix/pty/<id>?cols=&rows=`,
  /// preserving a reverse-proxy path prefix and encoding only what a path
  /// segment may not carry literally (see `unreservedPathCharacters`).
  /// Never force-unwraps: a baseURL `URLComponents` will not round-trip falls
  /// back to string surgery rather than trapping.
  public static func ptyURL(for baseURL: URL, sessionID: String, cols: Int, rows: Int) -> URL {
    let encoded =
      sessionID.addingPercentEncoding(withAllowedCharacters: unreservedPathCharacters) ?? sessionID
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

  /// Output bytes, oldest first — **one independent stream per call**.
  ///
  /// Several consumers (the terminal view, a recorder, a test) each see every
  /// chunk. A single shared `AsyncStream` would hand each chunk to whichever
  /// iterator asked first, and for a terminal that is not a slow view but a
  /// corrupted one: half the escape sequences would go to the other reader.
  ///
  /// Buffered `.bufferingNewest(4096)` per stream — terminal output is bursty,
  /// and a consumer that stalls drops its own oldest chunks rather than holding
  /// the socket's reader back for everybody. A consumer that stops iterating
  /// (cancels its task, drops the iterator) removes its own tap; `stop()`
  /// finishes every stream it handed out, so a `for await` over one ends
  /// instead of hanging. A stream taken while the connection is stopped stays
  /// open and starts delivering at the next `start()`/`takeOver()`.
  public func output() -> AsyncStream<Data> {
    let (stream, continuation) = AsyncStream<Data>.makeStream(
      bufferingPolicy: .bufferingNewest(4096))
    let id = UUID()
    // Runs on whatever executor ended the stream, so it hops back onto the
    // actor before touching the registry.
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeOutputTap(id) }
    }
    outputTaps[id] = continuation
    return stream
  }

  /// Socket lifecycle, oldest first — one independent stream per call, for the
  /// same reason `output()` is: a view and a status indicator both need to see
  /// `.reattached`, not one each. Buffered `.bufferingNewest(16)`; finished by
  /// `stop()`.
  public func lifecycle() -> AsyncStream<LifecycleEvent> {
    let (stream, continuation) = AsyncStream<LifecycleEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(16))
    let id = UUID()
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeLifecycleTap(id) }
    }
    lifecycleTaps[id] = continuation
    return stream
  }

  private func removeOutputTap(_ id: UUID) { outputTaps[id] = nil }
  private func removeLifecycleTap(_ id: UUID) { lifecycleTaps[id] = nil }

  /// Fans one lifecycle event out to every `lifecycle()` stream.
  private func deliver(lifecycle event: LifecycleEvent) {
    for tap in lifecycleTaps.values { tap.yield(event) }
  }

  /// Ends every stream this connection handed out. Called by `stop()`: the
  /// buffered events (the closing `.closed(.stopped)` included) still drain
  /// before each `for await` ends.
  private func finishTaps() {
    for tap in outputTaps.values { tap.finish() }
    for tap in lifecycleTaps.values { tap.finish() }
    outputTaps.removeAll()
    lifecycleTaps.removeAll()
  }

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

  /// Closes the socket, stops retrying, and finishes every `output()` and
  /// `lifecycle()` stream handed out so far — a consumer's `for await` ends on
  /// its own rather than hanging on a terminal nobody will feed again. A caller
  /// that reopens with `start()`/`takeOver()` takes fresh streams.
  public func stop() {
    guard !stopped else {
      // Already parked: `handleClose` reported `.closed(.superseded)`,
      // `.closed(.gone)` or `.closed(.unreachable)` and left the streams open on
      // purpose, so `takeOver()` can reclaim the terminal on the same
      // connection. There is no socket left to close and no `.closed(.stopped)`
      // to stack on top of the verdict already delivered — but a caller saying
      // `stop()` is done with this connection, so its `for await` loops still
      // have to end.
      finishTaps()
      return
    }
    stopped = true
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    // Held input belongs to the session that just ended; completing it into the
    // next one would inject a stray character.
    pendingInput = Data()
    deliver(lifecycle: .closed(.stopped))
    finishTaps()
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
  ///
  /// The bridge demuxes a single stdin **string** stream, so input goes out as
  /// a text frame and therefore has to be valid UTF-8. A caller that feeds this
  /// raw bytes — a keyboard pipe, a paste chunked by whatever read it — can
  /// split a multi-byte character across two calls, and decoding each half on
  /// its own would put two U+FFFD replacement characters on the wire instead of
  /// the character. So an incomplete trailing sequence (never more than 3
  /// bytes) is held back and prepended to the next call; `stop()` drops it.
  /// Nothing else is buffered: complete bytes always go out on the same call.
  public func send(_ bytes: Data) {
    var outgoing = pendingInput + bytes
    pendingInput = Data()
    let held = Self.incompleteTrailingUTF8Count(of: outgoing)
    if held > 0 {
      pendingInput = Data(outgoing.suffix(held))
      outgoing = Data(outgoing.prefix(outgoing.count - held))
    }
    guard !outgoing.isEmpty else { return }
    task?.send(.string(String(decoding: outgoing, as: UTF8.self))) { _ in }
  }

  /// How many bytes at the end of `buffer` open a multi-byte UTF-8 sequence the
  /// caller has not finished yet (0–3).
  ///
  /// Only a *valid* unfinished sequence is held: a byte that can never lead one
  /// is passed through, because nothing will ever complete it and holding it
  /// would stall every keystroke behind it.
  static func incompleteTrailingUTF8Count(of buffer: Data) -> Int {
    let bytes = [UInt8](buffer)
    var trailing = 0
    while trailing < 3, trailing < bytes.count {
      let byte = bytes[bytes.count - 1 - trailing]
      if byte & 0b1100_0000 == 0b1000_0000 {  // continuation byte: keep walking
        trailing += 1
        continue
      }
      let expected: Int
      switch byte {
      case 0x00...0x7f: return 0  // ASCII lead: the tail is already complete
      case 0xc2...0xdf: expected = 2
      case 0xe0...0xef: expected = 3
      case 0xf0...0xf4: expected = 4
      default: return 0  // 0xc0/0xc1/0xf5…: never a valid lead
      }
      let have = trailing + 1
      return have < expected ? have : 0
    }
    return 0  // three continuation bytes with no lead in reach: not ours to fix
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
    // Yielded before the upgrade is confirmed, like
    // `EventStream.LifecycleEvent.connected`: a refused upgrade shows up as the
    // `.detached` right after. `everAttached` deliberately does *not* flip
    // here — see `deliver(output:)`.
    deliver(lifecycle: everAttached ? .reattached : .attached)
    pump = Task { [weak self] in await self?.receiveLoop(socket) }
  }

  /// One received frame, or the close that ended the socket.
  ///
  /// `URLSessionWebSocketTask.Message` is not `Sendable` and the close code has
  /// to cross the same boundary, so the callback maps both into this.
  private enum Frame: Sendable {
    case text(String)
    case binary(Data)
    case closed(code: Int)
  }

  /// `receive()` plus the close code, read **inside URLSession's own completion
  /// callback**: the earliest moment the code is final and the last one nothing
  /// else has had a chance to touch.
  ///
  /// The `async` form of `receive()` resumes its caller back on this actor, and
  /// `receiveLoop` is actor-isolated, so the gap between "the socket failed"
  /// and "we look at why" is however long the actor stays busy — a `stop()` or
  /// `takeOver()` queued ahead of the resumption runs in it, cancels the task
  /// with `.goingAway` and replaces `task`. Capturing here turns the close code
  /// into a *value* that travels to `handleClose(of:closeCode:)`, so Task 3's
  /// policy cannot accidentally read it back off actor state that has moved on.
  /// (Darwin keeps a close code that was already delivered even across a later
  /// `cancel(with:)` — measured, not assumed — so this is the belt to that
  /// brace, not a workaround for it.)
  private nonisolated func nextFrame(on socket: URLSessionWebSocketTask) async -> Frame {
    await withCheckedContinuation { continuation in
      socket.receive { result in
        switch result {
        case .success(.string(let text)): continuation.resume(returning: .text(text))
        case .success(.data(let data)): continuation.resume(returning: .binary(data))
        // An unknown message kind cannot be replayed to the view, and any
        // failure means the socket is gone: both end the loop.
        case .success, .failure:
          continuation.resume(returning: .closed(code: socket.closeCode.rawValue))
        }
      }
    }
  }

  private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
    var closeCode = 0
    receiving: while !Task.isCancelled {
      switch await nextFrame(on: socket) {
      case .text(let text): deliver(output: Data(text.utf8))
      case .binary(let data): deliver(output: data)
      case .closed(let code):
        closeCode = code
        break receiving
      }
    }
    await handleClose(of: socket, closeCode: closeCode)
  }

  /// Fans one chunk of terminal output out to every `output()` stream, and
  /// records that this socket really carried a session.
  ///
  /// The first frame is what flips `everAttached`, not `connect()`: the server
  /// replays the scrollback on every *successful* attach, so `.reattached`
  /// (which tells the view to clear its buffer first) must only follow an
  /// attach that actually delivered something. An attach whose upgrade was
  /// refused carried no scrollback, and reporting `.reattached` after it would
  /// make the view clear a buffer the server is not going to refill.
  private func deliver(output bytes: Data) {
    everAttached = true
    for tap in outputTaps.values { tap.yield(bytes) }
  }

  /// What a dead socket means, and what happens next.
  ///
  /// The whole single-owner policy lives here: 4000 parks, 4001 ends, anything
  /// else is a transient drop that reconnects with capped exponential backoff
  /// until `maxFastFails` attaches in a row have died instantly. Mirrors
  /// `ui/src/lib/pty.ts` (`parked`, `stopped`, `FAST_FAIL_MS`/`MAX_FAST_FAILS`)
  /// so both clients behave the same against the same herdr.
  ///
  /// - Parameter closeCode: the raw WebSocket close code this socket carried,
  ///   captured inside URLSession's completion callback before any hop back
  ///   onto this actor (`nextFrame(on:)`), or `0` when it died with no close
  ///   frame at all — a dropped network or a refused upgrade, both transient as
  ///   far as policy is concerned. The policy switches on this *parameter*,
  ///   never on `socket.closeCode` or on `task`: by the time this runs, a
  ///   racing `stop()`/`takeOver()` may have cancelled that task with
  ///   `.goingAway` (1001) and pointed `task` at a new socket or at `nil`.
  ///   `URLSessionWebSocketTask.CloseCode` has no case for 4000 or 4001, so the
  ///   comparison is on raw values, never on enum cases.
  private func handleClose(of socket: URLSessionWebSocketTask, closeCode: Int) async {
    // Before the guard: a `stop()` that won the race still wants the code
    // recorded for the socket it actually belonged to.
    lastCloseCode = closeCode
    // A pump left running after `stop()`/`takeOver()` already replaced this
    // socket must not report anything: the replacement owns the lifecycle now.
    guard !stopped, task === socket else { return }
    // Captured before the backoff sleep below, so the guard after it can tell
    // this backoff window from a later one — same reason
    // `EventStream.scheduleReconnect` captures it.
    let capturedGeneration = connectionGeneration
    task = nil

    // The two single-owner codes are terminal by contract
    // (`PTY_SUPERSEDED_CODE` / `PTY_GONE_CODE` in `src/server.ts`). Reconnecting
    // after 4000 restarts the takeover war with the device that just won it —
    // it would bump us straight back — and after 4001 it loops on herdr's
    // `agent_not_found`. Both park `stopped` instead of retrying.
    //
    // The streams are deliberately *not* finished here, unlike in `stop()`:
    // `takeOver()` reclaims a superseded terminal on the same connection, and
    // its `.reattached` has to reach the `lifecycle()` stream the view is
    // already reading.
    if closeCode == Self.supersededCode {
      stopped = true
      ShepherdLog.realtime.notice("pty superseded by another client; parked")
      deliver(lifecycle: .closed(.superseded))
      return
    }
    if closeCode == Self.goneCode {
      stopped = true
      deliver(lifecycle: .closed(.gone))
      return
    }

    // A socket that lived past the window carried a real session; anything
    // shorter is an attach against a herdr that is not there. `everAttached` is
    // deliberately not the test: a long-lived but silent terminal is healthy.
    let lived = connectedAt.map { ContinuousClock.now - $0 } ?? .zero
    if lived >= Self.fastFailWindow {
      consecutiveFastFails = 0
      currentReconnectDelay = reconnectDelay
    } else {
      consecutiveFastFails += 1
    }
    if consecutiveFastFails >= Self.maxFastFails {
      stopped = true
      // The one failure nothing else surfaces — the connection would otherwise
      // retry quietly forever. Never the token, never the URL.
      ShepherdLog.realtime.notice(
        "pty gave up after \(Self.maxFastFails, privacy: .public) immediate failures")
      deliver(lifecycle: .closed(.unreachable))
      return
    }

    // Said before the sleep, so a view can repaint "reconnecting" immediately
    // rather than after the delay.
    deliver(lifecycle: .detached)
    let delay = currentReconnectDelay
    currentReconnectDelay = min(currentReconnectDelay * 2, maxReconnectDelay)
    do {
      try await Task.sleep(for: delay)
    } catch {
      return  // cancelled while waiting: `stop()`/`takeOver()` cancelled `pump`
    }
    // `task == nil` plus the generation check is the same guard
    // `EventStream.scheduleReconnect` uses: `task == nil` alone cannot tell this
    // backoff window from a later one that also opened and lost a socket while
    // this continuation was queued.
    guard !stopped, task == nil, connectionGeneration == capturedGeneration else { return }
    connect()
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
