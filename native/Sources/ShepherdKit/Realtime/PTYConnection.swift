import Foundation

/// One attached terminal: the `/pty/{id}` WebSocket.
///
/// Shaped like `EventStream` — bearer on the upgrade, an `AsyncStream` of
/// output, a `lifecycle()` stream — except in two ways. Both streams are
/// per-call broadcasts (a terminal has more than one reader) rather than the
/// single-consumer streams `EventStream` hands its store; and the retry is
/// flat rather than exponential, because the PTY's own single-owner policy
/// makes a retry loop the wrong thing to slow down. A 4000 (superseded) or
/// 4001 (gone) close is terminal and must never be retried — reconnecting
/// after a 4000 restarts the takeover war with the device that just took the
/// terminal — and a herdr that is simply gone is caught by the fast-fail
/// counter, not by waiting longer and longer between attaches.
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
  /// The pause between attaches. Flat, not a ladder — see `handleClose`.
  private let reconnectDelay: Duration

  /// One continuation per live `output()` / `lifecycle()` stream. Dictionaries,
  /// not a single shared continuation, because a shared `AsyncStream` splits
  /// its elements between iterators instead of broadcasting — see `output()`.
  private var outputTaps: [UUID: AsyncStream<Data>.Continuation] = [:]
  private var lifecycleTaps: [UUID: AsyncStream<LifecycleEvent>.Continuation] = [:]
  /// A trailing UTF-8 sequence `send(_:)` is holding until the caller finishes
  /// it. At most 3 bytes. See `send(_:)`.
  private(set) var pendingInput = Data()

  private var task: URLSessionWebSocketTask?
  private var pump: Task<Void, Never>?
  private var stopped = true
  /// A terminal verdict was delivered (`.superseded`, `.gone`, `.unreachable`)
  /// and only an explicit `takeOver()` may reopen the socket. Separate from
  /// `stopped` for the reason `ui/src/lib/pty.ts` keeps `parked` separate: a
  /// view whose `.task`/`onAppear` runs again calls `start()`, and a `start()`
  /// that re-attached here would restart the takeover war the park just ended.
  private var parked = false
  private var everAttached = false
  /// The attach event `connect()` produced and has deliberately **not**
  /// delivered yet: see `flushPendingAttach`. Internal rather than private only
  /// so a test can assert that a delivered frame released it.
  private(set) var pendingAttach: LifecycleEvent?
  private var cols: Int
  private var rows: Int

  /// Bumped by every `connect()`. `handleClose` captures it before its backoff
  /// sleep and compares after: `task == nil` alone cannot tell this backoff
  /// window from a later one that also opened and lost a socket. Same guard
  /// `EventStream.scheduleReconnect` uses, for the same reason.
  private var connectionGeneration = 0
  /// The raw WebSocket close code the current generation's socket closed with,
  /// or `0` when it died without a close frame (a dropped TCP connection). Read
  /// inside URLSession's completion callback, before anything can hop back onto
  /// this actor (see `nextFrame(on:)`), and written only by
  /// `recordCloseCode(_:generation:)`.
  private(set) var lastCloseCode = 0
  /// Internal test seam: suspend after capture but before actor-side close handling.
  /// Production leaves this nil; tests can order stop() without blocking an executor.
  var beforeHandlingClose: (@Sendable () async -> Void)?
  private var connectedAt: ContinuousClock.Instant?
  private var consecutiveFastFails = 0

  public init(
    baseURL: URL,
    sessionID: String,
    tokenProvider: @escaping @Sendable () -> String?,
    urlSession: URLSession = .shared,
    cols: Int = 100,
    rows: Int = 30,
    reconnectDelay: Duration = .seconds(1)
  ) {
    self.baseURL = baseURL
    self.sessionID = sessionID
    self.tokenProvider = tokenProvider
    self.urlSession = urlSession
    self.cols = cols
    self.rows = rows
    self.reconnectDelay = reconnectDelay
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
  /// Buffered `.unbounded` per stream, **not** `.bufferingNewest`: a dropped
  /// chunk does not cost a repaint, it corrupts the emulator. Terminal output
  /// is bursty and escape sequences straddle chunk boundaries, so eating the
  /// oldest of a burst leaves the screen wedged in whatever mode the truncated
  /// sequence opened until something redraws it.
  ///
  /// The memory profile is unchanged in production: the only consumer of this
  /// stream is `LivePTYAttachment`'s relay, which the main actor drains on
  /// every turn, so a burst is held for one turn either way. The cost of the
  /// unbounded policy falls on a consumer that stops draining *without* ending
  /// its stream — its buffer then grows with the session's output instead of
  /// capping at 4096 chunks. A consumer that stops iterating (cancels its
  /// task, drops the iterator) removes its own tap and buffers nothing;
  /// `stop()` finishes every stream it handed out, so a `for await` over one
  /// ends instead of hanging. A stream taken while the connection is stopped
  /// stays open and starts delivering at the next `start()`/`takeOver()`.
  public func output() -> AsyncStream<Data> {
    let (stream, continuation) = AsyncStream<Data>.makeStream(
      bufferingPolicy: .unbounded)
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

  /// Opens the socket and keeps it open. Idempotent, and deliberately inert on
  /// a parked connection: after `.superseded`, `.gone` or `.unreachable` only
  /// `takeOver()` reopens the socket, so a view that reruns its `.task` on
  /// every appearance cannot re-enter a takeover war or an `agent_not_found`
  /// loop behind the operator's back.
  public func start() {
    guard stopped, !parked else { return }
    stopped = false
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
      //
      // Held input belongs to the session that was taken away: a later
      // `takeOver()` must not complete it into the new attach.
      pendingInput = Data()
      finishTaps()
      return
    }
    stopped = true
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    // Held input belongs to the session that just ended; completing it into the
    // next one would inject a stray character. The held attach event belongs to
    // the socket that just went away, and `.closed(.stopped)` is the last thing
    // this connection says.
    pendingInput = Data()
    pendingAttach = nil
    deliver(lifecycle: .closed(.stopped))
    finishTaps()
  }

  /// Re-attach after a `.superseded` (or any terminal state the operator wants
  /// to override): makes this client the owner again and resets the fast-fail
  /// counter.
  ///
  /// This is the only way out of a park, and it re-attaches after `.gone` and
  /// `.unreachable` as well as after `.superseded` — on purpose. Those two say
  /// "the agent is gone" and "herdr is not answering", and both can be true one
  /// minute and false the next (the agent is restarted, herdr finishes
  /// updating), so the affordance a view puts behind them is "Reconnect", not a
  /// dead end. What must never happen implicitly — an attach the operator did
  /// not ask for — is what `start()` refuses.
  public func takeOver() {
    stopped = false
    parked = false
    consecutiveFastFails = 0
    // Same reason as in `stop()`: whatever `send(_:)` is still holding was
    // typed at the session this connection just lost, and the attach event the
    // old socket never proved must not be flushed by the new one's first frame.
    pendingInput = Data()
    pendingAttach = nil
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
  /// bytes) is held back and prepended to the next call; `stop()` and
  /// `takeOver()` drop it, because it was typed at a session that has ended.
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
    let generation = connectionGeneration
    connectedAt = .now
    socket.resume()
    // Produced here, delivered later. `resume()` only *starts* the upgrade, and
    // an attach event over an upgrade that is then refused is actively harmful:
    // `.reattached` tells the view to clear its buffer for a scrollback replay
    // the server is never going to send, and both events flip the view to
    // "live" over a socket that never opened — across a run of fast-fail
    // retries the phase then flaps once a second and the operator watches a
    // blank pane with no status at all. `ui/src/lib/pty.ts` fires
    // `onReconnect()` from `ws.onopen`, i.e. only after the handshake; this is
    // the same moment, deferred to `flushPendingAttach`.
    pendingAttach = everAttached ? .reattached : .attached
    pump = Task { [weak self] in await self?.receiveLoop(socket, generation: generation) }
    // Proof of life for a terminal that has nothing to say. A healthy pane can
    // have an empty scrollback and stay silent for hours, so "live" must not
    // wait for output; a pong comes back within the round trip on any socket
    // that opened, and never on one whose upgrade was refused.
    socket.sendPing { [weak self] error in
      guard error == nil else { return }
      Task { await self?.flushPendingAttach(for: socket, generation: generation) }
    }
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

  /// The pump: one frame at a time until the socket closes.
  ///
  /// `Task.isCancelled` on the `while` is checked *before* the await, which is
  /// the useless half of the guard on its own — a completion already queued for
  /// this socket resumes regardless. `deliverIfCurrent` re-checks after the
  /// await, which is where a `takeOver()`/`stop()` can have replaced the socket
  /// underneath this pump. A close still goes to `handleClose`, superseded or
  /// not: its generation guard is what decides whether the code counts, and
  /// dropping the call here would lose the close code of a socket a racing
  /// `stop()` had already detached.
  private func receiveLoop(_ socket: URLSessionWebSocketTask, generation: Int) async {
    var closeCode = 0
    receiving: while !Task.isCancelled {
      switch await nextFrame(on: socket) {
      case .text(let text):
        guard deliverIfCurrent(Data(text.utf8), from: socket, generation: generation) else {
          return
        }
      case .binary(let data):
        guard deliverIfCurrent(data, from: socket, generation: generation) else { return }
      case .closed(let code):
        closeCode = code
        await beforeHandlingClose?()
        break receiving
      }
    }
    await handleClose(of: socket, closeCode: closeCode, generation: generation)
  }

  /// Whether the pump — or the pong callback — asking still owns the
  /// connection.
  ///
  /// `nextFrame(on:)`'s completion can resume long after a `takeOver()` or
  /// `stop()` cancelled this pump and `connect()` opened a replacement, and the
  /// pong handler runs on a task of its own. Either would otherwise act on a
  /// socket the connection has moved on from: injecting the dead socket's bytes
  /// between the live one's scrollback frames, or confirming an attach nobody
  /// is watching any more.
  private func isCurrent(_ socket: URLSessionWebSocketTask?, generation: Int) -> Bool {
    !Task.isCancelled && generation == connectionGeneration && task === socket
  }

  /// Releases the attach event `connect()` parked, now that this socket has
  /// proved it really opened — whichever comes first of its first frame or its
  /// pong. Idempotent: the loser of that race finds nothing left to flush.
  private func flushPendingAttach(for socket: URLSessionWebSocketTask?, generation: Int) {
    guard let event = pendingAttach, !stopped, isCurrent(socket, generation: generation) else {
      return
    }
    pendingAttach = nil
    // Flipped here, not on the first frame: what makes the *next* attach a
    // reattach is a confirmed upgrade, and a healthy terminal can be silent for
    // hours. Mirrors `everOpened` in `ui/src/lib/pty.ts`, set in `ws.onopen`.
    everAttached = true
    deliver(lifecycle: event)
  }

  /// Delivers one received chunk, unless this pump has been superseded.
  ///
  /// Flushes the held attach event first and in the same actor turn: the
  /// `.reattached` that tells the view to clear has to be ordered ahead of the
  /// scrollback the server replays to refill it.
  ///
  /// Internal rather than private only so a test can replay what a superseded
  /// pump delivers — the same seam `recordCloseCode(_:generation:)` is for the
  /// close code such a pump reports.
  @discardableResult
  func deliverIfCurrent(
    _ bytes: Data, from socket: URLSessionWebSocketTask?, generation: Int
  ) -> Bool {
    guard isCurrent(socket, generation: generation) else { return false }
    flushPendingAttach(for: socket, generation: generation)
    deliver(output: bytes)
    return true
  }

  /// Fans one chunk of terminal output out to every `output()` stream.
  ///
  /// Unconditional: deciding whether this pump still owns the connection, and
  /// flushing the held attach event ahead of the bytes, are `deliverIfCurrent`'s
  /// job, and it is the only caller.
  private func deliver(output bytes: Data) {
    for tap in outputTaps.values { tap.yield(bytes) }
  }

  /// Records the close code of the socket that just died, unless a newer
  /// connection has already replaced it.
  ///
  /// Keyed on the generation rather than on `task`, so a `stop()` that won the
  /// race (it nils `task` without opening anything) still gets the code of the
  /// socket it belonged to, while a pump left running by a `takeOver()` cannot
  /// report the 1001 of its cancelled socket over the live one's verdict.
  ///
  /// Internal rather than private only so a test can replay what such a
  /// superseded pump reports.
  func recordCloseCode(_ code: Int, generation: Int) {
    guard generation == connectionGeneration else { return }
    lastCloseCode = code
  }

  /// One terminal verdict: park (so nothing but `takeOver()` reopens the
  /// socket) and say so.
  ///
  /// The streams are deliberately *not* finished here, unlike in `stop()`:
  /// `takeOver()` reclaims a superseded terminal on the same connection, and
  /// its `.reattached` has to reach the `lifecycle()` stream the view is
  /// already reading.
  private func park(_ closure: Closure) {
    stopped = true
    parked = true
    deliver(lifecycle: .closed(closure))
  }

  /// What a dead socket means, and what happens next.
  ///
  /// The whole single-owner policy lives here: 4000 parks, 4001 parks, anything
  /// else is a transient drop that reconnects after a flat `reconnectDelay`
  /// until `maxFastFails` attaches in a row have died instantly. Mirrors
  /// `ui/src/lib/pty.ts` (`parked` separate from `stopped`, `FAST_FAIL_MS` /
  /// `MAX_FAST_FAILS`, a flat 1 s retry) so both clients behave the same
  /// against the same herdr — including how long they take to say so: at the
  /// default 1 s the verdict lands ~8 s after the first failure, where a
  /// doubling ladder capped at 30 s would take a minute and a half.
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
  private func handleClose(
    of socket: URLSessionWebSocketTask, closeCode: Int, generation: Int
  ) async {
    // Before the guard, and keyed on the generation rather than on `task`:
    // see `recordCloseCode(_:generation:)`.
    recordCloseCode(closeCode, generation: generation)
    // A pump left running after `stop()`/`takeOver()` already replaced this
    // socket must not report anything: the replacement owns the lifecycle now.
    guard !stopped, task === socket else { return }
    task = nil
    // This socket never got to prove itself, so its attach event is void: a
    // refused upgrade must report `.detached` and nothing else.
    pendingAttach = nil

    // The two single-owner codes are terminal by contract
    // (`PTY_SUPERSEDED_CODE` / `PTY_GONE_CODE` in `src/server.ts`). Reconnecting
    // after 4000 restarts the takeover war with the device that just won it —
    // it would bump us straight back — and after 4001 it loops on herdr's
    // `agent_not_found`. Both park instead of retrying.
    if closeCode == Self.supersededCode {
      ShepherdLog.realtime.notice("pty superseded by another client; parked")
      park(.superseded)
      return
    }
    if closeCode == Self.goneCode {
      park(.gone)
      return
    }

    // A socket that lived past the window carried a real session; anything
    // shorter is an attach against a herdr that is not there. `everAttached` is
    // deliberately not the test: a long-lived but silent terminal is healthy.
    let lived = connectedAt.map { ContinuousClock.now - $0 } ?? .zero
    if lived >= Self.fastFailWindow {
      consecutiveFastFails = 0
    } else {
      consecutiveFastFails += 1
    }
    if consecutiveFastFails >= Self.maxFastFails {
      // The one failure nothing else surfaces — the connection would otherwise
      // retry quietly forever. Never the token, never the URL.
      ShepherdLog.realtime.notice(
        "pty gave up after \(Self.maxFastFails, privacy: .public) immediate failures")
      park(.unreachable)
      return
    }

    // Said before the sleep, so a view can repaint "reconnecting" immediately
    // rather than after the delay.
    deliver(lifecycle: .detached)
    do {
      try await Task.sleep(for: reconnectDelay)
    } catch {
      return  // cancelled while waiting: `stop()`/`takeOver()` cancelled `pump`
    }
    // `task == nil` plus the generation check is the same guard
    // `EventStream.scheduleReconnect` uses: `task == nil` alone cannot tell this
    // retry window from a later one that also opened and lost a socket while
    // this continuation was queued.
    guard !stopped, task == nil, connectionGeneration == generation else { return }
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
