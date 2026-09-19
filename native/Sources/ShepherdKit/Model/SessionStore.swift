import Foundation
import Observation

/// Where the conversation with one server stands.
///
/// Carries a `String` rather than an `Error` so the whole enum is `Equatable`:
/// views compare it on every render and tests assert on exact values.
public enum ConnectionState: Sendable, Equatable {
  /// Nothing has been started, or `stop()` has been called.
  case idle
  /// Bootstrapping, or waiting out a reconnect delay.
  case connecting
  /// Bootstrapped; events are flowing.
  case live
  /// The server rejected the token. The app must present a login sheet; the
  /// stored credential has already been cleared by the auth middleware.
  case needsLogin
  /// The server has no workspace root yet. `resolveFirstRun(path:)` clears it.
  case firstRunPending
  /// The server could not be reached. The message is diagnostic, not copy:
  /// show a localized banner and keep this for the log.
  case offline(message: String)
}

/// The live view of one server, for a SwiftUI app to render.
///
/// Event application mirrors `ui/src/lib/store.svelte.ts::apply` for the eight
/// events in the contract, so the native client and the web UI cannot disagree
/// about what a push means. `@MainActor` because every property here drives UI.
///
/// Two ways to use it:
/// - `init(profile:credentials:)` + `start()` — self-driving. The store builds
///   its own `ShepherdClient` and `EventStream`, bootstraps, publishes
///   `connection`, and applies events until `stop()`. This is what an app wants.
/// - `init(client:)` + `bootstrap()` / `apply(_:)` / `consume(_:)` — the
///   lower-level API, for tests and for a caller that owns its own event loop.
@Observable
@MainActor
public final class SessionStore {
  public private(set) var sessions: [Session] = []
  /// Blocked sessions, keyed by session id. Absent means not blocked.
  public private(set) var blocks: [String: Components.Schemas.BlockReason] = [:]
  public private(set) var settings: Settings?
  public private(set) var repos: [Repo] = []
  /// Auto-merge state keyed by `repoPath`, like the web store's `autoMerge`.
  public private(set) var autoMerge: [String: Components.Schemas.AutoMergeStatus] = [:]
  public private(set) var usageLimits: Components.Schemas.UsageLimits?
  /// The last command failure, for a banner. Cleared by the next success.
  public private(set) var lastError: ShepherdError?
  /// Where the server conversation stands. `@Observable`-tracked like every
  /// other property here, so SwiftUI and `withObservationTracking` both see it
  /// move — a consumer never has to poll.
  public private(set) var connection: ConnectionState = .idle

  /// The HTTP client this store drives, so an app that built the store with
  /// `init(profile:credentials:)` can still reach the one thing only the
  /// client exposes: `client.needsLogin`, the 401 signal for requests the
  /// store did not make.
  ///
  /// The store deliberately does NOT consume that stream — it is
  /// single-consumer, and every request the store makes already surfaces a
  /// 401 as `ShepherdError.unauthenticated` through `lastError` and
  /// `connection`. The app is the one consumer.
  public let client: ShepherdClient

