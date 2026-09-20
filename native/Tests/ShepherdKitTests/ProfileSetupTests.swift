import Foundation
import Testing

@testable import ShepherdKit

@Suite("ProfileSetup", .timeLimit(.minutes(1)))
struct ProfileSetupTests {
  private func profile(_ server: FakeShepherdServer) -> ServerProfile {
    ServerProfile(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
  }

  /// `POST /api/login`'s 200 declares `Set-Cookie` as a **required** response
  /// header, so the generated type refuses to decode a response without it.
  /// Every login stub has to send one.
  private func stubLogin(_ server: FakeShepherdServer, status: Int = 200) throws {
    let body =
      status == 200
      ? try Fixtures.json(Components.Schemas.Ok(ok: true))
      : try Fixtures.errorJSON("bad password")
    server.on("POST", "/api/login") { _ in
      FakeResponse(
        statusCode: status,
        headers: [
          "Content-Type": "application/json",
          "Set-Cookie": "shepherd_session=fake-session; Path=/; HttpOnly",
        ],
        body: body)
    }
  }

  private func mintedJSON() throws -> Data {
    try Fixtures.json(
      Components.Schemas.AccessTokenMinted(
        token: "shp_minted",
        entry: Components.Schemas.AccessTokenSummary(
          id: "tok_1", name: "Shepherd for Mac (probe)", hint: "…nted",
          createdAt: 1, lastUsedAt: nil, expiresAt: nil, scope: .full)))
  }

  @Test("the token name carries the hostname and fits the contract's 64 chars")
  func tokenName() {
    #expect(ProfileSetup.tokenName(hostName: "probe") == "Shepherd for Mac (probe)")
    let long = ProfileSetup.tokenName(hostName: String(repeating: "x", count: 200))
    #expect(long.count <= 64)
    #expect(long.hasPrefix("Shepherd for Mac ("))
    #expect(long.hasSuffix(")"))
    // The server's `normalizeTokenName` counts UTF-16 code units (JS's
    // `.length`), so a Mac named in emoji has to be measured the same way.
    let emoji = ProfileSetup.tokenName(hostName: String(repeating: "👩‍👩‍👧", count: 40))
    #expect(emoji.utf16.count <= 64)
    #expect(emoji.hasSuffix(")"))
  }

  @Test("login posts the password, mints a full non-expiring token and stores it")
  func loginMintsAndStores() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())
    let credentials = InMemoryCredentialStore()

