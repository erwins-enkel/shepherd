import Foundation
import Testing

@testable import ShepherdKit

/// Sessions mirrored from connected machines (#2762, #2768): the store keeps them in
/// `remoteSessions`, apart from this server's own `sessions`, and default taps keep local notifications separate.
@MainActor
@Suite("SessionStore mirrored sessions", .timeLimit(.minutes(1)))
struct SessionStoreRemoteTests {
  private func makeStore(_ server: FakeShepherdServer) throws -> SessionStore {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    let client = try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
    return SessionStore(client: client, events: nil, reconnectDelay: .milliseconds(20))
  }

  private func stubBootstrap(
    _ server: FakeShepherdServer, sessions: [Session], delay: TimeInterval = 0
  ) throws {
    let body = try Fixtures.json(sessions)
    server.on("GET", "/api/sessions") { _ in FakeResponse(body: body, delay: delay) }
    server.stub(
      "GET", "/api/settings", status: 200, json: try Fixtures.json(Fixtures.settings()))
    server.stub("GET", "/api/repos", status: 200, json: try Fixtures.json(Fixtures.repoList()))
  }

  private func mirrored(
    _ id: String, machine: String = "mac", name: String = "MacBook",
    status: SessionStatus = SessionStatus(known: .running), connected: Bool = true
  ) -> Session {
    var session = Fixtures.session(id: id, desig: "TASK-07", status: status)
    session.host = SessionHost(
      instanceId: machine, name: name, platform: InstancePlatform(known: .macos))
    session.connection = SessionConnection(
      state: .init(known: connected ? .connected : .disconnected), since: 1_790_000_000_000)
    return session
  }