  private let eventStream: EventStream?
  private let reconnectDelay: Duration
  private let maxReconnectDelay: Duration
  @ObservationIgnored private var running = false
  /// Set by `stop()`, cleared by `start()`. This, not `running`, is what gates
  /// `publish(_:)`: `running` is false both after `stop()` *and* after a
  /// hand-driven `start()` has returned (a store built with `events: nil`
  /// bootstraps and returns), and in the second case a 401 on a later command
  /// still has to reach `connection`.
  @ObservationIgnored private var stopped = false
  /// The delay the *next* bootstrap retry will sleep for. Starts at
  /// `reconnectDelay`, doubles (capped at `maxReconnectDelay`) after every
  /// bootstrap attempt that fails, and resets to `reconnectDelay` once one
  /// succeeds — the same policy `EventStream` uses for its socket reconnects.
  @ObservationIgnored private var currentReconnectDelay: Duration
  /// The task draining `EventStream.events()`. The store owns it because
  /// `EventStream.stop()` deliberately does NOT finish that stream — cancelling
  /// this task is the only thing that ends the `for await` inside `consume(_:)`.
  ///
  /// `@ObservationIgnored` so `deinit` may read it: an `@Observable` property
  /// is reached through a main-actor-isolated accessor, which a `deinit` may
  /// not call.
  @ObservationIgnored private var consumer: Task<Void, Never>?
  /// The task following `EventStream.lifecycle()`. Separate from `consumer`
  /// because the two streams move independently: frames keep arriving on a
  /// healthy socket while nothing happens on the lifecycle stream, and a
  /// reconnect produces lifecycle elements and no frames.
  @ObservationIgnored private var lifecycleWatcher: Task<Void, Never>?
  /// Bumped at the start of every `refresh()`. A snapshot whose generation is
  /// no longer the newest is dropped instead of installed: two refreshes can
  /// overlap (the reconnect watcher and a `resolveFirstRun`, say), and the one
  /// that started earlier holds the older lists by construction.
  @ObservationIgnored private var snapshotGeneration = 0
  /// How many `refresh()` calls are between "fetches issued" and "snapshot
  /// installed". While it is non-zero, `apply(_:)` buffers instead of mutating.
  @ObservationIgnored private var loadsInFlight = 0
  /// Frames that arrived while a snapshot load was in flight, oldest first.
  @ObservationIgnored private var bufferedEvents: [ServerEvent] = []

  /// - Parameters:
  ///   - events: `nil` for a store the caller drives by hand — `start()` then
  ///     bootstraps once and returns instead of running an event loop.
  ///   - reconnectDelay: how long `start()` waits before the *first*
  ///     re-bootstrap after a failure. The design spec fixes 1 s; tests
  ///     shorten it. Doubles on each further consecutive failure, up to
  ///     `maxReconnectDelay`, and resets after a successful bootstrap.
  ///   - maxReconnectDelay: the ceiling the doubling delay never exceeds.
  ///     Defaults to 30 s, mirroring `EventStream`, without making the
  ///     initializer source-breaking for existing callers.
  public init(
    client: ShepherdClient,
    events: EventStream? = nil,
    reconnectDelay: Duration = .seconds(1),
    maxReconnectDelay: Duration = .seconds(30)
  ) {
    self.client = client
    self.eventStream = events
    self.reconnectDelay = reconnectDelay
    self.maxReconnectDelay = maxReconnectDelay
    self.currentReconnectDelay = reconnectDelay
  }

  /// The self-driving store: builds the client and the `/events` socket from a
  /// profile, so an app needs exactly one object per server.
  ///
  /// - Throws: `ServerProfileError` when a `.remote` profile violates the
  ///   https-unless-loopback-or-tailnet policy — the same failure
  ///   `ShepherdClient.init` raises, surfaced at the same moment.
  public convenience init(profile: ServerProfile, credentials: any CredentialStore) throws {
    let client = try ShepherdClient(profile: profile, credentials: credentials)
    self.init(client: client, events: EventStream(client: client))
  }

  /// True while the server still needs a workspace root.
  public var firstRunPending: Bool { settings?.firstRunPending ?? false }

  public func session(id: String) -> Session? {
    sessions.first { $0.id == id }
  }

  // MARK: - Lifecycle

