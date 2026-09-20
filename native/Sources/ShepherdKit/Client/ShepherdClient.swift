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

  /// Fires when a request that carried a credential comes back 401 — an
  /// anonymous request answered with 401 fires nothing, since it says
  /// nothing about the stored token. The stored token has already been
  /// cleared by then; the app should present a login sheet.
  ///
  /// There is only one consumer. Repeated 401s while that signal is still
  /// pending coalesce into a single buffered element rather than piling up.
  public let needsLogin: AsyncStream<Void>

  /// The generated client, `internal` on purpose: the per-stream wrappers
  /// (`ShepherdClient+Terminal.swift`, `+Detail.swift`, `+Backlog.swift`,
  /// `+Actions.swift`) live in other files of THIS module and could not reach a
  /// `private` property. Never `public` — the whole point of this type is that
  /// callers outside the kit never see generated `Output` cases. The guard that
  /// it stays exactly here is `GeneratedClientVisibilityTests`.
  let generated: Client

  /// Opt-in generated client for slow operations in per-stream wrappers.
  /// Shares credentials, logout signals and retry policy with `generated`,
  /// but waits up to 300 seconds for response data by default.
  let longRunning: Client
  /// Owned by this client and invalidated on deinit. Stream wrappers use
  /// `longRunning`; internal visibility lets tests inspect its configuration.
  let longRunningURLSession: URLSession
  private let credentials: any CredentialStore
  private let needsLoginContinuation: AsyncStream<Void>.Continuation

  /// - Throws: `ServerProfileError` when a `.remote` profile violates the
  ///   https-unless-loopback-or-tailnet policy.
  /// - Parameters:
  ///   - urlSession: The unchanged session used by ordinary operations.
  ///   - longRunningRequestTimeout: Request timeout for opt-in slow operations.
  ///     Their dedicated session copies `urlSession.configuration` (not its
  ///     delegate) and raises the resource timeout to at least this value.
  public init(
    profile: ServerProfile,
    credentials: any CredentialStore,
    urlSession: URLSession = .shared,
    longRunningRequestTimeout: TimeInterval = 300,
    readOnlyAudit: ReadOnlyRequestAudit? = nil
  ) throws {
    precondition(longRunningRequestTimeout.isFinite && longRunningRequestTimeout > 0)
    let validated = try profile.validated()
    self.profile = validated
    self.credentials = credentials

    let (stream, continuation) = AsyncStream<Void>.makeStream(
      bufferingPolicy: .bufferingNewest(1))
    needsLogin = stream
    needsLoginContinuation = continuation

    let auth = AuthenticationMiddleware(
      store: credentials,
      credentialKey: validated.credentialKey,
      onUnauthorized: { continuation.yield(()) }
    )
    let configuration = urlSession.configuration
    configuration.timeoutIntervalForRequest = longRunningRequestTimeout
    configuration.timeoutIntervalForResource = max(
      configuration.timeoutIntervalForResource, longRunningRequestTimeout)
    longRunningURLSession = URLSession(configuration: configuration)

    // Both paths use the same credential store and publish to the same stream.
    var middlewares: [any ClientMiddleware] = [auth, RetryingMiddleware()]
    if let readOnlyAudit { middlewares.insert(ReadOnlyRequestMiddleware(audit: readOnlyAudit), at: 0) }
    longRunning = Client(
      serverURL: validated.baseURL,
      transport: URLSessionTransport(configuration: .init(session: longRunningURLSession)),
      middlewares: middlewares
    )
    generated = Client(
      serverURL: validated.baseURL,
      transport: URLSessionTransport(configuration: .init(session: urlSession)),
      // The first middleware is the outermost one. Auth signs the request
      // once, outside the retry loop, and observes the final response the
      // caller is handed — not an intermediate retried attempt. This still
      // clears the token and publishes `needsLogin` exactly once per 401
      // because retry never retries a 401 in the first place: it only
      // retries transient failures, so ordering the two this way costs
      // nothing.
      middlewares: middlewares
    )
  }

  deinit {
    longRunningURLSession.finishTasksAndInvalidate()
    needsLoginContinuation.finish()
  }

  /// The token currently in the store, for callers that have to build their
  /// own request — `EventStream` needs it for the WebSocket upgrade.
  public func currentToken() -> String? {
    do {
      return try credentials.load(for: profile.credentialKey)?.token
    } catch {
      // A locked or unreadable Keychain is not "no token": say so and report
      // nil anyway, since this call has no way to surface the failure.
      // Never log the credential itself — only the failure that reading it
      // produced.
      ShepherdLog.credentials.error(
        "could not read the credential: \(String(describing: error), privacy: .public)")
      return nil
    }
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

  // MARK: - Writes

  /// `POST /api/sessions` either spawns the session or queues it behind the
  /// usage hold. Both are success; the caller decides what to show.
  public func createSession(
    _ request: CreateSessionRequest
  ) async throws -> CreateOutcome {
    do {
      switch try await generated.createSession(.init(body: .json(request))) {
      case .created(let created): return .created(try created.body.json)
      case .ok(let ok): return .held(try ok.body.json)
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .unprocessableContent(let bad):
        throw ShepherdError.unprocessable(try bad.body.json.error)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "createSession")
      }
    } catch { throw ShepherdError.from(error, route: "createSession") }
  }

  /// `DELETE /api/sessions/{id}`. The contract documents 200 and 401 only —
  /// archiving an unknown id is a no-op server-side.
  public func archiveSession(id: String, reap: [String]? = nil) async throws {
    do {
      switch try await generated.archiveSession(.init(path: .init(id: id), body: reap.map { .json(.init(reap: $0)) })) {
      case .ok: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "archiveSession")
      }
    } catch { throw ShepherdError.from(error, route: "archiveSession") }
  }

  public func interruptSession(id: String) async throws {
    do {
      switch try await generated.interruptSession(.init(path: .init(id: id))) {
      case .ok: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "interruptSession")
      }
    } catch { throw ShepherdError.from(error, route: "interruptSession") }
  }

  /// `PUT /api/settings` with the repoRoot form. This is also what resolves a
  /// pending first run.
  public func putRepoRoot(_ path: String) async throws -> Components.Schemas.RepoRootResponse {
    do {
      switch try await generated.putRepoRoot(.init(body: .json(.init(repoRoot: path)))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "putRepoRoot")
      }
    } catch { throw ShepherdError.from(error, route: "putRepoRoot") }
  }
}

/// What `POST /api/sessions` did. The contract documents both 201 (spawned)
/// and 200 (queued behind the usage hold) as success.
public enum CreateOutcome: Equatable, Sendable {
  case created(Session)
  case held(HeldTask)
}
