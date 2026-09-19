import Foundation

/// The `/events` WebSocket.
///
/// Opens `baseURL` with `Authorization: Bearer` on the upgrade, yields
/// decoded frames on `events()`, reports presence so the server can suppress
/// push while the app is focused, and reconnects with capped exponential
/// backoff on any close that `stop()` did not cause.
public actor EventStream {
  private let baseURL: URL
  private let tokenProvider: @Sendable () -> String?
  private let urlSession: URLSession
  private let reconnectDelay: Duration
  private let maxReconnectDelay: Duration
  private let continuation: AsyncStream<ServerEvent>.Continuation
  private let lifecycleContinuation: AsyncStream<LifecycleEvent>.Continuation

  private var task: URLSessionWebSocketTask?
  private var pump: Task<Void, Never>?
  private var stopped = true
  private var active = false

  /// The delay the *next* reconnect will sleep for. Starts at
  /// `reconnectDelay`, doubles (capped at `maxReconnectDelay`) after every
  /// connection attempt that never became "healthy", and resets to
  /// `reconnectDelay` once one does. See `connectionWasHealthy`.
  private var currentReconnectDelay: Duration

  /// When the live socket was opened, so `connectionWasHealthy` can measure
  /// how long it stayed up.
  private var connectedAt: ContinuousClock.Instant?
  /// Whether any message (decodable or not) arrived on the current socket.
  private var frameReceivedSinceConnect = false
  /// How many connection attempts in a row ended without becoming healthy.
  /// Reported in the reconnect log line, so a server that keeps refusing the
  /// upgrade is diagnosable after the fact. Reset by a healthy socket.
  private var consecutiveFailures = 0

  private nonisolated let eventStream: AsyncStream<ServerEvent>
  private nonisolated let lifecycleStream: AsyncStream<LifecycleEvent>

  /// What the socket itself is doing, as opposed to what the server said on
  /// it. `SessionStore` needs both halves: a `.disconnected` means "we are
  /// reconnecting", not "offline", and a `.connected` after the first one
  /// means the stream may have missed pushes while it was down, so the
  /// snapshot has to be read again.
  public enum LifecycleEvent: Sendable, Equatable {
    /// A socket was opened. The upgrade may still be refused, in which case
    /// a `.disconnected` follows right after.
    case connected
    /// The socket is gone. The stream is already waiting out its backoff and
    /// will open another one unless `stop()` was called.
    case disconnected
  }

  /// Decoded frames, oldest first. Single-consumer: the `SessionStore` owns
  /// it. Calling this twice hands back the same `AsyncStream` — it is not a
  /// broadcast — so a second caller would steal elements from the first
  /// (each element goes to whichever iterator asks for it next) rather than
  /// see its own copy of every event. Don't call it more than once.
  public nonisolated func events() -> AsyncStream<ServerEvent> { eventStream }

  /// Socket lifecycle, oldest first. Single-consumer for the same reason
  /// `events()` is: calling it twice splits the elements between the two
  /// iterators instead of broadcasting to both.
  ///
  /// Elements are buffered from construction, so a consumer that subscribes
  /// after `start()` still sees the first `.connected`.
  public nonisolated func lifecycle() -> AsyncStream<LifecycleEvent> { lifecycleStream }

  /// - Parameters:
  ///   - baseURL: the full `ws(s)://…/events` URL.
  ///   - tokenProvider: read on every (re)connect, so a token minted after
  ///     construction is picked up without rebuilding the stream.
  ///   - reconnectDelay: the delay before the first reconnect attempt after
  ///     an unhealthy connection; the design spec fixes this at 1 s, tests
  ///     shorten it. Doubles on each further consecutive failure.
  ///   - maxReconnectDelay: the ceiling the doubling delay never exceeds.
  ///     Defaults to 30 s so a server that is down for a while does not get
  ///     hammered, without keeping the public initializer signature
  ///     source-breaking for existing callers.
  public init(
    baseURL: URL,
    tokenProvider: @escaping @Sendable () -> String?,
    urlSession: URLSession = .shared,
    reconnectDelay: Duration = .seconds(1),
    maxReconnectDelay: Duration = .seconds(30)
  ) {
    self.baseURL = baseURL
    self.tokenProvider = tokenProvider
    self.urlSession = urlSession
    self.reconnectDelay = reconnectDelay
    self.maxReconnectDelay = maxReconnectDelay
    self.currentReconnectDelay = reconnectDelay
    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(256))
    eventStream = stream
    self.continuation = continuation
    // `bufferingNewest(8)`, not unbounded: only the newest transitions matter
    // to a consumer that subscribes late or falls behind — an old `.connected`
    // sitting behind a dozen reconnect cycles is not worth replaying, and a
    // bound keeps a consumer that never reads `lifecycle()` from leaking
    // elements for the life of the stream. 8 is comfortably above what a
    // reconnect storm produces between reads.
    let (lifecycle, lifecycleContinuation) = AsyncStream<LifecycleEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(8))
    lifecycleStream = lifecycle
    self.lifecycleContinuation = lifecycleContinuation
  }

  /// Convenience for the common case: derive the `/events` URL and the token
  /// from a live client.
  public init(client: ShepherdClient, urlSession: URLSession = .shared) {
    self.init(
      baseURL: Self.eventsURL(for: client.profile.baseURL),
      tokenProvider: { client.currentToken() },
      urlSession: urlSession
    )
  }

  /// `http(s)://host/some/prefix` → `ws(s)://host/some/prefix/events`,
  /// preserving any path prefix the base URL carries (a reverse proxy may
  /// mount Shepherd under one) and dropping query and fragment, which have
  /// no meaning on the upgrade request.
  ///
  /// Built entirely through `URLComponents` with `guard` fallbacks: nothing
  /// here force-unwraps, so a baseURL `URLComponents` cannot parse (or that
  /// re-serializes to `nil`, which should not happen for a valid `URL` but
  /// is not provably impossible) falls back to `baseURL` with `/events`
  /// appended and the scheme swapped, rather than crashing.
  public static func eventsURL(for baseURL: URL) -> URL {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      return appendingEventsPath(to: baseURL)
    }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.query = nil
    components.fragment = nil
    let path = components.path
    let prefix = path.hasSuffix("/") ? String(path.dropLast()) : path
    components.path = prefix + "/events"
    guard let url = components.url else {
      return appendingEventsPath(to: baseURL)
    }
    return url
  }

  /// Last-resort fallback for a `baseURL` whose `URLComponents` will not
  /// round-trip. Pure string surgery on `absoluteString` rather than another
  /// `URLComponents` pass, so this path cannot fail the same way twice.
  private static func appendingEventsPath(to baseURL: URL) -> URL {
    let appended = baseURL.appendingPathComponent("events")
    let absolute = appended.absoluteString
    if absolute.hasPrefix("https://") {
      return URL(string: "wss://" + absolute.dropFirst("https://".count)) ?? appended
    }
    if absolute.hasPrefix("http://") {
      return URL(string: "ws://" + absolute.dropFirst("http://".count)) ?? appended
    }
    return appended
  }

  /// Opens the socket and keeps it open. Idempotent: a second `start()` on a
  /// running stream does nothing rather than opening a second socket.
  public func start() {
    guard stopped else { return }
    stopped = false
    currentReconnectDelay = reconnectDelay
    connect()
  }

  /// Closes the current socket and stops reconnecting — but does **not**
  /// finish `events()`: `start()` can reopen the same stream later, and any
  /// task consuming `events()` keeps waiting for elements that will never
  /// come until then. Callers that no longer want the frames must cancel
  /// their own consuming task; `stop()` alone will not end a `for await` on
  /// it. Call it when the stream is no longer wanted: while a socket is open
  /// the receive loop holds this actor alive, so a dropped reference alone
  /// will not tear the connection down.
  public func stop() {
    stopped = true
    pump?.cancel()
    pump = nil
    if task != nil { lifecycleContinuation.yield(.disconnected) }
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  /// Report whether the app is in the foreground. The server uses this to
  /// suppress push banners while the operator is already looking.
  ///
  /// Starts `false`: unlike the web client, which sends the page's live
  /// visibility state the instant it opens the socket, this stream has no
  /// signal of its own about the app's foreground state until told. The app
  /// must call `setActive(true)` once it knows it is active (e.g. from
  /// `applicationDidBecomeActive` / `scenePhase`) — otherwise the server
  /// treats every connection as backgrounded and never suppresses push for
  /// it.
  public func setActive(_ active: Bool) {
    guard self.active != active else { return }
    self.active = active
    sendPresence()
  }

  /// Drop the current socket and open a new one immediately — the app calls
  /// this on `applicationDidBecomeActive` rather than waiting out the delay.
  /// Also resets the backoff: a deliberate, operator-triggered reconnect is
  /// not a "consecutive failure" and should not inherit a long wait if the
  /// next attempt fails too.
  public func reconnectNow() {
    guard !stopped else { return }
    pump?.cancel()
    pump = nil
    // Say the old socket is gone before opening the new one, so a consumer
    // always sees `.disconnected` → `.connected` in that order. Without this,
    // the stale pump's own `.disconnected` (once its cancelled `receive()`
    // finally throws) can land *after* `connect()` below has already yielded
    // `.connected` for the replacement socket — see `scheduleReconnect`'s
    // `task === socket` guard, which suppresses that stale yield entirely.
    if task != nil { lifecycleContinuation.yield(.disconnected) }
    task?.cancel(with: .goingAway, reason: nil)
    currentReconnectDelay = reconnectDelay
    connect()
  }

  private func connect() {
    var request = URLRequest(url: baseURL)
    // Read the token afresh on every connect: a login that happened after
    // construction, or a rotated token, has to reach the next upgrade.
    if let token = tokenProvider() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let socket = urlSession.webSocketTask(with: request)
    task = socket
    connectedAt = .now
    frameReceivedSinceConnect = false
    socket.resume()
    sendPresence()
    lifecycleContinuation.yield(.connected)

    pump = Task { [weak self] in
      await self?.receiveLoop(socket)
    }
  }

  private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await socket.receive()
        frameReceivedSinceConnect = true
        switch message {
        case .string(let text): yield(Data(text.utf8))
        case .data(let data): yield(data)
        @unknown default: break
        }
      } catch {
        // Any receive failure means the socket is gone: a clean close, a
        // dropped network, or our own cancel(). `stopped` tells them apart.
        break
      }
    }
    // The socket is gone, whatever ended it. `scheduleReconnect` is what
    // yields `.disconnected` — gated on `task === socket` — so a pump left
    // running after `reconnectNow()`/`stop()` already replaced or closed the
    // socket does not emit a second, stale `.disconnected` behind the
    // `.connected` those callers already reported.
    await scheduleReconnect(after: socket)
  }

  /// A connection counts as healthy — and resets the backoff — if it ever
  /// received a message (a real frame proves the upgrade was accepted and
  /// the server is talking) or if it simply stayed open for a while (5 s: a
  /// socket the server did not immediately drop is doing fine even if
  /// nothing has been sent on it yet, e.g. a quiet session). Anything
  /// shorter that never received a message — an instant reject, a dropped
  /// upgrade — counts as a failure and grows the delay.
  private static let healthyConnectionDuration: Duration = .seconds(5)

  private func connectionWasHealthy() -> Bool {
    if frameReceivedSinceConnect { return true }
    guard let connectedAt else { return false }
    return ContinuousClock.now - connectedAt >= Self.healthyConnectionDuration
  }

  private func scheduleReconnect(after socket: URLSessionWebSocketTask) async {
    // `task === socket` keeps a stale pump from racing a socket that
    // `reconnectNow()` has already replaced — and from double-reporting a
    // `.disconnected` that `reconnectNow()`/`stop()` already yielded
    // themselves for that same replacement.
    guard !stopped, task === socket else { return }
    // Say so before the backoff sleep, so a consumer can repaint
    // "reconnecting" immediately rather than after the delay.
    lifecycleContinuation.yield(.disconnected)

    let delay: Duration
    if connectionWasHealthy() {
      consecutiveFailures = 0
      currentReconnectDelay = reconnectDelay
      delay = reconnectDelay
      ShepherdLog.realtime.debug("events socket closed; reconnecting")
    } else {
      delay = currentReconnectDelay
      currentReconnectDelay = min(currentReconnectDelay * 2, maxReconnectDelay)
      consecutiveFailures += 1
      // A refused or instantly dropped upgrade is the one failure nothing
      // else surfaces — the stream keeps retrying quietly — so it is logged
      // at `notice` with the run of consecutive failures, which tells one
      // hiccup from a server that keeps saying no. Never the token.
      ShepherdLog.realtime.notice(
        "events upgrade failed (\(self.consecutiveFailures, privacy: .public) in a row); retrying")
    }

    do {
      try await Task.sleep(for: delay)
    } catch {
      return  // cancelled while waiting
    }
    guard !stopped, task === socket else { return }
    connect()
  }

  private func yield(_ data: Data) {
    do {
      continuation.yield(try JSONDecoder().decode(ServerEvent.self, from: data))
    } catch {
      // A frame the client cannot parse is dropped, exactly like the web
      // store's `catch { /* ignore malformed frames */ }`. Never log the
      // body: a frame can carry a prompt.
      ShepherdLog.realtime.debug("dropped an unparseable /events frame")
    }
  }

  private func sendPresence() {
    guard let socket = task, let json = try? JSONEncoder().encode(PresenceFrame(active: active))
    else { return }
    socket.send(.string(String(decoding: json, as: UTF8.self))) { _ in }
  }

  deinit {
    continuation.finish()
    lifecycleContinuation.finish()
  }
}