  /// Bootstrap, publish `connection`, then apply events until `stop()`.
  ///
  /// Never throws: for a long-running connection a failure is a *state*, not an
  /// exception — the app renders `connection` rather than catching something.
  /// Calling it twice is a no-op while the first call is still running.
  ///
  /// `running` is a soft flag, not a lock: it stops a *second* call from
  /// starting a competing loop, but it gives no mutual exclusion against a
  /// `start()` issued while a previous loop is still unwinding after `stop()`
  /// — `stop()` flips `running` to `false` synchronously, so a caller that
  /// invokes `start()` again before the old task has actually returned from
  /// its current `await` can end up with two passes of this method live at
  /// once, each free to mutate `consumer` and `connection`. Nothing here
  /// detects that. The app is expected to build a fresh `SessionStore` (and
  /// `EventStream`) per activation, as `stop()`'s doc already directs, rather
  /// than restart one it just stopped — that is what keeps this soft flag
  /// safe in practice.
  ///
  /// The socket is opened and subscribed to **before** the snapshot is read,
  /// and `apply(_:)` buffers while a load is in flight: a frame that lands
  /// between the upgrade and the snapshot is replayed on top of the snapshot
  /// instead of being lost in the gap between the two. Gap recovery after a
  /// reconnect is the lifecycle watcher's job — `EventStream` buffers only the
  /// newest 256 frames, so a socket that went away may have missed pushes, and
  /// re-reading the three lists is what makes that harmless.
  public func start() async {
    guard !running else { return }
    running = true
    stopped = false
    currentReconnectDelay = reconnectDelay
    defer { running = false }

    publish(.connecting)

    if let eventStream {
      await eventStream.start()
      guard running else {
        // stop() raced in while the socket was opening: close what we just
        // opened rather than leaving a live connection nothing consumes.
        await eventStream.stop()
        return
      }
      startConsuming(eventStream)
      startWatchingLifecycle(eventStream)
    }

    while running {
      publish(.connecting)

      do {
        try await bootstrap()
        currentReconnectDelay = reconnectDelay
      } catch {
        switch ShepherdError.from(error, route: "bootstrap") {
        case .cancelled:
          // The task running start() was cancelled. Nothing failed, so nothing
          // is published: `connection` stays where the operator last saw it,
          // and the socket goes down with the loop.
          await teardownEventLoop()
          return
        case .unauthenticated:
          // Terminal: the middleware already cleared the token, and only a new
          // login can help. The app calls start() again after ProfileSetup.
          // The socket carries that same dead token, so it goes down with the
          // loop instead of reconnecting against a server that will refuse it.
          publish(.needsLogin)
          await teardownEventLoop()
          return
        case .firstRunPending:
          // No bootstrap route documents a 409 today, so this arrives only if
          // one starts to; the state machine covers it either way.
          publish(.firstRunPending)
        case .transport(let message):
          publish(.offline(message: message))
          guard await waitBeforeRetry() else { return }
          continue
        case let other:
          publish(.offline(message: String(describing: other)))
          guard await waitBeforeRetry() else { return }
          continue
        }
      }

      // A stop() that landed while bootstrap() was in flight must not park
      // start() on a consumer nobody will cancel.
      guard running else { return }

      // A store with no socket (init(client:)) has nothing left to do.
      guard eventStream != nil else { return }

      // Returns when `stop()` cancels the consuming task — the only thing that
      // ends it, since `EventStream.stop()` leaves `events()` unfinished.
      await consumer?.value
      consumer = nil
      lifecycleWatcher?.cancel()
      lifecycleWatcher = nil
      if running {
        // Not our doing: the stream finished by itself. That happens only on a
        // store restarted after `stop()` (cancelling an `AsyncStream` consumer
        // terminates the stream for good), and returning here rather than
        // looping keeps a dead socket from becoming a bootstrap hot loop.
        publish(.offline(message: "the /events stream ended"))
      }
      return
    }
  }

  /// Stop the event loop and return to `.idle`.
  ///
  /// Publishing `.idle` is deliberate: a consumer suspended on
  /// `withObservationTracking(connection)` is woken by it and can finish.
  ///
  /// Cancelling the consuming task also finishes `EventStream.events()` — that
  /// is how `AsyncStream` treats a cancelled consumer — so a stopped store
  /// cannot be brought back to life by calling `start()` again: build a fresh
  /// `SessionStore` (and `EventStream`) instead. To go quiet temporarily, use
  /// `setActive(false)` and keep the socket.
  public func stop() {
    running = false
    stopped = true
    consumer?.cancel()
    consumer = nil
    lifecycleWatcher?.cancel()
    lifecycleWatcher = nil
    if let eventStream {
      Task { await eventStream.stop() }
    }
    // Assigned rather than published: `stopped` is already true, and `.idle`
    // is the one state that outranks the gate.
    connection = .idle
  }