  private func decode(_ json: String) throws -> ServerEvent {
    try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8))
  }

  private func frame(_ name: String, _ payload: some Encodable) throws -> ServerEvent {
    let data = String(decoding: try Fixtures.json(payload), as: UTF8.self)
    return try decode(#"{"event":"\#(name)","data":\#(data)}"#)
  }

  private func eventually(
    timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool
  ) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }

  @Test("a snapshot puts mirrored sessions apart from the server's own")
  func snapshotSplitsMirroredSessions() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "local"), mirrored("remote")])
    let store = try makeStore(server)

    try await store.refresh()

    #expect(store.sessions.map(\.id) == ["local"])
    #expect(store.remoteSessions.map(\.id) == ["remote"])
    #expect(store.session(id: "remote") == nil)
    #expect(store.remoteSession(id: "remote")?.host?.name == "MacBook")
    #expect(store.remoteSession(id: "local") == nil)
  }

  @Test("frames about mirrored sessions patch the mirrored list and reach no tap")
  func mirroredFramesStayOutOfTaps() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "local")])
    let store = try makeStore(server)
    try await store.refresh()
    let tap = store.events()
    let host = try #require(mirrored("remote").host)
    let connection = try #require(mirrored("remote").connection)

    let new = try frame("session:new", mirrored("remote"))
    guard case .mirrored(let frameHost, .sessionNew(_)) = new else {
      Issue.record("expected a mirrored session:new, got \(new)")
      return
    }
    #expect(frameHost == host)
    store.apply(new)
    // The coordinator relays the machine's own frame with its annotation added.
    let hostJSON = String(decoding: try Fixtures.json(host), as: UTF8.self)
    let connectionJSON = String(decoding: try Fixtures.json(connection), as: UTF8.self)
    store.apply(try decode(
      #"{"event":"session:status","data":{"id":"remote","status":"blocked","host":\#(hostJSON),"connection":\#(connectionJSON)}}"#))
    store.apply(.mirrored(host: host, event: .sessionRenamed(
      Components.Schemas.SessionRenamedEvent(id: "remote", name: "renamed", branch: "feat/x"))))
    // A mirrored frame the store does not model is consumed too.
    store.apply(.mirrored(host: host, event: .unknown(name: "session:git", payload: nil)))
    // The first frame any tap sees is this local one.
    store.apply(.sessionStatus(Components.Schemas.SessionStatusEvent(
      id: "local", status: SessionStatus(known: .idle))))

    #expect(store.sessions.map(\.id) == ["local"])
    #expect(store.session(id: "local")?.status.known == .idle)
    let remote = try #require(store.remoteSession(id: "remote"))
    #expect(remote.status.known == .blocked)
    #expect(remote.name == "renamed")
    #expect(remote.branch == "feat/x")

    var iterator = tap.makeAsyncIterator()
    guard case .sessionStatus(let first) = await iterator.next() else {
      Issue.record("the tap's first frame was not the local status")
      return
    }
    #expect(first.id == "local")

    store.apply(.mirrored(host: host, event: .sessionArchived(
      Components.Schemas.SessionArchivedEvent(id: "remote"))))
    #expect(store.remoteSessions.isEmpty)
  }

  @Test("remote:sessions replaces one machine's set and an empty set removes it")
  func remoteSessionsReplacesOneMachine() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(
      server, sessions: [mirrored("a1"), mirrored("b1", machine: "box", name: "Box")])
    let store = try makeStore(server)
    try await store.refresh()
    let tap = store.events()

    store.apply(try frame("remote:sessions", RemoteSessionsEvent(
      instanceId: "mac", sessions: [mirrored("a1", connected: false), mirrored("a2")])))
    #expect(store.remoteSessions.map(\.id) == ["b1", "a1", "a2"])
    #expect(store.remoteSession(id: "a1")?.connection?.state.known == .disconnected)

    store.apply(try frame("remote:sessions", RemoteSessionsEvent(instanceId: "mac", sessions: [])))
    #expect(store.remoteSessions.map(\.id) == ["b1"])

    store.apply(.sessionReady(Components.Schemas.SessionReadyEvent(id: "x", ready: true)))
    var iterator = tap.makeAsyncIterator()
    guard case .sessionReady = await iterator.next() else {
      Issue.record("remote:sessions reached a tap")
      return
    }
  }

  @Test("a mirrored frame that arrives during a snapshot load lands on top of it")
  func mirroredFrameDuringLoadIsReplayed() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [mirrored("remote")], delay: 0.3)
    let store = try makeStore(server)
    let host = try #require(mirrored("remote").host)

    let load = Task { try await store.refresh() }
    #expect(await eventually { server.requests().contains { $0.path == "/api/sessions" } })
    store.apply(.mirrored(host: host, event: .sessionStatus(Components.Schemas.SessionStatusEvent(
      id: "remote", status: SessionStatus(known: .blocked)))))
    try await load.value

    #expect(store.remoteSession(id: "remote")?.status.known == .blocked)
  }

  @Test("a session created on a connected machine joins the mirrored list")
  func createdOnAMachineIsMirrored() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [])
    server.stub("POST", "/api/sessions", status: 201, json: try Fixtures.json(mirrored("remote")))
    let store = try makeStore(server)
    try await store.refresh()

    _ = try await store.create(
      CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "go"))

    #expect(store.sessions.isEmpty)
    #expect(store.remoteSessions.map(\.id) == ["remote"])
  }

  @Test("remote parity applies ready state immediately")
  func remoteReadyState() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [mirrored("remote")])
    let store = try makeStore(server)
    try await store.refresh()
    let host = try #require(mirrored("remote").host)
    store.apply(.mirrored(host: host, event: .sessionReady(.init(id: "remote", ready: true))))
    #expect(store.remoteSession(id: "remote")?.readyToMerge == true)
  }

  @Test("presentation taps opt in and receive validated remote frames after state is updated")
  func presentationTap() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "local"), mirrored("remote")])
    let store = try makeStore(server)
    try await store.refresh()
    let local = store.events()
    let presentation = store.events(includeMirrored: true)
    let host = try #require(mirrored("remote").host)
    store.apply(.mirrored(host: host, event: .sessionReady(.init(id: "remote", ready: true))))
    store.apply(.mirrored(host: host, event: .sessionReady(.init(id: "local", ready: true))))
    store.apply(.sessionReady(.init(id: "local", ready: false)))
    var remoteIterator = presentation.makeAsyncIterator()
    guard case .mirrored(_, .sessionReady(let ready)) = await remoteIterator.next() else {
      Issue.record("missing remote event"); return
    }
    #expect(ready.id == "remote" && store.remoteSession(id: "remote")?.readyToMerge == true)
    var localIterator = local.makeAsyncIterator()
    guard case .sessionReady(let localReady) = await localIterator.next() else {
      Issue.record("default tap received remote event"); return
    }
    #expect(localReady.id == "local" && !localReady.ready)
    await store.stop()
  }

  @Test("remote snapshots preserve failed sources, clear empty sources and reject foreign IDs")
  func remoteSnapshots() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "local"), mirrored("remote")])
    let store = try makeStore(server)
    try await store.refresh()
    let populated = await store.mergingRemoteSnapshots(key: "test", local: ["local": "local"], previous: [:]) { host in
      #expect(host == "mac")
      return ["remote": "remote", "local": "wrong", "foreign": "wrong"]
    }
    #expect(populated == ["local": "local", "remote": "remote"])
    let failed = await store.mergingRemoteSnapshots(key: "test", local: ["local": "new"], previous: populated) { _ in
      throw ShepherdError.transport("disconnected")
    }
    #expect(failed == ["local": "new", "remote": "remote"])
    #expect(store.remoteSnapshotFailures["test"] == ["mac"])
    let empty = await store.mergingRemoteSnapshots(key: "test", local: ["local": "new"], previous: failed) { _ in [:] }
    #expect(empty == ["local": "new"])
    #expect(store.remoteSnapshotFailures["test"] == [])
  }

  @Test("archiving a remote session removes it immediately without waiting for the socket")
  func archiveRemote() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "local"), mirrored("remote")])
    server.stub("DELETE", "/api/sessions/remote", status: 200, json: Data(#"{"ok":true}"#.utf8))
    let store = try makeStore(server)
    try await store.refresh()
    try await store.archive(id: "remote")
    #expect(store.remoteSessions.isEmpty)
    #expect(store.sessions.map(\.id) == ["local"])
  }
  @Test("HTTP session results preserve machine identity and ambiguous IDs stay inoperable")
  func returnedSessionsAndCollisions() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubBootstrap(server, sessions: [Fixtures.session(id: "local"), mirrored("remote")])
    let store = try makeStore(server)
    try await store.refresh()
    var updated = mirrored("remote"); updated.name = "replacement"
    store.acceptSession(updated)
    #expect(store.visibleSession(id: "remote")?.name == "replacement")
    store.acceptSession(mirrored("new"))
    #expect(store.visibleSession(id: "new")?.host?.instanceId == "mac")
    #expect(store.sessions.map(\.id) == ["local"])
    store.acceptSession(mirrored("remote", machine: "other"))
    #expect(store.visibleSession(id: "remote") == nil)
    #expect(!store.canOperateSession(id: "remote"))
    store.acceptSession(mirrored("local"))
    #expect(store.visibleSession(id: "local")?.host == nil)
    let host = try #require(updated.host)
    for (name, body) in [
      ("session:autopilot", #"{"id":"new","enabled":true,"paused":true,"complete":false}"#),
      ("session:plangate", #"{"id":"new","planPhase":"executing"}"#),
      ("session:manual-steps", #"{"id":"new","manualSteps":[{"id":"step","text":"Do it"}]}"#)
    ] { store.apply(.mirrored(host: host, event: .unknown(name: name, payload: Data(body.utf8)))) }
    #expect(store.visibleSession(id: "new")?.autopilotEnabled == true)
    #expect(store.visibleSession(id: "new")?.autopilotPaused == true)
    #expect(store.visibleSession(id: "new")?.planPhase?.rawValue == "executing")
    #expect(store.visibleSession(id: "new")?.manualSteps.count == 1)
  }

}
