import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// The kit's HTTP surface. One instance per active `ServerProfile`.
///
/// Every method maps the generated `Output` enum onto a value or a
/// `ShepherdError`; callers never see generated response cases. The generated
/// client is `Sendable` and this type holds only `let`s, so it is too.
public final class ShepherdClient: Sendable {
  public let profile: ServerProfile

  /// Fires once each time a request comes back 401. The stored token has
  /// already been cleared by then; the app should present a login sheet.
  public let needsLogin: AsyncStream<Void>

  private let generated: Client
  private let credentials: any CredentialStore
  private let needsLoginContinuation: AsyncStream<Void>.Continuation

  /// - Throws: `ServerProfileError` when a `.remote` profile violates the
  ///   https-unless-loopback-or-tailnet policy.
  public init(
    profile: ServerProfile,
    credentials: any CredentialStore,
    urlSession: URLSession = .shared
  ) throws {
    let validated = try profile.validated()
    self.profile = validated
    self.credentials = credentials

    let (stream, continuation) = AsyncStream<Void>.makeStream()
    needsLogin = stream
    needsLoginContinuation = continuation

    let auth = AuthenticationMiddleware(
      store: credentials,
      credentialKey: validated.credentialKey,
      onUnauthorized: { continuation.yield(()) }
    )
    generated = Client(
      serverURL: validated.baseURL,
      transport: URLSessionTransport(configuration: .init(session: urlSession)),
      // The first middleware is the outermost one. Auth runs there so it sees
      // the status the caller will actually be handed: a 401 clears the token
      // and publishes `needsLogin` exactly once, not once per retried attempt.
      middlewares: [auth, RetryingMiddleware()]
    )
  }

  deinit { needsLoginContinuation.finish() }

  /// The token currently in the store, for callers that have to build their
  /// own request — `EventStream` needs it for the WebSocket upgrade.
  public func currentToken() -> String? {
    (try? credentials.load(for: profile.credentialKey))?.token
  }

  // MARK: - Reads

  public func health() async throws -> Components.Schemas.Health {
    do {
      switch try await generated.getHealth(.init()) {
      case .ok(let ok): return try ok.body.json
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getHealth")
      }
    } catch { throw ShepherdError.from(error, route: "getHealth") }
  }

  public func settings() async throws -> Components.Schemas.Settings {
    do {
      switch try await generated.getSettings(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getSettings")
      }
    } catch { throw ShepherdError.from(error, route: "getSettings") }
  }

  public func sessions() async throws -> [Components.Schemas.Session] {
    do {
      switch try await generated.listSessions(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listSessions")
      }
    } catch { throw ShepherdError.from(error, route: "listSessions") }
  }

  public func doneSessions() async throws -> [Components.Schemas.Session] {
    do {
      switch try await generated.listDoneSessions(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listDoneSessions")
      }
    } catch { throw ShepherdError.from(error, route: "listDoneSessions") }
  }

  public func session(id: String) async throws -> Components.Schemas.Session {
    do {
      switch try await generated.getSession(.init(path: .init(id: id))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getSession")
      }
    } catch { throw ShepherdError.from(error, route: "getSession") }
  }

  public func repos() async throws -> Components.Schemas.RepoList {
    do {
      switch try await generated.listRepos(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listRepos")
      }
    } catch { throw ShepherdError.from(error, route: "listRepos") }
  }
}