  /// A store that goes out of scope while it is running must not leave a live
  /// socket behind: `EventStream`'s receive loop holds that actor alive, so a
  /// dropped reference alone would keep it reconnecting forever.
  ///
  /// `eventStream` is read into a local before the task captures it — a
  /// `deinit` must never let `self` escape into a task that could outlive the
  /// object being destroyed.
  deinit {
    consumer?.cancel()
    lifecycleWatcher?.cancel()
    if let stream = eventStream {
      Task { await stream.stop() }
    }
  }

  /// Ends everything `start()` set up, for the terminal paths that return
  /// without `stop()` having been called. Leaves `connection` alone: the
  /// caller has already published the state that explains the teardown.
  private func teardownEventLoop() async {
    consumer?.cancel()
    consumer = nil
    lifecycleWatcher?.cancel()
    lifecycleWatcher = nil
    await eventStream?.stop()
  }

  /// Report whether the app is in the foreground, so the server can suppress
  /// push while the operator is already looking. The app calls this from its
  /// focus notifications; a store with no socket ignores it.
  public func setActive(_ active: Bool) async {
    await eventStream?.setActive(active)
  }

  private func startConsuming(_ eventStream: EventStream) {
    // A stop() that raced in between eventStream.start() and here must not
    // spin up a consumer nobody will ever cancel.
    guard running, consumer == nil else { return }
    // `events()` is single-consumer, so it is read exactly once per socket.
    let events = eventStream.events()
    consumer = Task { [weak self] in
      await self?.consume(events)
    }
  }

  /// Follows the socket's own state, in a task of its own so a quiet socket
  /// (no frames) still reports a reconnect promptly.
  private func startWatchingLifecycle(_ eventStream: EventStream) {
    guard running, lifecycleWatcher == nil else { return }
    // `lifecycle()` is single-consumer, like `events()`: read exactly once.
    let lifecycle = eventStream.lifecycle()
    lifecycleWatcher = Task { [weak self] in
      await self?.watchLifecycle(lifecycle)
    }
  }

  /// Turns socket lifecycle into connection state and gap recovery. The first
  /// `.connected` is the socket `start()` just opened, whose snapshot
  /// `start()` is already reading — only the ones after it mean "we may have
  /// missed pushes while we were down".
  private func watchLifecycle(_ lifecycle: AsyncStream<EventStream.LifecycleEvent>) async {
    var sawFirstConnect = false
    for await event in lifecycle {
      switch event {
      case .connected:
        guard sawFirstConnect else {
          sawFirstConnect = true
          continue
        }
        // Re-read the three lists: the stream keeps only the newest 256
        // frames, so a reconnect can have dropped pushes. A failure here is
        // not fatal — `start()`'s retry loop owns the offline state.
        try? await refresh()
      case .disconnected:
        // The stream is already reconnecting with backoff, so this is
        // "connecting", not "offline", and the last snapshot is still the
        // best thing to render. Only `.live` is repainted: `.needsLogin`,
        // `.firstRunPending` and `.offline` are facts about the server, not
        // about the socket, and `.idle` means the operator stopped the store.
        if connection == .live { publish(.connecting) }
      }
    }
  }

  /// `true` when the caller should try again, `false` when `stop()` or task
  /// cancellation happened while waiting. Each call sleeps the current
  /// backoff delay, then doubles it (capped at `maxReconnectDelay`) for the
  /// next failure; a successful bootstrap resets it in `start()`.
  private func waitBeforeRetry() async -> Bool {
    let delay = currentReconnectDelay
    currentReconnectDelay = min(currentReconnectDelay * 2, maxReconnectDelay)
    do { try await Task.sleep(for: delay) } catch { return false }
    return running
  }

  /// Publish a state the store derived. Gated on `stopped` so `stop()` has the
  /// last word: an attempt still in flight when the app stopped must not
  /// repaint `.offline` — or `.needsLogin` — over the `.idle` the operator
  /// asked for. See `stopped` for why `running` cannot be the gate.
  private func publish(_ state: ConnectionState) {
    guard !stopped else { return }
    connection = state
  }