    let stored = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2", credentials: credentials,
      urlSessionFactory: { _ in server.urlSession() })

    #expect(stored == StoredCredential(token: "shp_minted", tokenId: "tok_1"))
    #expect(try credentials.load(for: "k") == stored)

    let login = try #require(server.requests().first { $0.path == "/api/login" })
    let sent = try JSONDecoder().decode(
      Components.Schemas.LoginRequest.self, from: try #require(login.body))
    #expect(sent.password == "hunter2")

    let mint = try #require(server.requests().first { $0.path == "/api/access-tokens" })
    let mintBody = try JSONDecoder().decode(
      Components.Schemas.AccessTokenMintRequest.self, from: try #require(mint.body))
    #expect(mintBody.scope == .full)
    #expect(mintBody.expiresInDays == nil)
    #expect(mintBody.name.hasPrefix("Shepherd for Mac ("))
  }

  @Test("a custom token name overrides the default on the mint request")
  func loginWithCustomTokenName() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())
    let credentials = InMemoryCredentialStore()

    _ = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2", credentials: credentials,
      tokenName: "Shepherd UI test (probe)",
      urlSessionFactory: { _ in server.urlSession() })

    let mint = try #require(server.requests().first { $0.path == "/api/access-tokens" })
    let mintBody = try JSONDecoder().decode(
      Components.Schemas.AccessTokenMintRequest.self, from: try #require(mint.body))
    #expect(mintBody.name == "Shepherd UI test (probe)")
  }

  @Test("a sweep name revokes every prior token sharing it before minting a fresh one")
  func loginSweepsPriorTokensWithTheSameName() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    let sweepName = "Shepherd UI test (probe)"
    server.stub(
      "GET", "/api/access-tokens", status: 200,
      json: try Fixtures.json(
        Components.Schemas.AccessTokenList(tokens: [
          Components.Schemas.AccessTokenSummary(
            id: "stale-1", name: sweepName, hint: "…ale1",
            createdAt: 1, lastUsedAt: nil, expiresAt: nil, scope: .full),
          Components.Schemas.AccessTokenSummary(
            id: "stale-2", name: sweepName, hint: "…ale2",
            createdAt: 2, lastUsedAt: nil, expiresAt: nil, scope: .full),
          Components.Schemas.AccessTokenSummary(
            id: "unrelated", name: "Shepherd for Mac (someone-else)", hint: "…ther",
            createdAt: 3, lastUsedAt: nil, expiresAt: nil, scope: .full),
        ])))
    server.stub(
      "DELETE", "/api/access-tokens/stale-1", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    server.stub(
      "DELETE", "/api/access-tokens/stale-2", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())
    let credentials = InMemoryCredentialStore()

    let stored = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2", credentials: credentials,
      tokenName: sweepName, sweepPriorTokensNamed: sweepName,
      urlSessionFactory: { _ in server.urlSession() })

    #expect(stored == StoredCredential(token: "shp_minted", tokenId: "tok_1"))
    #expect(
      server.requests().contains {
        $0.method == "DELETE" && $0.path == "/api/access-tokens/stale-1"
      })
    #expect(
      server.requests().contains {
        $0.method == "DELETE" && $0.path == "/api/access-tokens/stale-2"
      })
    #expect(
      !server.requests().contains {
        $0.method == "DELETE" && $0.path == "/api/access-tokens/unrelated"
      })
    // The sweep rides the login cookie, exactly like the mint that follows it.
    let list = try #require(
      server.requests().first { $0.method == "GET" && $0.path == "/api/access-tokens" })
    let cookie = try #require(list.headers["Cookie"])
    #expect(cookie.contains("shepherd_session=fake-session"))
  }

  @Test("a sweep that cannot list tokens does not block the mint")
  func sweepFailureDoesNotBlockTheMint() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    // No stub for GET /api/access-tokens: the fake fails that request.
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())
    let credentials = InMemoryCredentialStore()

    let stored = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2", credentials: credentials,
      sweepPriorTokensNamed: "Shepherd UI test (probe)",
      urlSessionFactory: { _ in server.urlSession() })

    #expect(stored == StoredCredential(token: "shp_minted", tokenId: "tok_1"))
  }

  @Test("the mint call rides the session cookie, not a bearer header")
  func mintUsesTheCookieNotABearer() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())

    _ = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2",
      credentials: InMemoryCredentialStore(),
      urlSessionFactory: { _ in server.urlSession() })

    let mint = try #require(server.requests().first { $0.path == "/api/access-tokens" })
    #expect(mint.headers["Authorization"] == nil)
    // `POST /api/access-tokens` is cookieAuth-only: the server answers a
    // bearer caller with 403, so the login cookie has to reach it.
    let cookie = try #require(mint.headers["Cookie"])
    #expect(cookie.contains("shepherd_session=fake-session"))
  }

  @Test("the session cookie never reaches the shared cookie jar")
  func cookieStaysOutOfTheSharedJar() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())

    let captured = CapturedConfiguration()
    _ = try await ProfileSetup.login(
      profile: profile(server), password: "hunter2",
      credentials: InMemoryCredentialStore(),
      urlSessionFactory: { configuration in
        captured.value = configuration
        return server.urlSession()
      })

    // The configuration production hands to `URLSession` must carry a jar of
    // its own — `HTTPCookieStorage.shared` would outlive the exchange and be
    // visible to every other session in the process.
    let configuration = try #require(captured.value)
    let jar = try #require(configuration.httpCookieStorage)
    #expect(jar !== HTTPCookieStorage.shared)
    #expect(HTTPCookieStorage.shared.cookies(for: server.baseURL)?.isEmpty ?? true)
    // The login cookie can only reach the mint call if the session is
    // actually configured to accept and send cookies at all.
    #expect(configuration.httpShouldSetCookies)
    #expect(configuration.httpCookieAcceptPolicy != .never)
  }

  @Test("a wrong password is unauthenticated and stores nothing")
  func wrongPassword() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server, status: 401)
    let credentials = InMemoryCredentialStore()

    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await ProfileSetup.login(
        profile: profile(server), password: "nope", credentials: credentials,
        urlSessionFactory: { _ in server.urlSession() })
    }
    #expect(try credentials.load(for: "k") == nil)
    // A rejected login must never reach the mint call.
    #expect(server.requests().count == 1)
  }

  @Test("a 403 on the mint is forbidden and stores nothing")
  func mintForbidden() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub(
      "POST", "/api/access-tokens", status: 403,
      json: try Fixtures.errorJSON("not an operator session"))
    let credentials = InMemoryCredentialStore()

    await #expect(throws: ShepherdError.forbidden) {
      _ = try await ProfileSetup.login(
        profile: profile(server), password: "hunter2", credentials: credentials,
        urlSessionFactory: { _ in server.urlSession() })
    }
    #expect(try credentials.load(for: "k") == nil)
  }

  // A 200 is what current servers answer: a full-scope token may revoke
  // itself, so logout really does kill the token server-side.
  @Test("logout revokes the token then clears the Keychain entry")
  func logoutAttemptsRevokeThenClears() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "DELETE", "/api/access-tokens/tok_1", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_minted", tokenId: "tok_1")])

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(server.requests().contains { $0.path == "/api/access-tokens/tok_1" })
    #expect(try credentials.load(for: "k") == nil)
  }

  // Servers from before token self-revocation answer 403
  // `operator_session_required`, because only an operator cookie could manage
  // tokens. The token then outlives the logout server-side; the local entry
  // must go regardless.
  @Test("logout tolerates a 403 from an older server and still clears the Keychain entry")
  func logoutTolerates403FromAnOlderServer() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "DELETE", "/api/access-tokens/tok_1", status: 403,
      json: try Fixtures.errorJSON("operator_session_required"))
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_minted", tokenId: "tok_1")])

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(server.requests().contains { $0.path == "/api/access-tokens/tok_1" })
    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("logout clears locally even when the server is unreachable")
  func logoutClearsWhenUnreachable() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // No stub for the revoke route, so the fake fails the request.
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_minted", tokenId: "tok_1")])

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("logout never puts the token on an insecure remote link")
  func logoutSkipsAnInsecureProfile() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // The fake answers plain http on a host that is neither loopback nor a
    // tailnet name, so a `.remote` profile pointed at it violates the policy.
    // Using the fake's own URL means a revocation that went out anyway would
    // be recorded — the assertion below is about a request that could land.
    let profile = ServerProfile(
      name: "remote", baseURL: server.baseURL, mode: .remote, credentialKey: "k")
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_minted", tokenId: "tok_1")])

    try await ProfileSetup.logout(
      profile: profile, credentials: credentials, urlSession: server.urlSession())

    #expect(server.requests().isEmpty)
    #expect(try credentials.load(for: "k") == nil)
  }

  @Test("logout clears the local entry even when the Keychain read fails")
  func logoutClearsWhenTheKeychainReadFails() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    // A locked Keychain hides the token id, so there is nothing to revoke —
    // but a logout that cannot read must still delete, or the app is stuck
    // holding a credential it can neither use nor get rid of.
    let credentials = FailingCredentialStore()

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(credentials.wasDeleted)
    #expect(server.requests().isEmpty)
  }

  @Test("a Keychain failure after the mint revokes the token instead of orphaning it")
  func mintRevokesWhenTheKeychainSaveFails() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try stubLogin(server)
    server.stub("POST", "/api/access-tokens", status: 201, json: try mintedJSON())
    server.stub(
      "DELETE", "/api/access-tokens/tok_1", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let credentials = SaveFailingCredentialStore()

    await #expect(throws: SaveFailingCredentialStore.SaveFailure.self) {
      _ = try await ProfileSetup.login(
        profile: profile(server), password: "hunter2", credentials: credentials,
        urlSessionFactory: { _ in server.urlSession() })
    }

    // A token the app cannot remember is a token nothing will ever use: it is
    // revoked with the cookie session that is still authenticated here, rather
    // than left in the operator's list for a manual cleanup.
    #expect(
      server.requests().contains {
        $0.method == "DELETE" && $0.path == "/api/access-tokens/tok_1"
      })
  }

  @Test("logout with nothing stored is a no-op")
  func logoutWithoutCredential() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let credentials = InMemoryCredentialStore()

    try await ProfileSetup.logout(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())

    #expect(server.requests().isEmpty)
  }
}

/// A store that reads back empty and refuses every write, standing in for a
/// Keychain that rejects `SecItemAdd` (no unlocked keychain, a denied ACL).
private final class SaveFailingCredentialStore: CredentialStore, @unchecked Sendable {
  struct SaveFailure: Error {}

  func load(for key: String) throws -> StoredCredential? { nil }
  func save(_ credential: StoredCredential, for key: String) throws { throw SaveFailure() }
  func delete(for key: String) throws {}
}

/// The factory closure is `@Sendable`, so the captured configuration needs a
/// box the compiler can prove is safe to write from it.
private final class CapturedConfiguration: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: URLSessionConfiguration?

  var value: URLSessionConfiguration? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return storage
    }
    set {
      lock.lock()
      defer { lock.unlock() }
      storage = newValue
    }
  }
}
