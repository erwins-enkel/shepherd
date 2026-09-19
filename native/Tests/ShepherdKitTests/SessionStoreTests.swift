import Foundation
import Testing

@testable import ShepherdKit

@MainActor
@Suite("SessionStore")
struct SessionStoreTests {
  /// A store with no event socket: `start()` bootstraps and returns, which is
  /// what makes the connection-state transitions testable without a listener.
  ///
  /// `maxReconnectDelay` defaults far below the production 30 s ceiling so a
  /// test that lets the bootstrap retry loop back off a few times does not
  /// itself slow down.
  private func makeStore(
    _ server: FakeShepherdServer,
    reconnectDelay: Duration = .milliseconds(20),
    maxReconnectDelay: Duration = .milliseconds(200)
  ) throws -> SessionStore {
    SessionStore(
      client: try makeClient(server),
      events: nil,
      reconnectDelay: reconnectDelay,
      maxReconnectDelay: maxReconnectDelay)
  }

  /// A store wired to a real `/events` socket, for the lifecycle tests that
  /// have to prove `start()` keeps consuming and `stop()` ends the consumer.
  private func makeLiveStore(
    _ server: FakeShepherdServer,
    events: FakeEventServer,
    reconnectDelay: Duration = .milliseconds(20),
    maxReconnectDelay: Duration = .milliseconds(200)
  ) throws -> SessionStore {
    SessionStore(
      client: try makeClient(server),
      events: EventStream(
        baseURL: events.url,
        tokenProvider: { "shp_test" },
        reconnectDelay: .milliseconds(50)),
      reconnectDelay: reconnectDelay,
      maxReconnectDelay: maxReconnectDelay)
  }

  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  /// Polls `condition` on the main actor until it holds or the deadline passes.
  /// `start()` runs in its own task, so its transitions are observed, not awaited.
  private func eventually(
    timeout: Duration = .seconds(5),
    _ condition: @MainActor () -> Bool
  ) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }

  private func stubBootstrap(
    _ server: FakeShepherdServer,
    sessions: [Session] = [],
    firstRunPending: Bool = false
  ) throws {
    server.stub("GET", "/api/sessions", status: 200, json: try Fixtures.json(sessions))
    server.stub(
      "GET", "/api/settings", status: 200,
      json: try Fixtures.json(Fixtures.settings(firstRunPending: firstRunPending)))
    server.stub("GET", "/api/repos", status: 200, json: try Fixtures.json(Fixtures.repoList()))
  }

  private func statusEvent(
    id: String, status: SessionStatus, hasScratchpadFiles: Bool? = nil
  ) -> ServerEvent {
    .sessionStatus(
      Components.Schemas.SessionStatusEvent(
        id: id, status: status, hasScratchpadFiles: hasScratchpadFiles))
  }

  /// One `/events` frame for the fake socket, built from the generated type so
  /// the JSON can never drift from the contract.
  private func frame(_ name: String, _ payload: some Encodable) throws -> String {
    let data = try Fixtures.json(payload)
    return #"{"event":"\#(name)","data":\#(String(decoding: data, as: UTF8.self))}"#
  }

  // MARK: connection state

  @Test("a store that has not started is idle")
  func idleBeforeStart() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    #expect(try makeStore(server).connection == .idle)
  }

  @Test("start() bootstraps and goes live")
  func startGoesLive() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)

    await store.start()

    #expect(store.connection == .live)
    #expect(store.sessions.map(\.id) == ["a"])
  }

  @Test("the store is connecting while the bootstrap is in flight")
  func connectingWhileBootstrapIsInFlight() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    // A slow list keeps the bootstrap in flight long enough to observe the
    // state the app renders as a spinner.
    server.on("GET", "/api/sessions") { _ in
      Thread.sleep(forTimeInterval: 0.4)
      return FakeResponse(statusCode: 200, body: try Fixtures.json([Session]()))
    }
    let store = try makeStore(server)

    let runner = Task { await store.start() }
    #expect(await eventually { store.connection == .connecting })
    await runner.value
    #expect(store.connection == .live)
  }

  @Test("a pending first run is its own connection state")
  func startReportsFirstRun() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, firstRunPending: true)
    let store = try makeStore(server)

    await store.start()
    #expect(store.connection == .firstRunPending)
  }

  @Test("resolving first run moves the connection to live")
  func resolvingFirstRunGoesLive() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, firstRunPending: true)
    server.stub(
      "PUT", "/api/settings", status: 200,
      json: try Fixtures.json(
        Components.Schemas.RepoRootResponse(
          repoRoot: "/repos", repoRootDisplay: "~/repos")))
    let store = try makeStore(server)
    await store.start()
    #expect(store.connection == .firstRunPending)

    server.stub(
      "GET", "/api/settings", status: 200,
      json: try Fixtures.json(Fixtures.settings(firstRunPending: false)))
    try await store.resolveFirstRun(path: "/repos")

    #expect(store.connection == .live)
  }

  @Test("a 401 during bootstrap becomes needsLogin and stops")
  func unauthorizedBootstrapBecomesNeedsLogin() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub("GET", "/api/sessions", status: 401, json: try Fixtures.errorJSON("unauthorized"))
    let store = try makeStore(server)

    await store.start()

    #expect(store.connection == .needsLogin)
    #expect(store.lastError == .unauthenticated)
  }

  @Test("an unreachable server is offline, and stop() ends the retry loop")
  func unreachableBecomesOfflineAndStopEndsTheLoop() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // Not a single stub: every request fails, which is what a dead server
    // looks like from here.
    let store = try makeStore(server)

    let runner = Task { await store.start() }
    #expect(
      await eventually {
        if case .offline = store.connection { return true }
        return false
      })

    store.stop()
    _ = await runner.value
    #expect(store.connection == .idle)
  }

  @Test("a bootstrap failure that is not transport is offline too")
  func contractFailureIsOffline() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // 500 is undocumented on every bootstrap route, so this maps to
    // .contractMismatch — the state machine's "anything else" row.
    for path in ["/api/sessions", "/api/settings", "/api/repos"] {
      server.stub("GET", path, status: 500, json: Data("{}".utf8))
    }
    let store = try makeStore(server)

    let runner = Task { await store.start() }
    #expect(
      await eventually {
        if case .offline = store.connection { return true }
        return false
      })
    if case .contractMismatch = store.lastError {} else {
      Issue.record("expected a contract mismatch, got \(String(describing: store.lastError))")
    }

    store.stop()
    _ = await runner.value
  }

  @Test("an offline store retries and goes live when the server comes back")
  func offlineRetriesUntilTheServerAnswers() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let store = try makeStore(server)

    let runner = Task { await store.start() }
    #expect(
      await eventually {
        if case .offline = store.connection { return true }
        return false
      })

    // The retry timer fires while start() is still running, so the next pass
    // re-bootstraps — which is also what closes any gap in the event stream.
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    #expect(await eventually { store.connection == .live })
    _ = await runner.value
    #expect(store.sessions.map(\.id) == ["a"])
  }

  @Test("a 401 on a command publishes needsLogin")
  func commandUnauthorizedPublishesNeedsLogin() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub("POST", "/api/sessions", status: 401, json: try Fixtures.errorJSON("unauthorized"))
    let store = try makeStore(server)
    await store.start()
    #expect(store.connection == .live)

    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await store.create(
        CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))
    }
    #expect(store.connection == .needsLogin)
  }

  @Test("the self-driving initialiser refuses an insecure remote profile")
  func convenienceInitRefusesInsecureProfile() throws {
    let profile = ServerProfile(
      name: "box", baseURL: URL(string: "http://box.example.com")!, mode: .remote)
    #expect(throws: ServerProfileError.insecureRemoteURL("box.example.com")) {
      _ = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
    }
  }

  @Test("stop() during a slow bootstrap leaves no reconnecting socket behind")
  func stopDuringBootstrapTearsTheSocketDown() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    // Keep the bootstrap in flight long enough for stop() to land while
    // start() is still awaiting it. The socket is now opened *before* the
    // snapshot — that is what closes the subscribe-after-snapshot gap — so the
    // invariant is no longer "the socket never opened" but "whatever was
    // opened is closed and does not come back".
    http.on("GET", "/api/sessions") { _ in
      Thread.sleep(forTimeInterval: 0.3)
      return FakeResponse(statusCode: 200, body: try Fixtures.json([Session]()))
    }
    let store = try makeLiveStore(http, events: events)

    let runner = Task { await store.start() }
    #expect(await eventually { store.connection == .connecting })
    store.stop()

    // The bootstrap's Thread.sleep(0.3s) bounds how long this can take: if
    // start() parked on a consumer nobody cancelled, this await would hang
    // well past that.
    _ = await runner.value

    #expect(store.connection == .idle)
    // A stream that was not stopped reconnects every 50 ms, so a count that
    // stands still across several of those windows is the proof.
    events.closeCurrentConnection()
    let afterStop = events.connectionCount()
    try? await Task.sleep(for: .milliseconds(300))
    #expect(events.connectionCount() == afterStop)
  }

  @Test("a store that goes out of scope stops the events socket")
  func deinitStopsTheEventStream() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    // The stream is held by the test on purpose: its receive loop keeps the
    // actor alive whatever the store does, which is exactly why a dropped
    // store has to stop it rather than rely on ARC.
    let stream = EventStream(
      baseURL: events.url, tokenProvider: { "shp_test" }, reconnectDelay: .milliseconds(50))
    var store: SessionStore? = SessionStore(client: try makeClient(http), events: stream)
    #expect(store?.connection == .idle)
    await stream.start()
    #expect(await eventually { events.connectionCount() == 1 })

    // Releasing the last reference runs `deinit`, which cancels the store's
    // tasks and stops the stream.
    store = nil
    #expect(store == nil)
    try? await Task.sleep(for: .milliseconds(200))

    events.closeCurrentConnection()
    let afterRelease = events.connectionCount()
    #expect(afterRelease == 1)
    try? await Task.sleep(for: .milliseconds(400))
    #expect(events.connectionCount() == afterRelease)
  }

  @Test("bootstrap retries back off exponentially")
  func bootstrapRetryBacksOff() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // Every bootstrap request fails until the test stubs it, so start()
    // must retry with growing (capped) delays rather than a fixed one.
    let store = try makeStore(
      server, reconnectDelay: .milliseconds(20), maxReconnectDelay: .milliseconds(200))

    let runner = Task { await store.start() }
    #expect(
      await eventually {
        if case .offline = store.connection { return true }
        return false
      })

    // Give the retry loop several backoff cycles to run (20, 40, 80, 160,
    // capped at 200ms...) while every attempt still fails, then confirm more
    // than one retry actually happened.
    try? await Task.sleep(for: .milliseconds(400))
    let attemptsWhileFailing = server.requests().count
    #expect(attemptsWhileFailing >= 2)

    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    #expect(await eventually { store.connection == .live })
    _ = await runner.value
    #expect(store.sessions.map(\.id) == ["a"])
  }

  // MARK: live socket

  @Test("a started store applies socket events, and stop() ends the consumer")
  func liveSocketFeedsTheStore() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    let store = try makeLiveStore(http, events: events)

    let runner = Task { await store.start() }
    #expect(await eventually { store.connection == .live })
    #expect(await eventually { events.connectionCount() == 1 })

    events.send(try frame("session:new", Fixtures.session(id: "a")))
    #expect(await eventually { store.sessions.map(\.id) == ["a"] })

    // `start()` only returns once the consuming task it owns has finished, and
    // the events stream never finishes on its own — so the runner returning is
    // proof that stop() cancelled the consumer.
    store.stop()
    _ = await runner.value
    #expect(store.connection == .idle)
  }

  @Test("a frame that lands during the bootstrap is applied on top of the snapshot")
  func frameDuringBootstrapSurvivesTheSnapshot() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    let ready = try frame(
      "session:ready", Components.Schemas.SessionReadyEvent(id: "a", ready: true))
    // The handler emits the frame itself and only then answers, so the frame
    // is guaranteed to be in flight while the snapshot fetch is. It waits for
    // the presence frame first: that is the proof the socket is adopted and a
    // send will actually reach the client.
    http.on("GET", "/api/sessions") { _ in
      let deadline = ContinuousClock.now.advanced(by: .seconds(5))
      while events.receivedTexts().isEmpty, ContinuousClock.now < deadline {
        Thread.sleep(forTimeInterval: 0.01)
      }
      events.send(ready)
      Thread.sleep(forTimeInterval: 0.3)
      return FakeResponse(statusCode: 200, body: try Fixtures.json([Fixtures.session(id: "a")]))
    }
    let store = try makeLiveStore(http, events: events)

    let runner = Task { await store.start() }
    #expect(await eventually { store.connection == .live })
    // The snapshot says `readyToMerge == false`; the frame that raced it says
    // true. Applied before the snapshot instead of after, it would be lost.
    #expect(await eventually { store.session(id: "a")?.readyToMerge == true })

    store.stop()
    _ = await runner.value
  }

  @Test("a reconnect re-reads the snapshot")
  func reconnectRefreshesTheSnapshot() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    let store = try makeLiveStore(http, events: events)

    let runner = Task { await store.start() }
    #expect(await eventually { store.connection == .live })
    let afterBootstrap = http.requests().filter { $0.path == "/api/sessions" }.count

    // A socket that went away may have missed pushes — the stream keeps only
    // the newest 256 frames — so the store must re-read the lists rather than
    // trust the snapshot it loaded before the gap.
    try stubBootstrap(http, sessions: [Fixtures.session(id: "late")])
    events.closeCurrentConnection()

    #expect(await eventually { store.sessions.map(\.id) == ["late"] })
    #expect(http.requests().filter { $0.path == "/api/sessions" }.count > afterBootstrap)

    store.stop()
    _ = await runner.value
  }

  @Test("a lost socket is connecting, not offline, and a reconnect returns to live")
  func disconnectIsConnectingThenLive() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    // A 30 s socket backoff makes this deterministic: after the close the
    // store stays `.connecting` until the test asks for the reconnect itself,
    // so there is no timing window for a loaded machine to miss.
    let stream = EventStream(
      baseURL: events.url, tokenProvider: { "shp_test" }, reconnectDelay: .seconds(30))
    let store = SessionStore(
      client: try makeClient(http), events: stream,
      reconnectDelay: .milliseconds(20), maxReconnectDelay: .milliseconds(200))

    let runner = Task { await store.start() }
    #expect(await eventually { store.connection == .live })

    events.closeCurrentConnection()
    // Nothing has failed for good: the stream is already reconnecting, so this
    // is `.connecting` and never `.offline`.
    #expect(await eventually { store.connection == .connecting })

    await stream.reconnectNow()
    #expect(await eventually { store.connection == .live })

    store.stop()
    _ = await runner.value
  }

  @Test("setActive forwards the app's focus to the socket")
  func setActiveForwardsPresence() async throws {
    let http = FakeShepherdServer()
    defer { http.tearDown() }
    let events = try FakeEventServer()
    defer { events.stop() }
    try stubBootstrap(http)
    let store = try makeLiveStore(http, events: events)

    let runner = Task { await store.start() }
    #expect(await eventually { events.receivedTexts().contains { $0.contains("\"active\":false") } })

    await store.setActive(true)
    #expect(await eventually { events.receivedTexts().contains { $0.contains("\"active\":true") } })

    store.stop()
    _ = await runner.value
  }

  // MARK: bootstrap

  @Test("bootstrap loads sessions, settings and repos")
  func bootstrapLoadsEverything() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a"), Fixtures.session(id: "b")])
    let store = try makeStore(server)

    try await store.bootstrap()

    #expect(store.sessions.map(\.id) == ["a", "b"])
    #expect(store.settings?.repoRoot == "/repos")
    #expect(store.repos.map(\.name) == ["demo"])
    #expect(store.firstRunPending == false)
  }

  @Test("firstRunPending reflects settings")
  func firstRunPendingFlag() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, firstRunPending: true)
    let store = try makeStore(server)

    try await store.bootstrap()
    #expect(store.firstRunPending == true)
  }

  @Test("an event that lands during a refresh is not undone by the snapshot")
  func eventDuringRefreshSurvivesTheSnapshot() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a"), Fixtures.session(id: "b")])
    let store = try makeStore(server)
    try await store.bootstrap()

    // The snapshot this refresh installs still lists "a": the archive that
    // lands while the fetches are in flight has to win anyway.
    server.on("GET", "/api/sessions") { _ in
      Thread.sleep(forTimeInterval: 0.3)
      return FakeResponse(
        statusCode: 200,
        body: try Fixtures.json([Fixtures.session(id: "a"), Fixtures.session(id: "b")]))
    }

    let refreshing = Task { try await store.refresh() }
    try? await Task.sleep(for: .milliseconds(50))
    store.apply(.sessionArchived(Components.Schemas.SessionArchivedEvent(id: "a")))
    try await refreshing.value

    #expect(store.sessions.map(\.id) == ["b"])
    #expect(store.blocks["a"] == nil)
  }

  @Test("a superseded refresh does not install its older snapshot")
  func supersededRefreshIsDropped() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    // The first refresh's list is slow and therefore stale by the time it
    // arrives; the second one's is immediate.
    let calls = Box(0)
    server.on("GET", "/api/sessions") { _ in
      let call = calls.get()
      calls.set(call + 1)
      if call == 0 {
        Thread.sleep(forTimeInterval: 0.4)
        return FakeResponse(
          statusCode: 200, body: try Fixtures.json([Fixtures.session(id: "stale")]))
      }
      return FakeResponse(statusCode: 200, body: try Fixtures.json([Fixtures.session(id: "fresh")]))
    }

    let slow = Task { try await store.refresh() }
    try? await Task.sleep(for: .milliseconds(50))
    try await store.refresh()
    #expect(store.sessions.map(\.id) == ["fresh"])

    try await slow.value
    // The slow snapshot lands last and is dropped: its generation is stale.
    #expect(store.sessions.map(\.id) == ["fresh"])
  }

  @Test("a 401 that lands after stop() leaves the store idle")
  func unauthorizedAfterStopStaysIdle() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub("POST", "/api/sessions", status: 401, json: try Fixtures.errorJSON("unauthorized"))
    let store = try makeStore(server)
    await store.start()
    store.stop()
    #expect(store.connection == .idle)

    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await store.create(
        CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))
    }
    // The operator asked for idle: a late 401 records the error but must not
    // repaint the connection.
    #expect(store.connection == .idle)
    #expect(store.lastError == .unauthenticated)
  }

  @Test("the store exposes the client so an app can consume needsLogin")
  func exposesTheClient() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let store = try makeStore(server)
    // The store never consumes `needsLogin` itself (that stream has a single
    // consumer); reaching it through `store.client` is how an app built with
    // `init(profile:credentials:)` hears about a 401 it did not cause.
    #expect(store.client.profile.credentialKey == "k")
  }

  // MARK: apply

  @Test("session:new appends, and a duplicate id is ignored")
  func applySessionNew() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.sessionNew(Fixtures.session(id: "a")))
    store.apply(.sessionNew(Fixtures.session(id: "a", name: "duplicate")))

    #expect(store.sessions.map(\.id) == ["a"])
    #expect(store.sessions[0].name == "session")
  }

  @Test("session:status patches status without clobbering the scratchpad flag")
  func applyStatusKeepsScratchpadFlag() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(
      statusEvent(
        id: "a", status: SessionStatus(known: .idle), hasScratchpadFiles: true))
    #expect(store.session(id: "a")?.status.known == .idle)
    #expect(store.session(id: "a")?.hasScratchpadFiles == true)

    // A status-only push must not reset the live flag to falsy.
    store.apply(statusEvent(id: "a", status: SessionStatus(known: .running)))
    #expect(store.session(id: "a")?.status.known == .running)
    #expect(store.session(id: "a")?.hasScratchpadFiles == true)
  }

  @Test("a status value this client does not know is still stored")
  func applyUnknownStatusValue() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(statusEvent(id: "a", status: SessionStatus(unknown: "quiescing")))
    #expect(store.session(id: "a")?.status.known == nil)
    #expect(store.session(id: "a")?.status.rawValue == "quiescing")
  }

  @Test("a status for an unknown id is ignored")
  func applyStatusUnknownId() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(statusEvent(id: "ghost", status: SessionStatus(known: .done)))
    #expect(store.sessions.isEmpty)
  }

  @Test("session:renamed patches name and branch")
  func applyRenamed() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a", branch: "old")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(
      .sessionRenamed(
        Components.Schemas.SessionRenamedEvent(
          id: "a", name: "fresh", branch: "feat/x")))
    #expect(store.session(id: "a")?.name == "fresh")
    #expect(store.session(id: "a")?.branch == "feat/x")
  }

  @Test("session:ready patches readyToMerge")
  func applyReady() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
    #expect(store.session(id: "a")?.readyToMerge == true)
  }

  @Test("session:block sets then clears the block")
  func applyBlock() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    let reason = Components.Schemas.BlockReason(
      shape: Components.Schemas.BlockReason.ShapePayload(known: .stall),
      options: [], tail: ["waiting"])
    store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(id: "a", block: reason)))
    #expect(store.blocks["a"]?.shape.rawValue == "stall")

    store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(id: "a", block: nil)))
    #expect(store.blocks["a"] == nil)
  }

  @Test("session:archived removes the row and its block")
  func applyArchived() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a"), Fixtures.session(id: "b")])
    let store = try makeStore(server)
    try await store.bootstrap()
    store.apply(
      .sessionBlock(
        Components.Schemas.SessionBlockEvent(
          id: "a",
          block: Components.Schemas.BlockReason(
            shape: Components.Schemas.BlockReason.ShapePayload(known: .stall),
            options: [], tail: []))))

    store.apply(.sessionArchived(Components.Schemas.SessionArchivedEvent(id: "a")))

    #expect(store.sessions.map(\.id) == ["b"])
    #expect(store.blocks["a"] == nil)
  }

  @Test("automerge:status is keyed by repoPath and usage:limits replaces wholesale")
  func applyGlobals() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(
      .automergeStatus(
        Components.Schemas.AutoMergeStatus(
          repoPath: "/repos/demo", enabled: true, state: "waiting", detail: nil, sessionId: "a")))
    #expect(store.autoMerge["/repos/demo"]?.enabled == true)

    store.apply(
      .usageLimits(
        Components.Schemas.UsageLimits(
          session5h: nil, week: nil, perModelWeek: [], credits: nil,
          stale: true, calibratedAt: nil, subscriptionOnly: false)))
    #expect(store.usageLimits?.stale == true)
  }

  @Test("an unknown event changes nothing")
  func applyUnknown() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    let store = try makeStore(server)
    try await store.bootstrap()

    store.apply(.unknown(name: "epic:progress"))
    #expect(store.sessions.map(\.id) == ["a"])
  }

  // MARK: commands

  @Test("create adds the session immediately")
  func createAddsSession() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub(
      "POST", "/api/sessions", status: 201,
      json: try Fixtures.json(Fixtures.session(id: "new")))
    let store = try makeStore(server)
    try await store.bootstrap()

    let outcome = try await store.create(
      CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))

    #expect(outcome == .created(Fixtures.session(id: "new")))
    #expect(store.sessions.map(\.id) == ["new"])
  }

  @Test("a held create adds nothing")
  func createHeldAddsNothing() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub(
      "POST", "/api/sessions", status: 200,
      json: try Fixtures.json(HeldTask(held: true, id: "h", count: 1)))
    let store = try makeStore(server)
    try await store.bootstrap()

    _ = try await store.create(
      CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))
    #expect(store.sessions.isEmpty)
  }

  @Test("archive drops the row without waiting for the event")
  func archiveDropsRow() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    server.stub(
      "DELETE", "/api/sessions/a", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let store = try makeStore(server)
    try await store.bootstrap()

    try await store.archive(id: "a")
    #expect(store.sessions.isEmpty)
  }

  @Test("interrupt leaves the row alone")
  func interruptKeepsRow() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "a")])
    server.stub(
      "POST", "/api/sessions/a/interrupt", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let store = try makeStore(server)
    try await store.bootstrap()

    try await store.interrupt(id: "a")
    #expect(store.sessions.map(\.id) == ["a"])
  }

  @Test("resolveFirstRun stores the root and reloads")
  func resolveFirstRun() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, firstRunPending: true)
    server.stub(
      "PUT", "/api/settings", status: 200,
      json: try Fixtures.json(
        Components.Schemas.RepoRootResponse(
          repoRoot: "/repos", repoRootDisplay: "~/repos")))
    let store = try makeStore(server)
    try await store.bootstrap()
    #expect(store.firstRunPending == true)

    // After the root is set the server stops reporting first run.
    server.stub(
      "GET", "/api/settings", status: 200,
      json: try Fixtures.json(Fixtures.settings(firstRunPending: false)))
    try await store.resolveFirstRun(path: "/repos")

    #expect(store.firstRunPending == false)
    #expect(server.requests().contains { $0.method == "PUT" && $0.path == "/api/settings" })
  }

  @Test("a failed command records lastError and rethrows")
  func failedCommandRecordsError() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    server.stub(
      "POST", "/api/sessions", status: 409,
      json: try Fixtures.errorJSON("first_run_pending"))
    let store = try makeStore(server)
    try await store.bootstrap()

    await #expect(throws: ShepherdError.firstRunPending) {
      _ = try await store.create(
        CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))
    }
    #expect(store.lastError == .firstRunPending)
  }

  @Test("consume() applies a whole stream of events")
  func consumeStream() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server)
    let store = try makeStore(server)
    try await store.bootstrap()

    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream()
    continuation.yield(.sessionNew(Fixtures.session(id: "a")))
    continuation.yield(.sessionReady(Components.Schemas.SessionReadyEvent(id: "a", ready: true)))
    continuation.finish()

    await store.consume(stream)

    #expect(store.sessions.map(\.id) == ["a"])
    #expect(store.session(id: "a")?.readyToMerge == true)
  }
}
