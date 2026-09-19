import Foundation
import Testing

@testable import ShepherdKit

@Suite("ProfileSetup")
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

  // A 200 here is the future server path — self-revocation for a full-scope
  // bearer token isn't live yet, but the stub exercises the success branch
  // for whenever the server-side change lands.
  @Test("logout attempts to revoke the token then clears the Keychain entry")
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

  @Test(
    "logout tolerates today's 403 operator_session_required and still clears the Keychain entry"
  )
  func logoutTolerates403WhenServerRequiresAnOperatorSession() async throws {
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