  /// After a successful load, reconcile `connection` with what settings say.
  /// `.idle` and `.needsLogin` are left alone: neither is this method's to
  /// overrule — one means "not started", the other "the app owes us a login".
  private func publishLoadedState() {
    switch connection {
    case .idle, .needsLogin:
      break
    case .connecting, .live, .firstRunPending, .offline:
      connection = self.firstRunPending ? .firstRunPending : .live
    }
  }

  /// Record a mapped failure. A 401 is also a connection fact, not just a
  /// command failure — the app has to re-authenticate before anything works.
  ///
  /// This is the store's only path to `.needsLogin`: every request it makes
  /// surfaces a 401 as `ShepherdError.unauthenticated`, so it deliberately does
  /// NOT consume `ShepherdClient.needsLogin` — that stream has a single
  /// consumer, and an app that wants to hear about a 401 from a request the
  /// store did not make should be the one listening to it.
  private func record(_ mapped: ShepherdError) {
    // A cancelled request is not a failure to show: the caller walked away, so
    // the last error the operator saw stays the current one.
    guard mapped != .cancelled else { return }
    lastError = mapped
    // Through `publish` rather than a direct assignment: a 401 that lands
    // after `stop()` must not repaint `.needsLogin` over `.idle`.
    if mapped == .unauthenticated { publish(.needsLogin) }
  }

  // MARK: - Loading

  /// Initial load: sessions, settings, repos. The design spec fixes these
  /// three as the bootstrap set.
  public func bootstrap() async throws {
    try await refresh()
  }

  /// Re-read the bootstrap set and install it as the current snapshot.
  ///
  /// Two rules keep a snapshot from undoing newer truth:
  /// - Frames that arrive while the fetches are in flight are buffered by
  ///   `apply(_:)` and replayed once the snapshot is installed, so a session
  ///   archived during the await is not resurrected by the older list, and a
  ///   status patch is not rolled back.
  /// - A generation counter taken before the fetches: if a later `refresh()`
  ///   has installed its snapshot in the meantime, this one's lists are stale
  ///   by construction and are dropped instead of installed.
  public func refresh() async throws {
    snapshotGeneration += 1
    let generation = snapshotGeneration
    loadsInFlight += 1
    defer {
      loadsInFlight -= 1
      // `@MainActor`, so this runs synchronously right after the snapshot was
      // installed: the buffered frames land on top of it, never under it.
      if loadsInFlight == 0 { drainBufferedEvents() }
    }
    do {
      // Each fetch maps its own failure to the route that actually failed
      // (rather than a blanket "bootstrap"), so a diagnostic names the right
      // call. `ShepherdError.from` is idempotent on an already-mapped error,
      // so the outer catch below just passes it through.
      async let sessions = fetchOrMap(route: "sessions") { try await client.sessions() }
      async let settings = fetchOrMap(route: "settings") { try await client.settings() }
      async let repos = fetchOrMap(route: "repos") { try await client.repos() }
      let (loadedSessions, loadedSettings, loadedRepos) = try await (sessions, settings, repos)
      // A refresh that started later already installed a newer snapshot;
      // these three lists are the older read of the same server.
      guard generation == snapshotGeneration else { return }
      self.sessions = loadedSessions
      self.settings = loadedSettings
      self.repos = loadedRepos.repos
      lastError = nil
      publishLoadedState()
    } catch {
      let mapped = ShepherdError.from(error, route: "refresh")
      record(mapped)
      throw mapped
    }
  }

  /// Runs `operation`, remapping any failure with the route that actually
  /// failed. `refresh()` fires its three fetches concurrently via `async
  /// let`, so the outer `catch` alone cannot tell which one threw.
  private func fetchOrMap<T>(route: String, _ operation: () async throws -> T) async throws -> T {
    do {
      return try await operation()
    } catch {
      throw ShepherdError.from(error, route: route)
    }
  }

  // MARK: - Events

  /// Drains `events` until it finishes or the calling task is cancelled. The
  /// app never calls this itself: `start()` runs it in the task it owns.
  public func consume(_ events: AsyncStream<ServerEvent>) async {
    for await event in events { apply(event) }
  }

  /// The most frames the store holds while a snapshot load is in flight.
  /// Matches `EventStream`'s own buffer, and is unreachable in practice: a
  /// load is three HTTP calls.
  private static let maxBufferedEvents = 256

