import Foundation
import HTTPTypes
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
  /// Shares credentials and logout signals with `generated`, retains the default
  /// GET retry policy, and waits up to 300 seconds for response data by default.
  let longRunning: Client
  /// Owned by this client and invalidated on deinit. Stream wrappers use
  /// `longRunning`; internal visibility lets tests inspect its configuration.
  let longRunningURLSession: URLSession
  /// Per-attempt timings of ordinary operations (not `longRunning`, which is
  /// slow by design), for the connection-quality indicator.
  public let latency: LatencyRecorder
  private let credentials: any CredentialStore
  private let needsLoginContinuation: AsyncStream<Void>.Continuation

  /// - Throws: `ServerProfileError` when a `.remote` profile violates the
  ///   https-unless-loopback-or-tailnet policy.
  /// - Parameters:
  ///   - urlSession: The unchanged session used by ordinary operations.
  ///   - readURLSession: Optional shorter session for ordinary GETs; writes retain `urlSession`.
  ///   - requestAttempts: GET attempts for ordinary operations; slow operations retain three.
  ///   - longRunningRequestTimeout: Request timeout for opt-in slow operations.
  ///     Their dedicated session copies `urlSession.configuration` (not its
  ///     delegate) and raises the resource timeout to at least this value.
  public init(
    profile: ServerProfile,
    credentials: any CredentialStore,
    urlSession: URLSession = .shared,
    longRunningRequestTimeout: TimeInterval = 300,
    readOnlyAudit: ReadOnlyRequestAudit? = nil,
    requestAttempts: Int = 3,
    readURLSession: URLSession? = nil
  ) throws {
    precondition(longRunningRequestTimeout.isFinite && longRunningRequestTimeout > 0)
    let validated = try profile.validated()
    self.profile = validated
    self.credentials = credentials
    let latency = LatencyRecorder()
    self.latency = latency

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
    var ordinaryMiddlewares: [any ClientMiddleware] = [
      auth, UpNextConditionalHeaderMiddleware(), RetryingMiddleware(maxAttempts: requestAttempts)
    ]
    if let readOnlyAudit { ordinaryMiddlewares.insert(ReadOnlyRequestMiddleware(audit: readOnlyAudit), at: 0) }
    generated = Client(
      serverURL: validated.baseURL,
      transport: ReadTransport(
        standard: URLSessionTransport(configuration: .init(session: urlSession)),
        reads: URLSessionTransport(configuration: .init(session: readURLSession ?? urlSession))),
      // Latency is innermost: one sample per attempt, retries included, timed
      // to response headers. It only observes.
      // The first middleware is the outermost one. Auth signs the request
      // once, outside the retry loop, and observes the final response the
      // caller is handed — not an intermediate retried attempt. This still
      // clears the token and publishes `needsLogin` exactly once per 401
      // because retry never retries a 401 in the first place: it only
      // retries transient failures, so ordering the two this way costs
      // nothing.
      middlewares: ordinaryMiddlewares + [LatencyMiddleware(recorder: latency)]
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

  public func settings(host: String? = nil) async throws -> Components.Schemas.Settings {
    do {
      switch try await generated.getSettings(.init(query: .init(host: host))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getSettings")
      }
    } catch { throw ShepherdError.from(error, route: "getSettings") }
  }

  public func sessions() async throws -> [Components.Schemas.Session] {
    switch try await readSessions() {
    case .modified(let value, _): return value
    case .notModified:
      throw ShepherdError.contractMismatch(route: "listSessions", underlying: "304 without a validator")
    }
  }

  public func readSessions(ifNoneMatch: String? = nil) async throws -> SnapshotReadResult<[Components.Schemas.Session]> {
    do {
      switch try await generated.listSessions(.init(headers: .init(ifNoneMatch: ifNoneMatch))) {
      case .ok(let ok): return .modified(value: try ok.body.json, etag: ok.headers.eTag)
      case .notModified:
        guard ifNoneMatch != nil else {
          throw ShepherdError.contractMismatch(route: "conditionalList", underlying: "304 without a validator")
        }
        return .notModified
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "listSessions")
      }
    } catch { throw ShepherdError.from(error, route: "listSessions") }
  }

  public func doneSessions() async throws -> [Components.Schemas.Session] {
    switch try await readDoneSessions() {
    case .modified(let value, _): return value
    case .notModified:
      throw ShepherdError.contractMismatch(route: "listDoneSessions", underlying: "304 without a validator")
    }
  }

  public func readDoneSessions(ifNoneMatch: String? = nil) async throws -> SnapshotReadResult<[Components.Schemas.Session]> {
    do {
      switch try await generated.listDoneSessions(.init(headers: .init(ifNoneMatch: ifNoneMatch))) {
      case .ok(let ok): return .modified(value: try ok.body.json, etag: ok.headers.eTag)
      case .notModified:
        guard ifNoneMatch != nil else {
          throw ShepherdError.contractMismatch(route: "conditionalList", underlying: "304 without a validator")
        }
        return .notModified
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

  public func repos(host: String? = nil) async throws -> Components.Schemas.RepoList {
    do {
      switch try await generated.listRepos(.init(query: .init(host: host))) {
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
      // afterSession names no task (after_not_found, #2589).
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .unprocessableContent(let bad):
        throw ShepherdError.unprocessable(try bad.body.json.error)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      // A task sent to a connected machine got no answer (remote_dispatch_unknown, #2763).
      case .gatewayTimeout(let timeout): throw ShepherdError.fromUpstream(try timeout.body.json)
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "createSession")
      }
    } catch { throw ShepherdError.from(error, route: "createSession") }
  }

  /// `DELETE /api/sessions/{id}`. Archiving an unknown id is a no-op
  /// server-side. A failed teardown answers 500 with the server's reason, which
  /// the operator sees verbatim instead of a contract-mismatch guess.
  public func archiveSession(id: String, reap: [String]? = nil) async throws {
    do {
      switch try await generated.archiveSession(.init(path: .init(id: id), body: reap.map { .json(.init(reap: $0)) })) {
      case .ok: return
      case .unauthorized: throw ShepherdError.unauthenticated
      case .internalServerError(let bad):
        throw ShepherdError.upstreamFailure(try bad.body.json.error)
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

/// A bounded read must not impose its deadline on uploads or task creation.
private struct ReadTransport: ClientTransport {
  let standard: URLSessionTransport
  let reads: URLSessionTransport
  func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
    try await (request.method == .get ? reads : standard).send(
      request, body: body, baseURL: baseURL, operationID: operationID)
  }
}
