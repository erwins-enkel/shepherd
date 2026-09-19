import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// First contact with a server: exchange the operator password for a durable
/// access token, and give it back on logout.
///
/// The password is used exactly once and never persisted. The session cookie
/// lives in an ephemeral `URLSession` that is invalidated as soon as the
/// token has been minted, so nothing cookie-shaped survives this call.
public enum ProfileSetup {
  /// The contract caps `AccessTokenMintRequest.name` at 64 characters.
  private static let maxTokenNameLength = 64

  /// `Shepherd for Mac (<hostname>)`, truncated to fit the contract.
  ///
  /// The trim drops whole characters but measures UTF-16 code units, because
  /// that is what the server's `normalizeTokenName` counts via JavaScript's
  /// `.length`: a Mac named with an emoji would otherwise pass a
  /// 64-character name the server reads as longer.
  public static func tokenName(hostName: String = ProcessInfo.processInfo.hostName) -> String {
    let prefix = "Shepherd for Mac ("
    let budget = maxTokenNameLength - prefix.utf16.count - 1  // the closing paren
    var host = hostName
    while host.utf16.count > budget { host.removeLast() }
    return "\(prefix)\(host))"
  }

  /// Logs in with `password`, mints a full-scope token that never expires,
  /// stores it under `profile.credentialKey`, and discards the cookie.
  ///
  /// - Parameter urlSessionFactory: injected so tests can hand back a session
  ///   wired to `FakeShepherdServer`. Production passes the default, which
  ///   builds a session from the ephemeral configuration below.
  /// - Returns: the credential that was stored.
  @discardableResult
  public static func login(
    profile: ServerProfile,
    password: String,
    credentials: any CredentialStore,
    urlSessionFactory: @Sendable (URLSessionConfiguration) -> URLSession = {
      URLSession(configuration: $0)
    }
  ) async throws -> StoredCredential {
    let validated = try profile.validated()

    // `.ephemeral` gives this exchange its own in-memory cookie jar, distinct
    // from `HTTPCookieStorage.shared`: the shepherd_session cookie never
    // touches process-wide storage and dies with the session.
    //
    // Do NOT swap in a freshly constructed `HTTPCookieStorage()`. That object
    // is not a working jar — it accepts `setCookie` and stores nothing — so
    // the login cookie would be dropped and the mint call, which the contract
    // serves to operator sessions only, would come back 403.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = true
    let session = urlSessionFactory(configuration)
    defer {
      configuration.httpCookieStorage?.removeCookies(since: .distantPast)
      session.invalidateAndCancel()
    }

    // No AuthenticationMiddleware here on purpose: these two calls
    // authenticate with the cookie, and the contract refuses token
    // management from a bearer caller.
    let client = Client(
      serverURL: validated.baseURL,
      transport: URLSessionTransport(configuration: .init(session: session))
    )

    do {
      switch try await client.login(.init(body: .json(.init(password: password)))) {
      case .ok: break
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "login")
      }
    } catch { throw ShepherdError.from(error, route: "login") }

    let minted: Components.Schemas.AccessTokenMinted
    do {
      let request = Components.Schemas.AccessTokenMintRequest(
        name: tokenName(), expiresInDays: nil, scope: .full)
      switch try await client.mintAccessToken(.init(body: .json(request))) {
      case .created(let created): minted = try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .forbidden: throw ShepherdError.forbidden
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "mintAccessToken")
      }
    } catch { throw ShepherdError.from(error, route: "mintAccessToken") }

    let credential = StoredCredential(token: minted.token, tokenId: minted.entry.id)
    do {
      try credentials.save(credential, for: validated.credentialKey)
    } catch {
      // The token exists on the server but the app cannot remember it: revoke
      // it rather than leave an orphan in the operator's token list, which
      // nothing would ever use and only a manual revocation could clean up.
      // Best effort, and it has to happen here — the cookie session that is
      // allowed to manage tokens dies with the `defer` above.
      ShepherdLog.client.notice(
        "could not store the minted token; revoking it instead of leaving it orphaned")
      _ = try? await client.revokeAccessToken(.init(path: .init(id: minted.entry.id)))
      throw error
    }
    ShepherdLog.client.notice(
      "minted an access token for \(validated.name, privacy: .public)")
    return credential
  }

  /// Attempts to revoke the stored token, and always clears the local entry.
  /// A logout must never leave the app holding a token it believes is valid.
  ///
  /// If the profile fails the remote-URL security policy, the revocation is
  /// skipped entirely — the token never goes on the wire — and only the
  /// local credential is cleared.
  public static func logout(
    profile: ServerProfile,
    credentials: any CredentialStore,
    urlSession: URLSession = .shared
  ) async throws {
    // A read that fails must not abort the logout: without the token id there
    // is nothing to revoke, but the local entry is still deleted below. This
    // is the one place where "I could not read the Keychain" and "there is
    // nothing stored" may be treated alike.
    let stored: StoredCredential?
    do {
      stored = try credentials.load(for: profile.credentialKey)
    } catch {
      // Never the item, only the failure that reading it produced.
      ShepherdLog.credentials.error(
        """
        could not read the credential to revoke it: \
        \(String(describing: error), privacy: .public) — clearing locally anyway
        """)
      stored = nil
    }
    // The revocation carries the token in an Authorization header, so it is a
    // request the remote-URL policy governs. A profile that fails it is still
    // logged out locally — it just never gets the token put on the wire.
    guard let credential = stored, (try? profile.validated()) != nil else {
      if stored != nil {
        ShepherdLog.client.notice("profile is not safe to reach; skipping the revocation")
      }
      try credentials.delete(for: profile.credentialKey)
      return
    }

    // The revoke is attempted with the bearer token that authenticates this
    // client. Current servers let a token revoke itself — `DELETE
    // /api/access-tokens/{id}` accepts the bearer caller when the id is its
    // own — so this call succeeds and the token is dead server-side too. A
    // server from before that change answers 403 `operator_session_required`,
    // because only an operator cookie could manage tokens; the token then
    // stays valid until it expires or an operator revokes it in the web UI.
    // Either way, the local credential is always cleared below.
    let client = Client(
      serverURL: profile.baseURL,
      transport: URLSessionTransport(configuration: .init(session: urlSession)),
      middlewares: [
        AuthenticationMiddleware(
          store: credentials, credentialKey: profile.credentialKey, onUnauthorized: {})
      ]
    )
    do {
      switch try await client.revokeAccessToken(.init(path: .init(id: credential.tokenId))) {
      case .ok:
        ShepherdLog.client.notice("revoked the access token")
      // A logged-out app holds no operator session, and the contract serves
      // token management to operator sessions only. None of these may stop
      // the local clear.
      case .unauthorized, .forbidden, .notFound:
        ShepherdLog.client.notice("the server declined the revocation; clearing locally anyway")
      case .undocumented(let statusCode, _):
        ShepherdLog.client.notice(
          "undocumented \(statusCode, privacy: .public) on the revocation; clearing locally anyway")
      }
    } catch {
      ShepherdLog.client.notice("token revocation failed; clearing locally anyway")
    }

    // Whatever the server said, the app stops holding the token.
    try credentials.delete(for: profile.credentialKey)
  }
}