  public func apply(_ event: ServerEvent) {
    // A snapshot load is in flight: hold the frame and replay it once the
    // snapshot lands. Applying it now would let the older lists the server is
    // about to return overwrite it.
    if loadsInFlight > 0 {
      if bufferedEvents.count >= Self.maxBufferedEvents {
        bufferedEvents.removeFirst()
        ShepherdLog.store.notice("the event buffer is full; dropped the oldest frame")
      }
      bufferedEvents.append(event)
      return
    }
    applyNow(event)
  }

  /// Replay what arrived during the load, oldest first, now that the snapshot
  /// is installed.
  private func drainBufferedEvents() {
    guard !bufferedEvents.isEmpty else { return }
    let pending = bufferedEvents
    bufferedEvents = []
    ShepherdLog.store.debug(
      "replaying \(pending.count, privacy: .public) events buffered during a load")
    for event in pending { applyNow(event) }
  }

  private func applyNow(_ event: ServerEvent) {
    switch event {
    case .sessionNew(let session):
      addSession(session)
    case .sessionStatus(let payload):
      // Patch `status`, and `hasScratchpadFiles` ONLY when this push carried
      // it: a status-only push (e.g. → running) must not clobber the live
      // flag back to falsy.
      patch(id: payload.id) {
        $0.status = payload.status
        if let flag = payload.hasScratchpadFiles { $0.hasScratchpadFiles = flag }
      }
    case .sessionRenamed(let payload):
      patch(id: payload.id) {
        $0.name = payload.name
        $0.branch = payload.branch
      }
    case .sessionReady(let payload):
      patch(id: payload.id) { $0.readyToMerge = payload.ready }
    case .sessionArchived(let payload):
      sessions.removeAll { $0.id == payload.id }
      blocks[payload.id] = nil
    case .sessionBlock(let payload):
      blocks[payload.id] = payload.block
    case .automergeStatus(let status):
      autoMerge[status.repoPath] = status
    case .usageLimits(let limits):
      usageLimits = limits
    case .unknown(let name):
      ShepherdLog.store.debug("ignoring event \(name, privacy: .public)")
    }
  }

  /// Append on `session:new`, ignoring a duplicate id — a push can race the
  /// bootstrap, and the create call also inserts optimistically.
  private func addSession(_ session: Session) {
    guard !sessions.contains(where: { $0.id == session.id }) else { return }
    sessions.append(session)
  }

  /// Mutate one session in place. An unknown id is a no-op, matching the web
  /// store's `if (s) Object.assign(...)`.
  private func patch(id: String, _ mutate: (inout Session) -> Void) {
    guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
    mutate(&sessions[index])
  }

  // MARK: - Commands

  @discardableResult
  public func create(_ input: CreateSessionRequest) async throws -> CreateOutcome {
    do {
      let outcome = try await client.createSession(input)
      // Insert optimistically so the list moves before session:new lands.
      if case .created(let session) = outcome { addSession(session) }
      lastError = nil
      return outcome
    } catch {
      let mapped = ShepherdError.from(error, route: "createSession")
      record(mapped)
      throw mapped
    }
  }

  public func archive(id: String) async throws {
    do {
      try await client.archiveSession(id: id)
      sessions.removeAll { $0.id == id }
      blocks[id] = nil
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "archiveSession")
      record(mapped)
      throw mapped
    }
  }

  public func interrupt(id: String) async throws {
    do {
      try await client.interruptSession(id: id)
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "interruptSession")
      record(mapped)
      throw mapped
    }
  }

  /// Picks the workspace root, which is also what clears a pending first run.
  public func resolveFirstRun(path: String) async throws {
    do {
      _ = try await client.putRepoRoot(path)
      lastError = nil
    } catch {
      let mapped = ShepherdError.from(error, route: "putRepoRoot")
      record(mapped)
      throw mapped
    }
    // refresh() calls publishLoadedState(), so a resolved first run moves
    // `connection` from .firstRunPending to .live without a further hop.
    try await refresh()
  }
}
