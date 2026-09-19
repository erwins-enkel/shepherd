import Foundation

/// The `/events` WebSocket.
///
/// Opens `baseURL` with `Authorization: Bearer` on the upgrade, yields
/// decoded frames on `events()`, reports presence so the server can suppress
/// push while the app is focused, and reconnects after `reconnectDelay` on
/// any close that `stop()` did not cause.
public actor EventStream {
  private let baseURL: URL
  private let tokenProvider: @Sendable () -> String?
  private let urlSession: URLSession
  private let reconnectDelay: Duration
  private let continuation: AsyncStream<ServerEvent>.Continuation

  private var task: URLSessionWebSocketTask?
  private var pump: Task<Void, Never>?
  private var stopped = true
  private var active = true

  private nonisolated let eventStream: AsyncStream<ServerEvent>

  /// Decoded frames, oldest first. Single-consumer: the `SessionStore` owns
  /// it. Calling this twice hands back the same stream, so the second caller
  /// would steal elements from the first — don't.
  public nonisolated func events() -> AsyncStream<ServerEvent> { eventStream }

  /// - Parameters:
  ///   - baseURL: the full `ws(s)://…/events` URL.
  ///   - tokenProvider: read on every (re)connect, so a token minted after
  ///     construction is picked up without rebuilding the stream.
  ///   - reconnectDelay: the design spec fixes this at 1 s; tests shorten it.
  public init(
    baseURL: URL,
    tokenProvider: @escaping @Sendable () -> String?,
    urlSession: URLSession = .shared,
    reconnectDelay: Duration = .seconds(1)
  ) {
    self.baseURL = baseURL
    self.tokenProvider = tokenProvider
    self.urlSession = urlSession
    self.reconnectDelay = reconnectDelay
    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(256))
    eventStream = stream
    self.continuation = continuation
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

  /// `http(s)://host/` → `ws(s)://host/events`.
  public static func eventsURL(for baseURL: URL) -> URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/events"
    return components.url!
  }

  /// Opens the socket and keeps it open. Idempotent: a second `start()` on a
  /// running stream does nothing rather than opening a second socket.
  public func start() {
    guard stopped else { return }
    stopped = false
    connect()
  }

  /// Closes the socket for good — `start()` can reopen it, but nothing else
  /// will. Call it when the stream is no longer wanted: while a socket is
  /// open the receive loop holds this actor alive, so a dropped reference
  /// alone will not tear the connection down.
  public func stop() {
    stopped = true
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  /// Report whether the app is in the foreground. The server uses this to
  /// suppress push banners while the operator is already looking.
  public func setActive(_ active: Bool) {
    guard self.active != active else { return }
    self.active = active
    sendPresence()
  }

  /// Drop the current socket and open a new one immediately — the app calls
  /// this on `applicationDidBecomeActive` rather than waiting out the delay.
  public func reconnectNow() {
    guard !stopped else { return }
    pump?.cancel()
    pump = nil
    task?.cancel(with: .goingAway, reason: nil)
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
    socket.resume()
    sendPresence()

    pump = Task { [weak self] in
      await self?.receiveLoop(socket)
    }
  }

  private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await socket.receive()
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
    await scheduleReconnect(after: socket)
  }

  private func scheduleReconnect(after socket: URLSessionWebSocketTask) async {
    // `task === socket` keeps a stale pump from racing a socket that
    // `reconnectNow()` has already replaced.
    guard !stopped, task === socket else { return }
    ShepherdLog.realtime.debug("events socket closed; reconnecting")
    do {
      try await Task.sleep(for: reconnectDelay)
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

  deinit { continuation.finish() }
}
